import { Queue } from "bullmq";
import { createRedisConnection } from "../config/redis.js";

function positiveIntegerEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer.`);
  }
  return value;
}

const embeddingJobAttempts = positiveIntegerEnv(
  "REPOLENS_CHUNK_EMBEDDING_ATTEMPTS",
  3,
);
const embeddingBackoffMs = positiveIntegerEnv(
  "REPOLENS_CHUNK_EMBEDDING_BACKOFF_MS",
  1000,
);

export interface ChunkEmbeddingJob {
  branchIndexId: string;
  ingestionAttempt: number;
  processingToken: string;
  commitSha: string;
  chunkIds: string[];
}

let chunkEmbeddingQueue: Queue<ChunkEmbeddingJob> | undefined;

export function enqueueChunkEmbeddings(
  job: ChunkEmbeddingJob,
): Promise<void> {
  if (job.chunkIds.length === 0) {
    return Promise.resolve();
  }

  chunkEmbeddingQueue ??= new Queue<ChunkEmbeddingJob>("chunk-embedding", {
    connection: createRedisConnection({
      connectTimeout: 10_000,
      retryStrategy: (attempt) =>
        attempt > 3 ? null : Math.min(attempt * 250, 1000),
    }),
  });

  const queue = chunkEmbeddingQueue;
  return queue
    .add("embed-batch", job, {
      jobId: `chunk-${job.branchIndexId}-${job.ingestionAttempt}-${job.processingToken}-${job.chunkIds[0]}`,
      attempts: embeddingJobAttempts,
      backoff: {
        type: "exponential",
        delay: embeddingBackoffMs,
      },
      removeOnComplete: 100,
      removeOnFail: 100,
    })
    .then(() => undefined)
    .catch(async (error: unknown) => {
      if (chunkEmbeddingQueue === queue) {
        chunkEmbeddingQueue = undefined;
        try {
          await queue.close();
        } catch (closeError) {
          console.error("Could not close failed chunk-embedding queue", {
            error:
              closeError instanceof Error
                ? closeError.message
                : "Unknown queue close error",
          });
        }
      }
      throw error;
    });
}

export async function closeChunkEmbeddingQueue(): Promise<void> {
  await chunkEmbeddingQueue?.close();
  chunkEmbeddingQueue = undefined;
}
