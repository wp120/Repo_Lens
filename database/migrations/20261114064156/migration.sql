/*
  Warnings:

  - You are about to drop the column `published_commit_sha` on the `code_chunks` table. All the data in the column will be lost.

*/
-- AlterTable
ALTER TABLE "branch_indexes" ADD COLUMN     "published_commit_sha" VARCHAR(40);

-- AlterTable
ALTER TABLE "code_chunks" DROP COLUMN "published_commit_sha",
ALTER COLUMN "embedding" DROP NOT NULL;

-- CreateIndex
CREATE INDEX "branch_indexes_status_idx" ON "branch_indexes"("status");

-- RenameIndex
ALTER INDEX "code_chunks_branch_index_id_ingestion_attempt_embedding_status_" RENAME TO "code_chunks_branch_index_id_ingestion_attempt_embedding_sta_idx";
