ALTER TABLE "branch_indexes"
ADD COLUMN "ingestion_attempt" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN "last_error" TEXT;

CREATE TABLE "user_branch_ingestions" (
    "user_id" UUID NOT NULL,
    "branch_index_id" UUID NOT NULL,
    "initiated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "user_branch_ingestions_pkey" PRIMARY KEY ("user_id", "branch_index_id")
);

CREATE INDEX "user_branch_ingestions_user_id_idx"
ON "user_branch_ingestions"("user_id");

ALTER TABLE "user_branch_ingestions"
ADD CONSTRAINT "user_branch_ingestions_user_id_fkey"
FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "user_branch_ingestions"
ADD CONSTRAINT "user_branch_ingestions_branch_index_id_fkey"
FOREIGN KEY ("branch_index_id") REFERENCES "branch_indexes"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
