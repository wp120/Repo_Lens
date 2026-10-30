import test from "node:test";
import assert from "node:assert/strict";
import {
  isIndexableSourceFile,
  fetchIndexableFiles,
  type GitHubIngestionLimits,
} from "../services/githubIngestionLimits.js";

test("isIndexableSourceFile filters out excluded directories, binaries, and lockfiles", () => {
  // Eligible source files
  assert.equal(isIndexableSourceFile("src/index.ts"), true);
  assert.equal(isIndexableSourceFile("lib/utils.py"), true);
  assert.equal(isIndexableSourceFile("components/Button.tsx"), true);
  assert.equal(isIndexableSourceFile("main.go"), true);
  assert.equal(isIndexableSourceFile("docs/readme.md"), true);

  // Excluded directories
  assert.equal(isIndexableSourceFile("node_modules/pkg/index.js"), false);
  assert.equal(isIndexableSourceFile("dist/bundle.js"), false);
  assert.equal(isIndexableSourceFile("build/output.js"), false);
  assert.equal(isIndexableSourceFile(".git/hooks/pre-commit.sh"), false);
  assert.equal(isIndexableSourceFile("vendor/bundle/lib.rb"), false);
  assert.equal(isIndexableSourceFile(".next/static/chunks/app.js"), false);
  assert.equal(isIndexableSourceFile("venv/lib/python3.10/site.py"), false);

  // Excluded file types / lockfiles / minified
  assert.equal(isIndexableSourceFile("package-lock.json"), false);
  assert.equal(isIndexableSourceFile("yarn.lock"), false);
  assert.equal(isIndexableSourceFile("Cargo.lock"), false);
  assert.equal(isIndexableSourceFile("app.min.js"), false);
  assert.equal(isIndexableSourceFile("style.bundle.css"), false);
  assert.equal(isIndexableSourceFile("dist/bundle.js.map"), false);
  assert.equal(isIndexableSourceFile("image.png"), false);
  assert.equal(isIndexableSourceFile("binary.wasm"), false);
  assert.equal(isIndexableSourceFile("document.pdf"), false);
});

test("fetchIndexableFiles rejects when an individual file exceeds maxFileSizeBytes", async () => {
  const limits: GitHubIngestionLimits = {
    repositorySizeKb: 1000,
    indexableFileCount: 100,
    indexableSourceBytes: 100000,
    maxFileSizeBytes: 50, // 50 bytes limit
  };

  const fakeFetcher: typeof fetch = async (url) => {
    const urlStr = url.toString();
    if (urlStr.includes("/git/trees/")) {
      return new Response(
        JSON.stringify({
          truncated: false,
          tree: [
            { type: "blob", path: "src/normal.ts", size: 30, sha: "sha1" },
            { type: "blob", path: "src/huge.ts", size: 100, sha: "sha2" }, // 100 > 50
          ],
        }),
        { status: 200 },
      );
    }
    return new Response("Not found", { status: 404 });
  };

  await assert.rejects(
    fetchIndexableFiles("owner", "repo", "a".repeat(40), limits, fakeFetcher),
    /individual file size limit/,
  );
});

test("fetchIndexableFiles falls back to non-recursive traversal when tree is truncated", async () => {
  const limits: GitHubIngestionLimits = {
    repositorySizeKb: 1000,
    indexableFileCount: 100,
    indexableSourceBytes: 100000,
    maxFileSizeBytes: 10000,
  };

  const rootSha = "a".repeat(40);
  const srcSha = "b".repeat(40);

  const fakeFetcher: typeof fetch = async (url) => {
    const urlStr = url.toString();

    // First recursive call is truncated
    if (urlStr.includes("recursive=1")) {
      return new Response(
        JSON.stringify({
          truncated: true,
          tree: [],
        }),
        { status: 200 },
      );
    }

    // Root directory non-recursive call
    if (urlStr.includes(`/git/trees/${rootSha}`)) {
      return new Response(
        JSON.stringify({
          truncated: false,
          tree: [
            { type: "tree", path: "src", sha: srcSha },
            { type: "blob", path: "README.md", size: 40, sha: "sha-readme" },
            { type: "tree", path: "node_modules", sha: "ignored-modules" },
          ],
        }),
        { status: 200 },
      );
    }

    // src directory non-recursive call
    if (urlStr.includes(`/git/trees/${srcSha}`)) {
      return new Response(
        JSON.stringify({
          truncated: false,
          tree: [
            { type: "blob", path: "index.ts", size: 60, sha: "sha-index" },
          ],
        }),
        { status: 200 },
      );
    }

    return new Response("Not found", { status: 404 });
  };

  const files = await fetchIndexableFiles(
    "owner",
    "repo",
    rootSha,
    limits,
    fakeFetcher,
  );

  assert.equal(files.length, 2);
  assert.deepEqual(
    files.map((f) => f.path).sort(),
    ["README.md", "src/index.ts"].sort(),
  );
  assert.equal(files.find((f) => f.path === "README.md")?.size, 40);
  assert.equal(files.find((f) => f.path === "src/index.ts")?.size, 60);
});

test("fetchIndexableFiles fails safely when non-recursive traversal is also truncated", async () => {
  const limits: GitHubIngestionLimits = {
    repositorySizeKb: 1000,
    indexableFileCount: 100,
    indexableSourceBytes: 100000,
    maxFileSizeBytes: 10000,
  };

  const rootSha = "c".repeat(40);

  const fakeFetcher: typeof fetch = async (url) => {
    const urlStr = url.toString();
    if (urlStr.includes("recursive=1")) {
      return new Response(JSON.stringify({ truncated: true, tree: [] }), {
        status: 200,
      });
    }
    // Subtree is also truncated
    return new Response(JSON.stringify({ truncated: true, tree: [] }), {
      status: 200,
    });
  };

  await assert.rejects(
    fetchIndexableFiles("owner", "repo", rootSha, limits, fakeFetcher),
    /incomplete branch file listing/,
  );
});
