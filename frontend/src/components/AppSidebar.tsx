import { useState } from "react";
import { NavLink, useNavigate } from "react-router-dom";
import type { Repository, RepositoryBranch } from "../types/app";
import { Icon } from "./Icon";

interface AppSidebarProps {
  repositories: Repository[];
  onRepositoriesChange: (repositories: Repository[]) => void;
  onAddRepository: () => void;
  isOpen: boolean;
  onClose: () => void;
}

export function AppSidebar({
  repositories,
  onRepositoriesChange,
  onAddRepository,
  isOpen,
  onClose,
}: AppSidebarProps) {
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [notice, setNotice] = useState("");
  const navigate = useNavigate();

  function createConversation(branch: RepositoryBranch) {
    const conversation = {
      id: `local-${crypto.randomUUID()}`,
      title: "New conversation",
      updatedAt: "Just now",
      messages: [],
    };
    onRepositoriesChange(
      repositories.map((repository) => ({
        ...repository,
        branches: repository.branches.map((item) =>
          item.id === branch.id
            ? { ...item, conversations: [conversation, ...item.conversations] }
            : item,
        ),
      })),
    );
    navigate(`/dashboard/${branch.id}/${conversation.id}`);
    onClose();
  }

  function removeBranch(branchName: string) {
    setNotice(
      `${branchName} was not removed. Branch management is not connected yet.`,
    );
  }

  return (
    <>
      {isOpen && (
        <button
          aria-label="Close navigation"
          className="sidebar-backdrop"
          onClick={onClose}
          type="button"
        />
      )}
      <aside className={`sidebar ${isOpen ? "sidebar-open" : ""}`}>
        <div className="sidebar-top">
          <NavLink
            className={({ isActive }) =>
              `sidebar-link ${isActive ? "sidebar-link-active" : ""}`
            }
            end
            onClick={onClose}
            to="/dashboard"
          >
            <Icon name="code" />
            <span>Overview</span>
          </NavLink>
        </div>

        <div className="sidebar-section-heading">
          <span>Repositories</span>
          <button
            aria-label="Add repository"
            className="icon-button tiny-icon-button"
            onClick={onAddRepository}
            type="button"
          >
            <Icon name="add" />
          </button>
        </div>

        <nav aria-label="Repositories" className="repository-nav">
          {repositories.map((repository) => (
            <div className="repository-group" key={repository.id}>
              <button
                aria-expanded={expanded[repository.id] ?? true}
                className="repository-heading"
                onClick={() =>
                  setExpanded((current) => ({
                    ...current,
                    [repository.id]: !(current[repository.id] ?? true),
                  }))
                }
                type="button"
              >
                <Icon name="chevron" className="repository-chevron" />
                <span className="repo-avatar">{repository.name[0]}</span>
                <span className="repository-name">{repository.name}</span>
                <span className="repository-owner">{repository.owner}</span>
              </button>
              {(expanded[repository.id] ?? true) &&
                repository.branches.map((branch) => (
                  <div className="branch-group" key={branch.id}>
                    <div className="branch-heading">
                      <Icon name="branch" />
                      <span className="branch-name" title={branch.name}>
                        {branch.name}
                      </span>
                      {branch.status !== "ready" && (
                        <span
                          className={`branch-status branch-status-${branch.status}`}
                          title={
                            branch.status === "indexing"
                              ? "Indexing"
                              : "Indexing failed"
                          }
                        />
                      )}
                      <button
                        aria-label={`Remove ${branch.name} branch`}
                        className="icon-button branch-action"
                        onClick={() => removeBranch(branch.name)}
                        type="button"
                      >
                        <Icon name="trash" />
                      </button>
                    </div>
                    {branch.status === "failed" && (
                      <NavLink
                        className="branch-state-link branch-state-error"
                        onClick={onClose}
                        to={`/dashboard/${branch.id}/status`}
                      >
                        Indexing failed · View details
                      </NavLink>
                    )}
                    {branch.status === "indexing" && (
                      <NavLink
                        className="branch-state-link"
                        onClick={onClose}
                        to={`/dashboard/${branch.id}/status`}
                      >
                        Indexing repository…
                      </NavLink>
                    )}
                    {branch.conversations.map((conversation) => (
                      <NavLink
                        className={({ isActive }) =>
                          `conversation-link ${isActive ? "conversation-active" : ""}`
                        }
                        key={conversation.id}
                        onClick={onClose}
                        to={`/dashboard/${branch.id}/${conversation.id}`}
                      >
                        <Icon name="message" />
                        <span>{conversation.title}</span>
                      </NavLink>
                    ))}
                    <button
                      className="new-conversation-button"
                      onClick={() => createConversation(branch)}
                      type="button"
                      disabled={branch.status !== "ready"}
                      title={
                        branch.status === "ready"
                          ? "Start a new conversation"
                          : "This branch is not ready yet"
                      }
                    >
                      <Icon name="add" />
                      New conversation
                    </button>
                  </div>
                ))}
            </div>
          ))}
          {repositories.length === 0 && (
            <div className="sidebar-empty">
              <p>No repositories connected.</p>
              <button
                className="text-button"
                onClick={onAddRepository}
                type="button"
              >
                Add your first repository
              </button>
            </div>
          )}
        </nav>

        <div className="sidebar-bottom">
          {notice && (
            <div className="sidebar-notice" role="status">
              {notice}
              <button
                aria-label="Dismiss message"
                onClick={() => setNotice("")}
                type="button"
              >
                <Icon name="close" />
              </button>
            </div>
          )}
          <button
            className="sidebar-link add-repository-button"
            onClick={onAddRepository}
            type="button"
          >
            <Icon name="add" />
            <span>Add repository</span>
          </button>
          <button
            className="sidebar-link settings-link"
            onClick={() =>
              setNotice("Workspace settings will be available soon.")
            }
            type="button"
          >
            <Icon name="settings" />
            <span>Settings</span>
          </button>
        </div>
      </aside>
    </>
  );
}
