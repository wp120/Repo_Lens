import { prisma } from "../database/prisma.js";
import { buildCitationUrl } from "./citationUrls.js";
import { runRetrievalAgent } from "./retrievalAgent.js";
import { retrieveRelevantChunks } from "./retrieval.js";

export { retrieveRelevantChunks } from "./retrieval.js";

export interface ConversationCitation {
  filePath: string;
  startLine: number;
  endLine: number;
  commitSha: string;
  url: string;
  label: string;
}

export interface RetrievedChunk {
  id?: string;
  filePath: string;
  content: string;
  startLine: number;
  endLine: number;
  commitSha: string;
}

export interface SendMessageResponse {
  assistant: PersistedMessage;
}

export interface PersistedMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  createdAt: Date;
  citations: ConversationCitation[];
}

export interface ConversationListItem {
  id: string;
  title: string;
  createdAt: Date;
  updatedAt: Date;
  latestMessagePreview?: string;
}

export class ConversationError extends Error {
  constructor(
    message: string,
    readonly statusCode = 400,
  ) {
    super(message);
    this.name = "ConversationError";
  }
}

export async function createConversation(
  userId: string,
  branchIndexId: string,
  title?: string,
) {
  await requireBranchAccess(userId, branchIndexId);
  return prisma.conversation.create({
    data: {
      userId,
      branchIndexId,
      title: title?.trim() || "New conversation",
    },
  });
}

export async function listConversations(
  userId: string,
  branchIndexId: string,
): Promise<ConversationListItem[]> {
  await requireBranchAccess(userId, branchIndexId);
  const conversations = await prisma.conversation.findMany({
    where: { userId, branchIndexId },
    orderBy: { updatedAt: "desc" },
    select: {
      id: true,
      title: true,
      createdAt: true,
      updatedAt: true,
      messages: {
        orderBy: { createdAt: "desc" },
        take: 1,
        select: { content: true },
      },
    },
  });
  return conversations.map(({ messages, ...conversation }) => ({
    ...conversation,
    latestMessagePreview: messages[0]?.content.slice(0, 160),
  }));
}

export async function getConversation(userId: string, conversationId: string) {
  const conversation = await prisma.conversation.findFirst({
    where: { id: conversationId, userId },
    include: {
      messages: {
        orderBy: { createdAt: "asc" },
        include: { citations: true },
      },
      branchIndex: {
        include: { repository: { select: { htmlUrl: true } } },
      },
    },
  });
  if (!conversation) {
    throw new ConversationError("Conversation not found.", 404);
  }
  await requireBranchAccess(userId, conversation.branchIndexId);
  return conversation;
}

export async function updateConversation(
  userId: string,
  conversationId: string,
  title: string,
) {
  await requireOwnedConversation(userId, conversationId);
  return prisma.conversation.update({
    where: { id: conversationId },
    data: { title },
  });
}

export async function deleteConversation(
  userId: string,
  conversationId: string,
) {
  await requireOwnedConversation(userId, conversationId);
  await prisma.conversation.delete({ where: { id: conversationId } });
}

export async function sendConversationMessage(
  userId: string,
  conversationId: string,
  content: string,
  clientId: string,
): Promise<SendMessageResponse> {
  const conversation = await getConversation(userId, conversationId);
  const existingUser = await prisma.message.findUnique({
    where: {
      conversationId_clientId: { conversationId, clientId },
    },
  });
  if (existingUser) {
    if (existingUser.status === "processing") {
      throw new ConversationError("This message is still being processed.", 409);
    }
    if (existingUser.status === "failed") {
      await prisma.message.update({
        where: { id: existingUser.id },
        data: { status: "processing" },
      });
    } else {
      return { assistant: await findPersistedAssistant(conversationId, existingUser.id) };
    }
  }
  let userMessage = existingUser;
  if (!userMessage) {
    try {
      userMessage = await prisma.message.create({
        data: { conversationId, role: "user", content, clientId, status: "processing" },
      });
    } catch (error) {
      const concurrentUser = await prisma.message.findUnique({
        where: { conversationId_clientId: { conversationId, clientId } },
        include: { conversation: true },
      });
      if (!concurrentUser) throw error;
      if (concurrentUser.status === "completed") {
        return { assistant: await findPersistedAssistant(conversationId, concurrentUser.id) };
      }
      throw new ConversationError("This message is still being processed.", 409);
    }
  }
  try {
    const retrieval = await retrieveAgentEvidence(
      content,
      conversation.branchIndexId,
    );
    const answer = await generateAnswer(
      content,
      retrieval.chunks,
      conversation.branchIndex.repository.htmlUrl,
      retrieval.status,
    );
    const citationRows = answer.citations.map((citation) => ({
      filePath: citation.filePath,
      startLine: citation.startLine,
      endLine: citation.endLine,
      commitSha: citation.commitSha,
    }));

    await prisma.$transaction(async (tx) => {
      const assistant = await tx.message.create({
        data: {
          conversationId,
          role: "assistant",
          content: answer.content,
          citations: citationRows.length ? { create: citationRows } : undefined,
        },
        include: { citations: true },
      });
      await tx.conversation.update({
        where: { id: conversationId },
        data: {
          updatedAt: new Date(),
          ...(conversation.title === "New conversation"
            ? { title: titleFromMessage(content) }
            : {}),
        },
      });
      await tx.message.update({
        where: { id: userMessage!.id },
        data: { status: "completed" },
      });
      return assistant;
    });
    return { assistant: await findPersistedAssistant(conversationId, userMessage.id) };
  } catch (error) {
    await prisma.message.update({
      where: { id: userMessage.id },
      data: { status: "failed" },
    });
    throw error;
  }
}

async function requireBranchAccess(userId: string, branchIndexId: string) {
  const access = await prisma.userBranchAccess.findUnique({
    where: { userId_branchIndexId: { userId, branchIndexId } },
  });
  if (!access) {
    throw new ConversationError("You do not have access to this branch.", 403);
  }
}

async function requireOwnedConversation(
  userId: string,
  conversationId: string,
) {
  const conversation = await prisma.conversation.findFirst({
    where: { id: conversationId, userId },
    select: { id: true },
  });
  if (!conversation) {
    throw new ConversationError("Conversation not found.", 404);
  }
}

async function retrieveAgentEvidence(
  question: string,
  branchIndexId: string,
) {
  const apiKey = process.env.AI_API_KEY?.trim();
  const model = process.env.AI_CHAT_MODEL?.trim();
  if (!apiKey || !model) {
    return {
      status: "insufficient" as const,
      chunks: await retrieveRelevantChunks(branchIndexId, question),
    };
  }
  return runRetrievalAgent(
    question,
    branchIndexId,
    {
      apiKey,
      baseUrl: process.env.AI_BASE_URL?.trim(),
      model,
    },
    retrieveRelevantChunks,
  );
}

async function generateAnswer(
  question: string,
  chunks: RetrievedChunk[],
  repositoryUrl?: string,
  retrievalStatus: "sufficient" | "insufficient" = "sufficient",
): Promise<{ content: string; citations: ConversationCitation[] }> {
  const provider = process.env.AI_PROVIDER?.trim().toLowerCase();
  const apiKey = process.env.AI_API_KEY?.trim();
  const baseUrl = process.env.AI_BASE_URL?.trim();
  const model = process.env.AI_CHAT_MODEL?.trim();

  console.log("Chunks provided for context: ", chunks.length);
  chunks.forEach(chunk => {
    console.log("From ", chunk.filePath , " ", chunk.content);
  });

  const sourcedChunks = chunks.map((chunk, index) => ({
    sourceId: `S${index + 1}`,
    ...chunk,
  }));
  if (!chunks.length && retrievalStatus === "insufficient") {
    return {
      content: "I could not find enough relevant indexed code to answer this question confidently. Please try a more specific question or ensure the repository branch has been indexed.",
      citations: [],
    };
  }

  let content = chunks.length
    ? `I found these relevant code locations:\n\n${chunks
        .map(
          (chunk, index) =>
            `[S${index + 1}] ${chunk.filePath}:${chunk.startLine}-${chunk.endLine}\n${chunk.content}`,
        )
        .join("\n\n")}`
    : "I could not find indexed code relevant to your question.";

  if (provider && apiKey && baseUrl && model && provider !== "voyage") {
    const response = await fetch(`${baseUrl.replace(/\/$/, "")}/chat/completions`, {
      method: "POST",
      headers: {
        Authorization: "Bearer " + apiKey,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model,
        messages: [
          {
            role: "system",
            content: `Answer using only the supplied code. Reference sources inline using only tokens such as [S1]. Do not invent source IDs, file paths, lines, or claims.${retrievalStatus === "insufficient" ? " The retrieval agent marked the evidence insufficient. Answer only what is supported, explicitly identify missing information, and do not fill gaps with unsupported code details." : ""}`,
          },
          {
            role: "user",
            content: `Question: ${question}\n\nCode context:\n${content}`,
          },
        ],
      }),
    });
    if (!response.ok) {
      throw new ConversationError("The AI response request failed.", 502);
    }

    const payload = (await response.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
    };
    content = payload.choices?.[0]?.message?.content?.trim() || content;
  }

  const sourceIds = extractSourceIds(content);
  const citations = sourceIds.flatMap((sourceId) => {
    const chunk = sourcedChunks.find((candidate) => candidate.sourceId === sourceId);
    if (!chunk) return [];
    const url = repositoryUrl
      ? buildCitationUrl(repositoryUrl, chunk.commitSha, chunk.filePath, chunk.startLine, chunk.endLine)
      : "";
    return [{
      filePath: chunk.filePath,
      startLine: chunk.startLine,
      endLine: chunk.endLine,
      commitSha: chunk.commitSha,
      url,
      label: `${chunk.filePath}:${chunk.startLine}-${chunk.endLine}`,
    }];
  });
  return { content, citations };
}

function extractSourceIds(content: string): string[] {
  const valid = new Set<string>();
  for (const match of content.matchAll(/\bS([1-9]\d*)\b/g)) {
    valid.add(`S${match[1]}`);
  }
  return [...valid];
}

async function findPersistedAssistant(
  conversationId: string,
  userMessageId: string,
): Promise<PersistedMessage> {
  const user = await prisma.message.findUniqueOrThrow({ where: { id: userMessageId } });
  const assistant = await prisma.message.findFirst({
    where: { conversationId, role: "assistant", createdAt: { gt: user.createdAt } },
    orderBy: { createdAt: "asc" },
    include: { citations: true },
  });
  if (!assistant) {
    throw new ConversationError("The assistant response is unavailable.", 502);
  }
  return formatPersistedMessage(assistant.id);
}

async function formatPersistedMessage(messageId: string): Promise<PersistedMessage> {
  const message = await prisma.message.findUniqueOrThrow({
    where: { id: messageId },
    include: { citations: true },
  });
  const conversation = await prisma.conversation.findUniqueOrThrow({
    where: { id: message.conversationId },
    include: { branchIndex: { include: { repository: { select: { htmlUrl: true } } } } },
  });
  const role = message.role === "assistant" ? "assistant" as const : "user" as const;
  const citations: ConversationCitation[] = message.citations.map((citation) => ({
    ...citation,
    url: buildCitationUrl(conversation.branchIndex.repository.htmlUrl, citation.commitSha, citation.filePath, citation.startLine, citation.endLine),
    label: `${citation.filePath}:${citation.startLine}-${citation.endLine}`,
  }));
  return { id: message.id, role, content: message.content, createdAt: message.createdAt, citations };
}

function titleFromMessage(content: string) {
  const words = content.trim().replace(/\s+/g, " ").split(" ");
  const title = words.slice(0, 8).join(" ");
  return title.length > 50 ? `${title.slice(0, 47)}...` : title;
}
