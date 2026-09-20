import { desc, gt } from "drizzle-orm";
import { db } from "@/db";
import { stemWorkerHeartbeats } from "@/db/schema";
import { getStemQueueConnection } from "@/lib/stems/queue";
import { getStemStorage } from "@/lib/stems/storage";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

function workerUrl() { return process.env.STEM_WORKER_URL?.replace(/\/$/, ""); }
function pipelineEnabled() { return process.env.STEM_PIPELINE_ENABLED === "true"; }

async function pipelineHealth() {
  const freshAfter = new Date(Date.now() - 60_000);
  const [heartbeat] = await db.select().from(stemWorkerHeartbeats)
    .where(gt(stemWorkerHeartbeats.lastSeenAt, freshAfter)).orderBy(desc(stemWorkerHeartbeats.lastSeenAt)).limit(1);
  if (!heartbeat) return { available: false, reason: "No live Arena stem worker heartbeat has been recorded in the last minute." };
  if (await getStemQueueConnection().ping() !== "PONG") return { available: false, reason: "Redis did not accept a queue health check." };
  await getStemStorage().healthcheck();
  return { available: true, engine: heartbeat.engine, model: heartbeat.model, device: heartbeat.device };
}

export async function GET() {
  if (pipelineEnabled()) {
    try { return Response.json(await pipelineHealth()); }
    catch (error) {
      console.error("Arena stem pipeline health failed", error);
      return Response.json({ available: false, reason: "Arena stem storage, database, or queue is unavailable." }, { status: 503 });
    }
  }

  const target = workerUrl();
  if (!target) return Response.json({ available: false, reason: "No durable Arena stem pipeline or STEM_WORKER_URL is configured. Arena will not simulate separation." });
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5_000);
  try {
    const result = await fetch(`${target}/health`, { signal: controller.signal, cache: "no-store" });
    const body = await result.json().catch(() => ({}));
    if (!result.ok) return Response.json({ available: false, reason: body?.error ?? `Stem worker returned ${result.status}.` }, { status: 503 });
    return Response.json({ available: body?.available !== false, engine: body?.engine ?? "unknown", model: body?.model ?? "unknown", device: body?.device ?? "unknown" });
  } catch {
    return Response.json({ available: false, reason: "The configured stem worker could not be reached." }, { status: 503 });
  } finally { clearTimeout(timeout); }
}
