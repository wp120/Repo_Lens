import { ingestionLimits } from "../config/ingestionLimits.js";
import { getGitHubJson, GitHubRepositoryError } from "./githubRepository.js";

const sourceExtensions = new Set([
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

interface RepositoryResponse {
  size?: unknown;
}

interface BranchResponse {
  commit?: { sha?: unknown };
}

interface TreeEntry {
  type?: unknown;
  path?: unknown;
  size?: unknown;
}

interface TreeResponse {
  truncated?: unknown;
  tree?: unknown;
}

export interface GitHubIngestionLimits {
  repositorySizeKb: number;
  indexableFileCount: number;
  indexableSourceBytes: number;
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

  const treeResponse = await getGitHubJson<TreeResponse>(
    `${apiRoot}/git/trees/${encodeURIComponent(commitSha)}?recursive=1`,
    fetcher,
  );
  if (
    treeResponse.truncated !== false ||
    !Array.isArray(treeResponse.tree) ||
    !treeResponse.tree.every(isTreeEntry)
  ) {
    throw new GitHubRepositoryError(
      "GitHub returned an incomplete branch file listing. Ingestion cannot be safely started.",
      503,
    );
  }

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
  }
}

function isTreeEntry(entry: unknown): entry is TreeEntry {
  return typeof entry === "object" && entry !== null;
}

function isIndexableSourceFile(path: string): boolean {
  const fileName = path.slice(path.lastIndexOf("/") + 1);
  const extension = fileName.includes(".")
    ? fileName.slice(fileName.lastIndexOf(".")).toLowerCase()
    : "";
  return sourceExtensions.has(extension);
}
