import { useState, type FormEvent } from "react";
import { Link, Navigate, useNavigate } from "react-router-dom";
import { AuthPageFrame } from "../components/AuthPageFrame";
import { useAuth } from "../hooks/useAuth";

export function RegisterPage() {
  const { user, register, isLoading, error } = useAuth();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [localError, setLocalError] = useState("");
  const navigate = useNavigate();

  if (user) return <Navigate to="/dashboard" replace />;

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setLocalError("");
    try {
      await register(email, password);
      navigate("/dashboard", { replace: true });
    } catch (reason) {
      setLocalError(
        reason instanceof Error
          ? reason.message
          : "Could not create your account.",
      );
    }
  }

  return (
    <AuthPageFrame
      subtitle="A clearer view of every codebase."
      title="Create your account"
    >
      <form className="auth-form" onSubmit={handleSubmit}>
        <label htmlFor="register-email">Email address</label>
        <input
          autoComplete="email"
          id="register-email"
          onChange={(event) => setEmail(event.target.value)}
          placeholder="you@company.com"
          required
          type="email"
          value={email}
        />
        <label htmlFor="register-password">Password</label>
        <input
          autoComplete="new-password"
          id="register-password"
          maxLength={72}
          minLength={8}
          onChange={(event) => setPassword(event.target.value)}
          placeholder="At least 8 characters"
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
          {isLoading ? "Creating account…" : "Create account"}
        </button>
      </form>
      <p className="auth-switch">
        Already have an account? <Link to="/login">Sign in</Link>
      </p>
    </AuthPageFrame>
  );
}
