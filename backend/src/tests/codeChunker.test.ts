import test from "node:test";
import assert from "node:assert/strict";
import {
  chunkSourceFile,
  chunkByLines,
  isBinaryContent,
  detectLanguage,
} from "../services/codeChunker.js";
import { estimateVoyageTokens } from "../services/tokenEstimator.js";
import { buildChunkEmbeddingText } from "../services/embeddingContext.js";

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

test("normal function remains a single chunk under the token limit", async () => {
  const code = [
    "function add(a: number, b: number) {",
    "  return a + b;",
    "}",
  ].join("\n");

  const chunks = await chunkSourceFile("src/add.ts", code, "sha1", {
    maxChunkChars: 1000,
    maxTokensPerChunk: 100,
  });

  assert.equal(chunks.length, 1);
  assert.equal(chunks[0].startLine, 1);
  assert.equal(chunks[0].endLine, 3);
});

test("long functions split at statements and stay within the token budget", async () => {
  const statements = Array.from(
    { length: 12 },
    (_, i) => `  const step${i} = processStep(${i});`,
  );
  const code = ["function processAll() {", ...statements, "  return true;", "}"].join(
    "\n",
  );

  const chunks = await chunkSourceFile("src/process.ts", code, "sha1", {
    maxChunkChars: 1000,
    maxTokensPerChunk: 12,
  });

  assert.ok(chunks.length > 1);
  assert.ok(chunks.every((chunk) => estimateVoyageTokens(chunk.content) <= 12));
});

test("oversized statements and very long lines do not lose source text", async () => {
  const longLine = `  const payload = "${"x".repeat(500)}";`;
  const code = ["function build() {", longLine, "  return payload;", "}"].join("\n");

  const chunks = await chunkSourceFile("src/long.ts", code, "sha1", {
    maxChunkChars: 1000,
    maxTokensPerChunk: 20,
  });

  assert.ok(chunks.length > 1);
  for (const chunk of chunks) {
    assert.ok(chunk.content.length > 0);
    assert.ok(estimateVoyageTokens(chunk.content) <= 20);
    assert.equal(chunk.startLine >= 1, true);
    assert.equal(chunk.endLine >= chunk.startLine, true);
  }
  const longLineXCount = chunks.reduce(
    (count, chunk) => count + (chunk.content.match(/x/g)?.length ?? 0),
    0,
  );
  assert.equal(
    longLineXCount,
    500,
    chunks.map((chunk) => `${chunk.startLine}-${chunk.endLine}:${chunk.content.length}:${(chunk.content.match(/x/g) ?? []).length}`).join("\n"),
  );
});

test("oversized class method chunks preserve class, method, and signature context", async () => {
  const code = [
    "class BookingController {",
    "  async getBooking(id: string) {",
    "    const booking = await Booking.findById(id);",
    "    if (!booking) throw new Error(\"Not found\");",
    "    return booking;",
    "  }",
    "}",
  ].join("\n");

  const chunks = await chunkSourceFile("src/bookingController.ts", code, "sha1", {
    maxChunkChars: 80,
    maxTokensPerChunk: 30,
  });
  const methodChunk = chunks.find(
    (chunk) => chunk.className === "BookingController" && chunk.symbolType === "method",
  );

  assert.ok(methodChunk);
  assert.ok(methodChunk.className);
  assert.match(methodChunk.functionSignature ?? "", /getBooking/);
  assert.ok(buildChunkEmbeddingText(methodChunk).startsWith(
    "File: src/bookingController.ts\nLanguage: typescript\nClass: BookingController",
  ));
  assert.ok(buildChunkEmbeddingText(methodChunk).includes("Symbol type: method"));
});

test("embedding context keeps original source content unchanged", () => {
  const chunk = {
    filePath: "src/controllers/bookingController.ts",
    content: 'const booking = await Booking.findById(id);\nif (!booking) throw new Error("Not found");',
    startLine: 10,
    endLine: 11,
    language: "typescript",
    symbolName: "BookingController.getBookingById (part 1)",
    symbolType: "method",
    className: "BookingController",
    functionSignature: "async getBookingById(id: string)",
    commitSha: "sha1",
  };

  const contextualInput = buildChunkEmbeddingText(chunk);
  assert.ok(contextualInput.startsWith(
    "File: src/controllers/bookingController.ts\nLanguage: typescript\nClass: BookingController\nSymbol: BookingController.getBookingById (part 1)\nSymbol type: method\nSignature: async getBookingById(id: string)\n\nCode:\n",
  ));
  assert.ok(contextualInput.includes("Signature: async getBookingById(id: string)"));
  assert.ok(contextualInput.endsWith(chunk.content));
  assert.equal(chunk.content.includes("File:"), false);
});

test("embedding context omits unavailable metadata", () => {
  const text = buildChunkEmbeddingText({
    filePath: "src/standalone.ts",
    content: "export const value = 1;",
    startLine: 1,
    endLine: 1,
    language: "typescript",
    symbolName: null,
    symbolType: null,
    className: null,
    functionSignature: null,
    commitSha: "sha1",
  });

  assert.equal(
    text,
    "File: src/standalone.ts\nLanguage: typescript\n\nCode:\nexport const value = 1;",
  );
  assert.equal(text.includes("null"), false);
  assert.equal(text.includes("undefined"), false);
});
