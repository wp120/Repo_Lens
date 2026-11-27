import test from "node:test";
import assert from "node:assert/strict";
import { prisma } from "../database/prisma.js";
import {
  prismaCodeChunkStore,
  IngestionOwnershipLostError,
} from "../services/codeChunkStore.js";
import {
  chunkSourceFile,
  parseSourceFileWithGraph,
} from "../services/codeChunker.js";

test("Requirement 7 & 11: Finalization activates current attempt and deactivates prior attempt", async () => {
  const executedStatements: Array<{ query: string; values: unknown[] }> = [];

  const originalDescriptor = Object.getOwnPropertyDescriptor(
    prisma,
    "$transaction",
  );

  Object.defineProperty(prisma, "$transaction", {
    configurable: true,
    value: async (
      callback: (tx: {
        $queryRawUnsafe: <T>(query: string, ...values: unknown[]) => Promise<T>;
        $executeRawUnsafe: (
          query: string,
          ...values: unknown[]
        ) => Promise<number>;
      }) => Promise<unknown>,
    ) =>
      callback({
        $queryRawUnsafe: async (query) => {
          if (query.includes("has_pending_repository_file_paths")) {
            return [
              {
                id: "branch-index-1",
                has_pending_repository_file_paths: true,
                graph_status: "completed",
              },
            ] as never;
          }
          if (query.includes("count(*)::int AS count")) {
            return [{ count: 0 }] as never;
          }
          return [] as never;
        },
        $executeRawUnsafe: async (query, ...values) => {
          executedStatements.push({ query, values });
          return 1;
        },
      }),
  });

  try {
    const finalized = await prismaCodeChunkStore.finalizeIngestion!(
      "branch-index-1",
      2, // attempt 2
      "token-attempt-2",
      "commit-sha-2",
    );

    assert.equal(finalized, true);

    // Verify chunk deactivation of old and activation of new attempt
    assert.ok(
      executedStatements.some((s) =>
        s.query.includes("UPDATE code_chunks SET is_active = false"),
      ),
      "should deactivate old active chunks",
    );
    assert.ok(
      executedStatements.some(
        (s) =>
          s.query.includes("UPDATE code_chunks") &&
          s.query.includes("is_active = true") &&
          s.values.includes(2) &&
          s.values.includes("commit-sha-2"),
      ),
      "should activate attempt 2 chunks",
    );

    // Verify symbol deactivation of old and activation of new attempt
    assert.ok(
      executedStatements.some((s) =>
        s.query.includes("UPDATE code_symbols SET is_active = false"),
      ),
      "should deactivate old active symbols",
    );
    assert.ok(
      executedStatements.some(
        (s) =>
          s.query.includes("UPDATE code_symbols") &&
          s.query.includes("is_active = true") &&
          s.values.includes(2),
      ),
      "should activate attempt 2 symbols",
    );

    // Verify relationship deactivation of old and activation of new attempt
    assert.ok(
      executedStatements.some((s) =>
        s.query.includes("UPDATE code_relationships SET is_active = false"),
      ),
      "should deactivate old active relationships",
    );
    assert.ok(
      executedStatements.some(
        (s) =>
          s.query.includes("UPDATE code_relationships") &&
          s.query.includes("is_active = true") &&
          s.values.includes(2),
      ),
      "should activate attempt 2 relationships",
    );

    // Verify branch status ready update
    assert.ok(
      executedStatements.some(
        (s) =>
          s.query.includes("UPDATE branch_indexes") &&
          s.query.includes("status = 'ready'"),
      ),
      "should mark branch ready",
    );
  } finally {
    if (originalDescriptor) {
      Object.defineProperty(prisma, "$transaction", originalDescriptor);
    } else {
      delete (prisma as { $transaction?: unknown }).$transaction;
    }
  }
});

test("Requirement 8: Graph construction failure cleans up staged graph and does not publish", async () => {
  const executedStatements: Array<{ query: string; values: unknown[] }> = [];

  const originalDescriptor = Object.getOwnPropertyDescriptor(
    prisma,
    "$transaction",
  );

  Object.defineProperty(prisma, "$transaction", {
    configurable: true,
    value: async (
      callback: (tx: {
        $queryRawUnsafe: <T>(query: string, ...values: unknown[]) => Promise<T>;
        $executeRawUnsafe: (
          query: string,
          ...values: unknown[]
        ) => Promise<number>;
      }) => Promise<unknown>,
    ) =>
      callback({
        $queryRawUnsafe: async () => [{ id: "branch-index-1" }] as never,
        $executeRawUnsafe: async (query, ...values) => {
          executedStatements.push({ query, values });
          return 1;
        },
      }),
  });

  try {
    const failed = await prismaCodeChunkStore.failIngestion!(
      "branch-index-1",
      1,
      "token-attempt-1",
      "Graph resolution syntax error",
    );

    assert.equal(failed, true);

    // Status updated to failed
    assert.ok(
      executedStatements.some(
        (s) =>
          s.query.includes("UPDATE branch_indexes") &&
          s.query.includes("status = 'failed'") &&
          s.query.includes("graph_status = 'failed'"),
      ),
      "should mark branch and graph status failed",
    );

    // Inactive chunks deleted
    assert.ok(
      executedStatements.some((s) =>
        /DELETE FROM code_chunks[\s\S]*WHERE branch_index_id = \$1::uuid/.test(
          s.query,
        ),
      ),
      "should delete inactive chunks",
    );

    // Inactive relationships deleted
    assert.ok(
      executedStatements.some((s) =>
        /DELETE FROM code_relationships[\s\S]*WHERE branch_index_id = \$1::uuid/.test(
          s.query,
        ),
      ),
      "should delete inactive relationships",
    );

    // Inactive symbols deleted
    assert.ok(
      executedStatements.some((s) =>
        /DELETE FROM code_symbols[\s\S]*WHERE branch_index_id = \$1::uuid/.test(
          s.query,
        ),
      ),
      "should delete inactive symbols",
    );

    // Ensure it NEVER published
    assert.ok(
      !executedStatements.some((s) => s.query.includes("status = 'ready'")),
      "must never publish ready on failure",
    );
  } finally {
    if (originalDescriptor) {
      Object.defineProperty(prisma, "$transaction", originalDescriptor);
    } else {
      delete (prisma as { $transaction?: unknown }).$transaction;
    }
  }
});

test("Requirement 9: Embedding completion before graph completion defers finalization until graph completes", async () => {
  let graphStatusState = "pending";
  let chunksIncompleteCount = 0;
  const executedStatements: string[] = [];

  const originalDescriptor = Object.getOwnPropertyDescriptor(
    prisma,
    "$transaction",
  );

  Object.defineProperty(prisma, "$transaction", {
    configurable: true,
    value: async (
      callback: (tx: {
        $queryRawUnsafe: <T>(query: string, ...values: unknown[]) => Promise<T>;
        $executeRawUnsafe: (
          query: string,
          ...values: unknown[]
        ) => Promise<number>;
      }) => Promise<unknown>,
    ) =>
      callback({
        $queryRawUnsafe: async (query) => {
          if (query.includes("has_pending_repository_file_paths")) {
            return [
              {
                id: "branch-1",
                has_pending_repository_file_paths: true,
                graph_status: graphStatusState,
              },
            ] as never;
          }
          if (query.includes("count(*)::int AS count")) {
            return [{ count: chunksIncompleteCount }] as never;
          }
          return [] as never;
        },
        $executeRawUnsafe: async (query) => {
          executedStatements.push(query);
          return 1;
        },
      }),
  });

  try {
    // Step A: All embeddings complete, but graph is still pending
    graphStatusState = "pending";
    chunksIncompleteCount = 0;

    const firstTry = await prismaCodeChunkStore.finalizeIngestion!(
      "branch-1",
      1,
      "token-1",
      "commit-1",
    );
    assert.equal(
      firstTry,
      false,
      "finalization must be deferred while graph is pending",
    );
    assert.equal(
      executedStatements.length,
      0,
      "no publication statements should execute",
    );

    // Step B: Graph construction completes
    graphStatusState = "completed";

    const secondTry = await prismaCodeChunkStore.finalizeIngestion!(
      "branch-1",
      1,
      "token-1",
      "commit-1",
    );
    assert.equal(
      secondTry,
      true,
      "finalization must succeed when both graph and chunks are completed",
    );
    assert.ok(
      executedStatements.some((q) => q.includes("UPDATE branch_indexes")),
      "publication statements should now execute",
    );
  } finally {
    if (originalDescriptor) {
      Object.defineProperty(prisma, "$transaction", originalDescriptor);
    } else {
      delete (prisma as { $transaction?: unknown }).$transaction;
    }
  }
});

test("Requirement 10: Graph completion before embedding completion defers finalization until embeddings complete", async () => {
  let graphStatusState = "completed";
  let chunksIncompleteCount = 5;
  const executedStatements: string[] = [];

  const originalDescriptor = Object.getOwnPropertyDescriptor(
    prisma,
    "$transaction",
  );

  Object.defineProperty(prisma, "$transaction", {
    configurable: true,
    value: async (
      callback: (tx: {
        $queryRawUnsafe: <T>(query: string, ...values: unknown[]) => Promise<T>;
        $executeRawUnsafe: (
          query: string,
          ...values: unknown[]
        ) => Promise<number>;
      }) => Promise<unknown>,
    ) =>
      callback({
        $queryRawUnsafe: async (query) => {
          if (query.includes("has_pending_repository_file_paths")) {
            return [
              {
                id: "branch-1",
                has_pending_repository_file_paths: true,
                graph_status: graphStatusState,
              },
            ] as never;
          }
          if (query.includes("count(*)::int AS count")) {
            return [{ count: chunksIncompleteCount }] as never;
          }
          return [] as never;
        },
        $executeRawUnsafe: async (query) => {
          executedStatements.push(query);
          return 1;
        },
      }),
  });

  try {
    // Step A: Graph is completed, but chunks are still being embedded
    graphStatusState = "completed";
    chunksIncompleteCount = 5;

    const firstTry = await prismaCodeChunkStore.finalizeIngestion!(
      "branch-1",
      1,
      "token-1",
      "commit-1",
    );
    assert.equal(
      firstTry,
      false,
      "finalization must be deferred while chunks are incomplete",
    );
    assert.equal(
      executedStatements.length,
      0,
      "no publication statements should execute",
    );

    // Step B: Embedding worker completes the last batch
    chunksIncompleteCount = 0;

    const secondTry = await prismaCodeChunkStore.finalizeIngestion!(
      "branch-1",
      1,
      "token-1",
      "commit-1",
    );
    assert.equal(
      secondTry,
      true,
      "finalization must succeed when chunk embeddings complete",
    );
    assert.ok(
      executedStatements.some((q) => q.includes("UPDATE branch_indexes")),
      "publication statements should now execute",
    );
  } finally {
    if (originalDescriptor) {
      Object.defineProperty(prisma, "$transaction", originalDescriptor);
    } else {
      delete (prisma as { $transaction?: unknown }).$transaction;
    }
  }
});

test("Requirement 12: Existing chunking and embedding behavior remains intact", async () => {
  const code = `
export function add(a: number, b: number): number {
  return a + b;
}

export function subtract(a: number, b: number): number {
  return a - b;
}
`;

  // Compare chunkSourceFile and parseSourceFileWithGraph
  const chunksFromLegacy = await chunkSourceFile("src/math.ts", code, "sha-1");
  const parsedWithGraph = await parseSourceFileWithGraph(
    "src/math.ts",
    code,
    "sha-1",
  );

  assert.deepEqual(chunksFromLegacy, parsedWithGraph.chunks);
  assert.equal(chunksFromLegacy.length, 2);
  assert.equal(chunksFromLegacy[0].symbolName, "add");
  assert.equal(chunksFromLegacy[1].symbolName, "subtract");

  // In addition, graph symbols and relationships were extracted without separate parse
  assert.equal(parsedWithGraph.symbols.length, 2);
  assert.equal(parsedWithGraph.symbols[0].name, "add");
  assert.equal(parsedWithGraph.symbols[1].name, "subtract");
});

test("Ingestion worker integrates incremental graph staging, resolution, and finalization", async () => {
  const { processIngestionJob } = await import("../jobs/ingestionWorker.js");
  const { resolveGraphRelationships } =
    await import("../services/codeGraphResolver.js");

  const stagedSymbols: any[] = [];
  const stagedRelationships: any[] = [];
  const persistedUpdates: any[] = [];
  let graphCompleted = false;
  let finalizedCalled = false;

  const fakePrisma: any = {
    branchIndex: {
      findUnique: async () => ({
        id: "branch-1",
        repositoryId: "repo-1",
        branchName: "main",
        status: "queued",
        ingestionAttempt: 1,
        repository: { owner: "owner", name: "repo" },
      }),
      updateMany: async () => ({ count: 1 }),
    },
    $executeRawUnsafe: async () => 1,
  };

  const fakeChunkStore: any = {
    stageRepositoryFilePaths: async () => {},
    stageChunks: async () => {},
    finalizeIngestion: async () => {
      finalizedCalled = true;
      return true;
    },
  };

  const fakeGraphStore: any = {
    stageSymbols: async (
      _bId: string,
      _attempt: number,
      _token: string,
      syms: any[],
    ) => {
      stagedSymbols.push(...syms);
    },
    stageRelationships: async (
      _bId: string,
      _attempt: number,
      _token: string,
      rels: any[],
    ) => {
      stagedRelationships.push(...rels);
    },
    loadStagedGraph: async () => ({
      symbols: stagedSymbols,
      relationships: stagedRelationships,
    }),
    persistResolvedRelationships: async (
      _bId: string,
      _attempt: number,
      _token: string,
      updates: any[],
    ) => {
      persistedUpdates.push(...updates);
    },
    markGraphCompleted: async () => {
      graphCompleted = true;
    },
  };

  const fileA = "src/math.ts";
  const fileB = "src/app.ts";
  const contentA =
    "export function add(a: number, b: number): number { return a + b; }";
  const contentB =
    "import { add } from './math'; export function run() { return add(1, 2); }";

  const fakeDeps: any = {
    prisma: fakePrisma,
    chunkStore: fakeChunkStore,
    graphStore: fakeGraphStore,
    graphResolver: resolveGraphRelationships,
    resolveCommit: async () => "sha-commit-1234",
    fetchTree: async () => ({
      indexableFiles: [
        { path: fileA, size: contentA.length, sha: "sha-a" },
        { path: fileB, size: contentB.length, sha: "sha-b" },
      ],
      repositoryFilePaths: [fileA, fileB],
    }),
    fetchContent: async (_o: string, _r: string, sha: string) => {
      return sha === "sha-a" ? contentA : contentB;
    },
    fileParser: parseSourceFileWithGraph,
    chunker: chunkSourceFile,
    enqueueBatchEmbeddings: async () => {},
    embedder: async (t: string[]) => t.map(() => Array(1024).fill(0)),
  };

  await processIngestionJob(
    {
      branchIndexId: "branch-1",
      repositoryId: "repo-1",
      branchName: "main",
      attempt: 1,
    },
    fakeDeps,
  );

  // Assert incremental staging occurred
  assert.equal(stagedSymbols.length, 2, "should stage 2 symbols (add and run)");
  assert.equal(
    stagedRelationships.length,
    2,
    "should stage 2 relationships (import and call)",
  );

  // Assert resolution occurred
  assert.equal(
    persistedUpdates.length,
    2,
    "should persist 2 relationship updates",
  );
  assert.equal(graphCompleted, true, "graph completion should be recorded");
  assert.equal(finalizedCalled, true, "finalization should be triggered");
});
