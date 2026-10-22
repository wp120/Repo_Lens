import { randomBytes } from "node:crypto";
import bcrypt from "bcryptjs";
import type { Request } from "express";
import type { User } from "../generated/prisma/client.js";
import { prisma } from "../database/prisma.js";

const bcryptRounds = 12;

export interface PublicUser {
  id: string;
  email: string;
  createdAt: string;
}

export async function registerUser(
  email: string,
  password: string,
  request: Request,
): Promise<PublicUser> {
  const passwordHash = await bcrypt.hash(password, bcryptRounds);
  const user = await prisma.user.create({
    data: { email, passwordHash },
    select: { id: true, email: true, createdAt: true },
  });

  await establishSession(request, user.id);
  return toPublicUser(user);
}

export async function loginUser(
  email: string,
  password: string,
  request: Request,
): Promise<PublicUser | null> {
  const user = await prisma.user.findUnique({
    where: { email },
    select: { id: true, email: true, passwordHash: true, createdAt: true },
  });

  if (!user || !(await bcrypt.compare(password, user.passwordHash))) {
    return null;
  }

  await establishSession(request, user.id);
  return toPublicUser(user);
}

export async function findSessionUser(
  userId: string,
): Promise<PublicUser | null> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { id: true, email: true, createdAt: true },
  });
  return user ? toPublicUser(user) : null;
}

function establishSession(request: Request, userId: string): Promise<void> {
  return new Promise((resolve, reject) => {
    request.session.regenerate((regenerateError) => {
      if (regenerateError) {
        reject(regenerateError);
        return;
      }
      request.session.userId = userId;
      request.session.csrfToken = randomBytes(32).toString("hex");
      request.session.save((saveError) => {
        if (saveError) reject(saveError);
        else resolve();
      });
    });
  });
}

function toPublicUser(
  user: Pick<User, "id" | "email" | "createdAt">,
): PublicUser {
  return {
    id: user.id,
    email: user.email,
    createdAt: user.createdAt.toISOString(),
  };
}
