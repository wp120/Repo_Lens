import { prisma } from "../database/prisma.js";

export type RepositoryStructureMode =
  | "overview"
  | "list_directory"
  | "tree"
  | "search";

export interface RepositoryStructureQuery {
  mode: RepositoryStructureMode;
  path?: string;
  query?: string;
  offset?: number;
  limit?: number;
  depth?: number;
}

interface StructureEntry {
  name: string;
  path: string;
  type: "directory" | "file";
  children?: StructureEntry[];
  truncated?: boolean;
}

interface DirectoryNode {
  directories: Map<string, DirectoryNode>;
  files: Set<string>;
}

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 100;
const MAX_TREE_DEPTH = 5;

export async function lookupRepositoryStructure(
  branchIndexId: string,
  query: RepositoryStructureQuery,
): Promise<Record<string, unknown>> {
  const branch = await prisma.branchIndex.findUnique({
    where: { id: branchIndexId },
    select: {
      branchName: true,
      repositoryFilePaths: true,
      repository: { select: { owner: true, name: true } },
    },
  });

  if (!branch || branch.repositoryFilePaths === null) {
    return {
      status: "unavailable",
      message: "Repository structure is unavailable for this branch.",
    };
  }
  if (!Array.isArray(branch.repositoryFilePaths)) {
    throw new Error("Stored repository structure is not a file path list.");
  }
  const filePaths = branch.repositoryFilePaths.filter(
    (path): path is string => typeof path === "string",
  );
  if (filePaths.length !== branch.repositoryFilePaths.length) {
    throw new Error("Stored repository structure contains invalid paths.");
  }

  return formatRepositoryStructure(
    {
      repository: `${branch.repository.owner}/${branch.repository.name}`,
      branch: branch.branchName,
      filePaths,
    },
    query,
  );
}

export function formatRepositoryStructure(
  context: { repository: string; branch: string; filePaths: string[] },
  query: RepositoryStructureQuery,
): Record<string, unknown> {
  const limit = Math.min(MAX_LIMIT, Math.max(1, Math.floor(query.limit ?? DEFAULT_LIMIT)));
  const offset = Math.max(0, Math.floor(query.offset ?? 0));
  const tree = createDirectoryTree(context.filePaths);
  const directoryPath = query.mode === "overview"
    ? ""
    : normalizeDirectoryPath(query.path ?? "");
  const root = findDirectory(tree, directoryPath);
  const contextFields = {
    status: "available",
    repository: context.repository,
    branch: context.branch,
    fileCount: context.filePaths.length,
  };

  if (query.mode === "search") {
    const search = query.query?.trim().toLowerCase();
    if (!search) {
      return { status: "invalid_query", message: "A filename or path search query is required." };
    }
    const matches = context.filePaths
      .filter((path) => path.toLowerCase().includes(search))
      .sort((left, right) => left.localeCompare(right));
    const entries = matches.slice(offset, offset + limit).map((path) => ({
      name: path.slice(path.lastIndexOf("/") + 1),
      path,
      type: "file" as const,
    }));
    return {
      ...contextFields,
      mode: query.mode,
      query: query.query,
      entries,
      offset,
      limit,
      hasMore: offset + entries.length < matches.length,
      matchCount: matches.length,
    };
  }

  if (!root) {
    return {
      ...contextFields,
      status: "not_found",
      message: `Directory "${directoryPath}" was not found.`,
    };
  }

  if (query.mode === "overview") {
    const rootEntries = listDirectory(root, directoryPath);
    const entries = rootEntries.slice(offset, offset + limit);
    return {
      ...contextFields,
      mode: query.mode,
      rootEntryCount: rootEntries.length,
      entries,
      offset,
      limit,
      hasMore: offset + entries.length < rootEntries.length,
    };
  }

  const children = listDirectory(root, directoryPath);
  const entries = children.slice(offset, offset + limit);
  if (query.mode === "list_directory") {
    return {
      ...contextFields,
      mode: query.mode,
      path: directoryPath,
      entries,
      offset,
      limit,
      hasMore: offset + entries.length < children.length,
    };
  }

  const maxDepth = Math.min(
    MAX_TREE_DEPTH,
    Math.max(1, Math.floor(query.depth ?? 2)),
  );
  const budget = { remaining: Math.max(0, limit - entries.length) };
  const nestedEntries = entries.map((entry) => {
    if (entry.type !== "directory" || maxDepth <= 1) return entry;
    const childDirectory = findDirectory(tree, entry.path);
    if (!childDirectory) return entry;
    const expanded = expandDirectory(
      childDirectory,
      entry.path,
      maxDepth - 1,
      budget,
    );
    return {
      ...entry,
      children: expanded.entries,
      truncated: expanded.truncated,
    };
  });
  return {
    ...contextFields,
    mode: query.mode,
    path: directoryPath,
    depth: maxDepth,
    entries: nestedEntries,
    offset,
    limit,
    hasMore:
      offset + entries.length < children.length ||
      nestedEntries.some((entry) => entry.truncated === true),
  };
}

function createDirectoryTree(filePaths: string[]): DirectoryNode {
  const root: DirectoryNode = { directories: new Map(), files: new Set() };
  for (const filePath of filePaths) {
    const segments = filePath.split("/");
    let node = root;
    for (const segment of segments.slice(0, -1)) {
      let child = node.directories.get(segment);
      if (!child) {
        child = { directories: new Map(), files: new Set() };
        node.directories.set(segment, child);
      }
      node = child;
    }
    const fileName = segments.at(-1);
    if (fileName) node.files.add(fileName);
  }
  return root;
}

function findDirectory(root: DirectoryNode, path: string): DirectoryNode | undefined {
  if (!path) return root;
  let node: DirectoryNode | undefined = root;
  for (const segment of path.split("/")) {
    node = node?.directories.get(segment);
  }
  return node;
}

function listDirectory(node: DirectoryNode, path: string): StructureEntry[] {
  const entries: StructureEntry[] = [
    ...[...node.directories.keys()].map((name) => ({
      name,
      path: path ? `${path}/${name}` : name,
      type: "directory" as const,
    })),
    ...[...node.files].map((name) => ({
      name,
      path: path ? `${path}/${name}` : name,
      type: "file" as const,
    })),
  ];
  return entries.sort((left, right) => left.path.localeCompare(right.path));
}

function expandDirectory(
  node: DirectoryNode,
  path: string,
  depth: number,
  budget: { remaining: number },
): {
  entries: StructureEntry[];
  truncated: boolean;
} {
  const allChildren = listDirectory(node, path);
  const children = allChildren.slice(0, budget.remaining);
  budget.remaining -= children.length;
  let nestedTruncated = false;
  const entries = children.map((child) => {
    if (child.type !== "directory" || depth <= 1) {
      return child;
    }
    if (budget.remaining === 0) {
      nestedTruncated = true;
      return { ...child, truncated: true };
    }
    const directory = node.directories.get(child.name);
    if (!directory) return child;
    const expanded = expandDirectory(directory, child.path, depth - 1, budget);
    nestedTruncated ||= expanded.truncated;
    return {
      ...child,
      children: expanded.entries,
      truncated: expanded.truncated,
    };
  });
  return {
    entries,
    truncated: children.length < allChildren.length || nestedTruncated,
  };
}

function normalizeDirectoryPath(path: string): string {
  const normalized = path.trim().replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");
  if (normalized.split("/").some((segment) => segment === "." || segment === "..")) {
    return "\0";
  }
  return normalized;
}
