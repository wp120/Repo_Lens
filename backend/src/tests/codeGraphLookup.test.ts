import assert from "node:assert/strict";
import test from "node:test";
import { prisma } from "../database/prisma.js";
import {
  GRAPH_LOOKUP_LIMITS,
  GraphAuthorizationError,
  lookupCodeRelationships,
  prismaCodeGraphReader,
  type CodeGraphReader,
  type PersistedGraphRelationship,
  type PersistedGraphSymbol,
  type PublishedGraphSnapshot,
  type RelationshipSearchCriteria,
  type SymbolSearchCriteria,
} from "../services/codeGraphLookup.js";

const BRANCH_A = "11111111-1111-4111-8111-111111111111";
const BRANCH_B = "22222222-2222-4222-8222-222222222222";
const USER_ALLOWED = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const USER_DENIED = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const COMMIT_ACTIVE = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const COMMIT_STAGED = "cccccccccccccccccccccccccccccccccccccccc";

interface InMemoryGraphFixture {
  access: Array<{ userId: string; branchIndexId: string }>;
  branches: PublishedGraphSnapshot[];
  symbols: PersistedGraphSymbol[];
  relationships: PersistedGraphRelationship[];
}

function createInMemoryReader(fixture: InMemoryGraphFixture): CodeGraphReader {
  const matchesCriteria = (
    sym: PersistedGraphSymbol,
    criteria: SymbolSearchCriteria,
  ) => {
    if (criteria.symbolId && sym.id !== criteria.symbolId) return false;
    if (criteria.filePath && sym.filePath !== criteria.filePath) return false;
    if (criteria.kind && sym.kind !== criteria.kind) return false;
    if (criteria.name) {
      if (criteria.containerName && criteria.parsedContainerFromQualified) {
        const qualifiedMatch =
          sym.name === criteria.name &&
          sym.containerName === criteria.containerName;
        const rawMatch = Boolean(
          criteria.rawName && sym.name === criteria.rawName,
        );
        if (!qualifiedMatch && !rawMatch) return false;
      } else if (criteria.containerName) {
        if (
          sym.name !== criteria.name ||
          sym.containerName !== criteria.containerName
        ) {
          return false;
        }
      } else if (sym.name !== criteria.name) {
        return false;
      }
    } else if (
      criteria.containerName &&
      sym.containerName !== criteria.containerName
    ) {
      return false;
    }
    return true;
  };

  return {
    async hasBranchAccess(userId, branchIndexId) {
      return fixture.access.some(
        (entry) =>
          entry.userId === userId && entry.branchIndexId === branchIndexId,
      );
    },

    async getPublishedSnapshot(branchIndexId) {
      return (
        fixture.branches.find((b) => b.branchIndexId === branchIndexId) ?? null
      );
    },

    async findActiveSymbols(snapshot, criteria, limit) {
      const matched = fixture.symbols
        .filter(
          (sym) =>
            sym.branchIndexId === snapshot.branchIndexId &&
            sym.isActive === true &&
            sym.commitSha === snapshot.commitSha &&
            matchesCriteria(sym, criteria),
        )
        .sort(
          (a, b) =>
            a.filePath.localeCompare(b.filePath) ||
            a.startLine - b.startLine ||
            a.name.localeCompare(b.name) ||
            a.id.localeCompare(b.id),
        );
      return {
        symbols: matched.slice(0, limit),
        totalMatches: matched.length,
      };
    },

    async findActiveSymbolsByIds(snapshot, ids) {
      const idSet = new Set(ids);
      return fixture.symbols
        .filter(
          (sym) =>
            idSet.has(sym.id) &&
            sym.branchIndexId === snapshot.branchIndexId &&
            sym.isActive === true &&
            sym.commitSha === snapshot.commitSha,
        )
        .sort(
          (a, b) =>
            a.filePath.localeCompare(b.filePath) ||
            a.startLine - b.startLine ||
            a.id.localeCompare(b.id),
        );
    },

    async findActiveRelationships(
      snapshot,
      criteria: RelationshipSearchCriteria,
      limit: number,
    ) {
      const matched = fixture.relationships
        .filter((rel) => {
          if (rel.branchIndexId !== snapshot.branchIndexId) return false;
          if (rel.isActive !== true) return false;
          if (rel.commitSha !== snapshot.commitSha) return false;
          if (criteria.types && !criteria.types.includes(rel.type)) {
            return false;
          }
          if (
            criteria.fromSymbolId &&
            rel.fromSymbolId !== criteria.fromSymbolId
          ) {
            return false;
          }
          if (
            criteria.fromSymbolIds &&
            (!rel.fromSymbolId ||
              !criteria.fromSymbolIds.includes(rel.fromSymbolId))
          ) {
            return false;
          }
          if (criteria.toSymbolId && rel.toSymbolId !== criteria.toSymbolId) {
            return false;
          }
          if (
            criteria.toSymbolIds &&
            (!rel.toSymbolId || !criteria.toSymbolIds.includes(rel.toSymbolId))
          ) {
            return false;
          }
          if (criteria.filePath && rel.filePath !== criteria.filePath) {
            return false;
          }
          if (
            criteria.isResolved !== undefined &&
            rel.isResolved !== criteria.isResolved
          ) {
            return false;
          }
          return true;
        })
        .sort(
          (a, b) =>
            a.filePath.localeCompare(b.filePath) ||
            a.startLine - b.startLine ||
            a.id.localeCompare(b.id),
        );

      return {
        relationships: matched.slice(0, limit),
        totalMatches: matched.length,
      };
    },
  };
}

function sym(
  id: string,
  overrides: Partial<PersistedGraphSymbol> & {
    name: string;
    kind: string;
    filePath: string;
  },
): PersistedGraphSymbol {
  return {
    id,
    branchIndexId: BRANCH_A,
    language: "typescript",
    startLine: 1,
    endLine: 10,
    containerName: null,
    signature: null,
    commitSha: COMMIT_ACTIVE,
    ingestionAttempt: 1,
    isActive: true,
    ...overrides,
  };
}

function rel(
  id: string,
  overrides: Partial<PersistedGraphRelationship> & {
    type: string;
    filePath: string;
    referenceName: string;
  },
): PersistedGraphRelationship {
  return {
    id,
    branchIndexId: BRANCH_A,
    fromSymbolId: null,
    toSymbolId: null,
    startLine: 1,
    endLine: 1,
    targetModule: null,
    isResolved: true,
    resolutionError: null,
    commitSha: COMMIT_ACTIVE,
    ingestionAttempt: 1,
    isActive: true,
    ...overrides,
  };
}

function buildStandardFixture(): InMemoryGraphFixture {
  const symbols: PersistedGraphSymbol[] = [
    sym("sym-ctrl-cls", {
      name: "OrderController",
      kind: "class",
      filePath: "src/controllers/orderController.ts",
      startLine: 5,
      endLine: 30,
    }),
    sym("sym-ctrl-handle", {
      name: "createOrder",
      kind: "method",
      containerName: "OrderController",
      filePath: "src/controllers/orderController.ts",
      startLine: 8,
      endLine: 22,
      signature: "createOrder(req: Request): Promise<Order>",
    }),
    sym("sym-svc-cls", {
      name: "OrderService",
      kind: "class",
      filePath: "src/services/orderService.ts",
      startLine: 4,
      endLine: 40,
    }),
    sym("sym-svc-base", {
      name: "BaseService",
      kind: "class",
      filePath: "src/services/baseService.ts",
      startLine: 1,
      endLine: 20,
    }),
    sym("sym-svc-iface", {
      name: "IOrderProcessor",
      kind: "interface",
      filePath: "src/services/interfaces.ts",
      startLine: 1,
      endLine: 8,
    }),
    sym("sym-svc-process", {
      name: "processOrder",
      kind: "method",
      containerName: "OrderService",
      filePath: "src/services/orderService.ts",
      startLine: 12,
      endLine: 28,
      signature: "processOrder(input: OrderInput): Promise<Order>",
    }),
    sym("sym-repo-save", {
      name: "save",
      kind: "method",
      containerName: "OrderRepository",
      filePath: "src/repositories/orderRepository.ts",
      startLine: 10,
      endLine: 20,
      signature: "save(order: Order): Promise<void>",
    }),
    sym("sym-db-exec", {
      name: "executeQuery",
      kind: "function",
      filePath: "src/db/client.ts",
      startLine: 15,
      endLine: 30,
      signature: "executeQuery(sql: string): Promise<Row[]>",
    }),
    // Ambiguous symbol name "save" in another file/class
    sym("sym-user-save", {
      name: "save",
      kind: "method",
      containerName: "UserRepository",
      filePath: "src/repositories/userRepository.ts",
      startLine: 12,
      endLine: 22,
    }),
    // Inactive / staged symbol from newer attempt (must NEVER appear!)
    sym("sym-staged-handle", {
      name: "createOrder",
      kind: "method",
      containerName: "OrderController",
      filePath: "src/controllers/orderController.ts",
      startLine: 100,
      endLine: 120,
      commitSha: COMMIT_STAGED,
      ingestionAttempt: 2,
      isActive: false,
    }),
    // Symbol on another branch (must NEVER appear when querying BRANCH_A!)
    sym("sym-other-branch", {
      branchIndexId: BRANCH_B,
      name: "createOrder",
      kind: "method",
      containerName: "OrderController",
      filePath: "src/controllers/orderController.ts",
      startLine: 1,
      endLine: 10,
    }),
  ];

  const relationships: PersistedGraphRelationship[] = [
    // Controller -> Service -> Repository -> Database
    rel("rel-1", {
      type: "CALL",
      fromSymbolId: "sym-ctrl-handle",
      toSymbolId: "sym-svc-process",
      filePath: "src/controllers/orderController.ts",
      startLine: 15,
      endLine: 15,
      referenceName: "processOrder",
    }),
    rel("rel-2", {
      type: "CALL",
      fromSymbolId: "sym-svc-process",
      toSymbolId: "sym-repo-save",
      filePath: "src/services/orderService.ts",
      startLine: 20,
      endLine: 20,
      referenceName: "save",
    }),
    rel("rel-3", {
      type: "CALL",
      fromSymbolId: "sym-repo-save",
      toSymbolId: "sym-db-exec",
      filePath: "src/repositories/orderRepository.ts",
      startLine: 16,
      endLine: 16,
      referenceName: "executeQuery",
    }),
    // Unresolved call from createOrder
    rel("rel-unresolved-call", {
      type: "CALL",
      fromSymbolId: "sym-ctrl-handle",
      toSymbolId: null,
      filePath: "src/controllers/orderController.ts",
      startLine: 18,
      endLine: 18,
      referenceName: "emitMetric",
      isResolved: false,
      resolutionError: "unresolved_reference",
    }),
    // Unresolved call claiming to call executeQuery by name (must NOT appear in find_callers)
    rel("rel-unresolved-name-only", {
      type: "CALL",
      fromSymbolId: "sym-user-save",
      toSymbolId: null,
      filePath: "src/repositories/userRepository.ts",
      startLine: 19,
      endLine: 19,
      referenceName: "executeQuery",
      isResolved: false,
      resolutionError: "ambiguous_target",
    }),
    // Class dependencies: OrderService extends BaseService implements IOrderProcessor
    rel("rel-inherits", {
      type: "INHERITS",
      fromSymbolId: "sym-svc-cls",
      toSymbolId: "sym-svc-base",
      filePath: "src/services/orderService.ts",
      startLine: 4,
      endLine: 4,
      referenceName: "BaseService",
    }),
    rel("rel-implements", {
      type: "IMPLEMENTS",
      fromSymbolId: "sym-svc-cls",
      toSymbolId: "sym-svc-iface",
      filePath: "src/services/orderService.ts",
      startLine: 4,
      endLine: 4,
      referenceName: "IOrderProcessor",
    }),
    rel("rel-import", {
      type: "IMPORT",
      toSymbolId: "sym-svc-base",
      filePath: "src/services/orderService.ts",
      startLine: 1,
      endLine: 1,
      referenceName: "BaseService",
      targetModule: "./baseService",
    }),
    // Inactive / staged edge (must be excluded!)
    rel("rel-staged-edge", {
      type: "CALL",
      fromSymbolId: "sym-ctrl-handle",
      toSymbolId: "sym-db-exec",
      filePath: "src/controllers/orderController.ts",
      startLine: 99,
      endLine: 99,
      referenceName: "executeQuery",
      commitSha: COMMIT_STAGED,
      ingestionAttempt: 2,
      isActive: false,
    }),
    // Wrong commit SHA even if isActive somehow true (must be excluded!)
    rel("rel-wrong-commit", {
      type: "CALL",
      fromSymbolId: "sym-ctrl-handle",
      toSymbolId: "sym-user-save",
      filePath: "src/controllers/orderController.ts",
      startLine: 101,
      endLine: 101,
      referenceName: "save",
      commitSha: COMMIT_STAGED,
      isActive: true,
    }),
    // Different branch edge
    rel("rel-other-branch", {
      branchIndexId: BRANCH_B,
      type: "CALL",
      fromSymbolId: "sym-other-branch",
      toSymbolId: "sym-db-exec",
      filePath: "src/controllers/orderController.ts",
      startLine: 5,
      endLine: 5,
      referenceName: "executeQuery",
    }),
  ];

  return {
    access: [{ userId: USER_ALLOWED, branchIndexId: BRANCH_A }],
    branches: [
      {
        branchIndexId: BRANCH_A,
        branchName: "main",
        status: "ready",
        commitSha: COMMIT_ACTIVE,
        graphStatus: "completed",
      },
      {
        branchIndexId: BRANCH_B,
        branchName: "feature/other",
        status: "ready",
        commitSha: COMMIT_ACTIVE,
        graphStatus: "completed",
      },
    ],
    symbols,
    relationships,
  };
}

test("1. Looking up a symbol supports qualified name, file path, and metadata", async () => {
  const reader = createInMemoryReader(buildStandardFixture());
  const result = await lookupCodeRelationships(
    BRANCH_A,
    {
      mode: "symbol_lookup",
      qualifiedName: "OrderController.createOrder",
    },
    { userId: USER_ALLOWED },
    reader,
  );

  assert.equal(result.status, "ok");
  assert.equal(result.isAmbiguous, false);
  assert.equal(result.totalMatches, 1);
  const symbols = result.symbols as Array<Record<string, unknown>>;
  assert.equal(symbols.length, 1);
  assert.deepEqual(symbols[0], {
    id: "sym-ctrl-handle",
    name: "createOrder",
    qualifiedName: "OrderController.createOrder",
    kind: "method",
    language: "typescript",
    filePath: "src/controllers/orderController.ts",
    startLine: 8,
    endLine: 22,
    containerName: "OrderController",
    signature: "createOrder(req: Request): Promise<Order>",
  });
});

test("2. Finding callers returns only active resolved callers and excludes unresolved/inactive edges", async () => {
  const reader = createInMemoryReader(buildStandardFixture());
  const result = await lookupCodeRelationships(
    BRANCH_A,
    { mode: "find_callers", symbolName: "executeQuery" },
    { userId: USER_ALLOWED },
    reader,
  );

  assert.equal(result.status, "ok");
  assert.equal(result.totalCallers, 1);
  const callers = result.callers as Array<Record<string, any>>;
  assert.equal(callers.length, 1);
  assert.equal(callers[0].fromSymbol.id, "sym-repo-save");
  assert.equal(callers[0].fromSymbol.qualifiedName, "OrderRepository.save");
  assert.equal(callers[0].toSymbol.id, "sym-db-exec");
  assert.equal(callers[0].startLine, 16);
});

test("3 & 7. Finding callees separates confirmed targets from unresolved references", async () => {
  const reader = createInMemoryReader(buildStandardFixture());
  const result = await lookupCodeRelationships(
    BRANCH_A,
    { mode: "find_callees", symbolId: "sym-ctrl-handle" },
    { userId: USER_ALLOWED },
    reader,
  );

  assert.equal(result.status, "ok");
  assert.equal(result.totalCallees, 1);
  const callees = result.callees as Array<Record<string, any>>;
  assert.equal(callees.length, 1);
  assert.equal(callees[0].toSymbol.id, "sym-svc-process");
  assert.equal(callees[0].toSymbol.qualifiedName, "OrderService.processOrder");

  // Unresolved reference is reported separately, never mixed into callees
  assert.equal(result.unresolvedCount, 1);
  const unresolved = result.unresolvedReferences as Array<Record<string, any>>;
  assert.equal(unresolved.length, 1);
  assert.equal(unresolved[0].referenceName, "emitMetric");
  assert.equal(unresolved[0].isResolved, false);
  assert.equal(unresolved[0].resolutionError, "unresolved_reference");
});

test("4. Class dependencies expose inheritance, implementations, subclasses, implementors, members, and imports", async () => {
  const reader = createInMemoryReader(buildStandardFixture());

  const serviceDeps = await lookupCodeRelationships(
    BRANCH_A,
    { mode: "class_dependencies", symbolName: "OrderService" },
    { userId: USER_ALLOWED },
    reader,
  );

  assert.equal(serviceDeps.status, "ok");
  assert.equal((serviceDeps.extends as any[]).length, 1);
  assert.equal((serviceDeps.extends as any[])[0].toSymbol.name, "BaseService");
  assert.equal((serviceDeps.implements as any[]).length, 1);
  assert.equal(
    (serviceDeps.implements as any[])[0].toSymbol.name,
    "IOrderProcessor",
  );
  assert.equal((serviceDeps.members as any[]).length, 1);
  assert.equal((serviceDeps.members as any[])[0].name, "processOrder");
  assert.equal((serviceDeps.fileImports as any[]).length, 1);
  assert.equal(
    (serviceDeps.fileImports as any[])[0].targetModule,
    "./baseService",
  );

  const baseDeps = await lookupCodeRelationships(
    BRANCH_A,
    { mode: "class_dependencies", symbolName: "BaseService" },
    { userId: USER_ALLOWED },
    reader,
  );
  assert.equal((baseDeps.subclasses as any[]).length, 1);
  assert.equal(
    (baseDeps.subclasses as any[])[0].fromSymbol.name,
    "OrderService",
  );
});

test("5. Cross-file execution path traces Controller -> Service -> Repository -> Database", async () => {
  const reader = createInMemoryReader(buildStandardFixture());

  // Outgoing trace without explicit target
  const outgoing = await lookupCodeRelationships(
    BRANCH_A,
    {
      mode: "execution_path",
      qualifiedName: "OrderController.createOrder",
      maxDepth: 5,
    },
    { userId: USER_ALLOWED },
    reader,
  );

  assert.equal(outgoing.status, "ok");
  assert.equal(outgoing.cycleDetected, false);
  const paths = outgoing.paths as Array<Record<string, any>>;
  assert.equal(paths.length, 1);
  assert.equal(paths[0].depth, 3);
  assert.equal(
    paths[0].summary,
    "src/controllers/orderController.ts:OrderController.createOrder -> src/services/orderService.ts:OrderService.processOrder -> src/repositories/orderRepository.ts:OrderRepository.save -> src/db/client.ts:executeQuery",
  );

  // Incoming trace toward Database function
  const incoming = await lookupCodeRelationships(
    BRANCH_A,
    {
      mode: "execution_path",
      symbolId: "sym-db-exec",
      direction: "incoming",
      maxDepth: 5,
    },
    { userId: USER_ALLOWED },
    reader,
  );
  assert.equal(incoming.status, "ok");
  const inPaths = incoming.paths as Array<Record<string, any>>;
  assert.equal(inPaths.length, 1);
  assert.equal(inPaths[0].depth, 3);
  assert.equal(
    inPaths[0].summary,
    "src/controllers/orderController.ts:OrderController.createOrder -> src/services/orderService.ts:OrderService.processOrder -> src/repositories/orderRepository.ts:OrderRepository.save -> src/db/client.ts:executeQuery",
  );

  // Targeted trace between two specific symbols
  const targeted = await lookupCodeRelationships(
    BRANCH_A,
    {
      mode: "execution_path",
      symbolId: "sym-ctrl-handle",
      targetSymbolId: "sym-repo-save",
    },
    { userId: USER_ALLOWED },
    reader,
  );
  assert.equal(targeted.targetReached, true);
  assert.equal((targeted.paths as any[]).length, 1);
  assert.equal((targeted.paths as any[])[0].depth, 2);
});

test("6. Ambiguous symbol names are never guessed and return candidateSymbols", async () => {
  const reader = createInMemoryReader(buildStandardFixture());

  // In symbol_lookup, ambiguity flag and all matching symbols are returned
  const lookupRes = await lookupCodeRelationships(
    BRANCH_A,
    { mode: "symbol_lookup", symbolName: "save" },
    { userId: USER_ALLOWED },
    reader,
  );
  assert.equal(lookupRes.status, "ok");
  assert.equal(lookupRes.isAmbiguous, true);
  assert.equal(lookupRes.totalMatches, 2);

  // In traversal modes, ambiguity prevents picking an arbitrary match
  const callersRes = await lookupCodeRelationships(
    BRANCH_A,
    { mode: "find_callers", symbolName: "save" },
    { userId: USER_ALLOWED },
    reader,
  );
  assert.equal(callersRes.status, "ambiguous");
  assert.equal(callersRes.totalMatches, 2);
  assert.equal((callersRes.candidateSymbols as any[]).length, 2);
  assert.equal(callersRes.callers, undefined);

  // Disambiguating with filePath succeeds
  const disambiguated = await lookupCodeRelationships(
    BRANCH_A,
    {
      mode: "find_callers",
      symbolName: "save",
      filePath: "src/repositories/orderRepository.ts",
    },
    { userId: USER_ALLOWED },
    reader,
  );
  assert.equal(disambiguated.status, "ok");
  assert.equal(disambiguated.totalCallers, 1);
});

test("8. Circular dependencies terminate safely and report cycleDetected", async () => {
  const fixture: InMemoryGraphFixture = {
    access: [{ userId: USER_ALLOWED, branchIndexId: BRANCH_A }],
    branches: [
      {
        branchIndexId: BRANCH_A,
        branchName: "main",
        status: "ready",
        commitSha: COMMIT_ACTIVE,
        graphStatus: "completed",
      },
    ],
    symbols: [
      sym("sym-a", { name: "stepA", kind: "function", filePath: "src/a.ts" }),
      sym("sym-b", { name: "stepB", kind: "function", filePath: "src/b.ts" }),
      sym("sym-c", { name: "stepC", kind: "function", filePath: "src/c.ts" }),
    ],
    relationships: [
      rel("rel-ab", {
        type: "CALL",
        fromSymbolId: "sym-a",
        toSymbolId: "sym-b",
        filePath: "src/a.ts",
        referenceName: "stepB",
      }),
      rel("rel-bc", {
        type: "CALL",
        fromSymbolId: "sym-b",
        toSymbolId: "sym-c",
        filePath: "src/b.ts",
        referenceName: "stepC",
      }),
      rel("rel-ca", {
        type: "CALL",
        fromSymbolId: "sym-c",
        toSymbolId: "sym-a",
        filePath: "src/c.ts",
        referenceName: "stepA",
      }),
    ],
  };

  const result = await lookupCodeRelationships(
    BRANCH_A,
    { mode: "execution_path", symbolName: "stepA", maxDepth: 6 },
    { userId: USER_ALLOWED },
    createInMemoryReader(fixture),
  );

  assert.equal(result.status, "ok");
  assert.equal(result.cycleDetected, true);
  assert.equal((result.cycles as any[]).length, 1);
  assert.equal((result.cycles as any[])[0].fromSymbol.id, "sym-c");
  assert.equal((result.cycles as any[])[0].toSymbol.id, "sym-a");
  assert.equal((result.limits as any).nodesExplored, 3);
  assert.equal((result.paths as any[]).length, 1);
  assert.equal((result.paths as any[])[0].depth, 2);
});

test("9. Traversal depth, node limits, and result caps are strictly enforced", async () => {
  const symbols: PersistedGraphSymbol[] = [];
  const relationships: PersistedGraphRelationship[] = [];
  for (let i = 0; i < 60; i++) {
    symbols.push(
      sym(`sym-${i}`, {
        name: `fn${i}`,
        kind: "function",
        filePath: `src/f${i}.ts`,
      }),
    );
    if (i > 0) {
      relationships.push(
        rel(`rel-${i}`, {
          type: "CALL",
          fromSymbolId: `sym-${i - 1}`,
          toSymbolId: `sym-${i}`,
          filePath: `src/f${i - 1}.ts`,
          referenceName: `fn${i}`,
        }),
      );
    }
  }

  const reader = createInMemoryReader({
    access: [{ userId: USER_ALLOWED, branchIndexId: BRANCH_A }],
    branches: [
      {
        branchIndexId: BRANCH_A,
        branchName: "main",
        status: "ready",
        commitSha: COMMIT_ACTIVE,
        graphStatus: "completed",
      },
    ],
    symbols,
    relationships,
  });

  // Excessive depth and node limit are clamped to hard limits
  const capped = await lookupCodeRelationships(
    BRANCH_A,
    { mode: "execution_path", symbolId: "sym-0", maxDepth: 99, limit: 999 },
    { userId: USER_ALLOWED },
    reader,
  );
  const limits = capped.limits as Record<string, unknown>;
  assert.equal(limits.maxDepth, GRAPH_LOOKUP_LIMITS.maxExecutionDepth);
  assert.equal(limits.maxNodes, GRAPH_LOOKUP_LIMITS.maxNodesExplored);
  assert.equal(limits.depthReached, GRAPH_LOOKUP_LIMITS.maxExecutionDepth);
  assert.equal(limits.truncated, true);

  // Small maxNodes cap stops early
  const smallNodes = await lookupCodeRelationships(
    BRANCH_A,
    { mode: "execution_path", symbolId: "sym-0", maxDepth: 6, limit: 3 },
    { userId: USER_ALLOWED },
    reader,
  );
  assert.equal((smallNodes.limits as any).nodesExplored, 3);
  assert.equal((smallNodes.limits as any).truncated, true);
  assert.equal(
    (smallNodes.limits as any).truncationReason,
    "max_nodes_reached",
  );
});

test("10 & 11. Excludes inactive snapshots, unpublished branches, other commits, and other branches", async () => {
  const fixture = buildStandardFixture();
  fixture.branches.push({
    branchIndexId: "33333333-3333-4333-8333-333333333333",
    branchName: "unindexed",
    status: "ingesting",
    commitSha: null,
    graphStatus: "pending",
  });
  const reader = createInMemoryReader(fixture);

  // Unpublished branch returns unavailable rather than leaking staged nodes
  const unpublished = await lookupCodeRelationships(
    "33333333-3333-4333-8333-333333333333",
    { mode: "symbol_lookup", symbolName: "createOrder" },
    {},
    reader,
  );
  assert.equal(unpublished.status, "unavailable");

  // Querying createOrder on BRANCH_A returns only the active commit symbol,
  // excluding both the staged attempt and BRANCH_B
  const activeOnly = await lookupCodeRelationships(
    BRANCH_A,
    { mode: "symbol_lookup", symbolName: "createOrder" },
    { userId: USER_ALLOWED },
    reader,
  );
  assert.equal(activeOnly.totalMatches, 1);
  assert.equal((activeOnly.symbols as any[])[0].id, "sym-ctrl-handle");
});

test("12. Enforces branch authorization and active snapshot filters in Prisma reader", async () => {
  const reader = createInMemoryReader(buildStandardFixture());

  // Unauthorized user is rejected
  await assert.rejects(
    lookupCodeRelationships(
      BRANCH_A,
      { mode: "symbol_lookup", symbolName: "createOrder" },
      { userId: USER_DENIED },
      reader,
    ),
    (err) => err instanceof GraphAuthorizationError && err.statusCode === 403,
  );

  // Verify prismaCodeGraphReader builds strict branch, isActive, and commitSha predicates
  const recordedCalls: Array<{ model: string; op: string; args: unknown }> = [];
  const origAccess = prisma.userBranchAccess;
  const origBranch = prisma.branchIndex;
  const origSymbol = prisma.codeSymbol;
  const origRel = prisma.codeRelationship;

  Object.defineProperty(prisma, "userBranchAccess", {
    configurable: true,
    value: {
      findUnique: async (args: unknown) => {
        recordedCalls.push({
          model: "userBranchAccess",
          op: "findUnique",
          args,
        });
        return { userId: USER_ALLOWED };
      },
    },
  });
  Object.defineProperty(prisma, "branchIndex", {
    configurable: true,
    value: {
      findUnique: async (args: unknown) => {
        recordedCalls.push({ model: "branchIndex", op: "findUnique", args });
        return {
          id: BRANCH_A,
          branchName: "main",
          status: "ready",
          publishedCommitSha: COMMIT_ACTIVE,
          graphStatus: "completed",
        };
      },
    },
  });
  Object.defineProperty(prisma, "codeSymbol", {
    configurable: true,
    value: {
      findMany: async (args: unknown) => {
        recordedCalls.push({ model: "codeSymbol", op: "findMany", args });
        return [
          {
            id: "44444444-4444-4444-8444-444444444444",
            branchIndexId: BRANCH_A,
            filePath: "src/index.ts",
            name: "boot",
            kind: "function",
            language: "typescript",
            startLine: 1,
            endLine: 5,
            containerName: null,
            signature: null,
            commitSha: COMMIT_ACTIVE,
            ingestionAttempt: 1,
            isActive: true,
          },
        ];
      },
      count: async () => 1,
    },
  });
  Object.defineProperty(prisma, "codeRelationship", {
    configurable: true,
    value: {
      findMany: async (args: unknown) => {
        recordedCalls.push({ model: "codeRelationship", op: "findMany", args });
        return [];
      },
      count: async () => 0,
    },
  });

  try {
    const res = await lookupCodeRelationships(
      BRANCH_A,
      { mode: "find_callees", symbolName: "boot" },
      { userId: USER_ALLOWED },
      prismaCodeGraphReader,
    );
    assert.equal(res.status, "ok");

    const symQuery = recordedCalls.find(
      (c) => c.model === "codeSymbol" && c.op === "findMany",
    )!.args as { where: { AND: Array<Record<string, unknown>> } };
    assert.ok(
      symQuery.where.AND.some((cond) => cond.branchIndexId === BRANCH_A),
    );
    assert.ok(symQuery.where.AND.some((cond) => cond.isActive === true));
    assert.ok(
      symQuery.where.AND.some((cond) => cond.commitSha === COMMIT_ACTIVE),
    );

    const relQuery = recordedCalls.find(
      (c) => c.model === "codeRelationship" && c.op === "findMany",
    )!.args as { where: Record<string, unknown> };
    assert.equal(relQuery.where.branchIndexId, BRANCH_A);
    assert.equal(relQuery.where.isActive, true);
    assert.equal(relQuery.where.commitSha, COMMIT_ACTIVE);
  } finally {
    Object.defineProperty(prisma, "userBranchAccess", {
      configurable: true,
      value: origAccess,
    });
    Object.defineProperty(prisma, "branchIndex", {
      configurable: true,
      value: origBranch,
    });
    Object.defineProperty(prisma, "codeSymbol", {
      configurable: true,
      value: origSymbol,
    });
    Object.defineProperty(prisma, "codeRelationship", {
      configurable: true,
      value: origRel,
    });
  }
});
