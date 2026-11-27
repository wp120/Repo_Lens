import test from "node:test";
import assert from "node:assert/strict";
import { parseSourceFileWithGraph } from "../services/codeChunker.js";
import {
  resolveGraphRelationships,
  resolveModulePath,
} from "../services/codeGraphResolver.js";
import type {
  StorableSymbol,
  StorableRelationship,
} from "../services/codeGraphStore.js";

test("Requirement 1: Function, class, method, and interface extraction in TypeScript", async () => {
  const tsCode = `
export interface UserRecord {
  id: string;
  name: string;
}

export class UserService {
  private serviceName: string;

  constructor() {
    this.serviceName = "user-service";
  }

  public findUser(id: string): UserRecord {
    return { id, name: "Alice" };
  }
}

export function createUserService(): UserService {
  return new UserService();
}

export const helperArrow = (x: number) => x * 2;
`;

  const result = await parseSourceFileWithGraph(
    "src/services/userService.ts",
    tsCode,
    "sha-1",
  );

  assert.ok(result.chunks.length > 0, "should produce RAG chunks");

  const syms = result.symbols;
  const iface = syms.find(
    (s) => s.kind === "interface" && s.name === "UserRecord",
  );
  assert.ok(iface, "interface UserRecord extracted");
  assert.equal(iface.filePath, "src/services/userService.ts");

  const cls = syms.find((s) => s.kind === "class" && s.name === "UserService");
  assert.ok(cls, "class UserService extracted");

  const method = syms.find((s) => s.kind === "method" && s.name === "findUser");
  assert.ok(method, "method findUser extracted");
  assert.equal(method.containerName, "UserService");

  const fn = syms.find(
    (s) => s.kind === "function" && s.name === "createUserService",
  );
  assert.ok(fn, "function createUserService extracted");

  const arrowFn = syms.find(
    (s) => s.kind === "function" && s.name === "helperArrow",
  );
  assert.ok(arrowFn, "arrow function helperArrow extracted");
});

test("Requirement 1 (Python): Function, class, and method extraction in Python", async () => {
  const pyCode = `
class Calculator:
    def __init__(self):
        self.base = 0

    def add(self, a, b):
        return a + b

def standalone_func(x):
    return x * 2
`;

  const result = await parseSourceFileWithGraph(
    "math/calculator.py",
    pyCode,
    "sha-1",
  );

  const syms = result.symbols;
  const cls = syms.find((s) => s.kind === "class" && s.name === "Calculator");
  assert.ok(cls, "Python class Calculator extracted");

  const method = syms.find((s) => s.kind === "method" && s.name === "add");
  assert.ok(method, "Python method add extracted");
  assert.equal(method.containerName, "Calculator");

  const fn = syms.find(
    (s) => s.kind === "function" && s.name === "standalone_func",
  );
  assert.ok(fn, "Python function standalone_func extracted");
});

test("Requirement 2: Cross-file function calls in TypeScript", async () => {
  const fileA = "src/utils/math.ts";
  const fileB = "src/services/orderService.ts";

  const codeA = `
export function calculateTax(amount: number): number {
  return amount * 0.1;
}
`;
  const codeB = `
import { calculateTax } from "../utils/math";

export function processOrder(total: number): number {
  const tax = calculateTax(total);
  return total + tax;
}
`;

  const parsedA = await parseSourceFileWithGraph(fileA, codeA, "sha-1");
  const parsedB = await parseSourceFileWithGraph(fileB, codeB, "sha-1");

  const symbols: StorableSymbol[] = [
    ...parsedA.symbols.map((s, idx) => ({
      ...s,
      id: `sym-a-${idx}`,
      branchIndexId: "branch-1",
      commitSha: "sha-1",
      ingestionAttempt: 1,
    })),
    ...parsedB.symbols.map((s, idx) => ({
      ...s,
      id: `sym-b-${idx}`,
      branchIndexId: "branch-1",
      commitSha: "sha-1",
      ingestionAttempt: 1,
    })),
  ];

  const relationships: StorableRelationship[] = [
    ...parsedA.relationshipCandidates.map((c, idx) => ({
      ...c,
      id: `rel-a-${idx}`,
      branchIndexId: "branch-1",
      commitSha: "sha-1",
      ingestionAttempt: 1,
    })),
    ...parsedB.relationshipCandidates.map((c, idx) => ({
      ...c,
      id: `rel-b-${idx}`,
      branchIndexId: "branch-1",
      commitSha: "sha-1",
      ingestionAttempt: 1,
    })),
  ];

  const resolution = await resolveGraphRelationships(
    [fileA, fileB],
    symbols,
    relationships,
  );

  const taxSymbol = symbols.find((s) => s.name === "calculateTax")!;
  assert.ok(taxSymbol);

  // Check the CALL relationship from processOrder to calculateTax
  const callRel = relationships.find(
    (r) => r.type === "CALL" && r.referenceName === "calculateTax",
  )!;
  assert.ok(callRel);

  const callUpdate = resolution.updates.find((u) => u.id === callRel.id)!;
  assert.ok(callUpdate);
  assert.equal(callUpdate.isResolved, true);
  assert.equal(callUpdate.toSymbolId, taxSymbol.id);
  assert.equal(callUpdate.resolutionError, null);
});

test("Requirement 3: Import aliases in TypeScript and Python", async () => {
  // TypeScript alias
  const tsFileA = "src/math.ts";
  const tsFileB = "src/main.ts";
  const tsCodeA = `export function add(a: number, b: number): number { return a + b; }`;
  const tsCodeB = `
import { add as sum } from "./math";

export function run(): number {
  return sum(1, 2);
}
`;

  const parsedTsA = await parseSourceFileWithGraph(tsFileA, tsCodeA, "sha-1");
  const parsedTsB = await parseSourceFileWithGraph(tsFileB, tsCodeB, "sha-1");

  const tsSymbols: StorableSymbol[] = [
    {
      ...parsedTsA.symbols[0],
      id: "sym-add",
      branchIndexId: "branch-1",
      commitSha: "sha-1",
      ingestionAttempt: 1,
    },
    {
      ...parsedTsB.symbols[0],
      id: "sym-run",
      branchIndexId: "branch-1",
      commitSha: "sha-1",
      ingestionAttempt: 1,
    },
  ];

  const tsRelationships: StorableRelationship[] = [
    ...parsedTsB.relationshipCandidates.map((c, idx) => ({
      ...c,
      id: `rel-ts-${idx}`,
      branchIndexId: "branch-1",
      commitSha: "sha-1",
      ingestionAttempt: 1,
    })),
  ];

  const tsResolution = await resolveGraphRelationships(
    [tsFileA, tsFileB],
    tsSymbols,
    tsRelationships,
  );

  const importRel = tsRelationships.find((r) => r.type === "IMPORT")!;
  assert.ok(importRel);
  const importUpdate = tsResolution.updates.find((u) => u.id === importRel.id)!;
  assert.equal(importUpdate.isResolved, true);
  assert.equal(importUpdate.toSymbolId, "sym-add");

  const callRel = tsRelationships.find(
    (r) => r.type === "CALL" && r.referenceName === "sum",
  )!;
  assert.ok(callRel);
  const callUpdate = tsResolution.updates.find((u) => u.id === callRel.id)!;
  assert.equal(callUpdate.isResolved, true);
  assert.equal(callUpdate.toSymbolId, "sym-add");

  // Python alias: from .math import add as sum
  const pyFileA = "app/math.py";
  const pyFileB = "app/main.py";
  const pyCodeA = `def add(a, b):\n    return a + b\n`;
  const pyCodeB = `
from .math import add as sum

def run():
    return sum(1, 2)
`;
  const parsedPyA = await parseSourceFileWithGraph(pyFileA, pyCodeA, "sha-1");
  const parsedPyB = await parseSourceFileWithGraph(pyFileB, pyCodeB, "sha-1");

  const pySymbols: StorableSymbol[] = [
    {
      ...parsedPyA.symbols[0],
      id: "sym-py-add",
      branchIndexId: "branch-1",
      commitSha: "sha-1",
      ingestionAttempt: 1,
    },
    {
      ...parsedPyB.symbols[0],
      id: "sym-py-run",
      branchIndexId: "branch-1",
      commitSha: "sha-1",
      ingestionAttempt: 1,
    },
  ];

  const pyRelationships: StorableRelationship[] = [
    ...parsedPyB.relationshipCandidates.map((c, idx) => ({
      ...c,
      id: `rel-py-${idx}`,
      branchIndexId: "branch-1",
      commitSha: "sha-1",
      ingestionAttempt: 1,
    })),
  ];

  const pyResolution = await resolveGraphRelationships(
    [pyFileA, pyFileB],
    pySymbols,
    pyRelationships,
  );

  const pyCallRel = pyRelationships.find(
    (r) => r.type === "CALL" && r.referenceName === "sum",
  )!;
  assert.ok(pyCallRel);
  const pyCallUpdate = pyResolution.updates.find((u) => u.id === pyCallRel.id)!;
  assert.equal(pyCallUpdate.isResolved, true);
  assert.equal(pyCallUpdate.toSymbolId, "sym-py-add");
});

test("Requirement 4: Inheritance and implementation relationships in TypeScript and Python", async () => {
  // TypeScript inheritance and implementation
  const fileA = "src/base.ts";
  const fileB = "src/derived.ts";
  const codeA = `
export interface Serializable {
  serialize(): string;
}

export class BaseModel {
  id: string = "1";
}
`;
  const codeB = `
import { BaseModel, Serializable } from "./base";

export class User extends BaseModel implements Serializable {
  serialize(): string {
    return JSON.stringify(this);
  }
}
`;

  const parsedA = await parseSourceFileWithGraph(fileA, codeA, "sha-1");
  const parsedB = await parseSourceFileWithGraph(fileB, codeB, "sha-1");

  const symbols: StorableSymbol[] = [
    ...parsedA.symbols.map((s, idx) => ({
      ...s,
      id: `base-${idx}`,
      branchIndexId: "b-1",
      commitSha: "sha-1",
      ingestionAttempt: 1,
    })),
    ...parsedB.symbols.map((s, idx) => ({
      ...s,
      id: `derived-${idx}`,
      branchIndexId: "b-1",
      commitSha: "sha-1",
      ingestionAttempt: 1,
    })),
  ];

  const relationships: StorableRelationship[] = [
    ...parsedB.relationshipCandidates.map((c, idx) => ({
      ...c,
      id: `rel-${idx}`,
      branchIndexId: "b-1",
      commitSha: "sha-1",
      ingestionAttempt: 1,
    })),
  ];

  const resolution = await resolveGraphRelationships(
    [fileA, fileB],
    symbols,
    relationships,
  );

  const baseModelSym = symbols.find((s) => s.name === "BaseModel")!;
  const serializableSym = symbols.find((s) => s.name === "Serializable")!;

  const inheritsRel = relationships.find(
    (r) => r.type === "INHERITS" && r.referenceName === "BaseModel",
  )!;
  assert.ok(inheritsRel);
  const inheritsUpdate = resolution.updates.find(
    (u) => u.id === inheritsRel.id,
  )!;
  assert.equal(inheritsUpdate.isResolved, true);
  assert.equal(inheritsUpdate.toSymbolId, baseModelSym.id);

  const implementsRel = relationships.find(
    (r) => r.type === "IMPLEMENTS" && r.referenceName === "Serializable",
  )!;
  assert.ok(implementsRel);
  const implementsUpdate = resolution.updates.find(
    (u) => u.id === implementsRel.id,
  )!;
  assert.equal(implementsUpdate.isResolved, true);
  assert.equal(implementsUpdate.toSymbolId, serializableSym.id);

  // Python inheritance
  const pyCode = `
class Animal:
    pass

class Dog(Animal):
    pass
`;
  const parsedPy = await parseSourceFileWithGraph(
    "models/animals.py",
    pyCode,
    "sha-1",
  );
  const pySymbols: StorableSymbol[] = parsedPy.symbols.map((s, idx) => ({
    ...s,
    id: `py-${idx}`,
    branchIndexId: "b-1",
    commitSha: "sha-1",
    ingestionAttempt: 1,
  }));
  const pyRels: StorableRelationship[] = parsedPy.relationshipCandidates.map(
    (c, idx) => ({
      ...c,
      id: `py-rel-${idx}`,
      branchIndexId: "b-1",
      commitSha: "sha-1",
      ingestionAttempt: 1,
    }),
  );

  const pyResolution = await resolveGraphRelationships(
    ["models/animals.py"],
    pySymbols,
    pyRels,
  );
  const pyInherits = pyRels.find(
    (r) => r.type === "INHERITS" && r.referenceName === "Animal",
  )!;
  assert.ok(pyInherits);
  const animalSym = pySymbols.find((s) => s.name === "Animal")!;
  const pyInheritsUpdate = pyResolution.updates.find(
    (u) => u.id === pyInherits.id,
  )!;
  assert.equal(pyInheritsUpdate.isResolved, true);
  assert.equal(pyInheritsUpdate.toSymbolId, animalSym.id);
});

test("Requirement 5: Ambiguous and unresolved references preserve failure reasons", async () => {
  const fileA = "src/index.ts";
  const code = `
import { nonExistentSymbol } from "./missingModule";

export function run() {
  mysteryCall();
}
`;

  const parsed = await parseSourceFileWithGraph(fileA, code, "sha-1");
  const symbols: StorableSymbol[] = parsed.symbols.map((s, idx) => ({
    ...s,
    id: `sym-${idx}`,
    branchIndexId: "b-1",
    commitSha: "sha-1",
    ingestionAttempt: 1,
  }));
  const relationships: StorableRelationship[] =
    parsed.relationshipCandidates.map((c, idx) => ({
      ...c,
      id: `rel-${idx}`,
      branchIndexId: "b-1",
      commitSha: "sha-1",
      ingestionAttempt: 1,
    }));

  const resolution = await resolveGraphRelationships(
    [fileA],
    symbols,
    relationships,
  );

  const importRel = relationships.find((r) => r.type === "IMPORT")!;
  const importUpdate = resolution.updates.find((u) => u.id === importRel.id)!;
  assert.equal(importUpdate.isResolved, false);
  assert.equal(importUpdate.resolutionError, "external_module");

  const callRel = relationships.find((r) => r.type === "CALL")!;
  const callUpdate = resolution.updates.find((u) => u.id === callRel.id)!;
  assert.equal(callUpdate.isResolved, false);
  assert.equal(callUpdate.resolutionError, "unresolved_reference");
  assert.equal(callUpdate.toSymbolId, null);
});

test("Requirement 6: Same-name symbols in different files resolve accurately", async () => {
  const fileA = "src/moduleA.ts";
  const fileB = "src/moduleB.ts";
  const fileConsumer = "src/consumer.ts";

  const codeA = `export function execute(): string { return "from A"; }`;
  const codeB = `export function execute(): string { return "from B"; }`;
  const codeConsumer = `
import { execute } from "./moduleB";

export function handle() {
  execute();
}
`;

  const parsedA = await parseSourceFileWithGraph(fileA, codeA, "sha-1");
  const parsedB = await parseSourceFileWithGraph(fileB, codeB, "sha-1");
  const parsedC = await parseSourceFileWithGraph(
    fileConsumer,
    codeConsumer,
    "sha-1",
  );

  const symbols: StorableSymbol[] = [
    {
      ...parsedA.symbols[0],
      id: "id-execute-a",
      branchIndexId: "b-1",
      commitSha: "sha-1",
      ingestionAttempt: 1,
    },
    {
      ...parsedB.symbols[0],
      id: "id-execute-b",
      branchIndexId: "b-1",
      commitSha: "sha-1",
      ingestionAttempt: 1,
    },
    {
      ...parsedC.symbols[0],
      id: "id-handle",
      branchIndexId: "b-1",
      commitSha: "sha-1",
      ingestionAttempt: 1,
    },
  ];

  const relationships: StorableRelationship[] =
    parsedC.relationshipCandidates.map((c, idx) => ({
      ...c,
      id: `rel-c-${idx}`,
      branchIndexId: "b-1",
      commitSha: "sha-1",
      ingestionAttempt: 1,
    }));

  const resolution = await resolveGraphRelationships(
    [fileA, fileB, fileConsumer],
    symbols,
    relationships,
  );

  const callRel = relationships.find(
    (r) => r.type === "CALL" && r.referenceName === "execute",
  )!;
  assert.ok(callRel);
  const callUpdate = resolution.updates.find((u) => u.id === callRel.id)!;

  assert.equal(callUpdate.isResolved, true);
  // Must link to moduleB's execute, NEVER moduleA's execute!
  assert.equal(callUpdate.toSymbolId, "id-execute-b");
});
