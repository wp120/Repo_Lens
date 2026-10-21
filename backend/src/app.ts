import express from "express";
import { errorHandler } from "./middleware/errorHandler.js";
import { healthRouter } from "./routes/health.js";

export const app = express();

app.disable("x-powered-by");
app.use(express.json());
app.use("/api/health", healthRouter);
app.use(errorHandler);
