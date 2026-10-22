import { Queue } from "bullmq";
import { createRedisConnection } from "../config/redis.js";

export interface IngestionJob {
  branchIndexId: string;
  repositoryId: string;
  branchName: string;
  attempt: number;
}

let ingestionQueue: Queue<IngestionJob> | undefined;

export function enqueueIngestion(job: IngestionJob): Promise<void> {
  ingestionQueue ??= new Queue<IngestionJob>("repository-ingestion", {
    connection: createRedisConnection({
      connectTimeout: 10_000,
      retryStrategy: (attempt) =>
        attempt > 3 ? null : Math.min(attempt * 250, 1000),
    }),
  });
  const queue = ingestionQueue;
  return queue
    .add("index-branch", job, {
      jobId: `branch-${job.branchIndexId}-${job.attempt}`,
      removeOnComplete: 100,
      removeOnFail: 100,
    })
    .then(() => undefined)
    .catch(async (error: unknown) => {
      if (ingestionQueue === queue) {
        ingestionQueue = undefined;
        try {
          await queue.close();
        } catch (closeError) {
          console.error("Could not close failed ingestion queue", {
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

export async function closeIngestionQueue(): Promise<void> {
  await ingestionQueue?.close();
  ingestionQueue = undefined;
}
