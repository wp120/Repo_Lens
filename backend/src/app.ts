import cors from "cors";
import express from "express";
import { getFrontendOrigin, sessionMiddleware } from "./config/session.js";
import { authRouter } from "./routes/auth.js";
import { errorHandler } from "./middleware/errorHandler.js";
import { healthRouter } from "./routes/health.js";

export const app = express();

app.disable("x-powered-by");
if (process.env.NODE_ENV === "production") app.set("trust proxy", 1);
app.use(
  cors({
    origin: getFrontendOrigin(),
    credentials: true,
    methods: ["GET", "POST", "OPTIONS"],
    allowedHeaders: ["Content-Type", "X-CSRF-Token"],
  }),
);
app.use(express.json({ limit: "16kb" }));
app.use(sessionMiddleware);
app.use("/api/health", healthRouter);
app.use("/api/auth", authRouter);
app.use(errorHandler);
