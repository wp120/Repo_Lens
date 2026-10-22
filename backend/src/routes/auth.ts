import { Router } from "express";
import {
  getCurrentUser,
  login,
  logout,
  register,
} from "../controllers/auth.js";
import {
  loginRateLimiter,
  registrationRateLimiter,
} from "../config/authRateLimiter.js";
import { getCsrfToken, requireCsrf } from "../middleware/csrf.js";
import { requireAuth } from "../middleware/requireAuth.js";

export const authRouter = Router();

authRouter.get("/csrf", getCsrfToken);
authRouter.get("/me", getCurrentUser);
authRouter.post("/register", registrationRateLimiter, requireCsrf, register);
authRouter.post("/login", loginRateLimiter, requireCsrf, login);
authRouter.post("/logout", requireAuth, requireCsrf, logout);
