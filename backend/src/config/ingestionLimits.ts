function positiveInteger(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined) return fallback;

  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer.`);
  }
  return value;
}

export const ingestionLimits = {
  lifetimeIngestionsPerUser: positiveInteger(
    "REPOLENS_LIFETIME_INGESTION_LIMIT",
    5,
  ),
  repositorySizeKb: positiveInteger("REPOLENS_MAX_REPOSITORY_SIZE_KB", 102400),
  indexableFileCount: positiveInteger("REPOLENS_MAX_INDEXABLE_FILES", 10000),
  indexableSourceBytes: positiveInteger(
    "REPOLENS_MAX_INDEXABLE_SOURCE_BYTES",
    52428800,
  ),
};
