/**
 * Per-file test database isolation.
 *
 * `mediaArchive.test.ts` and `local.test.ts` share the media-archive table
 * family and run as PARALLEL node:test processes. On a shared database one
 * file's defensive `clearMediaArchiveDomain()` deletes the other's fixtures
 * mid-run — locally this is hidden by timing, on CI it cascaded into five
 * failures ("cannot read … of undefined" on rows that had just been wiped).
 *
 * Each file creates its own database and applies the canonical
 * `desktop-migrations` schema, so both can run (and wipe) freely.
 */

import path from "node:path";

export async function isolatedTestDatabase(baseUrl: string, suffix: string): Promise<string> {
  const { Client } = await import("pg");
  const target = new URL(baseUrl);
  const baseName = target.pathname.replace(/^\//, "") || "app_db";
  const dbName = `${baseName}_${suffix}`.replace(/[^a-z0-9_]/gi, "_").toLowerCase();
  target.pathname = `/${dbName}`;

  const adminUrl = new URL(baseUrl);
  adminUrl.pathname = "/postgres";
  const admin = new Client({ connectionString: adminUrl.toString() });
  await admin.connect();
  try {
    const existing = await admin.query("select 1 from pg_database where datname = $1", [dbName]);
    if (existing.rowCount === 0) {
      await admin.query(`create database "${dbName}"`);
    }
  } finally {
    await admin.end();
  }

  // Canonical schema snapshot — the same one the packaged runtime applies.
  const { applyMigrations } = await import("../../../desktop/runtime/migrate");
  const client = new Client({ connectionString: target.toString() });
  await client.connect();
  try {
    await applyMigrations({ client, migrationsDir: path.resolve(process.cwd(), "desktop-migrations") });
  } finally {
    await client.end();
  }
  return target.toString();
}
