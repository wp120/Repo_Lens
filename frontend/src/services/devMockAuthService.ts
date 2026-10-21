import type { AuthService } from "./authService";

const previewUser = {
  id: "preview-user",
  name: "Alex Morgan",
  email: "alex@example.dev",
};

const storageKey = "repolens-dev-preview";

export const devMockAuthService: AuthService = {
  async getSession() {
    if (!import.meta.env.DEV) return null;
    return sessionStorage.getItem(storageKey) ? previewUser : null;
  },
  async signIn() {
    if (!import.meta.env.DEV) throw new Error("Preview mode is unavailable.");
    sessionStorage.setItem(storageKey, "enabled");
    return previewUser;
  },
  async register() {
    if (!import.meta.env.DEV) throw new Error("Preview mode is unavailable.");
    sessionStorage.setItem(storageKey, "enabled");
    return previewUser;
  },
  async signOut() {
    if (!import.meta.env.DEV) throw new Error("Preview mode is unavailable.");
    sessionStorage.removeItem(storageKey);
  },
};
