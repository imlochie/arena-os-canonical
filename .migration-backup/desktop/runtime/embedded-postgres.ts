/**
 * Embedded PostgreSQL lifecycle — real binaries, no fake state.
 *
 * First run: initdb (password file, UTF8, C locale, scram-sha-256) into the
 * app-data postgres dir — only ever on a truly empty directory. Start:
 * postgres spawned as a TRACKED child bound to 127.0.0.1 on the persisted
 * port (plus a runtime-owned socket dir on POSIX). Readiness: actual pg
 * client connects with the real password. Stop: pg_ctl fast shutdown
 * (signals only as fallback — on Windows kill() is a hard TerminateProcess
 * that can leave background workers holding the data directory), then a
 * bounded wait for the cluster to be released.
 *
 * Data safety: before any start, the data directory's PG_VERSION is compared
 * against the bundled server binary's major version (`postgres --version`).
 * A mismatch fails fast with recovery options and NEVER falls back to
 * initialising a new cluster — existing user data is never traded for a
 * green startup indicator. Startup failures preserve the server's own
 * output in `status.lastError`.
 *
 * The same server is reused across restarts; a stale postmaster.pid from a
 * crashed session is detected by probing the recorded PID, never by
 * blindly deleting cluster state.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";

import type { ArenaRuntimeConfig } from "./config";

export type PostgresState = "uninitialised" | "starting" | "running" | "stopped" | "failed";

/** Read the cluster major version written by initdb (e.g. "16"). Returns
 *  null when the marker is absent OR unreadable/empty — the caller must
 *  treat both as "version metadata missing", never as "compatible". */
export function readDataDirVersion(dataDir: string): string | null {
  try {
    const raw = readFileSync(path.join(dataDir, "PG_VERSION"), "utf8").trim();
    return /^\d+$/.test(raw) ? raw : null;
  } catch {
    return null;
  }
}

/** Parse the major version out of `postgres --version` output
 *  ("postgres (PostgreSQL) 16.14" → "16"). Returns null on anything else. */
export function parsePostgresMajorVersion(versionOutput: string): string | null {
  const match = /\(PostgreSQL\)\s+(\d+)/i.exec(versionOutput);
  return match ? match[1] : null;
}

/**
 * The compatibility verdict the runtime enforces BEFORE touching a cluster:
 * a data directory can only be opened by a server of the same major version.
 * PostgreSQL itself enforces this at startup with a terse FATAL; we surface
 * it first, with the recovery options, and never "fix" it by reinitialising.
 */
export function describeVersionMismatch(params: { dataDir: string; dataDirVersion: string; serverMajor: string; serverVersionLine: string }): string {
  return (
    `PostgreSQL version mismatch: the database at ${params.dataDir} was created by PostgreSQL ${params.dataDirVersion} ` +
    `(PG_VERSION=${params.dataDirVersion}), but this Arena build bundles PostgreSQL ${params.serverMajor} ` +
    `(${params.serverVersionLine.trim()}). Arena will NOT delete, overwrite, or reinitialise the existing data directory. ` +
    `Recovery options: (1) run an Arena build that bundles PostgreSQL ${params.dataDirVersion} to open this database as-is, or ` +
    `(2) migrate a COPY of the data directory with pg_upgrade (never the only original) — see docs/POSTGRES-16-TO-18-MIGRATION.md.`
  );
}

export interface PostgresStatus {
  state: PostgresState;
  port: number;
  dataDir: string;
  firstRun: boolean;
  lastError: string | null;
}

export interface PostgresLogger {
  info: (scope: string, message: string, detail?: Record<string, unknown>) => void;
  warn: (scope: string, message: string, detail?: Record<string, unknown>) => void;
  error: (scope: string, message: string, detail?: Record<string, unknown>) => void;
}

export class EmbeddedPostgres {
  private child: ChildProcess | null = null;
  private state: PostgresState = "uninitialised";
  private lastError: string | null = null;
  private firstRun = false;
  private stopping = false;
  /** Everything the server binary printed this session. Startup failures
   *  MUST preserve a tail of this in lastError — the actual FATAL line is
   *  the only place PostgreSQL explains why it refused to start. */
  private bootLog = "";
  private cachedServerMajor: string | null = null;
  private cachedServerVersionLine = "";
  private readonly config: ArenaRuntimeConfig;
  private readonly logger: PostgresLogger;
  private readonly spawnImpl: typeof spawn;
  private readonly processExists: (pid: number) => boolean;

  constructor(
    config: ArenaRuntimeConfig,
    logger: PostgresLogger = console,
    spawnImpl: typeof spawn = spawn,
    processExists: (pid: number) => boolean = defaultProcessExists,
  ) {
    this.config = config;
    this.logger = logger;
    this.spawnImpl = spawnImpl;
    this.processExists = processExists;
  }

  get status(): PostgresStatus {
    return {
      state: this.state,
      port: this.config.database.port,
      dataDir: this.config.database.dataDir,
      firstRun: this.firstRun,
      lastError: this.lastError,
    };
  }

  private postgresEnv(): NodeJS.ProcessEnv {
    const env = { ...process.env };
    if (process.platform !== "win32") env.LD_LIBRARY_PATH = `${this.config.postgres.libDir}:${env.LD_LIBRARY_PATH ?? ""}`;
    else env.PATH = `${this.config.postgres.windowsPathDirs.join(path.delimiter)}${path.delimiter}${env.PATH ?? ""}`;
    return env;
  }

  /** Bounded tail of the server's own output, for error messages. */
  private bootTailSuffix(): string {
    return this.bootLog.trim() === "" ? "" : ` — server output: …${this.bootLog.slice(-2000)}`;
  }

  /** Major version of the bundled server binary — verified by RUNNING it,
   *  never assumed from a package version. */
  private async serverMajorVersion(): Promise<string> {
    if (this.cachedServerMajor !== null) return this.cachedServerMajor;
    let result: { code: number; output: string };
    try {
      result = await this.run(this.config.postgres.postgres, ["--version"]);
    } catch (error) {
      throw new Error(
        `Bundled PostgreSQL binary could not run (${this.config.postgres.postgres}): ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    const major = parsePostgresMajorVersion(result.output);
    if (result.code !== 0 || major === null) {
      throw new Error(`Bundled PostgreSQL binary version could not be determined (exit ${result.code}): ${result.output.slice(-500)}`);
    }
    this.cachedServerMajor = major;
    this.cachedServerVersionLine = result.output.trim();
    return major;
  }

  private run(binary: string, args: string[]): Promise<{ code: number; output: string }> {
    return new Promise((resolve, reject) => {
      const child = this.spawnImpl(binary, args, { env: this.postgresEnv(), stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
      let output = "";
      child.stdout?.on("data", (chunk: Buffer) => (output += String(chunk)));
      child.stderr?.on("data", (chunk: Buffer) => (output += String(chunk)));
      child.once("error", reject);
      child.once("close", (code) => resolve({ code: code ?? -1, output }));
    });
  }

  /** A live-but-not-ours postmaster.pid blocks startup; probe before deciding. */
  private stalePostmasterPid(): boolean {
    const pidFile = path.join(this.config.database.dataDir, "postmaster.pid");
    if (!existsSync(pidFile)) return false;
    try {
      const pid = Number.parseInt(readFileSync(pidFile, "utf8").split("\n")[0] ?? "", 10);
      if (Number.isInteger(pid) && pid > 0 && this.processExists(pid)) return false; // a live server owns it
    } catch {
      // unreadable: treat as stale
    }
    return true;
  }

  async ensureStarted(): Promise<void> {
    const { dataDir, socketDir, port } = this.config.database;
    mkdirSync(path.dirname(dataDir), { recursive: true });
    this.bootLog = "";

    const dataDirVersion = readDataDirVersion(dataDir);
    if (dataDirVersion !== null) {
      // Existing cluster: the bundled server must be the same MAJOR version
      // or PostgreSQL will refuse the data directory. Detect that here, with
      // the recovery options attached — and never "solve" it by
      // reinitialising (that would destroy the user's data).
      const serverMajor = await this.serverMajorVersion();
      if (serverMajor !== dataDirVersion) {
        this.state = "failed";
        this.lastError = describeVersionMismatch({
          dataDir,
          dataDirVersion,
          serverMajor,
          serverVersionLine: this.cachedServerVersionLine,
        });
        this.logger.error("postgres", "refusing to start: data-directory/server major version mismatch", {
          dataDirVersion,
          serverMajor,
        });
        throw new Error(this.lastError);
      }
      if (this.stalePostmasterPid()) {
        const pidFile = path.join(dataDir, "postmaster.pid");
        this.logger.warn("postgres", "removing stale postmaster.pid after crash", { pidFile });
        rmSync(pidFile, { force: true });
      }
    } else if (dirHasContents(dataDir)) {
      // Files exist but PG_VERSION does not (half-initialised cluster,
      // damaged marker, or foreign contents). This is NOT a blank slate:
      // initdb here would either fail or tempt a cleanup that destroys
      // evidence. Refuse — the only path that may initialise is a truly
      // empty/absent directory below.
      const entries = listDirBounded(dataDir);
      this.state = "failed";
      this.lastError =
        `Postgres data directory ${dataDir} contains files (${entries}) but no readable PG_VERSION. ` +
        `Arena will not reinitialise, delete, or overwrite it. Inspect the directory or restore it from a backup before starting.`;
      this.logger.error("postgres", "refusing to start: data directory has contents but no PG_VERSION", { dataDir, entries });
      throw new Error(this.lastError);
    } else {
      // First run — the ONLY branch that may initialise a cluster.
      this.logger.info("postgres", "first run: initialising database cluster", { dataDir });
      mkdirSync(dataDir, { recursive: true });
      const pwFile = path.join(path.dirname(dataDir), ".initdb-password");
      writeFileSync(pwFile, this.config.database.password, { mode: 0o600 });
      try {
        const result = await this.run(this.config.postgres.initdb, [
          "-D", dataDir,
          "-U", this.config.database.user,
          "--pwfile", pwFile,
          "-E", "UTF8",
          "--locale", "C",
          "-A", "scram-sha-256",
        ]);
        if (result.code !== 0) throw new Error(`initdb failed (exit ${result.code}): ${result.output.slice(-2000)}`);
        this.firstRun = true;
      } finally {
        rmSync(pwFile, { force: true });
      }
    }

    if (socketDir !== null) mkdirSync(socketDir, { recursive: true });
    this.state = "starting";
    this.logger.info("postgres", "starting embedded postgres", { port, socketDir });

    const args = ["-D", dataDir, "-p", String(port), "-h", this.config.host, "-F"];
    if (socketDir !== null) args.push("-k", socketDir);
    this.child = this.spawnImpl(this.config.postgres.postgres, args, {
      env: this.postgresEnv(),
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    this.child.stdout?.on("data", (chunk: Buffer) => (this.bootLog += String(chunk)));
    this.child.stderr?.on("data", (chunk: Buffer) => (this.bootLog += String(chunk)));
    this.child.once("error", (error) => {
      // spawn-level failure (binary missing, not executable, …) never emits
      // "exit" — record it or readiness would wait out the full timeout.
      if (!this.stopping) {
        this.state = "failed";
        this.lastError = `postgres could not be started (${this.config.postgres.postgres}): ${error.message}`;
        this.logger.error("postgres", "embedded postgres could not be spawned", { error: error.message });
      }
      this.child = null;
    });
    this.child.once("exit", (code, signal) => {
      if (!this.stopping && (this.state === "starting" || this.state === "running")) {
        this.logger.error("postgres", "embedded postgres exited unexpectedly", { code, signal });
        this.state = "failed";
        // Preserve the server's own output: it is the only record of WHY.
        this.lastError = `postgres exited (code ${code}, signal ${signal})${this.bootTailSuffix()}`;
      }
      this.child = null;
    });

    try {
      await this.waitForReadiness(30_000);
      this.state = "running";
      this.logger.info("postgres", "embedded postgres ready", { port, firstRun: this.firstRun });
    } catch (error) {
      this.state = "failed";
      const message = error instanceof Error ? error.message : String(error);
      this.lastError = message.includes("server output:") ? message : `${message}${this.bootTailSuffix()}`;
      await this.stop();
      throw new Error(this.lastError);
    }
  }

  /** Real readiness: a pg client logs in with the real password. */
  async waitForReadiness(timeoutMs: number): Promise<void> {
    const { Client } = await import("pg");
    const deadline = Date.now() + timeoutMs;
    let lastError: unknown = null;
    while (Date.now() < deadline) {
      if (this.child === null || this.child.exitCode !== null) {
        throw new Error(`embedded postgres exited during startup: ${this.lastError ?? "no output"}${this.lastError === null ? this.bootTailSuffix() : ""}`);
      }
      const client = new Client(this.clientConfig("postgres"));
      try {
        await client.connect();
        await client.query("select 1");
        await client.end();
        return;
      } catch (error) {
        lastError = error;
        try {
          await client.end();
        } catch {
          // already closed
        }
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
    }
    throw new Error(`embedded postgres did not become ready in ${timeoutMs}ms: ${lastError instanceof Error ? lastError.message : String(lastError)}${this.bootTailSuffix()}`);
  }

  clientConfig(database: string) {
    return {
      host: this.config.host,
      port: this.config.database.port,
      user: this.config.database.user,
      password: this.config.database.password,
      database,
    };
  }

  async createDatabaseIfMissing(): Promise<void> {
    const { Client } = await import("pg");
    const admin = new Client(this.clientConfig("postgres"));
    await admin.connect();
    try {
      const existing = await admin.query("select 1 from pg_database where datname = $1", [this.config.database.name]);
      if (existing.rowCount === 0) {
        await admin.query(`create database ${quoteIdent(this.config.database.name)}`);
        this.logger.info("postgres", "created application database", { name: this.config.database.name });
      }
    } finally {
      await admin.end();
    }
  }

  /**
   * Fast shutdown via `pg_ctl stop -m fast` (the supported cross-platform
   * mechanism), falling back to signals. SIGINT on POSIX is PostgreSQL's
   * fast shutdown, but on Windows `child.kill()` is TerminateProcess — a
   * hard kill that (a) skips checkpointing and (b) can leave background
   * workers (checkpointer, walwriter, …) alive for seconds, still holding
   * handles into the data directory (EBUSY on cleanup).
   */
  async stop(timeoutMs = 10_000): Promise<void> {
    this.stopping = true;
    const child = this.child;
    this.child = null;
    if (child === null || child.exitCode !== null || child.signalCode !== null) {
      this.state = this.state === "failed" ? "failed" : "stopped";
      await this.waitForClusterReleased(2_000);
      return;
    }
    this.logger.info("postgres", "stopping embedded postgres (fast shutdown)");
    const viaPgCtl = await this.stopViaPgCtl(timeoutMs);
    if (!viaPgCtl) {
      child.kill("SIGINT");
      const graceful = await waitForExit(child, timeoutMs);
      if (!graceful) {
        this.logger.warn("postgres", "fast shutdown timed out; sending immediate shutdown");
        child.kill("SIGQUIT");
        await waitForExit(child, 5_000);
      }
    } else {
      // pg_ctl already waited for the postmaster; this is belt-and-braces for
      // our direct child handle (and reaps the exit event).
      await waitForExit(child, 5_000);
    }
    // Deterministic release: a clean shutdown removes postmaster.pid; waiting
    // for that (bounded) proves the cluster — including background workers —
    // has let go of the data directory before callers delete it.
    await this.waitForClusterReleased(10_000);
    this.state = this.state === "failed" ? "failed" : "stopped";
  }

  /** `pg_ctl -D <dir> stop -m fast` — waits for full shutdown by itself. */
  private async stopViaPgCtl(timeoutMs: number): Promise<boolean> {
    const pgCtl = this.config.postgres.pgCtl;
    const dataDir = this.config.database.dataDir;
    if (!pgCtl || !existsSync(pgCtl) || !existsSync(path.join(dataDir, "PG_VERSION"))) return false;
    try {
      const seconds = Math.max(5, Math.ceil(timeoutMs / 1000));
      const result = await withTimeout(
        this.run(pgCtl, ["-D", dataDir, "stop", "-m", "fast", "-w", "-t", String(seconds)]),
        (seconds + 5) * 1000,
      );
      if (result.code === 0) return true;
      this.logger.warn("postgres", "pg_ctl fast shutdown failed; falling back to signals", {
        code: result.code,
        output: result.output.slice(-300),
      });
      return false;
    } catch (error) {
      this.logger.warn("postgres", "pg_ctl stop could not be executed; falling back to signals", { error: String(error) });
      return false;
    }
  }

  /**
   * Wait until the data directory is released. postmaster.pid is removed by
   * a clean shutdown; a hard-killed postmaster leaves it behind, in which
   * case we wait for the recorded PID to disappear (Windows: background
   * workers can outlive a terminated postmaster and keep the dir locked).
   */
  private async waitForClusterReleased(timeoutMs: number): Promise<boolean> {
    const pidFile = path.join(this.config.database.dataDir, "postmaster.pid");
    if (!existsSync(pidFile)) return true;
    const deadline = Date.now() + timeoutMs;
    let deadSince: number | null = null;
    while (Date.now() < deadline) {
      if (!existsSync(pidFile)) {
        this.logger.info("postgres", "cluster released (postmaster.pid removed)");
        return true;
      }
      // Pid file remains (hard-kill path): once the postmaster PID is gone,
      // background workers follow within moments — allow a short grace.
      const pid = readPidFromFile(pidFile);
      if (pid !== null && !this.processExists(pid)) {
        deadSince ??= Date.now();
        if (Date.now() - deadSince >= 2_000) {
          this.logger.info("postgres", "cluster released (postmaster gone, workers drained)");
          return true;
        }
      } else {
        deadSince = null;
      }
      await sleep(200);
    }
    // Bounded wait is over: report honestly, do not throw — the caller's
    // retrying directory cleanup will surface a real error if handles remain.
    this.logger.warn("postgres", "postmaster.pid still present after shutdown wait", { pidFile });
    return false;
  }
}

function readPidFromFile(pidFile: string): number | null {
  try {
    const pid = Number.parseInt(readFileSync(pidFile, "utf8").split("\n")[0] ?? "", 10);
    return Number.isInteger(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

/** True when the directory exists and holds at least one entry. */
function dirHasContents(dir: string): boolean {
  try {
    return readdirSync(dir).length > 0;
  } catch {
    return false;
  }
}

/** Bounded, human-readable entry list for error messages (never unbounded). */
function listDirBounded(dir: string, max = 5): string {
  try {
    const entries = readdirSync(dir);
    const shown = entries.slice(0, max).join(", ");
    return entries.length > max ? `${shown}, … (${entries.length} entries)` : shown;
  } catch {
    return "unreadable";
  }
}

function quoteIdent(name: string): string {
  if (!/^[a-z_][a-z0-9_]*$/.test(name)) throw new Error(`unsafe database name: ${name}`);
  return `"${name}"`;
}

function defaultProcessExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

function waitForExit(child: ChildProcess, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) {
      resolve(true);
      return;
    }
    const timer = setTimeout(() => resolve(false), timeoutMs);
    timer.unref?.();
    child.once("exit", () => {
      clearTimeout(timer);
      resolve(true);
    });
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timed out after ${timeoutMs}ms`)), timeoutMs);
    timer.unref?.();
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}
