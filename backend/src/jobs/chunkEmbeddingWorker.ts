import { Worker, type Job } from "bullmq";
import { randomUUID } from "node:crypto";
import { createRedisConnection } from "../config/redis.js";
import { prisma as defaultPrisma } from "../database/prisma.js";
import { buildChunkEmbeddingText } from "../services/embeddingContext.js";
import {
  BatchOwnershipLostError,
  IngestionOwnershipLostError,
  prismaCodeChunkStore,
  type CodeChunkRecord,
  type CodeChunkStore,
} from "../services/codeChunkStore.js";
import { generateVoyageEmbeddings } from "../services/voyageEmbedding.js";
import type { ChunkEmbeddingJob } from "./chunkEmbeddingQueue.js";

export interface ChunkEmbeddingWorkerDependencies {
  prisma: typeof defaultPrisma;
  chunkStore: CodeChunkStore;
  fetchChunkBatch: (branchIndexId: string, chunkIds: string[]) => Promise<CodeChunkRecord[]>;
  embedder: (texts: string[]) => Promise<number[][]>;
}

export const defaultChunkEmbeddingDependencies: ChunkEmbeddingWorkerDependencies = {
  prisma: defaultPrisma,
  chunkStore: prismaCodeChunkStore,
  fetchChunkBatch: async (branchIndexId, chunkIds) =>
    (await defaultPrisma.codeChunk.findMany({
      where: { branchIndexId, id: { in: chunkIds } },
    })) as unknown as CodeChunkRecord[],
  embedder: (texts) => generateVoyageEmbeddings(texts),
};

export async function handleChunkEmbeddingJobFailure(
  job: Pick<
    Job<ChunkEmbeddingJob>,
    "data" | "attemptsMade" | "opts" | "getState"
  >,
  error: Error,
  chunkStore: CodeChunkStore = prismaCodeChunkStore,
): Promise<boolean> {
  const state = await job.getState();
  const attempts = job.opts.attempts ?? 1;
  if (state !== "failed" || job.attemptsMade < attempts) {
    return false;
  }

  if (!chunkStore.failIngestion) {
    throw new Error("Terminal ingestion failure handling is not configured.");
  }

  const failureMessage =
    error.message.trim() || "Chunk embedding failed after all retry attempts.";
  const transitioned = await chunkStore.failIngestion(
    job.data.branchIndexId,
    job.data.ingestionAttempt,
    job.data.processingToken,
    failureMessage,
  );
  if (!transitioned) {
    console.info("Ignoring stale terminal chunk embedding failure", {
      branchIndexId: job.data.branchIndexId,
      ingestionAttempt: job.data.ingestionAttempt,
    });
  } else {
    console.error("Marked branch ingestion failed after terminal batch failure", {
      branchIndexId: job.data.branchIndexId,
      ingestionAttempt: job.data.ingestionAttempt,
      error: failureMessage,
    });
  }
  return transitioned;
}

export async function processChunkEmbeddingJob(
  jobData: ChunkEmbeddingJob,
  deps: ChunkEmbeddingWorkerDependencies = defaultChunkEmbeddingDependencies,
): Promise<void> {
  const batchExecutionToken = randomUUID();
  const logContext = {
    branchIndexId: jobData.branchIndexId,
    ingestionAttempt: jobData.ingestionAttempt,
    chunkCount: jobData.chunkIds.length,
  };
  console.info("Starting chunk embedding batch", logContext);

  const branchIndex = await deps.prisma.branchIndex.findUnique({
    where: { id: jobData.branchIndexId },
  });

  if (!branchIndex) {
    console.warn("Skipping chunk batch: branch index was not found", logContext);
    return;
  }

  if (
    branchIndex.ingestionAttempt !== jobData.ingestionAttempt ||
    branchIndex.processingToken !== jobData.processingToken
  ) {
    console.info("Skipping stale chunk batch", {
      ...logContext,
      jobProcessingToken: jobData.processingToken,
      currentIngestionAttempt: branchIndex.ingestionAttempt,
      currentProcessingToken: branchIndex.processingToken,
    });
    return;
  }

  if (!deps.chunkStore.claimBatchChunks) {
    throw new Error("Batch chunk claiming is not configured.");
  }
  if (!deps.chunkStore.finalizeIngestion) {
    throw new Error("Ingestion finalization is not configured.");
  }
  const finalizeIngestion =
    deps.chunkStore.finalizeIngestion.bind(deps.chunkStore);

  const finalizeIfComplete = async (): Promise<boolean> => {
    const finalized = await finalizeIngestion(
      jobData.branchIndexId,
      jobData.ingestionAttempt,
      jobData.processingToken,
      jobData.commitSha,
    );
    console.info(
      finalized
        ? "Finalized and published branch after embedding batch"
        : "Branch finalization deferred; staged chunks remain incomplete",
      logContext,
    );
    return finalized;
  };

  const finalizePreviouslyCompletedBatch = async (): Promise<void> => {
    try {
      await finalizeIfComplete();
    } catch (error) {
      if (error instanceof IngestionOwnershipLostError) {
        return;
      }
      throw error;
    }
  };

  let claimed: CodeChunkRecord[] = [];
  try {
    claimed = await deps.chunkStore.claimBatchChunks(
      jobData.branchIndexId,
      jobData.ingestionAttempt,
      jobData.processingToken,
      batchExecutionToken,
      jobData.chunkIds,
    );
  } catch (error) {
    if (error instanceof IngestionOwnershipLostError) {
      console.info(
        "Skipping chunk batch after repository ownership loss",
        logContext,
      );
      return;
    }
    throw error;
  }

  console.info("Claimed staged chunks for embedding", {
    ...logContext,
    claimedChunkCount: claimed.length,
    batchExecutionToken,
  });

  if (claimed.length === 0) {
    await finalizePreviouslyCompletedBatch();
    return;
  }

  try {
    const chunks = await deps.fetchChunkBatch(
      jobData.branchIndexId,
      claimed.map((chunk) => chunk.id),
    );
    if (chunks.length !== claimed.length) {
      throw new Error(
        `Claimed chunk count mismatch (expected ${claimed.length}, got ${chunks.length}).`,
      );
    }

    console.info("Generating embeddings for claimed chunks", {
      ...logContext,
      claimedChunkCount: chunks.length,
    });
    const texts = chunks.map((chunk) => buildChunkEmbeddingText(chunk));
    const embeddings = await deps.embedder(texts);
    if (embeddings.length !== chunks.length) {
      throw new Error(
        `Embedding count mismatch (expected ${chunks.length}, got ${embeddings.length}).`,
      );
    }
    console.info("Generated embeddings for chunk batch", {
      ...logContext,
      embeddingCount: embeddings.length,
    });

    if (!deps.chunkStore.persistBatchEmbeddings) {
      throw new Error("Batch embedding persistence is not configured.");
    }

    await deps.chunkStore.persistBatchEmbeddings(
      jobData.branchIndexId,
      jobData.ingestionAttempt,
      jobData.processingToken,
      batchExecutionToken,
      chunks.map((chunk) => chunk.id),
      embeddings,
    );
    console.info("Persisted embeddings for chunk batch", {
      ...logContext,
      persistedChunkCount: chunks.length,
    });
    await finalizeIfComplete();
  } catch (error) {
    if (
      error instanceof IngestionOwnershipLostError ||
      error instanceof BatchOwnershipLostError
    ) {
      console.warn("Chunk batch lost ownership before completion", {
        ...logContext,
        error: error.message,
      });
      throw error;
    }

    console.error("Chunk embedding batch failed", {
      ...logContext,
      error: error instanceof Error ? error.message : String(error),
    });

    if (deps.chunkStore.markBatchFailed) {
      try {
        await deps.chunkStore.markBatchFailed(
          jobData.branchIndexId,
          jobData.ingestionAttempt,
          jobData.processingToken,
          batchExecutionToken,
          claimed.map((chunk) => chunk.id),
        );
        console.info("Marked still-owned batch chunks failed", logContext);
      } catch (failureError) {
        console.error("Could not mark failed batch chunks", {
          ...logContext,
          error:
            failureError instanceof Error
              ? failureError.message
              : String(failureError),
        });
      }
    }
    throw error;
  }
}

let chunkEmbeddingWorker: Worker<ChunkEmbeddingJob> | undefined;

export function startChunkEmbeddingWorker(
  deps: ChunkEmbeddingWorkerDependencies = defaultChunkEmbeddingDependencies,
): Worker<ChunkEmbeddingJob> {
  if (chunkEmbeddingWorker) return chunkEmbeddingWorker;

  chunkEmbeddingWorker = new Worker<ChunkEmbeddingJob>(
    "chunk-embedding",
    async (job: Job<ChunkEmbeddingJob>) => {
      console.log(
        `Worker starting chunk batch for branchIndex ${job.data.branchIndexId} (${job.data.chunkIds.length} chunks)`,
      );
      await processChunkEmbeddingJob(job.data, deps);
    },
    {
      connection: createRedisConnection({
        connectTimeout: 10_000,
        retryStrategy: (attempt) =>
          attempt > 3 ? null : Math.min(attempt * 250, 1000),
      }),
      concurrency: 1,
      lockDuration: 300_000,
    },
  );

  chunkEmbeddingWorker.on("failed", (job, error) => {
    console.error("Chunk embedding BullMQ job failed", {
      jobId: job?.id,
      branchIndexId: job?.data.branchIndexId,
      ingestionAttempt: job?.data.ingestionAttempt,
      attemptsMade: job?.attemptsMade,
      error: error.message,
    });
    if (job) {
      void handleChunkEmbeddingJobFailure(job, error, deps.chunkStore).catch(
        (failureError: unknown) => {
          console.error("Could not record terminal chunk embedding failure", {
            jobId: job.id,
            branchIndexId: job.data.branchIndexId,
            ingestionAttempt: job.data.ingestionAttempt,
            error:
              failureError instanceof Error
                ? failureError.message
                : String(failureError),
          });
        },
      );
    }
  });

  chunkEmbeddingWorker.on("error", (error) => {
    console.error("Chunk embedding BullMQ worker error", {
      error: error.message,
    });
  });

  return chunkEmbeddingWorker;
}

export async function closeChunkEmbeddingWorker(): Promise<void> {
  if (chunkEmbeddingWorker) {
    await chunkEmbeddingWorker.close();
    chunkEmbeddingWorker = undefined;
  }
}
