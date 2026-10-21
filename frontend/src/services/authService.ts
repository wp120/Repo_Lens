import type { User } from "../types/app";

export interface AuthService {
  getSession(): Promise<User | null>;
  signIn(email: string, password: string): Promise<User>;
  register(name: string, email: string, password: string): Promise<User>;
  signOut(): Promise<void>;
}

export const authService: AuthService = {
  async getSession() {
    return null;
  },
  async signIn() {
    throw new Error("Authentication is not connected yet.");
  },
  async register() {
    throw new Error("Registration is not connected yet.");
  },
  async signOut() {
    throw new Error("Authentication is not connected yet.");
  },
};
