import { NextResponse } from "next/server";
import { asc, eq } from "drizzle-orm";
import { db } from "@/db";
import {
  automaticRemixGenerations,
  remixClips,
  remixSessions,
  remixTracks,
  remixVersions,
  sourceAnalyses,
  sourceAssets,
  sourceSectionAnalyses,
  sourceSections,
  stemAssets,
} from "@/db/waveyardSchema";
import { buildAutomaticRemixPlan, type AutomaticRemixConstraints } from "@/lib/waveyard/types";
import { requireUser } from "@/lib/waveyard/local-context";
import { requireProjectRole } from "@/lib/waveyard/local-context";

function parseBeatGrid(value: string | null) {
  if (!value) return null;
  try { return JSON.parse(value); } catch { return null; }
}

function constraintsFrom(value: unknown): AutomaticRemixConstraints {
  if (!value || typeof value !== "object") return {};
  const input = value as Record<string, unknown>;
  return {
    variant: input.variant === "hybrid" ? "hybrid" : "original",
    ...(typeof input.anchorSourceId === "string" ? { anchorSourceId: input.anchorSourceId } : {}),
    ...(typeof input.vocalStemId === "string" ? { vocalStemId: input.vocalStemId } : {}),
    ...(typeof input.drumsStemId === "string" ? { drumsStemId: input.drumsStemId } : {}),
    instrumental: input.instrumental === true,
  };
}

/**
 * Materializes a deterministic plan directly into the existing RemixSession,
 * RemixTrack and RemixClip tables. The generation row is explanation only,
 * never a competing arrangement or browser-side audio authority.
 */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const user = await requireUser();
    const { id: projectId } = await params;
    await requireProjectRole(user.id, projectId, "editor");
    const constraints = constraintsFrom(await request.json().catch(() => ({})));
    
    const [sources, stems, analyses, sectionAnalyses, sections] = await Promise.all([
      db.select().from(sourceAssets).where(eq(sourceAssets.projectId, projectId)).orderBy(asc(sourceAssets.createdAt)),
      db.select().from(stemAssets).where(eq(stemAssets.projectId, projectId)).orderBy(asc(stemAssets.createdAt)),
      db.select().from(sourceAnalyses).where(eq(sourceAnalyses.projectId, projectId)).orderBy(asc(sourceAnalyses.createdAt)),
      db.select().from(sourceSectionAnalyses).where(eq(sourceSectionAnalyses.projectId, projectId)).orderBy(asc(sourceSectionAnalyses.createdAt)),
      db.select().from(sourceSections).where(eq(sourceSections.projectId, projectId)).orderBy(asc(sourceSections.sourceAssetId), asc(sourceSections.sectionIndex)),
    ]);
    const analysisBySource = new Map(analyses.map((analysis) => [analysis.sourceAssetId, analysis]));
    const sectionAnalysisBySource = new Map(sectionAnalyses.map((analysis) => [analysis.sourceAssetId, analysis]));
    const sectionsBySource = new Map<string, typeof sections>();
    for (const section of sections) {
      const existing = sectionsBySource.get(section.sourceAssetId) ?? [];
      existing.push(section);
      sectionsBySource.set(section.sourceAssetId, existing);
    }
    const plan = buildAutomaticRemixPlan(sources.map((source) => {
      const analysis = analysisBySource.get(source.id);
      const sectionAnalysis = sectionAnalysisBySource.get(source.id);
      const verifiedAnalysis = analysis?.status === "complete" && analysis.sourceChecksumSha256 === source.checksumSha256
        ? analysis
        : null;
      const verifiedSections = verifiedAnalysis && sectionAnalysis?.status === "complete"
        && sectionAnalysis.sourceAnalysisId === verifiedAnalysis.id
        && sectionAnalysis.sourceChecksumSha256 === source.checksumSha256
        ? (sectionsBySource.get(source.id) ?? []).filter((section) => section.sourceAnalysisId === verifiedAnalysis.id
          && section.sourceSectionAnalysisId === sectionAnalysis.id && section.sourceChecksumSha256 === source.checksumSha256)
        : [];
      return {
        id: source.id,
        originalFilename: source.originalFilename,
        checksumSha256: source.checksumSha256,
        durationMs: source.durationSeconds * 1000,
        analysis: verifiedAnalysis ? {
          id: verifiedAnalysis.id,
          status: verifiedAnalysis.status,
          sourceChecksumSha256: verifiedAnalysis.sourceChecksumSha256,
          bpm: verifiedAnalysis.bpm,
          musicalKey: verifiedAnalysis.musicalKey,
          beatGridMs: parseBeatGrid(verifiedAnalysis.beatGrid),
        } : null,
        sections: verifiedSections.map((section) => ({ id: section.id, sectionIndex: section.sectionIndex, startMs: section.startMs, endMs: section.endMs })),
        stems: stems.filter((stem) => stem.sourceAssetId === source.id).map((stem) => ({ id: stem.id, sourceAssetId: stem.sourceAssetId, stemType: stem.stemType, durationMs: stem.durationSeconds * 1000 })),
      };
    }), constraints);
    if (!plan.ok) return NextResponse.json({ error: plan.reason === "no_stems" ? "No usable stems remain for this automatic arrangement." : "A completed source with real stems is required before Waveyard can build an arrangement." }, { status: 409 });

    const result = await db.transaction(async (tx) => {
      const [remix] = await tx.insert(remixSessions).values({
        projectId,
        ownerId: user.id,
        name: plan.plan.name,
        masterVolume: 1,
        loopStartMs: 0,
        loopEndMs: null,
        tempoBpm: plan.plan.tempoBpm,
        timeSignatureNumerator: 4,
        timeSignatureDenominator: 4,
        gridDivision: "beat",
        snapEnabled: true,
        targetKey: plan.plan.targetKey,
      }).returning();
      const tracks = await tx.insert(remixTracks).values(plan.plan.tracks.map((track) => ({
        remixSessionId: remix.id,
        stemAssetId: track.stemAssetId,
        name: track.name,
        sortOrder: track.sortOrder,
        volume: track.volume,
        pan: track.pan,
      }))).returning();
      const trackByStemId = new Map(tracks.map((track) => [track.stemAssetId, track]));
      const clips = plan.plan.tracks.flatMap((track) => track.clips.map((clip) => ({
        remixTrackId: trackByStemId.get(track.stemAssetId)!.id,
        stemAssetId: clip.stemAssetId,
        timelineStartMs: clip.timelineStartMs,
        durationMs: clip.durationMs,
        sourceOffsetMs: clip.sourceOffsetMs,
        gain: clip.gain,
        fadeInMs: clip.fadeInMs,
        fadeOutMs: clip.fadeOutMs,
        tempoSyncEnabled: clip.tempoSyncEnabled,
        keySyncEnabled: clip.keySyncEnabled,
        beatSnapEnabled: clip.beatSnapEnabled,
      })));
      const insertedClips = clips.length ? await tx.insert(remixClips).values(clips).returning() : [];
      await tx.insert(automaticRemixGenerations).values({
        remixSessionId: remix.id,
        engine: plan.plan.provenance.engine,
        engineVersion: plan.plan.provenance.engineVersion,
        variant: plan.plan.provenance.variant,
        constraints: JSON.stringify(plan.plan.provenance.constraints),
        provenance: JSON.stringify(plan.plan.provenance),
      });
      const snapshot = {
        name: remix.name,
        masterVolume: remix.masterVolume,
        loopStartMs: remix.loopStartMs,
        loopEndMs: remix.loopEndMs,
        tempoBpm: remix.tempoBpm,
        timeSignatureNumerator: remix.timeSignatureNumerator,
        timeSignatureDenominator: remix.timeSignatureDenominator,
        gridDivision: remix.gridDivision,
        snapEnabled: remix.snapEnabled,
        targetKey: remix.targetKey,
        tracks: tracks.map((track) => ({ ...track, clips: insertedClips.filter((clip) => clip.remixTrackId === track.id) })),
        automation: [],
      };
      const [version] = await tx.insert(remixVersions).values({
        remixSessionId: remix.id,
        createdById: user.id,
        name: "Automatic starting point",
        snapshot: JSON.stringify(snapshot),
      }).returning({ id: remixVersions.id, name: remixVersions.name, createdAt: remixVersions.createdAt });
      return { remix, version };
    });
    return NextResponse.json({ remix: result.remix, version: result.version, plan: { notices: plan.plan.notices, provenance: plan.plan.provenance } }, { status: 201 });
  } catch (error) {
    if (error instanceof Response) return error;
    console.error("automatic remix creation failed", error);
    return NextResponse.json({ error: "Could not build an automatic arrangement." }, { status: 500 });
  }
}
