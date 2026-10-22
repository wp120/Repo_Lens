import { useState, type FormEvent } from "react";
import { Link, Navigate, useLocation, useNavigate } from "react-router-dom";
import { useAuth } from "../hooks/useAuth";
import { AuthPageFrame } from "../components/AuthPageFrame";

export function LoginPage() {
  const { user, signIn, isLoading, error } = useAuth();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [localError, setLocalError] = useState("");
  const navigate = useNavigate();
  const location = useLocation();
  const destination =
    (location.state as { from?: string } | null)?.from ?? "/dashboard";

  if (user) return <Navigate to="/dashboard" replace />;

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setLocalError("");
    try {
      await signIn(email, password);
      navigate(destination, { replace: true });
    } catch (reason) {
      setLocalError(
        reason instanceof Error ? reason.message : "Could not sign in.",
      );
    }
  }

  return (
    <AuthPageFrame subtitle="Your codebase, understood." title="Welcome back">
      <form className="auth-form" onSubmit={handleSubmit}>
        <label htmlFor="login-email">Email address</label>
        <input
          autoComplete="email"
          id="login-email"
          onChange={(event) => setEmail(event.target.value)}
          placeholder="you@company.com"
          required
          type="email"
          value={email}
        />
        <div className="auth-label-row">
          <label htmlFor="login-password">Password</label>
          <span>Forgot password?</span>
        </div>
        <input
          autoComplete="current-password"
          id="login-password"
          onChange={(event) => setPassword(event.target.value)}
          placeholder="Enter your password"
          required
          type="password"
          value={password}
        />
        {(localError || error) && (
          <p className="auth-error" role="alert">
            {localError || error}
          </p>
        )}
        <button
          className="button-primary auth-submit"
          disabled={isLoading}
          type="submit"
        >
          {isLoading ? "Signing in…" : "Sign in"}
        </button>
      </form>
      <p className="auth-switch">
        New to RepoLens? <Link to="/register">Create an account</Link>
      </p>
    </AuthPageFrame>
  );
}
