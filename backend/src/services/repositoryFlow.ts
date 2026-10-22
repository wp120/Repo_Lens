import { prisma } from "../database/prisma.js";
import {
  resolveGitHubRepository,
  type GitHubRepositoryMetadata,
} from "./githubRepository.js";

export interface ExistingBranchIndex {
  id: string;
  status: string;
  repositoryId: string;
}

export interface UserBranchRecord {
  id: string;
  name: string;
  status: string;
  repository: {
    id: string;
    owner: string;
    name: string;
    htmlUrl: string;
  };
}

export interface RepositoryStore {
  findBranchIndex(
    githubRepoId: bigint,
    branchName: string,
  ): Promise<ExistingBranchIndex | null>;
  attachUser(userId: string, branchIndexId: string): Promise<void>;
  listUserBranches(userId: string): Promise<UserBranchRecord[]>;
}

export interface DashboardRepository {
  id: string;
  name: string;
  owner: string;
  url: string;
  branches: {
    id: string;
    name: string;
    status: "ready" | "indexing" | "failed";
    conversations: [];
  }[];
}

export type AddRepositoryOutcome =
  | {
      state: "attached";
      repository: GitHubRepositoryMetadata;
      repositoryId: string;
      branchIndexId: string;
      status: "ready" | "indexing";
    }
  | {
      state: "confirmation_required";
      repository: GitHubRepositoryMetadata;
      status: "not_indexed" | "failed";
    };

export async function resolveAndAttachRepository(
  url: string,
  userId: string,
  store: RepositoryStore = prismaRepositoryStore,
  resolve: (
    url: string,
  ) => Promise<GitHubRepositoryMetadata> = resolveGitHubRepository,
): Promise<AddRepositoryOutcome> {
  const repository = await resolve(url);
  const branchIndex = await store.findBranchIndex(
    repository.githubRepoId,
    repository.branchName,
  );
  if (!branchIndex) {
    return {
      state: "confirmation_required",
      repository,
      status: "not_indexed",
    };
  }

  if (branchIndex.status === "failed") {
    return {
      state: "confirmation_required",
      repository,
      status: "failed",
    };
  }

  await store.attachUser(userId, branchIndex.id);
  return {
    state: "attached",
    repository,
    repositoryId: branchIndex.repositoryId,
    branchIndexId: branchIndex.id,
    status: branchIndex.status === "ready" ? "ready" : "indexing",
  };
}

export async function getUserRepositories(
  userId: string,
  store: RepositoryStore = prismaRepositoryStore,
): Promise<DashboardRepository[]> {
  const records = await store.listUserBranches(userId);
  const repositories = new Map<string, DashboardRepository>();

  for (const record of records) {
    let repository = repositories.get(record.repository.id);
    if (!repository) {
      repository = {
        id: record.repository.id,
        name: record.repository.name,
        owner: record.repository.owner,
        url: record.repository.htmlUrl,
        branches: [],
      };
      repositories.set(record.repository.id, repository);
    }
    repository.branches.push({
      id: record.id,
      name: record.name,
      status: toDashboardStatus(record.status),
      conversations: [],
    });
  }

  return [...repositories.values()];
}

const prismaRepositoryStore: RepositoryStore = {
  async findBranchIndex(githubRepoId, branchName) {
    return prisma.branchIndex
      .findFirst({
        where: {
          branchName,
          repository: { githubRepoId },
        },
        select: {
          id: true,
          status: true,
          repository: { select: { id: true } },
        },
      })
      .then((record) =>
        record
          ? {
              id: record.id,
              status: record.status,
              repositoryId: record.repository.id,
            }
          : null,
      );
  },
  async attachUser(userId, branchIndexId) {
    await prisma.userBranchAccess.upsert({
      where: {
        userId_branchIndexId: { userId, branchIndexId },
      },
      create: { userId, branchIndexId },
      update: {},
    });
  },
  async listUserBranches(userId) {
    const accessRecords = await prisma.userBranchAccess.findMany({
      where: { userId },
      orderBy: { createdAt: "desc" },
      select: {
        branchIndex: {
          select: {
            id: true,
            branchName: true,
            status: true,
            repository: {
              select: { id: true, owner: true, name: true, htmlUrl: true },
            },
          },
        },
      },
    });
    return accessRecords.map(({ branchIndex }) => ({
      id: branchIndex.id,
      name: branchIndex.branchName,
      status: branchIndex.status,
      repository: branchIndex.repository,
    }));
  },
};

function toDashboardStatus(status: string): "ready" | "indexing" | "failed" {
  if (status === "ready") return "ready";
  if (status === "failed") return "failed";
  return "indexing";
}
