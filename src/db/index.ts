import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";

const databaseUrl = process.env.DATABASE_URL;

if (!databaseUrl) {
  throw new Error("DATABASE_URL is required");
}

const globalForDb = globalThis as typeof globalThis & {
  __arenaNextJsPostgresqlPool?: Pool;
};

export const pool =
  globalForDb.__arenaNextJsPostgresqlPool ??
  new Pool({
    connectionString: databaseUrl,
  });

if (process.env.NODE_ENV !== "production") {
  globalForDb.__arenaNextJsPostgresqlPool = pool;
}

export const db = drizzle(pool);
// Own checkout/release around Drizzle as well as its transaction body.
// Drizzle starts BEGIN before its release-finally; a socket lost at BEGIN
// otherwise strands a checked-out client and can hang pool shutdown/restart.
db.transaction = async (transaction, config) => {
  const client = await pool.connect();
  let failure: unknown;
  try { return await drizzle(client).transaction(transaction, config); }
  catch (error) { failure = error; throw error; }
  finally { client.release(failure instanceof Error ? failure : undefined); }
};

// A temporary database restart must not terminate the server through an
// unhandled idle-client error. Checked queries still reject authoritatively.
if (pool.listenerCount("error") === 0) pool.on("error", (error) => {
  console.error("[database] idle connection lost:", error.message);
});

// A checked-out client can lose its socket between transaction statements.
// Its query still rejects, but pg also emits an error outside the query
// promise; keep that event from terminating the service during recovery.
if (pool.listenerCount("connect") === 0) pool.on("connect", (client) => {
  client.on("error", (error) => { console.error("[database] active connection lost:", error.message); });
});
