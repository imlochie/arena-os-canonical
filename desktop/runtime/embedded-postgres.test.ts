/**
 * Embedded PostgreSQL pre-start validation and diagnostics.
 *
 * Fake-spawn tests cover version matching/mismatch, missing metadata and
 * startup-failure output propagation without needing binaries. One real-binary
 * test proves an existing cluster is reopened (not re-initialised) and its
 * data survives a restart.
 */

import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import type { spawn } from "node:child_process";

import type { ArenaRuntimeConfig } from "./config";
import { EmbeddedPostgres, parsePgVersionFile, parsePostgresMajor } from "./embedded-postgres";

const silent = { info: () => undefined, warn: () => undefined, error: () => undefined };

function makeConfig(root: string, nativeDir = path.join(root, "native")): ArenaRuntimeConfig {
  return {
    host: "127.0.0.1",
    database: { user: "arena", password: "pw", name: "arena", port: 1, socketDir: null, dataDir: path.join(root, "data", "postgres") },
    postgres: {
      nativeDir,
      initdb: path.join(nativeDir, "bin", "initdb"),
      pgCtl: path.join(nativeDir, "bin", "pg_ctl"),
      postgres: path.join(nativeDir, "bin", "postgres"),
      libDir: path.join(nativeDir, "lib"),
      windowsPathDirs: [],
    },
  } as unknown as ArenaRuntimeConfig;
}

interface FakeOptions {
  versionOutput: string;
  serverOutput?: string;
  serverExitCode?: number;
}

/** Fake spawn: `--version` prints versionOutput; the server "crashes" printing serverOutput. */
function fakeSpawn(options: FakeOptions, calls: string[][]): typeof spawn {
  return ((_binary: string, args: string[]) => {
    calls.push(args);
    const child = new EventEmitter() as EventEmitter & { stdout: EventEmitter; stderr: EventEmitter; exitCode: number | null; signalCode: null };
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.exitCode = null;
    child.signalCode = null;
    setImmediate(() => {
      if (args[0] === "--version") {
        child.stdout.emit("data", Buffer.from(options.versionOutput));
        child.exitCode = 0;
        child.emit("close", 0);
        return;
      }
      if (options.serverOutput) child.stderr.emit("data", Buffer.from(options.serverOutput));
      child.exitCode = options.serverExitCode ?? 1;
      child.emit("exit", child.exitCode, null);
    });
    return child;
  }) as unknown as typeof spawn;
}

function dataDirWith(root: string, pgVersion: string | null): void {
  const dir = path.join(root, "data", "postgres");
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, "base-marker"), "user data");
  if (pgVersion !== null) writeFileSync(path.join(dir, "PG_VERSION"), pgVersion);
}

test("version parsers", () => {
  assert.equal(parsePostgresMajor("postgres (PostgreSQL) 16.14\n"), 16);
  assert.equal(parsePostgresMajor("postgres (PostgreSQL) 18.4"), 18);
  assert.equal(parsePostgresMajor("postgres (PostgreSQL) 9.6.24"), 9);
  assert.equal(parsePostgresMajor("garbage"), null);
  assert.equal(parsePgVersionFile("16\n"), 16);
  assert.equal(parsePgVersionFile("9.6"), 9);
  assert.equal(parsePgVersionFile(""), null);
  assert.equal(parsePgVersionFile(null), null);
  assert.equal(parsePgVersionFile("sixteen"), null);
});

test("version mismatch fails with an actionable error and leaves data untouched", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "arena-pgver-"));
  try {
    dataDirWith(root, "16\n");
    const calls: string[][] = [];
    const pg = new EmbeddedPostgres(makeConfig(root), silent, fakeSpawn({ versionOutput: "postgres (PostgreSQL) 18.4\n" }, calls));
    await assert.rejects(pg.ensureStarted(), (error: Error) => {
      assert.match(error.message, /created by PostgreSQL 16/);
      assert.match(error.message, /bundles PostgreSQL 18/);
      assert.match(error.message, /NOT been modified/);
      return true;
    });
    assert.equal(pg.status.state, "failed");
    assert.match(pg.status.lastError ?? "", /PostgreSQL 16/);
    // Only `--version` ran: no initdb, no server start.
    assert.deepEqual(calls, [["--version"]]);
    assert.equal(readFileSync(path.join(root, "data", "postgres", "PG_VERSION"), "utf8"), "16\n");
    assert.equal(readFileSync(path.join(root, "data", "postgres", "base-marker"), "utf8"), "user data");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("matching versions proceed to server start", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "arena-pgver-"));
  try {
    dataDirWith(root, "16\n");
    const calls: string[][] = [];
    const pg = new EmbeddedPostgres(makeConfig(root), silent, fakeSpawn({ versionOutput: "postgres (PostgreSQL) 16.14\n", serverOutput: "boom", serverExitCode: 1 }, calls));
    await assert.rejects(pg.ensureStarted(), /exited during startup/);
    assert.deepEqual(calls[0], ["--version"]);
    assert.equal(calls[1]?.[0], "-D", "server was spawned after the version check passed");
    assert.ok(!calls.some((c) => c.includes("--pwfile")), "must not initdb an existing cluster");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("missing or invalid PG_VERSION in a non-empty data dir refuses to initialise", async () => {
  for (const version of [null, "garbage"]) {
    const root = mkdtempSync(path.join(tmpdir(), "arena-pgver-"));
    try {
      dataDirWith(root, version);
      const calls: string[][] = [];
      const pg = new EmbeddedPostgres(makeConfig(root), silent, fakeSpawn({ versionOutput: "postgres (PostgreSQL) 16.14\n" }, calls));
      await assert.rejects(pg.ensureStarted(), /PG_VERSION/);
      assert.equal(pg.status.state, "failed");
      assert.deepEqual(calls, [], "no process may be spawned (no initdb, no server)");
      assert.equal(readFileSync(path.join(root, "data", "postgres", "base-marker"), "utf8"), "user data");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
});

test("startup failure surfaces the real postgres output, not 'no output'", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "arena-pgver-"));
  try {
    dataDirWith(root, "16\n");
    const message = 'FATAL:  database files are incompatible with server';
    const pg = new EmbeddedPostgres(makeConfig(root), silent, fakeSpawn({ versionOutput: "postgres (PostgreSQL) 16.14\n", serverOutput: message, serverExitCode: 1 }, []));
    await assert.rejects(pg.ensureStarted(), (error: Error) => {
      assert.ok(error.message.includes(message), error.message);
      assert.ok(!error.message.includes("no output"));
      assert.match(error.message, /code 1/);
      return true;
    });
    assert.ok((pg.status.lastError ?? "").includes(message));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("an unreadable bundled server version is reported, not ignored", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "arena-pgver-"));
  try {
    dataDirWith(root, "16\n");
    const pg = new EmbeddedPostgres(makeConfig(root), silent, fakeSpawn({ versionOutput: "???" }, []));
    await assert.rejects(pg.ensureStarted(), /Could not determine the bundled PostgreSQL version/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("real binaries: an existing cluster is reopened (not re-initialised) with data intact", async (t) => {
  const platformPackage = `@embedded-postgres/${process.platform === "win32" ? "windows" : "linux"}-x64`;
  const nativeDir = path.join(process.cwd(), "node_modules", platformPackage, "native");
  if (!existsSync(path.join(nativeDir, "bin"))) return t.skip("embedded postgres platform package unavailable");
  const root = mkdtempSync(path.join(tmpdir(), "arena-pgreal-"));
  const { pickFreePort } = await import("./config");
  const config = makeConfig(root, nativeDir);
  config.database.port = await pickFreePort("127.0.0.1");
  const { Client } = await import("pg");
  const query = async (sql: string) => {
    const client = new Client({ host: "127.0.0.1", port: config.database.port, user: "arena", password: "pw", database: "postgres" });
    await client.connect();
    try {
      return await client.query(sql);
    } finally {
      await client.end();
    }
  };
  const first = new EmbeddedPostgres(config, silent);
  try {
    await first.ensureStarted();
    assert.equal(first.status.firstRun, true);
    await query("create table keepme (v text)");
    await query("insert into keepme values ('persisted')");
    await first.stop(10_000);

    const second = new EmbeddedPostgres(config, silent);
    await second.ensureStarted();
    assert.equal(second.status.firstRun, false);
    assert.deepEqual((await query("select v from keepme")).rows, [{ v: "persisted" }]);
    await second.stop(10_000);
  } finally {
    await first.stop(5_000).catch(() => undefined);
    const { removeDirWithRetry } = await import("./fs-cleanup");
    await removeDirWithRetry(root);
  }
});
