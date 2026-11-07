import { useEffect, useState } from "react";
import { useNavigate, useOutletContext, useParams } from "react-router-dom";
import { ConversationPanel } from "../components/ConversationPanel";
import type { Repository } from "../types/app";
import { conversationService } from "../services/conversationService";
import { useRef } from "react";

interface DashboardContext {
  repositories: Repository[];
  onAddRepository: () => void;
  onRepositoriesChange: (repositories: Repository[]) => void;
}

export function DashboardPage() {
  const { repositories, onAddRepository, onRepositoriesChange } =
    useOutletContext<DashboardContext>();
  const { branchId, conversationId } = useParams();
  const showDefaultDashboard = branchId === undefined;
  const repository =
    repositories.find((item) =>
      item.branches.some((branch) => branch.id === branchId),
    ) ?? null;
  const branch =
    repository?.branches.find((item) => item.id === branchId) ?? null;
  const stub = branch?.conversations.find((item) => item.id === conversationId) ?? null;
  const [conversation, setConversation] = useState<typeof stub>(null);
  const navigate = useNavigate();
  const pendingClientId = useRef<string | null>(null);

  useEffect(() => {
    setConversation(null);
    pendingClientId.current = null;
    if (!conversationId) return;
    let active = true;
    conversationService
      .get(conversationId)
      .then((loaded) => {
        if (active) setConversation(loaded);
      })
      .catch(() => {
        if (active) navigate("/dashboard", { replace: true });
      });
    return () => { active = false; };
  }, [conversationId, navigate]);

  async function sendMessage(content: string) {
    if (!conversation) return;
    const clientId = pendingClientId.current ?? crypto.randomUUID();
    pendingClientId.current = clientId;
    setConversation((current) => current ? { ...current, isLoading: true } : current);
    try {
      const { assistant } = await conversationService.send(conversation.id, content, clientId);
      pendingClientId.current = null;
      setConversation((current) => current ? {
        ...current,
        isLoading: false,
        messages: [
          ...current.messages,
          { id: crypto.randomUUID(), role: "user", content, createdAt: new Date().toISOString() },
          assistant,
        ],
      } : current);
    } catch (error) {
      setConversation((current) => current ? { ...current, isLoading: false } : current);
      throw error;
    }
  }

  return (
    <ConversationPanel
      branch={branch}
      conversation={conversation}
      hasRepositories={repositories.length > 0 || showDefaultDashboard}
      onAddRepository={onAddRepository}
      repository={repository}
      onSendMessage={sendMessage}
    />
  );
}
