CREATE EXTENSION IF NOT EXISTS vector;

-- CreateTable
CREATE TABLE "code_chunks" (
    "id" UUID NOT NULL,
    "branch_index_id" UUID NOT NULL,
    "file_path" VARCHAR(1024) NOT NULL,
    "content" TEXT NOT NULL,
    "start_line" INTEGER NOT NULL,
    "end_line" INTEGER NOT NULL,
    "language" VARCHAR(64) NOT NULL,
    "symbol_name" VARCHAR(255),
    "commit_sha" VARCHAR(40) NOT NULL,
    "embedding" vector(1024) NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "code_chunks_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "code_chunks_branch_index_id_idx" ON "code_chunks"("branch_index_id");

-- CreateIndex
CREATE INDEX "code_chunks_branch_index_id_file_path_idx" ON "code_chunks"("branch_index_id", "file_path");

-- AddForeignKey
ALTER TABLE "code_chunks" ADD CONSTRAINT "code_chunks_branch_index_id_fkey" FOREIGN KEY ("branch_index_id") REFERENCES "branch_indexes"("id") ON DELETE CASCADE ON UPDATE CASCADE;
