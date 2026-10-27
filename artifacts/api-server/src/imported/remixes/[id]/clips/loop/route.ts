import { isUuid } from "@workspace/arena/lib/api/ids";

import { eq } from "drizzle-orm";
import { db } from "@workspace/db";
import {
  remixClips,
  remixSessions,
  remixTracks,
  sourceAnalyses,
  stemAssets,
} from "@workspace/db/waveyardSchema";
import { createLoopClips, tempoRatioForBpm } from "@workspace/arena/lib/waveyard/types";
import { requireUser } from "@workspace/arena/lib/waveyard/local-context";
import { requireProjectRole } from "@workspace/arena/lib/waveyard/local-context";

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
    const repetitions = Number(body.repetitions);
    
    const [remix] = await db.select().from(remixSessions).where(eq(remixSessions.id, id)).limit(1);
    if (!remix) return Response.json({ error: "Remix session not found." }, { status: 404 });
    await requireProjectRole(user.id, remix.projectId, "editor");
    const [clip] = await db.select().from(remixClips).where(eq(remixClips.id, clipId)).limit(1);
    if (!clip) return Response.json({ error: "Clip not found." }, { status: 404 });
    const [track] = await db.select().from(remixTracks).where(eq(remixTracks.id, clip.remixTrackId)).limit(1);
    if (!track || track.remixSessionId !== remix.id)
      return Response.json({ error: "Clip is outside this remix session." }, { status: 403 });
    if (!clip.beatSnapEnabled)
      return Response.json({ errorCode: "beat_slice_unavailable", error: "Enable Beat Snap before looping a beat-aligned region." }, { status: 422 });
    const [stem] = await db.select().from(stemAssets).where(eq(stemAssets.id, clip.stemAssetId)).limit(1);
    if (!stem || stem.projectId !== remix.projectId)
      return Response.json({ error: "Clip source stem is unavailable." }, { status: 409 });
    let sourceConsumedMs = clip.durationMs;
    if (clip.tempoSyncEnabled) {
      const [analysis] = await db.select().from(sourceAnalyses).where(eq(sourceAnalyses.sourceAssetId, stem.sourceAssetId)).limit(1);
      const ratio = analysis?.status === "complete" && analysis.projectId === remix.projectId
        ? tempoRatioForBpm(remix.tempoBpm, analysis.bpm ?? Number.NaN)
        : null;
      if (!ratio || analysis!.bpm! < 40 || analysis!.bpm! > 300)
        return Response.json({ errorCode: "tempo_sync_bpm_unavailable", error: "Tempo-synced looping requires a usable source BPM." }, { status: 422 });
      sourceConsumedMs = Math.ceil(clip.durationMs * ratio);
    }
    if (clip.sourceOffsetMs + sourceConsumedMs > stem.durationSeconds * 1000)
      return Response.json({ error: "The selected clip exceeds its immutable source stem." }, { status: 422 });
    const current = await db.select({ id: remixClips.id }).from(remixClips).where(eq(remixClips.remixTrackId, track.id));
    if (current.length >= 256)
      return Response.json({ error: "This track has reached the 256-clip limit." }, { status: 422 });
    const maximum = Math.min(64, 256 - current.length);
    const loops = createLoopClips(clip, repetitions, maximum);
    if (!loops)
      return Response.json({ error: `Repeat count must be an integer from 1 to ${maximum}.` }, { status: 422 });
    if (loops.some((loop) => loop.timelineStartMs + loop.durationMs > 86_400_000))
      return Response.json({ error: "Loop placement exceeds the arrangement timeline limit." }, { status: 422 });
    const created = await db.transaction(async (tx) => {
      const inserted = await tx.insert(remixClips).values(loops.map((loop) => ({
        remixTrackId: track.id,
        stemAssetId: loop.stemAssetId,
        timelineStartMs: loop.timelineStartMs,
        durationMs: loop.durationMs,
        sourceOffsetMs: loop.sourceOffsetMs,
        gain: loop.gain,
        fadeInMs: loop.fadeInMs,
        fadeOutMs: loop.fadeOutMs,
        tempoSyncEnabled: loop.tempoSyncEnabled,
        keySyncEnabled: loop.keySyncEnabled,
        beatSnapEnabled: loop.beatSnapEnabled,
      }))).returning();
      await tx.update(remixSessions).set({ version: remix.version + 1, updatedAt: new Date() }).where(eq(remixSessions.id, remix.id));
      return inserted;
    });
    return Response.json({ clips: created }, { status: 201 });
  } catch (error) {
    if (error instanceof Response) return error;
    console.error("beat loop failed", error);
    return Response.json({ error: "Could not create the beat-aligned loop." }, { status: 500 });
  }
}
