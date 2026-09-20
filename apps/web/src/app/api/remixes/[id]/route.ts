import { NextResponse } from "next/server";
import { asc, eq, inArray } from "drizzle-orm";
import {
  getDb,
  remixClips,
  remixSessions,
  remixTracks,
  stemAssets,
} from "@waveyard/database";
import { requireUser } from "@/lib/auth";
import { requireProjectRole } from "@/lib/permissions";
import { normaliseRemixState } from "@/lib/remix";

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
  const stems = tracks.length
    ? await db
        .select({
          id: stemAssets.id,
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
    const input = normaliseRemixState(await request.json());
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
        durationSeconds: stemAssets.durationSeconds,
      })
      .from(stemAssets)
      .where(eq(stemAssets.projectId, remix.projectId));
    const durationByAssetId = new Map(
      projectStems.map((stem) => [stem.id, stem.durationSeconds * 1000]),
    );
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
            clip.sourceOffsetMs + clip.durationMs >
            durationByAssetId.get(clip.stemAssetId)!,
        ),
      )
    )
      return NextResponse.json(
        { error: "A clip extends beyond its source stem." },
        { status: 422 },
      );
    await db.transaction(async (tx) => {
      await tx
        .update(remixSessions)
        .set({
          name: input.name || remix.name,
          masterVolume: input.masterVolume,
          loopStartMs: input.loopStartMs,
          loopEndMs: input.loopEndMs,
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
