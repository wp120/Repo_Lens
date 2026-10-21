export interface User {
  id: string;
  name: string;
  email: string;
  avatarUrl?: string;
}

export interface Citation {
  label: string;
  url: string;
}

export interface ChatMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  createdAt: string;
  citations?: Citation[];
}

export type BranchStatus = "ready" | "indexing" | "failed";

export interface Conversation {
  id: string;
  title: string;
  updatedAt: string;
  messages: ChatMessage[];
  isLoading?: boolean;
}

export interface RepositoryBranch {
  id: string;
  name: string;
  status: BranchStatus;
  conversations: Conversation[];
}

export interface Repository {
  id: string;
  name: string;
  owner: string;
  url: string;
  branches: RepositoryBranch[];
}
