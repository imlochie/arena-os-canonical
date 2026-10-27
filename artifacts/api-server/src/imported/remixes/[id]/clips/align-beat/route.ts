import { isUuid } from "@workspace/arena/lib/api/ids";

import { and, eq } from "drizzle-orm";
import { db } from "@workspace/db";
import {
  remixClips,
  remixSessions,
  remixTracks,
  sourceAnalyses,
  sourceAssets,
  stemAssets,
} from "@workspace/db/waveyardSchema";
import {
  alignSourceBeatToTimelineMs,
  clipTempoRatio,
  MAX_ARRANGEMENT_TIMELINE_MS,
  usableBeatGrid,
} from "@workspace/arena/lib/waveyard/types";
import { requireUser } from "@workspace/arena/lib/waveyard/local-context";
import { requireProjectRole } from "@workspace/arena/lib/waveyard/local-context";

function parsedBeatGrid(value: string | null) {
  if (!value) return null;
  try {
    return usableBeatGrid(JSON.parse(value));
  } catch {
    return null;
  }
}

/** Aligns one authoritative source beat to a chosen remix-time position. */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const user = await requireUser();
    const { id } = await params;
    if (!isUuid(id)) return Response.json({ error: "Invalid id parameter" }, { status: 400 });
    const body = await request.json().catch(() => ({}));
    const clipId = String(body.clipId ?? "");
    if (!UUID_RE.test(clipId))
      return Response.json({ error: "Clip not found." }, { status: 404 });
    const sourceBeatIndex = Number(body.sourceBeatIndex);
    const rawTarget = Number(body.timelineTargetMs);
    const timelineTargetMs = Number.isFinite(rawTarget) ? Math.round(rawTarget) : Number.NaN;
    if (!clipId || !Number.isInteger(sourceBeatIndex))
      return Response.json({ error: "A clip and source beat index are required." }, { status: 400 });
    if (!Number.isSafeInteger(timelineTargetMs) || timelineTargetMs < 0 || timelineTargetMs > MAX_ARRANGEMENT_TIMELINE_MS)
      return Response.json({ errorCode: "timeline_bounds_invalid", error: "The target remix timeline position is invalid." }, { status: 422 });

    
    const [remix] = await db.select().from(remixSessions).where(eq(remixSessions.id, id)).limit(1);
    if (!remix) return Response.json({ error: "Remix session not found." }, { status: 404 });
    await requireProjectRole(user.id, remix.projectId, "editor");
    const [clip] = await db.select().from(remixClips).where(eq(remixClips.id, clipId)).limit(1);
    if (!clip) return Response.json({ error: "Clip not found." }, { status: 404 });
    const [track] = await db.select().from(remixTracks).where(eq(remixTracks.id, clip.remixTrackId)).limit(1);
    if (!track || track.remixSessionId !== remix.id)
      return Response.json({ error: "Clip is outside this remix session." }, { status: 403 });
    const [stem] = await db.select().from(stemAssets).where(and(eq(stemAssets.id, clip.stemAssetId), eq(stemAssets.projectId, remix.projectId))).limit(1);
    if (!stem || track.stemAssetId !== stem.id)
      return Response.json({ errorCode: "cross_source_alignment_unavailable", error: "The clip stem is unavailable in this project." }, { status: 422 });
    const [[source], [analysis]] = await Promise.all([
      db.select().from(sourceAssets).where(and(eq(sourceAssets.id, stem.sourceAssetId), eq(sourceAssets.projectId, remix.projectId))).limit(1),
      db.select().from(sourceAnalyses).where(and(eq(sourceAnalyses.sourceAssetId, stem.sourceAssetId), eq(sourceAnalyses.projectId, remix.projectId))).limit(1),
    ]);
    if (!source || !analysis || analysis.status !== "complete" || analysis.sourceChecksumSha256 !== source.checksumSha256)
      return Response.json({ errorCode: "cross_source_alignment_unavailable", error: "A current complete source analysis is required to align a source beat." }, { status: 422 });
    const beatGrid = parsedBeatGrid(analysis.beatGrid);
    const sourceBeatMs = beatGrid?.[sourceBeatIndex];
    if (!beatGrid || !Number.isSafeInteger(sourceBeatMs))
      return Response.json({ errorCode: "cross_source_alignment_unavailable", error: "The requested authoritative source beat is unavailable." }, { status: 422 });
    const resolvedSourceBeatMs = sourceBeatMs as number;
    const ratio = clipTempoRatio(clip.tempoSyncEnabled, analysis.bpm, remix.tempoBpm);
    if (!ratio)
      return Response.json({ errorCode: "tempo_sync_bpm_unavailable", error: "Tempo-synced beat alignment requires a usable source BPM." }, { status: 422 });
    const sourceConsumedMs = clip.tempoSyncEnabled
      ? Math.ceil(clip.durationMs * ratio)
      : clip.durationMs;
    if (resolvedSourceBeatMs < clip.sourceOffsetMs || resolvedSourceBeatMs > clip.sourceOffsetMs + sourceConsumedMs)
      return Response.json({ errorCode: "source_beat_outside_clip", error: "Choose a source beat contained by this clip's current source window." }, { status: 422 });
    const timelineStartMs = alignSourceBeatToTimelineMs({
      sourceBeatMs: resolvedSourceBeatMs,
      sourceOffsetMs: clip.sourceOffsetMs,
      timelineTargetMs,
      sourceBpm: analysis.bpm,
      remixBpm: remix.tempoBpm,
      tempoSyncEnabled: clip.tempoSyncEnabled,
    });
    if (timelineStartMs === null || timelineStartMs + clip.durationMs > MAX_ARRANGEMENT_TIMELINE_MS)
      return Response.json({ errorCode: "timeline_bounds_invalid", error: "This beat cannot be placed at that remix timeline position without exceeding timeline bounds." }, { status: 422 });
    const [updated] = await db.transaction(async (tx) => {
      const [aligned] = await tx.update(remixClips).set({ timelineStartMs, updatedAt: new Date() }).where(eq(remixClips.id, clip.id)).returning();
      await tx.update(remixSessions).set({ version: remix.version + 1, updatedAt: new Date() }).where(eq(remixSessions.id, remix.id));
      return [aligned];
    });
    return Response.json({ clip: updated, sourceBeatIndex, sourceBeatMs: resolvedSourceBeatMs, timelineTargetMs }, { status: 200 });
  } catch (error) {
    if (error instanceof Response) return error;
    console.error("source beat alignment failed", error);
    return Response.json({ error: "Could not align the selected source beat." }, { status: 500 });
  }
}
