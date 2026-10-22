import { createContext } from "react";
import type { User } from "../types/app";

export interface AuthContextValue {
  user: User | null;
  isLoading: boolean;
  error: string | null;
  signIn(email: string, password: string): Promise<void>;
  register(email: string, password: string): Promise<void>;
  signOut(): Promise<void>;
}

export const AuthContext = createContext<AuthContextValue | null>(null);
