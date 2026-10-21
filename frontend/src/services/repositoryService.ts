export interface AddRepositoryResult {
  repositoryId: string;
  repositoryName: string;
  defaultBranch: string;
}

export interface RepositoryService {
  addRepository(url: string): Promise<AddRepositoryResult>;
}

export const repositoryService: RepositoryService = {
  async addRepository() {
    throw new Error(
      "Repository connection is not available yet. No repository has been added.",
    );
  },
};
