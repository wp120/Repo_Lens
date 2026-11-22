import assert from "node:assert/strict";
import test from "node:test";
import { formatRepositoryStructure } from "../services/repositoryStructure.js";

const repository = {
  repository: "sample/repo",
  branch: "main",
  filePaths: [
    "README.md",
    "package-lock.json",
    "src/index.ts",
    "src/services/auth.ts",
    "src/services/session.ts",
    "assets/logo.png",
  ],
};

test("repository overview lists root entries and all tracked file counts", () => {
  const result = formatRepositoryStructure(repository, { mode: "overview" });

  assert.equal(result.status, "available");
  assert.equal(result.repository, "sample/repo");
  assert.equal(result.branch, "main");
  assert.equal(result.fileCount, 6);
  assert.deepEqual(result.entries, [
    { name: "assets", path: "assets", type: "directory" },
    { name: "package-lock.json", path: "package-lock.json", type: "file" },
    { name: "README.md", path: "README.md", type: "file" },
    { name: "src", path: "src", type: "directory" },
  ]);
});

test("directory listing returns complete file paths with pagination", () => {
  const result = formatRepositoryStructure(repository, {
    mode: "list_directory",
    path: "src",
    offset: 1,
    limit: 1,
  });

  assert.deepEqual(result.entries, [
    { name: "services", path: "src/services", type: "directory" },
  ]);
  assert.equal(result.hasMore, false);
});

test("tree mode derives nested directories and bounds the result", () => {
  const result = formatRepositoryStructure(repository, {
    mode: "tree",
    path: "src",
    depth: 3,
    limit: 4,
  });

  assert.deepEqual(result.entries, [
    {
      name: "index.ts",
      path: "src/index.ts",
      type: "file",
    },
    {
      name: "services",
      path: "src/services",
      type: "directory",
      children: [
        { name: "auth.ts", path: "src/services/auth.ts", type: "file" },
        { name: "session.ts", path: "src/services/session.ts", type: "file" },
      ],
      truncated: false,
    },
  ]);
});

test("search matches filenames and paths and reports more results", () => {
  const result = formatRepositoryStructure(repository, {
    mode: "search",
    query: "service",
    limit: 1,
  });

  assert.equal(result.matchCount, 2);
  assert.equal(result.hasMore, true);
  assert.deepEqual(result.entries, [
    { name: "auth.ts", path: "src/services/auth.ts", type: "file" },
  ]);
});

test("empty repository and invalid directory are distinguishable", () => {
  const empty = formatRepositoryStructure(
    { ...repository, filePaths: [] },
    { mode: "overview" },
  );
  const missing = formatRepositoryStructure(repository, {
    mode: "list_directory",
    path: "missing",
  });

  assert.equal(empty.status, "available");
  assert.equal(empty.fileCount, 0);
  assert.deepEqual(empty.entries, []);
  assert.equal(missing.status, "not_found");
});
