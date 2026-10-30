import test from "node:test";
import assert from "node:assert/strict";
import {
  chunkSourceFile,
  chunkByLines,
  isBinaryContent,
  detectLanguage,
} from "../services/codeChunker.js";

test("detectLanguage correctly maps file extensions to language names and grammars", () => {
  assert.deepEqual(detectLanguage("src/index.ts"), {
    language: "typescript",
    grammar: "typescript",
  });
  assert.deepEqual(detectLanguage("components/App.tsx"), {
    language: "tsx",
    grammar: "tsx",
  });
  assert.deepEqual(detectLanguage("script.py"), {
    language: "python",
    grammar: "python",
  });
  assert.deepEqual(detectLanguage("main.go"), {
    language: "go",
    grammar: "go",
  });
  assert.deepEqual(detectLanguage("notes.txt"), {
    language: "text",
    grammar: null,
  });
});

test("isBinaryContent identifies null bytes and binary characters", () => {
  assert.equal(isBinaryContent("const x = 1;\nconsole.log(x);"), false);
  assert.equal(isBinaryContent("Hello world\0with null byte"), true);
});

test("chunkSourceFile returns empty array for empty or binary file", async () => {
  const empty = await chunkSourceFile("test.ts", "", "abc123");
  assert.deepEqual(empty, []);

  const binary = await chunkSourceFile("test.png", "PNG\0\0\0magic", "abc123");
  assert.deepEqual(binary, []);
});

test("chunkSourceFile syntax-aware chunking identifies functions and line numbers", async () => {
  const code = [
    "function calculateTotal(items: number[]): number {",
    "  let sum = 0;",
    "  for (const item of items) {",
    "    sum += item;",
    "  }",
    "  return sum;",
    "}",
  ].join("\n");

  const chunks = await chunkSourceFile("src/math.ts", code, "sha1234", {
    maxChunkChars: 1000,
    minChunkChars: 50,
  });

  assert.equal(chunks.length, 1);
  assert.equal(chunks[0].filePath, "src/math.ts");
  assert.equal(chunks[0].symbolName, "calculateTotal");
  assert.equal(chunks[0].startLine, 1);
  assert.equal(chunks[0].endLine, 7);
  assert.equal(chunks[0].language, "typescript");
  assert.equal(chunks[0].commitSha, "sha1234");
});

test("chunkSourceFile bundles small units together", async () => {
  const code = [
    "import a from 'a';",
    "import b from 'b';",
    "export const X = 1;",
    "export const Y = 2;",
  ].join("\n");

  const chunks = await chunkSourceFile("src/constants.ts", code, "sha1234", {
    maxChunkChars: 500,
    minChunkChars: 100, // minChars forces bundling small declarations
  });

  assert.equal(chunks.length, 1);
  assert.equal(chunks[0].startLine, 1);
  assert.equal(chunks[0].endLine, 4);
  assert.ok(chunks[0].content.includes("export const X = 1;"));
});

test("chunkSourceFile splits oversized classes into structural units", async () => {
  const code = [
    "class UserService {",
    "  getUser(id: string) {",
    "    const user = fetchUser(id);",
    "    return user;",
    "  }",
    "  saveUser(user: Record<string, unknown>) {",
    "    validateUser(user);",
    "    persistUser(user);",
    "    return true;",
    "  }",
    "}",
  ].join("\n");

  // Setting maxChunkChars small enough to trigger class splitting but large enough for methods
  const chunks = await chunkSourceFile("src/service.ts", code, "sha1234", {
    maxChunkChars: 120,
    minChunkChars: 10,
  });

  assert.ok(
    chunks.length >= 2,
    `Expected at least 2 chunks, got ${chunks.length}`,
  );
  const methodNames = chunks.map((c) => c.symbolName);
  assert.ok(
    methodNames.some((name) => name?.includes("UserService.getUser")),
    `Expected UserService.getUser in ${methodNames.join(", ")}`,
  );
  assert.ok(
    methodNames.some((name) => name?.includes("UserService.saveUser")),
    `Expected UserService.saveUser in ${methodNames.join(", ")}`,
  );
});

test("chunkSourceFile splits oversized functions at syntax boundaries", async () => {
  const statements = Array.from(
    { length: 15 },
    (_, i) => `  const step${i} = processStep(${i});`,
  );
  const code = [
    "function longProcess() {",
    ...statements,
    "  return true;",
    "}",
  ].join("\n");

  const chunks = await chunkSourceFile("src/process.ts", code, "sha1234", {
    maxChunkChars: 150,
  });

  assert.ok(
    chunks.length > 1,
    `Expected multiple chunks for oversized function, got ${chunks.length}`,
  );
  assert.ok(chunks[0].symbolName?.includes("longProcess"));
  for (const chunk of chunks) {
    assert.ok(chunk.startLine >= 1);
    assert.ok(chunk.endLine >= chunk.startLine);
  }
});

test("chunkByLines handles fallback line-based chunking with exact 1-based lines", () => {
  const content = ["Line 1", "Line 2", "Line 3", "Line 4", "Line 5"].join("\n");

  const chunks = chunkByLines("doc.txt", content, "text", "sha1", 15, 0);

  assert.ok(chunks.length >= 2);
  assert.equal(chunks[0].startLine, 1);
  assert.equal(chunks[0].symbolName, null);
  for (const c of chunks) {
    assert.ok(c.startLine <= c.endLine);
    assert.ok(c.content.length > 0);
  }
});
