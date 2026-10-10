/**
 * Server-side source resolution for the mashup routes — authoritative
 * analysis + sections → MashupSourceProfile. Shared by plan and render so
 * both see exactly the same evidence.
 */

import { and, asc, eq } from "drizzle-orm";

import { db } from "@/db";
import { sourceAnalyses, sourceAssets, sourceSections } from "@/db/waveyardSchema";
import type { MashupSourceProfile } from "./mashup";

export async function loadSourceProfile(
  projectId: string,
  sourceAssetId: string,
  role: "vocals" | "instrumental",
): Promise<MashupSourceProfile | null> {
  const [asset] = await db
    .select({ id: sourceAssets.id, durationSeconds: sourceAssets.durationSeconds })
    .from(sourceAssets)
    .where(and(eq(sourceAssets.id, sourceAssetId), eq(sourceAssets.projectId, projectId)))
    .limit(1);
  if (!asset) return null;

  const [analysis] = await db
    .select({ bpm: sourceAnalyses.bpm, musicalKey: sourceAnalyses.musicalKey })
    .from(sourceAnalyses)
    .where(eq(sourceAnalyses.sourceAssetId, sourceAssetId))
    .limit(1);

  const sections = await db
    .select({ label: sourceSections.label, startMs: sourceSections.startMs, endMs: sourceSections.endMs })
    .from(sourceSections)
    .where(eq(sourceSections.sourceAssetId, sourceAssetId))
    .orderBy(asc(sourceSections.startMs));

  return {
    role,
    bpm: analysis?.bpm ?? null,
    musicalKey: analysis?.musicalKey ?? null,
    durationMs: Math.round(asset.durationSeconds * 1000),
    sections,
  };
}
