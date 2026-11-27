-- AlterTable
ALTER TABLE "branch_indexes" ADD COLUMN "graph_status" VARCHAR(32) NOT NULL DEFAULT 'pending';

-- CreateTable
CREATE TABLE "code_symbols" (
    "id" UUID NOT NULL,
    "branch_index_id" UUID NOT NULL,
    "file_path" VARCHAR(1024) NOT NULL,
    "name" VARCHAR(255) NOT NULL,
    "kind" VARCHAR(64) NOT NULL,
    "language" VARCHAR(64) NOT NULL,
    "start_line" INTEGER NOT NULL,
    "end_line" INTEGER NOT NULL,
    "start_column" INTEGER NOT NULL,
    "end_column" INTEGER NOT NULL,
    "container_name" VARCHAR(255),
    "signature" TEXT,
    "commit_sha" VARCHAR(40) NOT NULL,
    "ingestion_attempt" INTEGER NOT NULL DEFAULT 0,
    "is_active" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "code_symbols_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "code_relationships" (
    "id" UUID NOT NULL,
    "branch_index_id" UUID NOT NULL,
    "from_symbol_id" UUID,
    "to_symbol_id" UUID,
    "type" VARCHAR(32) NOT NULL,
    "file_path" VARCHAR(1024) NOT NULL,
    "start_line" INTEGER NOT NULL,
    "end_line" INTEGER NOT NULL,
    "reference_name" VARCHAR(255) NOT NULL,
    "target_module" VARCHAR(1024),
    "is_resolved" BOOLEAN NOT NULL DEFAULT false,
    "resolution_error" VARCHAR(255),
    "metadata" JSONB,
    "commit_sha" VARCHAR(40) NOT NULL,
    "ingestion_attempt" INTEGER NOT NULL DEFAULT 0,
    "is_active" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "code_relationships_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "code_symbols_branch_index_id_idx" ON "code_symbols"("branch_index_id");
CREATE INDEX "code_symbols_branch_index_id_is_active_idx" ON "code_symbols"("branch_index_id", "is_active");
CREATE INDEX "code_symbols_branch_index_id_ingestion_attempt_idx" ON "code_symbols"("branch_index_id", "ingestion_attempt");
CREATE INDEX "code_symbols_branch_index_id_file_path_idx" ON "code_symbols"("branch_index_id", "file_path");
CREATE INDEX "code_symbols_branch_index_id_name_idx" ON "code_symbols"("branch_index_id", "name");

-- CreateIndex
CREATE INDEX "code_relationships_branch_index_id_idx" ON "code_relationships"("branch_index_id");
CREATE INDEX "code_relationships_branch_index_id_is_active_idx" ON "code_relationships"("branch_index_id", "is_active");
CREATE INDEX "code_relationships_branch_index_id_ingestion_attempt_idx" ON "code_relationships"("branch_index_id", "ingestion_attempt");
CREATE INDEX "code_relationships_from_symbol_id_idx" ON "code_relationships"("from_symbol_id");
CREATE INDEX "code_relationships_to_symbol_id_idx" ON "code_relationships"("to_symbol_id");
CREATE INDEX "code_relationships_branch_index_id_type_idx" ON "code_relationships"("branch_index_id", "type");

-- AddForeignKey
ALTER TABLE "code_symbols" ADD CONSTRAINT "code_symbols_branch_index_id_fkey" FOREIGN KEY ("branch_index_id") REFERENCES "branch_indexes"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "code_relationships" ADD CONSTRAINT "code_relationships_branch_index_id_fkey" FOREIGN KEY ("branch_index_id") REFERENCES "branch_indexes"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "code_relationships" ADD CONSTRAINT "code_relationships_from_symbol_id_fkey" FOREIGN KEY ("from_symbol_id") REFERENCES "code_symbols"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "code_relationships" ADD CONSTRAINT "code_relationships_to_symbol_id_fkey" FOREIGN KEY ("to_symbol_id") REFERENCES "code_symbols"("id") ON DELETE CASCADE ON UPDATE CASCADE;
