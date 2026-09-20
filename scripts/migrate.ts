import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { Client } from "pg";

async function main() {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error("DATABASE_URL is required for migrations.");
  const client = new Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    await client.query('CREATE TABLE IF NOT EXISTS "waveyard_schema_migrations" ("id" text PRIMARY KEY, "applied_at" timestamptz NOT NULL DEFAULT now())');
    const migrationId = "0000_waveyard_initial";
    const { rows } = await client.query('SELECT 1 FROM "waveyard_schema_migrations" WHERE "id" = $1', [migrationId]);
    if (!rows.length) {
      const sql = await readFile(resolve(process.cwd(), "packages/database/drizzle/0000_waveyard_initial.sql"), "utf8");
      await client.query("BEGIN");
      try {
        await client.query(sql);
        await client.query('INSERT INTO "waveyard_schema_migrations" ("id") VALUES ($1)', [migrationId]);
        await client.query("COMMIT");
        console.log(`Applied ${migrationId}.`);
      } catch (error) { await client.query("ROLLBACK"); throw error; }
    } else console.log(`${migrationId} already applied.`);
  } finally { await client.end(); }
}
void main();
