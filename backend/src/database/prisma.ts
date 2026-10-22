import "../config/loadEnv.js";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../generated/prisma/client.js";
import { Pool } from "pg";

const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  throw new Error("DATABASE_URL must be configured.");
}

const pool = new Pool({ connectionString });
export const prisma = new PrismaClient({
  adapter: new PrismaPg(pool),
});
