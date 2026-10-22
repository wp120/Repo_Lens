import type { Repository, RepositoryBranch } from "../types/app";
import { apiMutate, apiRequest } from "./apiClient";

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
}

export const repositoryService: RepositoryService = {
  async listRepositories() {
    return apiRequest<Repository[]>("/api/repositories");
  },
  async addRepository(url) {
    return apiMutate<AddRepositoryResult>("/api/repositories/resolve", {
      url,
    });
  },
};

export function toDashboardRepository(
  result: Extract<AddRepositoryResult, { state: "attached" }>,
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
