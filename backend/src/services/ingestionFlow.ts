import { ingestionLimits } from "../config/ingestionLimits.js";
import { prisma } from "../database/prisma.js";
import { enqueueIngestion, type IngestionJob } from "../jobs/ingestionQueue.js";
import {
  resolveGitHubRepository,
  type GitHubRepositoryMetadata,
} from "./githubRepository.js";
import {
  checkGitHubIngestionLimits,
  type GitHubIngestionLimits,
} from "./githubIngestionLimits.js";

export interface IngestionBranch {
  id: string;
  repositoryId: string;
  branchName: string;
  status: string;
  attempt: number;
}

export type IngestionStoreResult =
  | { state: "available"; branch: IngestionBranch }
  | { state: "accepted"; branch: IngestionBranch };

export interface IngestionStore {
  findBranchIndex(
    githubRepoId: bigint,
    branchName: string,
  ): Promise<IngestionBranch | null>;
  attachUser(userId: string, branchIndexId: string): Promise<void>;
  acceptIngestion(
    userId: string,
    repository: GitHubRepositoryMetadata,
    lifetimeLimit: number,
  ): Promise<IngestionStoreResult>;
  markEnqueueFailed(
    branchIndexId: string,
    attempt: number,
    error: string,
  ): Promise<void>;
}

export class RepositoryIngestionError extends Error {
  constructor(
    message: string,
    readonly statusCode: number,
  ) {
    super(message);
    this.name = "RepositoryIngestionError";
  }
}

export type InitiateIngestionOutcome = {
  state: "attached";
  repository: GitHubRepositoryMetadata;
  repositoryId: string;
  branchIndexId: string;
  status: "ready" | "indexing";
};

export interface IngestionDependencies {
  store: IngestionStore;
  queue: (job: IngestionJob) => Promise<void>;
  resolve: (url: string) => Promise<GitHubRepositoryMetadata>;
  checkLimits: (
    repository: GitHubRepositoryMetadata,
    limits: GitHubIngestionLimits,
  ) => Promise<void>;
  lifetimeLimit: number;
}

export async function initiateRepositoryIngestion(
  url: string,
  userId: string,
  dependencies: IngestionDependencies = defaultDependencies,
): Promise<InitiateIngestionOutcome> {
  const repository = await dependencies.resolve(url);
  const existing = await dependencies.store.findBranchIndex(
    repository.githubRepoId,
    repository.branchName,
  );

  if (existing && isAvailableStatus(existing.status)) {
    await dependencies.store.attachUser(userId, existing.id);
    return toAttachedOutcome(repository, existing);
  }
  if (existing && existing.status !== "failed") {
    throw new RepositoryIngestionError(
      "This branch has an unsupported indexing status. Please contact support.",
      409,
    );
  }

  await dependencies.checkLimits(repository, ingestionLimits);
  const result = await dependencies.store.acceptIngestion(
    userId,
    repository,
    dependencies.lifetimeLimit,
  );
  if (result.state === "available") {
    return toAttachedOutcome(repository, result.branch);
  }

  try {
    await dependencies.queue({
      branchIndexId: result.branch.id,
      repositoryId: result.branch.repositoryId,
      branchName: result.branch.branchName,
      attempt: result.branch.attempt,
    });
  } catch (error) {
    const detail =
      error instanceof Error ? error.message : "Unknown queue error";
    try {
      await dependencies.store.markEnqueueFailed(
        result.branch.id,
        result.branch.attempt,
        detail,
      );
    } catch (databaseError) {
      console.error("Could not record ingestion enqueue failure", {
        branchIndexId: result.branch.id,
        enqueueError: detail,
        databaseError:
          databaseError instanceof Error
            ? databaseError.message
            : "Unknown database error",
      });
    }
    console.error("Could not enqueue repository ingestion", {
      branchIndexId: result.branch.id,
      attempt: result.branch.attempt,
      error: detail,
    });
    throw new RepositoryIngestionError(
      "Ingestion could not be queued. Please try again.",
      503,
    );
  }

  return toAttachedOutcome(repository, result.branch);
}

const prismaIngestionStore: IngestionStore = {
  async findBranchIndex(githubRepoId, branchName) {
    const record = await prisma.branchIndex.findFirst({
      where: { branchName, repository: { githubRepoId } },
      select: {
        id: true,
        repositoryId: true,
        branchName: true,
        status: true,
        ingestionAttempt: true,
      },
    });
    return record
      ? {
          id: record.id,
          repositoryId: record.repositoryId,
          branchName: record.branchName,
          status: record.status,
          attempt: record.ingestionAttempt,
        }
      : null;
  },

  async attachUser(userId, branchIndexId) {
    await prisma.userBranchAccess.upsert({
      where: { userId_branchIndexId: { userId, branchIndexId } },
      create: { userId, branchIndexId },
      update: {},
    });
  },

  async acceptIngestion(userId, repository, lifetimeLimit) {
    return prisma.$transaction(async (transaction) => {
      const repositoryRecord = await transaction.repository.upsert({
        where: { githubRepoId: repository.githubRepoId },
        create: {
          githubRepoId: repository.githubRepoId,
          owner: repository.owner,
          name: repository.name,
          htmlUrl: repository.htmlUrl,
          defaultBranch: repository.defaultBranch,
        },
        update: {
          owner: repository.owner,
          name: repository.name,
          htmlUrl: repository.htmlUrl,
          defaultBranch: repository.defaultBranch,
        },
        select: { id: true },
      });

      await transaction.$queryRaw<Array<{ id: string }>>`
          SELECT id FROM repositories WHERE id = ${repositoryRecord.id}::uuid FOR UPDATE
        `;

      let branch = await transaction.branchIndex.findUnique({
        where: {
          repositoryId_branchName: {
            repositoryId: repositoryRecord.id,
            branchName: repository.branchName,
          },
        },
        select: {
          id: true,
          repositoryId: true,
          branchName: true,
          status: true,
          ingestionAttempt: true,
        },
      });
      if (branch) {
        await transaction.$queryRaw<Array<{ id: string }>>`
            SELECT id FROM branch_indexes WHERE id = ${branch.id}::uuid FOR UPDATE
          `;
        branch = await transaction.branchIndex.findUnique({
          where: { id: branch.id },
          select: {
            id: true,
            repositoryId: true,
            branchName: true,
            status: true,
            ingestionAttempt: true,
          },
        });
      }

      if (branch && isAvailableStatus(branch.status)) {
        await upsertUserAccess(transaction, userId, branch.id);
        return {
          state: "available" as const,
          branch: toIngestionBranch(branch),
        };
      }
      if (branch && branch.status !== "failed") {
        throw new RepositoryIngestionError(
          "This branch has an unsupported indexing status. Please contact support.",
          409,
        );
      }

      await transaction.$queryRaw<Array<{ id: string }>>`
          SELECT id FROM users WHERE id = ${userId}::uuid FOR UPDATE
        `;
      const existingInitiation = branch
        ? await transaction.userBranchIngestion.findUnique({
            where: {
              userId_branchIndexId: {
                userId,
                branchIndexId: branch.id,
              },
            },
            select: { userId: true },
          })
        : null;
      if (!existingInitiation) {
        const initiationCount = await transaction.userBranchIngestion.count({
          where: { userId },
        });
        if (initiationCount >= lifetimeLimit) {
          throw new RepositoryIngestionError(
            "Your lifetime ingestion limit has been reached.",
            429,
          );
        }
      }

      if (!branch) {
        branch = await transaction.branchIndex.create({
          data: {
            repositoryId: repositoryRecord.id,
            branchName: repository.branchName,
            status: "queued",
            ingestionAttempt: 1,
          },
          select: {
            id: true,
            repositoryId: true,
            branchName: true,
            status: true,
            ingestionAttempt: true,
          },
        });
      } else {
        branch = await transaction.branchIndex.update({
          where: { id: branch.id },
          data: {
            status: "queued",
            ingestionAttempt: { increment: 1 },
            lastError: null,
          },
          select: {
            id: true,
            repositoryId: true,
            branchName: true,
            status: true,
            ingestionAttempt: true,
          },
        });
      }

      await transaction.userBranchIngestion.upsert({
        where: {
          userId_branchIndexId: {
            userId,
            branchIndexId: branch.id,
          },
        },
        create: { userId, branchIndexId: branch.id },
        update: {},
      });
      await upsertUserAccess(transaction, userId, branch.id);
      return {
        state: "accepted" as const,
        branch: toIngestionBranch(branch),
      };
    });
  },

  async markEnqueueFailed(branchIndexId, attempt, error) {
    await prisma.branchIndex.updateMany({
      where: {
        id: branchIndexId,
        ingestionAttempt: attempt,
        status: "queued",
      },
      data: { status: "failed", lastError: error.slice(0, 4000) },
    });
  },
};

const defaultDependencies: IngestionDependencies = {
  store: prismaIngestionStore,
  queue: enqueueIngestion,
  resolve: resolveGitHubRepository,
  checkLimits: (repository, limits) =>
    checkGitHubIngestionLimits(
      repository.owner,
      repository.name,
      repository.branchName,
      limits,
    ),
  lifetimeLimit: ingestionLimits.lifetimeIngestionsPerUser,
};

async function upsertUserAccess(
  transaction: Parameters<Parameters<typeof prisma.$transaction>[0]>[0],
  userId: string,
  branchIndexId: string,
): Promise<void> {
  await transaction.userBranchAccess.upsert({
    where: { userId_branchIndexId: { userId, branchIndexId } },
    create: { userId, branchIndexId },
    update: {},
  });
}

function isAvailableStatus(status: string): boolean {
  return status === "ready" || status === "queued" || status === "ingesting";
}

function toIngestionBranch(branch: {
  id: string;
  repositoryId: string;
  branchName: string;
  status: string;
  ingestionAttempt: number;
}): IngestionBranch {
  return {
    id: branch.id,
    repositoryId: branch.repositoryId,
    branchName: branch.branchName,
    status: branch.status,
    attempt: branch.ingestionAttempt,
  };
}

function toAttachedOutcome(
  repository: GitHubRepositoryMetadata,
  branch: IngestionBranch,
): InitiateIngestionOutcome {
  return {
    state: "attached",
    repository,
    repositoryId: branch.repositoryId,
    branchIndexId: branch.id,
    status: branch.status === "ready" ? "ready" : "indexing",
  };
}
