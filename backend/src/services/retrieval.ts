import { prisma } from "../database/prisma.js";
import { generateVoyageEmbeddings } from "./voyageEmbedding.js";

export interface RetrievedCodeChunk {
  id: string;
  filePath: string;
  content: string;
  startLine: number;
  endLine: number;
  commitSha: string;
  symbolName: string | null;
  symbolType: string | null;
  className: string | null;
  functionSignature: string | null;
  distance: number;
}

interface RawRetrievedCodeChunk {
  id: string;
  filePath: string;
  content: string;
  startLine: number;
  endLine: number;
  commitSha: string;
  symbolName: string | null;
  symbolType: string | null;
  className: string | null;
  functionSignature: string | null;
  distance: number;
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
  return prisma.$queryRaw<RawRetrievedCodeChunk[]>`
    SELECT
      id::text AS "id",
      file_path AS "filePath",
      content,
      start_line AS "startLine",
      end_line AS "endLine",
      commit_sha AS "commitSha",
      symbol_name AS "symbolName",
      symbol_type AS "symbolType",
      class_name AS "className",
      function_signature AS "functionSignature",
      (embedding <=> ${vector}::vector) AS "distance"
    FROM code_chunks
    WHERE branch_index_id = ${branchIndexId}::uuid
    ORDER BY embedding <=> ${vector}::vector ASC
    LIMIT ${limit}
  `;
}
