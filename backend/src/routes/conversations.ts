import { Router } from "express";
import {
  createBranchConversation,
  listBranchConversations,
  removeConversation,
  renameConversation,
  retrieveConversation,
  sendMessage,
} from "../controllers/conversations.js";
import { requireCsrf } from "../middleware/csrf.js";
import { requireAuth } from "../middleware/requireAuth.js";

export const conversationsRouter = Router();

conversationsRouter.use(requireAuth);
conversationsRouter.get("/", listBranchConversations);
conversationsRouter.post("/", requireCsrf, createBranchConversation);
conversationsRouter.get("/:id", retrieveConversation);
conversationsRouter.patch("/:id", requireCsrf, renameConversation);
conversationsRouter.delete("/:id", requireCsrf, removeConversation);
conversationsRouter.post("/:id/messages", requireCsrf, sendMessage);
