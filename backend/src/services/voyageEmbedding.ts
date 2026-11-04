import { VoyageAIClient, VoyageAIError } from "voyageai";
import { voyageRateLimits } from "../config/voyageRateLimits.js";
import {
  acquireVoyageCapacity,
  VoyageRateLimitInvalidError,
} from "./voyageRateLimiter.js";
import { estimateVoyageTokens } from "./tokenEstimator.js";

export { estimateVoyageTokens } from "./tokenEstimator.js";

export class VoyageEmbeddingError extends Error {
  constructor(
    message: string,
    readonly statusCode: number = 500,
    readonly cause?: unknown,
  ) {
    super(message);
    this.name = "VoyageEmbeddingError";
  }
}

export const VOYAGE_MODEL = "voyage-code-4";
export const VOYAGE_DIMENSIONS = 1024;
export const VOYAGE_DEFAULT_BATCH_SIZE = 100;
export const VOYAGE_MAX_RETRIES = 3;
export const VOYAGE_INITIAL_BACKOFF_MS = 300;

export interface VoyageEmbedRequest {
  model: string;
  input: string[];
  inputType?: "query" | "document";
  outputDimension?: number;
  outputDtype?: "float";
  truncation?: boolean;
}

export interface VoyageEmbeddingConfig {
  apiKey?: string;
  maxBatchSize?: number;
  maxRetries?: number;
  initialBackoffMs?: number;
  maxBackoffMs?: number;
  maxTokensPerRequest?: number;
  acquireCapacity?: (estimatedTokens: number) => Promise<void>;
  client?: {
    embed: (
      request: VoyageEmbedRequest,
      requestOptions?: { maxRetries?: number },
    ) => Promise<{
      data?: Array<{
        embedding?: number[];
        index?: number;
      }>;
    }>;
  };
}

export interface VoyageEmbeddingBatch {
  texts: string[];
  estimatedTokens: number;
}

export function buildVoyageEmbeddingBatches(
  texts: string[],
  options: {
    maxInputsPerRequest: number;
    maxTokensPerRequest: number;
  },
): VoyageEmbeddingBatch[] {
  const batches: VoyageEmbeddingBatch[] = [];
  let current: VoyageEmbeddingBatch = { texts: [], estimatedTokens: 0 };

  for (const text of texts) {
    const tokens = estimateVoyageTokens(text);
    if (tokens > options.maxTokensPerRequest) {
      throw new VoyageRateLimitInvalidError(
        `An embedding input of ${text.length} characters (~${tokens} estimated tokens) exceeds the per-request budget of ${options.maxTokensPerRequest} estimated tokens. Inputs are not truncated or split because each embedding must map to one CodeChunk.`,
      );
    }

    const wouldExceedCount =
      current.texts.length >= options.maxInputsPerRequest;
    const wouldExceedTokens =
      current.estimatedTokens + tokens > options.maxTokensPerRequest;
    if (
      current.texts.length > 0 &&
      (wouldExceedCount || wouldExceedTokens)
    ) {
      batches.push(current);
      current = { texts: [], estimatedTokens: 0 };
    }

    current.texts.push(text);
    current.estimatedTokens += tokens;
  }

  if (current.texts.length > 0) {
    batches.push(current);
  }

  return batches;
}

export function getVoyageApiKey(): string {
  const key = process.env.VOYAGE_API_KEY;
  if (!key || !key.trim()) {
    throw new VoyageEmbeddingError("VOYAGE_API_KEY is not configured.", 500);
  }
  return key.trim();
}

export async function generateVoyageEmbeddings(
  texts: string[],
  config: VoyageEmbeddingConfig = {},
): Promise<number[][]> {
  if (texts.length === 0) return [];

  const maxBatchSize = config.maxBatchSize ?? voyageRateLimits.maxInputsPerRequest;
  if (!Number.isSafeInteger(maxBatchSize) || maxBatchSize <= 0) {
    throw new VoyageEmbeddingError(
      "Voyage embedding maxBatchSize must be a positive integer.",
      500,
    );
  }

  const maxTokensPerRequest =
    config.maxTokensPerRequest ?? voyageRateLimits.maxTokensPerRequest;
  const maxRetries = config.maxRetries ?? voyageRateLimits.maxRetries;
  const initialBackoffMs =
    config.initialBackoffMs ?? voyageRateLimits.initialBackoffMs;
  const maxBackoffMs = config.maxBackoffMs ?? voyageRateLimits.maxBackoffMs;
  const acquireCapacity = config.acquireCapacity ?? acquireVoyageCapacity;

  const client =
    config.client ??
    new VoyageAIClient({
      apiKey: config.apiKey ?? getVoyageApiKey(),
      maxRetries: 0,
    });

  const batches = buildVoyageEmbeddingBatches(texts, {
    maxInputsPerRequest: maxBatchSize,
    maxTokensPerRequest,
  });

  const allEmbeddings: number[][] = [];

  for (const batch of batches) {
    const batchEmbeddings = await embedBatchWithRetry(
      client,
      batch,
      maxRetries,
      initialBackoffMs,
      maxBackoffMs,
      acquireCapacity,
    );
    allEmbeddings.push(...batchEmbeddings);
  }

  return allEmbeddings;
}

function getErrorStatusCode(error: unknown): number | undefined {
  if (error instanceof VoyageAIError && error.statusCode !== undefined) {
    return error.statusCode;
  }

  if (typeof error === "object" && error !== null && "statusCode" in error) {
    const statusCode = (error as { statusCode: unknown }).statusCode;
    if (typeof statusCode === "number") {
      return statusCode;
    }
  }

  return undefined;
}

function readHeader(headers: unknown, name: string): string | undefined {
  if (!headers || typeof headers !== "object") {
    return undefined;
  }

  if (typeof (headers as { get?: unknown }).get === "function") {
    const value = (headers as { get: (key: string) => string | null }).get(
      name,
    );
    return value ?? undefined;
  }

  const record = headers as Record<string, unknown>;
  const direct = record[name] ?? record["Retry-After"] ?? record["retry-after"];
  return typeof direct === "string" ? direct : undefined;
}

function getRetryAfterMs(error: unknown): number | undefined {
  if (typeof error !== "object" || error === null) {
    return undefined;
  }

  const rawResponse = (error as { rawResponse?: { headers?: unknown } })
    .rawResponse;
  const value = readHeader(rawResponse?.headers, "retry-after");
  if (!value) {
    return undefined;
  }

  const asSeconds = Number(value);
  if (Number.isFinite(asSeconds) && asSeconds >= 0) {
    return asSeconds * 1000;
  }

  const asDate = Date.parse(value);
  if (!Number.isNaN(asDate)) {
    return Math.max(0, asDate - Date.now());
  }

  return undefined;
}

async function embedBatchWithRetry(
  client: NonNullable<VoyageEmbeddingConfig["client"]>,
  batch: VoyageEmbeddingBatch,
  maxRetries: number,
  initialBackoffMs: number,
  maxBackoffMs: number,
  acquireCapacity: (estimatedTokens: number) => Promise<void>,
): Promise<number[][]> {
  let attempt = 0;

  while (true) {
    await acquireCapacity(batch.estimatedTokens);

    try {
      const response = await client.embed(
        {
          model: VOYAGE_MODEL,
          input: batch.texts,
          inputType: "document",
          outputDimension: VOYAGE_DIMENSIONS,
          outputDtype: "float",
          truncation: false,
        },
        { maxRetries: 0 },
      );

      const data = response.data;
      if (!Array.isArray(data) || data.length !== batch.texts.length) {
        throw new VoyageEmbeddingError(
          `Voyage AI returned an incomplete embedding batch (expected ${batch.texts.length}, received ${data?.length ?? 0}).`,
          502,
        );
      }

      // Sort by index to ensure exact pairing with batch inputs
      const sorted = [...data].sort((a, b) => (a.index ?? 0) - (b.index ?? 0));
      const validatedVectors: number[][] = [];

      for (let j = 0; j < sorted.length; j++) {
        const item = sorted[j];
        const vector = item.embedding;
        if (
          !Array.isArray(vector) ||
          vector.length !== VOYAGE_DIMENSIONS ||
          !vector.every(
            (val) => typeof val === "number" && Number.isFinite(val),
          )
        ) {
          throw new VoyageEmbeddingError(
            `Voyage AI returned an embedding with invalid dimensions or non-finite values (expected ${VOYAGE_DIMENSIONS} floats).`,
            502,
          );
        }
        validatedVectors.push(vector);
      }

      return validatedVectors;
    } catch (error: unknown) {
      if (error instanceof VoyageEmbeddingError && error.statusCode === 502) {
        throw error;
      }

      const statusCode = getErrorStatusCode(error);
      const isRateLimit = statusCode === 429;
      const isAuthError = statusCode === 401 || statusCode === 403;

      if (isAuthError) {
        throw new VoyageEmbeddingError(
          "Voyage AI authentication failed. Check VOYAGE_API_KEY.",
          401,
          error,
        );
      }

      if (attempt >= maxRetries) {
        const message =
          error instanceof Error
            ? error.message
            : "Unknown Voyage AI embedding error";
        throw new VoyageEmbeddingError(
          `Voyage AI embedding failed after ${maxRetries + 1} attempts: ${message}`,
          isRateLimit ? 429 : 502,
          error,
        );
      }

      attempt += 1;
      const exponential =
        Math.min(
          maxBackoffMs,
          initialBackoffMs * Math.pow(2, attempt - 1),
        ) +
        Math.random() * 100;
      const retryAfterMs = isRateLimit ? getRetryAfterMs(error) : undefined;
      const delay =
        retryAfterMs !== undefined
          ? Math.min(retryAfterMs, maxBackoffMs)
          : exponential;
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }
}
