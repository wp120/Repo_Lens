import test from "node:test";
import assert from "node:assert/strict";
import {
  processIngestionJob,
  type IngestionWorkerDependencies,
} from "../jobs/ingestionWorker.js";
import type {
  CodeChunkStore,
  StorableCodeChunk,
} from "../services/codeChunkStore.js";

interface FakeBranchIndex {
  id: string;
  repositoryId: string;
  branchName: string;
  status: string;
  ingestionAttempt: number;
  lastError: string | null;
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
        status?: { in: string[] };
      };
      data: { status: string; lastError?: string | null };
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

      this.branch.status = args.data.status;
      if (args.data.lastError !== undefined) {
        this.branch.lastError = args.data.lastError;
      }
      this.statusHistory.push(args.data.status);
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

  async saveChunks(
    branchIndexId: string,
    chunks: StorableCodeChunk[],
  ): Promise<void> {
    this.savedChunks = [...chunks];
  }

  async deleteBranchChunks(branchIndexId: string): Promise<void> {
    this.deletedForBranch.push(branchIndexId);
    this.savedChunks = [];
  }

  async countBranchChunks(branchIndexId: string): Promise<number> {
    return this.savedChunks.filter((c) => c.branchIndexId === branchIndexId)
      .length;
  }
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
    repository: { owner: "sample-owner", name: "sample-repo" },
  };
  const chunkStore = new FakeChunkStore();
  const deps = createTestDependencies({ prisma, chunkStore });

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
  assert.deepEqual(prisma.statusHistory, ["ingesting", "ready"]);
  assert.equal(chunkStore.savedChunks.length, 1);
  assert.equal(chunkStore.savedChunks[0].embedding.length, 1024);
  assert.equal(chunkStore.savedChunks[0].branchIndexId, "branch-1");
  assert.equal(chunkStore.savedChunks[0].commitSha, "a".repeat(40));
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
    repository: { owner: "sample-owner", name: "sample-repo" },
  };
  const chunkStore = new FakeChunkStore();
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

test("processIngestionJob skips superseded job attempt", async () => {
  const prisma = new FakePrismaWorker();
  prisma.branch = {
    id: "branch-1",
    repositoryId: "repo-1",
    branchName: "main",
    status: "queued",
    ingestionAttempt: 2, // Current attempt is 2
    lastError: null,
    repository: { owner: "sample-owner", name: "sample-repo" },
  };
  const chunkStore = new FakeChunkStore();
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

test("processIngestionJob cleans up chunks and marks failed on error", async () => {
  const prisma = new FakePrismaWorker();
  prisma.branch = {
    id: "branch-1",
    repositoryId: "repo-1",
    branchName: "main",
    status: "queued",
    ingestionAttempt: 1,
    lastError: null,
    repository: { owner: "sample-owner", name: "sample-repo" },
  };
  const chunkStore = new FakeChunkStore();
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

  assert.equal(prisma.branch.status, "failed");
  assert.ok(prisma.branch.lastError?.includes("Voyage API failure"));
  assert.deepEqual(prisma.statusHistory, ["ingesting", "failed"]);
  assert.ok(chunkStore.deletedForBranch.includes("branch-1"));
  assert.equal(chunkStore.savedChunks.length, 0);
});
