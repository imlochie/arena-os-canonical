import { NextResponse } from "next/server";
import { desc, eq, inArray } from "drizzle-orm";
import {
  getDb,
  remixClips,
  remixSessions,
  remixTracks,
  stemAssets,
} from "@waveyard/database";
import { requireUser } from "@/lib/auth";
import { requireProjectRole } from "@/lib/permissions";

async function stateFor(remix: typeof remixSessions.$inferSelect) {
  const db = getDb();
  const tracks = await db.select().from(remixTracks).where(eq(remixTracks.remixSessionId, remix.id));
  const clips = tracks.length
    ? await db.select().from(remixClips).where(inArray(remixClips.remixTrackId, tracks.map((track) => track.id)))
    : [];
  return {
    remix,
    tracks: tracks
      .sort((left, right) => left.sortOrder - right.sortOrder)
      .map((track) => ({ ...track, clips: clips.filter((clip) => clip.remixTrackId === track.id) })),
  };
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const user = await requireUser();
    const { id } = await params;
    const db = getDb();
    const [remix] = await db.select().from(remixSessions).where(eq(remixSessions.id, id)).limit(1);
    if (!remix) return NextResponse.json({ error: "Remix session not found." }, { status: 404 });
    await requireProjectRole(user.id, remix.projectId, "editor");
    const { sourceTrackId } = await request.json().catch(() => ({}));
    const [source] = await db.select().from(remixTracks).where(eq(remixTracks.id, String(sourceTrackId ?? ""))).limit(1);
    if (!source || source.remixSessionId !== remix.id)
      return NextResponse.json({ error: "Source track not found." }, { status: 404 });
    const [stem] = await db.select({ id: stemAssets.id }).from(stemAssets).where(eq(stemAssets.id, source.stemAssetId)).limit(1);
    if (!stem) return NextResponse.json({ error: "Source stem not found." }, { status: 409 });
    const sourceClips = await db.select().from(remixClips).where(eq(remixClips.remixTrackId, source.id));
    const [last] = await db.select({ sortOrder: remixTracks.sortOrder }).from(remixTracks).where(eq(remixTracks.remixSessionId, remix.id)).orderBy(desc(remixTracks.sortOrder)).limit(1);
    await db.transaction(async (tx) => {
      const [track] = await tx.insert(remixTracks).values({
        remixSessionId: remix.id,
        stemAssetId: source.stemAssetId,
        name: `${source.name} copy`.slice(0, 80),
        sortOrder: Math.min(99, (last?.sortOrder ?? -1) + 1),
        volume: source.volume,
        pan: source.pan,
        muted: source.muted,
        solo: source.solo,
      }).returning();
      if (sourceClips.length)
        await tx.insert(remixClips).values(sourceClips.map((clip) => ({
          remixTrackId: track.id,
          stemAssetId: clip.stemAssetId,
          timelineStartMs: clip.timelineStartMs,
          durationMs: clip.durationMs,
          sourceOffsetMs: clip.sourceOffsetMs,
          gain: clip.gain,
          fadeInMs: clip.fadeInMs,
          fadeOutMs: clip.fadeOutMs,
        })));
      await tx.update(remixSessions).set({ version: remix.version + 1, updatedAt: new Date() }).where(eq(remixSessions.id, remix.id));
    });
    const [updated] = await db.select().from(remixSessions).where(eq(remixSessions.id, remix.id)).limit(1);
    return NextResponse.json(await stateFor(updated), { status: 201 });
  } catch (error) {
    if (error instanceof Response) return error;
    console.error("track duplication failed", error);
    return NextResponse.json({ error: "Track could not be duplicated." }, { status: 500 });
  }
}
