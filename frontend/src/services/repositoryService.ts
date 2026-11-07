import type { Repository, RepositoryBranch } from "../types/app";
import { apiMutate, apiRequest } from "./apiClient";
import { conversationService } from "./conversationService";

export type AddRepositoryResult =
  | {
      state: "attached";
      repository: ResolvedRepository;
      repositoryId: string;
      branchIndexId: string;
      status: "ready" | "indexing";
    }
  | {
      state: "confirmation_required";
      repository: ResolvedRepository;
      status: "not_indexed" | "failed";
    };

interface ResolvedRepository {
  githubRepoId: string;
  owner: string;
  name: string;
  htmlUrl: string;
  defaultBranch: string;
  branchName: string;
}

export interface RepositoryService {
  listRepositories(): Promise<Repository[]>;
  addRepository(url: string): Promise<AddRepositoryResult>;
  initiateIngestion(url: string): Promise<AttachedRepositoryResult>;
}

export type AttachedRepositoryResult = Extract<
  AddRepositoryResult,
  { state: "attached" }
>;

export const repositoryService: RepositoryService = {
  async listRepositories() {
    const repositories = await apiRequest<Repository[]>("/api/repositories");
    return Promise.all(
      repositories.map(async (repository) => ({
        ...repository,
        branches: await Promise.all(
          repository.branches.map(async (branch) => ({
            ...branch,
            conversations: await conversationService.list(branch.id),
          })),
        ),
      })),
    );
  },
  async addRepository(url) {
    return apiMutate<AddRepositoryResult>("/api/repositories/resolve", {
      url,
    });
  },
  async initiateIngestion(url) {
    return apiMutate<AttachedRepositoryResult>("/api/repositories/ingest", {
      url,
    });
  },
};

export function toDashboardRepository(
  result: AttachedRepositoryResult,
): Repository {
  const branch: RepositoryBranch = {
    id: result.branchIndexId,
    name: result.repository.branchName,
    status: result.status,
    conversations: [],
  };
  return {
    id: result.repositoryId,
    name: result.repository.name,
    owner: result.repository.owner,
    url: result.repository.htmlUrl,
    branches: [branch],
  };
}
