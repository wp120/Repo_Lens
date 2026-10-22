import rateLimit from "express-rate-limit";

const rateLimitOptions = {
  windowMs: 15 * 60 * 1000,
  limit: 10,
  standardHeaders: "draft-8" as const,
  legacyHeaders: false,
  message: { error: "Too many authentication attempts. Try again later." },
};

export const loginRateLimiter = rateLimit(rateLimitOptions);
export const registrationRateLimiter = rateLimit({
  ...rateLimitOptions,
  limit: 5,
});
