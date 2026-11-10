/**
 * Server-side source resolution for the mashup routes — authoritative
 * analysis + sections → MashupSourceProfile. Shared by plan and render so
 * both see exactly the same evidence.
 */

import { and, asc, eq } from "drizzle-orm";

import { db } from "@workspace/db";
import { sourceAnalyses, sourceAssets, sourceSections } from "@workspace/db/waveyardSchema";
import { trustedAnalysisBeatGrid } from "../types/analysis-confidence";
import type { MashupSourceProfile } from "./mashup";

export async function loadSourceProfile(
  projectId: string,
  sourceAssetId: string,
  role: "vocals" | "instrumental",
): Promise<MashupSourceProfile | null> {
  const [asset] = await db
    .select({
      id: sourceAssets.id,
      durationSeconds: sourceAssets.durationSeconds,
      checksumSha256: sourceAssets.checksumSha256,
    })
    .from(sourceAssets)
    .where(and(eq(sourceAssets.id, sourceAssetId), eq(sourceAssets.projectId, projectId)))
    .limit(1);
  if (!asset) return null;

  const [analysis] = await db
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
        eq(sourceAnalyses.sourceChecksumSha256, asset.checksumSha256),
        eq(sourceAnalyses.status, "complete"),
      ),
    )
    .limit(1);

  const sections = await db
    .select({ label: sourceSections.label, startMs: sourceSections.startMs, endMs: sourceSections.endMs })
    .from(sourceSections)
    .where(eq(sourceSections.sourceAssetId, sourceAssetId))
    .orderBy(asc(sourceSections.startMs));

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
