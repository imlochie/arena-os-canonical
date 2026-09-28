import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { and, eq } from "drizzle-orm";
import {
  getDb,
  sourceEventAnalyses,
  sourceEvents,
  sourceAssets,
} from "@waveyard/database";
import { enqueueSourceEventAnalysis } from "@waveyard/queue";
import { getStorage } from "@waveyard/storage";
import {
  normaliseSourceEvents,
  SOURCE_EVENT_ANALYSIS_ENGINE,
  SOURCE_EVENT_ANALYSIS_ENGINE_VERSION,
  type SourceEventAnalysisJobPayload,
} from "@waveyard/types";

function eventIdempotencyKey(sourceAssetId: string) {
  return `events:${sourceAssetId}:${SOURCE_EVENT_ANALYSIS_ENGINE}:${SOURCE_EVENT_ANALYSIS_ENGINE_VERSION}`;
}

function runEventEngine(inputPath: string, cwd: string) {
  return new Promise<{ stdout: string; stderr: string }>((resolvePromise, reject) => {
    const python = process.env.PYTHON_BIN ?? "python3";
    const current = process.cwd();
    const root = process.env.WAVEYARD_ROOT ?? (existsSync(resolve(current, "services/analysis/analyze.py")) ? current : resolve(current, "../.."));
    const child = spawn(python, [resolve(root, "services/analysis/analyze.py"), "--input", inputPath, "--events"], {
      cwd, stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (data) => { stdout += String(data); });
    child.stderr.on("data", (data) => { stderr += String(data); });
    child.once("error", reject);
    child.once("close", (code) => code === 0
      ? resolvePromise({ stdout, stderr })
      : reject(new Error(`Event analysis process failed (exit ${code}): ${(stderr || stdout).slice(-2000)}`)));
  });
}

async function updateEventAnalysis(id: string, patch: Partial<typeof sourceEventAnalyses.$inferInsert>) {
  await getDb().update(sourceEventAnalyses).set({ ...patch, updatedAt: new Date() }).where(eq(sourceEventAnalyses.id, id));
}

export async function provisionSourceEventAnalysis(source: typeof sourceAssets.$inferSelect) {
  const db = getDb();
  const [row] = await db.insert(sourceEventAnalyses).values({
    projectId: source.projectId,
    sourceAssetId: source.id,
    status: "queued",
    stage: "queued",
    idempotencyKey: eventIdempotencyKey(source.id),
    analysisEngine: SOURCE_EVENT_ANALYSIS_ENGINE,
    analysisEngineVersion: SOURCE_EVENT_ANALYSIS_ENGINE_VERSION,
    sourceChecksumSha256: source.checksumSha256,
  }).onConflictDoNothing({ target: sourceEventAnalyses.sourceAssetId }).returning();
  const analysis = row ?? (await db.select().from(sourceEventAnalyses).where(eq(sourceEventAnalyses.sourceAssetId, source.id)).limit(1))[0];
  if (!analysis) throw new Error("Could not resolve durable source event analysis.");
  if (analysis.sourceChecksumSha256 !== source.checksumSha256
    || analysis.analysisEngine !== SOURCE_EVENT_ANALYSIS_ENGINE
    || analysis.analysisEngineVersion !== SOURCE_EVENT_ANALYSIS_ENGINE_VERSION)
    return analysis;
  if (row) await enqueueSourceEventAnalysis({
    sourceEventAnalysisId: analysis.id,
    projectId: analysis.projectId,
    sourceAssetId: analysis.sourceAssetId,
    analysisEngine: analysis.analysisEngine,
    analysisEngineVersion: analysis.analysisEngineVersion,
  });
  return analysis;
}

export async function processSourceEventAnalysis(
  payload: SourceEventAnalysisJobPayload,
  reportStage: (stage: string) => Promise<void>,
) {
  const db = getDb();
  const [job] = await db.select().from(sourceEventAnalyses).where(eq(sourceEventAnalyses.id, payload.sourceEventAnalysisId)).limit(1);
  if (!job || job.status === "complete" || job.status === "cancelled") return;
  if (job.projectId !== payload.projectId || job.sourceAssetId !== payload.sourceAssetId
    || job.analysisEngine !== payload.analysisEngine || job.analysisEngineVersion !== payload.analysisEngineVersion) {
    await updateEventAnalysis(job.id, { status: "failed", stage: "failed", errorCode: "invalid_payload", errorMessage: "Event-analysis payload does not match its durable source target.", completedAt: new Date() });
    throw new Error("Event-analysis payload does not match durable provenance.");
  }
  const [source] = await db.select().from(sourceAssets).where(and(eq(sourceAssets.id, job.sourceAssetId), eq(sourceAssets.projectId, job.projectId))).limit(1);
  if (!source || source.checksumSha256 !== job.sourceChecksumSha256) {
    await updateEventAnalysis(job.id, { status: "failed", stage: "failed", errorCode: source ? "source_changed" : "source_missing", errorMessage: "Source identity no longer matches event-analysis provenance.", completedAt: new Date() });
    throw new Error("Source identity is unavailable for event analysis.");
  }
  const temporaryDirectory = await mkdtemp(join(tmpdir(), "waveyard-events-"));
  try {
    await updateEventAnalysis(job.id, { status: "processing", stage: "analyzing", attempts: job.attempts + 1, startedAt: new Date(), completedAt: null, errorCode: null, errorMessage: null });
    await reportStage("analyzing");
    const inputPath = join(temporaryDirectory, "source-input");
    await getStorage().getToFile(source.storageKey, inputPath);
    const { stdout } = await runEventEngine(inputPath, temporaryDirectory);
    const raw = JSON.parse(stdout.trim().split("\n").at(-1) ?? "{}") as Record<string, unknown>;
    if (raw.analysisEngine !== SOURCE_EVENT_ANALYSIS_ENGINE || raw.analysisEngineVersion !== SOURCE_EVENT_ANALYSIS_ENGINE_VERSION)
      throw new Error("Event-analysis engine provenance does not match the queued job.");
    const events = normaliseSourceEvents(raw.events, Math.round(source.durationSeconds * 1000));
    if (!events) throw new Error("Event-analysis engine returned invalid source events.");
    const analyzedAt = new Date();
    await db.transaction(async (tx) => {
      await tx.delete(sourceEvents).where(eq(sourceEvents.sourceEventAnalysisId, job.id));
      if (events.length) await tx.insert(sourceEvents).values(events.map((event, eventIndex) => ({
        projectId: source.projectId,
        sourceAssetId: source.id,
        sourceEventAnalysisId: job.id,
        eventIndex,
        timestampMs: event.timestampMs,
        strength: event.strength,
        confidence: event.confidence,
        rhythmicClass: event.rhythmicClass,
      })));
      await tx.update(sourceEventAnalyses).set({ status: "complete", stage: "complete", analyzedAt, completedAt: analyzedAt, errorCode: null, errorMessage: null, updatedAt: analyzedAt }).where(eq(sourceEventAnalyses.id, job.id));
    });
    await reportStage("complete");
  } catch (error) {
    const message = error instanceof Error ? error.message.slice(0, 1800) : "Unknown event-analysis failure.";
    await updateEventAnalysis(job.id, { status: "failed", stage: "failed", errorCode: "event_analysis_failed", errorMessage: message, completedAt: new Date() });
    throw error;
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
}
