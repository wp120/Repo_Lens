import { PrismaPg } from "@prisma/adapter-pg";
import { Pool } from "pg";

export function createPrismaAdapter(connectionString: string): PrismaPg {
  return new PrismaPg(new Pool({ connectionString }));
}
