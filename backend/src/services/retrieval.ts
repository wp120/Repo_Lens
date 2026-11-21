import { prisma } from "../database/prisma.js";
import { generateVoyageEmbeddings } from "./voyageEmbedding.js";

export interface RetrievedCodeChunk {
  id: string;
  filePath: string;
  content: string;
  startLine: number;
  endLine: number;
  commitSha: string;
  language: string | null;
  symbolName: string | null;
  symbolType: string | null;
  className: string | null;
  functionSignature: string | null;
  retrievalSources?: string[];
}

interface RawRetrievedCodeChunk {
  id: string;
  filePath: string;
  content: string;
  startLine: number;
  endLine: number;
  commitSha: string;
  language: string | null;
  symbolName: string | null;
  symbolType: string | null;
  className: string | null;
  functionSignature: string | null;
}

export type CodeSearchMode = "full_text" | "identifier";

export interface CodeSearchFilters {
  filePath?: string;
  className?: string;
  symbolName?: string;
  symbolType?: string;
  language?: string;
}

export class RetrievalError extends Error {
  constructor(message: string, readonly cause?: unknown) {
    super(message);
    this.name = "RetrievalError";
  }
}

export async function retrieveRelevantChunks(
  branchIndexId: string,
  question: string,
  limit = 6,
): Promise<RetrievedCodeChunk[]> {
  if (!question.trim()) {
    throw new RetrievalError("A non-empty retrieval question is required.");
  }
  if (!Number.isSafeInteger(limit) || limit <= 0) {
    throw new RetrievalError("Retrieval limit must be a positive integer.");
  }

  const [embedding] = await generateVoyageEmbeddings([question]);
  if (!embedding) {
    throw new RetrievalError("Question embedding generation returned no vector.");
  }

  const vector = `[${embedding.join(",")}]`;
  const rows = await prisma.$queryRaw<RawRetrievedCodeChunk[]>`
    SELECT
      id::text AS "id",
      file_path AS "filePath",
      content,
      start_line AS "startLine",
      end_line AS "endLine",
      commit_sha AS "commitSha",
      language,
      symbol_name AS "symbolName",
      symbol_type AS "symbolType",
      class_name AS "className",
      function_signature AS "functionSignature"
    FROM code_chunks
    WHERE branch_index_id = ${branchIndexId}::uuid
      AND is_active = true
      AND embedding_status = 'completed'
      AND embedding IS NOT NULL
    ORDER BY embedding <=> ${vector}::vector ASC
    LIMIT ${limit}
  `;
  return rows.map((row) => ({ ...row, retrievalSources: ["vector"] }));
}

export async function searchCode(
  branchIndexId: string,
  query: string,
  mode: CodeSearchMode,
  filters: CodeSearchFilters = {},
  limit = 10,
): Promise<RetrievedCodeChunk[]> {
  if (!branchIndexId.trim()) {
    throw new RetrievalError("A branch index is required.");
  }
  if (!query.trim()) {
    throw new RetrievalError("A non-empty search query is required.");
  }
  if (!Number.isSafeInteger(limit) || limit <= 0) {
    throw new RetrievalError("Search limit must be a positive integer.");
  }

  const normalizedFilters = normalizeFilters(filters);
  const params: unknown[] = [branchIndexId];
  const filterSql: string[] = [];
  addFilter(params, filterSql, "file_path", normalizedFilters.filePath);
  addFilter(params, filterSql, "class_name", normalizedFilters.className);
  addFilter(params, filterSql, "symbol_name", normalizedFilters.symbolName);
  addFilter(params, filterSql, "symbol_type", normalizedFilters.symbolType);
  addFilter(params, filterSql, "language", normalizedFilters.language);
  const filterClause = filterSql.length ? ` AND ${filterSql.join(" AND ")}` : "";

  if (mode === "full_text") {
    const queryParam = params.push(query.trim());
    params.push(Math.min(limit, 10));
    const limitParam = params.length;
    const sql = `
      SELECT
        id::text AS "id",
        file_path AS "filePath",
        content,
        start_line AS "startLine",
        end_line AS "endLine",
        commit_sha AS "commitSha",
        language,
        symbol_name AS "symbolName",
        symbol_type AS "symbolType",
        class_name AS "className",
        function_signature AS "functionSignature"
      FROM code_chunks
      WHERE branch_index_id = $1::uuid
        AND is_active = true
        AND search_vector @@ websearch_to_tsquery('english', $${queryParam})
        ${filterClause}
      ORDER BY ts_rank_cd(search_vector, websearch_to_tsquery('english', $${queryParam})) DESC
      LIMIT $${limitParam}
    `;
    const rows = await prisma.$queryRawUnsafe<RawRetrievedCodeChunk[]>(sql, ...params);
    return rows.map((row) => ({ ...row, retrievalSources: ["full_text"] }));
  }

  const escapedIdentifier = escapeRegex(query.trim());
  const identifierPattern = `(^|[^[:alnum:]_$])${escapedIdentifier}([^[:alnum:]_$]|$)`;
  const queryParam = params.push(identifierPattern);
  params.push(Math.min(limit, 10));
  const limitParam = params.length;
  const sql = `
    SELECT
      id::text AS "id",
      file_path AS "filePath",
      content,
      start_line AS "startLine",
      end_line AS "endLine",
      commit_sha AS "commitSha",
      language,
      symbol_name AS "symbolName",
      symbol_type AS "symbolType",
      class_name AS "className",
      function_signature AS "functionSignature"
    FROM code_chunks
    WHERE branch_index_id = $1::uuid
      AND is_active = true
      AND (
        COALESCE(symbol_name, '') ~ $${queryParam}
        OR COALESCE(class_name, '') ~ $${queryParam}
        OR COALESCE(function_signature, '') ~ $${queryParam}
        OR content ~ $${queryParam}
      )
      ${filterClause}
    ORDER BY
      CASE
        WHEN COALESCE(symbol_name, '') ~ $${queryParam} THEN 0
        WHEN COALESCE(class_name, '') ~ $${queryParam} THEN 1
        WHEN COALESCE(function_signature, '') ~ $${queryParam} THEN 2
        ELSE 3
      END,
      file_path,
      start_line
    LIMIT $${limitParam}
  `;
  const rows = await prisma.$queryRawUnsafe<RawRetrievedCodeChunk[]>(sql, ...params);
  return rows.map((row) => ({ ...row, retrievalSources: ["identifier"] }));
}

function normalizeFilters(filters: CodeSearchFilters): CodeSearchFilters {
  const normalized: CodeSearchFilters = {};
  for (const key of ["filePath", "className", "symbolName", "symbolType", "language"] as const) {
    const value = filters[key]?.trim();
    if (value) normalized[key] = value;
  }
  return normalized;
}

function addFilter(
  params: unknown[],
  filterSql: string[],
  column: string,
  value: string | undefined,
) {
  if (!value) return;
  params.push(value);
  filterSql.push(`${column} = $${params.length}`);
}

export function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
