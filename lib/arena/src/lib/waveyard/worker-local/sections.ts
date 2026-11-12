/**
 * Local section-analysis job handler — a faithful port of the worker's
 * processSourceSectionAnalysis, with the structure engine reimplemented in
 * JS: conservative bar-aligned boundaries chosen at onset-novelty peaks,
 * supplemented by beat-grid-aligned repeated two-bar phrases when the source
 * supports them.
 * Repetition is not mislabeled as verse/chorus or used to align other songs.
 * Candidates flow through the app's own normalizeSourceSections/
 * sourceSectionsAreValid validators, so rows are indistinguishable in shape
 * and constraints from worker-produced sections; only the engine provenance
 * differs (arena-js-structure, honestly recorded).
 */

import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { and, desc, eq, inArray } from "drizzle-orm";
import type { drizzle } from "drizzle-orm/node-postgres";

import { db as defaultDb } from "@workspace/db";
import { processingJobs, sourceAnalyses, sourceAssets, sourceSectionAnalyses, sourceSections, stemAssets } from "@workspace/db/waveyardSchema";
import { getStorage, type StorageProvider } from "@workspace/arena/lib/waveyard/storage";
import { normalizeSourceSections, sourceSectionsAreValid } from "@workspace/arena/lib/waveyard/types/source-sections";
import { usableBeatGrid } from "@workspace/arena/lib/waveyard/types/beat-grid";
import { currentBeatConfidence } from "@workspace/arena/lib/waveyard/types/analysis-provenance";
import type { SourceSectionAnalysisJobPayload } from "@workspace/arena/lib/waveyard/types";
import { DESKTOP_SECTION_ENGINE, DESKTOP_SECTION_ENGINE_VERSION } from "./analysis";
import { ANALYSIS_PCM_RATE, decodeMonoPcm, onsetEnvelope } from "./analysis-engine";
import {
  buildPassageFingerprint,
  buildStemActivityProfile,
  desktopSectionCandidates,
  detectStemActivityBoundaryChanges,
  type StemActivityBoundaryChange,
  type StemActivityProfile,
} from "./section-rhythm";

type SectionAnalysisDeps = {
  db?: ReturnType<typeof drizzle>;
  storage?: StorageProvider;
  decode?: typeof decodeMonoPcm;
};

function parseBeatGrid(value: string | null) {
  if (!value) return null;
  try {
    return usableBeatGrid(JSON.parse(value));
  } catch {
    return null;
  }
}

async function updateSectionAnalysis(
  database: ReturnType<typeof drizzle>,
  id: string,
  patch: Partial<typeof sourceSectionAnalyses.$inferInsert>,
  expectedStatus?: string | readonly string[],
) {
  const statusCondition = expectedStatus === undefined
    ? undefined
    : Array.isArray(expectedStatus)
      ? inArray(sourceSectionAnalyses.status, [...expectedStatus])
      : eq(sourceSectionAnalyses.status, expectedStatus as string);
  const updated = await database.update(sourceSectionAnalyses).set({ ...patch, updatedAt: new Date() })
    .where(statusCondition
      ? and(eq(sourceSectionAnalyses.id, id), statusCondition)
      : eq(sourceSectionAnalyses.id, id))
    .returning({ id: sourceSectionAnalyses.id });
  return updated.length > 0;
}

export function desktopSectionId(sourceAssetId: string, sourceChecksum: string, startBeatIndex: number, endBeatIndex: number) {
  return `section_${createHash("sha256")
    .update(`${sourceAssetId}:${sourceChecksum}:${DESKTOP_SECTION_ENGINE}:${DESKTOP_SECTION_ENGINE_VERSION}:${startBeatIndex}:${endBeatIndex}`)
    .digest("hex")
    .slice(0, 32)}`;
}

function separationSourceChecksum(metadata: string): string | null {
  try {
    const parsed = JSON.parse(metadata) as Record<string, unknown>;
    return typeof parsed.sourceChecksumSha256 === "string" ? parsed.sourceChecksumSha256 : null;
  } catch {
    return null;
  }
}

/** Loads only current-checksum stems from a completed separation publication. */
async function loadStemActivityProfiles(input: {
  database: ReturnType<typeof drizzle>;
  storage: StorageProvider;
  decode: typeof decodeMonoPcm;
  temporaryDirectory: string;
  source: typeof sourceAssets.$inferSelect;
  beatGridMs: number[];
  sourcePcm: Float32Array;
}): Promise<{ profiles: StemActivityProfile[]; changes: StemActivityBoundaryChange[] }> {
  const rows = await input.database
    .select({ stem: stemAssets, job: processingJobs })
    .from(stemAssets)
    .innerJoin(processingJobs, eq(stemAssets.separationJobId, processingJobs.id))
    .where(and(
      eq(stemAssets.projectId, input.source.projectId),
      eq(stemAssets.sourceAssetId, input.source.id),
      eq(processingJobs.projectId, input.source.projectId),
      eq(processingJobs.sourceAssetId, input.source.id),
      eq(processingJobs.type, "separation"),
      eq(processingJobs.status, "complete"),
    ))
    .orderBy(desc(processingJobs.completedAt), desc(stemAssets.createdAt));
  const latestCurrentJob = rows.find((row) => separationSourceChecksum(row.job.metadata) === input.source.checksumSha256)?.job;
  if (!latestCurrentJob) return { profiles: [], changes: [] };

  const selected = new Map<string, typeof rows[number]["stem"]>();
  for (const row of rows) {
    if (row.job.id !== latestCurrentJob.id || row.stem.stemType.includes("/")) continue;
    if (!selected.has(row.stem.stemType)) selected.set(row.stem.stemType, row.stem);
    if (selected.size >= 8) break;
  }

  const profiles: StemActivityProfile[] = [];
  const sourceDurationMs = (input.sourcePcm.length * 1000) / ANALYSIS_PCM_RATE;
  for (const stem of selected.values()) {
    const downloadedPath = join(input.temporaryDirectory, `stem-${stem.id}.wav`);
    try {
      await input.storage.verifyObject(stem.storageKey, {
        sha256: stem.checksumSha256,
        byteLength: stem.fileSizeBytes,
      });
      const inputPath = input.storage.getLocalPath(stem.storageKey) ?? downloadedPath;
      if (inputPath === downloadedPath) await input.storage.getToFile(stem.storageKey, inputPath);
      const pcm = await input.decode(inputPath);
      const stemDurationMs = (pcm.length * 1000) / ANALYSIS_PCM_RATE;
      if (pcm.length < ANALYSIS_PCM_RATE * 8 || Math.abs(stemDurationMs - sourceDurationMs) > 500) continue;
      const profile = buildStemActivityProfile(pcm, input.beatGridMs, {
        stemType: stem.stemType,
        stemAssetId: stem.id,
        separationJobId: latestCurrentJob.id,
        stemChecksumSha256: stem.checksumSha256,
      });
      if (profile) profiles.push(profile);
    } catch (error) {
      // A missing/corrupt optional stem must not block the source-only fallback.
      console.warn("Waveyard skipped unavailable stem activity evidence", {
        stemAssetId: stem.id,
        reason: error instanceof Error ? error.message : String(error),
      });
    }
  }
  const changes = detectStemActivityBoundaryChanges(profiles);
  return { profiles, changes };
}

/** Local structural analysis uses source audio and optional verified stem PCM. */
export async function handleSectionAnalysisJob(
  payloadInput: Record<string, unknown>,
  deps: SectionAnalysisDeps = {},
): Promise<void> {
  const payload = payloadInput as unknown as SourceSectionAnalysisJobPayload;
  const database = deps.db ?? defaultDb;
  const decode = deps.decode ?? decodeMonoPcm;
  const [job] = await database.select().from(sourceSectionAnalyses).where(eq(sourceSectionAnalyses.id, payload.sourceSectionAnalysisId)).limit(1);
  if (!job || job.status === "complete" || job.status === "unavailable") return;
  const invalidPayload =
    job.projectId !== payload.projectId ||
    job.sourceAssetId !== payload.sourceAssetId ||
    job.sourceAnalysisId !== payload.sourceAnalysisId ||
    job.analysisEngine !== payload.analysisEngine ||
    job.analysisEngineVersion !== payload.analysisEngineVersion;
  if (invalidPayload) {
    await updateSectionAnalysis(database, job.id, {
      status: "failed",
      stage: "failed",
      errorCode: "invalid_payload",
      errorMessage: "Section queue payload does not match its durable source target.",
      completedAt: new Date(),
    }, job.status);
    throw new Error("Section queue payload does not match its durable source target.");
  }
  const [analysis] = await database.select().from(sourceAnalyses).where(eq(sourceAnalyses.id, job.sourceAnalysisId)).limit(1);
  const [source] = await database
    .select()
    .from(sourceAssets)
    .where(and(eq(sourceAssets.id, job.sourceAssetId), eq(sourceAssets.projectId, job.projectId)))
    .limit(1);
  const beatGrid = analysis ? parseBeatGrid(analysis.beatGrid) : null;
  if (!source || source.checksumSha256 !== job.sourceChecksumSha256 || !analysis || analysis.status !== "complete" || !beatGrid) {
    await updateSectionAnalysis(database, job.id, {
      status: "unavailable",
      stage: "insufficient-analysis",
      errorCode: !source ? "source_missing" : "insufficient_analysis",
      errorMessage: !source ? "Authorized source asset is missing." : "Structural analysis requires complete persisted beat-grid analysis.",
      completedAt: new Date(),
    }, job.status);
    return;
  }

  const storage = deps.storage ?? getStorage();
  const temporaryDirectory = await mkdtemp(join(tmpdir(), "arena-sections-"));
  const inputPath = join(temporaryDirectory, "source-input");
  try {
    const prepared = await updateSectionAnalysis(database, job.id, {
      status: "preparing",
      stage: "preparing",
      startedAt: new Date(),
      attempts: (job.attempts ?? 0) + 1,
      errorCode: null,
      errorMessage: null,
      completedAt: null,
    }, job.status);
    if (!prepared) return;
    await storage.verifyObject(source.storageKey, {
      sha256: source.checksumSha256,
      byteLength: source.fileSizeBytes,
    });
    const sourceInputPath = storage.getLocalPath(source.storageKey) ?? inputPath;
    if (sourceInputPath === inputPath) await storage.getToFile(source.storageKey, inputPath);
    const started = await updateSectionAnalysis(database, job.id, { status: "processing", stage: "analyzing" }, "preparing");
    if (!started) return;
    const pcm = await decode(sourceInputPath);
    const decodedSourceDurationMs = Math.floor(
      (pcm.length * 1000) / ANALYSIS_PCM_RATE,
    );
    const { envelope, frameMs } = onsetEnvelope(pcm);
    const stemActivity = await loadStemActivityProfiles({
      database,
      storage,
      decode,
      temporaryDirectory,
      source,
      beatGridMs: beatGrid,
      sourcePcm: pcm,
    });
    const candidates = desktopSectionCandidates(beatGrid, envelope, frameMs, pcm, undefined, stemActivity.changes);
    if (!candidates) {
      await updateSectionAnalysis(database, job.id, {
        status: "unavailable",
        stage: "insufficient-evidence",
        errorCode: "structural_evidence_invalid",
        errorMessage: "No conservative bar-aligned structural boundary was supported by the source evidence.",
        analyzedAt: new Date(),
        completedAt: new Date(),
      }, "processing");
      return;
    }
    const fingerprintedCandidates = candidates.map((candidate) => ({
      ...candidate,
      passageFingerprint: buildPassageFingerprint({
        sourceChecksumSha256: source.checksumSha256,
        startBeatIndex: candidate.startBeatIndex,
        endBeatIndex: candidate.endBeatIndex,
        beatGridMs: beatGrid,
        beatConfidence: currentBeatConfidence(analysis),
        envelope,
        frameMs,
        pcm,
        stemActivityProfiles: stemActivity.profiles,
        stemActivityBoundaryChanges: stemActivity.changes,
      }),
    }));
    const sections = normalizeSourceSections(
      fingerprintedCandidates,
      beatGrid,
      {
        analysisEngine: DESKTOP_SECTION_ENGINE,
        analysisEngineVersion: DESKTOP_SECTION_ENGINE_VERSION,
        sourceChecksumSha256: source.checksumSha256,
      },
      ({ startBeatIndex, endBeatIndex }) => desktopSectionId(source.id, source.checksumSha256, startBeatIndex, endBeatIndex),
      decodedSourceDurationMs,
    );
    if (!sections.length || !sourceSectionsAreValid(sections, beatGrid, decodedSourceDurationMs)) {
      await updateSectionAnalysis(database, job.id, {
        status: "unavailable",
        stage: "insufficient-evidence",
        errorCode: "structural_evidence_invalid",
        errorMessage: "No valid conservative source sections were produced.",
        analyzedAt: new Date(),
        completedAt: new Date(),
      }, "processing");
      return;
    }
    const analyzedAt = new Date();
    await database.transaction(async (tx) => {
      const [currentJob] = await tx.select().from(sourceSectionAnalyses)
        .where(eq(sourceSectionAnalyses.id, job.id))
        .for("update")
        .limit(1);
      const [currentSource] = await tx.select({ checksumSha256: sourceAssets.checksumSha256 })
        .from(sourceAssets)
        .where(eq(sourceAssets.id, source.id))
        .for("update")
        .limit(1);
      // A newer separation completion can queue a stem-aware refresh while this
      // source-only pass is still running. Do not publish the stale result.
      if (!currentJob || currentJob.status !== "processing" || !currentSource
        || currentSource.checksumSha256 !== source.checksumSha256) return;
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
        .where(and(eq(sourceSectionAnalyses.id, job.id), eq(sourceSectionAnalyses.status, "processing")));
    });
  } catch (error) {
    const message = error instanceof Error ? error.message.slice(0, 1800) : "Unknown structural analysis failure.";
    await updateSectionAnalysis(database, job.id, {
      status: "failed",
      stage: "failed",
      errorCode: "section_analysis_failed",
      errorMessage: message,
      completedAt: new Date(),
    }, ["preparing", "processing"]);
    throw error;
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
}
