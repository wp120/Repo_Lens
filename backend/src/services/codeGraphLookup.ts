import { prisma } from "../database/prisma.js";

export type CodeGraphLookupMode =
  | "symbol_lookup"
  | "find_callers"
  | "find_callees"
  | "class_dependencies"
  | "execution_path";

export type GraphSymbolKind = "function" | "method" | "class" | "interface";

export interface CodeGraphLookupQuery {
  mode: CodeGraphLookupMode;
  symbolId?: string;
  symbolName?: string;
  qualifiedName?: string;
  filePath?: string;
  containerName?: string;
  kind?: GraphSymbolKind;
  targetSymbolId?: string;
  targetSymbolName?: string;
  targetQualifiedName?: string;
  targetFilePath?: string;
  direction?: "outgoing" | "incoming";
  maxDepth?: number;
  limit?: number;
}

export interface GraphLookupOptions {
  userId?: string;
}

export interface GraphSymbolSummary {
  id: string;
  name: string;
  qualifiedName: string;
  kind: string;
  language: string;
  filePath: string;
  startLine: number;
  endLine: number;
  containerName: string | null;
  signature: string | null;
}

export interface GraphRelationshipSummary {
  id: string;
  type: string;
  filePath: string;
  startLine: number;
  endLine: number;
  referenceName: string;
  targetModule: string | null;
  isResolved: boolean;
  resolutionError: string | null;
  fromSymbol: GraphSymbolSummary | null;
  toSymbol: GraphSymbolSummary | null;
}

export interface UnresolvedGraphReference {
  relationshipId: string;
  type: string;
  filePath: string;
  startLine: number;
  endLine: number;
  referenceName: string;
  targetModule: string | null;
  isResolved: false;
  resolutionError: string | null;
}

export interface ExecutionPathHop {
  step: number;
  relationshipId: string;
  type: string;
  filePath: string;
  startLine: number;
  endLine: number;
  referenceName: string;
  fromSymbol: GraphSymbolSummary;
  toSymbol: GraphSymbolSummary;
}

export interface ExecutionPathTrace {
  depth: number;
  reachesTarget?: boolean;
  summary: string;
  hops: ExecutionPathHop[];
}

export interface PersistedGraphSymbol {
  id: string;
  branchIndexId: string;
  filePath: string;
  name: string;
  kind: string;
  language: string;
  startLine: number;
  endLine: number;
  containerName: string | null;
  signature: string | null;
  commitSha: string;
  ingestionAttempt: number;
  isActive: boolean;
}

export interface PersistedGraphRelationship {
  id: string;
  branchIndexId: string;
  fromSymbolId: string | null;
  toSymbolId: string | null;
  type: string;
  filePath: string;
  startLine: number;
  endLine: number;
  referenceName: string;
  targetModule: string | null;
  isResolved: boolean;
  resolutionError: string | null;
  commitSha: string;
  ingestionAttempt: number;
  isActive: boolean;
}

export interface PublishedGraphSnapshot {
  branchIndexId: string;
  branchName: string;
  status: string;
  commitSha: string | null;
  graphStatus: string;
}

export interface GraphSnapshotRef {
  branchIndexId: string;
  commitSha: string;
}

export interface SymbolSearchCriteria {
  symbolId?: string;
  name?: string;
  rawName?: string;
  containerName?: string;
  parsedContainerFromQualified?: boolean;
  filePath?: string;
  kind?: string;
}

export interface RelationshipSearchCriteria {
  types?: string[];
  fromSymbolId?: string;
  fromSymbolIds?: string[];
  toSymbolId?: string;
  toSymbolIds?: string[];
  filePath?: string;
  isResolved?: boolean;
}

export interface CodeGraphReader {
  hasBranchAccess(userId: string, branchIndexId: string): Promise<boolean>;
  getPublishedSnapshot(
    branchIndexId: string,
  ): Promise<PublishedGraphSnapshot | null>;
  findActiveSymbols(
    snapshot: GraphSnapshotRef,
    criteria: SymbolSearchCriteria,
    limit: number,
  ): Promise<{ symbols: PersistedGraphSymbol[]; totalMatches: number }>;
  findActiveSymbolsByIds(
    snapshot: GraphSnapshotRef,
    ids: string[],
  ): Promise<PersistedGraphSymbol[]>;
  findActiveRelationships(
    snapshot: GraphSnapshotRef,
    criteria: RelationshipSearchCriteria,
    limit: number,
  ): Promise<{
    relationships: PersistedGraphRelationship[];
    totalMatches: number;
  }>;
}

export const GRAPH_LOOKUP_LIMITS = {
  defaultSymbolsLimit: 20,
  maxSymbolsLimit: 50,
  defaultRelationshipsLimit: 25,
  maxRelationshipsLimit: 50,
  defaultExecutionDepth: 4,
  maxExecutionDepth: 6,
  defaultMaxNodesExplored: 30,
  maxNodesExplored: 50,
  maxExecutionPaths: 20,
  maxEdgesPerFrontier: 200,
} as const;

export class GraphAuthorizationError extends Error {
  constructor(
    message = "You do not have access to this branch.",
    readonly statusCode = 403,
  ) {
    super(message);
    this.name = "GraphAuthorizationError";
  }
}

const UUID_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isUuid(value: string | undefined): value is string {
  return Boolean(value && UUID_REGEX.test(value));
}

function normalizeFilePath(rawPath: string | undefined): string | undefined {
  const trimmed = rawPath?.trim();
  if (!trimmed) return undefined;
  return trimmed.replace(/\\/g, "/").replace(/^\.\//, "").replace(/^\/+/, "");
}

function formatQualifiedName(symbol: {
  name: string;
  containerName: string | null;
}): string {
  return symbol.containerName
    ? `${symbol.containerName}.${symbol.name}`
    : symbol.name;
}

export function toGraphSymbolSummary(
  symbol: PersistedGraphSymbol,
): GraphSymbolSummary {
  return {
    id: symbol.id,
    name: symbol.name,
    qualifiedName: formatQualifiedName(symbol),
    kind: symbol.kind,
    language: symbol.language,
    filePath: symbol.filePath,
    startLine: symbol.startLine,
    endLine: symbol.endLine,
    containerName: symbol.containerName,
    signature: symbol.signature,
  };
}

function toUnresolvedReference(
  rel: PersistedGraphRelationship,
): UnresolvedGraphReference {
  return {
    relationshipId: rel.id,
    type: rel.type,
    filePath: rel.filePath,
    startLine: rel.startLine,
    endLine: rel.endLine,
    referenceName: rel.referenceName,
    targetModule: rel.targetModule,
    isResolved: false,
    resolutionError: rel.resolutionError,
  };
}

function parseSymbolNameCriteria(input: {
  symbolId?: string;
  symbolName?: string;
  qualifiedName?: string;
  containerName?: string;
  filePath?: string;
  kind?: string;
}): SymbolSearchCriteria {
  const symbolId = input.symbolId?.trim() || undefined;
  const containerName = input.containerName?.trim() || undefined;
  let filePath = normalizeFilePath(input.filePath);
  const kind = input.kind?.trim() || undefined;

  let rawName =
    input.qualifiedName?.trim() || input.symbolName?.trim() || undefined;

  // Handle optional "<filePath>:<Class>.<method>" prefix if present
  if (rawName && !filePath) {
    const colonIdx = rawName.indexOf(":");
    if (colonIdx > 0 && rawName[colonIdx + 1] !== ":") {
      const possiblePath = rawName.slice(0, colonIdx);
      if (possiblePath.includes("/") || possiblePath.includes(".")) {
        filePath = normalizeFilePath(possiblePath);
        rawName = rawName.slice(colonIdx + 1).trim() || undefined;
      }
    }
  }

  if (!rawName) {
    return { symbolId, containerName, filePath, kind };
  }

  if (containerName) {
    return {
      symbolId,
      name: rawName,
      rawName,
      containerName,
      filePath,
      kind,
    };
  }

  for (const sep of [".", "::", "#"]) {
    const sepIdx = rawName.lastIndexOf(sep);
    if (sepIdx > 0 && sepIdx < rawName.length - sep.length) {
      const prefix = rawName.slice(0, sepIdx).trim();
      const member = rawName.slice(sepIdx + sep.length).trim();
      if (prefix && member) {
        return {
          symbolId,
          name: member,
          rawName,
          containerName: prefix,
          parsedContainerFromQualified: true,
          filePath,
          kind,
        };
      }
    }
  }

  return {
    symbolId,
    name: rawName,
    rawName,
    filePath,
    kind,
  };
}

function buildPrismaSymbolWhere(
  snapshot: GraphSnapshotRef,
  criteria: SymbolSearchCriteria,
) {
  const andConditions: Record<string, unknown>[] = [
    { branchIndexId: snapshot.branchIndexId },
    { isActive: true },
    { commitSha: snapshot.commitSha },
  ];

  if (criteria.symbolId) {
    andConditions.push({ id: criteria.symbolId });
  }
  if (criteria.filePath) {
    andConditions.push({ filePath: criteria.filePath });
  }
  if (criteria.kind) {
    andConditions.push({ kind: criteria.kind });
  }

  if (criteria.name) {
    if (criteria.containerName && criteria.parsedContainerFromQualified) {
      andConditions.push({
        OR: [
          {
            name: criteria.name,
            containerName: criteria.containerName,
          },
          ...(criteria.rawName ? [{ name: criteria.rawName }] : []),
        ],
      });
    } else if (criteria.containerName) {
      andConditions.push({
        name: criteria.name,
        containerName: criteria.containerName,
      });
    } else {
      andConditions.push({ name: criteria.name });
    }
  } else if (criteria.containerName) {
    andConditions.push({ containerName: criteria.containerName });
  }

  return { AND: andConditions };
}

function buildPrismaRelationshipWhere(
  snapshot: GraphSnapshotRef,
  criteria: RelationshipSearchCriteria,
) {
  const where: Record<string, unknown> = {
    branchIndexId: snapshot.branchIndexId,
    isActive: true,
    commitSha: snapshot.commitSha,
  };

  if (criteria.types && criteria.types.length > 0) {
    where.type =
      criteria.types.length === 1 ? criteria.types[0] : { in: criteria.types };
  }
  if (criteria.fromSymbolId) {
    where.fromSymbolId = criteria.fromSymbolId;
  } else if (criteria.fromSymbolIds && criteria.fromSymbolIds.length > 0) {
    where.fromSymbolId = { in: criteria.fromSymbolIds };
  }
  if (criteria.toSymbolId) {
    where.toSymbolId = criteria.toSymbolId;
  } else if (criteria.toSymbolIds && criteria.toSymbolIds.length > 0) {
    where.toSymbolId = { in: criteria.toSymbolIds };
  }
  if (criteria.filePath) {
    where.filePath = criteria.filePath;
  }
  if (criteria.isResolved !== undefined) {
    where.isResolved = criteria.isResolved;
  }

  return where;
}

const symbolSelectFields = {
  id: true,
  branchIndexId: true,
  filePath: true,
  name: true,
  kind: true,
  language: true,
  startLine: true,
  endLine: true,
  containerName: true,
  signature: true,
  commitSha: true,
  ingestionAttempt: true,
  isActive: true,
} as const;

const relationshipSelectFields = {
  id: true,
  branchIndexId: true,
  fromSymbolId: true,
  toSymbolId: true,
  type: true,
  filePath: true,
  startLine: true,
  endLine: true,
  referenceName: true,
  targetModule: true,
  isResolved: true,
  resolutionError: true,
  commitSha: true,
  ingestionAttempt: true,
  isActive: true,
} as const;

/**
 * Default PostgreSQL/Prisma implementation of CodeGraphReader.
 * Every query strictly filters by branchIndexId, isActive = true, and the
 * branch's publishedCommitSha to guarantee snapshot and branch isolation.
 */
export const prismaCodeGraphReader: CodeGraphReader = {
  async hasBranchAccess(
    userId: string,
    branchIndexId: string,
  ): Promise<boolean> {
    if (!isUuid(userId) || !isUuid(branchIndexId)) {
      return false;
    }
    const access = await prisma.userBranchAccess.findUnique({
      where: {
        userId_branchIndexId: { userId, branchIndexId },
      },
      select: { userId: true },
    });
    return access !== null;
  },

  async getPublishedSnapshot(
    branchIndexId: string,
  ): Promise<PublishedGraphSnapshot | null> {
    if (!isUuid(branchIndexId)) {
      return null;
    }
    const branch = await prisma.branchIndex.findUnique({
      where: { id: branchIndexId },
      select: {
        id: true,
        branchName: true,
        status: true,
        publishedCommitSha: true,
        graphStatus: true,
      },
    });
    if (!branch) return null;
    return {
      branchIndexId: branch.id,
      branchName: branch.branchName,
      status: branch.status,
      commitSha: branch.publishedCommitSha,
      graphStatus: branch.graphStatus,
    };
  },

  async findActiveSymbols(
    snapshot: GraphSnapshotRef,
    criteria: SymbolSearchCriteria,
    limit: number,
  ): Promise<{ symbols: PersistedGraphSymbol[]; totalMatches: number }> {
    if (!isUuid(snapshot.branchIndexId)) {
      return { symbols: [], totalMatches: 0 };
    }
    if (criteria.symbolId && !isUuid(criteria.symbolId)) {
      return { symbols: [], totalMatches: 0 };
    }

    const where = buildPrismaSymbolWhere(snapshot, criteria);
    const [symbols, totalMatches] = await Promise.all([
      prisma.codeSymbol.findMany({
        where,
        select: symbolSelectFields,
        orderBy: [
          { filePath: "asc" },
          { startLine: "asc" },
          { name: "asc" },
          { id: "asc" },
        ],
        take: limit,
      }),
      prisma.codeSymbol.count({ where }),
    ]);

    return { symbols, totalMatches };
  },

  async findActiveSymbolsByIds(
    snapshot: GraphSnapshotRef,
    ids: string[],
  ): Promise<PersistedGraphSymbol[]> {
    if (!isUuid(snapshot.branchIndexId)) return [];
    const validIds = [...new Set(ids.filter((id) => isUuid(id)))];
    if (validIds.length === 0) return [];

    return prisma.codeSymbol.findMany({
      where: {
        id: { in: validIds },
        branchIndexId: snapshot.branchIndexId,
        isActive: true,
        commitSha: snapshot.commitSha,
      },
      select: symbolSelectFields,
      orderBy: [{ filePath: "asc" }, { startLine: "asc" }, { id: "asc" }],
    });
  },

  async findActiveRelationships(
    snapshot: GraphSnapshotRef,
    criteria: RelationshipSearchCriteria,
    limit: number,
  ): Promise<{
    relationships: PersistedGraphRelationship[];
    totalMatches: number;
  }> {
    if (!isUuid(snapshot.branchIndexId)) {
      return { relationships: [], totalMatches: 0 };
    }
    if (criteria.fromSymbolId && !isUuid(criteria.fromSymbolId)) {
      return { relationships: [], totalMatches: 0 };
    }
    if (criteria.toSymbolId && !isUuid(criteria.toSymbolId)) {
      return { relationships: [], totalMatches: 0 };
    }
    if (criteria.fromSymbolIds) {
      const valid = criteria.fromSymbolIds.filter((id) => isUuid(id));
      if (valid.length === 0) return { relationships: [], totalMatches: 0 };
      criteria = { ...criteria, fromSymbolIds: valid };
    }
    if (criteria.toSymbolIds) {
      const valid = criteria.toSymbolIds.filter((id) => isUuid(id));
      if (valid.length === 0) return { relationships: [], totalMatches: 0 };
      criteria = { ...criteria, toSymbolIds: valid };
    }

    const where = buildPrismaRelationshipWhere(snapshot, criteria);
    const [relationships, totalMatches] = await Promise.all([
      prisma.codeRelationship.findMany({
        where,
        select: relationshipSelectFields,
        orderBy: [{ filePath: "asc" }, { startLine: "asc" }, { id: "asc" }],
        take: limit,
      }),
      prisma.codeRelationship.count({ where }),
    ]);

    return { relationships, totalMatches };
  },
};

type ResolvedTargetResult =
  | { ok: true; symbol: PersistedGraphSymbol }
  | { ok: false; response: Record<string, unknown> };

async function resolveTargetSymbol(
  reader: CodeGraphReader,
  snapshot: GraphSnapshotRef,
  mode: CodeGraphLookupMode,
  input: {
    symbolId?: string;
    symbolName?: string;
    qualifiedName?: string;
    containerName?: string;
    filePath?: string;
    kind?: string;
  },
  candidateLimit: number,
  roleLabel = "symbol",
): Promise<ResolvedTargetResult> {
  const criteria = parseSymbolNameCriteria(input);
  if (
    !criteria.symbolId &&
    !criteria.name &&
    !criteria.containerName &&
    !criteria.filePath
  ) {
    return {
      ok: false,
      response: {
        status: "invalid_query",
        mode,
        message: `Provide ${roleLabel}Id, ${roleLabel}Name, or qualifiedName to identify the ${roleLabel}.`,
      },
    };
  }

  const { symbols, totalMatches } = await reader.findActiveSymbols(
    snapshot,
    criteria,
    candidateLimit,
  );

  if (totalMatches === 0 || symbols.length === 0) {
    return {
      ok: false,
      response: {
        status: "not_found",
        mode,
        branchIndexId: snapshot.branchIndexId,
        commitSha: snapshot.commitSha,
        message: `No active ${roleLabel} matched the provided criteria in the published graph snapshot.`,
      },
    };
  }

  if (totalMatches > 1 || symbols.length > 1) {
    return {
      ok: false,
      response: {
        status: "ambiguous",
        mode,
        branchIndexId: snapshot.branchIndexId,
        commitSha: snapshot.commitSha,
        message: `Multiple active ${roleLabel}s (${totalMatches}) matched. Do not guess; narrow with ${roleLabel}Id or filePath/containerName.`,
        totalMatches,
        truncated: totalMatches > symbols.length,
        candidateSymbols: symbols.map(toGraphSymbolSummary),
      },
    };
  }

  return { ok: true, symbol: symbols[0] };
}

function capSymbolsLimit(limit?: number): number {
  return Math.min(
    GRAPH_LOOKUP_LIMITS.maxSymbolsLimit,
    Math.max(1, Math.floor(limit ?? GRAPH_LOOKUP_LIMITS.defaultSymbolsLimit)),
  );
}

function capRelationshipsLimit(limit?: number): number {
  return Math.min(
    GRAPH_LOOKUP_LIMITS.maxRelationshipsLimit,
    Math.max(
      1,
      Math.floor(limit ?? GRAPH_LOOKUP_LIMITS.defaultRelationshipsLimit),
    ),
  );
}

/**
 * Look up symbols, callers, callees, class dependencies, or cross-file execution
 * paths from the currently active, published code graph snapshot for an authorized branch.
 */
export async function lookupCodeRelationships(
  branchIndexId: string,
  query: CodeGraphLookupQuery,
  options: GraphLookupOptions = {},
  reader: CodeGraphReader = prismaCodeGraphReader,
): Promise<Record<string, unknown>> {
  const normalizedBranchId = branchIndexId?.trim();
  if (!normalizedBranchId) {
    return {
      status: "invalid_query",
      message: "A valid branchIndexId is required.",
    };
  }

  if (options.userId !== undefined) {
    const allowed = await reader.hasBranchAccess(
      options.userId,
      normalizedBranchId,
    );
    if (!allowed) {
      throw new GraphAuthorizationError();
    }
  }

  const published = await reader.getPublishedSnapshot(normalizedBranchId);
  if (!published || !published.commitSha) {
    return {
      status: "unavailable",
      mode: query.mode,
      branchIndexId: normalizedBranchId,
      message: "No published code graph snapshot is available for this branch.",
    };
  }

  const snapshot: GraphSnapshotRef = {
    branchIndexId: published.branchIndexId,
    commitSha: published.commitSha,
  };

  switch (query.mode) {
    case "symbol_lookup":
      return handleSymbolLookup(reader, snapshot, query);
    case "find_callers":
      return handleFindCallers(reader, snapshot, query);
    case "find_callees":
      return handleFindCallees(reader, snapshot, query);
    case "class_dependencies":
      return handleClassDependencies(reader, snapshot, query);
    case "execution_path":
      return handleExecutionPath(reader, snapshot, query);
    default:
      return {
        status: "invalid_query",
        message: "Unsupported graph lookup mode.",
      };
  }
}

async function handleSymbolLookup(
  reader: CodeGraphReader,
  snapshot: GraphSnapshotRef,
  query: CodeGraphLookupQuery,
): Promise<Record<string, unknown>> {
  const criteria = parseSymbolNameCriteria(query);
  if (
    !criteria.symbolId &&
    !criteria.name &&
    !criteria.containerName &&
    !criteria.filePath
  ) {
    return {
      status: "invalid_query",
      mode: "symbol_lookup",
      message:
        "Provide symbolId, symbolName, qualifiedName, filePath, or containerName to search symbols.",
    };
  }

  const limit = capSymbolsLimit(query.limit);
  const { symbols, totalMatches } = await reader.findActiveSymbols(
    snapshot,
    criteria,
    limit,
  );

  if (totalMatches === 0 || symbols.length === 0) {
    return {
      status: "not_found",
      mode: "symbol_lookup",
      branchIndexId: snapshot.branchIndexId,
      commitSha: snapshot.commitSha,
      totalMatches: 0,
      returnedCount: 0,
      isAmbiguous: false,
      truncated: false,
      symbols: [],
      message:
        "No active symbols matched the search criteria in the published graph snapshot.",
    };
  }

  const isAmbiguous = totalMatches > 1 && !criteria.symbolId;
  return {
    status: "ok",
    mode: "symbol_lookup",
    branchIndexId: snapshot.branchIndexId,
    commitSha: snapshot.commitSha,
    totalMatches,
    returnedCount: symbols.length,
    isAmbiguous,
    truncated: totalMatches > symbols.length,
    symbols: symbols.map(toGraphSymbolSummary),
    ...(isAmbiguous
      ? {
          message:
            "Multiple active symbols matched. Pass a specific symbolId or filePath to subsequent relationship queries.",
        }
      : {}),
  };
}

async function handleFindCallers(
  reader: CodeGraphReader,
  snapshot: GraphSnapshotRef,
  query: CodeGraphLookupQuery,
): Promise<Record<string, unknown>> {
  const symbolLimit = capSymbolsLimit(query.limit);
  const target = await resolveTargetSymbol(
    reader,
    snapshot,
    "find_callers",
    query,
    symbolLimit,
  );
  if (!target.ok) return target.response;

  const limit = capRelationshipsLimit(query.limit);
  const { relationships, totalMatches } = await reader.findActiveRelationships(
    snapshot,
    {
      types: ["CALL"],
      toSymbolId: target.symbol.id,
      isResolved: true,
    },
    limit,
  );

  const callerIds = relationships
    .map((r) => r.fromSymbolId)
    .filter((id): id is string => Boolean(id));
  const callerSymbols = await reader.findActiveSymbolsByIds(
    snapshot,
    callerIds,
  );
  const callerMap = new Map(callerSymbols.map((s) => [s.id, s]));
  const targetSummary = toGraphSymbolSummary(target.symbol);

  const callers: GraphRelationshipSummary[] = relationships.map((rel) => {
    const callerSym = rel.fromSymbolId
      ? callerMap.get(rel.fromSymbolId)
      : undefined;
    return {
      id: rel.id,
      type: rel.type,
      filePath: rel.filePath,
      startLine: rel.startLine,
      endLine: rel.endLine,
      referenceName: rel.referenceName,
      targetModule: rel.targetModule,
      isResolved: true,
      resolutionError: null,
      fromSymbol: callerSym ? toGraphSymbolSummary(callerSym) : null,
      toSymbol: targetSummary,
    };
  });

  return {
    status: "ok",
    mode: "find_callers",
    branchIndexId: snapshot.branchIndexId,
    commitSha: snapshot.commitSha,
    symbol: targetSummary,
    totalCallers: totalMatches,
    returnedCount: callers.length,
    truncated: totalMatches > callers.length,
    callers,
  };
}

async function handleFindCallees(
  reader: CodeGraphReader,
  snapshot: GraphSnapshotRef,
  query: CodeGraphLookupQuery,
): Promise<Record<string, unknown>> {
  const symbolLimit = capSymbolsLimit(query.limit);
  const source = await resolveTargetSymbol(
    reader,
    snapshot,
    "find_callees",
    query,
    symbolLimit,
  );
  if (!source.ok) return source.response;

  const limit = capRelationshipsLimit(query.limit);
  const [resolvedRes, unresolvedRes] = await Promise.all([
    reader.findActiveRelationships(
      snapshot,
      {
        types: ["CALL"],
        fromSymbolId: source.symbol.id,
        isResolved: true,
      },
      limit,
    ),
    reader.findActiveRelationships(
      snapshot,
      {
        types: ["CALL"],
        fromSymbolId: source.symbol.id,
        isResolved: false,
      },
      limit,
    ),
  ]);

  const calleeIds = resolvedRes.relationships
    .map((r) => r.toSymbolId)
    .filter((id): id is string => Boolean(id));
  const calleeSymbols = await reader.findActiveSymbolsByIds(
    snapshot,
    calleeIds,
  );
  const calleeMap = new Map(calleeSymbols.map((s) => [s.id, s]));
  const sourceSummary = toGraphSymbolSummary(source.symbol);

  const callees: GraphRelationshipSummary[] = [];
  for (const rel of resolvedRes.relationships) {
    if (!rel.toSymbolId) continue;
    const targetSym = calleeMap.get(rel.toSymbolId);
    if (!targetSym) continue;
    callees.push({
      id: rel.id,
      type: rel.type,
      filePath: rel.filePath,
      startLine: rel.startLine,
      endLine: rel.endLine,
      referenceName: rel.referenceName,
      targetModule: rel.targetModule,
      isResolved: true,
      resolutionError: null,
      fromSymbol: sourceSummary,
      toSymbol: toGraphSymbolSummary(targetSym),
    });
  }

  return {
    status: "ok",
    mode: "find_callees",
    branchIndexId: snapshot.branchIndexId,
    commitSha: snapshot.commitSha,
    symbol: sourceSummary,
    totalCallees: resolvedRes.totalMatches,
    returnedCount: callees.length,
    truncated: resolvedRes.totalMatches > callees.length,
    callees,
    unresolvedCount: unresolvedRes.totalMatches,
    unresolvedReferences: unresolvedRes.relationships.map(
      toUnresolvedReference,
    ),
  };
}

async function handleClassDependencies(
  reader: CodeGraphReader,
  snapshot: GraphSnapshotRef,
  query: CodeGraphLookupQuery,
): Promise<Record<string, unknown>> {
  const symbolLimit = capSymbolsLimit(query.limit);
  const target = await resolveTargetSymbol(
    reader,
    snapshot,
    "class_dependencies",
    query,
    symbolLimit,
  );
  if (!target.ok) return target.response;

  const relLimit = capRelationshipsLimit(query.limit);
  const targetSymbol = target.symbol;
  const targetSummary = toGraphSymbolSummary(targetSymbol);

  const [
    outgoingResolved,
    outgoingUnresolved,
    incomingResolved,
    methodsRes,
    fileImportsRes,
  ] = await Promise.all([
    reader.findActiveRelationships(
      snapshot,
      {
        types: ["INHERITS", "IMPLEMENTS"],
        fromSymbolId: targetSymbol.id,
        isResolved: true,
      },
      relLimit,
    ),
    reader.findActiveRelationships(
      snapshot,
      {
        types: ["INHERITS", "IMPLEMENTS"],
        fromSymbolId: targetSymbol.id,
        isResolved: false,
      },
      relLimit,
    ),
    reader.findActiveRelationships(
      snapshot,
      {
        types: ["INHERITS", "IMPLEMENTS"],
        toSymbolId: targetSymbol.id,
        isResolved: true,
      },
      relLimit,
    ),
    reader.findActiveSymbols(
      snapshot,
      {
        filePath: targetSymbol.filePath,
        containerName: targetSymbol.name,
      },
      symbolLimit,
    ),
    reader.findActiveRelationships(
      snapshot,
      {
        types: ["IMPORT"],
        filePath: targetSymbol.filePath,
        isResolved: true,
      },
      relLimit,
    ),
  ]);

  const relatedSymbolIds = [
    ...outgoingResolved.relationships.map((r) => r.toSymbolId),
    ...incomingResolved.relationships.map((r) => r.fromSymbolId),
    ...fileImportsRes.relationships.map((r) => r.toSymbolId),
  ].filter((id): id is string => Boolean(id));

  const relatedSymbols = await reader.findActiveSymbolsByIds(
    snapshot,
    relatedSymbolIds,
  );
  const symbolMap = new Map(relatedSymbols.map((s) => [s.id, s]));

  const buildEdgeList = (
    rels: PersistedGraphRelationship[],
    type: "INHERITS" | "IMPLEMENTS",
    isOutgoing: boolean,
  ): GraphRelationshipSummary[] => {
    const result: GraphRelationshipSummary[] = [];
    for (const rel of rels) {
      if (rel.type !== type) continue;
      const otherId = isOutgoing ? rel.toSymbolId : rel.fromSymbolId;
      if (!otherId) continue;
      const otherSym = symbolMap.get(otherId);
      if (!otherSym) continue;
      const otherSummary = toGraphSymbolSummary(otherSym);
      result.push({
        id: rel.id,
        type: rel.type,
        filePath: rel.filePath,
        startLine: rel.startLine,
        endLine: rel.endLine,
        referenceName: rel.referenceName,
        targetModule: rel.targetModule,
        isResolved: true,
        resolutionError: null,
        fromSymbol: isOutgoing ? targetSummary : otherSummary,
        toSymbol: isOutgoing ? otherSummary : targetSummary,
      });
    }
    return result;
  };

  const extendsEdges = buildEdgeList(
    outgoingResolved.relationships,
    "INHERITS",
    true,
  );
  const implementsEdges = buildEdgeList(
    outgoingResolved.relationships,
    "IMPLEMENTS",
    true,
  );
  const subclasses = buildEdgeList(
    incomingResolved.relationships,
    "INHERITS",
    false,
  );
  const implementors = buildEdgeList(
    incomingResolved.relationships,
    "IMPLEMENTS",
    false,
  );

  const fileImports: GraphRelationshipSummary[] = [];
  for (const rel of fileImportsRes.relationships) {
    const targetSym = rel.toSymbolId
      ? symbolMap.get(rel.toSymbolId)
      : undefined;
    fileImports.push({
      id: rel.id,
      type: rel.type,
      filePath: rel.filePath,
      startLine: rel.startLine,
      endLine: rel.endLine,
      referenceName: rel.referenceName,
      targetModule: rel.targetModule,
      isResolved: true,
      resolutionError: null,
      fromSymbol: null,
      toSymbol: targetSym ? toGraphSymbolSummary(targetSym) : null,
    });
  }

  return {
    status: "ok",
    mode: "class_dependencies",
    branchIndexId: snapshot.branchIndexId,
    commitSha: snapshot.commitSha,
    symbol: targetSummary,
    extends: extendsEdges,
    implements: implementsEdges,
    subclasses,
    implementors,
    members: methodsRes.symbols
      .filter((m) => m.id !== targetSymbol.id)
      .map(toGraphSymbolSummary),
    fileImports,
    unresolvedDependencies: outgoingUnresolved.relationships.map(
      toUnresolvedReference,
    ),
    truncated:
      outgoingResolved.totalMatches > outgoingResolved.relationships.length ||
      incomingResolved.totalMatches > incomingResolved.relationships.length ||
      methodsRes.totalMatches > methodsRes.symbols.length ||
      fileImportsRes.totalMatches > fileImportsRes.relationships.length,
  };
}

async function handleExecutionPath(
  reader: CodeGraphReader,
  snapshot: GraphSnapshotRef,
  query: CodeGraphLookupQuery,
): Promise<Record<string, unknown>> {
  const symbolLimit = capSymbolsLimit(query.limit);
  const startRes = await resolveTargetSymbol(
    reader,
    snapshot,
    "execution_path",
    query,
    symbolLimit,
    "symbol",
  );
  if (!startRes.ok) return startRes.response;

  const hasTargetSpec = Boolean(
    query.targetSymbolId ||
    query.targetSymbolName ||
    query.targetQualifiedName ||
    query.targetFilePath,
  );
  let targetSymbol: PersistedGraphSymbol | null = null;
  if (hasTargetSpec) {
    const targetRes = await resolveTargetSymbol(
      reader,
      snapshot,
      "execution_path",
      {
        symbolId: query.targetSymbolId,
        symbolName: query.targetSymbolName,
        qualifiedName: query.targetQualifiedName,
        filePath: query.targetFilePath,
      },
      symbolLimit,
      "targetSymbol",
    );
    if (!targetRes.ok) return targetRes.response;
    targetSymbol = targetRes.symbol;
  }

  const direction = query.direction ?? "outgoing";
  const maxDepth = Math.min(
    GRAPH_LOOKUP_LIMITS.maxExecutionDepth,
    Math.max(
      1,
      Math.floor(query.maxDepth ?? GRAPH_LOOKUP_LIMITS.defaultExecutionDepth),
    ),
  );
  const maxNodes = Math.min(
    GRAPH_LOOKUP_LIMITS.maxNodesExplored,
    Math.max(
      1,
      Math.floor(query.limit ?? GRAPH_LOOKUP_LIMITS.defaultMaxNodesExplored),
    ),
  );
  const maxPaths = GRAPH_LOOKUP_LIMITS.maxExecutionPaths;

  const startSymbol = startRes.symbol;
  const knownSymbols = new Map<string, PersistedGraphSymbol>([
    [startSymbol.id, startSymbol],
  ]);
  if (targetSymbol) {
    knownSymbols.set(targetSymbol.id, targetSymbol);
  }

  interface PathEdgeRecord {
    rel: PersistedGraphRelationship;
    fromId: string;
    toId: string;
  }

  const visited = new Set<string>([startSymbol.id]);
  const pathToNode = new Map<string, PathEdgeRecord[]>([[startSymbol.id, []]]);
  const expandedChildren = new Set<string>();
  const targetPaths: PathEdgeRecord[][] = [];
  const cycleEdges: PathEdgeRecord[] = [];
  let frontier: string[] = [startSymbol.id];
  let depthReached = 0;
  let truncated = false;
  let truncationReason: string | null = null;
  let cycleDetected = false;

  for (let depth = 0; depth < maxDepth && frontier.length > 0; depth++) {
    const relCriteria: RelationshipSearchCriteria =
      direction === "outgoing"
        ? { types: ["CALL"], fromSymbolIds: frontier, isResolved: true }
        : { types: ["CALL"], toSymbolIds: frontier, isResolved: true };

    const { relationships, totalMatches } =
      await reader.findActiveRelationships(
        snapshot,
        relCriteria,
        GRAPH_LOOKUP_LIMITS.maxEdgesPerFrontier,
      );
    if (totalMatches > relationships.length) {
      truncated = true;
      truncationReason ??= "max_edges_per_level_reached";
    }

    const neighborIds: string[] = [];
    for (const rel of relationships) {
      if (!rel.fromSymbolId || !rel.toSymbolId) continue;
      const neighborId =
        direction === "outgoing" ? rel.toSymbolId : rel.fromSymbolId;
      if (!knownSymbols.has(neighborId)) {
        neighborIds.push(neighborId);
      }
    }

    if (neighborIds.length > 0) {
      const loadedNeighbors = await reader.findActiveSymbolsByIds(
        snapshot,
        neighborIds,
      );
      for (const sym of loadedNeighbors) {
        knownSymbols.set(sym.id, sym);
      }
    }

    const nextFrontier: string[] = [];
    let levelHadProgress = false;

    for (const rel of relationships) {
      if (!rel.fromSymbolId || !rel.toSymbolId) continue;
      const currentId =
        direction === "outgoing" ? rel.fromSymbolId : rel.toSymbolId;
      const neighborId =
        direction === "outgoing" ? rel.toSymbolId : rel.fromSymbolId;

      if (!knownSymbols.has(currentId) || !knownSymbols.has(neighborId)) {
        continue;
      }

      const currentPath = pathToNode.get(currentId);
      if (!currentPath) continue;

      const edgeRecord: PathEdgeRecord = {
        rel,
        fromId: rel.fromSymbolId,
        toId: rel.toSymbolId,
      };

      // Check whether neighborId creates a cycle on the current ancestor chain
      const onCurrentPath =
        neighborId === startSymbol.id ||
        currentPath.some((e) =>
          direction === "outgoing"
            ? e.toId === neighborId
            : e.fromId === neighborId,
        );
      if (onCurrentPath) {
        cycleDetected = true;
        if (cycleEdges.length < maxPaths) {
          cycleEdges.push(edgeRecord);
        }
        if (
          targetSymbol &&
          neighborId === targetSymbol.id &&
          targetPaths.length < maxPaths
        ) {
          targetPaths.push([...currentPath, edgeRecord]);
        }
        continue;
      }

      if (visited.has(neighborId)) {
        // Already explored via an equally short or shorter path; still allow recording
        // convergence on explicit targetSymbol without re-expanding neighborId.
        if (
          targetSymbol &&
          neighborId === targetSymbol.id &&
          targetPaths.length < maxPaths
        ) {
          targetPaths.push([...currentPath, edgeRecord]);
        }
        continue;
      }

      if (visited.size >= maxNodes) {
        truncated = true;
        truncationReason = "max_nodes_reached";
        break;
      }

      visited.add(neighborId);
      expandedChildren.add(currentId);
      levelHadProgress = true;

      const newPath = [...currentPath, edgeRecord];
      pathToNode.set(neighborId, newPath);

      if (targetSymbol && neighborId === targetSymbol.id) {
        if (targetPaths.length < maxPaths) {
          targetPaths.push(newPath);
        }
        // Do not expand past the requested target symbol
        continue;
      }

      nextFrontier.push(neighborId);
    }

    if (levelHadProgress) {
      depthReached = depth + 1;
    }
    if (truncated) break;
    frontier = nextFrontier;
  }

  if (frontier.length > 0 && !truncated) {
    truncated = true;
    truncationReason ??= "max_depth_reached";
  }

  const rawPaths: PathEdgeRecord[][] = targetSymbol
    ? targetPaths
    : [...pathToNode.entries()]
        .filter(
          ([nodeId, edges]) =>
            edges.length > 0 && !expandedChildren.has(nodeId),
        )
        .map(([, edges]) => edges)
        .slice(0, maxPaths);

  if (
    !targetSymbol &&
    [...pathToNode.entries()].filter(
      ([nodeId, edges]) => edges.length > 0 && !expandedChildren.has(nodeId),
    ).length > maxPaths
  ) {
    truncated = true;
    truncationReason ??= "max_paths_reached";
  }

  const formatTrace = (edges: PathEdgeRecord[]): ExecutionPathTrace => {
    const orderedEdges =
      direction === "incoming" ? [...edges].reverse() : edges;
    const hops: ExecutionPathHop[] = orderedEdges.map((edge, idx) => ({
      step: idx + 1,
      relationshipId: edge.rel.id,
      type: edge.rel.type,
      filePath: edge.rel.filePath,
      startLine: edge.rel.startLine,
      endLine: edge.rel.endLine,
      referenceName: edge.rel.referenceName,
      fromSymbol: toGraphSymbolSummary(knownSymbols.get(edge.fromId)!),
      toSymbol: toGraphSymbolSummary(knownSymbols.get(edge.toId)!),
    }));

    const chainLabels =
      hops.length > 0
        ? [
            `${hops[0].fromSymbol.filePath}:${hops[0].fromSymbol.qualifiedName}`,
            ...hops.map(
              (h) => `${h.toSymbol.filePath}:${h.toSymbol.qualifiedName}`,
            ),
          ]
        : [`${startSymbol.filePath}:${formatQualifiedName(startSymbol)}`];

    return {
      depth: hops.length,
      ...(targetSymbol ? { reachesTarget: true } : {}),
      summary: chainLabels.join(" -> "),
      hops,
    };
  };

  const paths = rawPaths.map(formatTrace);
  const cycles = cycleEdges.map((edge) => ({
    relationshipId: edge.rel.id,
    filePath: edge.rel.filePath,
    startLine: edge.rel.startLine,
    endLine: edge.rel.endLine,
    fromSymbol: toGraphSymbolSummary(knownSymbols.get(edge.fromId)!),
    toSymbol: toGraphSymbolSummary(knownSymbols.get(edge.toId)!),
  }));

  const involvedNodeIds = new Set<string>([startSymbol.id]);
  for (const path of paths) {
    for (const hop of path.hops) {
      involvedNodeIds.add(hop.fromSymbol.id);
      involvedNodeIds.add(hop.toSymbol.id);
    }
  }
  const nodes = [...involvedNodeIds]
    .map((id) => knownSymbols.get(id))
    .filter((s): s is PersistedGraphSymbol => Boolean(s))
    .map(toGraphSymbolSummary);

  return {
    status: "ok",
    mode: "execution_path",
    branchIndexId: snapshot.branchIndexId,
    commitSha: snapshot.commitSha,
    direction,
    startSymbol: toGraphSymbolSummary(startSymbol),
    ...(targetSymbol
      ? {
          targetSymbol: toGraphSymbolSummary(targetSymbol),
          targetReached: startSymbol.id === targetSymbol.id || paths.length > 0,
        }
      : {}),
    paths,
    nodes,
    cycleDetected,
    ...(cycles.length > 0 ? { cycles } : {}),
    limits: {
      maxDepth,
      maxNodes,
      maxPaths,
      depthReached,
      nodesExplored: visited.size,
      pathsReturned: paths.length,
      truncated,
      ...(truncationReason ? { truncationReason } : {}),
    },
  };
}
