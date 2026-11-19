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
