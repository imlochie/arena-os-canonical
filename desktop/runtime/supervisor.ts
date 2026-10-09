/**
 * ArenaRuntimeSupervisor — the desktop's real lifecycle owner.
 *
 * Ordered start: storage dirs → embedded Postgres (initdb on first run,
 * readiness via real login) → migrations → application database →
 * Next server (tracked child) → /api/health handshake → ready.
 * Ordered stop: server (SIGTERM, wait, force) → Postgres fast shutdown.
 * No unmanaged children: everything spawned is tracked and stopped.
 *
 * The module is Electron-free so the exact supervisor that ships in the
 * desktop app also runs headless (tests, smoke, Linux E2E).
 */

import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync } from "node:fs";

import { ChildProcessRegistry } from "../processes";
import { applyMigrations } from "./migrate";
import { EmbeddedPostgres, type PostgresStatus } from "./embedded-postgres";
import type { ArenaRuntimeConfig } from "./config";

export type RuntimePhase =
  | "idle"
  | "storage"
  | "postgres"
  | "migrating"
  | "server"
  | "health"
  | "ready"
  | "failed"
  | "stopped";

export interface RuntimeStageEvent {
  phase: RuntimePhase;
  detail?: string;
  at: string;
}

export interface RuntimeStatus {
  phase: RuntimePhase;
  serverUrl: string | null;
  stages: RuntimeStageEvent[];
  postgres: PostgresStatus | null;
  lastError: string | null;
}

export interface SupervisorLogger {
  info: (scope: string, message: string, detail?: Record<string, unknown>) => void;
  warn: (scope: string, message: string, detail?: Record<string, unknown>) => void;
  error: (scope: string, message: string, detail?: Record<string, unknown>) => void;
}

export interface SupervisorOptions {
  logger?: SupervisorLogger;
  spawnImpl?: typeof spawn;
  fetchImpl?: typeof fetch;
  healthTimeoutMs?: number;
  postgresStopTimeoutMs?: number;
}

const DEFAULT_HEALTH_TIMEOUT_MS = 120_000;

export class ArenaRuntimeSupervisor {
  private phase: RuntimePhase = "idle";
  private readonly stages: RuntimeStageEvent[] = [];
  private serverChild: ChildProcess | null = null;
  private serverExitReason: string | null = null;
  private lastError: string | null = null;
  private readonly registry = new ChildProcessRegistry();
  private readonly logger: SupervisorLogger;
  private readonly fetchImpl: typeof fetch;
  private readonly healthTimeoutMs: number;
  private readonly postgresStopTimeoutMs: number;
  private readonly config: ArenaRuntimeConfig;
  private readonly postgres: EmbeddedPostgres;

  constructor(config: ArenaRuntimeConfig, options: SupervisorOptions = {}, postgres?: EmbeddedPostgres) {
    this.config = config;
    this.postgres = postgres ?? new EmbeddedPostgres(config);
    this.logger = options.logger ?? console;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.healthTimeoutMs = options.healthTimeoutMs ?? DEFAULT_HEALTH_TIMEOUT_MS;
    this.postgresStopTimeoutMs = options.postgresStopTimeoutMs ?? 10_000;
  }

  get status(): RuntimeStatus {
    return {
      phase: this.phase,
      serverUrl: this.phase === "ready" ? this.serverUrl : null,
      stages: this.stages,
      postgres: this.postgres.status,
      lastError: this.lastError,
    };
  }

  get serverUrl(): string {
    return `http://${this.config.host}:${this.config.port}`;
  }

  private setPhase(phase: RuntimePhase, detail?: string): void {
    this.phase = phase;
    this.stages.push({ phase, detail, at: new Date().toISOString() });
    this.logger.info("runtime", `phase → ${phase}`, { detail });
  }

  private fail(message: string): never {
    this.lastError = message;
    this.setPhase("failed", message);
    this.logger.error("runtime", "startup failed", { error: message });
    throw new Error(message);
  }

  private serverEnv(): NodeJS.ProcessEnv {
    const { config } = this;
    return {
      ...process.env,
      NODE_ENV: process.env.NODE_ENV ?? "production",
      ARENA_DESKTOP_MODE: "1",
      DATABASE_URL: `postgres://${encodeURIComponent(config.database.user)}:${encodeURIComponent(config.database.password)}@${config.host}:${config.database.port}/${config.database.name}`,
      WAVEYARD_STORAGE_DIR: config.storageDir,
      WAVEYARD_MODELS_DIR: config.modelsDir,
      PORT: String(config.port),
      HOSTNAME: config.host,
      ...(config.ffmpegPath !== null ? { ARENA_FFMPEG_PATH: config.ffmpegPath } : {}),
      ...(config.ffprobePath !== null ? { ARENA_FFPROBE_PATH: config.ffprobePath } : {}),
      // Desktop mode never uses Redis even if the dev machine has one.
      REDIS_URL: "",
    };
  }

  async start(): Promise<string> {
    if (this.phase === "ready") return this.serverUrl;

    // 1. Storage + runtime directories (app data, never CWD).
    this.setPhase("storage");
    for (const dir of [this.config.storageDir, this.config.modelsDir, this.config.dirs.runtime, this.config.dirs.logs]) {
      mkdirSync(dir, { recursive: true });
    }

    // 2. Embedded PostgreSQL with real readiness.
    this.setPhase("postgres");
    await this.postgres.ensureStarted();

    // 3. Migrations (single-transaction, tracked) + application database.
    this.setPhase("migrating");
    await this.postgres.createDatabaseIfMissing();
    const { Client } = await import("pg");
    const client = new Client(this.postgres.clientConfig(this.config.database.name));
    await client.connect();
    try {
      const outcome = await applyMigrations({ client, migrationsDir: this.config.migrationsDir, logger: this.logger });
      this.logger.info("migrate", "database schema ready", { applied: outcome.applied.length, alreadyApplied: outcome.skipped.length });
    } finally {
      await client.end();
    }

    // 4. Next server as a tracked child.
    this.setPhase("server");
    this.spawnServer();

    // 5. Real /api/health handshake — no sleep-and-hope.
    this.setPhase("health");
    await this.waitForHealth();

    this.setPhase("ready");
    return this.serverUrl;
  }

  private spawnServer(): void {
    const { config } = this;
    const env = this.serverEnv();
    if (config.server.kind === "dev") {
      this.serverChild = this.registry.spawn(config.server.nodeBinary, ["node_modules/next/dist/bin/next", "dev", "--port", String(config.port)], {
        cwd: config.server.cwd,
        env,
        onStdout: (chunk) => this.logger.info("server", chunk.trimEnd()),
        onStderr: (chunk) => this.logger.warn("server", chunk.trimEnd()),
        onExit: (code, signal) => {
          if (this.phase !== "stopped" && this.phase !== "ready") {
            this.serverExitReason = `Next dev server exited during startup (code ${code}, signal ${signal})`;
          }
        },
      });
      return;
    }
    // Packaged: the Electron binary becomes a real Node runtime for the
    // standalone Next server — no system Node dependency.
    const childEnv = { ...env, ELECTRON_RUN_AS_NODE: "1" };
    this.serverChild = this.registry.spawn(config.server.nodeBinary, [config.server.serverScript], {
      cwd: undefined,
      env: childEnv,
      onStdout: (chunk) => this.logger.info("server", chunk.trimEnd()),
      onStderr: (chunk) => this.logger.warn("server", chunk.trimEnd()),
      onExit: (code, signal) => {
        if (this.phase !== "stopped" && this.phase !== "ready") {
          this.serverExitReason = `Server exited during startup (code ${code}, signal ${signal})`;
        }
      },
    });
  }

  private async waitForHealth(): Promise<void> {
    const deadline = Date.now() + this.healthTimeoutMs;
    const url = `${this.serverUrl}/api/health`;
    let lastError = "unknown";
    while (Date.now() < deadline) {
      if (this.serverExitReason !== null) this.fail(this.serverExitReason);
      try {
        const response = await this.fetchImpl(url, { signal: AbortSignal.timeout(5_000) });
        if (response.ok) {
          const body = (await response.json()) as { ok?: boolean };
          if (body.ok === true) return;
          lastError = `health endpoint returned ok=${String(body.ok)}`;
        } else {
          lastError = `health endpoint returned ${response.status}`;
        }
      } catch (error) {
        lastError = error instanceof Error ? error.message : String(error);
      }
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    this.fail(`Server did not become healthy at ${url} within ${this.healthTimeoutMs}ms; last error: ${lastError}`);
  }

  /** Ordered reverse shutdown. Safe to call multiple times. */
  async stop(): Promise<void> {
    if (this.phase === "stopped") return;
    this.setPhase("stopped");
    // 1. Stop the Next server first (it holds DB connections + jobs).
    if (this.serverChild !== null && this.serverChild.exitCode === null && this.serverChild.signalCode === null) {
      this.serverChild.kill("SIGTERM");
      const graceful = await new Promise<boolean>((resolve) => {
        const timer = setTimeout(() => resolve(false), 8_000);
        timer.unref?.();
        this.serverChild!.once("exit", () => {
          clearTimeout(timer);
          resolve(true);
        });
      });
      if (!graceful) this.serverChild.kill("SIGKILL");
    }
    await this.registry.shutdownAll(3_000);
    this.serverChild = null;
    // 2. Then the database.
    await this.postgres.stop(this.postgresStopTimeoutMs);
    this.logger.info("runtime", "runtime stopped");
  }
}
