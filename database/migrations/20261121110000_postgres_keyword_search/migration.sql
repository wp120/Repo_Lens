ALTER TABLE "code_chunks"
  ADD COLUMN "search_vector" tsvector
  GENERATED ALWAYS AS (
    setweight(to_tsvector('english', coalesce(file_path, '')), 'A')
    || setweight(
      to_tsvector(
        'english',
        coalesce(symbol_name, '') || ' ' ||
        coalesce(class_name, '') || ' ' ||
        coalesce(function_signature, '')
      ),
      'B'
    )
    || setweight(to_tsvector('english', coalesce(content, '')), 'C')
  ) STORED;

CREATE INDEX "code_chunks_search_vector_idx"
  ON "code_chunks" USING GIN ("search_vector");

CREATE INDEX "code_chunks_branch_class_name_idx"
  ON "code_chunks" ("branch_index_id", "class_name");

CREATE INDEX "code_chunks_branch_symbol_name_idx"
  ON "code_chunks" ("branch_index_id", "symbol_name");

CREATE INDEX "code_chunks_branch_symbol_type_idx"
  ON "code_chunks" ("branch_index_id", "symbol_type");

CREATE INDEX "code_chunks_branch_language_idx"
  ON "code_chunks" ("branch_index_id", "language");
