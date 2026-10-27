import { isUuid } from "@/lib/api/ids";
import { NextResponse } from "next/server";
import { desc, eq, inArray } from "drizzle-orm";
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
} from "@/db/waveyardSchema";
import { MULTI_SOURCE_PLACEMENT_MODES, proposeMultiSourcePlacement, type MultiSourcePlacementMode } from "@/lib/waveyard/types";
import { requireUser } from "@/lib/waveyard/local-context";
import { requireProjectRole } from "@/lib/waveyard/local-context";

function parsedBeatGrid(value: string | null) { if (!value) return null; try { return JSON.parse(value); } catch { return null; } }
function closeToBeat(valueMs: number, beatMs: number) { return Math.abs(valueMs / beatMs - Math.round(valueMs / beatMs)) <= 0.001; }
function closeToBar(valueMs: number, beatMs: number, beatsPerBar = 4) { return Math.abs(valueMs / (beatMs * beatsPerBar) - Math.round(valueMs / (beatMs * beatsPerBar))) <= 0.001; }
function modeFrom(value: unknown): MultiSourcePlacementMode | null { return MULTI_SOURCE_PLACEMENT_MODES.includes(value as MultiSourcePlacementMode) ? value as MultiSourcePlacementMode : null; }

async function access(userId: string, remixId: string, minimum: "viewer" | "editor") {
  const [remix] = await db.select().from(remixSessions).where(eq(remixSessions.id, remixId)).limit(1);
  if (!remix) throw new Response("Remix session not found.", { status: 404 });
  await requireProjectRole(userId, remix.projectId, minimum); return remix;
}

async function proposalFor(remix: typeof remixSessions.$inferSelect, anchorClipId: string, stemId: string, sectionId: string, mode: MultiSourcePlacementMode) {
  
  const [tracks, stems, sources, analyses, sectionAnalyses, sections] = await Promise.all([
    db.select().from(remixTracks).where(eq(remixTracks.remixSessionId, remix.id)),
    db.select().from(stemAssets).where(eq(stemAssets.projectId, remix.projectId)),
    db.select().from(sourceAssets).where(eq(sourceAssets.projectId, remix.projectId)),
    db.select().from(sourceAnalyses).where(eq(sourceAnalyses.projectId, remix.projectId)),
    db.select().from(sourceSectionAnalyses).where(eq(sourceSectionAnalyses.projectId, remix.projectId)),
    db.select().from(sourceSections).where(eq(sourceSections.projectId, remix.projectId)),
  ]);
  const clips = tracks.length ? await db.select().from(remixClips).where(inArray(remixClips.remixTrackId, tracks.map((track) => track.id))) : [];
  const anchor = clips.find((clip) => clip.id === anchorClipId);
  const stem = stems.find((candidate) => candidate.id === stemId);
  if (!anchor || !stem || stem.projectId !== remix.projectId) return null;
  const source = sources.find((candidate) => candidate.id === stem.sourceAssetId);
  const analysis = source ? analyses.filter((candidate) => candidate.sourceAssetId === source.id).at(-1) : null;
  const sectionAnalysis = source ? sectionAnalyses.find((candidate) => candidate.sourceAssetId === source.id) : null;
  const section = source && analysis && sectionAnalysis ? sections.find((candidate) => candidate.id === sectionId && candidate.sourceAssetId === source.id
    && candidate.sourceAnalysisId === analysis.id && candidate.sourceSectionAnalysisId === sectionAnalysis.id && candidate.sourceChecksumSha256 === source.checksumSha256) : null;
  if (!source || !analysis || analysis.status !== "complete" || analysis.sourceChecksumSha256 !== source.checksumSha256
    || !sectionAnalysis || sectionAnalysis.status !== "complete" || sectionAnalysis.sourceAnalysisId !== analysis.id || sectionAnalysis.sourceChecksumSha256 !== source.checksumSha256 || !section) return null;
  const beatMs = 60_000 / remix.tempoBpm;
  return proposeMultiSourcePlacement({
    source: { sourceAssetId: source.id, stemAssetId: stem.id, sourceChecksumSha256: source.checksumSha256, startMs: section.startMs, endMs: section.endMs, analysis: { status: analysis.status, sourceChecksumSha256: analysis.sourceChecksumSha256, bpm: analysis.bpm, musicalKey: analysis.musicalKey, beatGridMs: parsedBeatGrid(analysis.beatGrid) } },
    anchor: { clipId: anchor.id, timelineStartMs: anchor.timelineStartMs, durationMs: anchor.durationMs, beatAlignedEnd: closeToBeat(anchor.timelineStartMs + anchor.durationMs, beatMs), barAlignedEnd: closeToBar(anchor.timelineStartMs + anchor.durationMs, beatMs, remix.timeSignatureNumerator) },
    mode, remixBpm: remix.tempoBpm, targetKey: remix.targetKey,
  });
}

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const user = await requireUser(); const { id } = await params; const remix = await access(user.id, id, "viewer");
    if (!isUuid(id)) return NextResponse.json({ error: "Invalid id parameter" }, { status: 400 });
    const body = await request.json().catch(() => ({})); const mode = modeFrom(body.mode);
    if (!mode) return NextResponse.json({ error: "Choose an overlay or handoff mode." }, { status: 400 });
    const proposal = await proposalFor(remix, String(body.anchorClipId ?? ""), String(body.stemAssetId ?? ""), String(body.sourceSectionId ?? ""), mode);
    if (!proposal) return NextResponse.json({ error: "Choose a verified source section and an existing arrangement clip." }, { status: 409 });
    return NextResponse.json({ proposal });
  } catch (error) { if (error instanceof Response) return error; throw error; }
}

/** Applies one user-selected placement as ordinary tracks/clips and fade fields. */
export async function PUT(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const user = await requireUser(); const { id } = await params; const remix = await access(user.id, id, "editor");
    if (!isUuid(id)) return NextResponse.json({ error: "Invalid id parameter" }, { status: 400 });
    const body = await request.json().catch(() => ({})); const mode = modeFrom(body.mode);
    if (!mode) return NextResponse.json({ error: "Choose an overlay or handoff mode." }, { status: 400 });
    const anchorClipId = String(body.anchorClipId ?? ""); const stemId = String(body.stemAssetId ?? ""); const sectionId = String(body.sourceSectionId ?? "");
    const proposal = await proposalFor(remix, anchorClipId, stemId, sectionId, mode);
    if (!proposal || proposal.id !== String(body.proposalId ?? "")) return NextResponse.json({ error: "This placement is stale. Propose it again before adding." }, { status: 409 });
    
    await db.transaction(async (tx) => {
      const tracks = await tx.select().from(remixTracks).where(eq(remixTracks.remixSessionId, remix.id));
      const clips = tracks.length ? await tx.select().from(remixClips).where(inArray(remixClips.remixTrackId, tracks.map((track) => track.id))) : [];
      const anchor = clips.find((clip) => clip.id === anchorClipId);
      const [stem] = await tx.select().from(stemAssets).where(eq(stemAssets.id, stemId)).limit(1);
      if (!anchor || !stem || stem.projectId !== remix.projectId) throw new Response("Placement source is no longer available.", { status: 409 });
      let track = tracks.find((candidate) => candidate.stemAssetId === stem.id);
      if (!track) {
        const [source] = await tx.select().from(sourceAssets).where(eq(sourceAssets.id, stem.sourceAssetId)).limit(1);
        const [last] = await tx.select({ sortOrder: remixTracks.sortOrder }).from(remixTracks).where(eq(remixTracks.remixSessionId, remix.id)).orderBy(desc(remixTracks.sortOrder)).limit(1);
        [track] = await tx.insert(remixTracks).values({ remixSessionId: remix.id, stemAssetId: stem.id, name: `${source?.originalFilename ?? "Source"} — ${stem.stemType}`.slice(0, 80), sortOrder: Math.min(99, (last?.sortOrder ?? -1) + 1), volume: stem.stemType === "vocals" ? 0.94 : 0.82, pan: 0 }).returning();
      }
      if (proposal.mode === "crossfade") await tx.update(remixClips).set({ fadeOutMs: proposal.fadeOutMs, updatedAt: new Date() }).where(eq(remixClips.id, anchor.id));
      await tx.insert(remixClips).values({ remixTrackId: track.id, stemAssetId: stem.id, timelineStartMs: proposal.timelineStartMs, durationMs: proposal.durationMs, sourceOffsetMs: proposal.source.startMs, gain: 1, fadeInMs: proposal.fadeInMs, fadeOutMs: 0, tempoSyncEnabled: proposal.tempoSyncEnabled, keySyncEnabled: proposal.keySyncEnabled, beatSnapEnabled: proposal.beatSnapEnabled });
      await tx.update(remixSessions).set({ version: remix.version + 1, updatedAt: new Date() }).where(eq(remixSessions.id, remix.id));
    });
    return NextResponse.json({ proposal }, { status: 201 });
  } catch (error) { if (error instanceof Response) return error; console.error("multi-source placement failed", error); return NextResponse.json({ error: "Could not add this source placement." }, { status: 500 }); }
}
