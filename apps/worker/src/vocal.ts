import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { and, eq } from "drizzle-orm";
import {
  getDb,
  sourceAssets,
  stemAssets,
  vocalAnalyses,
  vocalPhrases,
  vocalPitchFrames,
} from "@waveyard/database";
import { enqueueVocalAnalysis } from "@waveyard/queue";
import { getStorage } from "@waveyard/storage";
import {
  normaliseVocalPitchFrames,
  segmentVocalPhrases,
  vocalAnalysisProvenanceReason,
  VOCAL_ANALYSIS_ENGINE,
  VOCAL_ANALYSIS_ENGINE_VERSION,
  type VocalAnalysisJobPayload,
} from "@waveyard/types";

export function vocalAnalysisIdempotencyKey(stemAssetId: string) {
  return `vocal:${stemAssetId}:${VOCAL_ANALYSIS_ENGINE}:${VOCAL_ANALYSIS_ENGINE_VERSION}`;
}

function runVocalEngine(inputPath: string, durationMs: number, cwd: string) {
  return new Promise<{ stdout: string; stderr: string }>((resolvePromise, reject) => {
    const python = process.env.PYTHON_BIN ?? "python3";
    const current = process.cwd();
    const root = process.env.WAVEYARD_ROOT ?? (existsSync(resolve(current, "services/analysis/analyze.py")) ? current : resolve(current, "../.."));
    const child = spawn(python, [resolve(root, "services/analysis/analyze.py"), "--input", inputPath, "--vocal", "--duration-ms", String(durationMs)], {
      cwd, stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (data) => { stdout += String(data); });
    child.stderr.on("data", (data) => { stderr += String(data); });
    child.once("error", reject);
    child.once("close", (code) => code === 0
      ? resolvePromise({ stdout, stderr })
      : reject(new Error(`Vocal analysis process failed (exit ${code}): ${(stderr || stdout).slice(-2000)}`)));
  });
}

async function updateVocalAnalysis(id: string, patch: Partial<typeof vocalAnalyses.$inferInsert>) {
  await getDb().update(vocalAnalyses).set({ ...patch, updatedAt: new Date() }).where(eq(vocalAnalyses.id, id));
}

/** Creates durable work only for an isolated stem named vocals in the same project/source. */
export async function provisionVocalAnalysis(stem: typeof stemAssets.$inferSelect) {
  if (stem.stemType !== "vocals") return null;
  const db = getDb();
  const [source] = await db.select().from(sourceAssets)
    .where(and(eq(sourceAssets.id, stem.sourceAssetId), eq(sourceAssets.projectId, stem.projectId))).limit(1);
  if (!source) throw new Error("Vocal stem has no authorized source in its project.");
  const [row] = await db.insert(vocalAnalyses).values({
    projectId: stem.projectId,
    sourceAssetId: source.id,
    stemAssetId: stem.id,
    status: "queued",
    stage: "queued",
    idempotencyKey: vocalAnalysisIdempotencyKey(stem.id),
    analysisEngine: VOCAL_ANALYSIS_ENGINE,
    analysisEngineVersion: VOCAL_ANALYSIS_ENGINE_VERSION,
    sourceChecksumSha256: source.checksumSha256,
    stemChecksumSha256: stem.checksumSha256,
  }).onConflictDoNothing({ target: vocalAnalyses.stemAssetId }).returning();
  const analysis = row ?? (await db.select().from(vocalAnalyses).where(eq(vocalAnalyses.stemAssetId, stem.id)).limit(1))[0];
  if (!analysis) throw new Error("Could not resolve durable vocal analysis.");
  const reason = vocalAnalysisProvenanceReason({
    sourceAssetId: analysis.sourceAssetId, expectedSourceAssetId: source.id,
    stemAssetId: analysis.stemAssetId, expectedStemAssetId: stem.id,
    sourceChecksumSha256: analysis.sourceChecksumSha256, expectedSourceChecksumSha256: source.checksumSha256,
    stemChecksumSha256: analysis.stemChecksumSha256, expectedStemChecksumSha256: stem.checksumSha256,
    analysisEngine: analysis.analysisEngine, analysisEngineVersion: analysis.analysisEngineVersion,
  });
  if (reason) return analysis;
  if (row) {
    try {
      await enqueueVocalAnalysis({
        vocalAnalysisId: analysis.id,
        projectId: analysis.projectId,
        sourceAssetId: analysis.sourceAssetId,
        stemAssetId: analysis.stemAssetId,
        analysisEngine: analysis.analysisEngine,
        analysisEngineVersion: analysis.analysisEngineVersion,
      });
    } catch (error) {
      await updateVocalAnalysis(analysis.id, {
        status: "failed", stage: "queue-unavailable", errorCode: "queue_unavailable",
        errorMessage: error instanceof Error ? error.message.slice(0, 1000) : "Queue unavailable.", completedAt: new Date(),
      });
      throw error;
    }
  }
  return analysis;
}

export async function processVocalAnalysis(
  payload: VocalAnalysisJobPayload,
  reportStage: (stage: string) => Promise<void>,
) {
  const db = getDb();
  const [job] = await db.select().from(vocalAnalyses).where(eq(vocalAnalyses.id, payload.vocalAnalysisId)).limit(1);
  if (!job || job.status === "complete" || job.status === "cancelled") return;
  if (job.projectId !== payload.projectId || job.sourceAssetId !== payload.sourceAssetId || job.stemAssetId !== payload.stemAssetId
    || job.analysisEngine !== payload.analysisEngine || job.analysisEngineVersion !== payload.analysisEngineVersion) {
    await updateVocalAnalysis(job.id, { status: "failed", stage: "failed", errorCode: "invalid_payload", errorMessage: "Vocal-analysis payload does not match its durable target.", completedAt: new Date() });
    throw new Error("Vocal-analysis payload does not match durable provenance.");
  }
  const [source] = await db.select().from(sourceAssets).where(and(eq(sourceAssets.id, job.sourceAssetId), eq(sourceAssets.projectId, job.projectId))).limit(1);
  const [stem] = await db.select().from(stemAssets).where(and(
    eq(stemAssets.id, job.stemAssetId), eq(stemAssets.projectId, job.projectId), eq(stemAssets.sourceAssetId, job.sourceAssetId), eq(stemAssets.stemType, "vocals"),
  )).limit(1);
  const reason = !source || !stem ? "asset_missing" : vocalAnalysisProvenanceReason({
    sourceAssetId: job.sourceAssetId, expectedSourceAssetId: source.id,
    stemAssetId: job.stemAssetId, expectedStemAssetId: stem.id,
    sourceChecksumSha256: job.sourceChecksumSha256, expectedSourceChecksumSha256: source.checksumSha256,
    stemChecksumSha256: job.stemChecksumSha256, expectedStemChecksumSha256: stem.checksumSha256,
    analysisEngine: job.analysisEngine, analysisEngineVersion: job.analysisEngineVersion,
  });
  if (reason) {
    await updateVocalAnalysis(job.id, { status: "failed", stage: "failed", errorCode: reason, errorMessage: "Vocal stem/source identity no longer matches analysis provenance.", completedAt: new Date() });
    throw new Error("Vocal source or isolated stem is unavailable or stale.");
  }
  const temporaryDirectory = await mkdtemp(join(tmpdir(), "waveyard-vocal-"));
  try {
    await updateVocalAnalysis(job.id, { status: "processing", stage: "analyzing", attempts: job.attempts + 1, startedAt: new Date(), completedAt: null, errorCode: null, errorMessage: null });
    await reportStage("analyzing");
    const inputPath = join(temporaryDirectory, "vocals-input");
    await getStorage().getToFile(stem.storageKey, inputPath);
    const { stdout } = await runVocalEngine(inputPath, Math.round(stem.durationSeconds * 1000), temporaryDirectory);
    const raw = JSON.parse(stdout.trim().split("\n").at(-1) ?? "{}") as Record<string, unknown>;
    if (raw.analysisEngine !== VOCAL_ANALYSIS_ENGINE || raw.analysisEngineVersion !== VOCAL_ANALYSIS_ENGINE_VERSION)
      throw new Error("Vocal-analysis engine provenance does not match the queued job.");
    const frames = normaliseVocalPitchFrames(raw.frames, Math.round(stem.durationSeconds * 1000));
    if (!frames) throw new Error("Vocal-analysis engine returned invalid pitch frames.");
    const phrases = segmentVocalPhrases(frames);
    const analyzedAt = new Date();
    await db.transaction(async (tx) => {
      await tx.delete(vocalPhrases).where(eq(vocalPhrases.vocalAnalysisId, job.id));
      await tx.delete(vocalPitchFrames).where(eq(vocalPitchFrames.vocalAnalysisId, job.id));
      if (frames.length) await tx.insert(vocalPitchFrames).values(frames.map((frame, frameIndex) => ({
        vocalAnalysisId: job.id, frameIndex, ...frame,
      })));
      if (phrases.length) await tx.insert(vocalPhrases).values(phrases.map((phrase, phraseIndex) => ({
        vocalAnalysisId: job.id, phraseIndex, ...phrase,
      })));
      await tx.update(vocalAnalyses).set({ status: "complete", stage: "complete", analyzedAt, completedAt: analyzedAt, errorCode: null, errorMessage: null, updatedAt: analyzedAt }).where(eq(vocalAnalyses.id, job.id));
    });
    await reportStage("complete");
  } catch (error) {
    const message = error instanceof Error ? error.message.slice(0, 1800) : "Unknown vocal-analysis failure.";
    await updateVocalAnalysis(job.id, { status: "failed", stage: "failed", errorCode: "vocal_analysis_failed", errorMessage: message, completedAt: new Date() });
    throw error;
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
}
