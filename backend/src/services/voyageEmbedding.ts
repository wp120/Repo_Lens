import { VoyageAIClient } from "voyageai";

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

export interface VoyageEmbeddingConfig {
  apiKey?: string;
  maxBatchSize?: number;
  maxRetries?: number;
  initialBackoffMs?: number;
  client?: {
    embed: (request: {
      model: string;
      input: string[];
      inputType?: "query" | "document";
      outputDimension?: number;
      outputDtype?: "float";
      truncation?: boolean;
    }) => Promise<{
      data?: Array<{
        embedding?: number[];
        index?: number;
      }>;
    }>;
  };
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

  const maxBatchSize = Math.min(
    Math.max(1, config.maxBatchSize ?? VOYAGE_DEFAULT_BATCH_SIZE),
    128,
  );
  const maxRetries = config.maxRetries ?? VOYAGE_MAX_RETRIES;
  const initialBackoffMs = config.initialBackoffMs ?? VOYAGE_INITIAL_BACKOFF_MS;

  const client =
    config.client ??
    new VoyageAIClient({
      apiKey: config.apiKey ?? getVoyageApiKey(),
    });

  const allEmbeddings: number[][] = [];

  for (let i = 0; i < texts.length; i += maxBatchSize) {
    const batch = texts.slice(i, i + maxBatchSize);
    const batchEmbeddings = await embedBatchWithRetry(
      client,
      batch,
      maxRetries,
      initialBackoffMs,
    );
    allEmbeddings.push(...batchEmbeddings);
  }

  return allEmbeddings;
}

async function embedBatchWithRetry(
  client: NonNullable<VoyageEmbeddingConfig["client"]>,
  batch: string[],
  maxRetries: number,
  initialBackoffMs: number,
): Promise<number[][]> {
  let attempt = 0;

  while (true) {
    try {
      const response = await client.embed({
        model: VOYAGE_MODEL,
        input: batch,
        inputType: "document",
        outputDimension: VOYAGE_DIMENSIONS,
        outputDtype: "float",
        truncation: false,
      });

      const data = response.data;
      if (!Array.isArray(data) || data.length !== batch.length) {
        throw new VoyageEmbeddingError(
          `Voyage AI returned an incomplete embedding batch (expected ${batch.length}, received ${data?.length ?? 0}).`,
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

      const isRateLimit =
        typeof error === "object" &&
        error !== null &&
        "status" in error &&
        (error as { status: number }).status === 429;

      const isAuthError =
        typeof error === "object" &&
        error !== null &&
        "status" in error &&
        ((error as { status: number }).status === 401 ||
          (error as { status: number }).status === 403);

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
      const delay =
        initialBackoffMs * Math.pow(2, attempt - 1) + Math.random() * 100;
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }
}
