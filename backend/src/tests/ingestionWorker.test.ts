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
}

class FakeChunkStore implements CodeChunkStore {
  savedChunks: StorableCodeChunk[] = [];
  deletedForBranch: string[] = [];

  constructor(private readonly prisma: FakePrismaWorker) {}

  async saveChunks(
    branchIndexId: string,
    ingestionAttempt: number,
    processingToken: string,
    chunks: StorableCodeChunk[],
  ): Promise<void> {
    this.assertOwner(branchIndexId, ingestionAttempt, processingToken);
    this.savedChunks = [...chunks];
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
    fetchTree: async () => files,
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
