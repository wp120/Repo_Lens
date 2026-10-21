import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { useAuth } from "../hooks/useAuth";
import { Icon } from "./Icon";

export function AppHeader({
  onToggleSidebar,
}: {
  onToggleSidebar: () => void;
}) {
  const { user, signOut } = useAuth();
  const [menuOpen, setMenuOpen] = useState(false);
  const [message, setMessage] = useState("");
  const [githubConnectedPreview, setGitHubConnectedPreview] = useState(false);
  const navigate = useNavigate();

  async function handleLogout() {
    try {
      await signOut();
      navigate("/login");
    } catch (reason) {
      setMessage(
        reason instanceof Error ? reason.message : "Could not sign out.",
      );
    }
  }

  return (
    <header className="app-header">
      <button
        aria-label="Open navigation"
        className="icon-button mobile-menu-button"
        onClick={onToggleSidebar}
        type="button"
      >
        <Icon name="menu" />
      </button>
      <a
        className="app-brand"
        href="/dashboard"
        aria-label="RepoLens dashboard"
      >
        <span className="app-brand-mark">
          <Icon name="code" />
        </span>
        <span>RepoLens</span>
      </a>
      <div className="header-spacer" />
      <div className="github-connection">
        <span
          className={`connection-dot ${githubConnectedPreview ? "connected" : ""}`}
        />
        <span>
          {githubConnectedPreview
            ? "GitHub connected · Preview"
            : "GitHub not connected"}
        </span>
        <button
          className="text-button connect-button"
          onClick={() => {
            if (import.meta.env.DEV) {
              setGitHubConnectedPreview((connected) => !connected);
              setMessage(
                "Preview status only. No GitHub OAuth connection was made.",
              );
            } else {
              setMessage("GitHub connection will be available soon.");
            }
          }}
          type="button"
        >
          <Icon name="github" />
          {githubConnectedPreview ? "Disconnect" : "Connect"}
        </button>
      </div>
      <div className="account-wrap">
        <button
          aria-expanded={menuOpen}
          aria-haspopup="menu"
          className="account-button"
          onClick={() => setMenuOpen((open) => !open)}
          type="button"
        >
          <span className="avatar">{user?.name.slice(0, 1) ?? "U"}</span>
          <span className="account-name">{user?.name ?? "Account"}</span>
          <Icon name="chevron" />
        </button>
        {menuOpen && (
          <div className="account-menu" role="menu">
            <div className="account-menu-user">
              <strong>{user?.name}</strong>
              <span>{user?.email}</span>
            </div>
            {message && <p className="menu-error">{message}</p>}
            <button onClick={handleLogout} role="menuitem" type="button">
              Sign out
            </button>
          </div>
        )}
      </div>
      {message && !menuOpen && (
        <div className="header-notice" role="status">
          {message}
          <button
            aria-label="Dismiss message"
            onClick={() => setMessage("")}
            type="button"
          >
            <Icon name="close" />
          </button>
        </div>
      )}
    </header>
  );
}
