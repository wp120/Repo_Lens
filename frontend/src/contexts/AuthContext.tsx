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
    authService
      .getSession()
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
    (email: string, password: string) =>
      authenticate(() => authService.register(email, password)),
    [authenticate],
  );

  const signOut = useCallback(async () => {
    setError(null);
    setIsLoading(true);
    try {
      await authService.signOut();
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
  }, []);

  const value = useMemo(
    () => ({
      user,
      isLoading,
      error,
      signIn,
      register,
      signOut,
    }),
    [user, isLoading, error, signIn, register, signOut],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

function toErrorMessage(reason: unknown): string {
  return reason instanceof Error ? reason.message : "Something went wrong.";
}
