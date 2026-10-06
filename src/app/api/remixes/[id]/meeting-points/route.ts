import { NextResponse } from "next/server";
import { asc, desc, eq, inArray } from "drizzle-orm";
import { db } from "@/db";
import {
  remixClips,
  remixSessions,
  remixTracks,
  sourceAnalyses,
  sourceAssets,
  sourceSectionAnalyses,
  sourceSections,
  stemAssets,
  vocalAnalyses,
  vocalPhrases,
} from "@/db/waveyardSchema";
import { discoverMusicalMeetingPoints, type MusicalMeetingPoint } from "@/lib/waveyard/types";
import { requireUser } from "@/lib/waveyard/local-context";
import { requireProjectRole } from "@/lib/waveyard/local-context";

function parsedBeatGrid(value: string | null) {
  if (!value) return null;
  try { return JSON.parse(value); } catch { return null; }
}

function closeTo(left: number, right: number, tolerance: number) {
  return Math.abs(left - right) <= tolerance;
}

async function access(userId: string, remixId: string, minimum: "viewer" | "editor") {
  const [remix] = await db.select().from(remixSessions).where(eq(remixSessions.id, remixId)).limit(1);
  if (!remix) throw new Response("Remix session not found.", { status: 404 });
  await requireProjectRole(userId, remix.projectId, minimum);
  return remix;
}

type Discovery = { points: MusicalMeetingPoint[]; sourceStemId: string; sourceSectionId: string };

/** Re-derives ephemeral meeting points from persisted authoritative state. */
async function discover(remix: typeof remixSessions.$inferSelect, stemId: string, sectionId: string): Promise<Discovery | null> {
  
  const [sources, stems, analyses, sectionAnalyses, sections, tracks, phrasesRows] = await Promise.all([
    db.select().from(sourceAssets).where(eq(sourceAssets.projectId, remix.projectId)).orderBy(asc(sourceAssets.createdAt)),
    db.select().from(stemAssets).where(eq(stemAssets.projectId, remix.projectId)).orderBy(asc(stemAssets.createdAt)),
    db.select().from(sourceAnalyses).where(eq(sourceAnalyses.projectId, remix.projectId)).orderBy(asc(sourceAnalyses.createdAt)),
    db.select().from(sourceSectionAnalyses).where(eq(sourceSectionAnalyses.projectId, remix.projectId)),
    db.select().from(sourceSections).where(eq(sourceSections.projectId, remix.projectId)).orderBy(asc(sourceSections.sourceAssetId), asc(sourceSections.sectionIndex)),
    db.select().from(remixTracks).where(eq(remixTracks.remixSessionId, remix.id)).orderBy(asc(remixTracks.sortOrder)),
    db.select().from(vocalPhrases).innerJoin(vocalAnalyses, eq(vocalPhrases.vocalAnalysisId, vocalAnalyses.id)).where(eq(vocalAnalyses.projectId, remix.projectId)),
  ]);
  const clips = tracks.length ? await db.select().from(remixClips).where(inArray(remixClips.remixTrackId, tracks.map((track) => track.id))) : [];
  const sourceById = new Map(sources.map((source) => [source.id, source]));
  const stemById = new Map(stems.map((stem) => [stem.id, stem]));
  const analysisBySource = new Map(analyses.map((analysis) => [analysis.sourceAssetId, analysis]));
  const sectionAnalysisBySource = new Map(sectionAnalyses.map((analysis) => [analysis.sourceAssetId, analysis]));
  const sectionsBySource = new Map<string, typeof sections>();
  for (const section of sections) {
    const current = sectionsBySource.get(section.sourceAssetId) ?? [];
    current.push(section); sectionsBySource.set(section.sourceAssetId, current);
  }
  const selectedStem = stemById.get(stemId);
  if (!selectedStem) return null;
  const source = sourceById.get(selectedStem.sourceAssetId);
  const sourceAnalysis = source ? analysisBySource.get(source.id) : null;
  const sourceSectionAnalysis = source ? sectionAnalysisBySource.get(source.id) : null;
  const selectedSection = source && sourceAnalysis && sourceSectionAnalysis
    ? (sectionsBySource.get(source.id) ?? []).find((section) => section.id === sectionId
      && section.sourceAnalysisId === sourceAnalysis.id && section.sourceSectionAnalysisId === sourceSectionAnalysis.id
      && section.sourceChecksumSha256 === source.checksumSha256)
    : null;
  if (!source || !sourceAnalysis || sourceAnalysis.status !== "complete" || sourceAnalysis.sourceChecksumSha256 !== source.checksumSha256
    || !sourceSectionAnalysis || sourceSectionAnalysis.status !== "complete" || sourceSectionAnalysis.sourceAnalysisId !== sourceAnalysis.id
    || sourceSectionAnalysis.sourceChecksumSha256 !== source.checksumSha256 || !selectedSection) return null;
  const phraseEvidence = phrasesRows
    .filter((row) => row.vocal_analyses.stemAssetId === selectedStem.id && row.vocal_analyses.status === "complete"
      && row.vocal_analyses.sourceAssetId === source.id && row.vocal_analyses.sourceChecksumSha256 === source.checksumSha256
      && row.vocal_analyses.stemChecksumSha256 === selectedStem.checksumSha256)
    .map((row) => row.vocal_phrases);
  const phraseTolerance = Math.max(100, 60_000 / Math.max(40, sourceAnalysis.bpm ?? 120) / 4);
  const sourceInput = {
    sourceAssetId: source.id,
    stemAssetId: selectedStem.id,
    sourceChecksumSha256: source.checksumSha256,
    sectionId: selectedSection.id,
    startBeatIndex: selectedSection.startBeatIndex,
    endBeatIndex: selectedSection.endBeatIndex,
    startMs: selectedSection.startMs,
    endMs: selectedSection.endMs,
    phraseBoundaryStart: selectedStem.stemType === "vocals" && phraseEvidence.some((phrase) => closeTo(phrase.startMs, selectedSection.startMs, phraseTolerance)),
    phraseBoundaryEnd: selectedStem.stemType === "vocals" && phraseEvidence.some((phrase) => closeTo(phrase.endMs, selectedSection.endMs, phraseTolerance)),
    analysis: {
      status: sourceAnalysis.status,
      sourceChecksumSha256: sourceAnalysis.sourceChecksumSha256,
      bpm: sourceAnalysis.bpm,
      musicalKey: sourceAnalysis.musicalKey,
      beatGridMs: parsedBeatGrid(sourceAnalysis.beatGrid),
    },
  };
  const beatMs = 60_000 / remix.tempoBpm;
  const targets = clips.flatMap((clip) => {
    const targetStem = stemById.get(clip.stemAssetId);
    const targetSource = targetStem ? sourceById.get(targetStem.sourceAssetId) : null;
    const targetAnalysis = targetSource ? analysisBySource.get(targetSource.id) : null;
    if (!targetStem || !targetSource) return [];
    const matchingSection = (sectionsBySource.get(targetSource.id) ?? []).find((section) => section.startMs === clip.sourceOffsetMs
      && section.endMs >= clip.sourceOffsetMs + (clip.tempoSyncEnabled ? Math.round(clip.durationMs * (remix.tempoBpm / Math.max(1, targetAnalysis?.bpm ?? remix.tempoBpm))) : clip.durationMs));
    const barCount = matchingSection && (matchingSection.endBeatIndex - matchingSection.startBeatIndex) % 4 === 0
      ? (matchingSection.endBeatIndex - matchingSection.startBeatIndex) / 4
      : Number.isFinite(beatMs) ? Math.round(clip.durationMs / (beatMs * 4)) : null;
    return [{
      targetClipId: clip.id,
      sourceAssetId: targetSource.id,
      sourceChecksumSha256: targetSource.checksumSha256,
      timelineStartMs: clip.timelineStartMs,
      durationMs: clip.durationMs,
      barCount: barCount && barCount > 0 ? barCount : null,
      sectionId: matchingSection?.id ?? null,
      beatAligned: closeTo(clip.timelineStartMs / beatMs, Math.round(clip.timelineStartMs / beatMs), 0.001),
      analysis: targetAnalysis ? {
        status: targetAnalysis.status,
        sourceChecksumSha256: targetAnalysis.sourceChecksumSha256,
        bpm: targetAnalysis.bpm,
        musicalKey: targetAnalysis.musicalKey,
        beatGridMs: parsedBeatGrid(targetAnalysis.beatGrid),
      } : null,
    }];
  });
  return { points: discoverMusicalMeetingPoints({ source: sourceInput, targets, remixBpm: remix.tempoBpm, targetKey: remix.targetKey }), sourceStemId: stemId, sourceSectionId: sectionId };
}

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const user = await requireUser(); const { id } = await params;
    const remix = await access(user.id, id, "viewer");
    const body = await request.json().catch(() => ({}));
    const result = await discover(remix, String(body.stemAssetId ?? ""), String(body.sourceSectionId ?? ""));
    if (!result) return NextResponse.json({ error: "This selected source region is not currently verified for meeting-point discovery." }, { status: 409 });
    return NextResponse.json({ points: result.points });
  } catch (error) { if (error instanceof Response) return error; throw error; }
}

/** Accept one re-derived recommendation as exactly one ordinary RemixClip action. */
export async function PUT(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const user = await requireUser(); const { id } = await params;
    const remix = await access(user.id, id, "editor");
    const body = await request.json().catch(() => ({}));
    const stemId = String(body.stemAssetId ?? ""); const sectionId = String(body.sourceSectionId ?? ""); const pointId = String(body.meetingPointId ?? "");
    const discovery = await discover(remix, stemId, sectionId);
    const point = discovery?.points.find((candidate) => candidate.id === pointId);
    if (!point) return NextResponse.json({ error: "That recommendation is no longer available. Find placements again." }, { status: 409 });
    
    const [stem] = await db.select().from(stemAssets).where(eq(stemAssets.id, stemId)).limit(1);
    if (!stem || stem.projectId !== remix.projectId) return NextResponse.json({ error: "Selected stem is unavailable." }, { status: 404 });
    await db.transaction(async (tx) => {
      const existing = await tx.select().from(remixTracks).where(eq(remixTracks.remixSessionId, remix.id));
      let track = existing.find((candidate) => candidate.stemAssetId === stem.id);
      if (!track) {
        const [source] = await tx.select().from(sourceAssets).where(eq(sourceAssets.id, stem.sourceAssetId)).limit(1);
        const [last] = await tx.select({ sortOrder: remixTracks.sortOrder }).from(remixTracks).where(eq(remixTracks.remixSessionId, remix.id)).orderBy(desc(remixTracks.sortOrder)).limit(1);
        [track] = await tx.insert(remixTracks).values({
          remixSessionId: remix.id, stemAssetId: stem.id,
          name: `${source?.originalFilename ?? "Source"} — ${stem.stemType}`.slice(0, 80),
          sortOrder: Math.min(99, (last?.sortOrder ?? -1) + 1), volume: stem.stemType === "vocals" ? 0.94 : 0.82, pan: 0,
        }).returning();
      }
      await tx.insert(remixClips).values({
        remixTrackId: track.id, stemAssetId: stem.id,
        timelineStartMs: point.target.timelineStartMs, durationMs: point.target.durationMs, sourceOffsetMs: point.source.startMs,
        gain: 1, fadeInMs: 0, fadeOutMs: 0,
        tempoSyncEnabled: point.tempoSyncEnabled, keySyncEnabled: point.keySyncEnabled, beatSnapEnabled: point.beatSnapEnabled,
      });
      await tx.update(remixSessions).set({ version: remix.version + 1, updatedAt: new Date() }).where(eq(remixSessions.id, remix.id));
    });
    return NextResponse.json({ accepted: point }, { status: 201 });
  } catch (error) { if (error instanceof Response) return error; console.error("meeting point acceptance failed", error); return NextResponse.json({ error: "Could not add this meeting point to the arrangement." }, { status: 500 }); }
}
