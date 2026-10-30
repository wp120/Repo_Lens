import test from "node:test";
import assert from "node:assert/strict";
import {
  generateVoyageEmbeddings,
  getVoyageApiKey,
  VoyageEmbeddingError,
  VOYAGE_DIMENSIONS,
} from "../services/voyageEmbedding.js";

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

test("generateVoyageEmbeddings returns empty array for empty inputs", async () => {
  const result = await generateVoyageEmbeddings([]);
  assert.deepEqual(result, []);
});

test("generateVoyageEmbeddings generates embeddings and validates 1024 dimensions", async () => {
  const mockVector = Array.from({ length: 1024 }, (_, i) => i * 0.001);
  const fakeClient = {
    async embed(req: { input: string[] }) {
      return {
        data: req.input.map((_, idx) => ({
          embedding: [...mockVector],
          index: idx,
        })),
      };
    },
  };

  const inputs = ["function test() {}", "class MyClass {}"];
  const results = await generateVoyageEmbeddings(inputs, {
    client: fakeClient,
    maxBatchSize: 1,
  });

  assert.equal(results.length, 2);
  assert.equal(results[0].length, VOYAGE_DIMENSIONS);
  assert.equal(results[1].length, VOYAGE_DIMENSIONS);
  assert.equal(results[0][0], 0);
  assert.equal(results[0][1], 0.001);
});

test("generateVoyageEmbeddings rejects embeddings with wrong dimensions", async () => {
  const fakeClient = {
    async embed(req: { input: string[] }) {
      return {
        data: req.input.map((_, idx) => ({
          embedding: Array(512).fill(0.1), // Wrong dimensions!
          index: idx,
        })),
      };
    },
  };

  await assert.rejects(
    generateVoyageEmbeddings(["code snippet"], {
      client: fakeClient,
      maxRetries: 0,
    }),
    /invalid dimensions or non-finite values/,
  );
});

test("generateVoyageEmbeddings detects incomplete batch response", async () => {
  const fakeClient = {
    async embed() {
      return {
        data: [], // Empty data when 2 inputs were expected
      };
    },
  };

  await assert.rejects(
    generateVoyageEmbeddings(["code 1", "code 2"], {
      client: fakeClient,
      maxRetries: 0,
    }),
    /incomplete embedding batch/,
  );
});

test("generateVoyageEmbeddings aborts immediately without retrying on 401 auth failure", async () => {
  let callCount = 0;
  const fakeClient = {
    async embed() {
      callCount++;
      const error = new Error("Unauthorized");
      (error as unknown as { status: number }).status = 401;
      throw error;
    },
  };

  await assert.rejects(
    generateVoyageEmbeddings(["code"], {
      client: fakeClient,
      maxRetries: 3,
    }),
    /Voyage AI authentication failed/,
  );

  assert.equal(callCount, 1);
});

test("generateVoyageEmbeddings retries on 429 rate limit with bounded backoff", async () => {
  let callCount = 0;
  const mockVector = Array(1024).fill(0.05);

  const fakeClient = {
    async embed(req: { input: string[] }) {
      callCount++;
      if (callCount < 3) {
        const error = new Error("Rate limit exceeded");
        (error as unknown as { status: number }).status = 429;
        throw error;
      }
      return {
        data: req.input.map((_, idx) => ({
          embedding: mockVector,
          index: idx,
        })),
      };
    },
  };

  const results = await generateVoyageEmbeddings(["code"], {
    client: fakeClient,
    maxRetries: 3,
    initialBackoffMs: 10,
  });

  assert.equal(callCount, 3);
  assert.equal(results.length, 1);
  assert.equal(results[0].length, 1024);
});
