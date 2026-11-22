import assert from "node:assert/strict";
import test from "node:test";
import { prisma } from "../database/prisma.js";
import {
  IngestionOwnershipLostError,
  prismaCodeChunkStore,
  type StorableCodeChunk,
} from "../services/codeChunkStore.js";

test("stages each batch in its own owned transaction and resumes idempotently", async () => {
  const chunks: StorableCodeChunk[] = Array.from({ length: 101 }, (_, index) => ({
    id: `00000000-0000-4000-8000-${index.toString().padStart(12, "0")}`,
    branchIndexId: "branch-index-id",
    filePath: `src/file-${index}.ts`,
    content: `chunk-${index}`,
    startLine: index + 1,
    endLine: index + 1,
    language: "typescript",
    symbolName: `symbol${index}`,
    commitSha: "0123456789abcdef0123456789abcdef01234567",
    embedding: [],
  }));
  const storedIds = new Set<string>();
  const ownershipChecks: unknown[][] = [];
  const committedBatchSizes: number[] = [];
  let transactionCount = 0;
  let activeTransactions = 0;
  let failOnInsertInTransaction = 2;

  const originalDescriptor = Object.getOwnPropertyDescriptor(
    prisma,
    "$transaction",
  );
  const mockTransaction = async (
    callback: (tx: {
      $queryRawUnsafe: <T>(query: string, ...values: unknown[]) => Promise<T>;
      $executeRawUnsafe: (
        query: string,
        ...values: unknown[]
      ) => Promise<number>;
    }) => Promise<unknown>,
  ) => {
    assert.equal(activeTransactions, 0, "transactions must not be nested");
    transactionCount += 1;
    activeTransactions += 1;
    const pendingIds: string[] = [];
    try {
      const result = await callback({
        $queryRawUnsafe: async (query, ...values) => {
          assert.match(query, /FOR UPDATE/);
          ownershipChecks.push(values);
          return [{ id: "branch-index-id" }] as never;
        },
        $executeRawUnsafe: async (query, ...values) => {
          assert.match(query, /ON CONFLICT \(id\) DO NOTHING/);
          if (transactionCount === failOnInsertInTransaction) {
            throw new Error("simulated interruption after prior batch commit");
          }
          const batchIds: string[] = [];
          for (let index = 0; index < values.length; index += 18) {
            const id = values[index];
            if (typeof id !== "string") {
              throw new Error("Staged chunk ID must be a string.");
            }
            batchIds.push(id);
            pendingIds.push(id);
          }
          committedBatchSizes.push(batchIds.length);
          return batchIds.length;
        },
      });
      pendingIds.forEach((id) => storedIds.add(id));
      return result;
    } finally {
      activeTransactions -= 1;
    }
  };

  Object.defineProperty(prisma, "$transaction", {
    configurable: true,
    value: mockTransaction,
  });
  try {
    await assert.rejects(
      prismaCodeChunkStore.stageChunks!(
        "branch-index-id",
        7,
        "processing-token",
        chunks,
      ),
      /simulated interruption/,
    );
    assert.equal(transactionCount, 2);
    assert.equal(ownershipChecks.length, 2);
    assert.equal(storedIds.size, 50);

    failOnInsertInTransaction = -1;
    await prismaCodeChunkStore.stageChunks!(
      "branch-index-id",
      7,
      "processing-token",
      chunks,
    );

    assert.equal(transactionCount, 5);
    assert.equal(ownershipChecks.length, 5);
    assert.ok(
      ownershipChecks.every(
        (values) =>
          values[0] === "branch-index-id" &&
          values[1] === 7 &&
          values[2] === "processing-token",
      ),
    );
    assert.deepEqual(committedBatchSizes, [50, 50, 50, 1]);
    assert.equal(storedIds.size, chunks.length);
    assert.deepEqual(
      [...storedIds].sort(),
      chunks.map((chunk) => chunk.id!).sort(),
    );
  } finally {
    if (originalDescriptor) {
      Object.defineProperty(prisma, "$transaction", originalDescriptor);
    } else {
      delete (prisma as { $transaction?: unknown }).$transaction;
    }
  }
});

test("staging still fails when a batch no longer owns its branch", async () => {
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
        $queryRawUnsafe: async () => [] as never,
        $executeRawUnsafe: async () => 0,
      }),
  });

  try {
    await assert.rejects(
      prismaCodeChunkStore.stageChunks!("branch-index-id", 1, "stale-token", [
        {
          id: "00000000-0000-4000-8000-000000000001",
          branchIndexId: "branch-index-id",
          filePath: "src/file.ts",
          content: "content",
          startLine: 1,
          endLine: 1,
          language: "typescript",
          symbolName: "symbol",
          commitSha: "0123456789abcdef0123456789abcdef01234567",
          embedding: [],
        },
      ]),
      (error) => error instanceof IngestionOwnershipLostError,
    );
  } finally {
    if (originalDescriptor) {
      Object.defineProperty(prisma, "$transaction", originalDescriptor);
    } else {
      delete (prisma as { $transaction?: unknown }).$transaction;
    }
  }
});

test("claiming chunks does not deserialize unsupported tsvector columns", async () => {
  const originalDescriptor = Object.getOwnPropertyDescriptor(
    prisma,
    "$transaction",
  );
  let claimQuery = "";
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
        $queryRawUnsafe: async (query: string) => {
          if (query.includes("FOR UPDATE")) {
            return [{ id: "branch-index-id" }] as never;
          }
          claimQuery = query;
          return [{
            id: "00000000-0000-4000-8000-000000000001",
            branchIndexId: "branch-index-id",
            filePath: "src/file.ts",
            content: "content",
            startLine: 1,
            endLine: 1,
            language: "typescript",
            symbolName: "symbol",
            symbolType: null,
            className: null,
            functionSignature: null,
            commitSha: "0123456789abcdef0123456789abcdef01234567",
            sourceBlobSha: null,
            embeddingStatus: "processing",
            isActive: false,
            ingestionAttempt: 7,
            batchExecutionToken: "batch-token",
          }] as never;
        },
        $executeRawUnsafe: async () => 1,
      }),
  });

  try {
    const claimed = await prismaCodeChunkStore.claimBatchChunks!(
      "branch-index-id",
      7,
      "processing-token",
      "batch-token",
      ["00000000-0000-4000-8000-000000000001"],
    );

    assert.equal(claimed.length, 1);
    assert.match(claimQuery, /RETURNING/);
    assert.doesNotMatch(claimQuery, /\bRETURNING\s+\*/);
    assert.doesNotMatch(claimQuery, /search_vector/);
  } finally {
    if (originalDescriptor) {
      Object.defineProperty(prisma, "$transaction", originalDescriptor);
    } else {
      delete (prisma as { $transaction?: unknown }).$transaction;
    }
  }
});

test("finalization publishes the staged repository structure in the chunk transaction", async () => {
  const statements: Array<{ query: string; values: unknown[] }> = [];
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
            return [{
              id: "branch-index-id",
              has_pending_repository_file_paths: true,
            }] as never;
          }
          return [{ count: 0 }] as never;
        },
        $executeRawUnsafe: async (query, ...values) => {
          statements.push({ query, values });
          return 1;
        },
      }),
  });

  try {
    const finalized = await prismaCodeChunkStore.finalizeIngestion!(
      "branch-index-id",
      7,
      "processing-token",
      "0123456789abcdef0123456789abcdef01234567",
    );

    assert.equal(finalized, true);
    const publish = statements.find(({ query }) =>
      query.includes("repository_file_paths = pending_repository_file_paths"),
    );
    assert.ok(publish);
    assert.match(publish.query, /pending_repository_file_paths = NULL/);
    assert.deepEqual(publish.values, [
      "branch-index-id",
      7,
      "processing-token",
      "0123456789abcdef0123456789abcdef01234567",
    ]);
  } finally {
    if (originalDescriptor) {
      Object.defineProperty(prisma, "$transaction", originalDescriptor);
    } else {
      delete (prisma as { $transaction?: unknown }).$transaction;
    }
  }
});

test("repository paths are staged only for the current ingestion owner", async () => {
  const statements: Array<{ query: string; values: unknown[] }> = [];
  const originalDescriptor = Object.getOwnPropertyDescriptor(
    prisma,
    "$executeRawUnsafe",
  );
  Object.defineProperty(prisma, "$executeRawUnsafe", {
    configurable: true,
    value: async (query: string, ...values: unknown[]) => {
      statements.push({ query, values });
      return 1;
    },
  });

  try {
    const filePaths = ["README.md", "assets/logo.png", "src/index.ts"];
    await prismaCodeChunkStore.stageRepositoryFilePaths!(
      "branch-index-id",
      7,
      "processing-token",
      filePaths,
    );

    assert.match(statements[0].query, /pending_repository_file_paths = \$4::jsonb/);
    assert.match(statements[0].query, /processing_token = \$3::uuid/);
    assert.deepEqual(statements[0].values, [
      "branch-index-id",
      7,
      "processing-token",
      JSON.stringify(filePaths),
    ]);

    Object.defineProperty(prisma, "$executeRawUnsafe", {
      configurable: true,
      value: async () => 0,
    });
    await assert.rejects(
      prismaCodeChunkStore.stageRepositoryFilePaths!(
        "branch-index-id",
        7,
        "stale-token",
        filePaths,
      ),
      (error) => error instanceof IngestionOwnershipLostError,
    );
  } finally {
    if (originalDescriptor) {
      Object.defineProperty(prisma, "$executeRawUnsafe", originalDescriptor);
    } else {
      delete (prisma as { $executeRawUnsafe?: unknown }).$executeRawUnsafe;
    }
  }
});

test("finalization leaves the published structure untouched while chunks are incomplete", async () => {
  const statements: string[] = [];
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
        $queryRawUnsafe: async (query) =>
          query.includes("has_pending_repository_file_paths")
            ? ([{
                id: "branch-index-id",
                has_pending_repository_file_paths: true,
              }] as never)
            : ([{ count: 1 }] as never),
        $executeRawUnsafe: async (query) => {
          statements.push(query);
          return 1;
        },
      }),
  });

  try {
    const finalized = await prismaCodeChunkStore.finalizeIngestion!(
      "branch-index-id",
      7,
      "processing-token",
      "0123456789abcdef0123456789abcdef01234567",
    );

    assert.equal(finalized, false);
    assert.deepEqual(statements, []);
  } finally {
    if (originalDescriptor) {
      Object.defineProperty(prisma, "$transaction", originalDescriptor);
    } else {
      delete (prisma as { $transaction?: unknown }).$transaction;
    }
  }
});
