import assert from "node:assert/strict";
import test from "node:test";
import type { GitHubRepositoryMetadata } from "../services/githubRepository.js";
import {
  getUserRepositories,
  resolveAndAttachRepository,
  type ExistingBranchIndex,
  type RepositoryStore,
  type UserBranchRecord,
} from "../services/repositoryFlow.js";

const githubRepository: GitHubRepositoryMetadata = {
  githubRepoId: 987n,
  owner: "owner",
  name: "repo",
  htmlUrl: "https://github.com/owner/repo",
  defaultBranch: "main",
  branchName: "main",
};

test("attaches ready branch access idempotently and does not create duplicate access", async () => {
  const store = fakeStore({
    id: "branch-id",
    repositoryId: "repo-id",
    status: "ready",
  });

  const first = await resolveAndAttachRepository(
    "https://github.com/owner/repo",
    "authenticated-user",
    store,
    async () => githubRepository,
  );
  const second = await resolveAndAttachRepository(
    "https://github.com/owner/repo",
    "authenticated-user",
    store,
    async () => githubRepository,
  );

  assert.equal(first.state, "attached");
  assert.equal(second.state, "attached");
  assert.equal(store.access.size, 1);
  assert.equal([...store.access][0], "authenticated-user:branch-id");
});

test("reuses queued index status without starting duplicate processing", async () => {
  const store = fakeStore({
    id: "queued-branch",
    repositoryId: "repo-id",
    status: "queued",
  });
  const result = await resolveAndAttachRepository(
    "https://github.com/owner/repo",
    "authenticated-user",
    store,
    async () => githubRepository,
  );

  assert.deepEqual(
    result.state === "attached" ? result.status : result.status,
    "indexing",
  );
  assert.equal(store.access.size, 1);
});

test("requires confirmation for new and failed branches without writing access", async () => {
  for (const branch of [
    null,
    { id: "failed", repositoryId: "repo-id", status: "failed" },
  ]) {
    const store = fakeStore(branch);
    const result = await resolveAndAttachRepository(
      "https://github.com/owner/repo",
      "authenticated-user",
      store,
      async () => githubRepository,
    );

    assert.equal(result.state, "confirmation_required");
    assert.equal(
      result.state === "confirmation_required" ? result.status : "unexpected",
      branch ? "failed" : "not_indexed",
    );
    assert.equal(store.access.size, 0);
  }
});

test("lists user access grouped by repository with index statuses", async () => {
  const store = fakeStore(null, [
    {
      id: "branch-id",
      name: "main",
      status: "ready",
      repository: {
        id: "repo-id",
        owner: "owner",
        name: "repo",
        htmlUrl: "https://github.com/owner/repo",
      },
    },
  ]);
  const repositories = await getUserRepositories("authenticated-user", store);
  assert.equal(repositories.length, 1);
  assert.equal(repositories[0].branches[0].status, "ready");
});

function fakeStore(
  branch: (ExistingBranchIndex & { repositoryId: string }) | null,
  records: UserBranchRecord[] = [],
): RepositoryStore & { access: Set<string> } {
  const access = new Set<string>();
  return {
    access,
    async findBranchIndex() {
      return branch;
    },
    async attachUser(userId, branchIndexId) {
      access.add(`${userId}:${branchIndexId}`);
    },
    async listUserBranches() {
      return records;
    },
  };
}
