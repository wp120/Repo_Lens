function positiveInteger(
  env: NodeJS.ProcessEnv,
  name: string,
  fallback: number,
): number {
  const raw = env[name];
  if (raw === undefined) return fallback;

  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer.`);
  }
  return value;
}

function rateLimitScope(
  env: NodeJS.ProcessEnv,
  name: string,
  fallback: string,
): string {
  const raw = env[name];
  const value = (raw === undefined ? fallback : raw).trim();
  if (!/^[A-Za-z0-9_-]+$/.test(value)) {
    throw new Error(
      `${name} must be a non-empty identifier using letters, digits, underscores, or hyphens.`,
    );
  }
  return value;
}

export interface VoyageRateLimitConfig {
  /** Stable, non-secret identifier for the shared Voyage organization quota. */
  scope: string;
  maxRequestsPerWindow: number;
  estimatedTokenBudgetPerWindow: number;
  maxTokensPerRequest: number;
  minSpacingMs: number;
  maxWaitMs: number;
  maxInputsPerRequest: number;
  maxRetries: number;
  initialBackoffMs: number;
  maxBackoffMs: number;
  windowMs: number;
}

export function readVoyageRateLimitConfig(
  env: NodeJS.ProcessEnv = process.env,
): VoyageRateLimitConfig {
  return {
    scope: rateLimitScope(env, "VOYAGE_RATE_LIMIT_SCOPE", "default"),
    maxRequestsPerWindow: positiveInteger(
      env,
      "VOYAGE_MAX_REQUESTS_PER_MINUTE",
      3,
    ),
    estimatedTokenBudgetPerWindow: positiveInteger(
      env,
      "VOYAGE_ESTIMATED_TOKEN_BUDGET_PER_MINUTE",
      8000,
    ),
    maxTokensPerRequest: positiveInteger(
      env,
      "VOYAGE_MAX_TOKENS_PER_REQUEST",
      2500,
    ),
    minSpacingMs: positiveInteger(env, "VOYAGE_MIN_REQUEST_SPACING_MS", 22_000),
    maxWaitMs: positiveInteger(env, "VOYAGE_RATE_LIMIT_MAX_WAIT_MS", 120_000),
    maxInputsPerRequest: positiveInteger(env, "VOYAGE_MAX_EMBEDDING_INPUTS", 100),
    maxRetries: positiveInteger(env, "VOYAGE_MAX_RETRIES", 3),
    initialBackoffMs: positiveInteger(env, "VOYAGE_INITIAL_BACKOFF_MS", 300),
    maxBackoffMs: positiveInteger(env, "VOYAGE_MAX_BACKOFF_MS", 8000),
    windowMs: 60_000,
  };
}

export const voyageRateLimits = readVoyageRateLimitConfig();
