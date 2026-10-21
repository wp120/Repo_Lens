import type { ReactNode } from "react";
import { Link } from "react-router-dom";
import { Icon } from "./Icon";

export function AuthPageFrame({
  title,
  subtitle,
  children,
}: {
  title: string;
  subtitle: string;
  children: ReactNode;
}) {
  return (
    <main className="auth-page">
      <div className="auth-background-grid" />
      <header className="auth-header">
        <Link className="app-brand" to="/" aria-label="RepoLens home">
          <span className="app-brand-mark">
            <Icon name="code" />
          </span>
          <span>RepoLens</span>
        </Link>
        <span>Repository intelligence, made clear.</span>
      </header>
      <section className="auth-card">
        <div className="auth-card-heading">
          <span className="auth-heading-mark">
            <Icon name="spark" />
          </span>
          <h1>{title}</h1>
          <p>{subtitle}</p>
        </div>
        {children}
      </section>
      <footer className="auth-footer">© 2026 RepoLens</footer>
    </main>
  );
}
