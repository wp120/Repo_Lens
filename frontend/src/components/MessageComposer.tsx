import { useState, type FormEvent } from "react";
import { Icon } from "./Icon";

export function MessageComposer({
  disabled = false,
  message,
  onMessageChange,
  onSend,
}: {
  disabled?: boolean;
  message: string;
  onMessageChange: (message: string) => void;
  onSend: (message: string) => void | Promise<void>;
}) {
  const [notice, setNotice] = useState("");

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!message.trim()) return;
    void Promise.resolve(onSend(message.trim())).catch((error: unknown) => {
      setNotice(error instanceof Error ? error.message : "Message could not be sent.");
    });
  }

  return (
    <div className="composer-wrap">
      {notice && (
        <div className="composer-notice" role="status">
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
      <form className="message-composer" onSubmit={handleSubmit}>
        <textarea
          aria-label="Message"
          disabled={disabled}
          onChange={(event) => {
            onMessageChange(event.target.value);
            setNotice("");
          }}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.shiftKey) {
              event.preventDefault();
              event.currentTarget.form?.requestSubmit();
            }
          }}
          placeholder={
            disabled
              ? "This branch is not ready to chat yet"
              : "Ask about this codebase…"
          }
          rows={1}
          value={message}
        />
        <div className="composer-toolbar">
          <span>AI responses will be available when connected.</span>
          <button
            aria-label="Send message"
            className="send-button"
            disabled={disabled || !message.trim()}
            type="submit"
          >
            <Icon name="send" />
          </button>
        </div>
      </form>
      <p className="composer-disclaimer">
        RepoLens can make mistakes. Check important details against your code.
      </p>
    </div>
  );
}
