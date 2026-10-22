import assert from "node:assert/strict";
import test from "node:test";
import type { GitHubRepositoryMetadata } from "../services/githubRepository.js";
import {
  initiateRepositoryIngestion,
  RepositoryIngestionError,
  type IngestionBranch,
  type IngestionDependencies,
  type IngestionStore,
} from "../services/ingestionFlow.js";
import {
  checkGitHubIngestionLimits,
  type GitHubIngestionLimits,
} from "../services/githubIngestionLimits.js";
import type { IngestionJob } from "../jobs/ingestionQueue.js";

const repository: GitHubRepositoryMetadata = {
  githubRepoId: 456n,
  owner: "sample",
  name: "repository",
  htmlUrl: "https://github.com/sample/repository",
  defaultBranch: "main",
  branchName: "main",
};

const limits: GitHubIngestionLimits = {
  repositorySizeKb: 10,
  indexableFileCount: 2,
  indexableSourceBytes: 100,
};

test("attaches ready and queued indexes without checking limits or enqueuing", async () => {
  for (const status of ["ready", "queued", "ingesting"]) {
    const store = new FakeIngestionStore({
      id: "branch",
      repositoryId: "repo",
      branchName: "main",
      status,
      attempt: 1,
    });
    const queue: IngestionJob[] = [];
    const dependencies = fakeDependencies(store, queue);

    const result = await initiateRepositoryIngestion(
      "url",
      "user",
      dependencies,
    );

    assert.equal(result.status, status === "ready" ? "ready" : "indexing");
    assert.equal(store.access.size, 1);
    assert.equal(queue.length, 0);
    assert.equal(dependencies.limitChecks, 0);
  }
});

test("rejects exhausted lifetime quota without creating access or a job", async () => {
  const store = new FakeIngestionStore();
  store.initiations.set("user", new Set(["previous-branch"]));
  const queue: IngestionJob[] = [];

  await assert.rejects(
    initiateRepositoryIngestion(
      "url",
      "user",
      fakeDependencies(store, queue, { lifetimeLimit: 1 }),
    ),
    (error: unknown) =>
      error instanceof RepositoryIngestionError &&
      error.statusCode === 429 &&
      /lifetime ingestion limit/i.test(error.message),
  );
  assert.equal(store.access.size, 0);
  assert.equal(store.branches.size, 0);
  assert.equal(queue.length, 0);
});

test("counts a user-branch initiation once and avoids repeat jobs", async () => {
  const store = new FakeIngestionStore();
  const queue: IngestionJob[] = [];
  const dependencies = fakeDependencies(store, queue);

  await initiateRepositoryIngestion("url", "user", dependencies);
  await initiateRepositoryIngestion("url", "user", dependencies);

  assert.equal(queue.length, 1);
  assert.equal(store.access.size, 1);
  assert.equal(store.initiations.get("user")?.size, 1);
  assert.equal(store.branches.size, 1);
});

test("concurrent confirmations enqueue only one shared branch job", async () => {
  const store = new FakeIngestionStore();
  const queue: IngestionJob[] = [];
  const dependencies = fakeDependencies(store, queue);

  await Promise.all([
    initiateRepositoryIngestion("url", "user-one", dependencies),
    initiateRepositoryIngestion("url", "user-two", dependencies),
  ]);

  assert.equal(queue.length, 1);
  assert.equal(store.branches.size, 1);
  assert.equal(store.initiations.get("user-one")?.size ?? 0, 1);
  assert.equal(store.initiations.get("user-two")?.size ?? 0, 0);
  assert.equal(store.access.size, 2);
});

test("retries failed branches explicitly with a new attempt but no duplicate slot", async () => {
  const failed: IngestionBranch = {
    id: "branch",
    repositoryId: "repo",
    branchName: "main",
    status: "failed",
    attempt: 1,
  };
  const store = new FakeIngestionStore(failed);
  store.initiations.set("user", new Set(["branch"]));
  const queue: IngestionJob[] = [];

  await initiateRepositoryIngestion(
    "url",
    "user",
    fakeDependencies(store, queue),
  );

  assert.equal(queue.length, 1);
  assert.equal(queue[0].attempt, 2);
  assert.equal(store.initiations.get("user")?.size, 1);
  assert.equal(store.branches.get("branch")?.status, "queued");
});

test("surfaces database failures and records queue failures for diagnosis", async () => {
  const databaseFailure = new Error("database unavailable");
  const failedStore = new FakeIngestionStore();
  failedStore.failAccept = databaseFailure;
  await assert.rejects(
    initiateRepositoryIngestion(
      "url",
      "user",
      fakeDependencies(failedStore, []),
    ),
    databaseFailure,
  );

  const store = new FakeIngestionStore();
  const dependencies = fakeDependencies(store, [], {
    queue: async () => {
      throw new Error("redis unavailable");
    },
  });
  await assert.rejects(
    initiateRepositoryIngestion("url", "user", dependencies),
    (error: unknown) =>
      error instanceof RepositoryIngestionError && error.statusCode === 503,
  );
  assert.equal(store.branches.get("branch-1")?.status, "failed");
  assert.match(store.lastError ?? "", /redis unavailable/);
});

test("rejects repositories that exceed repository size, file count, or source size limits", async () => {
  await assert.rejects(
    checkLimitsWith([
      { type: "repo", body: { size: 11 } },
      ...validMetadataResponses(),
    ]),
    (error: unknown) =>
      error instanceof Error && error.message.includes("repository size limit"),
  );
  await assert.rejects(
    checkLimitsWith([
      { type: "repo", body: { size: 1 } },
      ...validMetadataResponses([
        { type: "blob", path: "src/a.ts", size: 1 },
        { type: "blob", path: "src/b.py", size: 1 },
        { type: "blob", path: "src/c.go", size: 1 },
      ]),
    ]),
    (error: unknown) =>
      error instanceof Error && error.message.includes("file count"),
  );
  await assert.rejects(
    checkLimitsWith([
      { type: "repo", body: { size: 1 } },
      ...validMetadataResponses([
        { type: "blob", path: "src/a.ts", size: 80 },
        { type: "blob", path: "src/b.py", size: 30 },
      ]),
    ]),
    (error: unknown) =>
      error instanceof Error && error.message.includes("source size limit"),
  );
});

test("fails safely when GitHub tree is truncated or size metadata is missing", async () => {
  await assert.rejects(
    checkLimitsWith([
      { type: "repo", body: { size: 1 } },
      { type: "branch" },
      { type: "tree", body: { truncated: true, tree: [] } },
    ]),
    /incomplete branch file listing/,
  );
  await assert.rejects(
    checkLimitsWith([{ type: "repo", body: {} }, ...validMetadataResponses()]),
    /did not provide repository size information/,
  );
});

function fakeDependencies(
  store: FakeIngestionStore,
  jobs: IngestionJob[],
  options: {
    lifetimeLimit?: number;
    queue?: (job: IngestionJob) => Promise<void>;
  } = {},
): IngestionDependencies & { limitChecks: number } {
  const dependencies: IngestionDependencies & { limitChecks: number } = {
    store,
    queue: options.queue ?? (async (job) => void jobs.push(job)),
    resolve: async () => repository,
    checkLimits: async () => {
      dependencies.limitChecks += 1;
    },
    lifetimeLimit: options.lifetimeLimit ?? 5,
    limitChecks: 0,
  };
  return dependencies;
}

class FakeIngestionStore implements IngestionStore {
  readonly branches = new Map<string, IngestionBranch>();
  readonly access = new Set<string>();
  readonly initiations = new Map<string, Set<string>>();
  lastError: string | null = null;
  failAccept: Error | null = null;
  private nextBranchId = 1;
  private lock: Promise<void> = Promise.resolve();

  constructor(branch?: IngestionBranch) {
    if (branch) this.branches.set(branch.id, branch);
  }

  async findBranchIndex(): Promise<IngestionBranch | null> {
    return [...this.branches.values()][0] ?? null;
  }

  async attachUser(userId: string, branchIndexId: string): Promise<void> {
    this.access.add(`${userId}:${branchIndexId}`);
  }

  async acceptIngestion(
    userId: string,
    branchMetadata: GitHubRepositoryMetadata,
    lifetimeLimit: number,
  ) {
    if (this.failAccept) throw this.failAccept;
    let release = () => {};
    const previous = this.lock;
    this.lock = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      let branch = [...this.branches.values()][0];
      if (branch && ["ready", "queued", "ingesting"].includes(branch.status)) {
        await this.attachUser(userId, branch.id);
        return { state: "available" as const, branch };
      }
      const userIngestions = this.initiations.get(userId) ?? new Set<string>();
      if (branch && branch.status !== "failed") {
        throw new RepositoryIngestionError("Unexpected status", 409);
      }
      if (!branch && userIngestions.size >= lifetimeLimit) {
        throw new RepositoryIngestionError("Lifetime ingestion limit", 429);
      }
      if (!branch) {
        branch = {
          id: `branch-${this.nextBranchId++}`,
          repositoryId: "repo",
          branchName: branchMetadata.branchName,
          status: "queued",
          attempt: 1,
        };
      } else {
        branch = { ...branch, status: "queued", attempt: branch.attempt + 1 };
      }
      this.branches.set(branch.id, branch);
      userIngestions.add(branch.id);
      this.initiations.set(userId, userIngestions);
      await this.attachUser(userId, branch.id);
      return { state: "accepted" as const, branch };
    } finally {
      release();
    }
  }

  async markEnqueueFailed(
    branchIndexId: string,
    _attempt: number,
    error: string,
  ): Promise<void> {
    const branch = this.branches.get(branchIndexId);
    if (branch)
      this.branches.set(branchIndexId, { ...branch, status: "failed" });
    this.lastError = error;
  }
}

async function checkLimitsWith(
  responses: Array<{ type: string; body?: unknown }>,
): Promise<void> {
  const nextResponses = [...responses];
  await checkGitHubIngestionLimits(
    "sample",
    "repository",
    "main",
    limits,
    async () => {
      const next = nextResponses.shift();
      if (!next) throw new Error("Unexpected GitHub request.");
      if (next.type === "branch") {
        return jsonResponse({ commit: { sha: "a".repeat(40) } });
      }
      if (next.type === "tree") return jsonResponse(next.body);
      return jsonResponse(next.body);
    },
  );
}

function validMetadataResponses(
  entries: Array<{ type: string; path: string; size: number }> = [],
) {
  return [
    { type: "branch" },
    {
      type: "tree",
      body: { truncated: false, tree: entries },
    },
  ];
}

function jsonResponse(value: unknown): Response {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}
