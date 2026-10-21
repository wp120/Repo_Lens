import { useState } from "react";
import type {
  ChatMessage,
  Conversation,
  Repository,
  RepositoryBranch,
} from "../types/app";
import { Icon } from "./Icon";
import { MessageComposer } from "./MessageComposer";

interface ConversationPanelProps {
  conversation: Conversation | null;
  branch: RepositoryBranch | null;
  repository: Repository | null;
  onAddRepository: () => void;
  hasRepositories: boolean;
}

export function ConversationPanel({
  conversation,
  branch,
  repository,
  onAddRepository,
  hasRepositories,
}: ConversationPanelProps) {
  const [draft, setDraft] = useState("");

  if (!repository && !conversation && !hasRepositories) {
    return (
      <section className="welcome-panel">
        <div className="welcome-panel-icon">
          <Icon name="spark" />
        </div>
        <p className="eyebrow">WELCOME TO REPOLENS</p>
        <h1>Your codebase, understood.</h1>
        <p>
          Connect a repository to explore its structure, ask questions, and
          trace answers back to source.
        </p>
        <button
          className="button-primary"
          onClick={onAddRepository}
          type="button"
        >
          <Icon name="add" />
          Add repository
        </button>
        <div className="welcome-steps">
          <span>
            <b>01</b> Connect GitHub
          </span>
          <span>
            <b>02</b> Choose a branch
          </span>
          <span>
            <b>03</b> Explore your code
          </span>
        </div>
      </section>
    );
  }

  if (!repository && !conversation) {
    return (
      <section className="no-conversation">
        <div className="welcome-panel-icon">
          <Icon name="message" />
        </div>
        <p className="eyebrow">YOUR WORKSPACE</p>
        <h1>Select a conversation</h1>
        <p>Choose a conversation from the sidebar or start a new one.</p>
      </section>
    );
  }

  if (branch?.status === "indexing" && repository) {
    return (
      <section className="branch-state">
        <span className="indexing-illustration">
          <span />
        </span>
        <p className="eyebrow">PREPARING YOUR CODE</p>
        <h1>Indexing {repository.name}</h1>
        <p>
          The <strong>{branch.name}</strong> branch is being prepared. You can
          start exploring as soon as indexing is complete.
        </p>
        <div className="progress-track">
          <span />
        </div>
        <span className="state-caption">Indexing in progress</span>
      </section>
    );
  }

  if (branch?.status === "failed" && repository) {
    return (
      <section className="branch-state branch-failed">
        <div className="failed-icon">!</div>
        <p className="eyebrow">INDEXING INTERRUPTED</p>
        <h1>We couldn’t prepare this branch.</h1>
        <p>
          Indexing for{" "}
          <strong>
            {repository.name}/{branch.name}
          </strong>{" "}
          did not complete. The repository service is not connected, so retry is
          not available yet.
        </p>
      </section>
    );
  }

  if (!conversation || !branch || !repository) {
    return (
      <section className="no-conversation">
        <div className="welcome-panel-icon">
          <Icon name="message" />
        </div>
        <h1>Select a conversation</h1>
        <p>Choose a conversation from the sidebar or start a new one.</p>
      </section>
    );
  }

  return (
    <section
      aria-label={`Conversation ${conversation.title}`}
      className="conversation-panel"
    >
      <div className="conversation-topline">
        <div className="conversation-breadcrumb">
          <span>
            {repository.owner}/{repository.name}
          </span>
          <span className="breadcrumb-divider">/</span>
          <span>
            <Icon name="branch" /> {branch.name}
          </span>
        </div>
        <span className="branch-ready">
          <span /> Indexed
        </span>
      </div>

      {conversation.messages.length === 0 && !conversation.isLoading ? (
        <div className="empty-chat">
          <div className="empty-chat-icon">
            <Icon name="spark" />
          </div>
          <h1>Start a conversation</h1>
          <p>
            Ask a question about <strong>{repository.name}</strong> on{" "}
            <strong>{branch.name}</strong>.
          </p>
          <div className="suggestion-chips">
            <button
              type="button"
              onClick={() => setDraft("How is this repository organized?")}
            >
              How is this repository organized?
            </button>
            <button
              type="button"
              onClick={() => setDraft("Where does the application start?")}
            >
              Where does the application start?
            </button>
          </div>
        </div>
      ) : (
        <div className="messages-scroll">
          <div className="conversation-title">
            <span className="conversation-title-tag">CONVERSATION</span>
            <h1>{conversation.title}</h1>
            <p>On {branch.name}</p>
          </div>
          {conversation.messages.map((message) => (
            <MessageBubble key={message.id} message={message} />
          ))}
          {conversation.isLoading && (
            <div className="message-row assistant-row" aria-live="polite">
              <span className="assistant-avatar">
                <Icon name="spark" />
              </span>
              <div
                className="typing-indicator"
                aria-label="Assistant is responding"
              >
                <i />
                <i />
                <i />
              </div>
            </div>
          )}
        </div>
      )}
      <MessageComposer
        disabled={conversation.isLoading}
        message={draft}
        onMessageChange={setDraft}
      />
    </section>
  );
}

function MessageBubble({ message }: { message: ChatMessage }) {
  const isAssistant = message.role === "assistant";
  return (
    <article
      className={`message-row ${isAssistant ? "assistant-row" : "user-row"}`}
    >
      <span className={isAssistant ? "assistant-avatar" : "user-avatar"}>
        {isAssistant ? <Icon name="spark" /> : "A"}
      </span>
      <div className="message-content">
        <div className="message-meta">
          <strong>{isAssistant ? "RepoLens" : "You"}</strong>
          <time>{message.createdAt}</time>
        </div>
        <p>{message.content}</p>
        {message.citations?.length ? (
          <div className="citation-list" aria-label="Source citations">
            {message.citations.map((citation) =>
              isCommitSpecificGitHubUrl(citation.url) ? (
                <a
                  href={citation.url}
                  key={citation.url}
                  rel="noopener noreferrer"
                  target="_blank"
                >
                  <Icon name="code" />
                  {citation.label}
                  <Icon name="external" />
                </a>
              ) : (
                <span className="citation-unavailable" key={citation.url}>
                  <Icon name="code" /> {citation.label}
                </span>
              ),
            )}
          </div>
        ) : null}
      </div>
    </article>
  );
}

function isCommitSpecificGitHubUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return (
      url.protocol === "https:" &&
      url.hostname === "github.com" &&
      /\/(?:commit|blob|tree)\/[0-9a-f]{7,40}(?:\/|$)/i.test(url.pathname)
    );
  } catch {
    return false;
  }
}
