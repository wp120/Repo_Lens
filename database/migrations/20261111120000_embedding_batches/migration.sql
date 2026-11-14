ALTER TABLE "code_chunks"
  ADD COLUMN "source_blob_sha" VARCHAR(40),
  ADD COLUMN "embedding_status" VARCHAR(32) NOT NULL DEFAULT 'pending',
  ADD COLUMN "is_active" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "ingestion_attempt" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "batch_execution_token" UUID,
  ADD COLUMN "published_commit_sha" VARCHAR(40);

CREATE INDEX IF NOT EXISTS "code_chunks_branch_index_id_is_active_idx"
  ON "code_chunks" ("branch_index_id", "is_active");

CREATE INDEX IF NOT EXISTS "code_chunks_branch_index_id_ingestion_attempt_embedding_status_idx"
  ON "code_chunks" ("branch_index_id", "ingestion_attempt", "embedding_status");

CREATE INDEX IF NOT EXISTS "code_chunks_branch_index_id_batch_execution_token_idx"
  ON "code_chunks" ("branch_index_id", "batch_execution_token");
