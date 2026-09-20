import { readdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { Client } from "pg";

async function main() {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error("DATABASE_URL is required for migrations.");
  const client = new Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    await client.query('CREATE TABLE IF NOT EXISTS "waveyard_schema_migrations" ("id" text PRIMARY KEY, "applied_at" timestamptz NOT NULL DEFAULT now())');
    const completed = new Set((await client.query<{ id: string }>('SELECT "id" FROM "waveyard_schema_migrations"')).rows.map((row) => row.id));
    const folder = resolve(process.cwd(), "packages/database/drizzle");
    const migrations = (await readdir(folder)).filter((name) => /^\d+_.+\.sql$/.test(name)).sort();
    for (const id of migrations) {
      if (completed.has(id.replace(/\.sql$/, ""))) continue;
      const sql = await readFile(resolve(folder, id), "utf8");
      await client.query("BEGIN");
      try {
        await client.query(sql);
        await client.query('INSERT INTO "waveyard_schema_migrations" ("id") VALUES ($1)', [id.replace(/\.sql$/, "")]);
        await client.query("COMMIT");
        console.log(`Applied ${id}.`);
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      }
    }
  } finally { await client.end(); }
}
void main();
