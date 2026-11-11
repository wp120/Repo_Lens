import { randomUUID } from "node:crypto";
import { prisma } from "../database/prisma.js";
import type { CodeChunk } from "./codeChunker.js";

export interface StorableCodeChunk extends CodeChunk {
  embedding: number[];
  branchIndexId: string;
}

export interface CodeChunkStore {
  saveChunks(
    branchIndexId: string,
    ingestionAttempt: number,
    processingToken: string,
    chunks: StorableCodeChunk[],
  ): Promise<void>;
  deleteBranchChunks(
    branchIndexId: string,
    ingestionAttempt: number,
    processingToken: string,
  ): Promise<void>;
  countBranchChunks(branchIndexId: string): Promise<number>;
}

const BATCH_SIZE = 50;

export class IngestionOwnershipLostError extends Error {
  constructor() {
    super("Ingestion execution no longer owns this branch.");
    this.name = "IngestionOwnershipLostError";
  }
}

export const prismaCodeChunkStore: CodeChunkStore = {
  async saveChunks(
    branchIndexId: string,
    ingestionAttempt: number,
    processingToken: string,
    chunks: StorableCodeChunk[],
  ): Promise<void> {
    await prisma.$transaction(async (tx) => {
      const owner = await tx.$queryRawUnsafe<Array<{ id: string }>>(
        `SELECT id FROM branch_indexes
         WHERE id = $1::uuid
           AND ingestion_attempt = $2
           AND processing_token = $3::uuid
         FOR UPDATE`,
        branchIndexId,
        ingestionAttempt,
        processingToken,
      );
      if (owner.length === 0) {
        throw new IngestionOwnershipLostError();
      }

      // Clean up any prior chunks for this branch index
      await tx.$executeRawUnsafe(
        "DELETE FROM code_chunks WHERE branch_index_id = $1::uuid",
        branchIndexId,
      );

      if (chunks.length === 0) return;

      for (let i = 0; i < chunks.length; i += BATCH_SIZE) {
        const batch = chunks.slice(i, i + BATCH_SIZE);
        const valuePlaceholders: string[] = [];
        const params: unknown[] = [];

        for (let j = 0; j < batch.length; j++) {
          const chunk = batch[j];
          const offset = j * 13;
          valuePlaceholders.push(
            `($${offset + 1}::uuid, $${offset + 2}::uuid, $${offset + 3}, $${offset + 4}, $${offset + 5}, $${offset + 6}, $${offset + 7}, $${offset + 8}, $${offset + 9}, $${offset + 10}, $${offset + 11}, $${offset + 12}, $${offset + 13}::vector)`,
          );

          const id = randomUUID();
          const vectorString = `[${chunk.embedding.join(",")}]`;

          params.push(
            id,
            branchIndexId,
            chunk.filePath,
            chunk.content,
            chunk.startLine,
            chunk.endLine,
            chunk.language,
            chunk.symbolName,
            chunk.commitSha,
            chunk.symbolType ?? null,
            chunk.className ?? null,
            chunk.functionSignature ?? null,
            vectorString,
          );
        }

        const sql = `
          INSERT INTO code_chunks (
            id,
            branch_index_id,
            file_path,
            content,
            start_line,
            end_line,
            language,
            symbol_name,
            commit_sha,
            symbol_type,
            class_name,
            function_signature,
            embedding
          ) VALUES ${valuePlaceholders.join(", ")}
        `;

        await tx.$executeRawUnsafe(sql, ...params);
      }
    });
  },

  async deleteBranchChunks(
    branchIndexId: string,
    ingestionAttempt: number,
    processingToken: string,
  ): Promise<void> {
    await prisma.$transaction(async (tx) => {
      const owner = await tx.$queryRawUnsafe<Array<{ id: string }>>(
        `SELECT id FROM branch_indexes
         WHERE id = $1::uuid
           AND ingestion_attempt = $2
           AND processing_token = $3::uuid
         FOR UPDATE`,
        branchIndexId,
        ingestionAttempt,
        processingToken,
      );
      if (owner.length === 0) {
        throw new IngestionOwnershipLostError();
      }

      await tx.$executeRawUnsafe(
        "DELETE FROM code_chunks WHERE branch_index_id = $1::uuid",
        branchIndexId,
      );
    });
  },

  async countBranchChunks(branchIndexId: string): Promise<number> {
    const result = await prisma.$queryRawUnsafe<
      Array<{ count: string | number | bigint }>
    >(
      "SELECT count(*) as count FROM code_chunks WHERE branch_index_id = $1::uuid",
      branchIndexId,
    );
    return Number(result[0]?.count ?? 0);
  },
};
