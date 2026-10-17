/**
 * Embedded PostgreSQL lifecycle tests.
 *
 * Two layers, matching how the failure actually happens in the field:
 *
 *  1. Scripted-spawn unit tests — deterministic coverage of the version
 *     guard and of the bootLog→lastError propagation regression (the
 *     startup failure path used to swallow the server's FATAL output).
 *  2. Real-binary tests against the actual bundled PostgreSQL — proving a
 *     PG 16 cluster starts, that a tampered/mismatched PG_VERSION is
 *     refused WITHOUT touching the data directory, and that the cluster is
 *     still intact (and openable) after the marker is restored.
 *
 * The real layer skips when the platform package is absent (same policy as
 * migrate.test.ts).
 */

import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { join } from "node:path";
import { test } from "node:test";
import type { spawn } from "node:child_process";

import {
  EmbeddedPostgres,
  describeVersionMismatch,
  parsePostgresMajorVersion,
  readDataDirVersion,
} from "./embedded-postgres";
import { removeDirWithRetry } from "./fs-cleanup";
import type { ArenaRuntimeConfig } from "./config";

// ---------- pure helpers -------------------------------------------------

test("readDataDirVersion reads the initdb major marker and treats garbage as missing", async () => {
  const dir = await mkdtemp(join(tmpdir(), "arena-pgver-"));
  try {
    assert.equal(readDataDirVersion(join(dir, "does-not-exist")), null);
    await writeFile(join(dir, "PG_VERSION"), "16\n");
    assert.equal(readDataDirVersion(dir), "16");
    await writeFile(join(dir, "PG_VERSION"), "  18  ");
    assert.equal(readDataDirVersion(dir), "18");
    await writeFile(join(dir, "PG_VERSION"), "banana");
    assert.equal(readDataDirVersion(dir), null);
    await writeFile(join(dir, "PG_VERSION"), "   ");
    assert.equal(readDataDirVersion(dir), null);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("parsePostgresMajorVersion parses real postgres --version output and rejects noise", () => {
  assert.equal(parsePostgresMajorVersion("postgres (PostgreSQL) 16.14"), "16");
  assert.equal(parsePostgresMajorVersion("postgres (PostgreSQL) 18.4 (Debian 18.4-1.pgdg120+1)"), "18");
  assert.equal(parsePostgresMajorVersion("postgres (PostgreSQL) 16.14\n"), "16");
  assert.equal(parsePostgresMajorVersion("command not found"), null);
  assert.equal(parsePostgresMajorVersion(""), null);
});

test("describeVersionMismatch names both versions and forbids reinitialising", () => {
  const message = describeVersionMismatch({
    dataDir: "/data/postgres",
    dataDirVersion: "16",
    serverMajor: "18",
    serverVersionLine: "postgres (PostgreSQL) 18.4",
  });
  assert.match(message, /\/data\/postgres/);
  assert.match(message, /created by PostgreSQL 16/);
  assert.match(message, /bundles PostgreSQL 18/);
  assert.match(message, /will NOT delete, overwrite, or reinitialise/);
  assert.match(message, /pg_upgrade/);
  assert.match(message, /POSTGRES-16-TO-18-MIGRATION/);
});

// ---------- scripted-spawn lifecycle -------------------------------------

type SpawnScript = (binary: string, args: string[]) => { stdout?: string; stderr?: string; code?: number };

class FakeChild extends EventEmitter {
  stdout = new EventEmitter();
  stderr = new EventEmitter();
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  constructor(script: { stdout?: string; stderr?: string; code?: number }) {
    super();
    setImmediate(() => {
      if (script.stdout) this.stdout.emit("data", Buffer.from(script.stdout));
      if (script.stderr) this.stderr.emit("data", Buffer.from(script.stderr));
      this.exitCode = script.code ?? 0;
      this.emit("exit", this.exitCode, null);
      this.emit("close", this.exitCode);
    });
  }
  kill(): boolean {
    return true;
  }
}

function fakeSpawn(script: SpawnScript) {
  const calls: Array<{ binary: string; args: string[] }> = [];
  const spawnImpl = ((binary: string, args: string[]) => {
    calls.push({ binary, args });
    return new FakeChild(script(binary, args) ?? { code: 0 });
  }) as unknown as typeof spawn;
  return { calls, spawnImpl };
}

function configFor(root: string): ArenaRuntimeConfig {
  return {
    dirs: {
      root, data: join(root, "data"), projects: join(root, "projects"), waveyard: join(root, "waveyard"),
      cache: join(root, "cache"), logs: join(root, "logs"), models: join(root, "models"),
      runtime: join(root, "runtime"), settings: join(root, "settings"), portable: false, source: "env" as const,
    },
    host: "127.0.0.1",
    port: 54329,
    database: {
      user: "arena",
      password: "test-password",
      name: "arena_test",
      port: 54330,
      socketDir: null,
      dataDir: join(root, "data", "postgres"),
    },
    postgres: {
      nativeDir: "/fake/native",
      initdb: "/fake/native/bin/initdb",
      pgCtl: "/fake/native/bin/pg_ctl",
      postgres: "/fake/native/bin/postgres",
      libDir: "/fake/native/lib",
      windowsPathDirs: [],
    },
    migrationsDir: join(root, "migrations"),
    ffmpegPath: null,
    ffprobePath: null,
    storageDir: join(root, "waveyard", "storage"),
    modelsDir: join(root, "waveyard", "models"),
    server: { kind: "dev", cwd: root, nodeBinary: process.execPath },
    mode: "desktop" as const,
  };
}

const silent = { info: () => undefined, warn: () => undefined, error: () => undefined };

test("version mismatch refuses to start and NEVER falls back to initdb", async () => {
  const root = await mkdtemp(join(tmpdir(), "arena-pg-unit-"));
  try {
    const config = configFor(root);
    await mkdir(config.database.dataDir, { recursive: true });
    await writeFile(join(config.database.dataDir, "PG_VERSION"), "16\n");
    await writeFile(join(config.database.dataDir, "base"), "precious user data");

    const { calls, spawnImpl } = fakeSpawn((binary, args) =>
      args.includes("--version") ? { stdout: "postgres (PostgreSQL) 18.4\n", code: 0 } : { code: 0 },
    );
    const pg = new EmbeddedPostgres(config, silent, spawnImpl, () => false);
    await assert.rejects(() => pg.ensureStarted(), /version mismatch/i);

    // Only `postgres --version` ran: no initdb, no server start.
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0].args, ["--version"]);

    // The error is actionable and the data directory is untouched.
    const status = pg.status;
    assert.equal(status.state, "failed");
    assert.match(status.lastError ?? "", /created by PostgreSQL 16/);
    assert.match(status.lastError ?? "", /will NOT delete, overwrite, or reinitialise/);
    assert.equal(await readFile(join(config.database.dataDir, "PG_VERSION"), "utf8"), "16\n");
    assert.equal(await readFile(join(config.database.dataDir, "base"), "utf8"), "precious user data");
  } finally {
    await removeDirWithRetry(root);
  }
});

test("a directory with contents but no readable PG_VERSION is refused, never initialised", async () => {
  const root = await mkdtemp(join(tmpdir(), "arena-pg-unit-"));
  try {
    const config = configFor(root);
    await mkdir(config.database.dataDir, { recursive: true });
    await writeFile(join(config.database.dataDir, "postmaster.pid"), "999999\n");

    const { calls, spawnImpl } = fakeSpawn(() => ({ code: 0 }));
    const pg = new EmbeddedPostgres(config, silent, spawnImpl, () => false);
    await assert.rejects(() => pg.ensureStarted(), /no readable PG_VERSION/);
    assert.equal(calls.length, 0, "nothing may spawn when the directory state is inconsistent");
    assert.match(pg.status.lastError ?? "", /will not reinitialise/);
  } finally {
    await removeDirWithRetry(root);
  }
});

test("an unparseable PG_VERSION is treated as damaged metadata, not as a fresh directory", async () => {
  const root = await mkdtemp(join(tmpdir(), "arena-pg-unit-"));
  try {
    const config = configFor(root);
    await mkdir(config.database.dataDir, { recursive: true });
    await writeFile(join(config.database.dataDir, "PG_VERSION"), "banana");
    const { calls, spawnImpl } = fakeSpawn(() => ({ code: 0 }));
    const pg = new EmbeddedPostgres(config, silent, spawnImpl, () => false);
    await assert.rejects(() => pg.ensureStarted(), /no readable PG_VERSION/);
    assert.equal(calls.length, 0);
  } finally {
    await removeDirWithRetry(root);
  }
});

test("a startup failure preserves the server's own output in the error and status.lastError", async () => {
  const root = await mkdtemp(join(tmpdir(), "arena-pg-unit-"));
  try {
    const config = configFor(root);
    const fatal = 'FATAL: database files are incompatible with server\nDETAIL: The data directory was initialized by PostgreSQL version 16.';
    const { calls, spawnImpl } = fakeSpawn((_binary, args) => {
      if (args.includes("--version")) return { stdout: "postgres (PostgreSQL) 16.14\n", code: 0 };
      if (args.includes("--pwfile")) return { code: 0 }; // initdb
      return { stderr: fatal, code: 1 }; // the server refuses to start
    });
    const pg = new EmbeddedPostgres(config, silent, spawnImpl, () => false);
    let thrown: Error | null = null;
    try {
      await pg.ensureStarted();
    } catch (error) {
      thrown = error as Error;
    }
    assert.notEqual(thrown, null, "startup must fail");
    assert.match(thrown!.message, /exited during startup/);
    assert.match(thrown!.message, /FATAL: database files are incompatible with server/);
    assert.match(pg.status.lastError ?? "", /FATAL: database files are incompatible with server/);

    // Exactly: initdb once, then the server — and NO second initdb as a
    // "recovery" fallback when the server would not start. (A blank-slate
    // first run needs no `postgres --version` pre-check: there is no
    // existing cluster to protect.)
    assert.equal(calls.length, 2);
    assert.equal(calls[0].args.includes("--pwfile"), true);
    assert.equal(calls[1].args.includes("-p"), true);
  } finally {
    await removeDirWithRetry(root);
  }
});

test("a matching major version proceeds past the guard to the real server spawn", async () => {
  const root = await mkdtemp(join(tmpdir(), "arena-pg-unit-"));
  try {
    const config = configFor(root);
    await mkdir(config.database.dataDir, { recursive: true });
    await writeFile(join(config.database.dataDir, "PG_VERSION"), "16\n");
    const { calls, spawnImpl } = fakeSpawn((binary, args) => {
      if (args.includes("--version")) return { stdout: "postgres (PostgreSQL) 16.14\n", code: 0 };
      return { stderr: "shutting down", code: 1 };
    });
    const pg = new EmbeddedPostgres(config, silent, spawnImpl, () => false);
    await assert.rejects(() => pg.ensureStarted(), /exited during startup/);
    const serverSpawn = calls.find((c) => c.args.includes("-p"));
    assert.notEqual(serverSpawn, undefined, "server must be spawned once the guard passes");
    assert.equal(serverSpawn!.binary, config.postgres.postgres);
    assert.equal(calls.some((c) => c.args.includes("--pwfile")), false, "no initdb on an existing cluster");
  } finally {
    await removeDirWithRetry(root);
  }
});

test("a failing initdb preserves its output and does not continue to startup", async () => {
  const root = await mkdtemp(join(tmpdir(), "arena-pg-unit-"));
  try {
    const config = configFor(root);
    const { calls, spawnImpl } = fakeSpawn((_binary, args) => {
      if (args.includes("--pwfile")) return { stderr: "initdb: error: could not create directory", code: 1 };
      return { code: 0 };
    });
    const pg = new EmbeddedPostgres(config, silent, spawnImpl, () => false);
    await assert.rejects(() => pg.ensureStarted(), /initdb failed \(exit 1\):[\s\S]*could not create directory/);
    assert.equal(calls.length, 1);
  } finally {
    await removeDirWithRetry(root);
  }
});

// ---------- real bundled binaries ----------------------------------------

function realConfig(root: string): ArenaRuntimeConfig | null {
  const platformPackage = `@embedded-postgres/${process.platform === "win32" ? "windows" : process.platform === "darwin" ? "darwin" : "linux"}-x64`;
  const nativeDir = path.join(process.cwd(), "node_modules", platformPackage, "native");
  if (!existsSync(path.join(nativeDir, "bin"))) return null;
  const ext = process.platform === "win32" ? ".exe" : "";
  return {
    dirs: {
      root, data: join(root, "data"), projects: join(root, "projects"), waveyard: join(root, "waveyard"),
      cache: join(root, "cache"), logs: join(root, "logs"), models: join(root, "models"),
      runtime: join(root, "runtime"), settings: join(root, "settings"), portable: false, source: "env" as const,
    },
    host: "127.0.0.1",
    port: 0,
    database: {
      user: "arena",
      password: "test-password",
      name: "arena_version_guard",
      port: 0,
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
    migrationsDir: join(root, "migrations"),
    ffmpegPath: null,
    ffprobePath: null,
    storageDir: join(root, "waveyard", "storage"),
    modelsDir: join(root, "waveyard", "models"),
    server: { kind: "dev", cwd: root, nodeBinary: process.execPath },
    mode: "desktop" as const,
  };
}

test("real cluster: version guard refuses a mismatched PG_VERSION and the data survives", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "arena-pg-real-"));
  const config = realConfig(root);
  if (config === null) {
    await rm(root, { recursive: true, force: true });
    return t.skip("embedded postgres platform package unavailable");
  }
  const { pickFreePort } = await import("./config");
  config.port = await pickFreePort("127.0.0.1");
  config.database.port = await pickFreePort("127.0.0.1");

  t.after(async () => {
    await removeDirWithRetry(root);
  });

  // 1. A real first run initialises and starts the bundled (PG 16) server.
  const first = new EmbeddedPostgres(config, silent);
  await first.ensureStarted();
  assert.equal(first.status.state, "running");
  assert.equal(first.status.firstRun, true);
  await first.stop(10_000);

  const dataDir = config.database.dataDir;
  const listingBefore = (await readdir(dataDir)).sort();

  // 2. Simulate the field incident: a data directory from a DIFFERENT major
  //    than the bundled server. Startup must refuse with a useful error.
  await writeFile(join(dataDir, "PG_VERSION"), "18\n");
  const guard = new EmbeddedPostgres(config, silent);
  await assert.rejects(() => guard.ensureStarted(), /version mismatch/i);
  assert.match(guard.status.lastError ?? "", /created by PostgreSQL 18/);
  assert.match(guard.status.lastError ?? "", /will NOT delete, overwrite, or reinitialise/);

  // 3. Nothing was reinitialised, replaced or cleaned up.
  assert.equal(await readFile(join(dataDir, "PG_VERSION"), "utf8"), "18\n");
  assert.deepEqual((await readdir(dataDir)).sort(), listingBefore);

  // 4. Restoring the marker makes the same data openable again — the
  //    recovery path never required destroying anything.
  await writeFile(join(dataDir, "PG_VERSION"), "16\n");
  const again = new EmbeddedPostgres(config, silent);
  await again.ensureStarted();
  assert.equal(again.status.state, "running");
  assert.equal(again.status.firstRun, false, "an existing cluster is not a first run");
  await again.stop(10_000);
});
