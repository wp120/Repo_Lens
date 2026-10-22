import type { RequestHandler } from "express";
import { prisma } from "../database/prisma.js";

export const requireAuth: RequestHandler = async (request, response, next) => {
  const userId = request.session.userId;
  if (!userId) {
    response.status(401).json({ error: "Authentication required." });
    return;
  }

  try {
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { id: true },
    });
    if (!user) {
      request.session.destroy((error) => {
        if (error) next(error);
        else response.status(401).json({ error: "Authentication required." });
      });
      return;
    }
    next();
  } catch (error) {
    next(error);
  }
};
