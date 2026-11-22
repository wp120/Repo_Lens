ALTER TABLE branch_indexes
  ADD COLUMN repository_file_paths JSONB,
  ADD COLUMN pending_repository_file_paths JSONB;
