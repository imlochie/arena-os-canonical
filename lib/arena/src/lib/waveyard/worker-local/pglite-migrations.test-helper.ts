/**
 * Apply the canonical desktop SQL migrations to a disposable PGlite database.
 *
 * Tests must NOT import the desktop runtime (`desktop/runtime/*`): it is not
 * part of the web workspace and is not installed here, so a test that reaches
 * for it fails with ERR_MODULE_NOT_FOUND instead of exercising anything. This
 * helper is the shared way to get the real schema into an in-memory database.
 *
 * Behaviour matches the packaged runtime for the part tests depend on: every
 * `<name>.sql` in `desktop-migrations/` is applied in filename order. The
 * packaged runtime also records each file in `arena_schema_migrations`; a
 * freshly created disposable database needs no such bookkeeping, so it is not
 * written here.
 *
 * Deliberately tiny and dependency-light: it must stay importable from any
 * test without pulling in the separation engine, storage or the ORM.
 */

import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import type { PGlite } from "@electric-sql/pglite";

/** `lib/arena/desktop-migrations` — this file lives in `.../waveyard/worker-local/`. */
export const DESKTOP_MIGRATIONS_DIR = fileURLToPath(
  new URL("../../../../desktop-migrations", import.meta.url),
);

/**
 * Execute every canonical migration file against `client`, in order.
 *
 * Throws if the directory holds no migrations: an empty schema would make
 * tests fail later with a confusing "relation does not exist", so the
 * missing-schema cause is reported at its source instead.
 */
export async function applyDesktopMigrationsToPGlite(
  client: PGlite,
  migrationsDir: string = DESKTOP_MIGRATIONS_DIR,
): Promise<void> {
  const files = (await readdir(migrationsDir)).filter((name) => name.endsWith(".sql")).sort();
  if (files.length === 0) {
    throw new Error(`No migration files found in ${migrationsDir}.`);
  }
  for (const name of files) {
    await client.exec(await readFile(join(migrationsDir, name), "utf8"));
  }
}

/**
 * The same migration set, for a real `pg` client (the embedded PostgreSQL
 * concurrency proof). Records applied files in `arena_schema_migrations`
 * exactly like the packaged runtime, so a cluster that is inspected after a
 * run shows what was applied.
 */
export async function applyDesktopMigrationsToPgClient(
  client: { query: (text: string, values?: unknown[]) => Promise<unknown> },
  migrationsDir: string = DESKTOP_MIGRATIONS_DIR,
): Promise<void> {
  await client.query(
    "create table if not exists arena_schema_migrations (name text primary key, applied_at timestamptz not null default now())",
  );
  const appliedRows = (await client.query("select name from arena_schema_migrations")) as {
    rows: Array<{ name: string }>;
  };
  const applied = new Set(appliedRows.rows.map((row) => row.name));
  const files = (await readdir(migrationsDir)).filter((name) => name.endsWith(".sql")).sort();
  if (files.length === 0) {
    throw new Error(`No migration files found in ${migrationsDir}.`);
  }
  for (const name of files) {
    if (applied.has(name)) continue;
    const sql = await readFile(join(migrationsDir, name), "utf8");
    const statements = sql
      .split("--> statement-breakpoint")
      .map((statement) => statement.trim())
      .filter((statement) => statement.length > 0);
    await client.query("begin");
    try {
      for (const statement of statements) await client.query(statement);
      await client.query("insert into arena_schema_migrations (name) values ($1)", [name]);
      await client.query("commit");
    } catch (error) {
      await client.query("rollback");
      throw new Error(
        `Migration ${name} failed and was rolled back: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
}
