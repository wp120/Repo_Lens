import { randomUUID } from "node:crypto";
import type { Redis } from "ioredis";
import { createRedisConnection } from "../config/redis.js";
import {
  voyageRateLimits,
  type VoyageRateLimitConfig,
} from "../config/voyageRateLimits.js";

export class VoyageRateLimitTimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "VoyageRateLimitTimeoutError";
  }
}

export class VoyageRateLimiterUnavailableError extends Error {
  constructor(message: string, readonly cause?: unknown) {
    super(message);
    this.name = "VoyageRateLimiterUnavailableError";
  }
}

export class VoyageRateLimitInvalidError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "VoyageRateLimitInvalidError";
  }
}

export interface VoyageLimiterRedis {
  eval(
    script: string,
    numkeys: number,
    ...args: (string | number)[]
  ): Promise<unknown>;
  status?: string;
  on?(event: string, listener: (...args: unknown[]) => void): unknown;
  once?(event: string, listener: (...args: unknown[]) => void): unknown;
  off?(event: string, listener: (...args: unknown[]) => void): unknown;
  quit(): Promise<unknown>;
  disconnect(): void;
}

export interface AcquireVoyageCapacityOptions {
  redis?: VoyageLimiterRedis;
  config?: VoyageRateLimitConfig;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

/**
 * Atomic reservation: prune the rolling window, check RPM/TPM/spacing, then
 * either record a new reservation or return the wait until capacity opens.
 * Time comes from Redis TIME, not the application clock.
 */
const VOYAGE_RATE_LIMIT_LUA = `
local now_sec, now_usec = unpack(redis.call('TIME'))
local now_ms = tonumber(now_sec) * 1000 + math.floor(tonumber(now_usec) / 1000)
local reservation_id = ARGV[1]
local request_tokens = tonumber(ARGV[2])
local window_ms = tonumber(ARGV[3])
local max_rpm = tonumber(ARGV[4])
local max_tpm = tonumber(ARGV[5])
local min_spacing = tonumber(ARGV[6])
local ttl_ms = tonumber(ARGV[7])
local cutoff = now_ms - window_ms

local expired = redis.call('ZRANGEBYSCORE', KEYS[1], '-inf', cutoff)
for i, id in ipairs(expired) do
  redis.call('HDEL', KEYS[2], id)
end
redis.call('ZREMRANGEBYSCORE', KEYS[1], '-inf', cutoff)

local members = redis.call('ZRANGE', KEYS[1], 0, -1, 'WITHSCORES')
local count = 0
local tokens = 0
for i = 1, #members, 2 do
  count = count + 1
  local cost = tonumber(redis.call('HGET', KEYS[2], members[i]) or '0')
  tokens = tokens + cost
end

local wait_spacing = 0
if count > 0 then
  local last_ts = tonumber(members[#members])
  local elapsed = now_ms - last_ts
  if elapsed < min_spacing then
    wait_spacing = math.max(1, min_spacing - elapsed)
  end
end

local wait_rpm = 0
if count >= max_rpm then
  local oldest_ts = tonumber(members[2])
  wait_rpm = math.max(1, oldest_ts + window_ms - now_ms)
end

local wait_tpm = 0
if tokens + request_tokens > max_tpm then
  local needed = tokens + request_tokens - max_tpm
  local freed = 0
  for i = 1, #members, 2 do
    local cost = tonumber(redis.call('HGET', KEYS[2], members[i]) or '0')
    freed = freed + cost
    wait_tpm = math.max(1, tonumber(members[i + 1]) + window_ms - now_ms)
    if freed >= needed then
      break
    end
  end
end

local wait_ms = math.max(wait_spacing, wait_rpm, wait_tpm)
if wait_ms > 0 then
  return {0, math.ceil(wait_ms)}
end

redis.call('ZADD', KEYS[1], now_ms, reservation_id)
redis.call('HSET', KEYS[2], reservation_id, request_tokens)
redis.call('PEXPIRE', KEYS[1], ttl_ms)
redis.call('PEXPIRE', KEYS[2], ttl_ms)
return {1, 0}
`;

let moduleRedis: Redis | undefined;

function attachLimiterErrorHandler(redis: VoyageLimiterRedis): void {
  redis.on?.("error", () => {
    // Command failures surface limiter unavailability; do not crash the process.
  });
}

function getVoyageRateLimiterRedis(): Redis {
  if (!moduleRedis) {
    moduleRedis = createRedisConnection({
      maxRetriesPerRequest: 1,
      enableOfflineQueue: false,
      connectTimeout: 5_000,
      commandTimeout: 5_000,
      retryStrategy: (attempt) =>
        attempt > 3 ? null : Math.min(attempt * 250, 1000),
    });
    attachLimiterErrorHandler(moduleRedis);
  }
  return moduleRedis;
}

async function waitForRedisReady(
  redis: VoyageLimiterRedis,
  timeoutMs: number,
): Promise<void> {
  if (redis.status === "ready" || redis.status === undefined) {
    return;
  }

  if (redis.status === "end" || redis.status === "close") {
    throw new VoyageRateLimiterUnavailableError(
      "Voyage embedding rate limiter is unavailable because Redis is not connected.",
    );
  }

  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(
        new VoyageRateLimiterUnavailableError(
          "Voyage embedding rate limiter timed out while connecting to Redis.",
        ),
      );
    }, timeoutMs);

    const onReady = () => {
      cleanup();
      resolve();
    };
    const onFailure = () => {
      cleanup();
      reject(
        new VoyageRateLimiterUnavailableError(
          "Voyage embedding rate limiter is unavailable because Redis is not connected.",
        ),
      );
    };
    const cleanup = () => {
      clearTimeout(timer);
      redis.off?.("ready", onReady);
      redis.off?.("error", onFailure);
      redis.off?.("end", onFailure);
      redis.off?.("close", onFailure);
    };

    redis.once?.("ready", onReady);
    redis.once?.("error", onFailure);
    redis.once?.("end", onFailure);
    redis.once?.("close", onFailure);

    if (redis.status === "ready") {
      cleanup();
      resolve();
    }
  });
}

function reservationKeys(scope: string): { zsetKey: string; hashKey: string } {
  return {
    zsetKey: `repolens:voyage:${scope}:reservations`,
    hashKey: `repolens:voyage:${scope}:costs`,
  };
}

function parseReservationResult(raw: unknown): {
  allowed: boolean;
  waitMs: number;
} {
  if (!Array.isArray(raw) || raw.length < 2) {
    throw new VoyageRateLimiterUnavailableError(
      "Voyage embedding rate limiter returned an unexpected Redis result.",
    );
  }

  const waitMs = Math.ceil(Number(raw[1]));
  if (!Number.isFinite(waitMs)) {
    throw new VoyageRateLimiterUnavailableError(
      "Voyage embedding rate limiter returned a non-numeric wait interval.",
    );
  }

  return {
    allowed: Number(raw[0]) === 1,
    waitMs: Math.max(0, waitMs),
  };
}

async function defaultSleep(ms: number): Promise<void> {
  if (ms <= 0) return;
  await new Promise((resolve) => setTimeout(resolve, ms));
}

export async function acquireVoyageCapacity(
  estimatedTokens: number,
  options: AcquireVoyageCapacityOptions = {},
): Promise<void> {
  const config = options.config ?? voyageRateLimits;

  if (!Number.isFinite(estimatedTokens) || estimatedTokens < 0) {
    throw new VoyageRateLimitInvalidError(
      `Voyage embedding reservation token cost must be a non-negative finite number (received ${estimatedTokens}).`,
    );
  }

  if (
    estimatedTokens > config.maxTokensPerRequest ||
    estimatedTokens > config.estimatedTokenBudgetPerWindow
  ) {
    throw new VoyageRateLimitInvalidError(
      `Requested Voyage embedding reservation of ${estimatedTokens} estimated tokens exceeds the per-request limit of ${config.maxTokensPerRequest} or the rolling-window budget of ${config.estimatedTokenBudgetPerWindow}.`,
    );
  }

  const redis = options.redis ?? getVoyageRateLimiterRedis();
  const sleep = options.sleep ?? defaultSleep;
  const now = options.now ?? Date.now;
  const deadline = now() + config.maxWaitMs;
  const { zsetKey, hashKey } = reservationKeys(config.scope);
  const ttlMs = config.windowMs + Math.max(config.minSpacingMs, 1000);

  try {
    await waitForRedisReady(redis, Math.min(config.maxWaitMs, 5_000));
  } catch (error) {
    if (error instanceof VoyageRateLimiterUnavailableError) {
      throw error;
    }
    throw new VoyageRateLimiterUnavailableError(
      "Voyage embedding rate limiter is unavailable because Redis is not connected.",
      error,
    );
  }

  while (true) {
    const remainingMs = deadline - now();
    if (remainingMs <= 0) {
      throw new VoyageRateLimitTimeoutError(
        `Voyage embedding rate limiter timed out after ${config.maxWaitMs}ms waiting for capacity.`,
      );
    }

    let raw: unknown;
    try {
      raw = await redis.eval(
        VOYAGE_RATE_LIMIT_LUA,
        2,
        zsetKey,
        hashKey,
        randomUUID(),
        estimatedTokens,
        config.windowMs,
        config.maxRequestsPerWindow,
        config.estimatedTokenBudgetPerWindow,
        config.minSpacingMs,
        ttlMs,
      );
    } catch (error) {
      if (error instanceof VoyageRateLimiterUnavailableError) {
        throw error;
      }
      throw new VoyageRateLimiterUnavailableError(
        "Voyage embedding rate limiter is unavailable because Redis could not complete the reservation.",
        error,
      );
    }

    const result = parseReservationResult(raw);
    if (result.allowed) {
      return;
    }

    const waitMs = Math.min(Math.max(result.waitMs, 1), remainingMs);
    const jitter = Math.floor(Math.random() * Math.min(25, waitMs));
    await sleep(Math.min(waitMs + jitter, remainingMs));
  }
}

export async function closeVoyageRateLimiter(): Promise<void> {
  const client = moduleRedis;
  moduleRedis = undefined;
  if (!client) return;

  try {
    await client.quit();
  } catch {
    client.disconnect();
  }
}
