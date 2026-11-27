import { randomUUID } from "node:crypto";
import { prisma } from "../database/prisma.js";
import type { CodeChunk } from "./codeChunker.js";

export type EmbeddingStatus = "pending" | "processing" | "completed" | "failed";

export interface StorableCodeChunk extends CodeChunk {
  id?: string;
  embedding: number[];
  branchIndexId: string;
  sourceBlobSha?: string | null;
  embeddingStatus?: EmbeddingStatus;
  isActive?: boolean;
  ingestionAttempt?: number;
  batchExecutionToken?: string | null;
}

export interface CodeChunkRecord extends StorableCodeChunk {
  id: string;
}

export interface CodeChunkStore {
  saveChunks?: (
    branchIndexId: string,
    ingestionAttempt: number,
    processingToken: string,
    chunks: StorableCodeChunk[],
    commitSha: string,
  ) => Promise<void>;
  deleteBranchChunks?: (
    branchIndexId: string,
    ingestionAttempt: number,
    processingToken: string,
  ) => Promise<void>;
  countBranchChunks?: (branchIndexId: string) => Promise<number>;
  stageRepositoryFilePaths?: (
    branchIndexId: string,
    ingestionAttempt: number,
    processingToken: string,
    filePaths: string[],
  ) => Promise<void>;
  stageChunks?: (
    branchIndexId: string,
    ingestionAttempt: number,
    processingToken: string,
    chunks: StorableCodeChunk[],
  ) => Promise<void>;
  claimBatchChunks?: (
    branchIndexId: string,
    ingestionAttempt: number,
    processingToken: string,
    batchExecutionToken: string,
    chunkIds: string[],
  ) => Promise<CodeChunkRecord[]>;
  persistBatchEmbeddings?: (
    branchIndexId: string,
    ingestionAttempt: number,
    processingToken: string,
    batchExecutionToken: string,
    chunkIds: string[],
    embeddings: number[][],
  ) => Promise<void>;
  markBatchFailed?: (
    branchIndexId: string,
    ingestionAttempt: number,
    processingToken: string,
    batchExecutionToken: string,
    chunkIds: string[],
  ) => Promise<void>;
  finalizeIngestion?: (
    branchIndexId: string,
    ingestionAttempt: number,
    processingToken: string,
    commitSha: string,
  ) => Promise<boolean>;
  failIngestion?: (
    branchIndexId: string,
    ingestionAttempt: number,
    processingToken: string,
    error: string,
  ) => Promise<boolean>;
}

const BATCH_SIZE = 50;

export class IngestionOwnershipLostError extends Error {
  constructor() {
    super("Ingestion execution no longer owns this branch.");
    this.name = "IngestionOwnershipLostError";
  }
}

export class BatchOwnershipLostError extends Error {
  constructor() {
    super("Batch execution no longer owns the targeted chunks.");
    this.name = "BatchOwnershipLostError";
  }
}

function toVectorString(values: number[]): string {
  return `[${values.join(",")}]`;
}

export const prismaCodeChunkStore: CodeChunkStore = {
  async stageRepositoryFilePaths(
    branchIndexId: string,
    ingestionAttempt: number,
    processingToken: string,
    filePaths: string[],
  ): Promise<void> {
    const result = await prisma.$executeRawUnsafe(
      `UPDATE branch_indexes
       SET pending_repository_file_paths = $4::jsonb
       WHERE id = $1::uuid
         AND ingestion_attempt = $2
         AND processing_token = $3::uuid`,
      branchIndexId,
      ingestionAttempt,
      processingToken,
      JSON.stringify(filePaths),
    );
    if (result !== 1) {
      throw new IngestionOwnershipLostError();
    }
  },

  async saveChunks(
    branchIndexId: string,
    ingestionAttempt: number,
    processingToken: string,
    chunks: StorableCodeChunk[],
    commitSha: string,
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

      for (let i = 0; i < chunks.length; i += BATCH_SIZE) {
        const batch = chunks.slice(i, i + BATCH_SIZE);
        const valuePlaceholders: string[] = [];
        const params: unknown[] = [];

        for (let j = 0; j < batch.length; j++) {
          const chunk = batch[j];
          const offset = j * 15;
          valuePlaceholders.push(
            `($${offset + 1}::uuid, $${offset + 2}::uuid, $${offset + 3}, $${offset + 4}, $${offset + 5}, $${offset + 6}, $${offset + 7}, $${offset + 8}, $${offset + 9}, $${offset + 10}, $${offset + 11}, $${offset + 12}, $${offset + 13}, $${offset + 14}, $${offset + 15}::vector)`,
          );

          const id = chunk.id ?? randomUUID();
          const vectorString = toVectorString(chunk.embedding ?? []);

          params.push(
            id,
            branchIndexId,
            chunk.filePath,
            chunk.content,
            chunk.startLine,
            chunk.endLine,
            chunk.language,
            chunk.symbolName,
            chunk.symbolType ?? null,
            chunk.className ?? null,
            chunk.functionSignature ?? null,
            chunk.commitSha,
            chunk.sourceBlobSha ?? null,
            "completed",
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
            symbol_type,
            class_name,
            function_signature,
            commit_sha,
            source_blob_sha,
            embedding_status,
            embedding
          ) VALUES ${valuePlaceholders.join(", ")}
        `;

        await tx.$executeRawUnsafe(sql, ...params);
      }

      const published = await tx.$executeRawUnsafe(
        `UPDATE branch_indexes
         SET repository_file_paths = pending_repository_file_paths,
             pending_repository_file_paths = NULL,
             published_commit_sha = $4
         WHERE id = $1::uuid
           AND ingestion_attempt = $2
           AND processing_token = $3::uuid
           AND pending_repository_file_paths IS NOT NULL`,
        branchIndexId,
        ingestionAttempt,
        processingToken,
        commitSha,
      );
      if (published !== 1) {
        throw new Error("Staged repository structure is missing.");
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
        "DELETE FROM code_relationships WHERE branch_index_id = $1::uuid",
        branchIndexId,
      );
      await tx.$executeRawUnsafe(
        "DELETE FROM code_symbols WHERE branch_index_id = $1::uuid",
        branchIndexId,
      );
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

  async stageChunks(
    branchIndexId: string,
    ingestionAttempt: number,
    processingToken: string,
    chunks: StorableCodeChunk[],
  ): Promise<void> {
    const stageBatch = async (batch: StorableCodeChunk[]) => {
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
        if (batch.length === 0) return;

        const params: unknown[] = [];
        const placeholders: string[] = [];

        for (let j = 0; j < batch.length; j++) {
          const chunk = batch[j];
          const offset = j * 18;
          placeholders.push(
            `($${offset + 1}::uuid, $${offset + 2}::uuid, $${offset + 3}, $${offset + 4}, $${offset + 5}, $${offset + 6}, $${offset + 7}, $${offset + 8}, $${offset + 9}, $${offset + 10}, $${offset + 11}, $${offset + 12}, $${offset + 13}, $${offset + 14}, $${offset + 15}, $${offset + 16}, $${offset + 17}, $${offset + 18})`,
          );
          params.push(
            chunk.id ?? randomUUID(),
            branchIndexId,
            chunk.filePath,
            chunk.content,
            chunk.startLine,
            chunk.endLine,
            chunk.language,
            chunk.symbolName,
            chunk.symbolType ?? null,
            chunk.className ?? null,
            chunk.functionSignature ?? null,
            chunk.commitSha,
            chunk.sourceBlobSha ?? null,
            null,
            "pending",
            false,
            ingestionAttempt,
            null,
          );
        }

        await tx.$executeRawUnsafe(
          `INSERT INTO code_chunks (
            id,
            branch_index_id,
            file_path,
            content,
            start_line,
            end_line,
            language,
            symbol_name,
            symbol_type,
            class_name,
            function_signature,
            commit_sha,
            source_blob_sha,
            embedding,
            embedding_status,
            is_active,
            ingestion_attempt,
            batch_execution_token
          ) VALUES ${placeholders.join(", ")}
          ON CONFLICT (id) DO NOTHING`,
          ...params,
        );
      });
    };

    if (chunks.length === 0) {
      await stageBatch([]);
      return;
    }

    for (let i = 0; i < chunks.length; i += BATCH_SIZE) {
      await stageBatch(chunks.slice(i, i + BATCH_SIZE));
    }
  },

  async claimBatchChunks(
    branchIndexId: string,
    ingestionAttempt: number,
    processingToken: string,
    batchExecutionToken: string,
    chunkIds: string[],
  ): Promise<CodeChunkRecord[]> {
    if (chunkIds.length === 0) return [];

    return prisma.$transaction(async (tx) => {
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

      const claimed = await tx.$queryRawUnsafe<Array<any>>(
        `UPDATE code_chunks
         SET embedding_status = 'processing',
             batch_execution_token = $3::uuid
         WHERE id = ANY($4::uuid[])
           AND branch_index_id = $1::uuid
           AND ingestion_attempt = $2
           AND embedding_status IN ('pending', 'failed', 'processing')
           AND is_active = false
         RETURNING
           id,
           branch_index_id AS "branchIndexId",
           file_path AS "filePath",
           content,
           start_line AS "startLine",
           end_line AS "endLine",
           language,
           symbol_name AS "symbolName",
           symbol_type AS "symbolType",
           class_name AS "className",
           function_signature AS "functionSignature",
           commit_sha AS "commitSha",
           source_blob_sha AS "sourceBlobSha",
           embedding_status AS "embeddingStatus",
           is_active AS "isActive",
           ingestion_attempt AS "ingestionAttempt",
           batch_execution_token AS "batchExecutionToken"`,
        branchIndexId,
        ingestionAttempt,
        batchExecutionToken,
        chunkIds,
      );
      return claimed.map((chunk) => ({
        ...chunk,
        embedding: Array.isArray(chunk.embedding) ? chunk.embedding : [],
      }));
    });
  },

  async persistBatchEmbeddings(
    branchIndexId: string,
    ingestionAttempt: number,
    processingToken: string,
    batchExecutionToken: string,
    chunkIds: string[],
    embeddings: number[][],
  ): Promise<void> {
    if (chunkIds.length === 0) return;

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
        throw new BatchOwnershipLostError();
      }

      for (let index = 0; index < chunkIds.length; index++) {
        const chunkId = chunkIds[index];
        const embedding = embeddings[index] ?? [];
        const result = await tx.$executeRawUnsafe(
          `UPDATE code_chunks
           SET embedding = $1::vector,
               embedding_status = 'completed',
               batch_execution_token = NULL,
               is_active = false
           WHERE id = $2::uuid
             AND branch_index_id = $3::uuid
             AND ingestion_attempt = $4
             AND batch_execution_token = $5::uuid
             AND embedding_status = 'processing'`,
          toVectorString(embedding),
          chunkId,
          branchIndexId,
          ingestionAttempt,
          batchExecutionToken,
        );
        if (result === 0) {
          throw new BatchOwnershipLostError();
        }
      }
    });
  },

  async markBatchFailed(
    branchIndexId: string,
    ingestionAttempt: number,
    processingToken: string,
    batchExecutionToken: string,
    chunkIds: string[],
  ): Promise<void> {
    if (chunkIds.length === 0) return;

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
        return;
      }

      await tx.$executeRawUnsafe(
        `UPDATE code_chunks
         SET embedding_status = 'failed',
             batch_execution_token = NULL,
             is_active = false
         WHERE id = ANY($1::uuid[])
           AND branch_index_id = $2::uuid
           AND ingestion_attempt = $3
           AND batch_execution_token = $4::uuid
           AND embedding_status = 'processing'`,
        chunkIds,
        branchIndexId,
        ingestionAttempt,
        batchExecutionToken,
      );
    });
  },

  async finalizeIngestion(
    branchIndexId: string,
    ingestionAttempt: number,
    processingToken: string,
    commitSha: string,
  ): Promise<boolean> {
    return prisma.$transaction(async (tx) => {
      const owner = await tx.$queryRawUnsafe<
        Array<{
          id: string;
          has_pending_repository_file_paths: boolean;
          graph_status?: string;
        }>
      >(
        `SELECT id,
                pending_repository_file_paths IS NOT NULL AS has_pending_repository_file_paths,
                graph_status
         FROM branch_indexes
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
      if (!owner[0].has_pending_repository_file_paths) {
        throw new Error("Staged repository structure is missing.");
      }

      // Finalization requires graph construction to be completed
      if (
        owner[0].graph_status !== undefined &&
        owner[0].graph_status !== "completed"
      ) {
        return false;
      }

      const incomplete = await tx.$queryRawUnsafe<
        Array<{ count: string | number | bigint }>
      >(
        `SELECT count(*)::int AS count
         FROM code_chunks
         WHERE branch_index_id = $1::uuid
           AND ingestion_attempt = $2
           AND (
             commit_sha <> $3::varchar(40)
             OR embedding_status <> 'completed'
             OR embedding IS NULL
           )`,
        branchIndexId,
        ingestionAttempt,
        commitSha,
      );
      if (Number(incomplete[0]?.count ?? 0) > 0) {
        return false;
      }

      await tx.$executeRawUnsafe(
        "UPDATE code_chunks SET is_active = false WHERE branch_index_id = $1::uuid AND is_active = true",
        branchIndexId,
      );

      await tx.$executeRawUnsafe(
        `UPDATE code_chunks
         SET is_active = true
         WHERE branch_index_id = $1::uuid
           AND ingestion_attempt = $2
           AND commit_sha = $3
           AND embedding_status = 'completed'
           AND embedding IS NOT NULL`,
        branchIndexId,
        ingestionAttempt,
        commitSha,
      );

      await tx.$executeRawUnsafe(
        "UPDATE code_symbols SET is_active = false WHERE branch_index_id = $1::uuid AND is_active = true",
        branchIndexId,
      );

      await tx.$executeRawUnsafe(
        `UPDATE code_symbols
         SET is_active = true
         WHERE branch_index_id = $1::uuid
           AND ingestion_attempt = $2
           AND commit_sha = $3`,
        branchIndexId,
        ingestionAttempt,
        commitSha,
      );

      await tx.$executeRawUnsafe(
        "UPDATE code_relationships SET is_active = false WHERE branch_index_id = $1::uuid AND is_active = true",
        branchIndexId,
      );

      await tx.$executeRawUnsafe(
        `UPDATE code_relationships
         SET is_active = true
         WHERE branch_index_id = $1::uuid
           AND ingestion_attempt = $2
           AND commit_sha = $3`,
        branchIndexId,
        ingestionAttempt,
        commitSha,
      );

      await tx.$executeRawUnsafe(
        `DELETE FROM code_chunks
         WHERE branch_index_id = $1::uuid
           AND embedding_status = 'pending'`,
        branchIndexId,
      );

      // Delete all rows from prior ingestion attempts that are now superseded
      // (is_active = false after the activation step above). FK order: relationships
      // reference symbols which reference chunks, so delete in reverse dependency order.
      await tx.$executeRawUnsafe(
        `DELETE FROM code_relationships
         WHERE branch_index_id = $1::uuid
           AND is_active = false`,
        branchIndexId,
      );

      await tx.$executeRawUnsafe(
        `DELETE FROM code_symbols
         WHERE branch_index_id = $1::uuid
           AND is_active = false`,
        branchIndexId,
      );

      await tx.$executeRawUnsafe(
        `DELETE FROM code_chunks
         WHERE branch_index_id = $1::uuid
           AND is_active = false`,
        branchIndexId,
      );

      await tx.$executeRawUnsafe(
        `UPDATE branch_indexes
         SET status = 'ready',
             last_error = NULL,
             processing_token = NULL,
             published_commit_sha = $4,
             repository_file_paths = pending_repository_file_paths,
             pending_repository_file_paths = NULL,
             updated_at = NOW()
         WHERE id = $1::uuid
           AND ingestion_attempt = $2
           AND processing_token = $3::uuid
           AND pending_repository_file_paths IS NOT NULL`,
        branchIndexId,
        ingestionAttempt,
        processingToken,
        commitSha,
      );

      return true;
    });
  },

  async failIngestion(
    branchIndexId: string,
    ingestionAttempt: number,
    processingToken: string,
    error: string,
  ): Promise<boolean> {
    return prisma.$transaction(async (tx) => {
      const owner = await tx.$queryRawUnsafe<Array<{ id: string }>>(
        `SELECT id FROM branch_indexes
         WHERE id = $1::uuid
           AND ingestion_attempt = $2
           AND processing_token = $3::uuid
           AND status = 'ingesting'
         FOR UPDATE`,
        branchIndexId,
        ingestionAttempt,
        processingToken,
      );
      if (owner.length === 0) {
        return false;
      }

      const transitioned = await tx.$executeRawUnsafe(
        `UPDATE branch_indexes
         SET status = 'failed',
             graph_status = 'failed',
             last_error = $4,
             processing_token = NULL,
             pending_repository_file_paths = NULL,
             updated_at = NOW()
         WHERE id = $1::uuid
           AND ingestion_attempt = $2
           AND processing_token = $3::uuid
           AND status = 'ingesting'`,
        branchIndexId,
        ingestionAttempt,
        processingToken,
        error.slice(0, 4000),
      );
      if (transitioned !== 1) {
        return false;
      }

      await tx.$executeRawUnsafe(
        `DELETE FROM code_chunks
         WHERE branch_index_id = $1::uuid
           AND ingestion_attempt = $2
           AND is_active = false`,
        branchIndexId,
        ingestionAttempt,
      );

      await tx.$executeRawUnsafe(
        `DELETE FROM code_relationships
         WHERE branch_index_id = $1::uuid
           AND ingestion_attempt = $2
           AND is_active = false`,
        branchIndexId,
        ingestionAttempt,
      );

      await tx.$executeRawUnsafe(
        `DELETE FROM code_symbols
         WHERE branch_index_id = $1::uuid
           AND ingestion_attempt = $2
           AND is_active = false`,
        branchIndexId,
        ingestionAttempt,
      );
      return true;
    });
  },
};
