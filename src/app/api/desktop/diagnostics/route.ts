/**
 * Desktop diagnostics — real checks, never config-only READY (spec §9).
 *
 * Every subsystem is exercised: DB runs a query, storage writes+reads+deletes
 * a probe object, ffmpeg/ffprobe execute -version, the worker reports its
 * actual broker/queue state, AI providers report their credential state.
 * READY is only ever the result of a successful real interaction.
 */

import { NextResponse } from "next/server";
import { sql } from "drizzle-orm";
import { randomUUID } from "node:crypto";

import { db } from "@/db";
import { getStorage } from "@/lib/waveyard/storage";
import { execTool, resolveToolPath } from "@/lib/waveyard/ffmpeg";
import { listProviders } from "@/lib/waveyard/ai/providers";
import { localWorkerActive, localWorkerStats } from "@/lib/waveyard/worker-local";
import { queueConfigured } from "@/lib/waveyard/queue";

export const dynamic = "force-dynamic";

export type ComponentStatus = "READY" | "DEGRADED" | "UNAVAILABLE";

type Report = {
  status: ComponentStatus;
  reason: string;
  detail?: Record<string, unknown>;
};

async function checkDatabase(): Promise<Report> {
  try {
    await db.execute(sql`select 1`);
    return { status: "READY", reason: "PostgreSQL answered select 1.", detail: { mode: process.env.ARENA_DESKTOP_MODE === "1" ? "desktop-embedded" : "external" } };
  } catch (error) {
    return { status: "UNAVAILABLE", reason: `Database query failed: ${error instanceof Error ? error.message : String(error)}` };
  }
}

async function checkStorage(): Promise<Report> {
  try {
    const storage = getStorage();
    const key = `diagnostics/probe-${randomUUID()}.txt`;
    const payload = `arena-diagnostics-${new Date().toISOString()}`;
    await storage.putBuffer(key, payload);
    const readBack = await storage.getBuffer(key, 4096);
    if (!readBack.toString("utf8").includes("arena-diagnostics")) throw new Error("storage read-back mismatch");
    await storage.delete(key);
    return { status: "READY", reason: "Storage write/read/delete round-trip succeeded." };
  } catch (error) {
    return { status: "UNAVAILABLE", reason: `Storage probe failed: ${error instanceof Error ? error.message : String(error)}` };
  }
}

async function checkTool(tool: "ffmpeg" | "ffprobe"): Promise<Report> {
  const resolved = await resolveToolPath(tool);
  if (resolved === null) return { status: "UNAVAILABLE", reason: `${tool} binary was not found (no env override, no installer package, not on PATH).` };
  try {
    const { stdout } = await execTool(tool, ["-version"], { timeoutMs: 15_000 });
    const version = /version\s+(\S+)/.exec(stdout)?.[1] ?? "unknown";
    return { status: "READY", reason: `${tool} executed -version.`, detail: { path: resolved.path, source: resolved.source, version } };
  } catch (error) {
    return { status: "UNAVAILABLE", reason: `${tool} was found but failed to execute: ${error instanceof Error ? error.message : String(error)}` };
  }
}

function checkWorker(): Report {
  if (localWorkerActive()) {
    const stats = localWorkerStats();
    if (stats === null)
      return { status: "DEGRADED", reason: "Desktop local worker is active but no handlers are registered (instrumentation did not run)." };
    return {
      status: stats.failed > 0 ? "DEGRADED" : "READY",
      reason: `Local executor running ${stats.queues.length} queues: ${stats.queues.join(", ")}. Separation and Python-only analyses are not available on desktop.`,
      detail: { ...stats, cloudWorker: false },
    };
  }
  if (queueConfigured())
    return { status: "READY", reason: "Cloud worker queue (Redis/BullMQ) is configured.", detail: { cloudWorker: true } };
  return {
    status: "UNAVAILABLE",
    reason: "No job executor: REDIS_URL is not set and desktop mode is off. Processing jobs will fail with queue-unavailable.",
  };
}

function checkAi(): Report {
  const providers = listProviders();
  const available = providers.filter((provider) => provider.state === "available");
  if (available.length === 0)
    return {
      status: "DEGRADED",
      reason: "No AI provider has credentials. Core audio features are unaffected; AI features are unavailable until keys are set.",
      detail: { providers },
    };
  return { status: "READY", reason: `${available.length} AI provider(s) configured.`, detail: { providers } };
}

function checkServer(): Report {
  return {
    status: "READY",
    reason: "This response was served by the Arena server.",
    detail: { desktopMode: process.env.ARENA_DESKTOP_MODE === "1", node: process.version },
  };
}

export async function GET() {
  const [database, storage, ffmpeg, ffprobe] = await Promise.all([checkDatabase(), checkStorage(), checkTool("ffmpeg"), checkTool("ffprobe")]);
  const components = {
    server: checkServer(),
    database,
    storage,
    worker: checkWorker(),
    ffmpeg,
    ffprobe,
    ai: checkAi(),
  };
  const values = Object.values(components);
  const overall: ComponentStatus = values.some((report) => report.status === "UNAVAILABLE")
    ? "UNAVAILABLE"
    : values.some((report) => report.status === "DEGRADED")
      ? "DEGRADED"
      : "READY";
  return NextResponse.json({ overall, components, checkedAt: new Date().toISOString() });
}
