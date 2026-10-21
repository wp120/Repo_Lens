import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { authService } from "../services/authService";
import { AuthContext } from "./auth-context";
import type { User } from "../types/app";

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    const restoreSession = async () => {
      if (import.meta.env.DEV) {
        const { devMockAuthService } =
          await import("../services/devMockAuthService");
        return devMockAuthService.getSession();
      }
      return authService.getSession();
    };

    restoreSession()
      .then((sessionUser) => {
        if (active) setUser(sessionUser);
      })
      .catch((reason: unknown) => {
        if (active) setError(toErrorMessage(reason));
      })
      .finally(() => {
        if (active) setIsLoading(false);
      });

    return () => {
      active = false;
    };
  }, []);

  const authenticate = useCallback(async (operation: () => Promise<User>) => {
    setError(null);
    setIsLoading(true);
    try {
      setUser(await operation());
    } catch (reason) {
      const message = toErrorMessage(reason);
      setError(message);
      throw reason instanceof Error
        ? reason
        : new Error(message, { cause: reason });
    } finally {
      setIsLoading(false);
    }
  }, []);

  const signIn = useCallback(
    (email: string, password: string) =>
      authenticate(() => authService.signIn(email, password)),
    [authenticate],
  );

  const register = useCallback(
    (name: string, email: string, password: string) =>
      authenticate(() => authService.register(name, email, password)),
    [authenticate],
  );

  const signOut = useCallback(async () => {
    setError(null);
    setIsLoading(true);
    try {
      if (import.meta.env.DEV && user?.id === "preview-user") {
        const { devMockAuthService } =
          await import("../services/devMockAuthService");
        await devMockAuthService.signOut();
      } else {
        await authService.signOut();
      }
      setUser(null);
    } catch (reason) {
      const message = toErrorMessage(reason);
      setError(message);
      throw reason instanceof Error
        ? reason
        : new Error(message, { cause: reason });
    } finally {
      setIsLoading(false);
    }
  }, [user]);

  const enterDevelopmentPreview = useCallback(async () => {
    if (!import.meta.env.DEV) return false;
    const { devMockAuthService } =
      await import("../services/devMockAuthService");
    await authenticate(() => devMockAuthService.signIn("", ""));
    return true;
  }, [authenticate]);

  const value = useMemo(
    () => ({
      user,
      isLoading,
      error,
      signIn,
      register,
      signOut,
      enterDevelopmentPreview,
    }),
    [
      user,
      isLoading,
      error,
      signIn,
      register,
      signOut,
      enterDevelopmentPreview,
    ],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

function toErrorMessage(reason: unknown): string {
  return reason instanceof Error ? reason.message : "Something went wrong.";
}
