import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import {
  getDb,
  remixClips,
  remixSessions,
  remixTracks,
  sourceAnalyses,
  stemAssets,
} from "@waveyard/database";
import {
  sliceClipToBeatRange,
  tempoRatioForBpm,
} from "@waveyard/types";
import { requireUser } from "@/lib/auth";
import { requireProjectRole } from "@/lib/permissions";

function parsedBeatGrid(value: string | null) {
  if (!value) return null;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return null;
  }
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const user = await requireUser();
    const { id } = await params;
    const body = await request.json().catch(() => ({}));
    const clipId = String(body.clipId ?? "");
    const startBeatIndex = Number(body.startBeatIndex);
    const endBeatIndex = Number(body.endBeatIndex);
    const db = getDb();
    const [remix] = await db.select().from(remixSessions).where(eq(remixSessions.id, id)).limit(1);
    if (!remix) return NextResponse.json({ error: "Remix session not found." }, { status: 404 });
    await requireProjectRole(user.id, remix.projectId, "editor");
    const [clip] = await db.select().from(remixClips).where(eq(remixClips.id, clipId)).limit(1);
    if (!clip) return NextResponse.json({ error: "Clip not found." }, { status: 404 });
    const [track] = await db.select().from(remixTracks).where(eq(remixTracks.id, clip.remixTrackId)).limit(1);
    if (!track || track.remixSessionId !== remix.id)
      return NextResponse.json({ error: "Clip is outside this remix session." }, { status: 403 });
    const [stem] = await db.select().from(stemAssets).where(eq(stemAssets.id, clip.stemAssetId)).limit(1);
    if (!stem || stem.projectId !== remix.projectId)
      return NextResponse.json({ error: "Clip source stem is unavailable." }, { status: 409 });
    const [analysis] = await db
      .select()
      .from(sourceAnalyses)
      .where(eq(sourceAnalyses.sourceAssetId, stem.sourceAssetId))
      .limit(1);
    if (!analysis || analysis.projectId !== remix.projectId || analysis.status !== "complete")
      return NextResponse.json({ errorCode: "beat_grid_unavailable", error: "Beat slicing requires complete source beat analysis." }, { status: 422 });
    let ratio = 1;
    if (clip.tempoSyncEnabled) {
      ratio = tempoRatioForBpm(remix.tempoBpm, analysis.bpm ?? Number.NaN) ?? 0;
      if (!ratio || analysis.bpm! < 40 || analysis.bpm! > 300)
        return NextResponse.json({ errorCode: "tempo_sync_bpm_unavailable", error: "Tempo-synced slicing requires a usable source BPM." }, { status: 422 });
    }
    const result = sliceClipToBeatRange(
      clip,
      parsedBeatGrid(analysis.beatGrid),
      startBeatIndex,
      endBeatIndex,
      Math.round(stem.durationSeconds * 1000),
      ratio,
    );
    if (!result.ok)
      return NextResponse.json({ errorCode: result.reason, error: "The requested beat range is unavailable or invalid." }, { status: 422 });
    const count = await db.select({ id: remixClips.id }).from(remixClips).where(eq(remixClips.remixTrackId, track.id));
    if (count.length >= 256)
      return NextResponse.json({ error: "This track has reached the 256-clip limit." }, { status: 422 });
    const [created] = await db.transaction(async (tx) => {
      const [inserted] = await tx.insert(remixClips).values({
        remixTrackId: track.id,
        stemAssetId: result.clip.stemAssetId,
        timelineStartMs: result.clip.timelineStartMs,
        durationMs: result.clip.durationMs,
        sourceOffsetMs: result.clip.sourceOffsetMs,
        gain: result.clip.gain,
        fadeInMs: result.clip.fadeInMs,
        fadeOutMs: result.clip.fadeOutMs,
        tempoSyncEnabled: result.clip.tempoSyncEnabled,
        keySyncEnabled: result.clip.keySyncEnabled,
        beatSnapEnabled: result.clip.beatSnapEnabled,
      }).returning();
      await tx.update(remixSessions).set({ version: remix.version + 1, updatedAt: new Date() }).where(eq(remixSessions.id, remix.id));
      return [inserted];
    });
    return NextResponse.json({ clip: created }, { status: 201 });
  } catch (error) {
    if (error instanceof Response) return error;
    console.error("beat slice failed", error);
    return NextResponse.json({ error: "Could not create the beat-aligned slice." }, { status: 500 });
  }
}
