import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { and, eq } from "drizzle-orm";
import { getDb, harmonyAnalyses, harmonyEvents, sourceAssets } from "@waveyard/database";
import { enqueueHarmonyAnalysis } from "@waveyard/queue";
import { getStorage } from "@waveyard/storage";
import {
  harmonyAnalysisProvenanceReason,
  normaliseHarmonyEvents,
  HARMONY_ANALYSIS_ENGINE,
  HARMONY_ANALYSIS_ENGINE_VERSION,
  type HarmonyAnalysisJobPayload,
} from "@waveyard/types";

export function harmonyAnalysisIdempotencyKey(sourceAssetId: string) {
  return `harmony:${sourceAssetId}:${HARMONY_ANALYSIS_ENGINE}:${HARMONY_ANALYSIS_ENGINE_VERSION}`;
}

function runHarmonyEngine(inputPath: string, cwd: string) {
  return new Promise<{ stdout: string; stderr: string }>((resolvePromise, reject) => {
    const python = process.env.PYTHON_BIN ?? "python3";
    const current = process.cwd();
    const root = process.env.WAVEYARD_ROOT ?? (existsSync(resolve(current, "services/analysis/analyze.py")) ? current : resolve(current, "../.."));
    const child = spawn(python, [resolve(root, "services/analysis/analyze.py"), "--input", inputPath, "--harmony"], { cwd, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = ""; let stderr = "";
    child.stdout.on("data", (data) => { stdout += String(data); });
    child.stderr.on("data", (data) => { stderr += String(data); });
    child.once("error", reject);
    child.once("close", (code) => code === 0 ? resolvePromise({ stdout, stderr }) : reject(new Error(`Harmony analysis process failed (exit ${code}): ${(stderr || stdout).slice(-2000)}`)));
  });
}

async function updateHarmonyAnalysis(id: string, patch: Partial<typeof harmonyAnalyses.$inferInsert>) {
  await getDb().update(harmonyAnalyses).set({ ...patch, updatedAt: new Date() }).where(eq(harmonyAnalyses.id, id));
}

export async function provisionHarmonyAnalysis(source: typeof sourceAssets.$inferSelect) {
  const db = getDb();
  const [row] = await db.insert(harmonyAnalyses).values({
    projectId: source.projectId, sourceAssetId: source.id, status: "queued", stage: "queued",
    idempotencyKey: harmonyAnalysisIdempotencyKey(source.id), analysisEngine: HARMONY_ANALYSIS_ENGINE,
    analysisEngineVersion: HARMONY_ANALYSIS_ENGINE_VERSION, sourceChecksumSha256: source.checksumSha256,
  }).onConflictDoNothing({ target: harmonyAnalyses.sourceAssetId }).returning();
  const analysis = row ?? (await db.select().from(harmonyAnalyses).where(eq(harmonyAnalyses.sourceAssetId, source.id)).limit(1))[0];
  if (!analysis) throw new Error("Could not resolve durable harmony analysis.");
  const reason = harmonyAnalysisProvenanceReason({
    sourceAssetId: analysis.sourceAssetId, expectedSourceAssetId: source.id,
    sourceChecksumSha256: analysis.sourceChecksumSha256, expectedSourceChecksumSha256: source.checksumSha256,
    analysisEngine: analysis.analysisEngine, analysisEngineVersion: analysis.analysisEngineVersion,
  });
  if (reason) return analysis;
  if (row) {
    try { await enqueueHarmonyAnalysis({ harmonyAnalysisId: analysis.id, projectId: analysis.projectId, sourceAssetId: analysis.sourceAssetId, analysisEngine: analysis.analysisEngine, analysisEngineVersion: analysis.analysisEngineVersion }); }
    catch (error) {
      await updateHarmonyAnalysis(analysis.id, { status: "failed", stage: "queue-unavailable", errorCode: "queue_unavailable", errorMessage: error instanceof Error ? error.message.slice(0, 1000) : "Queue unavailable.", completedAt: new Date() });
      throw error;
    }
  }
  return analysis;
}

export async function processHarmonyAnalysis(payload: HarmonyAnalysisJobPayload, reportStage: (stage: string) => Promise<void>) {
  const db = getDb();
  const [job] = await db.select().from(harmonyAnalyses).where(eq(harmonyAnalyses.id, payload.harmonyAnalysisId)).limit(1);
  if (!job || job.status === "complete" || job.status === "cancelled") return;
  if (job.projectId !== payload.projectId || job.sourceAssetId !== payload.sourceAssetId || job.analysisEngine !== payload.analysisEngine || job.analysisEngineVersion !== payload.analysisEngineVersion) {
    await updateHarmonyAnalysis(job.id, { status: "failed", stage: "failed", errorCode: "invalid_payload", errorMessage: "Harmony-analysis payload does not match its durable target.", completedAt: new Date() });
    throw new Error("Harmony-analysis payload does not match durable provenance.");
  }
  const [source] = await db.select().from(sourceAssets).where(and(eq(sourceAssets.id, job.sourceAssetId), eq(sourceAssets.projectId, job.projectId))).limit(1);
  const reason = !source ? "source_missing" : harmonyAnalysisProvenanceReason({
    sourceAssetId: job.sourceAssetId, expectedSourceAssetId: source.id,
    sourceChecksumSha256: job.sourceChecksumSha256, expectedSourceChecksumSha256: source.checksumSha256,
    analysisEngine: job.analysisEngine, analysisEngineVersion: job.analysisEngineVersion,
  });
  if (reason) {
    await updateHarmonyAnalysis(job.id, { status: "failed", stage: "failed", errorCode: reason, errorMessage: "Source identity no longer matches harmony-analysis provenance.", completedAt: new Date() });
    throw new Error("Source is unavailable or stale for harmony analysis.");
  }
  const temporaryDirectory = await mkdtemp(join(tmpdir(), "waveyard-harmony-"));
  try {
    await updateHarmonyAnalysis(job.id, { status: "processing", stage: "analyzing", attempts: job.attempts + 1, startedAt: new Date(), completedAt: null, errorCode: null, errorMessage: null });
    await reportStage("analyzing");
    const inputPath = join(temporaryDirectory, "source-input");
    await getStorage().getToFile(source.storageKey, inputPath);
    const { stdout } = await runHarmonyEngine(inputPath, temporaryDirectory);
    const raw = JSON.parse(stdout.trim().split("\n").at(-1) ?? "{}") as Record<string, unknown>;
    if (raw.analysisEngine !== HARMONY_ANALYSIS_ENGINE || raw.analysisEngineVersion !== HARMONY_ANALYSIS_ENGINE_VERSION) throw new Error("Harmony-analysis engine provenance does not match the queued job.");
    const events = normaliseHarmonyEvents(raw.events, Math.round(source.durationSeconds * 1000));
    if (!events) throw new Error("Harmony-analysis engine returned invalid events.");
    const analyzedAt = new Date();
    await db.transaction(async (tx) => {
      await tx.delete(harmonyEvents).where(eq(harmonyEvents.harmonyAnalysisId, job.id));
      if (events.length) await tx.insert(harmonyEvents).values(events.map((event, eventIndex) => ({ harmonyAnalysisId: job.id, eventIndex, ...event })));
      await tx.update(harmonyAnalyses).set({ status: "complete", stage: "complete", analyzedAt, completedAt: analyzedAt, errorCode: null, errorMessage: null, updatedAt: analyzedAt }).where(eq(harmonyAnalyses.id, job.id));
    });
    await reportStage("complete");
  } catch (error) {
    const message = error instanceof Error ? error.message.slice(0, 1800) : "Unknown harmony-analysis failure.";
    await updateHarmonyAnalysis(job.id, { status: "failed", stage: "failed", errorCode: "harmony_analysis_failed", errorMessage: message, completedAt: new Date() });
    throw error;
  } finally { await rm(temporaryDirectory, { recursive: true, force: true }); }
}
