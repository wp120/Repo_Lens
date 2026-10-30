import "./config/loadEnv.js";
import { app } from "./app.js";
import { sessionRedis } from "./config/session.js";
import { prisma } from "./database/prisma.js";
import { closeIngestionQueue } from "./jobs/ingestionQueue.js";
import {
  startIngestionWorker,
  closeIngestionWorker,
} from "./jobs/ingestionWorker.js";

const port = Number(process.env.PORT ?? 3001);

await sessionRedis.connect();
startIngestionWorker();
const server = app.listen(port, () => {
  console.log(`RepoLens API listening on http://localhost:${port}`);
});

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    server.close(() => {
      void Promise.all([
        sessionRedis.quit(),
        prisma.$disconnect(),
        closeIngestionQueue(),
        closeIngestionWorker(),
      ]).finally(() => process.exit(0));
    });
  });
}
