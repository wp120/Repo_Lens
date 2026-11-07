ALTER TABLE "code_chunks"
  ADD COLUMN "symbol_type" VARCHAR(32),
  ADD COLUMN "class_name" VARCHAR(255),
  ADD COLUMN "function_signature" TEXT;
