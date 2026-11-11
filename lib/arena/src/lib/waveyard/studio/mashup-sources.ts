/**
 * Server-side source resolution for the mashup routes — authoritative
 * analysis + sections → MashupSourceProfile. Shared by plan and render so
 * both see exactly the same evidence.
 */

import { and, asc, desc, eq } from "drizzle-orm";

import { db } from "@workspace/db";
import { sourceAnalyses, sourceAssets, sourceSectionAnalyses, sourceSections } from "@workspace/db/waveyardSchema";
import { trustedAnalysisBeatGrid } from "../types/analysis-confidence";
import { isCurrentDesktopSectionAnalysis } from "../types/analysis-provenance";
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
      id: sourceAnalyses.id,
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

  let sections: MashupSourceProfile["sections"] = [];
  if (analysis) {
    const [sectionAnalysis] = await database
      .select({
        id: sourceSectionAnalyses.id,
        analysisEngine: sourceSectionAnalyses.analysisEngine,
        analysisEngineVersion: sourceSectionAnalyses.analysisEngineVersion,
        sourceChecksumSha256: sourceSectionAnalyses.sourceChecksumSha256,
      })
      .from(sourceSectionAnalyses)
      .where(and(
        eq(sourceSectionAnalyses.projectId, projectId),
        eq(sourceSectionAnalyses.sourceAssetId, sourceAssetId),
        eq(sourceSectionAnalyses.sourceAnalysisId, analysis.id),
        eq(sourceSectionAnalyses.status, "complete"),
        eq(sourceSectionAnalyses.sourceChecksumSha256, asset.checksumSha256),
      ))
      .limit(1);

    if (sectionAnalysis && isCurrentDesktopSectionAnalysis(sectionAnalysis)) {
      const rows: MashupSourceProfile["sections"] = await database
        .select({
          label: sourceSections.label,
          startMs: sourceSections.startMs,
          endMs: sourceSections.endMs,
        })
        .from(sourceSections)
        .where(and(
          eq(sourceSections.projectId, projectId),
          eq(sourceSections.sourceAssetId, sourceAssetId),
          eq(sourceSections.sourceAnalysisId, analysis.id),
          eq(sourceSections.sourceSectionAnalysisId, sectionAnalysis.id),
          eq(sourceSections.sourceChecksumSha256, asset.checksumSha256),
          eq(sourceSections.analysisEngine, sectionAnalysis.analysisEngine),
          eq(sourceSections.analysisEngineVersion, sectionAnalysis.analysisEngineVersion),
        ))
        .orderBy(asc(sourceSections.startMs), asc(sourceSections.sectionIndex));
      const durationMs = Math.round(asset.durationSeconds * 1000);
      sections = rows.filter((section) =>
        Number.isSafeInteger(section.startMs)
        && Number.isSafeInteger(section.endMs)
        && section.startMs >= 0
        && section.endMs > section.startMs
        && section.endMs <= durationMs,
      );
    }
  }

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
  };
}
