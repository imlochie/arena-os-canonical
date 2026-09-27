import { NextResponse } from "next/server";
import { nearestBeat } from "@waveyard/types";
import { asc, eq, inArray } from "drizzle-orm";
import {
  getDb,
  remixAutomationPoints,
  remixClips,
  remixSessions,
  remixTracks,
  sourceAnalyses,
  stemAssets,
} from "@waveyard/database";
import { requireUser } from "@/lib/auth";
import { requireProjectRole } from "@/lib/permissions";
import { crossfadeError, normaliseRemixState } from "@/lib/remix";

function persistedBeatGrid(value: string | null) {
  if (!value) return null;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return null;
  }
}

async function getRemixAccess(
  userId: string,
  id: string,
  minimum: "viewer" | "editor",
) {
  const db = getDb();
  const [remix] = await db
    .select()
    .from(remixSessions)
    .where(eq(remixSessions.id, id))
    .limit(1);
  if (!remix) throw new Response("Remix session not found.", { status: 404 });
  await requireProjectRole(userId, remix.projectId, minimum);
  return remix;
}

async function stateFor(remix: typeof remixSessions.$inferSelect) {
  const db = getDb();
  const tracks = await db
    .select()
    .from(remixTracks)
    .where(eq(remixTracks.remixSessionId, remix.id))
    .orderBy(asc(remixTracks.sortOrder));
  const clips = tracks.length
    ? await db
        .select()
        .from(remixClips)
        .where(
          inArray(
            remixClips.remixTrackId,
            tracks.map((track) => track.id),
          ),
        )
        .orderBy(asc(remixClips.timelineStartMs))
    : [];
  const automation = await db
    .select()
    .from(remixAutomationPoints)
    .where(eq(remixAutomationPoints.remixSessionId, remix.id))
    .orderBy(asc(remixAutomationPoints.timelineMs));
  const stems = tracks.length
    ? await db
        .select({
          id: stemAssets.id,
          sourceAssetId: stemAssets.sourceAssetId,
          stemType: stemAssets.stemType,
          durationSeconds: stemAssets.durationSeconds,
          sampleRate: stemAssets.sampleRate,
          channels: stemAssets.channels,
          codec: stemAssets.codec,
          format: stemAssets.format,
          fileSizeBytes: stemAssets.fileSizeBytes,
          checksumSha256: stemAssets.checksumSha256,
        })
        .from(stemAssets)
        .where(
          inArray(
            stemAssets.id,
            tracks.map((track) => track.stemAssetId),
          ),
        )
    : [];
  return {
    remix,
    tracks: tracks.map((track) => ({
      ...track,
      clips: clips.filter((clip) => clip.remixTrackId === track.id),
    })),
    automation: [...new Map(automation.map((point) => [
      `${point.remixTrackId}:${point.parameter}`,
      {
        remixTrackId: point.remixTrackId,
        parameter: point.parameter,
        points: automation.filter((candidate) => candidate.remixTrackId === point.remixTrackId && candidate.parameter === point.parameter)
          .map(({ id: pointId, timelineMs, value }) => ({ id: pointId, timelineMs, value })),
      },
    ])).values()],
    stems,
  };
}

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const user = await requireUser();
    const { id } = await params;
    return NextResponse.json(
      await stateFor(await getRemixAccess(user.id, id, "viewer")),
    );
  } catch (error) {
    if (error instanceof Response) return error;
    throw error;
  }
}

export async function PUT(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const user = await requireUser();
    const { id } = await params;
    const remix = await getRemixAccess(user.id, id, "editor");
    let input = normaliseRemixState(await request.json());
    if (!input)
      return NextResponse.json(
        { error: "Invalid remix arrangement." },
        { status: 400 },
      );
    const db = getDb();
    const existingTracks = await db
      .select()
      .from(remixTracks)
      .where(eq(remixTracks.remixSessionId, remix.id));
    const trackById = new Map(existingTracks.map((track) => [track.id, track]));
    if (
      input.tracks.length !== existingTracks.length ||
      input.tracks.some(
        (track) =>
          !trackById.has(track.id) ||
          trackById.get(track.id)!.stemAssetId !== track.stemAssetId,
      )
    ) {
      return NextResponse.json(
        { error: "Remix tracks do not match this session." },
        { status: 409 },
      );
    }
    const projectStems = await db
      .select({
        id: stemAssets.id,
        sourceAssetId: stemAssets.sourceAssetId,
        durationSeconds: stemAssets.durationSeconds,
      })
      .from(stemAssets)
      .where(eq(stemAssets.projectId, remix.projectId));
    const durationByAssetId = new Map(
      projectStems.map((stem) => [stem.id, stem.durationSeconds * 1000]),
    );
    // Beat snapping resolves source-side metadata at the persistence boundary.
    // Unavailable analysis deliberately leaves freehand coordinates untouched.
    const sourceIds = [...new Set(projectStems.map((stem) => stem.sourceAssetId))];
    const analyses = sourceIds.length
      ? await db.select().from(sourceAnalyses).where(inArray(sourceAnalyses.sourceAssetId, sourceIds))
      : [];
    const beatGridBySourceId = new Map(analyses.map((analysis) => [analysis.sourceAssetId, analysis]));
    const sourceByStemId = new Map(projectStems.map((stem) => [stem.id, stem.sourceAssetId]));
    input = {
      ...input,
      tracks: input.tracks.map((track) => ({
        ...track,
        clips: track.clips.map((clip) => {
          if (!clip.beatSnapEnabled) return clip;
          const analysis = beatGridBySourceId.get(sourceByStemId.get(clip.stemAssetId) ?? "");
          const snappedOffset = analysis?.status === "complete"
            ? nearestBeat(clip.sourceOffsetMs, persistedBeatGrid(analysis.beatGrid))
            : null;
          return snappedOffset === null ? clip : { ...clip, sourceOffsetMs: snappedOffset };
        }),
      })),
    };
    if (
      input.tracks.some((track) =>
        track.clips.some((clip) => !durationByAssetId.has(clip.stemAssetId)),
      )
    )
      return NextResponse.json(
        { error: "A clip references an asset outside this project." },
        { status: 403 },
      );
    if (
      input.tracks.some((track) =>
        track.clips.some(
          (clip) =>
            !clip.tempoSyncEnabled && clip.sourceOffsetMs + clip.durationMs >
            durationByAssetId.get(clip.stemAssetId)!,
        ),
      )
    )
      return NextResponse.json(
        { error: "A clip extends beyond its source stem." },
        { status: 422 },
      );
    const crossfadeMessage = input.tracks.map(crossfadeError).find(Boolean);
    if (crossfadeMessage)
      return NextResponse.json({ error: crossfadeMessage }, { status: 422 });
    await db.transaction(async (tx) => {
      await tx
        .update(remixSessions)
        .set({
          name: input.name || remix.name,
          masterVolume: input.masterVolume,
          loopStartMs: input.loopStartMs,
          loopEndMs: input.loopEndMs,
          tempoBpm: input.tempoBpm,
          timeSignatureNumerator: input.timeSignatureNumerator,
          timeSignatureDenominator: input.timeSignatureDenominator,
          gridDivision: input.gridDivision,
          snapEnabled: input.snapEnabled,
          targetKey: input.targetKey,
          version: remix.version + 1,
          updatedAt: new Date(),
        })
        .where(eq(remixSessions.id, remix.id));
      for (const track of input.tracks) {
        await tx
          .update(remixTracks)
          .set({
            name: track.name,
            sortOrder: track.sortOrder,
            volume: track.volume,
            pan: track.pan,
            muted: track.muted,
            solo: track.solo,
            updatedAt: new Date(),
          })
          .where(eq(remixTracks.id, track.id));
      }
      if (input.automation !== undefined) {
        await tx.delete(remixAutomationPoints).where(eq(remixAutomationPoints.remixSessionId, remix.id));
        const points = input.automation.flatMap((lane) => lane.points.map((point) => ({
          remixSessionId: remix.id,
          remixTrackId: lane.remixTrackId,
          parameter: lane.parameter,
          timelineMs: point.timelineMs,
          value: point.value,
        })));
        if (points.length) await tx.insert(remixAutomationPoints).values(points);
      }
      await tx.delete(remixClips).where(
        inArray(
          remixClips.remixTrackId,
          existingTracks.map((track) => track.id),
        ),
      );
      const clips = input.tracks.flatMap((track) =>
        track.clips.map((clip) => ({
          remixTrackId: track.id,
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
        })),
      );
      if (clips.length) await tx.insert(remixClips).values(clips);
    });
    const [updated] = await db
      .select()
      .from(remixSessions)
      .where(eq(remixSessions.id, remix.id))
      .limit(1);
    return NextResponse.json(await stateFor(updated));
  } catch (error) {
    if (error instanceof Response) return error;
    console.error("remix save failed", error);
    return NextResponse.json(
      { error: "Remix could not be saved." },
      { status: 500 },
    );
  }
}
