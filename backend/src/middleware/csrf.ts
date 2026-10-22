import { randomBytes, timingSafeEqual } from "node:crypto";
import type { RequestHandler } from "express";
import { isAllowedFrontendOrigin } from "../config/session.js";

export const getCsrfToken: RequestHandler = (request, response, next) => {
  if (!request.session.csrfToken) {
    request.session.csrfToken = randomBytes(32).toString("hex");
  }
  request.session.save((error) => {
    if (error) {
      next(error);
      return;
    }
    response.json({ csrfToken: request.session.csrfToken });
  });
};

export const requireCsrf: RequestHandler = (request, response, next) => {
  if (!isAllowedFrontendOrigin(request.get("origin"))) {
    response.status(403).json({ error: "Request origin is not allowed." });
    return;
  }

  const expected = request.session.csrfToken;
  const provided = request.get("x-csrf-token");
  if (!expected || !provided || !safeEqual(expected, provided)) {
    response.status(403).json({ error: "Invalid or missing CSRF token." });
    return;
  }

  next();
};

function safeEqual(expected: string, provided: string): boolean {
  const expectedBuffer = Buffer.from(expected);
  const providedBuffer = Buffer.from(provided);
  return (
    expectedBuffer.length === providedBuffer.length &&
    timingSafeEqual(expectedBuffer, providedBuffer)
  );
}
