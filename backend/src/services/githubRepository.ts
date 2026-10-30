export interface ParsedGitHubUrl {
  owner: string;
  repository: string;
  branchSegments: string[] | null;
}

export interface GitHubRepositoryMetadata {
  githubRepoId: bigint;
  owner: string;
  name: string;
  htmlUrl: string;
  defaultBranch: string;
  branchName: string;
}

interface GitHubRepositoryResponse {
  id: number;
  name: string;
  full_name: string;
  html_url: string;
  default_branch: string;
  private: boolean;
}

export class GitHubRepositoryError extends Error {
  constructor(
    message: string,
    readonly statusCode: number,
  ) {
    super(message);
    this.name = "GitHubRepositoryError";
  }
}

export function parseGitHubRepositoryUrl(value: string): ParsedGitHubUrl {
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    throw new GitHubRepositoryError(
      "Enter a valid GitHub repository URL.",
      400,
    );
  }

  if (
    url.protocol !== "https:" ||
    url.hostname.toLowerCase() !== "github.com" ||
    url.port ||
    url.username ||
    url.password ||
    url.pathname.includes("//")
  ) {
    throw new GitHubRepositoryError("Use a secure URL from github.com.", 400);
  }

  const segments = url.pathname.split("/").filter(Boolean).map(decodeSegment);
  if (
    segments.length < 2 ||
    !isValidRepositorySegment(segments[0]) ||
    !isValidRepositorySegment(segments[1])
  ) {
    throw new GitHubRepositoryError(
      "Include the repository owner and repository name.",
      400,
    );
  }

  const owner = segments[0];
  const repository = segments[1].replace(/\.git$/i, "");
  if (!isValidRepositorySegment(repository)) {
    throw new GitHubRepositoryError(
      "The repository URL is not in a recognized format.",
      400,
    );
  }

  const remainder = segments.slice(2);
  if (remainder.length === 0) {
    return { owner, repository, branchSegments: null };
  }
  if (
    (remainder[0] !== "tree" && remainder[0] !== "blob") ||
    remainder.length < 2
  ) {
    throw new GitHubRepositoryError(
      "Use a repository URL or a GitHub branch/file URL.",
      400,
    );
  }
  if (remainder.length > 34) {
    throw new GitHubRepositoryError(
      "The GitHub branch URL contains too many path segments.",
      400,
    );
  }

  return {
    owner,
    repository,
    branchSegments: remainder.slice(1),
  };
}

export async function resolveGitHubRepository(
  value: string,
  fetcher: typeof fetch = fetch,
): Promise<GitHubRepositoryMetadata> {
  const parsed = parseGitHubRepositoryUrl(value);
  const apiRoot = `https://api.github.com/repos/${encodeURIComponent(parsed.owner)}/${encodeURIComponent(parsed.repository)}`;
  let repository: GitHubRepositoryResponse;
  try {
    repository = await getGitHubJson<GitHubRepositoryResponse>(
      apiRoot,
      fetcher,
    );
  } catch (error) {
    if (error instanceof GitHubRepositoryError && error.statusCode === 404) {
      throw new GitHubRepositoryError(
        "Repository not found or private. Only public GitHub repositories are supported right now.",
        404,
      );
    }
    throw error;
  }

  if (repository.private) {
    throw new GitHubRepositoryError(
      "Only public GitHub repositories are supported right now.",
      422,
    );
  }
  if (
    !Number.isSafeInteger(repository.id) ||
    !repository.name ||
    !repository.full_name ||
    repository.full_name.split("/").length !== 2 ||
    !repository.html_url ||
    !repository.default_branch ||
    typeof repository.private !== "boolean"
  ) {
    throw new GitHubRepositoryError(
      "GitHub returned incomplete repository metadata.",
      502,
    );
  }

  const branchName = parsed.branchSegments
    ? await resolveRequestedBranch(apiRoot, parsed.branchSegments, fetcher)
    : repository.default_branch;
  if (!branchName) {
    throw new GitHubRepositoryError(
      "GitHub did not report a default branch for this repository.",
      502,
    );
  }
  if (!parsed.branchSegments) {
    await getBranch(apiRoot, branchName, fetcher);
  }

  const [owner, name] = repository.full_name.split("/");
  return {
    githubRepoId: BigInt(repository.id),
    owner,
    name,
    htmlUrl: repository.html_url.replace(/\/+$/, ""),
    defaultBranch: repository.default_branch,
    branchName,
  };
}

async function resolveRequestedBranch(
  apiRoot: string,
  branchAndPath: string[],
  fetcher: typeof fetch,
): Promise<string> {
  for (let length = branchAndPath.length; length > 0; length -= 1) {
    const candidate = branchAndPath.slice(0, length).join("/");
    try {
      return await getBranch(apiRoot, candidate, fetcher);
    } catch (error) {
      if (error instanceof GitHubRepositoryError && error.statusCode === 404) {
        continue;
      }
      throw error;
    }
  }
  throw new GitHubRepositoryError(
    "The requested branch could not be found in this repository.",
    422,
  );
}

async function getBranch(
  apiRoot: string,
  branchName: string,
  fetcher: typeof fetch,
): Promise<string> {
  const branch = await getGitHubJson<{ name?: unknown }>(
    `${apiRoot}/branches/${encodeURIComponent(branchName)}`,
    fetcher,
  );
  if (typeof branch.name !== "string" || !branch.name) {
    throw new GitHubRepositoryError(
      "GitHub returned incomplete branch metadata.",
      502,
    );
  }
  return branch.name;
}

export async function getGitHubJson<T>(
  url: string,
  fetcher: typeof fetch,
): Promise<T> {
  let response: Response;
  try {
    const token = process.env.GITHUB_TOKEN;    
    
    const headers: Record<string, string> = {
      Accept: "application/vnd.github+json",
      "User-Agent": "RepoLens",
      "X-GitHub-Api-Version": "2022-11-28",
    };

    if (token) {
      headers["Authorization"] = `Bearer ${token}`;
    }

    response = await fetcher(url, {
      headers,
      signal: AbortSignal.timeout(10_000),
    });
  } catch {
    throw new GitHubRepositoryError(
      "Could not reach GitHub. Please try again.",
      503,
    );
  }

  if (response.status === 404) {
    throw new GitHubRepositoryError(
      "The repository or branch was not found.",
      404,
    );
  }
  if (response.status === 403 || response.status === 429) {
    throw new GitHubRepositoryError(
      "GitHub API rate limit reached. Please try again later.",
      503,
    );
  }
  if (!response.ok) {
    throw new GitHubRepositoryError(
      "GitHub could not verify this repository right now.",
      502,
    );
  }

  try {
    return (await response.json()) as T;
  } catch {
    throw new GitHubRepositoryError(
      "GitHub returned an invalid response.",
      502,
    );
  }
}

function decodeSegment(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    throw new GitHubRepositoryError("The GitHub URL is malformed.", 400);
  }
}

function isValidRepositorySegment(segment: string): boolean {
  return (
    /^[A-Za-z0-9_.-]+$/.test(segment) && segment !== "." && segment !== ".."
  );
}
