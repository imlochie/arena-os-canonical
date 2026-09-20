import { NextResponse } from "next/server";
import { eq, inArray } from "drizzle-orm";
import {
  getDb,
  remixClips,
  remixSessions,
  remixTracks,
  remixVersions,
  stemAssets,
} from "@waveyard/database";
import { requireUser } from "@/lib/auth";
import { requireProjectRole } from "@/lib/permissions";
import { normaliseRemixState } from "@/lib/remix";

export async function POST(
  _request: Request,
  { params }: { params: Promise<{ id: string; versionId: string }> },
) {
  try {
    const user = await requireUser();
    const { id, versionId } = await params;
    const db = getDb();
    const [remix] = await db
      .select()
      .from(remixSessions)
      .where(eq(remixSessions.id, id))
      .limit(1);
    if (!remix)
      return NextResponse.json(
        { error: "Remix session not found." },
        { status: 404 },
      );
    await requireProjectRole(user.id, remix.projectId, "editor");
    const [version] = await db
      .select()
      .from(remixVersions)
      .where(eq(remixVersions.id, versionId))
      .limit(1);
    if (!version || version.remixSessionId !== remix.id)
      return NextResponse.json(
        { error: "Remix version not found." },
        { status: 404 },
      );
    const state = normaliseRemixState(JSON.parse(version.snapshot));
    if (!state)
      return NextResponse.json(
        { error: "Stored remix version is invalid." },
        { status: 422 },
      );
    const tracks = await db
      .select()
      .from(remixTracks)
      .where(eq(remixTracks.remixSessionId, remix.id));
    const byId = new Map(tracks.map((track) => [track.id, track]));
    if (
      state.tracks.length !== tracks.length ||
      state.tracks.some(
        (track) =>
          !byId.has(track.id) ||
          byId.get(track.id)!.stemAssetId !== track.stemAssetId,
      )
    )
      return NextResponse.json(
        {
          error: "This version is incompatible with the current remix tracks.",
        },
        { status: 409 },
      );
    const projectStems = await db
      .select({
        id: stemAssets.id,
        durationSeconds: stemAssets.durationSeconds,
      })
      .from(stemAssets)
      .where(eq(stemAssets.projectId, remix.projectId));
    const durationByAssetId = new Map(
      projectStems.map((asset) => [asset.id, asset.durationSeconds * 1000]),
    );
    if (
      state.tracks.some((track) =>
        track.clips.some((clip) => !durationByAssetId.has(clip.stemAssetId)),
      )
    )
      return NextResponse.json(
        { error: "This version references a removed asset." },
        { status: 409 },
      );
    if (
      state.tracks.some((track) =>
        track.clips.some(
          (clip) =>
            clip.sourceOffsetMs + clip.durationMs >
            durationByAssetId.get(clip.stemAssetId)!,
        ),
      )
    )
      return NextResponse.json(
        { error: "This version extends beyond its source stem." },
        { status: 422 },
      );
    await db.transaction(async (tx) => {
      await tx
        .update(remixSessions)
        .set({
          name: state.name || remix.name,
          masterVolume: state.masterVolume,
          loopStartMs: state.loopStartMs,
          loopEndMs: state.loopEndMs,
          version: remix.version + 1,
          updatedAt: new Date(),
        })
        .where(eq(remixSessions.id, remix.id));
      for (const track of state.tracks)
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
      await tx.delete(remixClips).where(
        inArray(
          remixClips.remixTrackId,
          tracks.map((track) => track.id),
        ),
      );
      const clips = state.tracks.flatMap((track) =>
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
    return NextResponse.json({ ok: true });
  } catch (error) {
    if (error instanceof Response) return error;
    console.error("remix restore failed", error);
    return NextResponse.json(
      { error: "Could not restore this remix version." },
      { status: 500 },
    );
  }
}
