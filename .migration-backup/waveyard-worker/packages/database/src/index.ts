import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";

let pool: Pool | undefined;

export function getPool(): Pool {
  if (pool) return pool;
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) throw new Error("DATABASE_URL is required to access Waveyard data.");
  pool = new Pool({ connectionString, max: 10 });
  return pool;
}

export function getDb() {
  return drizzle(getPool());
}

export * from "./schema";
