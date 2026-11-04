import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import {
  readVoyageRateLimitConfig,
  type VoyageRateLimitConfig,
} from "../config/voyageRateLimits.js";
import { createRedisConnection } from "../config/redis.js";
import {
  acquireVoyageCapacity,
  closeVoyageRateLimiter,
  VoyageRateLimitInvalidError,
  VoyageRateLimiterUnavailableError,
  VoyageRateLimitTimeoutError,
  type VoyageLimiterRedis,
} from "../services/voyageRateLimiter.js";

function testConfig(
  overrides: Partial<VoyageRateLimitConfig> = {},
): VoyageRateLimitConfig {
  return {
    ...readVoyageRateLimitConfig({}),
    scope: `test-${process.pid}-${Math.random().toString(16).slice(2)}`,
    maxRequestsPerWindow: 3,
    estimatedTokenBudgetPerWindow: 1000,
    maxTokensPerRequest: 250,
    minSpacingMs: 1,
    maxWaitMs: 2_000,
    windowMs: 400,
    ...overrides,
  };
}

const redis = createRedisConnection({
  maxRetriesPerRequest: 1,
  enableOfflineQueue: false,
  connectTimeout: 3_000,
  commandTimeout: 3_000,
  retryStrategy: (attempt) => (attempt > 2 ? null : 100),
});

redis.on("error", () => undefined);

before(async () => {
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error("Redis is not available for rate limiter tests.")),
      5_000,
    );
    if (redis.status === "ready") {
      clearTimeout(timer);
      resolve();
      return;
    }
    redis.once("ready", () => {
      clearTimeout(timer);
      resolve();
    });
    redis.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
});

after(async () => {
  await closeVoyageRateLimiter();
  try {
    await redis.quit();
  } catch {
    redis.disconnect();
  }
});

test("readVoyageRateLimitConfig rejects invalid or non-positive values", () => {
  assert.throws(
    () =>
      readVoyageRateLimitConfig({
        VOYAGE_MAX_REQUESTS_PER_MINUTE: "0",
      }),
    /VOYAGE_MAX_REQUESTS_PER_MINUTE must be a positive integer/,
  );
  assert.throws(
    () =>
      readVoyageRateLimitConfig({
        VOYAGE_RATE_LIMIT_SCOPE: "org/secret",
      }),
    /VOYAGE_RATE_LIMIT_SCOPE must be a non-empty identifier/,
  );
});

test("acquireVoyageCapacity rejects oversized token reservations immediately", async () => {
  let evalCalls = 0;
  const fakeRedis: VoyageLimiterRedis = {
    eval: async () => {
      evalCalls += 1;
      return [1, 0];
    },
    quit: async () => "OK",
    disconnect: () => undefined,
  };

  await assert.rejects(
    acquireVoyageCapacity(9_000, {
      redis: fakeRedis,
      config: testConfig({
        maxTokensPerRequest: 2500,
        estimatedTokenBudgetPerWindow: 8000,
      }),
    }),
    (err: unknown) =>
      err instanceof VoyageRateLimitInvalidError &&
      err.message.includes("exceeds the per-request limit"),
  );
  assert.equal(evalCalls, 0);
});

test("concurrent reservations respect RPM", async () => {
  const config = testConfig({
    maxRequestsPerWindow: 2,
    estimatedTokenBudgetPerWindow: 10_000,
    minSpacingMs: 1,
    windowMs: 1_500,
    maxWaitMs: 400,
  });

  const results = await Promise.allSettled([
    acquireVoyageCapacity(1, { redis, config }),
    acquireVoyageCapacity(1, { redis, config }),
    acquireVoyageCapacity(1, { redis, config }),
  ]);

  const fulfilled = results.filter((result) => result.status === "fulfilled");
  const timedOut = results.filter(
    (result) =>
      result.status === "rejected" &&
      result.reason instanceof VoyageRateLimitTimeoutError,
  );

  assert.equal(fulfilled.length, 2);
  assert.equal(timedOut.length, 1);
});

test("concurrent reservations respect TPM", async () => {
  const config = testConfig({
    maxRequestsPerWindow: 10,
    estimatedTokenBudgetPerWindow: 100,
    maxTokensPerRequest: 80,
    minSpacingMs: 1,
    windowMs: 1_200,
    maxWaitMs: 250,
  });

  const results = await Promise.allSettled([
    acquireVoyageCapacity(70, { redis, config }),
    acquireVoyageCapacity(70, { redis, config }),
  ]);

  const fulfilled = results.filter((result) => result.status === "fulfilled");
  const timedOut = results.filter(
    (result) =>
      result.status === "rejected" &&
      result.reason instanceof VoyageRateLimitTimeoutError,
  );

  assert.equal(fulfilled.length, 1);
  assert.equal(timedOut.length, 1);
});

test("acquireVoyageCapacity enforces minimum request spacing", async () => {
  const config = testConfig({
    maxRequestsPerWindow: 10,
    estimatedTokenBudgetPerWindow: 10_000,
    minSpacingMs: 120,
    windowMs: 1_000,
    maxWaitMs: 1_000,
  });

  const started = Date.now();
  await acquireVoyageCapacity(1, { redis, config });
  await acquireVoyageCapacity(1, { redis, config });
  const elapsed = Date.now() - started;
  assert.ok(elapsed >= 110, `expected spacing of ~120ms, waited ${elapsed}ms`);
});

test("old reservations expire after the rolling window", async () => {
  const config = testConfig({
    maxRequestsPerWindow: 1,
    estimatedTokenBudgetPerWindow: 10_000,
    minSpacingMs: 1,
    windowMs: 200,
    maxWaitMs: 50,
  });

  await acquireVoyageCapacity(1, { redis, config });
  await assert.rejects(
    acquireVoyageCapacity(1, { redis, config }),
    (err: unknown) => err instanceof VoyageRateLimitTimeoutError,
  );

  await new Promise((resolve) => setTimeout(resolve, 250));
  await acquireVoyageCapacity(1, {
    redis,
    config: { ...config, maxWaitMs: 200 },
  });
});

test("acquireVoyageCapacity times out when capacity stays unavailable", async () => {
  const config = testConfig({
    maxRequestsPerWindow: 1,
    estimatedTokenBudgetPerWindow: 10_000,
    minSpacingMs: 1,
    windowMs: 2_000,
    maxWaitMs: 80,
  });

  await acquireVoyageCapacity(1, { redis, config });
  const started = Date.now();
  await assert.rejects(
    acquireVoyageCapacity(1, { redis, config }),
    (err: unknown) => err instanceof VoyageRateLimitTimeoutError,
  );
  const elapsed = Date.now() - started;
  assert.ok(elapsed < 500, `timeout waited too long: ${elapsed}ms`);
});

test("Redis connection failure does not reserve capacity and fails closed", async () => {
  await assert.rejects(
    acquireVoyageCapacity(10, {
      redis: {
        status: "end",
        eval: async () => {
          throw new Error("should not eval while Redis is unavailable");
        },
        quit: async () => "OK",
        disconnect: () => undefined,
      },
    }),
    (err: unknown) => err instanceof VoyageRateLimiterUnavailableError,
  );

  await assert.rejects(
    acquireVoyageCapacity(10, {
      redis: {
        eval: async () => {
          throw new Error("connect ECONNREFUSED");
        },
        quit: async () => "OK",
        disconnect: () => undefined,
      },
      config: testConfig({ maxWaitMs: 200 }),
    }),
    (err: unknown) => err instanceof VoyageRateLimiterUnavailableError,
  );
});
