/**
 * Embedded PostgreSQL lifecycle — real binaries, no fake state.
 *
 * First run: initdb (password file, UTF8, C locale, scram-sha-256) into the
 * app-data postgres dir. Start: postgres spawned as a TRACKED child bound to
 * 127.0.0.1 on the persisted port (plus a runtime-owned socket dir on
 * POSIX). Readiness: actual pg client connects with the real password.
 * Stop: SIGINT (PostgreSQL "fast" shutdown), SIGQUIT fallback.
 *
 * The same server is reused across restarts; a stale postmaster.pid from a
 * crashed session is detected by probing the recorded PID, never by
 * blindly deleting cluster state.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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

    const alreadyInitialised = existsSync(path.join(dataDir, "PG_VERSION"));
    if (!alreadyInitialised) {
      this.logger.info("postgres", "first run: initialising database cluster", { dataDir });
      if (this.stalePostmasterPid()) {
        // Only reached when PG_VERSION is missing but a pid file exists —
        // inconsistent cluster remains; refuse rather than delete user data.
        this.state = "failed";
        this.lastError = "Postgres data directory is inconsistent (postmaster.pid without PG_VERSION).";
        throw new Error(this.lastError);
      }
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
    } else if (this.stalePostmasterPid()) {
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
    let bootLog = "";
    this.child.stdout?.on("data", (chunk: Buffer) => (bootLog += String(chunk)));
    this.child.stderr?.on("data", (chunk: Buffer) => (bootLog += String(chunk)));
    this.child.once("exit", (code, signal) => {
      if (this.state === "running" && !this.stopping) {
        this.logger.error("postgres", "embedded postgres exited unexpectedly", { code, signal });
        this.state = "failed";
        this.lastError = `postgres exited (code ${code}, signal ${signal}): ${bootLog.slice(-1000)}`;
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
        throw new Error(`embedded postgres exited during startup: ${this.lastError ?? "no output"}`);
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

  /** Fast shutdown (SIGINT); immediate (SIGQUIT) fallback after a timeout. */
  async stop(timeoutMs = 10_000): Promise<void> {
    this.stopping = true;
    const child = this.child;
    this.child = null;
    if (child === null || child.exitCode !== null || child.signalCode !== null) {
      this.state = this.state === "failed" ? "failed" : "stopped";
      return;
    }
    this.logger.info("postgres", "stopping embedded postgres (fast shutdown)");
    child.kill("SIGINT");
    const graceful = await waitForExit(child, timeoutMs);
    if (!graceful) {
      this.logger.warn("postgres", "fast shutdown timed out; sending immediate shutdown");
      child.kill("SIGQUIT");
      await waitForExit(child, 5000);
    }
    this.state = this.state === "failed" ? "failed" : "stopped";
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
