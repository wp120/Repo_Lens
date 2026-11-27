import { prisma } from "../database/prisma.js";
import { IngestionOwnershipLostError } from "./codeChunkStore.js";

export interface StorableSymbol {
  id: string;
  branchIndexId: string;
  filePath: string;
  name: string;
  kind: string;
  language: string;
  startLine: number;
  endLine: number;
  startColumn: number;
  endColumn: number;
  containerName?: string | null;
  signature?: string | null;
  commitSha: string;
  ingestionAttempt: number;
  isActive?: boolean;
}

export interface StorableRelationship {
  id: string;
  branchIndexId: string;
  fromSymbolId?: string | null;
  toSymbolId?: string | null;
  type: string;
  filePath: string;
  startLine: number;
  endLine: number;
  referenceName: string;
  targetModule?: string | null;
  isResolved?: boolean;
  resolutionError?: string | null;
  metadata?: Record<string, unknown> | null;
  commitSha: string;
  ingestionAttempt: number;
  isActive?: boolean;
}

export interface ResolvedRelationshipUpdate {
  id: string;
  toSymbolId: string | null;
  isResolved: boolean;
  resolutionError: string | null;
}

export interface CodeGraphStore {
  stageSymbols(
    branchIndexId: string,
    ingestionAttempt: number,
    processingToken: string,
    symbols: StorableSymbol[],
  ): Promise<void>;
  stageRelationships(
    branchIndexId: string,
    ingestionAttempt: number,
    processingToken: string,
    relationships: StorableRelationship[],
  ): Promise<void>;
  loadStagedGraph(
    branchIndexId: string,
    ingestionAttempt: number,
    processingToken: string,
  ): Promise<{
    symbols: StorableSymbol[];
    relationships: StorableRelationship[];
  }>;
  persistResolvedRelationships(
    branchIndexId: string,
    ingestionAttempt: number,
    processingToken: string,
    updates: ResolvedRelationshipUpdate[],
  ): Promise<void>;
  markGraphCompleted(
    branchIndexId: string,
    ingestionAttempt: number,
    processingToken: string,
  ): Promise<void>;
}

const BATCH_SIZE = 50;

export const prismaCodeGraphStore: CodeGraphStore = {
  async stageSymbols(
    branchIndexId: string,
    ingestionAttempt: number,
    processingToken: string,
    symbols: StorableSymbol[],
  ): Promise<void> {
    if (symbols.length === 0) return;

    for (let i = 0; i < symbols.length; i += BATCH_SIZE) {
      const batch = symbols.slice(i, i + BATCH_SIZE);
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

        const placeholders: string[] = [];
        const params: unknown[] = [];

        for (let j = 0; j < batch.length; j++) {
          const s = batch[j];
          const offset = j * 15;
          placeholders.push(
            `($${offset + 1}::uuid, $${offset + 2}::uuid, $${offset + 3}, $${offset + 4}, $${offset + 5}, $${offset + 6}, $${offset + 7}, $${offset + 8}, $${offset + 9}, $${offset + 10}, $${offset + 11}, $${offset + 12}, $${offset + 13}, $${offset + 14}, $${offset + 15})`,
          );
          params.push(
            s.id,
            branchIndexId,
            s.filePath,
            s.name,
            s.kind,
            s.language,
            s.startLine,
            s.endLine,
            s.startColumn,
            s.endColumn,
            s.containerName ?? null,
            s.signature ?? null,
            s.commitSha,
            ingestionAttempt,
            false,
          );
        }

        await tx.$executeRawUnsafe(
          `INSERT INTO code_symbols (
            id,
            branch_index_id,
            file_path,
            name,
            kind,
            language,
            start_line,
            end_line,
            start_column,
            end_column,
            container_name,
            signature,
            commit_sha,
            ingestion_attempt,
            is_active
          ) VALUES ${placeholders.join(", ")}
          ON CONFLICT (id) DO NOTHING`,
          ...params,
        );
      });
    }
  },

  async stageRelationships(
    branchIndexId: string,
    ingestionAttempt: number,
    processingToken: string,
    relationships: StorableRelationship[],
  ): Promise<void> {
    if (relationships.length === 0) return;

    for (let i = 0; i < relationships.length; i += BATCH_SIZE) {
      const batch = relationships.slice(i, i + BATCH_SIZE);
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

        const placeholders: string[] = [];
        const params: unknown[] = [];

        for (let j = 0; j < batch.length; j++) {
          const r = batch[j];
          const offset = j * 16;
          placeholders.push(
            `($${offset + 1}::uuid, $${offset + 2}::uuid, $${offset + 3}::uuid, $${offset + 4}::uuid, $${offset + 5}, $${offset + 6}, $${offset + 7}, $${offset + 8}, $${offset + 9}, $${offset + 10}, $${offset + 11}, $${offset + 12}, $${offset + 13}::jsonb, $${offset + 14}, $${offset + 15}, $${offset + 16})`,
          );
          params.push(
            r.id,
            branchIndexId,
            r.fromSymbolId ?? null,
            r.toSymbolId ?? null,
            r.type,
            r.filePath,
            r.startLine,
            r.endLine,
            r.referenceName,
            r.targetModule ?? null,
            r.isResolved ?? false,
            r.resolutionError ?? null,
            r.metadata ? JSON.stringify(r.metadata) : null,
            r.commitSha,
            ingestionAttempt,
            false,
          );
        }

        await tx.$executeRawUnsafe(
          `INSERT INTO code_relationships (
            id,
            branch_index_id,
            from_symbol_id,
            to_symbol_id,
            type,
            file_path,
            start_line,
            end_line,
            reference_name,
            target_module,
            is_resolved,
            resolution_error,
            metadata,
            commit_sha,
            ingestion_attempt,
            is_active
          ) VALUES ${placeholders.join(", ")}
          ON CONFLICT (id) DO NOTHING`,
          ...params,
        );
      });
    }
  },

  async loadStagedGraph(
    branchIndexId: string,
    ingestionAttempt: number,
    processingToken: string,
  ): Promise<{
    symbols: StorableSymbol[];
    relationships: StorableRelationship[];
  }> {
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

      const symbols = await tx.$queryRawUnsafe<
        Array<{
          id: string;
          branch_index_id: string;
          file_path: string;
          name: string;
          kind: string;
          language: string;
          start_line: number;
          end_line: number;
          start_column: number;
          end_column: number;
          container_name: string | null;
          signature: string | null;
          commit_sha: string;
          ingestion_attempt: number;
          is_active: boolean;
        }>
      >(
        `SELECT id,
                branch_index_id,
                file_path,
                name,
                kind,
                language,
                start_line,
                end_line,
                start_column,
                end_column,
                container_name,
                signature,
                commit_sha,
                ingestion_attempt,
                is_active
         FROM code_symbols
         WHERE branch_index_id = $1::uuid
           AND ingestion_attempt = $2
           AND is_active = false`,
        branchIndexId,
        ingestionAttempt,
      );

      const relationships = await tx.$queryRawUnsafe<
        Array<{
          id: string;
          branch_index_id: string;
          from_symbol_id: string | null;
          to_symbol_id: string | null;
          type: string;
          file_path: string;
          start_line: number;
          end_line: number;
          reference_name: string;
          target_module: string | null;
          is_resolved: boolean;
          resolution_error: string | null;
          metadata: unknown;
          commit_sha: string;
          ingestion_attempt: number;
          is_active: boolean;
        }>
      >(
        `SELECT id,
                branch_index_id,
                from_symbol_id,
                to_symbol_id,
                type,
                file_path,
                start_line,
                end_line,
                reference_name,
                target_module,
                is_resolved,
                resolution_error,
                metadata,
                commit_sha,
                ingestion_attempt,
                is_active
         FROM code_relationships
         WHERE branch_index_id = $1::uuid
           AND ingestion_attempt = $2
           AND is_active = false`,
        branchIndexId,
        ingestionAttempt,
      );

      return {
        symbols: symbols.map((s) => ({
          id: s.id,
          branchIndexId: s.branch_index_id,
          filePath: s.file_path,
          name: s.name,
          kind: s.kind,
          language: s.language,
          startLine: s.start_line,
          endLine: s.end_line,
          startColumn: s.start_column,
          endColumn: s.end_column,
          containerName: s.container_name,
          signature: s.signature,
          commitSha: s.commit_sha,
          ingestionAttempt: s.ingestion_attempt,
          isActive: s.is_active,
        })),
        relationships: relationships.map((r) => ({
          id: r.id,
          branchIndexId: r.branch_index_id,
          fromSymbolId: r.from_symbol_id,
          toSymbolId: r.to_symbol_id,
          type: r.type,
          filePath: r.file_path,
          startLine: r.start_line,
          endLine: r.end_line,
          referenceName: r.reference_name,
          targetModule: r.target_module,
          isResolved: r.is_resolved,
          resolutionError: r.resolution_error,
          metadata:
            r.metadata && typeof r.metadata === "object"
              ? (r.metadata as Record<string, unknown>)
              : null,
          commitSha: r.commit_sha,
          ingestionAttempt: r.ingestion_attempt,
          isActive: r.is_active,
        })),
      };
    });
  },

  async persistResolvedRelationships(
    branchIndexId: string,
    ingestionAttempt: number,
    processingToken: string,
    updates: ResolvedRelationshipUpdate[],
  ): Promise<void> {
    if (updates.length === 0) return;

    for (let i = 0; i < updates.length; i += BATCH_SIZE) {
      const batch = updates.slice(i, i + BATCH_SIZE);
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

        for (const u of batch) {
          await tx.$executeRawUnsafe(
            `UPDATE code_relationships
             SET to_symbol_id = $1::uuid,
                 is_resolved = $2,
                 resolution_error = $3
             WHERE id = $4::uuid
               AND branch_index_id = $5::uuid
               AND ingestion_attempt = $6`,
            u.toSymbolId,
            u.isResolved,
            u.resolutionError,
            u.id,
            branchIndexId,
            ingestionAttempt,
          );
        }
      });
    }
  },

  async markGraphCompleted(
    branchIndexId: string,
    ingestionAttempt: number,
    processingToken: string,
  ): Promise<void> {
    const result = await prisma.$executeRawUnsafe(
      `UPDATE branch_indexes
       SET graph_status = 'completed'
       WHERE id = $1::uuid
         AND ingestion_attempt = $2
         AND processing_token = $3::uuid`,
      branchIndexId,
      ingestionAttempt,
      processingToken,
    );
    if (result !== 1) {
      throw new IngestionOwnershipLostError();
    }
  },
};
