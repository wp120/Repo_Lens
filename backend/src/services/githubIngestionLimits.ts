import { ingestionLimits } from "../config/ingestionLimits.js";
import { getGitHubJson, GitHubRepositoryError } from "./githubRepository.js";

export const sourceExtensions = new Set([
  ".c",
  ".cc",
  ".cpp",
  ".cs",
  ".css",
  ".go",
  ".h",
  ".hpp",
  ".html",
  ".java",
  ".js",
  ".jsx",
  ".kt",
  ".md",
  ".php",
  ".py",
  ".rb",
  ".rs",
  ".scala",
  ".sh",
  ".sql",
  ".swift",
  ".ts",
  ".tsx",
  ".vue",
  ".xml",
  ".yaml",
  ".yml",
]);

export const EXCLUDED_DIRECTORIES = new Set([
  "node_modules",
  "vendor",
  ".git",
  ".svn",
  ".hg",
  ".next",
  ".nuxt",
  ".turbo",
  ".cache",
  "dist",
  "build",
  "out",
  "target",
  "bin",
  "obj",
  "coverage",
  ".idea",
  ".vscode",
  "venv",
  ".venv",
  "env",
  ".env",
  "__pycache__",
  ".pytest_cache",
  "Pods",
  "Carthage",
  ".gradle",
]);

const EXCLUDED_FILE_NAMES = new Set([
  "package-lock.json",
  "yarn.lock",
  "pnpm-lock.yaml",
  "composer.lock",
  "cargo.lock",
  "poetry.lock",
  "gemfile.lock",
  "go.sum",
  "mix.lock",
]);

const EXCLUDED_EXTENSIONS = new Set([
  ".exe",
  ".dll",
  ".so",
  ".dylib",
  ".bin",
  ".wasm",
  ".pyc",
  ".pyo",
  ".class",
  ".jar",
  ".war",
  ".png",
  ".jpg",
  ".jpeg",
  ".gif",
  ".ico",
  ".bmp",
  ".tiff",
  ".webp",
  ".svg",
  ".mp3",
  ".wav",
  ".ogg",
  ".mp4",
  ".mov",
  ".avi",
  ".mkv",
  ".webm",
  ".zip",
  ".tar",
  ".gz",
  ".tgz",
  ".bz2",
  ".7z",
  ".rar",
  ".woff",
  ".woff2",
  ".ttf",
  ".eot",
  ".otf",
  ".pdf",
  ".doc",
  ".docx",
  ".xls",
  ".xlsx",
  ".ppt",
  ".pptx",
  ".map",
]);

export interface RepositoryResponse {
  size?: unknown;
}

export interface BranchResponse {
  commit?: { sha?: unknown };
}

export interface TreeEntry {
  type?: unknown;
  path?: unknown;
  size?: unknown;
  sha?: unknown;
}

export interface TreeResponse {
  truncated?: unknown;
  tree?: unknown;
}

export interface BlobResponse {
  content?: unknown;
  encoding?: unknown;
  size?: unknown;
}

export interface GitHubIngestionLimits {
  repositorySizeKb: number;
  indexableFileCount: number;
  indexableSourceBytes: number;
  maxFileSizeBytes?: number;
}

export interface IndexableFileEntry {
  path: string;
  size: number;
  sha: string;
}

export function isIndexableSourceFile(path: string): boolean {
  const normalized = path.replace(/\\/g, "/");
  const segments = normalized.split("/").filter(Boolean);
  if (segments.length === 0) return false;

  for (let i = 0; i < segments.length - 1; i++) {
    if (EXCLUDED_DIRECTORIES.has(segments[i])) {
      return false;
    }
  }

  const fileName = segments[segments.length - 1];
  const fileNameLower = fileName.toLowerCase();

  if (EXCLUDED_FILE_NAMES.has(fileNameLower)) {
    return false;
  }

  if (
    fileNameLower.endsWith(".min.js") ||
    fileNameLower.endsWith(".min.css") ||
    fileNameLower.endsWith(".bundle.js") ||
    fileNameLower.endsWith(".bundle.css")
  ) {
    return false;
  }

  const extension = fileNameLower.includes(".")
    ? fileNameLower.slice(fileNameLower.lastIndexOf("."))
    : "";

  if (EXCLUDED_EXTENSIONS.has(extension)) {
    return false;
  }

  return sourceExtensions.has(extension);
}

export async function checkGitHubIngestionLimits(
  owner: string,
  repository: string,
  branchName: string,
  limits: GitHubIngestionLimits = ingestionLimits,
  fetcher: typeof fetch = fetch,
): Promise<void> {
  const apiRoot = `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repository)}`;
  const repositoryMetadata = await getGitHubJson<RepositoryResponse>(
    apiRoot,
    fetcher,
  );
  if (
    typeof repositoryMetadata.size !== "number" ||
    !Number.isSafeInteger(repositoryMetadata.size) ||
    repositoryMetadata.size < 0
  ) {
    throw new GitHubRepositoryError(
      "GitHub did not provide repository size information. Ingestion cannot be safely started.",
      502,
    );
  }
  if (repositoryMetadata.size > limits.repositorySizeKb) {
    throw new GitHubRepositoryError(
      "This repository exceeds the supported repository size limit.",
      413,
    );
  }

  const branch = await getGitHubJson<BranchResponse>(
    `${apiRoot}/branches/${encodeURIComponent(branchName)}`,
    fetcher,
  );
  const commitSha = branch.commit?.sha;
  if (typeof commitSha !== "string" || !/^[a-f0-9]{40}$/i.test(commitSha)) {
    throw new GitHubRepositoryError(
      "GitHub did not provide complete branch metadata. Ingestion cannot be safely started.",
      502,
    );
  }

  await fetchIndexableFiles(owner, repository, commitSha, limits, fetcher);
}

export async function fetchIndexableFiles(
  owner: string,
  repository: string,
  commitSha: string,
  limits: GitHubIngestionLimits = ingestionLimits,
  fetcher: typeof fetch = fetch,
): Promise<IndexableFileEntry[]> {
  const apiRoot = `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repository)}`;
  const maxFileBytes =
    limits.maxFileSizeBytes ?? ingestionLimits.maxFileSizeBytes;

  const treeResponse = await getGitHubJson<TreeResponse>(
    `${apiRoot}/git/trees/${encodeURIComponent(commitSha)}?recursive=1`,
    fetcher,
  );

  if (
    treeResponse.truncated === false &&
    Array.isArray(treeResponse.tree) &&
    treeResponse.tree.every(isTreeEntry)
  ) {
    const results: IndexableFileEntry[] = [];
    let fileCount = 0;
    let sourceBytes = 0;

    for (const entry of treeResponse.tree) {
      if (
        entry.type !== "blob" ||
        typeof entry.path !== "string" ||
        !isIndexableSourceFile(entry.path)
      ) {
        continue;
      }
      if (
        typeof entry.size !== "number" ||
        !Number.isSafeInteger(entry.size) ||
        entry.size < 0
      ) {
        throw new GitHubRepositoryError(
          "GitHub returned incomplete file-size information. Ingestion cannot be safely started.",
          503,
        );
      }
      if (entry.size > maxFileBytes) {
        throw new GitHubRepositoryError(
          "This repository contains files that exceed the supported individual file size limit.",
          413,
        );
      }
      fileCount += 1;
      sourceBytes += entry.size;
      if (
        fileCount > limits.indexableFileCount ||
        sourceBytes > limits.indexableSourceBytes
      ) {
        throw new GitHubRepositoryError(
          "This branch exceeds the supported file count or source size limit.",
          413,
        );
      }
      results.push({
        path: entry.path,
        size: entry.size,
        sha: typeof entry.sha === "string" ? entry.sha : "",
      });
    }
    return results;
  }

  // Fallback: non-recursive traversal when recursive tree is truncated or not provided
  try {
    return await traverseTreeNonRecursive(
      apiRoot,
      commitSha,
      limits,
      maxFileBytes,
      fetcher,
    );
  } catch (error) {
    if (
      error instanceof GitHubRepositoryError &&
      (error.statusCode === 413 ||
        error.statusCode === 400 ||
        error.statusCode === 404 ||
        error.statusCode === 422)
    ) {
      throw error;
    }
    throw new GitHubRepositoryError(
      "GitHub returned an incomplete branch file listing. Ingestion cannot be safely started.",
      503,
    );
  }
}

async function traverseTreeNonRecursive(
  apiRoot: string,
  rootSha: string,
  limits: GitHubIngestionLimits,
  maxFileBytes: number,
  fetcher: typeof fetch,
): Promise<IndexableFileEntry[]> {
  const queue: Array<{ sha: string; prefix: string }> = [
    { sha: rootSha, prefix: "" },
  ];
  const results: IndexableFileEntry[] = [];
  const visitedTrees = new Set<string>();
  let fileCount = 0;
  let sourceBytes = 0;

  while (queue.length > 0) {
    const current = queue.shift()!;
    if (visitedTrees.has(current.sha)) continue;
    visitedTrees.add(current.sha);

    const response = await getGitHubJson<TreeResponse>(
      `${apiRoot}/git/trees/${encodeURIComponent(current.sha)}`,
      fetcher,
    );

    if (
      response.truncated === true ||
      !Array.isArray(response.tree) ||
      !response.tree.every(isTreeEntry)
    ) {
      throw new GitHubRepositoryError(
        "GitHub returned an incomplete branch file listing. Ingestion cannot be safely started.",
        503,
      );
    }

    for (const entry of response.tree) {
      if (typeof entry.path !== "string") continue;
      const fullPath = current.prefix
        ? `${current.prefix}/${entry.path}`
        : entry.path;

      if (entry.type === "tree") {
        if (EXCLUDED_DIRECTORIES.has(entry.path)) {
          continue;
        }
        if (typeof entry.sha === "string" && entry.sha) {
          queue.push({ sha: entry.sha, prefix: fullPath });
        }
      } else if (entry.type === "blob") {
        if (!isIndexableSourceFile(fullPath)) {
          continue;
        }
        if (
          typeof entry.size !== "number" ||
          !Number.isSafeInteger(entry.size) ||
          entry.size < 0
        ) {
          throw new GitHubRepositoryError(
            "GitHub returned incomplete file-size information. Ingestion cannot be safely started.",
            503,
          );
        }
        if (entry.size > maxFileBytes) {
          throw new GitHubRepositoryError(
            "This repository contains files that exceed the supported individual file size limit.",
            413,
          );
        }
        fileCount += 1;
        sourceBytes += entry.size;
        if (
          fileCount > limits.indexableFileCount ||
          sourceBytes > limits.indexableSourceBytes
        ) {
          throw new GitHubRepositoryError(
            "This branch exceeds the supported file count or source size limit.",
            413,
          );
        }
        results.push({
          path: fullPath,
          size: entry.size,
          sha: typeof entry.sha === "string" ? entry.sha : "",
        });
      }
    }
  }

  return results;
}

export async function fetchBlobContent(
  owner: string,
  repository: string,
  blobSha: string,
  fetcher: typeof fetch = fetch,
): Promise<string> {
  const apiRoot = `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repository)}`;
  const blob = await getGitHubJson<BlobResponse>(
    `${apiRoot}/git/blobs/${encodeURIComponent(blobSha)}`,
    fetcher,
  );

  if (typeof blob.content !== "string") {
    throw new GitHubRepositoryError(
      "GitHub returned invalid blob content.",
      502,
    );
  }

  if (blob.encoding === "base64") {
    const raw = Buffer.from(blob.content, "base64").toString("utf8");
    return raw;
  }

  return blob.content;
}

function isTreeEntry(entry: unknown): entry is TreeEntry {
  return typeof entry === "object" && entry !== null;
}
