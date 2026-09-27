import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { and, eq } from "drizzle-orm";
import {
  getDb,
  sourceAnalyses,
  sourceAssets,
  sourceSectionAnalyses,
  sourceSections,
} from "@waveyard/database";
import { enqueueSourceSectionAnalysis } from "@waveyard/queue";
import { getStorage } from "@waveyard/storage";
import {
  normalizeSourceSections,
  type SourceSectionCandidate,
  type SourceSectionAnalysisJobPayload,
  usableBeatGrid,
} from "@waveyard/types";

export const SOURCE_SECTION_ANALYSIS_ENGINE = "waveyard-numpy-structure";
export const SOURCE_SECTION_ANALYSIS_ENGINE_VERSION = "1.0.0";

type SectionEngineResult = {
  analysisEngine: string;
  analysisEngineVersion: string;
  sections: SourceSectionCandidate[];
  unavailableReason: string | null;
};

function parseBeatGrid(value: string | null) {
  if (!value) return null;
  try {
    return usableBeatGrid(JSON.parse(value));
  } catch {
    return null;
  }
}

export function sectionAnalysisIdempotencyKey(sourceAssetId: string) {
  return `sections:${sourceAssetId}:${SOURCE_SECTION_ANALYSIS_ENGINE}:${SOURCE_SECTION_ANALYSIS_ENGINE_VERSION}`;
}

export function sectionAnalysisQueuePayload(job: {
  id: string;
  projectId: string;
  sourceAssetId: string;
  sourceAnalysisId: string;
  analysisEngine: string;
  analysisEngineVersion: string;
}): SourceSectionAnalysisJobPayload {
  return {
    sourceSectionAnalysisId: job.id,
    projectId: job.projectId,
    sourceAssetId: job.sourceAssetId,
    sourceAnalysisId: job.sourceAnalysisId,
    analysisEngine: job.analysisEngine,
    analysisEngineVersion: job.analysisEngineVersion,
  };
}

async function updateSectionAnalysis(
  id: string,
  patch: Partial<typeof sourceSectionAnalyses.$inferInsert>,
) {
  await getDb().update(sourceSectionAnalyses).set({ ...patch, updatedAt: new Date() })
    .where(eq(sourceSectionAnalyses.id, id));
}

/**
 * Creates one durable lifecycle row per source after the authoritative beat
 * analysis is complete. No-grid sources are explicit unavailable records rather
 * than an empty completed segmentation.
 */
export async function provisionSourceSectionAnalysis(
  analysis: typeof sourceAnalyses.$inferSelect,
  source: typeof sourceAssets.$inferSelect,
) {
  const db = getDb();
  const beatGrid = parseBeatGrid(analysis.beatGrid);
  const unavailable = analysis.status !== "complete" || !beatGrid;
  const now = new Date();
  const [row] = await db.insert(sourceSectionAnalyses).values({
    projectId: source.projectId,
    sourceAssetId: source.id,
    sourceAnalysisId: analysis.id,
    status: unavailable ? "unavailable" : "queued",
    stage: unavailable ? "insufficient-analysis" : "queued",
    attempts: 0,
    idempotencyKey: sectionAnalysisIdempotencyKey(source.id),
    analysisEngine: SOURCE_SECTION_ANALYSIS_ENGINE,
    analysisEngineVersion: SOURCE_SECTION_ANALYSIS_ENGINE_VERSION,
    sourceChecksumSha256: source.checksumSha256,
    errorCode: unavailable ? "insufficient_analysis" : null,
    errorMessage: unavailable ? "Structural analysis requires a complete usable source beat grid." : null,
    startedAt: null,
    analyzedAt: null,
    completedAt: unavailable ? now : null,
    updatedAt: now,
  }).onConflictDoUpdate({
    target: sourceSectionAnalyses.sourceAssetId,
    set: {
      sourceAnalysisId: analysis.id,
      status: unavailable ? "unavailable" : "queued",
      stage: unavailable ? "insufficient-analysis" : "queued",
      attempts: 0,
      analysisEngine: SOURCE_SECTION_ANALYSIS_ENGINE,
      analysisEngineVersion: SOURCE_SECTION_ANALYSIS_ENGINE_VERSION,
      sourceChecksumSha256: source.checksumSha256,
      errorCode: unavailable ? "insufficient_analysis" : null,
      errorMessage: unavailable ? "Structural analysis requires a complete usable source beat grid." : null,
      startedAt: null,
      analyzedAt: null,
      completedAt: unavailable ? now : null,
      updatedAt: now,
    },
  }).returning();
  // A re-analysis never exposes old structural evidence as current. Completed
  // rows are replaced atomically by the worker after the new engine succeeds.
  await db.delete(sourceSections).where(eq(sourceSections.sourceAssetId, source.id));
  if (unavailable) return row;
  try {
    await enqueueSourceSectionAnalysis(sectionAnalysisQueuePayload(row));
  } catch (error) {
    await updateSectionAnalysis(row.id, {
      status: "failed", stage: "queue-unavailable", errorCode: "queue_unavailable",
      errorMessage: error instanceof Error ? error.message.slice(0, 1000) : "Section queue is unavailable.",
      completedAt: new Date(),
    });
  }
  return row;
}

function runSectionEngine(inputPath: string, beatGrid: number[], cwd: string) {
  return new Promise<{ stdout: string; stderr: string }>((resolvePromise, reject) => {
    const python = process.env.PYTHON_BIN ?? "python3";
    const current = process.cwd();
    const root = process.env.WAVEYARD_ROOT ?? (existsSync(resolve(current, "services/analysis/analyze.py")) ? current : resolve(current, "../.."));
    const script = resolve(root, "services/analysis/analyze.py");
    const child = spawn(python, [script, "--input", inputPath, "--sections", "--beat-grid", JSON.stringify(beatGrid)], {
      cwd, stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (data) => { stdout += String(data); });
    child.stderr.on("data", (data) => { stderr += String(data); });
    child.once("error", reject);
    child.once("close", (code) => {
      if (code === 0) resolvePromise({ stdout, stderr });
      else reject(new Error(`Structural analysis process failed (exit ${code}): ${(stderr || stdout).slice(-2000)}`));
    });
  });
}

function normaliseSectionEngineResult(value: unknown): SectionEngineResult {
  if (!value || typeof value !== "object") throw new Error("Section engine returned no result document.");
  const result = value as Record<string, unknown>;
  if (result.analysisEngine !== SOURCE_SECTION_ANALYSIS_ENGINE || result.analysisEngineVersion !== SOURCE_SECTION_ANALYSIS_ENGINE_VERSION)
    throw new Error("Section engine provenance does not match the queued job.");
  if (!Array.isArray(result.sections)) throw new Error("Section engine returned invalid section evidence.");
  const sections: SourceSectionCandidate[] = result.sections.map((value) => {
    if (!value || typeof value !== "object") throw new Error("Section engine returned an invalid section.");
    const section = value as Record<string, unknown>;
    if (section.label !== "section" || !Number.isInteger(section.startBeatIndex) || !Number.isInteger(section.endBeatIndex)
      || typeof section.structuralConfidence !== "number" || !Number.isFinite(section.structuralConfidence)
      || typeof section.labelConfidence !== "number" || !Number.isFinite(section.labelConfidence))
      throw new Error("Section engine returned invalid source-coordinate evidence.");
    return {
      startBeatIndex: section.startBeatIndex as number,
      endBeatIndex: section.endBeatIndex as number,
      label: "section",
      labelConfidence: section.labelConfidence,
      structuralConfidence: section.structuralConfidence,
    };
  });
  const unavailableReason = result.unavailableReason === null ? null : typeof result.unavailableReason === "string"
    ? result.unavailableReason.slice(0, 200) : null;
  if (sections.length > 0 && unavailableReason) throw new Error("Section engine returned both sections and unavailable evidence.");
  return { analysisEngine: SOURCE_SECTION_ANALYSIS_ENGINE, analysisEngineVersion: SOURCE_SECTION_ANALYSIS_ENGINE_VERSION, sections, unavailableReason };
}

function stableSectionId(sourceChecksum: string, startBeatIndex: number, endBeatIndex: number) {
  return `section_${createHash("sha256")
    .update(`${sourceChecksum}:${SOURCE_SECTION_ANALYSIS_ENGINE}:${SOURCE_SECTION_ANALYSIS_ENGINE_VERSION}:${startBeatIndex}:${endBeatIndex}`)
    .digest("hex").slice(0, 32)}`;
}

/** Worker-owned, bounded source structure analysis using original source audio only. */
export async function processSourceSectionAnalysis(
  payload: SourceSectionAnalysisJobPayload,
  reportStage: (stage: string) => Promise<void>,
) {
  const db = getDb();
  const [job] = await db.select().from(sourceSectionAnalyses).where(eq(sourceSectionAnalyses.id, payload.sourceSectionAnalysisId)).limit(1);
  if (!job || job.status === "complete" || job.status === "unavailable") return;
  const invalidPayload = job.projectId !== payload.projectId || job.sourceAssetId !== payload.sourceAssetId
    || job.sourceAnalysisId !== payload.sourceAnalysisId || job.analysisEngine !== payload.analysisEngine
    || job.analysisEngineVersion !== payload.analysisEngineVersion;
  if (invalidPayload) {
    await updateSectionAnalysis(job.id, { status: "failed", stage: "failed", errorCode: "invalid_payload", errorMessage: "Section queue payload does not match its durable source target.", completedAt: new Date() });
    throw new Error("Section queue payload does not match its durable source target.");
  }
  const [analysis] = await db.select().from(sourceAnalyses).where(eq(sourceAnalyses.id, job.sourceAnalysisId)).limit(1);
  const [source] = await db.select().from(sourceAssets).where(and(eq(sourceAssets.id, job.sourceAssetId), eq(sourceAssets.projectId, job.projectId))).limit(1);
  const beatGrid = analysis ? parseBeatGrid(analysis.beatGrid) : null;
  if (!source || source.checksumSha256 !== job.sourceChecksumSha256 || !analysis || analysis.status !== "complete" || !beatGrid) {
    await updateSectionAnalysis(job.id, {
      status: "unavailable", stage: "insufficient-analysis", errorCode: !source ? "source_missing" : "insufficient_analysis",
      errorMessage: !source ? "Authorized source asset is missing." : "Structural analysis requires complete persisted beat-grid analysis.", completedAt: new Date(),
    });
    return;
  }
  const temporaryDirectory = await mkdtemp(join(tmpdir(), "waveyard-sections-"));
  const inputPath = join(temporaryDirectory, "source-input");
  try {
    await updateSectionAnalysis(job.id, { status: "preparing", stage: "preparing", startedAt: new Date(), attempts: (job.attempts ?? 0) + 1, errorCode: null, errorMessage: null, completedAt: null });
    await reportStage("preparing");
    await getStorage().getToFile(source.storageKey, inputPath);
    await updateSectionAnalysis(job.id, { status: "processing", stage: "analyzing" });
    await reportStage("analyzing");
    const { stdout } = await runSectionEngine(inputPath, beatGrid, temporaryDirectory);
    const result = normaliseSectionEngineResult(JSON.parse(stdout.trim().split("\n").at(-1) ?? "{}") as unknown);
    if (result.unavailableReason) {
      await updateSectionAnalysis(job.id, { status: "unavailable", stage: "insufficient-evidence", errorCode: result.unavailableReason, errorMessage: "No conservative bar-aligned structural boundary was supported by the source evidence.", analyzedAt: new Date(), completedAt: new Date() });
      await reportStage("unavailable");
      return;
    }
    const sections = normalizeSourceSections(result.sections, beatGrid, {
      analysisEngine: result.analysisEngine,
      analysisEngineVersion: result.analysisEngineVersion,
      sourceChecksumSha256: source.checksumSha256,
    }, ({ startBeatIndex, endBeatIndex }) => stableSectionId(source.checksumSha256, startBeatIndex, endBeatIndex));
    if (!sections.length) {
      await updateSectionAnalysis(job.id, { status: "unavailable", stage: "insufficient-evidence", errorCode: "structural_evidence_invalid", errorMessage: "No valid conservative source sections were produced.", analyzedAt: new Date(), completedAt: new Date() });
      await reportStage("unavailable");
      return;
    }
    const analyzedAt = new Date();
    await db.transaction(async (tx) => {
      await tx.delete(sourceSections).where(eq(sourceSections.sourceAssetId, source.id));
      await tx.insert(sourceSections).values(sections.map((section) => ({
        ...section,
        projectId: source.projectId,
        sourceAssetId: source.id,
        sourceAnalysisId: analysis.id,
        sourceSectionAnalysisId: job.id,
      })));
      await tx.update(sourceSectionAnalyses).set({ status: "complete", stage: "complete", errorCode: null, errorMessage: null, analyzedAt, completedAt: analyzedAt, updatedAt: analyzedAt }).where(eq(sourceSectionAnalyses.id, job.id));
    });
    await reportStage("complete");
  } catch (error) {
    const message = error instanceof Error ? error.message.slice(0, 1800) : "Unknown structural analysis failure.";
    await updateSectionAnalysis(job.id, { status: "failed", stage: "failed", errorCode: "section_analysis_failed", errorMessage: message, completedAt: new Date() });
    throw error;
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
}

export async function enqueueSourceSectionAnalysisRow(job: typeof sourceSectionAnalyses.$inferSelect) {
  return enqueueSourceSectionAnalysis(sectionAnalysisQueuePayload(job));
}
