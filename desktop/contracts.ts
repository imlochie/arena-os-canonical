/**
 * Arena desktop IPC contracts — the single typed allowlist.
 *
 * Every channel the renderer may invoke lives here, with its request and
 * response shapes zod-validated. Nothing else is bridged. Adding desktop
 * surface means adding a channel here first — the preload exposes only
 * these, and the main process registers only these.
 */

import { z } from "zod";

/** Channel: renderer → main, app identity/runtime info. */
export const DESKTOP_INFO_CHANNEL = "app:getInfo" as const;

/** Channel: renderer → main, live runtime + subsystem diagnostics. */
export const DESKTOP_DIAGNOSTICS_CHANNEL = "app:getDiagnostics" as const;

/** The complete allowlist of invokable IPC channels. */
export const IPC_CHANNELS = [DESKTOP_INFO_CHANNEL, DESKTOP_DIAGNOSTICS_CHANNEL] as const;

export type IpcChannel = (typeof IPC_CHANNELS)[number];

export function isIpcChannel(value: unknown): value is IpcChannel {
  return (
    typeof value === "string" &&
    (IPC_CHANNELS as readonly unknown[]).includes(value)
  );
}

export const DesktopAppInfoSchema = z.object({
  name: z.string().min(1),
  version: z.string().min(1),
  platform: z.string().min(1),
  arch: z.string().min(1),
  electron: z.string(),
  chrome: z.string(),
  node: z.string(),
  dataDir: z.string().min(1),
  portable: z.boolean(),
  channel: z.enum(["dev", "stable", "beta"]),
});

export type DesktopAppInfo = z.infer<typeof DesktopAppInfoSchema>;

const StageEventSchema = z.object({
  phase: z.string().min(1),
  detail: z.string().nullable().optional(),
  at: z.string().min(1),
});

const PostgresStatusSchema = z.object({
  state: z.enum(["uninitialised", "starting", "running", "stopped", "failed"]),
  port: z.number().int().positive(),
  dataDir: z.string().min(1),
  firstRun: z.boolean(),
  lastError: z.string().nullable(),
});

export const RuntimeStatusSchema = z.object({
  phase: z.enum(["idle", "storage", "postgres", "migrating", "server", "health", "ready", "failed", "stopped"]),
  serverUrl: z.string().nullable(),
  stages: z.array(StageEventSchema),
  postgres: PostgresStatusSchema.nullable(),
  lastError: z.string().nullable(),
});

export type RuntimeStatusContract = z.infer<typeof RuntimeStatusSchema>;

/** Subsystem diagnostics as reported by the server's real checks. */
const ComponentReportSchema = z.object({
  status: z.enum(["READY", "DEGRADED", "UNAVAILABLE"]),
  reason: z.string().min(1),
  detail: z.record(z.string(), z.unknown()).optional(),
});

export const DesktopDiagnosticsSchema = z.object({
  runtime: RuntimeStatusSchema,
  subsystems: z
    .object({
      overall: z.enum(["READY", "DEGRADED", "UNAVAILABLE"]),
      components: z.record(z.string(), ComponentReportSchema),
      checkedAt: z.string().min(1),
    })
    .nullable(),
  source: z.enum(["main-process", "main-process-server-unreachable"]),
});

export type DesktopDiagnostics = z.infer<typeof DesktopDiagnosticsSchema>;
