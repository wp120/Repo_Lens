import type { RequestHandler } from "express";
import {
  getSessionCookieOptions,
  sessionCookieName,
} from "../config/session.js";
import { Prisma } from "../generated/prisma/client.js";
import { findSessionUser, loginUser, registerUser } from "../services/auth.js";
import { credentialsSchema } from "../services/authValidation.js";

export const getCurrentUser: RequestHandler = async (
  request,
  response,
  next,
) => {
  try {
    if (!request.session.userId) {
      response.status(200).json({ user: null });
      return;
    }
    const user = await findSessionUser(request.session.userId);
    if (!user) {
      request.session.destroy((error) => {
        if (error) next(error);
        else response.status(200).json({ user: null });
      });
      return;
    }
    response.json({ user });
  } catch (error) {
    next(error);
  }
};

export const register: RequestHandler = async (request, response, next) => {
  const parsed = credentialsSchema.safeParse(request.body);
  if (!parsed.success) {
    response.status(400).json({
      error: "Check the email and password and try again.",
      fieldErrors: parsed.error.flatten().fieldErrors,
    });
    return;
  }

  try {
    const user = await registerUser(
      parsed.data.email,
      parsed.data.password,
      request,
    );
    response.status(201).json({ user });
  } catch (error) {
    if (
      error instanceof Prisma.PrismaClientKnownRequestError &&
      error.code === "P2002"
    ) {
      response
        .status(409)
        .json({ error: "An account with this email already exists." });
      return;
    }
    next(error);
  }
};

export const login: RequestHandler = async (request, response, next) => {
  const parsed = credentialsSchema.safeParse(request.body);
  if (!parsed.success) {
    response.status(400).json({
      error: "Enter a valid email address and password.",
      fieldErrors: parsed.error.flatten().fieldErrors,
    });
    return;
  }

  try {
    const user = await loginUser(
      parsed.data.email,
      parsed.data.password,
      request,
    );
    if (!user) {
      response.status(401).json({ error: "Invalid email or password." });
      return;
    }
    response.json({ user });
  } catch (error) {
    next(error);
  }
};

export const logout: RequestHandler = (request, response, next) => {
  request.session.destroy((error) => {
    if (error) {
      next(error);
      return;
    }
    response.clearCookie(sessionCookieName, getSessionCookieOptions());
    response.status(204).end();
  });
};
