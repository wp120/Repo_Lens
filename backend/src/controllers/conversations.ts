import type { RequestHandler } from "express";
import { z } from "zod";
import {
  ConversationError,
  createConversation,
  deleteConversation,
  getConversation,
  listConversations,
  sendConversationMessage,
  updateConversation,
  type SendMessageResponse,
} from "../services/conversationFlow.js";
import { buildCitationUrl } from "../services/citationUrls.js";

const branchSchema = z.object({
  branchId: z.string().uuid(),
  title: z.string().trim().min(1).max(255).optional(),
});
const titleSchema = z.object({ title: z.string().trim().min(1).max(255) });
const messageSchema = z.object({
  content: z.string().trim().min(1).max(16000),
  clientId: z.string().uuid(),
});

function userId(request: Parameters<RequestHandler>[0]) {
  return request.session.userId;
}

function conversationParam(request: Parameters<RequestHandler>[0]) {
  return Array.isArray(request.params.id) ? request.params.id[0] : request.params.id;
}

export const listBranchConversations: RequestHandler = async (
  request,
  response,
  next,
) => {
  const id = userId(request);
  const parsed = branchSchema.pick({ branchId: true }).safeParse(request.query);
  if (!id) return response.status(401).json({ error: "Authentication required." });
  if (!parsed.success)
    return response.status(400).json({ error: "A valid branchId is required." });
  try {
    response.json(await listConversations(id, parsed.data.branchId));
  } catch (error) {
    handleConversationError(error, response, next);
  }
};

export const createBranchConversation: RequestHandler = async (
  request,
  response,
  next,
) => {
  const id = userId(request);
  const parsed = branchSchema.safeParse(request.body);
  if (!id) return response.status(401).json({ error: "Authentication required." });
  if (!parsed.success)
    return response.status(400).json({ error: "A valid branchId is required." });
  try {
    const conversation = await createConversation(
      id,
      parsed.data.branchId,
      parsed.data.title,
    );
    response.status(201).json(conversation);
  } catch (error) {
    handleConversationError(error, response, next);
  }
};

export const retrieveConversation: RequestHandler = async (
  request,
  response,
  next,
) => {
  const id = userId(request);
  if (!id) return response.status(401).json({ error: "Authentication required." });
  try {
    const conversation = await getConversation(id, conversationParam(request));
    response.json({
      ...conversation,
      messages: conversation.messages.map((message) => ({
        ...message,
        citations: message.citations.map((citation) => {
          return {
            ...citation,
            url: buildCitationUrl(conversation.branchIndex.repository.htmlUrl, citation.commitSha, citation.filePath, citation.startLine, citation.endLine),
            label: `${citation.filePath}:${citation.startLine}-${citation.endLine}`,
          };
        }),
      })),
    });
  } catch (error) {
    handleConversationError(error, response, next);
  }
};

export const renameConversation: RequestHandler = async (
  request,
  response,
  next,
) => {
  const id = userId(request);
  const parsed = titleSchema.safeParse(request.body);
  if (!id) return response.status(401).json({ error: "Authentication required." });
  if (!parsed.success)
    return response.status(400).json({ error: "Enter a valid conversation title." });
  try {
    response.json(await updateConversation(id, conversationParam(request), parsed.data.title));
  } catch (error) {
    handleConversationError(error, response, next);
  }
};

export const removeConversation: RequestHandler = async (
  request,
  response,
  next,
) => {
  const id = userId(request);
  if (!id) return response.status(401).json({ error: "Authentication required." });
  try {
    await deleteConversation(id, conversationParam(request));
    response.status(204).send();
  } catch (error) {
    handleConversationError(error, response, next);
  }
};

export const sendMessage: RequestHandler = async (request, response, next) => {
  const id = userId(request);
  const parsed = messageSchema.safeParse(request.body);
  if (!id) return response.status(401).json({ error: "Authentication required." });
  if (!parsed.success)
    return response.status(400).json({ error: "Enter a message." });
  try {
    const assistant = await sendConversationMessage(
      id,
      conversationParam(request),
      parsed.data.content,
      parsed.data.clientId,
    );
    const payload: SendMessageResponse = {
      assistant: assistant.assistant,
    };
    response.json(payload);
  } catch (error) {
    handleConversationError(error, response, next);
  }
};

function handleConversationError(error: unknown, response: Parameters<RequestHandler>[1], next: Parameters<RequestHandler>[2]) {
  if (error instanceof ConversationError) {
    response.status(error.statusCode).json({ error: error.message });
    return;
  }
  next(error);
}
