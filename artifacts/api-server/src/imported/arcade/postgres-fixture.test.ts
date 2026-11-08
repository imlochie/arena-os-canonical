import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { join } from "node:path";

/** Real embedded PostgreSQL for route tests. Returns null only when the
 * platform has no embedded-postgres package. */
export async function bootFixture() {
  // An externally provisioned, already-migrated database (e.g. a system PostgreSQL).
  if (process.env.ARENA_TEST_DATABASE_URL) {
    process.env.DATABASE_URL = process.env.ARENA_TEST_DATABASE_URL;
    return { postgres: null, stop: async () => undefined };
  }
  const root = await mkdtemp(join(tmpdir(), "arena-arcade-test-"));
  const platformPackage = `@embedded-postgres/${process.platform === "win32" ? "windows" : process.platform === "darwin" ? "darwin" : "linux"}-x64`;
  const nativeDir = path.join(process.cwd(), "node_modules", platformPackage, "native");
  if (!existsSync(path.join(nativeDir, "bin"))) {
    await rm(root, { recursive: true, force: true });
    return null;
  }
  const { EmbeddedPostgres } = await import("../../../../desktop/runtime/embedded-postgres");
  const { applyMigrations } = await import("../../../../desktop/runtime/migrate");
  const { pickFreePort } = await import("../../../../desktop/runtime/config");
  const ext = process.platform === "win32" ? ".exe" : "";
  const config = {
    dirs: {
      root, data: join(root, "data"), projects: join(root, "projects"), waveyard: join(root, "waveyard"),
      cache: join(root, "cache"), logs: join(root, "logs"), models: join(root, "models"),
      runtime: join(root, "runtime"), settings: join(root, "settings"), portable: false, source: "env" as const,
    },
    host: "127.0.0.1",
    port: 0,
    database: {
      user: "arena", password: "test-password", name: "arena_arcade_test", port: 0,
      socketDir: process.platform === "win32" ? null : join(root, "runtime", "pg-sockets"),
      dataDir: join(root, "data", "postgres"),
    },
    postgres: {
      nativeDir,
      initdb: join(nativeDir, "bin", `initdb${ext}`),
      pgCtl: join(nativeDir, "bin", `pg_ctl${ext}`),
      postgres: join(nativeDir, "bin", `postgres${ext}`),
      libDir: join(nativeDir, "lib"),
      windowsPathDirs: [],
    },
    migrationsDir: path.join(process.cwd(), "desktop-migrations"),
    ffmpegPath: null, ffprobePath: null,
    storageDir: join(root, "waveyard", "storage"),
    modelsDir: join(root, "waveyard", "models"),
    server: { kind: "dev" as const, cwd: root, nodeBinary: process.execPath },
    mode: "desktop" as const,
  };
  config.port = await pickFreePort("127.0.0.1");
  config.database.port = await pickFreePort("127.0.0.1");

  const silent = { info: () => undefined, warn: () => undefined, error: () => undefined };
  const postgres = new (EmbeddedPostgres as any)(config, silent);
  await postgres.ensureStarted();
  await postgres.createDatabaseIfMissing();
  const { Client } = await import("pg");
  const client = new Client(postgres.clientConfig(config.database.name));
  await client.connect();
  await applyMigrations({ client, migrationsDir: config.migrationsDir });
  await client.end();

  // The db pool is created at module import — the URL must be in place first.
  process.env.DATABASE_URL = `postgres://arena:test-password@127.0.0.1:${config.database.port}/arena_arcade_test`;
  return {
    postgres,
    stop: async () => {
      await postgres.stop(10_000);
      await rm(root, { recursive: true, force: true });
    },
  };
}
