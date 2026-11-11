import { Worker, type Job } from "bullmq";
import { randomUUID } from "node:crypto";
import { createRedisConnection } from "../config/redis.js";
import { ingestionLimits } from "../config/ingestionLimits.js";
import { prisma as defaultPrisma } from "../database/prisma.js";
import {
  fetchIndexableFiles,
  fetchBlobContent,
  type IndexableFileEntry,
  type GitHubIngestionLimits,
} from "../services/githubIngestionLimits.js";
import {
  getGitHubJson,
  GitHubRepositoryError,
} from "../services/githubRepository.js";
import {
  chunkSourceFile,
  type CodeChunk,
  type ChunkerConfig,
} from "../services/codeChunker.js";
import { generateVoyageEmbeddings } from "../services/voyageEmbedding.js";
import { buildChunkEmbeddingText } from "../services/embeddingContext.js";
import {
  prismaCodeChunkStore,
  IngestionOwnershipLostError,
  type CodeChunkStore,
  type StorableCodeChunk,
} from "../services/codeChunkStore.js";
import type { IngestionJob } from "./ingestionQueue.js";

export interface IngestionWorkerDependencies {
  prisma: typeof defaultPrisma;
  chunkStore: CodeChunkStore;
  resolveCommit: (
    owner: string,
    repo: string,
    branchName: string,
  ) => Promise<string>;
  fetchTree: (
    owner: string,
    repo: string,
    commitSha: string,
    limits?: GitHubIngestionLimits,
  ) => Promise<IndexableFileEntry[]>;
  fetchContent: (
    owner: string,
    repo: string,
    blobSha: string,
  ) => Promise<string>;
  chunker: (
    filePath: string,
    content: string,
    commitSha: string,
    config?: ChunkerConfig,
  ) => Promise<CodeChunk[]>;
  embedder: (texts: string[]) => Promise<number[][]>;
}

export async function resolveBranchCommit(
  owner: string,
  repo: string,
  branchName: string,
  fetcher: typeof fetch = fetch,
): Promise<string> {
  const apiRoot = `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`;
  const branchData = await getGitHubJson<{ commit?: { sha?: unknown } }>(
    `${apiRoot}/branches/${encodeURIComponent(branchName)}`,
    fetcher,
  );

  const sha = branchData.commit?.sha;
  if (typeof sha !== "string" || !/^[a-f0-9]{40}$/i.test(sha)) {
    throw new GitHubRepositoryError(
      "GitHub did not provide a valid commit SHA for this branch.",
      502,
    );
  }
  return sha;
}

export const defaultWorkerDependencies: IngestionWorkerDependencies = {
  prisma: defaultPrisma,
  chunkStore: prismaCodeChunkStore,
  resolveCommit: (owner, repo, branch) =>
    resolveBranchCommit(owner, repo, branch),
  fetchTree: (owner, repo, commitSha, limits) =>
    fetchIndexableFiles(owner, repo, commitSha, limits),
  fetchContent: (owner, repo, blobSha) =>
    fetchBlobContent(owner, repo, blobSha),
  chunker: (path, content, sha, cfg) =>
    chunkSourceFile(path, content, sha, cfg),
  embedder: (texts) => generateVoyageEmbeddings(texts),
};

export async function processIngestionJob(
  jobData: IngestionJob,
  deps: IngestionWorkerDependencies = defaultWorkerDependencies,
): Promise<void> {
  const processingToken = randomUUID();
  const branchIndex = await deps.prisma.branchIndex.findUnique({
    where: { id: jobData.branchIndexId },
    include: { repository: true },
  });

  if (!branchIndex) {
    console.warn(
      `BranchIndex ${jobData.branchIndexId} not found, skipping job.`,
    );
    return;
  }

  if (branchIndex.status === "ready") {
    console.info(
      `BranchIndex ${jobData.branchIndexId} is already ready, skipping.`,
    );
    return;
  }
  // Skip superseded attempts
  if (branchIndex.ingestionAttempt !== jobData.attempt) {
    console.info(
      `BranchIndex ${jobData.branchIndexId} attempt ${jobData.attempt} is superseded by attempt ${branchIndex.ingestionAttempt}, skipping.`,
    );
    return;
  }

  // Claiming an already-ingesting branch is how stalled BullMQ deliveries resume.
  const transition = await deps.prisma.branchIndex.updateMany({
    where: {
      id: jobData.branchIndexId,
      ingestionAttempt: jobData.attempt,
      status: { in: ["queued", "failed", "ingesting"] },
    },
    data: {
      status: "ingesting",
      lastError: null,
      processingToken,
    },
  });

  if (transition.count === 0) {
    return;
  }

  try {
    // Resolve branch to specific commit SHA
    const commitSha = await deps.resolveCommit(
      branchIndex.repository.owner,
      branchIndex.repository.name,
      branchIndex.branchName,
    );

    // Retrieve and validate complete file tree and limits
    const files = await deps.fetchTree(
      branchIndex.repository.owner,
      branchIndex.repository.name,
      commitSha,
      ingestionLimits,
    );

    // Fetch eligible source files with size limits
    const maxFileBytes = ingestionLimits.maxFileSizeBytes;
    const maxTotalBytes = ingestionLimits.indexableSourceBytes;
    let cumulativeBytes = 0;
    const allChunks: StorableCodeChunk[] = [];

    for (const file of files) {
      if (file.size > maxFileBytes) {
        throw new Error(
          `File ${file.path} (${file.size} bytes) exceeds individual file limit (${maxFileBytes} bytes).`,
        );
      }
      cumulativeBytes += file.size;
      if (cumulativeBytes > maxTotalBytes) {
        throw new Error(
          `Cumulative source content exceeds limit (${maxTotalBytes} bytes).`,
        );
      }

      const content = await deps.fetchContent(
        branchIndex.repository.owner,
        branchIndex.repository.name,
        file.sha,
      );

      const chunks = await deps.chunker(file.path, content, commitSha, {
        maxChunkChars: ingestionLimits.maxChunkChars,
        minChunkChars: ingestionLimits.minChunkChars,
        targetChunkChars: ingestionLimits.targetChunkChars,
        maxTokensPerChunk: ingestionLimits.maxTokensPerChunk,
        chunkOverlapLines: ingestionLimits.chunkOverlapLines,
      });

      for (const chunk of chunks) {
        allChunks.push({
          ...chunk,
          embedding: [],
          branchIndexId: branchIndex.id,
        });
      }
    }

    // Generate embeddings in batches via Voyage AI
    if (allChunks.length > 0) {
      const texts = allChunks.map((c) => buildChunkEmbeddingText(c));
      const embeddings = await deps.embedder(texts);

      if (embeddings.length !== allChunks.length) {
        throw new Error(
          `Embedding count mismatch (expected ${allChunks.length}, got ${embeddings.length}).`,
        );
      }

      for (let i = 0; i < allChunks.length; i++) {
        allChunks[i].embedding = embeddings[i];
      }
    }

    // Store chunks and embeddings atomically
    await deps.chunkStore.saveChunks(
      branchIndex.id,
      jobData.attempt,
      processingToken,
      allChunks,
    );

    const readyTransition = await deps.prisma.branchIndex.updateMany({
      where: {
        id: branchIndex.id,
        ingestionAttempt: jobData.attempt,
        status: "ingesting",
        processingToken,
      },
      data: {
        status: "ready",
        lastError: null,
        processingToken: null,
      },
    });
    if (readyTransition.count === 0) {
      return;
    }
  } catch (error) {
    if (error instanceof IngestionOwnershipLostError) {
      return;
    }

    const errorMsg =
      error instanceof Error ? error.message : "Unknown ingestion failure";

    try {
      await deps.chunkStore.deleteBranchChunks(
        branchIndex.id,
        jobData.attempt,
        processingToken,
      );
    } catch (cleanupError) {
      if (cleanupError instanceof IngestionOwnershipLostError) {
        return;
      }
      console.error(
        `Failed to clean up chunks for branch ${branchIndex.id}:`,
        cleanupError,
      );
    }

    console.error(`Ingestion failed for branch ${branchIndex.id}:`, errorMsg);
    throw error;
  }
}

export async function handleIngestionJobFailure(
  job: Pick<Job<IngestionJob>, "data" | "getState">,
  error: Error,
  db: IngestionWorkerDependencies["prisma"] = defaultPrisma,
): Promise<void> {
  if ((await job.getState()) !== "failed") {
    return;
  }

  await db.branchIndex.updateMany({
    where: {
      id: job.data.branchIndexId,
      ingestionAttempt: job.data.attempt,
      status: { not: "ready" },
    },
    data: {
      status: "failed",
      lastError: error.message.slice(0, 4000),
      processingToken: null,
    },
  });
}

let ingestionWorker: Worker<IngestionJob> | undefined;

export function startIngestionWorker(
  deps: IngestionWorkerDependencies = defaultWorkerDependencies,
): Worker<IngestionJob> {
  if (ingestionWorker) return ingestionWorker;

  ingestionWorker = new Worker<IngestionJob>(
    "repository-ingestion",
    async (job: Job<IngestionJob>) => {
      console.log(
        `Worker starting job for repoId: ${job.data.repositoryId}, branchId: ${job.data.branchIndexId}`,
      );
      await processIngestionJob(job.data, deps);
    },
    {
      connection: createRedisConnection({
        connectTimeout: 10_000,
        retryStrategy: (attempt) =>
          attempt > 3 ? null : Math.min(attempt * 250, 1000),
      }),
      concurrency: 2,
      lockDuration: 300_000,
    },
  );

  ingestionWorker.on("failed", (job, err) => {
    console.error(
      `Job ${job?.id} failed for branchIndex ${job?.data?.branchIndexId}:`,
      err.message,
    );
    if (job) {
      void handleIngestionJobFailure(job, err, deps.prisma).catch(
        (failureError: unknown) => {
          console.error("Could not record terminal ingestion failure", {
            branchIndexId: job.data.branchIndexId,
            attempt: job.data.attempt,
            error:
              failureError instanceof Error
                ? failureError.message
                : "Unknown database error",
          });
        },
      );
    }
  });

  return ingestionWorker;
}

export async function closeIngestionWorker(): Promise<void> {
  if (ingestionWorker) {
    await ingestionWorker.close();
    ingestionWorker = undefined;
  }
}
