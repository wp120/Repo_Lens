import type {
  ChatMessage,
  Citation,
  Conversation,
  ConversationSummary,
} from "../types/app";
import { apiMutate, apiRequest } from "./apiClient";

interface MessageResponse {
  id: string;
  role: "user" | "assistant";
  content: string;
  createdAt: string;
  citations: Citation[];
}

interface ConversationResponse {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  messages?: MessageResponse[];
}

interface SendMessageResponse {
  assistant: MessageResponse;
}

function normalizeMessage(value: MessageResponse): ChatMessage {
  return {
    id: value.id,
    role: value.role,
    content: value.content,
    createdAt: value.createdAt,
    citations: value.citations,
  };
}

function normalizeConversation(value: ConversationResponse): Conversation {
  return {
    id: value.id,
    title: value.title,
    updatedAt: value.updatedAt,
    createdAt: value.createdAt,
    messages: (value.messages ?? []).map(normalizeMessage),
  };
}

function normalizeSummary(value: ConversationResponse): ConversationSummary {
  return normalizeConversation(value);
}

export const conversationService = {
  list(branchId: string): Promise<ConversationSummary[]> {
    return apiRequest<ConversationResponse[]>(`/api/conversations?branchId=${encodeURIComponent(branchId)}`).then((rows) => rows.map(normalizeSummary));
  },
  create(branchId: string, title?: string): Promise<Conversation> {
    return apiMutate("/api/conversations", { branchId, ...(title ? { title } : {}) });
  },
  get(id: string): Promise<Conversation> {
    return apiRequest<ConversationResponse>(`/api/conversations/${id}`).then(normalizeConversation);
  },
  rename(id: string, title: string): Promise<Conversation> {
    return apiMutate(`/api/conversations/${id}`, { title }, "PATCH");
  },
  delete(id: string): Promise<void> {
    return apiMutate(`/api/conversations/${id}`, undefined, "DELETE");
  },
  send(id: string, content: string, clientId: string): Promise<{ assistant: ChatMessage }> {
    return apiMutate<SendMessageResponse>(
      `/api/conversations/${id}/messages`,
      { content, clientId },
    ).then((response) => ({ assistant: normalizeMessage(response.assistant) }));
  },
};
