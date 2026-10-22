import type { User } from "../types/app";
import { apiMutate, apiRequest } from "./apiClient";

interface AuthResponse {
  user: Omit<User, "name">;
}

export interface AuthService {
  getSession(): Promise<User | null>;
  signIn(email: string, password: string): Promise<User>;
  register(email: string, password: string): Promise<User>;
  signOut(): Promise<void>;
}

export const authService: AuthService = {
  async getSession() {
    const result = await apiRequest<{ user: AuthResponse["user"] | null }>(
      "/api/auth/me",
    );
    return result.user ? toUser(result.user) : null;
  },
  async signIn(email, password) {
    const result = await apiMutate<AuthResponse>("/api/auth/login", {
      email: normalizeEmail(email),
      password,
    });
    return toUser(result.user);
  },
  async register(email, password) {
    const result = await apiMutate<AuthResponse>("/api/auth/register", {
      email: normalizeEmail(email),
      password,
    });
    return toUser(result.user);
  },
  async signOut() {
    await apiMutate<void>("/api/auth/logout");
  },
};

function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

function toUser(user: AuthResponse["user"]): User {
  return {
    ...user,
    name: user.email.split("@")[0],
  };
}
