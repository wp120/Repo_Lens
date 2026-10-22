import assert from "node:assert/strict";
import test from "node:test";
import {
  GitHubRepositoryError,
  parseGitHubRepositoryUrl,
  resolveGitHubRepository,
} from "../services/githubRepository.js";

test("normalizes repository URLs and ignores query, fragment, and trailing slash", () => {
  assert.deepEqual(
    parseGitHubRepositoryUrl(
      "https://github.com/Example/Repo.git/?tab=readme#overview",
    ),
    {
      owner: "Example",
      repository: "Repo",
      branchSegments: null,
    },
  );
});

test("parses branch URLs with an optional file or folder path", () => {
  assert.deepEqual(
    parseGitHubRepositoryUrl(
      "https://github.com/example/repo/tree/feature%2Fsearch/src/query.ts",
    ),
    {
      owner: "example",
      repository: "repo",
      branchSegments: ["feature/search", "src", "query.ts"],
    },
  );
});

test("rejects malformed, unsupported-host, and unsupported-path URLs", () => {
  for (const value of [
    "not a URL",
    "https://github.example.com/owner/repo",
    "http://github.com/owner/repo",
    "https://github.com/owner//repo",
    "https://github.com/owner/repo/issues/4",
  ]) {
    assert.throws(() => parseGitHubRepositoryUrl(value), GitHubRepositoryError);
  }
});

test("uses and verifies GitHub's actual default branch", async () => {
  const requested: string[] = [];
  const result = await resolveGitHubRepository(
    "https://github.com/owner/repo",
    async (input) => {
      const url = String(input);
      requested.push(url);
      return url.endsWith("/branches/release")
        ? jsonResponse({ name: "release" })
        : jsonResponse({
            id: 123,
            name: "repo",
            full_name: "owner/repo",
            html_url: "https://github.com/owner/repo/",
            default_branch: "release",
            private: false,
          });
    },
  );

  assert.equal(result.branchName, "release");
  assert.equal(result.defaultBranch, "release");
  assert.equal(result.githubRepoId, 123n);
  assert.ok(requested.some((url) => url.endsWith("/branches/release")));
});

test("resolves branch names containing slashes before the remaining file path", async () => {
  const requested: string[] = [];
  const result = await resolveGitHubRepository(
    "https://github.com/owner/repo/tree/feature%2Fsearch/src/index.ts",
    async (input) => {
      const url = String(input);
      requested.push(url);
      if (url.endsWith("/branches/feature%2Fsearch")) {
        return jsonResponse({ name: "feature/search" });
      }
      if (url.endsWith("/branches/main")) {
        return jsonResponse({ name: "main" });
      }
      if (url.endsWith("/branches/feature%2Fsearch%2Fsrc%2Findex.ts")) {
        return new Response(null, { status: 404 });
      }
      if (url.endsWith("/branches/feature%2Fsearch%2Fsrc")) {
        return new Response(null, { status: 404 });
      }
      return jsonResponse({
        id: 123,
        name: "repo",
        full_name: "owner/repo",
        html_url: "https://github.com/owner/repo",
        default_branch: "main",
        private: false,
      });
    },
  );

  assert.equal(result.branchName, "feature/search");
  assert.ok(
    requested.some((url) => url.endsWith("/branches/feature%2Fsearch")),
  );
});

test("reports private repositories and GitHub API rate limits clearly", async () => {
  await assert.rejects(
    resolveGitHubRepository("https://github.com/owner/private", async () =>
      jsonResponse({
        id: 1,
        name: "private",
        full_name: "owner/private",
        html_url: "https://github.com/owner/private",
        default_branch: "main",
        private: true,
      }),
    ),
    /Only public GitHub repositories/,
  );

  await assert.rejects(
    resolveGitHubRepository(
      "https://github.com/owner/repo",
      async () => new Response(null, { status: 403 }),
    ),
    /GitHub API rate limit reached/,
  );

  await assert.rejects(
    resolveGitHubRepository(
      "https://github.com/owner/missing",
      async () => new Response(null, { status: 404 }),
    ),
    /not found or private/,
  );
});

test("rejects a branch URL when none of its branch prefixes exist", async () => {
  await assert.rejects(
    resolveGitHubRepository(
      "https://github.com/owner/repo/tree/missing/src/file.ts",
      async (input) => {
        const url = String(input);
        return url.includes("/branches/")
          ? new Response(null, { status: 404 })
          : jsonResponse({
              id: 123,
              name: "repo",
              full_name: "owner/repo",
              html_url: "https://github.com/owner/repo",
              default_branch: "main",
              private: false,
            });
      },
    ),
    /requested branch could not be found/,
  );
});

function jsonResponse(value: unknown): Response {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}
