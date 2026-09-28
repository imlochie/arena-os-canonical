import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";

let arenaPool: Pool | undefined;
let arenaDb: ReturnType<typeof drizzle> | undefined;

function getArenaDb() {
  if (arenaDb) return arenaDb;
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error("DATABASE_URL is required to access Arena OS data.");
  }
  arenaPool = new Pool({ connectionString: databaseUrl });
  arenaDb = drizzle(arenaPool);
  return arenaDb;
}

// Route modules are evaluated during production builds. A lazy proxy keeps that
// evaluation side-effect free while preserving the historic `db.select()` API.
export const db = new Proxy({} as ReturnType<typeof drizzle>, {
  get(_target, property) {
    const target = getArenaDb();
    const value = Reflect.get(target, property, target);
    return typeof value === "function" ? value.bind(target) : value;
  },
});

export function getArenaPool() {
  getArenaDb();
  return arenaPool!;
}
