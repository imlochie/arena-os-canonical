import { isUuid } from "@workspace/arena/lib/api/ids";

import { and, desc, eq, inArray } from "drizzle-orm";
import { db } from "@workspace/db";
import {
  remixAutomationPoints,
  remixClips,
  remixSessions,
  remixTracks,
  stemAssets,
} from "@workspace/db/waveyardSchema";
import { requireUser } from "@workspace/arena/lib/waveyard/local-context";
import { requireProjectRole } from "@workspace/arena/lib/waveyard/local-context";

async function stateFor(remix: typeof remixSessions.$inferSelect) {
  
  const tracks = await db.select().from(remixTracks).where(eq(remixTracks.remixSessionId, remix.id));
  const clips = tracks.length
    ? await db.select().from(remixClips).where(inArray(remixClips.remixTrackId, tracks.map((track) => track.id)))
    : [];
  const automation = await db.select().from(remixAutomationPoints).where(eq(remixAutomationPoints.remixSessionId, remix.id));
  return {
    remix,
    tracks: tracks
      .sort((left, right) => left.sortOrder - right.sortOrder)
      .map((track) => ({ ...track, clips: clips.filter((clip) => clip.remixTrackId === track.id) })),
    automation: [...new Map(automation.map((point) => [
      `${point.remixTrackId}:${point.parameter}`,
      {
        remixTrackId: point.remixTrackId,
        parameter: point.parameter,
        points: automation.filter((candidate) => candidate.remixTrackId === point.remixTrackId && candidate.parameter === point.parameter)
          .map(({ id: pointId, timelineMs, value }) => ({ id: pointId, timelineMs, value })),
      },
    ])).values()],
  };
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const user = await requireUser();
    const { id } = await params;
    if (!isUuid(id)) return Response.json({ error: "Invalid id parameter" }, { status: 400 });
    
    const [remix] = await db.select().from(remixSessions).where(eq(remixSessions.id, id)).limit(1);
    if (!remix) return Response.json({ error: "Remix session not found." }, { status: 404 });
    await requireProjectRole(user.id, remix.projectId, "editor");
    const input = await request.json().catch(() => ({}));
    const sourceTrackId = typeof input.sourceTrackId === "string" ? input.sourceTrackId : null;
    const stemAssetId = typeof input.stemAssetId === "string" ? input.stemAssetId : null;
    const [last] = await db.select({ sortOrder: remixTracks.sortOrder }).from(remixTracks).where(eq(remixTracks.remixSessionId, remix.id)).orderBy(desc(remixTracks.sortOrder)).limit(1);
    if (!sourceTrackId && isUuid(stemAssetId)) {
      const [stem] = await db.select({ id: stemAssets.id })
        .from(stemAssets)
        .where(and(eq(stemAssets.id, stemAssetId), eq(stemAssets.projectId, remix.projectId)))
        .limit(1);
      if (!stem) return Response.json({ error: "Source stem is unavailable to this arrangement." }, { status: 404 });
      const name = typeof input.name === "string" && input.name.trim()
        ? input.name.trim().slice(0, 80)
        : "New arrangement track";
      await db.transaction(async (tx) => {
        await tx.insert(remixTracks).values({
          remixSessionId: remix.id,
          stemAssetId: stem.id,
          name,
          sortOrder: Math.min(99, (last?.sortOrder ?? -1) + 1),
          volume: 1,
          pan: 0,
          muted: false,
          solo: false,
        });
        await tx.update(remixSessions).set({ version: remix.version + 1, updatedAt: new Date() }).where(eq(remixSessions.id, remix.id));
      });
    } else {
      const [source] = await db.select().from(remixTracks).where(eq(remixTracks.id, String(sourceTrackId ?? ""))).limit(1);
      if (!source || source.remixSessionId !== remix.id)
        return Response.json({ error: "Source track not found." }, { status: 404 });
      const [stem] = await db.select({ id: stemAssets.id }).from(stemAssets).where(eq(stemAssets.id, source.stemAssetId)).limit(1);
      if (!stem) return Response.json({ error: "Source stem not found." }, { status: 409 });
      const sourceClips = await db.select().from(remixClips).where(eq(remixClips.remixTrackId, source.id));
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
            tempoSyncEnabled: clip.tempoSyncEnabled,
            keySyncEnabled: clip.keySyncEnabled,
            beatSnapEnabled: clip.beatSnapEnabled,
            chopStepIndex: null,
            chopSampleDurationMs: null,
          })));
        await tx.update(remixSessions).set({ version: remix.version + 1, updatedAt: new Date() }).where(eq(remixSessions.id, remix.id));
      });
    }
    const [updated] = await db.select().from(remixSessions).where(eq(remixSessions.id, remix.id)).limit(1);
    return Response.json(await stateFor(updated), { status: 201 });
  } catch (error) {
    if (error instanceof Response) return error;
    console.error("track duplication failed", error);
    return Response.json({ error: "Track could not be duplicated." }, { status: 500 });
  }
}
