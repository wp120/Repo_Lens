interface CsrfResponse {
  csrfToken: string;
}

export async function apiRequest<T>(
  path: string,
  init: RequestInit = {},
): Promise<T> {
  const response = await fetch(`${import.meta.env.VITE_API_URL ?? ""}${path}`, {
    ...init,
    credentials: "include",
    headers: {
      Accept: "application/json",
      ...init.headers,
    },
  });

  if (response.status === 204) return undefined as T;
  const payload: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const message =
      typeof payload === "object" &&
      payload !== null &&
      "error" in payload &&
      typeof payload.error === "string"
        ? payload.error
        : "The request could not be completed.";
    throw new Error(message);
  }
  return payload as T;
}

export async function apiMutate<T>(
  path: string,
  body?: Record<string, string>,
): Promise<T> {
  const { csrfToken } = await apiRequest<CsrfResponse>("/api/auth/csrf");
  return apiRequest<T>(path, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-CSRF-Token": csrfToken,
    },
    body: body ? JSON.stringify(body) : undefined,
  });
}
