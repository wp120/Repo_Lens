import { Worker, type Job } from "bullmq";
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
import {
  prismaCodeChunkStore,
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

  // Idempotency: Do not silently reprocess an already-ready or already-ingesting branch
  // below checks are not needed because we update for branches with status queued or failed only.
  if (branchIndex.status === "ready") {
    console.info(
      `BranchIndex ${jobData.branchIndexId} is already ready, skipping.`,
    );
    return;
  }
  if (branchIndex.status === "ingesting") {
    console.info(`BranchIndex ${branchIndex.id} is already ingesting, skipping.`);
    return;
  }

  // Skip superseded attempts
  if (branchIndex.ingestionAttempt > jobData.attempt) {
    console.info(
      `BranchIndex ${jobData.branchIndexId} attempt ${jobData.attempt} is superseded by attempt ${branchIndex.ingestionAttempt}, skipping.`,
    );
    return;
  }

  // Atomically update status to "ingesting"
  const transition = await deps.prisma.branchIndex.updateMany({
    where: {
      id: jobData.branchIndexId,
      ingestionAttempt: jobData.attempt,
      status: { in: ["queued", "failed"] },
    },
    data: {
      status: "ingesting",
      lastError: null,
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
      const texts = allChunks.map((c) => c.content);
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
    await deps.chunkStore.saveChunks(branchIndex.id, allChunks);

    // Update status to "ready"
    await deps.prisma.branchIndex.update({
      where: { id: branchIndex.id },
      data: {
        status: "ready",
        lastError: null,
      },
    });
  } catch (error) {
    const errorMsg =
      error instanceof Error ? error.message : "Unknown ingestion failure";

    try {
      await deps.chunkStore.deleteBranchChunks(branchIndex.id);
    } catch (cleanupError) {
      console.error(
        `Failed to clean up chunks for branch ${branchIndex.id}:`,
        cleanupError,
      );
    }

    await deps.prisma.branchIndex.updateMany({
      where: {
        id: branchIndex.id,
        ingestionAttempt: jobData.attempt,
      },
      data: {
        status: "failed",
        lastError: errorMsg.slice(0, 4000),
      },
    });

    throw error;
  }
}

let ingestionWorker: Worker<IngestionJob> | undefined;

export function startIngestionWorker(
  deps: IngestionWorkerDependencies = defaultWorkerDependencies,
): Worker<IngestionJob> {
  if (ingestionWorker) return ingestionWorker;

  ingestionWorker = new Worker<IngestionJob>(
    "repository-ingestion",
    async (job: Job<IngestionJob>) => {
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
  });

  return ingestionWorker;
}

export async function closeIngestionWorker(): Promise<void> {
  if (ingestionWorker) {
    await ingestionWorker.close();
    ingestionWorker = undefined;
  }
}
