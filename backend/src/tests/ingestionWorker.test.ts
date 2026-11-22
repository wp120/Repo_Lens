import test from "node:test";
import assert from "node:assert/strict";
import {
  handleIngestionJobFailure,
  processIngestionJob,
  type IngestionWorkerDependencies,
} from "../jobs/ingestionWorker.js";
import type { IngestionJob } from "../jobs/ingestionQueue.js";
import type {
  CodeChunkStore,
  StorableCodeChunk,
} from "../services/codeChunkStore.js";
import { IngestionOwnershipLostError } from "../services/codeChunkStore.js";
import { VoyageRateLimitTimeoutError } from "../services/voyageRateLimiter.js";

interface FakeBranchIndex {
  id: string;
  repositoryId: string;
  branchName: string;
  status: string;
  ingestionAttempt: number;
  lastError: string | null;
  processingToken: string | null;
  repositoryFilePaths?: string[] | null;
  pendingRepositoryFilePaths?: string[] | null;
  publishedCommitSha?: string | null;
  repository: {
    owner: string;
    name: string;
  };
}

class FakePrismaWorker {
  branch: FakeBranchIndex | null = null;
  statusHistory: string[] = [];

  readonly branchIndex = {
    findUnique: async (args: { where: { id: string } }) => {
      if (this.branch && this.branch.id === args.where.id) {
        return this.branch;
      }
      return null;
    },
    updateMany: async (args: {
      where: {
        id: string;
        ingestionAttempt?: number;
        status?: { in?: string[]; not?: string };
        processingToken?: string;
      };
      data: {
        status?: string;
        lastError?: string | null;
        processingToken?: string | null;
        repositoryFilePaths?: string[] | null;
        pendingRepositoryFilePaths?: string[] | null;
        publishedCommitSha?: string | null;
      };
    }) => {
      if (!this.branch || this.branch.id !== args.where.id) {
        return { count: 0 };
      }
      if (
        args.where.ingestionAttempt !== undefined &&
        this.branch.ingestionAttempt !== args.where.ingestionAttempt
      ) {
        return { count: 0 };
      }
      if (
        args.where.status?.in &&
        !args.where.status.in.includes(this.branch.status)
      ) {
        return { count: 0 };
      }
      if (
        args.where.status?.not &&
        args.where.status.not === this.branch.status
      ) {
        return { count: 0 };
      }
      if (
        args.where.processingToken !== undefined &&
        this.branch.processingToken !== args.where.processingToken
      ) {
        return { count: 0 };
      }

      if (args.data.status !== undefined) {
        this.branch.status = args.data.status;
      }
      if (args.data.lastError !== undefined) {
        this.branch.lastError = args.data.lastError;
      }
      if (args.data.processingToken !== undefined) {
        this.branch.processingToken = args.data.processingToken;
      }
      if (args.data.repositoryFilePaths !== undefined) {
        this.branch.repositoryFilePaths = args.data.repositoryFilePaths;
      }
      if (args.data.pendingRepositoryFilePaths !== undefined) {
        this.branch.pendingRepositoryFilePaths = args.data.pendingRepositoryFilePaths;
      }
      if (args.data.publishedCommitSha !== undefined) {
        this.branch.publishedCommitSha = args.data.publishedCommitSha;
      }
      if (args.data.status !== undefined) {
        this.statusHistory.push(args.data.status);
      }
      return { count: 1 };
    },
    update: async (args: {
      where: { id: string };
      data: { status: string; lastError?: string | null };
    }) => {
      if (!this.branch || this.branch.id !== args.where.id) {
        throw new Error("Not found");
      }
      this.branch.status = args.data.status;
      if (args.data.lastError !== undefined) {
        this.branch.lastError = args.data.lastError;
      }
      this.statusHistory.push(args.data.status);
      return this.branch;
    },
  };

  async $executeRawUnsafe(
    _query: string,
    branchIndexId: string,
    ingestionAttempt: number,
  ): Promise<number> {
    if (
      !this.branch ||
      this.branch.id !== branchIndexId ||
      this.branch.ingestionAttempt !== ingestionAttempt ||
      this.branch.status !== "failed"
    ) {
      return 0;
    }
    this.branch.pendingRepositoryFilePaths = null;
    return 1;
  }
}

class FakeChunkStore implements CodeChunkStore {
  savedChunks: StorableCodeChunk[] = [];
  deletedForBranch: string[] = [];
  finalizedCommits: string[] = [];

  constructor(private readonly prisma: FakePrismaWorker) {}

  async saveChunks(
    branchIndexId: string,
    ingestionAttempt: number,
    processingToken: string,
    chunks: StorableCodeChunk[],
    commitSha: string,
  ): Promise<void> {
    this.assertOwner(branchIndexId, ingestionAttempt, processingToken);
    this.savedChunks = [...chunks];
    this.publishRepositoryFilePaths(commitSha);
  }

  async stageRepositoryFilePaths(
    branchIndexId: string,
    ingestionAttempt: number,
    processingToken: string,
    filePaths: string[],
  ): Promise<void> {
    this.assertOwner(branchIndexId, ingestionAttempt, processingToken);
    this.prisma.branch!.pendingRepositoryFilePaths = [...filePaths];
  }

  async deleteBranchChunks(
    branchIndexId: string,
    ingestionAttempt: number,
    processingToken: string,
  ): Promise<void> {
    this.assertOwner(branchIndexId, ingestionAttempt, processingToken);
    this.deletedForBranch.push(branchIndexId);
    this.savedChunks = [];
  }

  async countBranchChunks(branchIndexId: string): Promise<number> {
    return this.savedChunks.filter((c) => c.branchIndexId === branchIndexId)
      .length;
  }

  async stageChunks(
    branchIndexId: string,
    ingestionAttempt: number,
    processingToken: string,
    chunks: StorableCodeChunk[],
  ): Promise<void> {
    this.assertOwner(branchIndexId, ingestionAttempt, processingToken);
    const stagedById = new Map(
      this.savedChunks
        .filter((chunk) => chunk.id)
        .map((chunk) => [chunk.id!, chunk]),
    );
    this.savedChunks = chunks.map((chunk) => {
      const previous = chunk.id ? stagedById.get(chunk.id) : undefined;
      return previous?.embeddingStatus === "completed"
        ? previous
        : chunk;
    });
  }

  async finalizeIngestion(
    branchIndexId: string,
    ingestionAttempt: number,
    processingToken: string,
    commitSha: string,
  ): Promise<boolean> {
    this.assertOwner(branchIndexId, ingestionAttempt, processingToken);
    if (!this.prisma.branch) {
      throw new Error("Branch is not configured.");
    }
    this.finalizedCommits.push(commitSha);
    this.prisma.branch.status = "ready";
    this.prisma.branch.lastError = null;
    this.prisma.branch.processingToken = null;
    this.publishRepositoryFilePaths(commitSha);
    this.prisma.statusHistory.push("ready");
    return true;
  }

  private assertOwner(
    branchIndexId: string,
    ingestionAttempt: number,
    processingToken: string,
  ): void {
    const branch = this.prisma.branch;
    if (
      !branch ||
      branch.id !== branchIndexId ||
      branch.ingestionAttempt !== ingestionAttempt ||
      branch.processingToken !== processingToken
    ) {
      throw new IngestionOwnershipLostError();
    }
  }

  private publishRepositoryFilePaths(commitSha: string): void {
    if (!this.prisma.branch?.pendingRepositoryFilePaths) {
      throw new Error("Staged repository structure is missing.");
    }
    this.prisma.branch.repositoryFilePaths = [
      ...this.prisma.branch.pendingRepositoryFilePaths,
    ];
    this.prisma.branch.pendingRepositoryFilePaths = null;
    this.prisma.branch.publishedCommitSha = commitSha;
  }
}

const jobData: IngestionJob = {
  branchIndexId: "branch-1",
  repositoryId: "repo-1",
  branchName: "main",
  attempt: 1,
};

function createFailureJob(state: "failed" | "waiting") {
  return {
    data: jobData,
    getState: async () => state,
  };
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}

function createTestDependencies(options: {
  prisma: FakePrismaWorker;
  chunkStore: FakeChunkStore;
  commitSha?: string;
  files?: Array<{ path: string; size: number; sha: string }>;
  repositoryFilePaths?: string[];
  contentBySha?: Record<string, string>;
  embedError?: boolean;
}) {
  const commit = options.commitSha ?? "a".repeat(40);
  const files = options.files ?? [
    { path: "src/index.ts", size: 100, sha: "sha-file-1" },
  ];
  const contents = options.contentBySha ?? {
    "sha-file-1": "export function hello() { return 'world'; }",
  };

  const deps: IngestionWorkerDependencies = {
    prisma: options.prisma as unknown as IngestionWorkerDependencies["prisma"],
    chunkStore: options.chunkStore,
    resolveCommit: async () => commit,
    fetchTree: async () => ({
      indexableFiles: files,
      repositoryFilePaths:
        options.repositoryFilePaths ?? files.map((file) => file.path),
    }),
    fetchContent: async (_owner, _repo, sha) => contents[sha] ?? "",
    chunker: async (filePath, content, commitSha) => [
      {
        filePath,
        content,
        startLine: 1,
        endLine: 1,
        language: "typescript",
        symbolName: "hello",
        commitSha,
      },
    ],
    embedder: async (texts) => {
      if (options.embedError) {
        throw new Error("Voyage API failure");
      }
      return texts.map(() => Array(1024).fill(0.01));
    },
  };

  return deps;
}

test("processIngestionJob successfully processes queued branch to ready", async () => {
  const prisma = new FakePrismaWorker();
  prisma.branch = {
    id: "branch-1",
    repositoryId: "repo-1",
    branchName: "main",
    status: "queued",
    ingestionAttempt: 1,
    lastError: null,
    processingToken: null,
    repository: { owner: "sample-owner", name: "sample-repo" },
  };
  const chunkStore = new FakeChunkStore(prisma);
  const deps = createTestDependencies({ prisma, chunkStore });
  let embeddingTexts: string[] = [];
  deps.embedder = async (texts) => {
    embeddingTexts = texts;
    return texts.map(() => Array(1024).fill(0.01));
  };

  await processIngestionJob(
    {
      branchIndexId: "branch-1",
      repositoryId: "repo-1",
      branchName: "main",
      attempt: 1,
    },
    deps,
  );

  assert.equal(prisma.branch.status, "ready");
  assert.equal(prisma.branch.lastError, null);
  assert.equal(prisma.branch.processingToken, null);
  assert.deepEqual(prisma.statusHistory, ["ingesting", "ready"]);
  assert.equal(chunkStore.savedChunks.length, 1);
  assert.equal(chunkStore.savedChunks[0].embedding.length, 1024);
  assert.equal(chunkStore.savedChunks[0].branchIndexId, "branch-1");
  assert.equal(chunkStore.savedChunks[0].commitSha, "a".repeat(40));
  assert.equal(
    embeddingTexts[0],
    "File: src/index.ts\nLanguage: typescript\nSymbol: hello\n\nCode:\nexport function hello() { return 'world'; }",
  );
  assert.equal(
    chunkStore.savedChunks[0].content,
    "export function hello() { return 'world'; }",
  );
});

test("batch ingestion splits work into batches and keeps the branch ingesting", async () => {
  const prisma = new FakePrismaWorker();
  prisma.branch = {
    id: "branch-1",
    repositoryId: "repo-1",
    branchName: "main",
    status: "queued",
    ingestionAttempt: 1,
    lastError: null,
    processingToken: null,
    repository: { owner: "sample-owner", name: "sample-repo" },
  };
  const chunkStore = new FakeChunkStore(prisma);
  const deps = createTestDependencies({ prisma, chunkStore });
  deps.chunker = async (filePath, _content, commitSha) =>
    Array.from({ length: 101 }, (_, index) => ({
      filePath,
      content: `chunk-${index}`,
      startLine: index + 1,
      endLine: index + 1,
      language: "typescript",
      symbolName: `symbol-${index}`,
      commitSha,
    }));
  const batches: Array<{
    branchIndexId: string;
    ingestionAttempt: number;
    processingToken: string;
    commitSha: string;
    chunkIds: string[];
  }> = [];
  deps.enqueueBatchEmbeddings = async (batch) => {
    batches.push(batch);
  };

  await processIngestionJob(jobData, deps);

  assert.equal(prisma.branch.status, "ingesting");
  assert.ok(prisma.branch.processingToken);
  assert.equal(prisma.statusHistory.includes("ready"), false);
  assert.equal(chunkStore.savedChunks.length, 101);
  assert.deepEqual(batches.map((batch) => batch.chunkIds.length), [50, 50, 1]);
  assert.ok(
    batches.every(
      (batch) =>
        batch.processingToken === prisma.branch?.processingToken &&
        batch.ingestionAttempt === jobData.attempt &&
        batch.commitSha === "a".repeat(40),
    ),
  );
});

test("batch ingestion keeps the published structure until chunks are finalized", async () => {
  const prisma = new FakePrismaWorker();
  prisma.branch = {
    id: "branch-1",
    repositoryId: "repo-1",
    branchName: "main",
    status: "queued",
    ingestionAttempt: 1,
    lastError: null,
    processingToken: null,
    repositoryFilePaths: ["old/deleted.ts"],
    repository: { owner: "sample-owner", name: "sample-repo" },
  };
  const chunkStore = new FakeChunkStore(prisma);
  const deps = createTestDependencies({
    prisma,
    chunkStore,
    repositoryFilePaths: [
      "src/index.ts",
      "README.md",
      "assets/logo.png",
      "node_modules/pkg/index.js",
    ],
  });
  deps.enqueueBatchEmbeddings = async () => {};

  await processIngestionJob(jobData, deps);

  assert.deepEqual(prisma.branch.repositoryFilePaths, ["old/deleted.ts"]);
  assert.deepEqual(prisma.branch.pendingRepositoryFilePaths, [
    "src/index.ts",
    "README.md",
    "assets/logo.png",
    "node_modules/pkg/index.js",
  ]);
  await chunkStore.finalizeIngestion(
    "branch-1",
    1,
    prisma.branch.processingToken!,
    "a".repeat(40),
  );
  assert.deepEqual(prisma.branch.repositoryFilePaths, [
    "src/index.ts",
    "README.md",
    "assets/logo.png",
    "node_modules/pkg/index.js",
  ]);
  assert.equal(prisma.branch.pendingRepositoryFilePaths, null);
  assert.equal(prisma.branch.publishedCommitSha, "a".repeat(40));
});

test("batch ingestion finalizes immediately when there are no chunks", async () => {
  const prisma = new FakePrismaWorker();
  prisma.branch = {
    id: "branch-1",
    repositoryId: "repo-1",
    branchName: "main",
    status: "queued",
    ingestionAttempt: 1,
    lastError: null,
    processingToken: null,
    repository: { owner: "sample-owner", name: "sample-repo" },
  };
  const chunkStore = new FakeChunkStore(prisma);
  const deps = createTestDependencies({ prisma, chunkStore, files: [] });
  const batches: unknown[] = [];
  deps.enqueueBatchEmbeddings = async (batch) => {
    batches.push(batch);
  };

  await processIngestionJob(jobData, deps);

  assert.deepEqual(batches, []);
  assert.deepEqual(chunkStore.finalizedCommits, ["a".repeat(40)]);
  assert.equal(prisma.branch.status, "ready");
  assert.equal(prisma.branch.processingToken, null);
});

test("repository redelivery reuses staged chunk IDs and completed embeddings", async () => {
  const prisma = new FakePrismaWorker();
  prisma.branch = {
    id: "branch-1",
    repositoryId: "repo-1",
    branchName: "main",
    status: "queued",
    ingestionAttempt: 1,
    lastError: null,
    processingToken: null,
    repository: { owner: "sample-owner", name: "sample-repo" },
  };
  const chunkStore = new FakeChunkStore(prisma);
  const firstBatches: string[][] = [];
  const firstDeps = createTestDependencies({ prisma, chunkStore });
  firstDeps.enqueueBatchEmbeddings = async (batch) => {
    firstBatches.push(batch.chunkIds);
  };
  await processIngestionJob(jobData, firstDeps);

  const stagedId = chunkStore.savedChunks[0].id;
  assert.ok(stagedId);
  chunkStore.savedChunks[0].embeddingStatus = "completed";
  chunkStore.savedChunks[0].embedding = Array(1024).fill(0.25);
  const previousToken = prisma.branch.processingToken;

  const recoveredBatches: string[][] = [];
  const retryDeps = createTestDependencies({ prisma, chunkStore });
  retryDeps.enqueueBatchEmbeddings = async (batch) => {
    recoveredBatches.push(batch.chunkIds);
  };
  await processIngestionJob(jobData, retryDeps);

  assert.equal(chunkStore.savedChunks.length, 1);
  assert.equal(chunkStore.savedChunks[0].id, stagedId);
  assert.equal(chunkStore.savedChunks[0].embeddingStatus, "completed");
  assert.deepEqual(chunkStore.savedChunks[0].embedding, Array(1024).fill(0.25));
  assert.deepEqual(firstBatches, [[stagedId]]);
  assert.deepEqual(recoveredBatches, [[stagedId]]);
  assert.notEqual(prisma.branch.processingToken, previousToken);
});

test("processIngestionJob skips already-ready branch index idempotently", async () => {
  const prisma = new FakePrismaWorker();
  prisma.branch = {
    id: "branch-1",
    repositoryId: "repo-1",
    branchName: "main",
    status: "ready", // Already ready!
    ingestionAttempt: 1,
    lastError: null,
    processingToken: null,
    repository: { owner: "sample-owner", name: "sample-repo" },
  };
  const chunkStore = new FakeChunkStore(prisma);
  let embedderCalled = false;
  const deps = createTestDependencies({ prisma, chunkStore });
  deps.embedder = async () => {
    embedderCalled = true;
    return [];
  };

  await processIngestionJob(
    {
      branchIndexId: "branch-1",
      repositoryId: "repo-1",
      branchName: "main",
      attempt: 1,
    },
    deps,
  );

  assert.equal(prisma.branch.status, "ready");
  assert.equal(prisma.statusHistory.length, 0); // No status transitions
  assert.equal(embedderCalled, false);
  assert.equal(chunkStore.savedChunks.length, 0);
});

test("processIngestionJob resumes a redelivered job when status is already ingesting", async () => {
  const prisma = new FakePrismaWorker();
  prisma.branch = {
    id: "branch-1",
    repositoryId: "repo-1",
    branchName: "main",
    status: "ingesting",
    ingestionAttempt: 1,
    lastError: null,
    processingToken: "00000000-0000-4000-8000-000000000001",
    repository: { owner: "sample-owner", name: "sample-repo" },
  };
  const chunkStore = new FakeChunkStore(prisma);

  await processIngestionJob(
    jobData,
    createTestDependencies({ prisma, chunkStore }),
  );

  assert.equal(prisma.branch.status, "ready");
  assert.equal(prisma.branch.processingToken, null);
  assert.equal(chunkStore.savedChunks.length, 1);
});

test("processIngestionJob skips superseded job attempt", async () => {
  const prisma = new FakePrismaWorker();
  prisma.branch = {
    id: "branch-1",
    repositoryId: "repo-1",
    branchName: "main",
    status: "queued",
    ingestionAttempt: 2, // Current attempt is 2
    lastError: null,
    processingToken: null,
    repository: { owner: "sample-owner", name: "sample-repo" },
  };
  const chunkStore = new FakeChunkStore(prisma);
  const deps = createTestDependencies({ prisma, chunkStore });

  // Attempt 1 arrives late:
  await processIngestionJob(
    {
      branchIndexId: "branch-1",
      repositoryId: "repo-1",
      branchName: "main",
      attempt: 1, // 1 < 2
    },
    deps,
  );

  assert.equal(prisma.branch.status, "queued");
  assert.equal(prisma.statusHistory.length, 0);
  assert.equal(chunkStore.savedChunks.length, 0);
});

test("only the latest execution of an attempt can commit chunks", async () => {
  const prisma = new FakePrismaWorker();
  prisma.branch = {
    id: "branch-1",
    repositoryId: "repo-1",
    branchName: "main",
    status: "queued",
    ingestionAttempt: 1,
    lastError: null,
    processingToken: null,
    repository: { owner: "sample-owner", name: "sample-repo" },
  };
  const chunkStore = new FakeChunkStore(prisma);
  const firstEmbedStarted = deferred();
  const releaseFirstEmbed = deferred();
  const firstDeps = createTestDependencies({
    prisma,
    chunkStore,
    contentBySha: { "sha-file-1": "first execution" },
  });
  firstDeps.embedder = async (texts) => {
    firstEmbedStarted.resolve();
    await releaseFirstEmbed.promise;
    return texts.map(() => Array(1024).fill(0.01));
  };

  const firstExecution = processIngestionJob(jobData, firstDeps);
  await firstEmbedStarted.promise;

  await processIngestionJob(
    jobData,
    createTestDependencies({
      prisma,
      chunkStore,
      contentBySha: { "sha-file-1": "current execution" },
    }),
  );
  releaseFirstEmbed.resolve();
  await firstExecution;

  assert.equal(prisma.branch.status, "ready");
  assert.equal(chunkStore.savedChunks.length, 1);
  assert.equal(chunkStore.savedChunks[0].content, "current execution");
});

test("outdated failure cleanup cannot delete chunks committed by the current execution", async () => {
  const prisma = new FakePrismaWorker();
  prisma.branch = {
    id: "branch-1",
    repositoryId: "repo-1",
    branchName: "main",
    status: "queued",
    ingestionAttempt: 1,
    lastError: null,
    processingToken: null,
    repository: { owner: "sample-owner", name: "sample-repo" },
  };
  const chunkStore = new FakeChunkStore(prisma);
  const firstTreeStarted = deferred();
  const releaseFirstTree = deferred();
  const firstDeps = createTestDependencies({ prisma, chunkStore });
  firstDeps.fetchTree = async () => {
    firstTreeStarted.resolve();
    await releaseFirstTree.promise;
    throw new Error("outdated execution failed");
  };

  const firstExecution = processIngestionJob(jobData, firstDeps);
  await firstTreeStarted.promise;
  await processIngestionJob(
    jobData,
    createTestDependencies({ prisma, chunkStore }),
  );
  releaseFirstTree.resolve();
  await firstExecution;

  assert.equal(prisma.branch.status, "ready");
  assert.equal(chunkStore.savedChunks.length, 1);
  assert.deepEqual(chunkStore.deletedForBranch, []);
});

test("outdated execution cannot overwrite terminal failure from the current execution", async () => {
  const prisma = new FakePrismaWorker();
  prisma.branch = {
    id: "branch-1",
    repositoryId: "repo-1",
    branchName: "main",
    status: "queued",
    ingestionAttempt: 1,
    lastError: null,
    processingToken: null,
    repository: { owner: "sample-owner", name: "sample-repo" },
  };
  const chunkStore = new FakeChunkStore(prisma);
  const firstEmbedStarted = deferred();
  const releaseFirstEmbed = deferred();
  const firstDeps = createTestDependencies({ prisma, chunkStore });
  firstDeps.embedder = async (texts) => {
    firstEmbedStarted.resolve();
    await releaseFirstEmbed.promise;
    return texts.map(() => Array(1024).fill(0.01));
  };
  const firstExecution = processIngestionJob(jobData, firstDeps);
  await firstEmbedStarted.promise;

  const currentDeps = createTestDependencies({ prisma, chunkStore });
  currentDeps.fetchTree = async () => {
    throw new Error("current execution failed");
  };
  await assert.rejects(processIngestionJob(jobData, currentDeps));
  await handleIngestionJobFailure(
    createFailureJob("failed"),
    new Error("current execution failed"),
    prisma as unknown as IngestionWorkerDependencies["prisma"],
  );

  releaseFirstEmbed.resolve();
  await firstExecution;
  assert.equal(prisma.branch.status, "failed");
  assert.equal(prisma.branch.lastError, "current execution failed");
  assert.equal(prisma.branch.processingToken, null);
});

test("processIngestionJob leaves terminal status handling to BullMQ after an error", async () => {
  const prisma = new FakePrismaWorker();
  prisma.branch = {
    id: "branch-1",
    repositoryId: "repo-1",
    branchName: "main",
    status: "queued",
    ingestionAttempt: 1,
    lastError: null,
    processingToken: null,
    repositoryFilePaths: ["previous/snapshot.ts"],
    repository: { owner: "sample-owner", name: "sample-repo" },
  };
  const chunkStore = new FakeChunkStore(prisma);
  const deps = createTestDependencies({
    prisma,
    chunkStore,
    embedError: true, // Embedding will fail!
  });

  await assert.rejects(
    processIngestionJob(
      {
        branchIndexId: "branch-1",
        repositoryId: "repo-1",
        branchName: "main",
        attempt: 1,
      },
      deps,
    ),
    /Voyage API failure/,
  );

  assert.equal(prisma.branch.status, "ingesting");
  assert.equal(prisma.branch.processingToken !== null, true);
  assert.deepEqual(prisma.statusHistory, ["ingesting"]);
  assert.ok(chunkStore.deletedForBranch.includes("branch-1"));
  assert.equal(chunkStore.savedChunks.length, 0);

  await handleIngestionJobFailure(
    {
      data: {
        branchIndexId: "branch-1",
        repositoryId: "repo-1",
        branchName: "main",
        attempt: 1,
      },
      getState: async () => "failed",
    },
    new Error("Voyage API failure"),
    prisma as unknown as IngestionWorkerDependencies["prisma"],
  );
  assert.equal(prisma.branch.status, "failed");
  assert.ok(prisma.branch.lastError?.includes("Voyage API failure"));
  assert.equal(prisma.branch.processingToken, null);
  assert.deepEqual(prisma.branch.repositoryFilePaths, ["previous/snapshot.ts"]);
  assert.equal(prisma.branch.pendingRepositoryFilePaths, null);
});

test("an intermediate BullMQ failure does not mark the branch failed", async () => {
  const prisma = new FakePrismaWorker();
  prisma.branch = {
    id: "branch-1",
    repositoryId: "repo-1",
    branchName: "main",
    status: "ingesting",
    ingestionAttempt: 1,
    lastError: null,
    processingToken: "00000000-0000-4000-8000-000000000001",
    repository: { owner: "sample-owner", name: "sample-repo" },
  };

  await handleIngestionJobFailure(
    createFailureJob("waiting"),
    new Error("temporary failure"),
    prisma as unknown as IngestionWorkerDependencies["prisma"],
  );

  assert.equal(prisma.branch.status, "ingesting");
  assert.ok(prisma.branch.processingToken);
  assert.equal(prisma.branch.lastError, null);
});

test("terminal stalled-job failure marks only the current non-ready attempt failed", async () => {
  const prisma = new FakePrismaWorker();
  prisma.branch = {
    id: "branch-1",
    repositoryId: "repo-1",
    branchName: "main",
    status: "ingesting",
    ingestionAttempt: 1,
    lastError: null,
    processingToken: "00000000-0000-4000-8000-000000000001",
    repository: { owner: "sample-owner", name: "sample-repo" },
  };

  await handleIngestionJobFailure(
    createFailureJob("failed"),
    new Error("job stalled more than allowable limit"),
    prisma as unknown as IngestionWorkerDependencies["prisma"],
  );

  assert.equal(prisma.branch.status, "failed");
  assert.equal(
    prisma.branch.lastError,
    "job stalled more than allowable limit",
  );
  assert.equal(prisma.branch.processingToken, null);

  prisma.branch.status = "ready";
  prisma.branch.lastError = null;
  await handleIngestionJobFailure(
    createFailureJob("failed"),
    new Error("late failure event"),
    prisma as unknown as IngestionWorkerDependencies["prisma"],
  );
  assert.equal(prisma.branch.status, "ready");
  assert.equal(prisma.branch.lastError, null);

  prisma.branch.ingestionAttempt = 2;
  prisma.branch.status = "queued";
  prisma.branch.processingToken = "00000000-0000-4000-8000-000000000002";
  await handleIngestionJobFailure(
    createFailureJob("failed"),
    new Error("superseded failure event"),
    prisma as unknown as IngestionWorkerDependencies["prisma"],
  );
  assert.equal(prisma.branch.status, "queued");
  assert.equal(
    prisma.branch.processingToken,
    "00000000-0000-4000-8000-000000000002",
  );
});

test("processIngestionJob preserves retry state when embedding rate-limit wait times out", async () => {
  const prisma = new FakePrismaWorker();
  prisma.branch = {
    id: "branch-1",
    repositoryId: "repo-1",
    branchName: "main",
    status: "queued",
    ingestionAttempt: 1,
    lastError: null,
    processingToken: null,
    repository: { owner: "sample-owner", name: "sample-repo" },
  };
  const chunkStore = new FakeChunkStore(prisma);
  const deps = createTestDependencies({ prisma, chunkStore });
  deps.embedder = async () => {
    throw new VoyageRateLimitTimeoutError(
      "Voyage embedding rate limiter timed out after 120000ms waiting for capacity.",
    );
  };

  await assert.rejects(
    processIngestionJob(
      {
        branchIndexId: "branch-1",
        repositoryId: "repo-1",
        branchName: "main",
        attempt: 1,
      },
      deps,
    ),
    (err: unknown) => err instanceof VoyageRateLimitTimeoutError,
  );

  assert.equal(prisma.branch.status, "ingesting");
  assert.ok(prisma.branch.processingToken);
  assert.deepEqual(prisma.statusHistory, ["ingesting"]);
  assert.ok(chunkStore.deletedForBranch.includes("branch-1"));
});
