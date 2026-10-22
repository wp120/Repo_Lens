import "./loadEnv.js";
import { Redis, type RedisOptions } from "ioredis";

export function createRedisConnection(options: RedisOptions = {}): Redis {
  const url = process.env.REDIS_URL ?? "redis://localhost:6379";
  return new Redis(url, { ...options, maxRetriesPerRequest: null });
}
