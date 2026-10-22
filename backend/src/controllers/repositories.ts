import type { RequestHandler } from "express";
import { z } from "zod";
import { GitHubRepositoryError } from "../services/githubRepository.js";
import {
  getUserRepositories,
  resolveAndAttachRepository,
} from "../services/repositoryFlow.js";

const repositoryUrlSchema = z.object({
  url: z.string().trim().min(1).max(2048),
});

export const listRepositories: RequestHandler = async (
  request,
  response,
  next,
) => {
  const userId = request.session.userId;
  if (!userId) {
    response.status(401).json({ error: "Authentication required." });
    return;
  }
  try {
    response.json(await getUserRepositories(userId));
  } catch (error) {
    next(error);
  }
};

export const resolveRepository: RequestHandler = async (
  request,
  response,
  next,
) => {
  const userId = request.session.userId;
  if (!userId) {
    response.status(401).json({ error: "Authentication required." });
    return;
  }
  const parsed = repositoryUrlSchema.safeParse(request.body);
  if (!parsed.success) {
    response.status(400).json({
      error: "Enter a valid GitHub repository URL.",
      fieldErrors: parsed.error.flatten().fieldErrors,
    });
    return;
  }

  try {
    const result = await resolveAndAttachRepository(parsed.data.url, userId);
    response.json({
      ...result,
      repository: {
        ...result.repository,
        githubRepoId: result.repository.githubRepoId.toString(),
      },
    });
  } catch (error) {
    if (error instanceof GitHubRepositoryError) {
      response.status(error.statusCode).json({ error: error.message });
      return;
    }
    next(error);
  }
};
