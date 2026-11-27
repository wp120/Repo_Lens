import test from "node:test";
import assert from "node:assert/strict";
import { prisma } from "../database/prisma.js";
import {
  prismaCodeGraphStore,
  type StorableSymbol,
  type StorableRelationship,
} from "../services/codeGraphStore.js";
import { IngestionOwnershipLostError } from "../services/codeChunkStore.js";

test("prismaCodeGraphStore stages symbols in batches and checks ownership", async () => {
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
        $queryRawUnsafe: async (query, ...values) => {
          assert.match(query, /FOR UPDATE/);
          return [{ id: "branch-1" }] as never;
        },
        $executeRawUnsafe: async (query, ...values) => {
          executedStatements.push({ query, values });
          return values.length / 15;
        },
      }),
  });

  try {
    const symbols: StorableSymbol[] = Array.from({ length: 60 }, (_, idx) => ({
      id: `00000000-0000-4000-8000-${idx.toString().padStart(12, "0")}`,
      branchIndexId: "branch-1",
      filePath: "src/sample.ts",
      name: `func${idx}`,
      kind: "function",
      language: "typescript",
      startLine: idx + 1,
      endLine: idx + 1,
      startColumn: 0,
      endColumn: 10,
      containerName: null,
      signature: null,
      commitSha: "sha-1",
      ingestionAttempt: 1,
    }));

    await prismaCodeGraphStore.stageSymbols("branch-1", 1, "token-1", symbols);

    // 60 symbols should be split into 2 batches (50 + 10)
    assert.equal(executedStatements.length, 2);
    assert.match(executedStatements[0].query, /INSERT INTO code_symbols/);
    assert.match(executedStatements[0].query, /ON CONFLICT \(id\) DO NOTHING/);
    assert.equal(executedStatements[0].values.length, 50 * 15);
    assert.equal(executedStatements[1].values.length, 10 * 15);
  } finally {
    if (originalDescriptor) {
      Object.defineProperty(prisma, "$transaction", originalDescriptor);
    } else {
      delete (prisma as { $transaction?: unknown }).$transaction;
    }
  }
});

test("prismaCodeGraphStore stages relationships in batches and checks ownership", async () => {
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
        $queryRawUnsafe: async () => [{ id: "branch-1" }] as never,
        $executeRawUnsafe: async (query, ...values) => {
          executedStatements.push({ query, values });
          return values.length / 16;
        },
      }),
  });

  try {
    const rels: StorableRelationship[] = Array.from(
      { length: 55 },
      (_, idx) => ({
        id: `00000000-0000-4000-8000-${idx.toString().padStart(12, "0")}`,
        branchIndexId: "branch-1",
        type: "CALL",
        filePath: "src/sample.ts",
        startLine: idx + 1,
        endLine: idx + 1,
        referenceName: `called${idx}`,
        commitSha: "sha-1",
        ingestionAttempt: 1,
      }),
    );

    await prismaCodeGraphStore.stageRelationships(
      "branch-1",
      1,
      "token-1",
      rels,
    );

    // 55 relationships split into 2 batches (50 + 5)
    assert.equal(executedStatements.length, 2);
    assert.match(executedStatements[0].query, /INSERT INTO code_relationships/);
    assert.equal(executedStatements[0].values.length, 50 * 16);
    assert.equal(executedStatements[1].values.length, 5 * 16);
  } finally {
    if (originalDescriptor) {
      Object.defineProperty(prisma, "$transaction", originalDescriptor);
    } else {
      delete (prisma as { $transaction?: unknown }).$transaction;
    }
  }
});

test("prismaCodeGraphStore persists resolved relationships and marks graph completed", async () => {
  const updateStatements: Array<{ query: string; values: unknown[] }> = [];

  const originalDescriptor = Object.getOwnPropertyDescriptor(
    prisma,
    "$transaction",
  );
  const originalExecute = Object.getOwnPropertyDescriptor(
    prisma,
    "$executeRawUnsafe",
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
        $queryRawUnsafe: async () => [{ id: "branch-1" }] as never,
        $executeRawUnsafe: async (query, ...values) => {
          updateStatements.push({ query, values });
          return 1;
        },
      }),
  });

  Object.defineProperty(prisma, "$executeRawUnsafe", {
    configurable: true,
    value: async (query: string, ...values: unknown[]) => {
      updateStatements.push({ query, values });
      return 1;
    },
  });

  try {
    await prismaCodeGraphStore.persistResolvedRelationships(
      "branch-1",
      1,
      "token-1",
      [
        {
          id: "00000000-0000-4000-8000-000000000001",
          toSymbolId: "00000000-0000-4000-8000-000000000002",
          isResolved: true,
          resolutionError: null,
        },
      ],
    );

    assert.equal(updateStatements.length, 1);
    assert.match(updateStatements[0].query, /UPDATE code_relationships/);
    assert.equal(
      updateStatements[0].values[0],
      "00000000-0000-4000-8000-000000000002",
    );
    assert.equal(updateStatements[0].values[1], true);

    await prismaCodeGraphStore.markGraphCompleted("branch-1", 1, "token-1");
    assert.equal(updateStatements.length, 2);
    assert.match(updateStatements[1].query, /SET graph_status = 'completed'/);
  } finally {
    if (originalDescriptor) {
      Object.defineProperty(prisma, "$transaction", originalDescriptor);
    } else {
      delete (prisma as { $transaction?: unknown }).$transaction;
    }
    if (originalExecute) {
      Object.defineProperty(prisma, "$executeRawUnsafe", originalExecute);
    } else {
      delete (prisma as { $executeRawUnsafe?: unknown }).$executeRawUnsafe;
    }
  }
});
