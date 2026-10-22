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

  if (isBadRequestError(error)) {
    response.status(error.status).json({ error: error.message });
    return;
  }

  console.error("Unhandled request error:", getErrorName(error));
  response.status(500).json({ error: "Internal server error" });
};

function isBadRequestError(
  error: unknown,
): error is Error & { status: 400 | 413 } {
  return (
    error instanceof Error &&
    "status" in error &&
    (error.status === 400 || error.status === 413)
  );
}

function getErrorName(error: unknown): string {
  return error instanceof Error ? error.name : "UnknownError";
}
