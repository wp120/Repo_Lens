import { randomUUID } from "node:crypto";
import { prisma } from "../database/prisma.js";
import type { CodeChunk } from "./codeChunker.js";

export interface StorableCodeChunk extends CodeChunk {
  embedding: number[];
  branchIndexId: string;
}

export interface CodeChunkStore {
  saveChunks(branchIndexId: string, chunks: StorableCodeChunk[]): Promise<void>;
  deleteBranchChunks(branchIndexId: string): Promise<void>;
  countBranchChunks(branchIndexId: string): Promise<number>;
}

const BATCH_SIZE = 50;

export const prismaCodeChunkStore: CodeChunkStore = {
  async saveChunks(
    branchIndexId: string,
    chunks: StorableCodeChunk[],
  ): Promise<void> {
    await prisma.$transaction(async (tx) => {
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
          const offset = j * 10;
          valuePlaceholders.push(
            `($${offset + 1}::uuid, $${offset + 2}::uuid, $${offset + 3}, $${offset + 4}, $${offset + 5}, $${offset + 6}, $${offset + 7}, $${offset + 8}, $${offset + 9}, $${offset + 10}::vector)`,
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
            embedding
          ) VALUES ${valuePlaceholders.join(", ")}
        `;

        await tx.$executeRawUnsafe(sql, ...params);
      }
    });
  },

  async deleteBranchChunks(branchIndexId: string): Promise<void> {
    await prisma.$executeRawUnsafe(
      "DELETE FROM code_chunks WHERE branch_index_id = $1::uuid",
      branchIndexId,
    );
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
