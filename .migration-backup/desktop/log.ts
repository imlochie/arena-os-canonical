/**
 * Arena desktop logger — JSONL to the logs directory plus an in-memory ring
 * buffer for the future diagnostics center (Phase 17).
 *
 * Fields are redacted before writing: secrets never enter diagnostics.
 */

import { appendFile, mkdir } from "node:fs/promises";
import { join } from "node:path";

export type LogLevel = "info" | "warn" | "error";

export interface LogEntry {
  ts: string;
  level: LogLevel;
  scope: string;
  msg: string;
  fields?: Record<string, unknown>;
}

const SECRET_KEY_RE =
  /(secret|token|password|passwd|api[-_]?key|authorization|credential)/i;

export function redact(
  fields: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(fields)) {
    if (SECRET_KEY_RE.test(key)) {
      out[key] = "[redacted]";
    } else if (
      value !== null &&
      typeof value === "object" &&
      !Array.isArray(value)
    ) {
      out[key] = redact(value as Record<string, unknown>);
    } else {
      out[key] = value;
    }
  }
  return out;
}

export interface LoggerOptions {
  dir: string;
  file?: string;
  maxRing?: number;
  write?: (file: string, line: string) => Promise<void>;
  now?: () => string;
}

export class ArenaLogger {
  private readonly file: string;
  private readonly ring: LogEntry[] = [];
  private readonly maxRing: number;
  private readonly opts: LoggerOptions;

  constructor(opts: LoggerOptions) {
    this.opts = opts;
    this.file = join(opts.dir, opts.file ?? "arena-desktop.log");
    this.maxRing = opts.maxRing ?? 200;
  }

  get logFile(): string {
    return this.file;
  }

  async init(): Promise<void> {
    await mkdir(this.opts.dir, { recursive: true });
    await this.log("info", "log", "session started", { file: this.file });
  }

  async log(
    level: LogLevel,
    scope: string,
    msg: string,
    fields?: Record<string, unknown>,
  ): Promise<void> {
    const entry: LogEntry = {
      ts: this.now(),
      level,
      scope,
      msg,
      fields: fields === undefined ? undefined : redact(fields),
    };
    await this.append(entry);
    this.ring.push(entry);
    if (this.ring.length > this.maxRing) this.ring.shift();
  }

  info(scope: string, msg: string, fields?: Record<string, unknown>) {
    return this.log("info", scope, msg, fields);
  }

  warn(scope: string, msg: string, fields?: Record<string, unknown>) {
    return this.log("warn", scope, msg, fields);
  }

  error(scope: string, msg: string, fields?: Record<string, unknown>) {
    return this.log("error", scope, msg, fields);
  }

  /** Ring-buffer snapshot for the diagnostics center. */
  recent(): readonly LogEntry[] {
    return [...this.ring];
  }

  private async append(entry: LogEntry): Promise<void> {
    const write =
      this.opts.write ??
      ((file: string, line: string) => appendFile(file, line, "utf8"));
    try {
      await write(this.file, JSON.stringify(entry) + "\n");
    } catch {
      // Never crash the desktop shell because a log write failed.
    }
  }

  private now(): string {
    return (this.opts.now ?? (() => new Date().toISOString()))();
  }
}
