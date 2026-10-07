/**
 * Local source-analysis job handler — a faithful port of the worker's
 * processSourceAnalysis (waveyard-worker/apps/worker/src/analysis.ts),
 * substituting the arena-js-dsp engine for the Python numpy engine. The
 * durable row, payload validation, lifecycle statuses, null-for-unknown
 * semantics, and downstream section provisioning all match the worker.
 */

import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { and, eq } from "drizzle-orm";

import { db } from "@/db";
import { sourceAnalyses, sourceAssets, sourceSectionAnalyses, sourceSections } from "@/db/waveyardSchema";
import { getStorage } from "@/lib/waveyard/storage";
import { enqueueSourceSectionAnalysis } from "@/lib/waveyard/queue";
import type { SourceAnalysisJobPayload } from "@/lib/waveyard/types";
import { usableBeatGrid } from "@/lib/waveyard/types/beat-grid";
import {
  DESKTOP_ANALYSIS_ENGINE,
  DESKTOP_ANALYSIS_ENGINE_VERSION,
  analysePcm,
  beatConfidenceFromGrid,
  decodeMonoPcm,
  normaliseBeatGrid,
} from "./analysis-engine";

export const DESKTOP_SECTION_ENGINE = "arena-js-structure";
export const DESKTOP_SECTION_ENGINE_VERSION = "1.0.0";

function parseBeatGrid(value: string | null) {
  if (!value) return null;
  try {
    return usableBeatGrid(JSON.parse(value));
  } catch {
    return null;
  }
}

async function updateJob(id: string, patch: Partial<typeof sourceAnalyses.$inferInsert>) {
  await db.update(sourceAnalyses).set({ ...patch, updatedAt: new Date() }).where(eq(sourceAnalyses.id, id));
}

export function desktopSectionIdempotencyKey(sourceAssetId: string) {
  return `sections:${sourceAssetId}:${DESKTOP_SECTION_ENGINE}:${DESKTOP_SECTION_ENGINE_VERSION}`;
}

/**
 * Port of the worker's provisionSourceSectionAnalysis, scoped to the desktop
 * structure engine. Creates/refreshes the durable section-analysis row and
 * enqueues it; a queue outage marks that row failed without failing the
 * completed parent analysis.
 */
export async function provisionDesktopSectionAnalysis(
  analysis: typeof sourceAnalyses.$inferSelect,
  source: typeof sourceAssets.$inferSelect,
) {
  const beatGrid = parseBeatGrid(analysis.beatGrid);
  const unavailable = analysis.status !== "complete" || !beatGrid;
  const now = new Date();
  const [row] = await db
    .insert(sourceSectionAnalyses)
    .values({
      projectId: source.projectId,
      sourceAssetId: source.id,
      sourceAnalysisId: analysis.id,
      status: unavailable ? "unavailable" : "queued",
      stage: unavailable ? "insufficient-analysis" : "queued",
      attempts: 0,
      idempotencyKey: desktopSectionIdempotencyKey(source.id),
      analysisEngine: DESKTOP_SECTION_ENGINE,
      analysisEngineVersion: DESKTOP_SECTION_ENGINE_VERSION,
      sourceChecksumSha256: source.checksumSha256,
      errorCode: unavailable ? "insufficient_analysis" : null,
      errorMessage: unavailable ? "Structural analysis requires a complete usable source beat grid." : null,
      startedAt: null,
      analyzedAt: null,
      completedAt: unavailable ? now : null,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: sourceSectionAnalyses.sourceAssetId,
      set: {
        sourceAnalysisId: analysis.id,
        status: unavailable ? "unavailable" : "queued",
        stage: unavailable ? "insufficient-analysis" : "queued",
        attempts: 0,
        analysisEngine: DESKTOP_SECTION_ENGINE,
        analysisEngineVersion: DESKTOP_SECTION_ENGINE_VERSION,
        sourceChecksumSha256: source.checksumSha256,
        errorCode: unavailable ? "insufficient_analysis" : null,
        errorMessage: unavailable ? "Structural analysis requires a complete usable source beat grid." : null,
        startedAt: null,
        analyzedAt: null,
        completedAt: unavailable ? now : null,
        updatedAt: now,
      },
    })
    .returning();
  await db.delete(sourceSections).where(eq(sourceSections.sourceAssetId, source.id));
  if (unavailable) return row;
  try {
    await enqueueSourceSectionAnalysis({
      sourceSectionAnalysisId: row.id,
      projectId: source.projectId,
      sourceAssetId: source.id,
      sourceAnalysisId: analysis.id,
      analysisEngine: DESKTOP_SECTION_ENGINE,
      analysisEngineVersion: DESKTOP_SECTION_ENGINE_VERSION,
    });
  } catch (error) {
    await db
      .update(sourceSectionAnalyses)
      .set({
        status: "failed",
        stage: "queue-unavailable",
        errorCode: "queue_unavailable",
        errorMessage: error instanceof Error ? error.message.slice(0, 1000) : "Section queue is unavailable.",
        completedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(sourceSectionAnalyses.id, row.id));
  }
  return row;
}

/** Local musical analysis over the original source audio. */
export async function handleSourceAnalysisJob(payloadInput: Record<string, unknown>): Promise<void> {
  const payload = payloadInput as unknown as SourceAnalysisJobPayload;
  const [job] = await db.select().from(sourceAnalyses).where(eq(sourceAnalyses.id, payload.sourceAnalysisId)).limit(1);
  if (!job || job.status === "complete" || job.status === "cancelled") return;
  const invalidPayload =
    job.projectId !== payload.projectId ||
    job.sourceAssetId !== payload.sourceAssetId ||
    job.analysisEngine !== payload.analysisEngine ||
    job.analysisEngineVersion !== payload.analysisEngineVersion;
  if (invalidPayload) {
    await updateJob(job.id, {
      status: "failed",
      stage: "failed",
      errorCode: "invalid_payload",
      analysisError: "Analysis queue payload does not match its durable source target.",
      completedAt: new Date(),
    });
    throw new Error("Analysis payload does not match its durable source target.");
  }

  const [source] = await db
    .select()
    .from(sourceAssets)
    .where(and(eq(sourceAssets.id, payload.sourceAssetId), eq(sourceAssets.projectId, payload.projectId)))
    .limit(1);
  if (!source || source.checksumSha256 !== job.sourceChecksumSha256) {
    await updateJob(job.id, {
      status: "failed",
      stage: "failed",
      errorCode: source ? "source_changed" : "source_missing",
      analysisError: source ? "Source checksum no longer matches analysis provenance." : "Authorized source asset is missing.",
      completedAt: new Date(),
    });
    throw new Error("Authorized source asset is unavailable for analysis.");
  }

  const temporaryDirectory = await mkdtemp(join(tmpdir(), "arena-analysis-"));
  const inputPath = join(temporaryDirectory, "source-input");
  try {
    await updateJob(job.id, {
      status: "preparing",
      stage: "preparing",
      startedAt: new Date(),
      attempts: (job.attempts ?? 0) + 1,
      analysisError: null,
      errorCode: null,
      completedAt: null,
    });
    await getStorage().getToFile(source.storageKey, inputPath);
    await updateJob(job.id, { status: "processing", stage: "analyzing" });

    // arena-js-dsp: real DSP over decoded PCM; unavailable evidence stays null.
    const pcm = await decodeMonoPcm(inputPath);
    if (pcm.length < 22_050) throw new Error("Audio is too short for musical analysis.");
    const raw = analysePcm(pcm);
    const beatGridMs = raw.beatGridMs == null ? null : normaliseBeatGrid(raw.beatGridMs, source.durationSeconds);
    if (raw.beatGridMs != null && beatGridMs === null)
      throw new Error("Desktop analysis produced an invalid beat grid for this source.");
    const beatConfidence = beatGridMs == null ? raw.beatConfidence : beatConfidenceFromGrid(raw.bpmConfidence, beatGridMs);
    if (!beatGridMs && beatConfidence !== null)
      throw new Error("Desktop analysis reported beat confidence without a beat grid.");
    const analyzedAt = new Date();

    await updateJob(job.id, {
      status: "complete",
      stage: "complete",
      analysisEngine: DESKTOP_ANALYSIS_ENGINE,
      analysisEngineVersion: DESKTOP_ANALYSIS_ENGINE_VERSION,
      bpm: raw.bpm,
      bpmConfidence: raw.bpmConfidence,
      musicalKey: raw.musicalKey,
      keyConfidence: raw.keyConfidence,
      beatGrid: beatGridMs ? JSON.stringify(beatGridMs) : null,
      beatConfidence,
      analysisError: null,
      errorCode: null,
      analyzedAt,
      completedAt: analyzedAt,
    });
    // Downstream structural work is isolated metadata: a queue outage must
    // never turn a completed BPM/key/beat analysis into a failed analysis.
    await provisionDesktopSectionAnalysis({ ...job, status: "complete", beatGrid: beatGridMs ? JSON.stringify(beatGridMs) : null }, source).catch(
      (sectionError) => console.error("could not provision desktop section analysis", sectionError),
    );
  } catch (error) {
    const message = error instanceof Error ? error.message.slice(0, 1800) : "Unknown musical analysis failure.";
    await updateJob(job.id, {
      status: "failed",
      stage: "failed",
      errorCode: "analysis_failed",
      analysisError: message,
      bpm: null,
      bpmConfidence: null,
      musicalKey: null,
      keyConfidence: null,
      beatGrid: null,
      beatConfidence: null,
      analyzedAt: null,
      completedAt: new Date(),
    });
    const [sourceRow] = await db.select().from(sourceAssets).where(eq(sourceAssets.id, job.sourceAssetId)).limit(1);
    if (sourceRow)
      await provisionDesktopSectionAnalysis({ ...job, status: "failed", beatGrid: null }, sourceRow).catch((sectionError) =>
        console.error("could not record unavailable desktop section analysis", sectionError),
      );
    throw error;
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
}
