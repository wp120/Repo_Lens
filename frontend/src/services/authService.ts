import type { User } from "../types/app";

interface AuthResponse {
  user: Omit<User, "name">;
}

interface CsrfResponse {
  csrfToken: string;
}

export interface AuthService {
  getSession(): Promise<User | null>;
  signIn(email: string, password: string): Promise<User>;
  register(email: string, password: string): Promise<User>;
  signOut(): Promise<void>;
}

export const authService: AuthService = {
  async getSession() {
    const result = await request<{ user: AuthResponse["user"] | null }>(
      "/api/auth/me",
    );
    return result.user ? toUser(result.user) : null;
  },
  async signIn(email, password) {
    const result = await mutate<AuthResponse>("/api/auth/login", {
      email: normalizeEmail(email),
      password,
    });
    return toUser(result.user);
  },
  async register(email, password) {
    const result = await mutate<AuthResponse>("/api/auth/register", {
      email: normalizeEmail(email),
      password,
    });
    return toUser(result.user);
  },
  async signOut() {
    await mutate<void>("/api/auth/logout");
  },
};

async function mutate<T>(
  path: string,
  body?: Record<string, string>,
): Promise<T> {
  const { csrfToken } = await request<CsrfResponse>("/api/auth/csrf");
  return request<T>(path, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-CSRF-Token": csrfToken,
    },
    body: body ? JSON.stringify(body) : undefined,
  });
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
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

function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

function toUser(user: AuthResponse["user"]): User {
  return {
    ...user,
    name: user.email.split("@")[0],
  };
}
