import assert from "node:assert/strict";
import test from "node:test";
import {
  handleChunkEmbeddingJobFailure,
  processChunkEmbeddingJob,
  type ChunkEmbeddingWorkerDependencies,
} from "../jobs/chunkEmbeddingWorker.js";
import type { ChunkEmbeddingJob } from "../jobs/chunkEmbeddingQueue.js";
import {
  BatchOwnershipLostError,
  type CodeChunkRecord,
  type CodeChunkStore,
} from "../services/codeChunkStore.js";

class FakeBranchStore {
  branch: {
    id: string;
    ingestionAttempt: number;
    processingToken: string | null;
    status: string;
    lastError: string | null;
  } | null = {
    id: "branch-1",
    ingestionAttempt: 7,
    processingToken: "11111111-1111-4111-8111-111111111111",
    status: "ingesting",
    lastError: null,
  };

  readonly branchIndex = {
    findUnique: async ({ where }: { where: { id: string } }) =>
      this.branch && this.branch.id === where.id ? this.branch : null,
  };
}

class FakeChunkStore implements CodeChunkStore {
  claimed: string[] = [];
  batchExecutionTokens: string[] = [];
  persisted: string[] = [];
  failed: string[] = [];
  finalized: string[] = [];
  events: string[] = [];
  terminalFailures: Array<{
    branchIndexId: string;
    ingestionAttempt: number;
    processingToken: string;
    error: string;
  }> = [];
  stagedRows: Array<{ ingestionAttempt: number; isActive: boolean; status: string }> = [];
  constructor(private readonly branchStore?: FakeBranchStore) {}

  async claimBatchChunks(
    branchIndexId: string,
    ingestionAttempt: number,
    processingToken: string,
    batchExecutionToken: string,
    chunkIds: string[],
  ): Promise<CodeChunkRecord[]> {
    this.claimed.push(...chunkIds);
    this.batchExecutionTokens.push(batchExecutionToken);
    return chunkIds.map((id) => ({
      id,
      branchIndexId,
      filePath: "src/sample.ts",
      content: "const value = 1;",
      startLine: 1,
      endLine: 1,
      language: "typescript",
      symbolName: "value",
      commitSha: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      embedding: [],
      sourceBlobSha: null,
      embeddingStatus: "pending",
      isActive: false,
      ingestionAttempt,
      batchExecutionToken,
    }));
  }

  async persistBatchEmbeddings(
    branchIndexId: string,
    ingestionAttempt: number,
    processingToken: string,
    batchExecutionToken: string,
    chunkIds: string[],
    embeddings: number[][],
  ): Promise<void> {
    const branch = this.branchStore?.branch;
    if (
      this.branchStore &&
      (!branch ||
        branch.id !== branchIndexId ||
        branch.ingestionAttempt !== ingestionAttempt ||
        branch.processingToken !== processingToken ||
        branch.status !== "ingesting")
    ) {
      throw new BatchOwnershipLostError();
    }
    this.persisted.push(...chunkIds);
    this.events.push("persist");
  }

  async markBatchFailed(
    branchIndexId: string,
    ingestionAttempt: number,
    processingToken: string,
    batchExecutionToken: string,
    chunkIds: string[],
  ): Promise<void> {
    this.failed.push(...chunkIds);
  }

  async finalizeIngestion(
    branchIndexId: string,
    ingestionAttempt: number,
    processingToken: string,
    commitSha: string,
  ): Promise<boolean> {
    this.finalized.push(commitSha);
    this.events.push("finalize");
    return true;
  }

  async failIngestion(
    branchIndexId: string,
    ingestionAttempt: number,
    processingToken: string,
    error: string,
  ): Promise<boolean> {
    const branch = this.branchStore?.branch;
    if (
      !branch ||
      branch.id !== branchIndexId ||
      branch.ingestionAttempt !== ingestionAttempt ||
      branch.processingToken !== processingToken ||
      branch.status !== "ingesting"
    ) {
      return false;
    }

    this.terminalFailures.push({
      branchIndexId,
      ingestionAttempt,
      processingToken,
      error,
    });
    branch.status = "failed";
    branch.lastError = error;
    branch.processingToken = null;
    this.stagedRows = this.stagedRows.filter(
      (row) => row.ingestionAttempt !== ingestionAttempt || row.isActive,
    );
    return true;
  }
}

const jobData: ChunkEmbeddingJob = {
  branchIndexId: "branch-1",
  ingestionAttempt: 7,
  processingToken: "11111111-1111-4111-8111-111111111111",
  commitSha: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  chunkIds: ["chunk-1", "chunk-2"],
};

test("processChunkEmbeddingJob claims and embeds a batch", async () => {
  const prisma = new FakeBranchStore();
  const chunkStore = new FakeChunkStore();
  const deps: ChunkEmbeddingWorkerDependencies = {
    prisma: prisma as never,
    chunkStore: chunkStore as unknown as CodeChunkStore,
    fetchChunkBatch: async (_branchIndexId, chunkIds) =>
      chunkIds.map((id) => ({
        id,
        branchIndexId: jobData.branchIndexId,
        filePath: "src/sample.ts",
        content: "const value = 1;",
        startLine: 1,
        endLine: 1,
        language: "typescript",
        symbolName: "value",
        commitSha: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        embedding: [],
        sourceBlobSha: null,
        embeddingStatus: "pending",
        isActive: false,
        ingestionAttempt: jobData.ingestionAttempt,
        batchExecutionToken: null,
      })),
    embedder: async () => [[1, 2, 3], [4, 5, 6]],
  };

  await processChunkEmbeddingJob(jobData, deps);

  assert.deepEqual(chunkStore.claimed, ["chunk-1", "chunk-2"]);
  assert.deepEqual(chunkStore.persisted, ["chunk-1", "chunk-2"]);
  assert.deepEqual(chunkStore.finalized, [jobData.commitSha]);
  assert.deepEqual(chunkStore.events, ["persist", "finalize"]);
  assert.deepEqual(chunkStore.failed, []);
});

test("processChunkEmbeddingJob retries finalization when chunks were already completed", async () => {
  const prisma = new FakeBranchStore();
  const chunkStore = new FakeChunkStore();
  const deps: ChunkEmbeddingWorkerDependencies = {
    prisma: prisma as never,
    chunkStore: chunkStore as unknown as CodeChunkStore,
    fetchChunkBatch: async () => [],
    embedder: async () => [],
  };
  chunkStore.claimBatchChunks = async () => [];

  await processChunkEmbeddingJob(jobData, deps);

  assert.deepEqual(chunkStore.finalized, [jobData.commitSha]);
  assert.deepEqual(chunkStore.events, ["finalize"]);
});

test("redelivered batch execution gets a fresh execution token", async () => {
  const prisma = new FakeBranchStore();
  const chunkStore = new FakeChunkStore(prisma);
  const deps: ChunkEmbeddingWorkerDependencies = {
    prisma: prisma as never,
    chunkStore,
    fetchChunkBatch: async (_branchIndexId, chunkIds) =>
      chunkIds.map((id) => ({
        id,
        branchIndexId: jobData.branchIndexId,
        filePath: "src/sample.ts",
        content: "const value = 1;",
        startLine: 1,
        endLine: 1,
        language: "typescript",
        symbolName: "value",
        commitSha: jobData.commitSha,
        embedding: [],
        sourceBlobSha: null,
        embeddingStatus: "pending",
        isActive: false,
        ingestionAttempt: jobData.ingestionAttempt,
        batchExecutionToken: null,
      })),
    embedder: async () => [[1, 2, 3], [4, 5, 6]],
  };

  await processChunkEmbeddingJob(jobData, deps);
  await processChunkEmbeddingJob(jobData, deps);

  assert.equal(chunkStore.batchExecutionTokens.length, 2);
  assert.notEqual(
    chunkStore.batchExecutionTokens[0],
    chunkStore.batchExecutionTokens[1],
  );
  assert.deepEqual(chunkStore.persisted, [...jobData.chunkIds, ...jobData.chunkIds]);
});

test("processChunkEmbeddingJob marks failed chunks when embedding generation errors", async () => {
  const prisma = new FakeBranchStore();
  const chunkStore = new FakeChunkStore();
  const deps: ChunkEmbeddingWorkerDependencies = {
    prisma: prisma as never,
    chunkStore: chunkStore as unknown as CodeChunkStore,
    fetchChunkBatch: async (_branchIndexId, chunkIds) =>
      chunkIds.map((id) => ({
        id,
        branchIndexId: jobData.branchIndexId,
        filePath: "src/sample.ts",
        content: "const value = 1;",
        startLine: 1,
        endLine: 1,
        language: "typescript",
        symbolName: "value",
        commitSha: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        embedding: [],
        sourceBlobSha: null,
        embeddingStatus: "pending",
        isActive: false,
        ingestionAttempt: jobData.ingestionAttempt,
        batchExecutionToken: null,
      })),
    embedder: async () => {
      throw new Error("Voyage backend unavailable");
    },
  };

  await assert.rejects(processChunkEmbeddingJob(jobData, deps), /Voyage backend unavailable/);
  assert.deepEqual(chunkStore.failed, ["chunk-1", "chunk-2"]);
});

function failureJob(
  branchData: ChunkEmbeddingJob,
  state: "failed" | "delayed",
  attemptsMade: number,
  attempts: number,
) {
  return {
    data: branchData,
    attemptsMade,
    opts: { attempts },
    getState: async () => state,
  };
}

test("retryable batch failure preserves branch and staged chunks", async () => {
  const prisma = new FakeBranchStore();
  const chunkStore = new FakeChunkStore(prisma);
  chunkStore.stagedRows = [
    { ingestionAttempt: 7, isActive: false, status: "failed" },
    { ingestionAttempt: 7, isActive: false, status: "completed" },
    { ingestionAttempt: 6, isActive: false, status: "completed" },
    { ingestionAttempt: 7, isActive: true, status: "completed" },
  ];

  const transitioned = await handleChunkEmbeddingJobFailure(
    failureJob(jobData, "delayed", 1, 3),
    new Error("temporary Voyage error"),
    chunkStore,
  );

  assert.equal(transitioned, false);
  assert.equal(prisma.branch?.status, "ingesting");
  assert.equal(prisma.branch?.processingToken, jobData.processingToken);
  assert.equal(chunkStore.terminalFailures.length, 0);
  assert.equal(chunkStore.stagedRows.length, 4);
  assert.equal(
    await handleChunkEmbeddingJobFailure(
      failureJob(jobData, "failed", 1, 3),
      new Error("intermediate failure notification"),
      chunkStore,
    ),
    false,
  );
  assert.equal(prisma.branch?.status, "ingesting");
});

test("terminal batch failure fails the owned attempt and removes only inactive attempt chunks", async () => {
  const prisma = new FakeBranchStore();
  const chunkStore = new FakeChunkStore(prisma);
  chunkStore.stagedRows = [
    { ingestionAttempt: 7, isActive: false, status: "failed" },
    { ingestionAttempt: 7, isActive: false, status: "completed" },
    { ingestionAttempt: 6, isActive: false, status: "completed" },
    { ingestionAttempt: 7, isActive: true, status: "completed" },
  ];

  const transitioned = await handleChunkEmbeddingJobFailure(
    failureJob(jobData, "failed", 3, 3),
    new Error("Voyage quota exhausted"),
    chunkStore,
  );

  assert.equal(transitioned, true);
  assert.equal(prisma.branch?.status, "failed");
  assert.equal(prisma.branch?.lastError, "Voyage quota exhausted");
  assert.equal(prisma.branch?.processingToken, null);
  assert.deepEqual(chunkStore.stagedRows, [
    { ingestionAttempt: 6, isActive: false, status: "completed" },
    { ingestionAttempt: 7, isActive: true, status: "completed" },
  ]);
});

test("stale and repeated terminal failures are idempotently ignored", async () => {
  const prisma = new FakeBranchStore();
  const chunkStore = new FakeChunkStore(prisma);
  prisma.branch!.ingestionAttempt = 8;
  prisma.branch!.processingToken = "22222222-2222-4222-8222-222222222222";

  const staleResult = await handleChunkEmbeddingJobFailure(
    failureJob(jobData, "failed", 3, 3),
    new Error("stale failure"),
    chunkStore,
  );
  assert.equal(staleResult, false);
  assert.equal(prisma.branch?.status, "ingesting");

  const currentJob = {
    ...jobData,
    ingestionAttempt: 8,
    processingToken: "22222222-2222-4222-8222-222222222222",
  };
  const terminalJob = failureJob(currentJob, "failed", 3, 3);
  assert.equal(
    await handleChunkEmbeddingJobFailure(
      terminalJob,
      new Error("terminal failure"),
      chunkStore,
    ),
    true,
  );
  assert.equal(
    await handleChunkEmbeddingJobFailure(
      terminalJob,
      new Error("duplicate notification"),
      chunkStore,
    ),
    false,
  );
  assert.equal(prisma.branch?.status, "failed");
  assert.equal(prisma.branch?.lastError, "terminal failure");
  assert.equal(chunkStore.terminalFailures.length, 1);
});

test("stale batch execution cannot persist after terminal failure invalidates its token", async () => {
  const prisma = new FakeBranchStore();
  const chunkStore = new FakeChunkStore(prisma);
  const deps: ChunkEmbeddingWorkerDependencies = {
    prisma: prisma as never,
    chunkStore,
    fetchChunkBatch: async (_branchIndexId, chunkIds) =>
      chunkIds.map((id) => ({
        id,
        branchIndexId: jobData.branchIndexId,
        filePath: "src/sample.ts",
        content: "const value = 1;",
        startLine: 1,
        endLine: 1,
        language: "typescript",
        symbolName: "value",
        commitSha: jobData.commitSha,
        embedding: [],
        sourceBlobSha: null,
        embeddingStatus: "pending",
        isActive: false,
        ingestionAttempt: jobData.ingestionAttempt,
        batchExecutionToken: null,
      })),
    embedder: async () => {
      prisma.branch!.status = "failed";
      prisma.branch!.processingToken = null;
      return [[1, 2, 3], [4, 5, 6]];
    },
  };

  await assert.rejects(
    processChunkEmbeddingJob(jobData, deps),
    BatchOwnershipLostError,
  );
  assert.deepEqual(chunkStore.persisted, []);
});
