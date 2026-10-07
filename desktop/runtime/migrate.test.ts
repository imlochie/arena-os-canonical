/**
 * Migration runner tests — against a REAL embedded PostgreSQL instance
 * (initdb in a temp dir; the same lifecycle the supervisor drives). These
 * tests prove: fresh apply, tracking, skip-on-restart, rollback on failure.
 * If the platform package is missing (e.g. macOS arm), they skip.
 */

import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { join } from "node:path";
import { test } from "node:test";

import { applyMigrations } from "./migrate";
import { EmbeddedPostgres } from "./embedded-postgres";
import type { ArenaRuntimeConfig } from "./config";

async function startTestPostgres(): Promise<{ postgres: EmbeddedPostgres; config: ArenaRuntimeConfig; stop: () => Promise<void> } | null> {
  const root = await mkdtemp(join(tmpdir(), "arena-migrate-test-"));
  const platformPackage = `@embedded-postgres/${process.platform === "win32" ? "windows" : "linux"}-x64`;
  const nativeDir = path.join(process.cwd(), "node_modules", platformPackage, "native");
  if (!existsSync(path.join(nativeDir, "bin"))) return null;
  const config = {
    dirs: {
      root, data: join(root, "data"), projects: join(root, "projects"), waveyard: join(root, "waveyard"),
      cache: join(root, "cache"), logs: join(root, "logs"), models: join(root, "models"),
      runtime: join(root, "runtime"), settings: join(root, "settings"), portable: false, source: "env" as const,
    },
    host: "127.0.0.1",
    port: 0,
    database: { user: "arena", password: "test-password", name: "arena_test", port: 0, socketDir: join(root, "runtime", "pg-sockets"), dataDir: join(root, "data", "postgres") },
    postgres: { nativeDir, initdb: join(nativeDir, "bin", "initdb"), pgCtl: join(nativeDir, "bin", "pg_ctl"), postgres: join(nativeDir, "bin", "postgres"), libDir: join(nativeDir, "lib"), windowsPathDirs: [] },
    migrationsDir: join(root, "migrations"),
    ffmpegPath: null,
    ffprobePath: null,
    storageDir: join(root, "waveyard", "storage"),
    server: { kind: "dev", cwd: root, nodeBinary: process.execPath },
    mode: "desktop" as const,
  };
  // pick free ports
  const { pickFreePort } = await import("./config");
  config.port = await pickFreePort("127.0.0.1");
  config.database.port = await pickFreePort("127.0.0.1");
  const silent = { info: () => undefined, warn: () => undefined, error: () => undefined };
  const postgres = new EmbeddedPostgres(config as ArenaRuntimeConfig, silent);
  await postgres.ensureStarted();
  await postgres.createDatabaseIfMissing();
  return {
    postgres,
    config: config as ArenaRuntimeConfig,
    stop: async () => {
      await postgres.stop(5000);
      await rm(root, { recursive: true, force: true });
    },
  };
}

test("migrations apply once, are tracked, and are skipped on the second run", async (t) => {
  const instance = await startTestPostgres();
  if (instance === null) return t.skip("embedded postgres platform package unavailable");
  t.after(() => instance.stop());
  const { config } = instance;
  await mkdir(config.migrationsDir, { recursive: true });
  await writeFile(path.join(config.migrationsDir, "0000_first.sql"), "create table if not exists probe_a (id integer);--> statement-breakpoint\ninsert into probe_a values (1);");
  await writeFile(path.join(config.migrationsDir, "0001_second.sql"), "create table if not exists probe_b (id integer);");

  const { Client } = await import("pg");
  const client = new Client(instance.postgres.clientConfig(config.database.name));
  await client.connect();
  try {
    const first = await applyMigrations({ client, migrationsDir: config.migrationsDir });
    assert.deepEqual(first.applied, ["0000_first.sql", "0001_second.sql"]);
    const second = await applyMigrations({ client, migrationsDir: config.migrationsDir });
    assert.deepEqual(second.applied, []);
    assert.deepEqual(second.skipped, ["0000_first.sql", "0001_second.sql"]);
    const tracked = await client.query("select name from arena_schema_migrations order by name");
    assert.deepEqual(tracked.rows.map((row) => row.name), ["0000_first.sql", "0001_second.sql"]);
    const rows = await client.query("select count(*)::int as count from probe_a");
    assert.equal(rows.rows[0].count, 1); // 0000 ran exactly once
  } finally {
    await client.end();
  }
});

test("a failing migration rolls back atomically", async (t) => {
  const instance = await startTestPostgres();
  if (instance === null) return t.skip("embedded postgres platform package unavailable");
  t.after(() => instance.stop());
  const { config } = instance;
  await mkdir(config.migrationsDir, { recursive: true });
  await writeFile(path.join(config.migrationsDir, "0000_good.sql"), "create table probe_ok (id integer);");
  await writeFile(path.join(config.migrationsDir, "0001_bad.sql"), "create table probe_bad (id integer);--> statement-breakpoint\nthis is not valid sql at all;");

  const { Client } = await import("pg");
  const client = new Client(instance.postgres.clientConfig(config.database.name));
  await client.connect();
  try {
    await assert.rejects(applyMigrations({ client, migrationsDir: config.migrationsDir }), /0001_bad.sql failed and was rolled back/);
    // 0001's earlier statement rolled back with it; 0000 committed before.
    const bad = await client.query("select to_regclass('probe_bad')");
    assert.equal(bad.rows[0].to_regclass, null);
    const tracked = await client.query("select name from arena_schema_migrations");
    assert.deepEqual(tracked.rows.map((row) => row.name), ["0000_good.sql"]);
  } finally {
    await client.end();
  }
});
