import test from "node:test";
import assert from "node:assert/strict";
import { VoyageAIError } from "voyageai";
import {
  buildVoyageEmbeddingBatches,
  estimateVoyageTokens,
  generateVoyageEmbeddings,
  getVoyageApiKey,
  VoyageEmbeddingError,
  VOYAGE_DIMENSIONS,
} from "../services/voyageEmbedding.js";
import {
  VoyageRateLimiterUnavailableError,
  VoyageRateLimitInvalidError,
} from "../services/voyageRateLimiter.js";

function mockVector(fill = 0.05): number[] {
  return Array(VOYAGE_DIMENSIONS).fill(fill);
}

function vectorForIndex(index: number): number[] {
  const vector = mockVector(0);
  vector[0] = index;
  return vector;
}

test("getVoyageApiKey throws VoyageEmbeddingError when key is missing or empty", () => {
  const original = process.env.VOYAGE_API_KEY;
  try {
    delete process.env.VOYAGE_API_KEY;
    assert.throws(
      () => getVoyageApiKey(),
      (err: unknown) =>
        err instanceof VoyageEmbeddingError &&
        err.message.includes("VOYAGE_API_KEY is not configured"),
    );

    process.env.VOYAGE_API_KEY = "   ";
    assert.throws(
      () => getVoyageApiKey(),
      (err: unknown) =>
        err instanceof VoyageEmbeddingError &&
        err.message.includes("VOYAGE_API_KEY is not configured"),
    );
  } finally {
    if (original !== undefined) {
      process.env.VOYAGE_API_KEY = original;
    } else {
      delete process.env.VOYAGE_API_KEY;
    }
  }
});

test("estimateVoyageTokens uses ceil(length / 4) as a conservative approximation", () => {
  assert.equal(estimateVoyageTokens(""), 0);
  assert.equal(estimateVoyageTokens("abcd"), 1);
  assert.equal(estimateVoyageTokens("abcde"), 2);
});

test("buildVoyageEmbeddingBatches greedily packs by estimated tokens and input count", () => {
  const texts = [
    "a".repeat(8000), // 2000 tokens
    "b".repeat(1600), // 400 tokens
    "c".repeat(1600), // 400 tokens
    "d".repeat(4), // 1 token
  ];

  const batches = buildVoyageEmbeddingBatches(texts, {
    maxInputsPerRequest: 10,
    maxTokensPerRequest: 2500,
  });

  assert.equal(batches.length, 2);
  assert.deepEqual(batches[0].texts, [texts[0], texts[1]]);
  assert.equal(batches[0].estimatedTokens, 2400);
  assert.deepEqual(batches[1].texts, [texts[2], texts[3]]);
  assert.equal(batches[1].estimatedTokens, 401);
});

test("buildVoyageEmbeddingBatches enforces maximum input count", () => {
  const texts = ["abcd", "efgh", "ijkl"];
  const batches = buildVoyageEmbeddingBatches(texts, {
    maxInputsPerRequest: 2,
    maxTokensPerRequest: 2500,
  });

  assert.equal(batches.length, 2);
  assert.deepEqual(batches[0].texts, ["abcd", "efgh"]);
  assert.deepEqual(batches[1].texts, ["ijkl"]);
});

test("buildVoyageEmbeddingBatches rejects an oversized individual input", () => {
  assert.throws(
    () =>
      buildVoyageEmbeddingBatches(["x".repeat(10_004)], {
        maxInputsPerRequest: 100,
        maxTokensPerRequest: 2500,
      }),
    (err: unknown) =>
      err instanceof VoyageRateLimitInvalidError &&
      err.message.includes("exceeds the per-request budget"),
  );
});

test("generateVoyageEmbeddings returns empty array for empty inputs", async () => {
  const result = await generateVoyageEmbeddings([]);
  assert.deepEqual(result, []);
});

test("generateVoyageEmbeddings generates embeddings and validates 1024 dimensions", async () => {
  const fakeClient = {
    async embed(req: { input: string[] }) {
      return {
        data: req.input.map((_, idx) => ({
          embedding: vectorForIndex(idx),
          index: idx,
        })),
      };
    },
  };

  const inputs = ["function test() {}", "class MyClass {}"];
  const results = await generateVoyageEmbeddings(inputs, {
    client: fakeClient,
    acquireCapacity: async () => undefined,
    maxBatchSize: 1,
  });

  assert.equal(results.length, 2);
  assert.equal(results[0].length, VOYAGE_DIMENSIONS);
  assert.equal(results[1].length, VOYAGE_DIMENSIONS);
  assert.equal(results[0][0], 0);
  assert.equal(results[1][0], 1);
});

test("generateVoyageEmbeddings preserves input order across token-aware batches", async () => {
  const receivedBatches: string[][] = [];
  const fakeClient = {
    async embed(req: { input: string[] }) {
      receivedBatches.push([...req.input]);
      return {
        data: [...req.input]
          .map((_, idx) => ({
            embedding: vectorForIndex(idx + receivedBatches.length * 10),
            index: idx,
          }))
          .reverse(),
      };
    },
  };

  const inputs = ["a".repeat(8000), "b".repeat(1600), "c".repeat(1600)];
  const results = await generateVoyageEmbeddings(inputs, {
    client: fakeClient,
    acquireCapacity: async () => undefined,
    maxTokensPerRequest: 2500,
    maxBatchSize: 10,
  });

  assert.deepEqual(receivedBatches, [
    [inputs[0], inputs[1]],
    [inputs[2]],
  ]);
  assert.equal(results.length, 3);
  assert.equal(results[0][0], 10);
  assert.equal(results[1][0], 11);
  assert.equal(results[2][0], 20);
});

test("generateVoyageEmbeddings acquires capacity before every API attempt including retries", async () => {
  const acquisitions: number[] = [];
  let callCount = 0;
  const fakeClient = {
    async embed(req: { input: string[] }, requestOptions?: { maxRetries?: number }) {
      assert.equal(requestOptions?.maxRetries, 0);
      callCount += 1;
      if (callCount < 3) {
        throw new VoyageAIError({
          message: "Rate limit exceeded",
          statusCode: 429,
        });
      }
      return {
        data: req.input.map((_, idx) => ({
          embedding: mockVector(),
          index: idx,
        })),
      };
    },
  };

  const input = "abcd";
  const results = await generateVoyageEmbeddings([input], {
    client: fakeClient,
    maxRetries: 3,
    initialBackoffMs: 1,
    maxBackoffMs: 5,
    acquireCapacity: async (tokens) => {
      acquisitions.push(tokens);
    },
  });

  assert.equal(callCount, 3);
  assert.deepEqual(acquisitions, [1, 1, 1]);
  assert.equal(results.length, 1);
  assert.equal(results[0].length, VOYAGE_DIMENSIONS);
});

test("generateVoyageEmbeddings does not call Voyage when Redis capacity cannot be reserved", async () => {
  let embedCalls = 0;
  const fakeClient = {
    async embed() {
      embedCalls += 1;
      return { data: [] };
    },
  };

  await assert.rejects(
    generateVoyageEmbeddings(["code"], {
      client: fakeClient,
      acquireCapacity: async () => {
        throw new VoyageRateLimiterUnavailableError(
          "Voyage embedding rate limiter is unavailable because Redis could not complete the reservation.",
        );
      },
    }),
    (err: unknown) => err instanceof VoyageRateLimiterUnavailableError,
  );

  assert.equal(embedCalls, 0);
});

test("generateVoyageEmbeddings rejects embeddings with wrong dimensions without retrying", async () => {
  let callCount = 0;
  const fakeClient = {
    async embed(req: { input: string[] }) {
      callCount += 1;
      return {
        data: req.input.map((_, idx) => ({
          embedding: Array(512).fill(0.1),
          index: idx,
        })),
      };
    },
  };

  await assert.rejects(
    generateVoyageEmbeddings(["code snippet"], {
      client: fakeClient,
      acquireCapacity: async () => undefined,
      maxRetries: 3,
    }),
    /invalid dimensions or non-finite values/,
  );
  assert.equal(callCount, 1);
});

test("generateVoyageEmbeddings detects incomplete batch response without retrying", async () => {
  let callCount = 0;
  const fakeClient = {
    async embed() {
      callCount += 1;
      return {
        data: [],
      };
    },
  };

  await assert.rejects(
    generateVoyageEmbeddings(["code 1", "code 2"], {
      client: fakeClient,
      acquireCapacity: async () => undefined,
      maxRetries: 3,
    }),
    /incomplete embedding batch/,
  );
  assert.equal(callCount, 1);
});

test("generateVoyageEmbeddings aborts immediately without retrying on 401 auth failure", async () => {
  let callCount = 0;
  const fakeClient = {
    async embed() {
      callCount += 1;
      throw new VoyageAIError({
        message: "Unauthorized",
        statusCode: 401,
      });
    },
  };

  await assert.rejects(
    generateVoyageEmbeddings(["code"], {
      client: fakeClient,
      acquireCapacity: async () => undefined,
      maxRetries: 3,
    }),
    /Voyage AI authentication failed/,
  );

  assert.equal(callCount, 1);
});

test("generateVoyageEmbeddings respects Retry-After and makes at most four attempts", async () => {
  let callCount = 0;
  const delays: number[] = [];
  const originalSetTimeout = globalThis.setTimeout;
  const fakeSetTimeout = ((
    handler: TimerHandler,
    timeout?: number,
    ...args: unknown[]
  ) => {
    delays.push(timeout ?? 0);
    if (typeof handler === "function") {
      handler(...args);
    }
    return 0;
  }) as typeof setTimeout;
  globalThis.setTimeout = fakeSetTimeout;

  try {
    const fakeClient = {
      async embed() {
        callCount += 1;
        throw new VoyageAIError({
          message: "Rate limit exceeded",
          statusCode: 429,
          rawResponse: {
            headers: {
              get(name: string) {
                return name.toLowerCase() === "retry-after" ? "1" : null;
              },
            },
          } as never,
        });
      },
    };

    await assert.rejects(
      generateVoyageEmbeddings(["code"], {
        client: fakeClient,
        acquireCapacity: async () => undefined,
        maxRetries: 3,
        initialBackoffMs: 10,
        maxBackoffMs: 50,
      }),
      (err: unknown) =>
        err instanceof VoyageEmbeddingError &&
        err.statusCode === 429 &&
        err.message.includes("after 4 attempts"),
    );

    assert.equal(callCount, 4);
    assert.equal(delays.length, 3);
    for (const delay of delays) {
      assert.equal(delay, 1000);
    }
  } finally {
    globalThis.setTimeout = originalSetTimeout;
  }
});
