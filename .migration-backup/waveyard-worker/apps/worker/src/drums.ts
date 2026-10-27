import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { and, eq } from "drizzle-orm";
import {
  drumAnalyses,
  drumEvents,
  getDb,
  sourceAnalyses,
  sourceAssets,
  stemAssets,
} from "@waveyard/database";
import { enqueueDrumAnalysis } from "@waveyard/queue";
import { getStorage } from "@waveyard/storage";
import {
  classifiedDrumEvent,
  drumAnalysisProvenanceReason,
  isSupportedDrumStemType,
  nearestBeatProjection,
  normaliseDrumEvents,
  DRUM_ANALYSIS_ENGINE,
  DRUM_ANALYSIS_ENGINE_VERSION,
  type DrumAnalysisJobPayload,
} from "@waveyard/types";

export function drumAnalysisIdempotencyKey(stemAssetId: string) {
  return `drums:${stemAssetId}:${DRUM_ANALYSIS_ENGINE}:${DRUM_ANALYSIS_ENGINE_VERSION}`;
}

function runDrumEngine(inputPath: string, durationMs: number, cwd: string) {
  return new Promise<{ stdout: string; stderr: string }>((resolvePromise, reject) => {
    const python = process.env.PYTHON_BIN ?? "python3";
    const current = process.cwd();
    const root = process.env.WAVEYARD_ROOT ?? (existsSync(resolve(current, "services/analysis/analyze.py")) ? current : resolve(current, "../.."));
    const child = spawn(python, [resolve(root, "services/analysis/analyze.py"), "--input", inputPath, "--drums", "--duration-ms", String(durationMs)], {
      cwd, stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (data) => { stdout += String(data); });
    child.stderr.on("data", (data) => { stderr += String(data); });
    child.once("error", reject);
    child.once("close", (code) => code === 0
      ? resolvePromise({ stdout, stderr })
      : reject(new Error(`Drum analysis process failed (exit ${code}): ${(stderr || stdout).slice(-2000)}`)));
  });
}

function parseBeatGrid(value: string) {
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed) && parsed.every((item) => Number.isSafeInteger(item) && item >= 0) ? parsed : null;
  } catch { return null; }
}

async function updateDrumAnalysis(id: string, patch: Partial<typeof drumAnalyses.$inferInsert>) {
  await getDb().update(drumAnalyses).set({ ...patch, updatedAt: new Date() }).where(eq(drumAnalyses.id, id));
}

/** Only an isolated drums/percussion stem from the source's own project may queue work. */
export async function provisionDrumAnalysis(stem: typeof stemAssets.$inferSelect) {
  if (!isSupportedDrumStemType(stem.stemType)) return null;
  const db = getDb();
  const [source] = await db.select().from(sourceAssets).where(and(
    eq(sourceAssets.id, stem.sourceAssetId), eq(sourceAssets.projectId, stem.projectId),
  )).limit(1);
  if (!source) throw new Error("Drum stem has no authorized source in its project.");
  const [row] = await db.insert(drumAnalyses).values({
    projectId: stem.projectId, sourceAssetId: source.id, stemAssetId: stem.id,
    status: "queued", stage: "queued", idempotencyKey: drumAnalysisIdempotencyKey(stem.id),
    analysisEngine: DRUM_ANALYSIS_ENGINE, analysisEngineVersion: DRUM_ANALYSIS_ENGINE_VERSION,
    sourceChecksumSha256: source.checksumSha256, stemChecksumSha256: stem.checksumSha256,
  }).onConflictDoNothing({ target: drumAnalyses.stemAssetId }).returning();
  const analysis = row ?? (await db.select().from(drumAnalyses).where(eq(drumAnalyses.stemAssetId, stem.id)).limit(1))[0];
  if (!analysis) throw new Error("Could not resolve durable drum analysis.");
  const reason = drumAnalysisProvenanceReason({
    sourceAssetId: analysis.sourceAssetId, expectedSourceAssetId: source.id,
    stemAssetId: analysis.stemAssetId, expectedStemAssetId: stem.id,
    sourceChecksumSha256: analysis.sourceChecksumSha256, expectedSourceChecksumSha256: source.checksumSha256,
    stemChecksumSha256: analysis.stemChecksumSha256, expectedStemChecksumSha256: stem.checksumSha256,
    analysisEngine: analysis.analysisEngine, analysisEngineVersion: analysis.analysisEngineVersion,
  });
  if (reason) return analysis;
  if (row) {
    try {
      await enqueueDrumAnalysis({ drumAnalysisId: analysis.id, projectId: analysis.projectId, sourceAssetId: analysis.sourceAssetId, stemAssetId: analysis.stemAssetId, analysisEngine: analysis.analysisEngine, analysisEngineVersion: analysis.analysisEngineVersion });
    } catch (error) {
      await updateDrumAnalysis(analysis.id, { status: "failed", stage: "queue-unavailable", errorCode: "queue_unavailable", errorMessage: error instanceof Error ? error.message.slice(0, 1000) : "Queue unavailable.", completedAt: new Date() });
      throw error;
    }
  }
  return analysis;
}

export async function processDrumAnalysis(payload: DrumAnalysisJobPayload, reportStage: (stage: string) => Promise<void>) {
  const db = getDb();
  const [job] = await db.select().from(drumAnalyses).where(eq(drumAnalyses.id, payload.drumAnalysisId)).limit(1);
  if (!job || job.status === "complete" || job.status === "cancelled") return;
  if (job.projectId !== payload.projectId || job.sourceAssetId !== payload.sourceAssetId || job.stemAssetId !== payload.stemAssetId || job.analysisEngine !== payload.analysisEngine || job.analysisEngineVersion !== payload.analysisEngineVersion) {
    await updateDrumAnalysis(job.id, { status: "failed", stage: "failed", errorCode: "invalid_payload", errorMessage: "Drum-analysis payload does not match its durable target.", completedAt: new Date() });
    throw new Error("Drum-analysis payload does not match durable provenance.");
  }
  const [source] = await db.select().from(sourceAssets).where(and(eq(sourceAssets.id, job.sourceAssetId), eq(sourceAssets.projectId, job.projectId))).limit(1);
  const [stem] = await db.select().from(stemAssets).where(and(
    eq(stemAssets.id, job.stemAssetId), eq(stemAssets.projectId, job.projectId), eq(stemAssets.sourceAssetId, job.sourceAssetId),
  )).limit(1);
  const reason = !source || !stem || !isSupportedDrumStemType(stem.stemType) ? "asset_missing" : drumAnalysisProvenanceReason({
    sourceAssetId: job.sourceAssetId, expectedSourceAssetId: source.id,
    stemAssetId: job.stemAssetId, expectedStemAssetId: stem.id,
    sourceChecksumSha256: job.sourceChecksumSha256, expectedSourceChecksumSha256: source.checksumSha256,
    stemChecksumSha256: job.stemChecksumSha256, expectedStemChecksumSha256: stem.checksumSha256,
    analysisEngine: job.analysisEngine, analysisEngineVersion: job.analysisEngineVersion,
  });
  if (reason) {
    await updateDrumAnalysis(job.id, { status: "failed", stage: "failed", errorCode: reason, errorMessage: "Drum stem/source identity no longer matches analysis provenance.", completedAt: new Date() });
    throw new Error("Drum source or isolated stem is unavailable or stale.");
  }
  const temporaryDirectory = await mkdtemp(join(tmpdir(), "waveyard-drums-"));
  try {
    await updateDrumAnalysis(job.id, { status: "processing", stage: "analyzing", attempts: job.attempts + 1, startedAt: new Date(), completedAt: null, errorCode: null, errorMessage: null });
    await reportStage("analyzing");
    const inputPath = join(temporaryDirectory, "drums-input");
    await getStorage().getToFile(stem.storageKey, inputPath);
    const { stdout } = await runDrumEngine(inputPath, Math.round(stem.durationSeconds * 1000), temporaryDirectory);
    const raw = JSON.parse(stdout.trim().split("\n").at(-1) ?? "{}") as Record<string, unknown>;
    if (raw.analysisEngine !== DRUM_ANALYSIS_ENGINE || raw.analysisEngineVersion !== DRUM_ANALYSIS_ENGINE_VERSION) throw new Error("Drum-analysis engine provenance does not match the queued job.");
    const events = normaliseDrumEvents(raw.events, Math.round(stem.durationSeconds * 1000));
    if (!events) throw new Error("Drum-analysis engine returned invalid events.");
    const [sourceAnalysis] = await db.select().from(sourceAnalyses).where(and(eq(sourceAnalyses.sourceAssetId, source.id), eq(sourceAnalyses.projectId, source.projectId), eq(sourceAnalyses.status, "complete"))).limit(1);
    const beatGrid = sourceAnalysis?.beatGrid ? parseBeatGrid(sourceAnalysis.beatGrid) : null;
    const projected = events.map((event) => classifiedDrumEvent(event, nearestBeatProjection(event.timestampMs, beatGrid)));
    const analyzedAt = new Date();
    await db.transaction(async (tx) => {
      await tx.delete(drumEvents).where(eq(drumEvents.drumAnalysisId, job.id));
      if (projected.length) await tx.insert(drumEvents).values(projected.map((event, eventIndex) => ({ drumAnalysisId: job.id, eventIndex, ...event })));
      await tx.update(drumAnalyses).set({ status: "complete", stage: "complete", analyzedAt, completedAt: analyzedAt, errorCode: null, errorMessage: null, updatedAt: analyzedAt }).where(eq(drumAnalyses.id, job.id));
    });
    await reportStage("complete");
  } catch (error) {
    const message = error instanceof Error ? error.message.slice(0, 1800) : "Unknown drum-analysis failure.";
    await updateDrumAnalysis(job.id, { status: "failed", stage: "failed", errorCode: "drum_analysis_failed", errorMessage: message, completedAt: new Date() });
    throw error;
  } finally { await rm(temporaryDirectory, { recursive: true, force: true }); }
}
