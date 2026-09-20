import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { Pool } from "pg";

async function main() {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) throw new Error("DATABASE_URL is required for migrations.");
  const pool = new Pool({ connectionString });
  const client = await pool.connect();
  try {
    await client.query("CREATE TABLE IF NOT EXISTS arena_schema_migrations (name text PRIMARY KEY NOT NULL, applied_at timestamp NOT NULL DEFAULT now())");
    const completed = new Set((await client.query<{ name: string }>("SELECT name FROM arena_schema_migrations")).rows.map((row) => row.name));
    const migrationDir = join(process.cwd(), "drizzle");
    const names = (await readdir(migrationDir)).filter((name) => name.endsWith(".sql")).sort();
    for (const name of names) {
      if (completed.has(name)) continue;
      const contents = await readFile(join(migrationDir, name), "utf8");
      await client.query("BEGIN");
      try {
        await client.query(contents);
        await client.query("INSERT INTO arena_schema_migrations (name) VALUES ($1)", [name]);
        await client.query("COMMIT");
        console.info(`Applied ${name}`);
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      }
    }
  } finally {
    client.release();
    await pool.end();
  }
}

void main().catch((error) => {
  console.error("Migration failed", error);
  process.exit(1);
});
