import { useOutletContext, useParams } from "react-router-dom";
import { ConversationPanel } from "../components/ConversationPanel";
import type { Repository } from "../types/app";

interface DashboardContext {
  repositories: Repository[];
  onAddRepository: () => void;
}

export function DashboardPage() {
  const { repositories, onAddRepository } =
    useOutletContext<DashboardContext>();
  const { branchId, conversationId } = useParams();
  const showDefaultDashboard = branchId === undefined;
  const repository =
    repositories.find((item) =>
      item.branches.some((branch) => branch.id === branchId),
    ) ?? null;
  const branch =
    repository?.branches.find((item) => item.id === branchId) ?? null;
  const conversation =
    branch?.conversations.find((item) => item.id === conversationId) ?? null;

  return (
    <ConversationPanel
      branch={branch}
      conversation={conversation}
      hasRepositories={repositories.length > 0 || showDefaultDashboard}
      onAddRepository={onAddRepository}
      repository={repository}
    />
  );
}
