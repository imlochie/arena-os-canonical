/**
 * Desktop migration runner — SQL files only, pg client only.
 *
 * `desktop-migrations/` holds the canonical schema snapshot (0000) plus
 * future ordered deltas. Each file runs in ONE transaction and is recorded
 * in arena_schema_migrations; upgrades are purely additive files — the
 * runtime never diffs or rewrites. (Dev keeps `drizzle-kit push` via
 * scripts/db-setup.mjs; this runner is the packaged path.)
 */

import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

import type { Client } from "pg";

export const MIGRATIONS_TABLE = "arena_schema_migrations";

export interface MigrationOutcome {
  applied: string[];
  skipped: string[];
}

export async function applyMigrations(options: {
  client: Client;
  migrationsDir: string;
  logger?: { info: (scope: string, message: string, detail?: Record<string, unknown>) => void };
}): Promise<MigrationOutcome> {
  const { client, migrationsDir, logger } = options;
  await client.query(
    `create table if not exists ${MIGRATIONS_TABLE} (
       name text primary key,
       applied_at timestamptz not null default now()
     )`,
  );

  const files = (await readdir(migrationsDir)).filter((file) => file.endsWith(".sql")).sort();
  if (files.length === 0) throw new Error(`No migration files found in ${migrationsDir}.`);

  const applied = new Set<string>(
    (await client.query<{ name: string }>(`select name from ${MIGRATIONS_TABLE}`)).rows.map((row) => row.name),
  );

  const newlyApplied: string[] = [];
  const skipped: string[] = [];
  for (const file of files) {
    if (applied.has(file)) {
      skipped.push(file);
      continue;
    }
    const sql = await readFile(path.join(migrationsDir, file), "utf8");
    // drizzle-kit statement-breakpoint markers split the file into statements.
    const statements = sql
      .split("--> statement-breakpoint")
      .map((statement) => statement.trim())
      .filter((statement) => statement.length > 0);
    await client.query("begin");
    try {
      for (const statement of statements) await client.query(statement);
      await client.query(`insert into ${MIGRATIONS_TABLE} (name) values ($1)`, [file]);
      await client.query("commit");
      newlyApplied.push(file);
      logger?.info("migrate", "applied migration", { file });
    } catch (error) {
      await client.query("rollback");
      throw new Error(
        `Migration ${file} failed and was rolled back: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  return { applied: newlyApplied, skipped };
}
