# Background jobs

BullMQ and Redis are used to enqueue repository ingestion requests on the
`repository-ingestion` queue. The indexing worker is intentionally not part of
this feature and must be implemented separately.

The pre-ingestion MVP limits are centralized in `src/config/ingestionLimits.ts`
and can be overridden with positive integer environment variables:

| Variable                              |  Default | Meaning                                                            |
| ------------------------------------- | -------: | ------------------------------------------------------------------ |
| `REPOLENS_LIFETIME_INGESTION_LIMIT`   |        5 | Distinct branch ingestions initiated by a user over their lifetime |
| `REPOLENS_MAX_REPOSITORY_SIZE_KB`     |   102400 | GitHub repository size in KB                                       |
| `REPOLENS_MAX_INDEXABLE_FILES`        |    10000 | Tracked source files in a branch                                   |
| `REPOLENS_MAX_INDEXABLE_SOURCE_BYTES` | 52428800 | Combined GitHub-reported size of tracked source files              |
| `REPOLENS_MAX_FILE_SIZE_BYTES`        |  1048576 | Maximum allowed size in bytes for an individual indexable file     |
| `REPOLENS_MAX_CHUNK_CHARS`            |     2500 | Maximum character length of a code chunk                           |
| `REPOLENS_MIN_CHUNK_CHARS`            |       50 | Minimum character threshold before combining small units           |
| `REPOLENS_CHUNK_OVERLAP_LINES`        |        3 | Line overlap for bounded fallback line-based chunking              |

GitHub tree truncation triggers a non-recursive traversal fallback; if the repository
cannot be completely and reliably validated, ingestion fails closed. The indexing
worker repeats applicable file, individual file, and content limits while processing.
