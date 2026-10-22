import { useState, type FormEvent } from "react";
import {
  repositoryService,
  toDashboardRepository,
  type AddRepositoryResult,
} from "../services/repositoryService";
import type { Repository } from "../types/app";
import { Icon } from "./Icon";

interface AddRepositoryModalProps {
  onClose: () => void;
  onRepositoryAttached: (repository: Repository) => void;
}

export function AddRepositoryModal({
  onClose,
  onRepositoryAttached,
}: AddRepositoryModalProps) {
  const [url, setUrl] = useState("");
  const [validationMessage, setValidationMessage] = useState("");
  const [requestError, setRequestError] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [addedRepository, setAddedRepository] = useState<{
    name: string;
    branchName: string;
  } | null>(null);
  const [confirmation, setConfirmation] = useState<Extract<
    AddRepositoryResult,
    { state: "confirmation_required" }
  > | null>(null);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setRequestError("");
    const validation = validateGitHubRepositoryUrl(url);
    if (validation) {
      setValidationMessage(validation);
      return;
    }

    setValidationMessage("");
    setIsSubmitting(true);
    try {
      const result = await repositoryService.addRepository(url.trim());
      if (result.state === "attached") {
        onRepositoryAttached(toDashboardRepository(result));
        setAddedRepository({
          name: result.repository.name,
          branchName: result.repository.branchName,
        });
      } else {
        setConfirmation(result);
      }
    } catch (reason) {
      setRequestError(
        reason instanceof Error
          ? reason.message
          : "Could not add this repository.",
      );
    } finally {
      setIsSubmitting(false);
    }
  }

  return (
    <div
      className="modal-backdrop"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <section
        aria-labelledby="add-repository-title"
        aria-modal="true"
        className="modal-card"
        role="dialog"
      >
        <div className="modal-heading">
          <div>
            <span className="modal-icon">
              <Icon name="github" />
            </span>
            <h2 id="add-repository-title">Add a repository</h2>
            <p>Connect a GitHub repository to explore its codebase.</p>
          </div>
          <button
            aria-label="Close dialog"
            className="icon-button"
            onClick={onClose}
            type="button"
          >
            <Icon name="close" />
          </button>
        </div>

        {addedRepository ? (
          <div className="repository-success" role="status">
            <span className="success-check">✓</span>
            <h3>{addedRepository.name} added to your dashboard</h3>
            <p>
              Branch: <strong>{addedRepository.branchName}</strong>
            </p>
            <button className="button-primary" onClick={onClose} type="button">
              Done
            </button>
          </div>
        ) : confirmation ? (
          <div className="repository-success">
            <span className="modal-icon">
              <Icon name="branch" />
            </span>
            <h3>
              {confirmation.repository.owner}/{confirmation.repository.name}
            </h3>
            <p>
              Branch to ingest:{" "}
              <strong>{confirmation.repository.branchName}</strong>
            </p>
            {confirmation.status === "failed" ? (
              <p role="status">
                Indexing previously failed for this branch. Retry processing is
                not available yet.
              </p>
            ) : (
              <p>
                This branch is not indexed yet. Confirming will not start
                ingestion in this version.
              </p>
            )}
            <div className="modal-actions">
              <button
                className="button-secondary"
                onClick={onClose}
                type="button"
              >
                Cancel
              </button>
              <button
                className="button-primary"
                onClick={() => {
                  console.log("Ingestion confirmed.");
                  onClose();
                }}
                type="button"
              >
                Confirm
              </button>
            </div>
          </div>
        ) : (
          <form className="repository-form" onSubmit={handleSubmit}>
            <label htmlFor="repository-url">GitHub repository URL</label>
            <input
              autoFocus
              autoComplete="url"
              id="repository-url"
              onChange={(event) => {
                setUrl(event.target.value);
                setValidationMessage("");
                setRequestError("");
              }}
              placeholder="https://github.com/owner/repository"
              type="url"
              value={url}
            />
            {validationMessage && (
              <p className="field-error" role="alert">
                {validationMessage}
              </p>
            )}
            <p className="field-hint">
              You can also paste a branch or file URL. When no branch is
              specified, RepoLens will use the repository’s default branch.
            </p>
            {requestError && (
              <div className="request-error" role="alert">
                <strong>Repository not added</strong>
                <span>{requestError}</span>
              </div>
            )}
            <div className="modal-actions">
              <button
                className="button-secondary"
                onClick={onClose}
                type="button"
              >
                Cancel
              </button>
              <button
                className="button-primary"
                disabled={isSubmitting || !url.trim()}
                type="submit"
              >
                {isSubmitting ? (
                  <>
                    <span className="spinner spinner-small" />
                    Checking…
                  </>
                ) : (
                  "Continue"
                )}
              </button>
            </div>
          </form>
        )}
      </section>
    </div>
  );
}

function validateGitHubRepositoryUrl(value: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(value.trim());
  } catch {
    return "Enter a valid GitHub repository URL.";
  }

  if (
    parsed.protocol !== "https:" ||
    parsed.hostname.toLowerCase() !== "github.com" ||
    parsed.username ||
    parsed.password
  ) {
    return "Use a secure URL from github.com.";
  }

  const segments = parsed.pathname.split("/").filter(Boolean);
  if (segments.length < 2 || !/^[\w.-]+$/.test(segments[0])) {
    return "Include the repository owner and repository name.";
  }

  const repositoryName = segments[1].replace(/\.git$/i, "");
  if (!/^[\w.-]+$/.test(repositoryName)) {
    return "The repository URL is not in a recognized format.";
  }
  return null;
}
