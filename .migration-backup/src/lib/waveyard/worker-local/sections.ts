/**
 * Local section-analysis job handler — a faithful port of the worker's
 * processSourceSectionAnalysis, with the structure engine reimplemented in
 * JS: conservative bar-aligned boundaries chosen at onset-novelty peaks.
 * Candidates flow through the app's own normalizeSourceSections/
 * sourceSectionsAreValid validators, so rows are indistinguishable in shape
 * and constraints from worker-produced sections; only the engine provenance
 * differs (arena-js-structure, honestly recorded).
 */

import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { and, eq } from "drizzle-orm";

import { db } from "@/db";
import { sourceAnalyses, sourceAssets, sourceSectionAnalyses, sourceSections } from "@/db/waveyardSchema";
import { getStorage } from "@/lib/waveyard/storage";
import { normalizeSourceSections, sourceSectionsAreValid, type SourceSectionCandidate } from "@/lib/waveyard/types/source-sections";
import { usableBeatGrid } from "@/lib/waveyard/types/beat-grid";
import type { SourceSectionAnalysisJobPayload } from "@/lib/waveyard/types";
import { DESKTOP_SECTION_ENGINE, DESKTOP_SECTION_ENGINE_VERSION } from "./analysis";
import { decodeMonoPcm, onsetEnvelope } from "./analysis-engine";

function parseBeatGrid(value: string | null) {
  if (!value) return null;
  try {
    return usableBeatGrid(JSON.parse(value));
  } catch {
    return null;
  }
}

async function updateSectionAnalysis(id: string, patch: Partial<typeof sourceSectionAnalyses.$inferInsert>) {
  await db.update(sourceSectionAnalyses).set({ ...patch, updatedAt: new Date() }).where(eq(sourceSectionAnalyses.id, id));
}

export function desktopSectionId(sourceAssetId: string, sourceChecksum: string, startBeatIndex: number, endBeatIndex: number) {
  return `section_${createHash("sha256")
    .update(`${sourceAssetId}:${sourceChecksum}:${DESKTOP_SECTION_ENGINE}:${DESKTOP_SECTION_ENGINE_VERSION}:${startBeatIndex}:${endBeatIndex}`)
    .digest("hex")
    .slice(0, 32)}`;
}

/**
 * Conservative structure engine: candidate boundaries only at bar edges
 * (4-beat groups) that coincide with onset-novelty peaks. A section spans
 * whole bars; the last section extends to the final beat. Returns null
 * when the evidence supports no conservative boundary (the caller records
 * the honest unavailable state, exactly like the worker).
 */
export function desktopSectionCandidates(beatGridMs: number[], envelope: Float32Array, frameMs: number): SourceSectionCandidate[] | null {
  if (beatGridMs.length < 8) return null; // fewer than two bars: no structure claim
  const noveltyAt = (ms: number) => {
    const frame = Math.min(envelope.length - 1, Math.max(0, Math.round(ms / frameMs)));
    return envelope[frame] ?? 0;
  };
  const barLength = 4;
  const barCount = Math.floor(beatGridMs.length / barLength);
  if (barCount < 2) return null;

  // Score every bar edge as a potential boundary using local onset novelty
  // (edge ± half a beat), then require the boundary to be a local maximum.
  const edgeScore = (barIndex: number) => {
    const beat = barIndex * barLength;
    const at = beatGridMs[beat];
    const halfBeat = beat + 1 < beatGridMs.length ? (beatGridMs[beat + 1] - at) / 2 : 250;
    return noveltyAt(Math.max(0, at - halfBeat)) + noveltyAt(at) + noveltyAt(at + halfBeat);
  };
  const meanScore = Array.from({ length: barCount - 1 }, (_, i) => edgeScore(i + 1)).reduce((t, v) => t + v, 0) / Math.max(1, barCount - 1);
  const boundaries: number[] = [0];
  for (let bar = 1; bar < barCount; bar += 1) {
    const score = edgeScore(bar);
    const previous = edgeScore(bar - 1);
    const next = bar < barCount - 1 ? edgeScore(bar + 1) : -Infinity;
    if (score >= previous && score >= next && score > meanScore) boundaries.push(bar * barLength);
  }
  boundaries.push(barCount * barLength);
  const deduped = [...new Set(boundaries)].sort((left, right) => left - right);
  if (deduped.length < 2) return null;

  const candidates: SourceSectionCandidate[] = [];
  for (let index = 0; index < deduped.length - 1; index += 1) {
    const startBeatIndex = deduped[index];
    const endBeatIndex = deduped[index + 1];
    // Structural confidence scales with the novelty evidence at the opening
    // boundary, clamped conservatively.
    const opening = edgeScore(startBeatIndex / barLength);
    const strength = meanScore > 0 ? Math.min(1, opening / (meanScore * 2.5)) : 0.25;
    candidates.push({
      startBeatIndex,
      endBeatIndex,
      label: "section",
      labelConfidence: 0,
      structuralConfidence: Math.round(Math.max(0.05, Math.min(1, strength)) * 1000) / 1000,
    });
  }
  return candidates;
}

/** Local structural analysis using original source audio only. */
export async function handleSectionAnalysisJob(payloadInput: Record<string, unknown>): Promise<void> {
  const payload = payloadInput as unknown as SourceSectionAnalysisJobPayload;
  const [job] = await db.select().from(sourceSectionAnalyses).where(eq(sourceSectionAnalyses.id, payload.sourceSectionAnalysisId)).limit(1);
  if (!job || job.status === "complete" || job.status === "unavailable") return;
  const invalidPayload =
    job.projectId !== payload.projectId ||
    job.sourceAssetId !== payload.sourceAssetId ||
    job.sourceAnalysisId !== payload.sourceAnalysisId ||
    job.analysisEngine !== payload.analysisEngine ||
    job.analysisEngineVersion !== payload.analysisEngineVersion;
  if (invalidPayload) {
    await updateSectionAnalysis(job.id, {
      status: "failed",
      stage: "failed",
      errorCode: "invalid_payload",
      errorMessage: "Section queue payload does not match its durable source target.",
      completedAt: new Date(),
    });
    throw new Error("Section queue payload does not match its durable source target.");
  }
  const [analysis] = await db.select().from(sourceAnalyses).where(eq(sourceAnalyses.id, job.sourceAnalysisId)).limit(1);
  const [source] = await db
    .select()
    .from(sourceAssets)
    .where(and(eq(sourceAssets.id, job.sourceAssetId), eq(sourceAssets.projectId, job.projectId)))
    .limit(1);
  const beatGrid = analysis ? parseBeatGrid(analysis.beatGrid) : null;
  if (!source || source.checksumSha256 !== job.sourceChecksumSha256 || !analysis || analysis.status !== "complete" || !beatGrid) {
    await updateSectionAnalysis(job.id, {
      status: "unavailable",
      stage: "insufficient-analysis",
      errorCode: !source ? "source_missing" : "insufficient_analysis",
      errorMessage: !source ? "Authorized source asset is missing." : "Structural analysis requires complete persisted beat-grid analysis.",
      completedAt: new Date(),
    });
    return;
  }

  const temporaryDirectory = await mkdtemp(join(tmpdir(), "arena-sections-"));
  const inputPath = join(temporaryDirectory, "source-input");
  try {
    await updateSectionAnalysis(job.id, {
      status: "preparing",
      stage: "preparing",
      startedAt: new Date(),
      attempts: (job.attempts ?? 0) + 1,
      errorCode: null,
      errorMessage: null,
      completedAt: null,
    });
    await getStorage().getToFile(source.storageKey, inputPath);
    await updateSectionAnalysis(job.id, { status: "processing", stage: "analyzing" });
    const pcm = await decodeMonoPcm(inputPath);
    const { envelope, frameMs } = onsetEnvelope(pcm);
    const candidates = desktopSectionCandidates(beatGrid, envelope, frameMs);
    if (!candidates) {
      await updateSectionAnalysis(job.id, {
        status: "unavailable",
        stage: "insufficient-evidence",
        errorCode: "structural_evidence_invalid",
        errorMessage: "No conservative bar-aligned structural boundary was supported by the source evidence.",
        analyzedAt: new Date(),
        completedAt: new Date(),
      });
      return;
    }
    const sections = normalizeSourceSections(
      candidates,
      beatGrid,
      {
        analysisEngine: DESKTOP_SECTION_ENGINE,
        analysisEngineVersion: DESKTOP_SECTION_ENGINE_VERSION,
        sourceChecksumSha256: source.checksumSha256,
      },
      ({ startBeatIndex, endBeatIndex }) => desktopSectionId(source.id, source.checksumSha256, startBeatIndex, endBeatIndex),
    );
    if (!sections.length || !sourceSectionsAreValid(sections, beatGrid)) {
      await updateSectionAnalysis(job.id, {
        status: "unavailable",
        stage: "insufficient-evidence",
        errorCode: "structural_evidence_invalid",
        errorMessage: "No valid conservative source sections were produced.",
        analyzedAt: new Date(),
        completedAt: new Date(),
      });
      return;
    }
    const analyzedAt = new Date();
    await db.transaction(async (tx) => {
      await tx.delete(sourceSections).where(eq(sourceSections.sourceAssetId, source.id));
      await tx.insert(sourceSections).values(
        sections.map((section) => ({
          ...section,
          projectId: source.projectId,
          sourceAssetId: source.id,
          sourceAnalysisId: analysis.id,
          sourceSectionAnalysisId: job.id,
        })),
      );
      await tx
        .update(sourceSectionAnalyses)
        .set({ status: "complete", stage: "complete", errorCode: null, errorMessage: null, analyzedAt, completedAt: analyzedAt, updatedAt: analyzedAt })
        .where(eq(sourceSectionAnalyses.id, job.id));
    });
  } catch (error) {
    const message = error instanceof Error ? error.message.slice(0, 1800) : "Unknown structural analysis failure.";
    await updateSectionAnalysis(job.id, {
      status: "failed",
      stage: "failed",
      errorCode: "section_analysis_failed",
      errorMessage: message,
      completedAt: new Date(),
    });
    throw error;
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
}
