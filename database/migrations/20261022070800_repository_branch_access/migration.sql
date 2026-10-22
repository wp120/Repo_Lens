CREATE TABLE "repositories" (
    "id" UUID NOT NULL,
    "github_repo_id" BIGINT NOT NULL,
    "owner" VARCHAR(255) NOT NULL,
    "name" VARCHAR(255) NOT NULL,
    "html_url" VARCHAR(2048) NOT NULL,
    "default_branch" VARCHAR(255) NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "repositories_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "branch_indexes" (
    "id" UUID NOT NULL,
    "repository_id" UUID NOT NULL,
    "branch_name" VARCHAR(255) NOT NULL,
    "status" VARCHAR(32) NOT NULL DEFAULT 'queued',
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "branch_indexes_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "user_branch_access" (
    "user_id" UUID NOT NULL,
    "branch_index_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "user_branch_access_pkey" PRIMARY KEY ("user_id", "branch_index_id")
);

CREATE UNIQUE INDEX "repositories_github_repo_id_key" ON "repositories"("github_repo_id");
CREATE UNIQUE INDEX "branch_indexes_repository_id_branch_name_key" ON "branch_indexes"("repository_id", "branch_name");
CREATE INDEX "user_branch_access_branch_index_id_idx" ON "user_branch_access"("branch_index_id");

ALTER TABLE "branch_indexes"
ADD CONSTRAINT "branch_indexes_repository_id_fkey"
FOREIGN KEY ("repository_id") REFERENCES "repositories"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "user_branch_access"
ADD CONSTRAINT "user_branch_access_user_id_fkey"
FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "user_branch_access"
ADD CONSTRAINT "user_branch_access_branch_index_id_fkey"
FOREIGN KEY ("branch_index_id") REFERENCES "branch_indexes"("id") ON DELETE CASCADE ON UPDATE CASCADE;
