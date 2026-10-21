import type { ErrorRequestHandler } from "express";

export const errorHandler: ErrorRequestHandler = (
  error,
  _request,
  response,
  next,
) => {
  if (response.headersSent) {
    next(error);
    return;
  }

  console.error("Unhandled request error:", error);
  response.status(500).json({ error: "Internal server error" });
};
