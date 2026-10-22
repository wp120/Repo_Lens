import "./loadEnv.js";
import { createClient } from "redis";
import { RedisStore } from "connect-redis";
import session from "express-session";

const sessionSecret = process.env.SESSION_SECRET;
if (!sessionSecret || sessionSecret.length < 32) {
  throw new Error("SESSION_SECRET must contain at least 32 characters.");
}

const frontendOrigin = process.env.FRONTEND_ORIGIN ?? "http://127.0.0.1:5173";
const sessionTtlSeconds = 60 * 60 * 24 * 7;
const secureCookie =
  process.env.COOKIE_SECURE === "true" ||
  (process.env.COOKIE_SECURE !== "false" &&
    process.env.NODE_ENV === "production");
if (process.env.NODE_ENV === "production" && !secureCookie) {
  throw new Error("COOKIE_SECURE=true is required in production.");
}

export const sessionRedis = createClient({
  url: process.env.REDIS_URL ?? "redis://localhost:6379",
  socket: {
    reconnectStrategy: (retries) => Math.min(retries * 250, 3000),
  },
});

export const sessionCookieName =
  process.env.SESSION_COOKIE_NAME ?? "repolens.sid";

sessionRedis.on("error", () => {
  console.error("Session Redis connection error.");
});

export const sessionMiddleware = session({
  name: sessionCookieName,
  secret: sessionSecret,
  store: new RedisStore({
    client: sessionRedis,
    prefix: "repolens:sess:",
    ttl: sessionTtlSeconds,
  }),
  resave: false,
  saveUninitialized: false,
  rolling: true,
  cookie: {
    ...getSessionCookieOptions(),
    maxAge: sessionTtlSeconds * 1000,
  },
});

export function getSessionCookieOptions() {
  return {
    httpOnly: true,
    secure: secureCookie,
    sameSite: getSameSite(),
    path: "/",
  };
}

export function isAllowedFrontendOrigin(origin: string | undefined): boolean {
  return origin === frontendOrigin;
}

export function getFrontendOrigin(): string {
  return frontendOrigin;
}

function getSameSite(): boolean | "lax" | "strict" | "none" {
  const value = process.env.COOKIE_SAME_SITE ?? "lax";
  if (value !== "lax" && value !== "strict" && value !== "none") {
    throw new Error("COOKIE_SAME_SITE must be lax, strict, or none.");
  }
  if (value === "none" && !secureCookie) {
    throw new Error(
      "COOKIE_SECURE=true is required when COOKIE_SAME_SITE=none.",
    );
  }
  return value;
}
