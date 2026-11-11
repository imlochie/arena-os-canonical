/**
 * Server-side source resolution for the mashup routes — authoritative
 * analysis + sections → MashupSourceProfile. Shared by plan and render so
 * both see exactly the same evidence.
 */

import { and, asc, desc, eq } from "drizzle-orm";

import { db } from "@workspace/db";
import { processingJobs, sourceAnalyses, sourceAssets, sourceSections, stemAssets, vocalAnalyses, vocalPhrases } from "@workspace/db/waveyardSchema";
import {
  LOCAL_VOCAL_ANALYSIS_ENGINE,
  LOCAL_VOCAL_ANALYSIS_ENGINE_VERSION,
  vocalAnalysisProvenanceReason,
  type VocalPhrase,
} from "../types/vocal-analysis";
import { trustedAnalysisBeatGrid } from "../types/analysis-confidence";
import type { MashupSourceProfile } from "./mashup";

export async function loadSourceProfile(
  projectId: string,
  sourceAssetId: string,
  role: "vocals" | "instrumental",
  database: any = db,
): Promise<MashupSourceProfile | null> {
  const [asset] = await database
    .select({
      id: sourceAssets.id,
      durationSeconds: sourceAssets.durationSeconds,
      checksumSha256: sourceAssets.checksumSha256,
    })
    .from(sourceAssets)
    .where(and(eq(sourceAssets.id, sourceAssetId), eq(sourceAssets.projectId, projectId)))
    .limit(1);
  if (!asset) return null;

  const [analysis] = await database
    .select({
      bpm: sourceAnalyses.bpm,
      bpmConfidence: sourceAnalyses.bpmConfidence,
      musicalKey: sourceAnalyses.musicalKey,
      keyConfidence: sourceAnalyses.keyConfidence,
      beatGrid: sourceAnalyses.beatGrid,
      beatConfidence: sourceAnalyses.beatConfidence,
      sourceChecksumSha256: sourceAnalyses.sourceChecksumSha256,
      status: sourceAnalyses.status,
    })
    .from(sourceAnalyses)
    .where(
      and(
        eq(sourceAnalyses.sourceAssetId, sourceAssetId),
        eq(sourceAnalyses.projectId, projectId),
        eq(sourceAnalyses.sourceChecksumSha256, asset.checksumSha256),
        eq(sourceAnalyses.status, "complete"),
      ),
    )
    .orderBy(desc(sourceAnalyses.createdAt), desc(sourceAnalyses.id))
    .limit(1);

  const sections = await database
    .select({ label: sourceSections.label, startMs: sourceSections.startMs, endMs: sourceSections.endMs })
    .from(sourceSections)
    .where(eq(sourceSections.sourceAssetId, sourceAssetId))
    .orderBy(asc(sourceSections.startMs));

  const measuredVocalPhrases = role === "vocals"
    ? await loadCurrentVocalPhrases(database, projectId, sourceAssetId, asset.checksumSha256, Math.round(asset.durationSeconds * 1000))
    : [];

  let parsedGrid: number[] | null = null;
  if (analysis?.beatGrid) {
    try {
      const parsed = JSON.parse(analysis.beatGrid);
      parsedGrid = trustedAnalysisBeatGrid(parsed, analysis.bpmConfidence, analysis.beatConfidence);
    } catch {
      parsedGrid = null;
    }
  }

  return {
    role,
    bpm: analysis?.bpm ?? null,
    bpmConfidence: analysis?.bpmConfidence ?? null,
    musicalKey: analysis?.musicalKey ?? null,
    keyConfidence: analysis?.keyConfidence ?? null,
    beatGridMs: parsedGrid,
    beatConfidence: analysis?.beatConfidence ?? null,
    durationMs: Math.round(asset.durationSeconds * 1000),
    sections,
    vocalPhrases: measuredVocalPhrases,
  };
}

/**
 * Mashup planning may use only phrase intervals from the latest vocal stem
 * when both its separation run and checksum-bound local analysis completed.
 * Older or mismatched analysis is treated as unavailable, never reused.
 */
async function loadCurrentVocalPhrases(
  database: any,
  projectId: string,
  sourceAssetId: string,
  sourceChecksumSha256: string,
  durationMs: number,
): Promise<VocalPhrase[]> {
  const [stem] = await database
    .select({
      id: stemAssets.id,
      checksumSha256: stemAssets.checksumSha256,
      separationJobId: stemAssets.separationJobId,
    })
    .from(stemAssets)
    .where(and(
      eq(stemAssets.projectId, projectId),
      eq(stemAssets.sourceAssetId, sourceAssetId),
      eq(stemAssets.stemType, "vocals"),
    ))
    .orderBy(desc(stemAssets.createdAt), desc(stemAssets.id))
    .limit(1);
  if (!stem) return [];

  const [separation] = await database
    .select({ status: processingJobs.status })
    .from(processingJobs)
    .where(eq(processingJobs.id, stem.separationJobId))
    .limit(1);
  if (separation?.status !== "complete") return [];

  const [analysis] = await database
    .select({
      id: vocalAnalyses.id,
      sourceAssetId: vocalAnalyses.sourceAssetId,
      stemAssetId: vocalAnalyses.stemAssetId,
      sourceChecksumSha256: vocalAnalyses.sourceChecksumSha256,
      stemChecksumSha256: vocalAnalyses.stemChecksumSha256,
      analysisEngine: vocalAnalyses.analysisEngine,
      analysisEngineVersion: vocalAnalyses.analysisEngineVersion,
    })
    .from(vocalAnalyses)
    .where(and(
      eq(vocalAnalyses.projectId, projectId),
      eq(vocalAnalyses.sourceAssetId, sourceAssetId),
      eq(vocalAnalyses.stemAssetId, stem.id),
      eq(vocalAnalyses.status, "complete"),
      eq(vocalAnalyses.analysisEngine, LOCAL_VOCAL_ANALYSIS_ENGINE),
      eq(vocalAnalyses.analysisEngineVersion, LOCAL_VOCAL_ANALYSIS_ENGINE_VERSION),
      eq(vocalAnalyses.sourceChecksumSha256, sourceChecksumSha256),
      eq(vocalAnalyses.stemChecksumSha256, stem.checksumSha256),
    ))
    .orderBy(desc(vocalAnalyses.completedAt), desc(vocalAnalyses.id))
    .limit(1);
  if (!analysis || vocalAnalysisProvenanceReason({
    sourceAssetId: analysis.sourceAssetId,
    expectedSourceAssetId: sourceAssetId,
    stemAssetId: analysis.stemAssetId,
    expectedStemAssetId: stem.id,
    sourceChecksumSha256: analysis.sourceChecksumSha256,
    expectedSourceChecksumSha256: sourceChecksumSha256,
    stemChecksumSha256: analysis.stemChecksumSha256,
    expectedStemChecksumSha256: stem.checksumSha256,
    analysisEngine: analysis.analysisEngine,
    analysisEngineVersion: analysis.analysisEngineVersion,
  }, { engine: LOCAL_VOCAL_ANALYSIS_ENGINE, version: LOCAL_VOCAL_ANALYSIS_ENGINE_VERSION })) return [];

  const rows = await database
    .select({ startMs: vocalPhrases.startMs, endMs: vocalPhrases.endMs, confidence: vocalPhrases.confidence })
    .from(vocalPhrases)
    .where(eq(vocalPhrases.vocalAnalysisId, analysis.id))
    .orderBy(asc(vocalPhrases.startMs));

  return rows.filter((phrase: VocalPhrase) =>
    Number.isSafeInteger(phrase.startMs)
    && Number.isSafeInteger(phrase.endMs)
    && phrase.startMs >= 0
    && phrase.endMs > phrase.startMs
    && phrase.endMs <= durationMs
    && Number.isFinite(phrase.confidence)
    && phrase.confidence >= 0
    && phrase.confidence <= 1,
  );
}
