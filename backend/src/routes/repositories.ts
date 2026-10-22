import { Router } from "express";
import {
  listRepositories,
  initiateIngestion,
  resolveRepository,
} from "../controllers/repositories.js";
import { requireAuth } from "../middleware/requireAuth.js";
import { requireCsrf } from "../middleware/csrf.js";

export const repositoriesRouter = Router();

repositoriesRouter.use(requireAuth);
repositoriesRouter.get("/", listRepositories);
repositoriesRouter.post("/resolve", requireCsrf, resolveRepository);
repositoriesRouter.post("/ingest", requireCsrf, initiateIngestion);
