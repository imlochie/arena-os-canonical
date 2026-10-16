/**
 * Embedded PostgreSQL lifecycle — real binaries, no fake state.
 *
 * First run: initdb (password file, UTF8, C locale, scram-sha-256) into the
 * app-data postgres dir. Start: postgres spawned as a TRACKED child bound to
 * 127.0.0.1 on the persisted port (plus a runtime-owned socket dir on
 * POSIX). Readiness: actual pg client connects with the real password.
 * Stop: pg_ctl fast shutdown (signals only as fallback — on Windows kill()
 * is a hard TerminateProcess that can leave background workers holding the
 * data directory), then a bounded wait for the cluster to be released.
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
  private bootLog = "";
  private exitInfo: { code: number | null; signal: NodeJS.Signals | null } | null = null;
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

  private fail(message: string): Error {
    this.state = "failed";
    this.lastError = message;
    this.logger.error("postgres", message);
    return new Error(message);
  }

  /**
   * Compare the data directory's PG_VERSION with the bundled server's major
   * version before starting. PostgreSQL cannot open a cluster written by a
   * different major version; fail with guidance instead of a silent exit.
   */
  private async assertDataDirCompatible(): Promise<void> {
    const { dataDir } = this.config.database;
    const dataMajor = parsePgVersionFile(safeRead(path.join(dataDir, "PG_VERSION")));
    if (dataMajor === null) {
      throw this.fail(
        `Postgres data directory ${dataDir} has an unreadable or invalid PG_VERSION file, so its version cannot be verified. ` +
          "Arena will not start or re-initialise it. Restore from a backup or inspect the directory manually.",
      );
    }
    let bundledMajor: number | null = null;
    let detail = "";
    try {
      const result = await this.run(this.config.postgres.postgres, ["--version"]);
      bundledMajor = result.code === 0 ? parsePostgresMajor(result.output) : null;
      detail = result.output.trim().slice(-300);
    } catch (error) {
      detail = error instanceof Error ? error.message : String(error);
    }
    if (bundledMajor === null) {
      throw this.fail(`Could not determine the bundled PostgreSQL version from ${this.config.postgres.postgres}: ${detail || "no output"}`);
    }
    if (bundledMajor !== dataMajor) {
      throw this.fail(
        `Postgres data directory ${dataDir} was created by PostgreSQL ${dataMajor}, but this Arena build bundles PostgreSQL ${bundledMajor}, ` +
          "which cannot open it. Your data has NOT been modified. " +
          `Install an Arena build that bundles PostgreSQL ${dataMajor}, or migrate the data with pg_upgrade on a copy of the directory. ` +
          "Do not delete the data directory.",
      );
    }
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
    const alreadyInitialised = existsSync(path.join(dataDir, "PG_VERSION"));
    if (!alreadyInitialised) {
      if (directoryHasEntries(dataDir)) {
        // Existing files without version metadata: never initdb over (or
        // beside) what may be a user's only copy of their data.
        throw this.fail(
          `Postgres data directory ${dataDir} is not empty but has no PG_VERSION file, so its server version cannot be verified. ` +
            "Arena will not initialise a new database over it. Restore PG_VERSION from a backup or move the directory aside manually.",
        );
      }
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
    } else {
      await this.assertDataDirCompatible();
    }
    if (alreadyInitialised && this.stalePostmasterPid()) {
      const pidFile = path.join(dataDir, "postmaster.pid");
      this.logger.warn("postgres", "removing stale postmaster.pid after crash", { pidFile });
      rmSync(pidFile, { force: true });
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
      this.bootLog += `spawn error: ${error.message}\n`;
    });
    this.child.once("exit", (code, signal) => {
      this.exitInfo = { code, signal };
      if (this.state === "running" && !this.stopping) {
        this.logger.error("postgres", "embedded postgres exited unexpectedly", { code, signal });
        this.state = "failed";
        this.lastError = `postgres exited (code ${code}, signal ${signal}): ${this.bootLog.slice(-1000)}`;
      }
      this.child = null;
    });

    try {
      await this.waitForReadiness(30_000);
      this.state = "running";
      this.logger.info("postgres", "embedded postgres ready", { port, firstRun: this.firstRun });
    } catch (error) {
      this.state = "failed";
      this.lastError = error instanceof Error ? error.message : String(error);
      await this.stop();
      throw error;
    }
  }

  /** Real readiness: a pg client logs in with the real password. */
  async waitForReadiness(timeoutMs: number): Promise<void> {
    const { Client } = await import("pg");
    const deadline = Date.now() + timeoutMs;
    let lastError: unknown = null;
    while (Date.now() < deadline) {
      if (this.child === null || this.child.exitCode !== null) {
        const exit = this.exitInfo === null ? "" : ` (code ${this.exitInfo.code}, signal ${this.exitInfo.signal})`;
        const output = this.bootLog.trim().slice(-2000);
        this.logger.error("postgres", "embedded postgres exited during startup", { output, ...this.exitInfo });
        throw new Error(`embedded postgres exited during startup${exit}: ${output === "" ? "no output" : output}`);
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
    throw new Error(`embedded postgres did not become ready in ${timeoutMs}ms: ${lastError instanceof Error ? lastError.message : String(lastError)}`);
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

/** "postgres (PostgreSQL) 16.14" -> 16; "postgres (PostgreSQL) 9.6.24" -> 9. */
export function parsePostgresMajor(output: string): number | null {
  const match = /PostgreSQL\)?\s+(\d+)(?:\.\d+)*/.exec(output);
  return match === null ? null : Number.parseInt(match[1] ?? "", 10);
}

/** PG_VERSION holds "16" (or "9.6" for legacy clusters). */
export function parsePgVersionFile(content: string | null): number | null {
  const match = /^\s*(\d+)(?:\.\d+)?\s*$/.exec(content ?? "");
  return match === null ? null : Number.parseInt(match[1] ?? "", 10);
}

function safeRead(file: string): string | null {
  try {
    return readFileSync(file, "utf8");
  } catch {
    return null;
  }
}

function directoryHasEntries(dir: string): boolean {
  try {
    return readdirSync(dir).length > 0;
  } catch {
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
