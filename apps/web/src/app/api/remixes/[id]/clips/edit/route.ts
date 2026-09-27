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
  MAX_CLIPS_PER_TRACK,
  clipWindowIsValid,
  moveClipTimeline,
  nearestBeat,
  slipClipSource,
  splitEditableClip,
  tempoRatioForBpm,
  trimClipLeftBy,
  trimClipRightBy,
} from "@waveyard/types";
import { requireUser } from "@/lib/auth";
import { requireProjectRole } from "@/lib/permissions";
import { barMs, beatMs, snapTimelineMs, type MusicalTiming } from "@/lib/timing";

const operations = new Set(["move", "nudge", "trim-left", "trim-right", "slip", "duplicate", "split"]);
type Operation = "move" | "nudge" | "trim-left" | "trim-right" | "slip" | "duplicate" | "split";

function asFinite(value: unknown) {
  if (value === null || value === "" || typeof value === "boolean" || typeof value === "object") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function clipValues(clip: typeof remixClips.$inferSelect) {
  return {
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
  };
}

function persistedValues(clip: ReturnType<typeof clipValues>) {
  return {
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
    updatedAt: new Date(),
  };
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const user = await requireUser();
    const { id } = await params;
    const body = await request.json().catch(() => ({}));
    const operation = String(body.operation ?? "") as Operation;
    const clipId = String(body.clipId ?? "");
    if (!operations.has(operation) || !clipId)
      return NextResponse.json({ error: "A supported edit operation and clip are required." }, { status: 400 });
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
    const sourceDurationMs = Math.round(stem.durationSeconds * 1000);
    const [analysis] = await db.select().from(sourceAnalyses).where(eq(sourceAnalyses.sourceAssetId, stem.sourceAssetId)).limit(1);
    const sourceBpm = analysis?.status === "complete" && analysis.projectId === remix.projectId ? analysis.bpm : null;
    const tempoRatio = clip.tempoSyncEnabled
      ? tempoRatioForBpm(remix.tempoBpm, sourceBpm ?? Number.NaN)
      : 1;
    if (!tempoRatio)
      return NextResponse.json({ error: "Tempo-synced editing requires usable source BPM analysis." }, { status: 422 });
    const original = { ...clipValues(clip), id: clip.id };
    if (!clipWindowIsValid(original, sourceDurationMs, tempoRatio))
      return NextResponse.json({ error: "The existing clip has an invalid source window." }, { status: 422 });
    const timing: MusicalTiming = {
      tempoBpm: remix.tempoBpm,
      timeSignatureNumerator: remix.timeSignatureNumerator,
      timeSignatureDenominator: remix.timeSignatureDenominator,
      gridDivision: remix.gridDivision as MusicalTiming["gridDivision"],
      snapEnabled: true,
    };
    const snapMode: "free" | "beat" | "bar" = body.snapMode === "beat" || body.snapMode === "bar" ? body.snapMode : "free";
    const snapTarget = (value: number) => snapMode === "free"
      ? Math.max(0, Math.round(value))
      : snapTimelineMs(value, { ...timing, gridDivision: snapMode as "beat" | "bar" });
    let next: ReturnType<typeof clipValues> | null = null;
    if (operation === "move") {
      const target = asFinite(body.timelineStartMs);
      next = target === null ? null : moveClipTimeline(original, snapTarget(target));
    } else if (operation === "nudge") {
      const direction = body.direction === -1 || body.direction === "back" ? -1 : 1;
      const amount = body.amount === "10ms" ? 10
        : body.amount === "beat" ? beatMs(timing)
          : body.amount === "bar" ? barMs(timing) : 1;
      next = moveClipTimeline(original, original.timelineStartMs + direction * Math.round(amount));
    } else if (operation === "trim-left") {
      const delta = asFinite(body.timelineDeltaMs);
      next = delta === null ? null : trimClipLeftBy(original, delta, sourceDurationMs, tempoRatio);
    } else if (operation === "trim-right") {
      const delta = asFinite(body.timelineDeltaMs);
      next = delta === null ? null : trimClipRightBy(original, delta, sourceDurationMs, tempoRatio);
    } else if (operation === "slip") {
      const offset = asFinite(body.sourceOffsetMs);
      next = offset === null ? null : slipClipSource(original, offset, sourceDurationMs, tempoRatio);
      if (next && next.beatSnapEnabled && analysis?.status === "complete") {
        const snapped = nearestBeat(next.sourceOffsetMs, (() => { try { return JSON.parse(analysis.beatGrid ?? "null"); } catch { return null; } })());
        next = snapped === null ? next : slipClipSource(next, snapped, sourceDurationMs, tempoRatio);
      }
    }
    if (operation === "duplicate") {
      const target = asFinite(body.timelineStartMs);
      const duplicate = moveClipTimeline(original, target === null ? original.timelineStartMs + original.durationMs : snapTarget(target));
      if (!duplicate || !clipWindowIsValid(duplicate, sourceDurationMs, tempoRatio))
        return NextResponse.json({ error: "Duplicate placement is outside the arrangement timeline." }, { status: 422 });
      const current = await db.select({ id: remixClips.id }).from(remixClips).where(eq(remixClips.remixTrackId, track.id));
      if (current.length >= MAX_CLIPS_PER_TRACK)
        return NextResponse.json({ error: `This track has reached the ${MAX_CLIPS_PER_TRACK}-clip limit.` }, { status: 422 });
      const created = await db.transaction(async (tx) => {
        const [inserted] = await tx.insert(remixClips).values({ remixTrackId: track.id, ...persistedValues(duplicate) }).returning();
        await tx.update(remixSessions).set({ version: remix.version + 1, updatedAt: new Date() }).where(eq(remixSessions.id, remix.id));
        return inserted;
      });
      return NextResponse.json({ operation, clip: created, version: remix.version + 1 }, { status: 201 });
    }
    if (operation === "split") {
      const current = await db.select({ id: remixClips.id }).from(remixClips).where(eq(remixClips.remixTrackId, track.id));
      if (current.length >= MAX_CLIPS_PER_TRACK)
        return NextResponse.json({ error: `This track has reached the ${MAX_CLIPS_PER_TRACK}-clip limit.` }, { status: 422 });
      const splitAt = asFinite(body.timelineMs);
      const split = splitAt === null ? null : splitEditableClip(original, splitAt, sourceDurationMs, tempoRatio);
      if (!split) return NextResponse.json({ error: "Split point must fall inside the source-bounded clip." }, { status: 422 });
      const created = await db.transaction(async (tx) => {
        const [left] = await tx.insert(remixClips).values({ remixTrackId: track.id, ...persistedValues(split.left) }).returning();
        const [right] = await tx.insert(remixClips).values({ remixTrackId: track.id, ...persistedValues(split.right) }).returning();
        await tx.delete(remixClips).where(eq(remixClips.id, clip.id));
        await tx.update(remixSessions).set({ version: remix.version + 1, updatedAt: new Date() }).where(eq(remixSessions.id, remix.id));
        return [left, right];
      });
      return NextResponse.json({ operation, replacedClipId: clip.id, clips: created, version: remix.version + 1 });
    }
    if (!next || !clipWindowIsValid(next, sourceDurationMs, tempoRatio))
      return NextResponse.json({ error: "This edit falls outside immutable source or timeline bounds." }, { status: 422 });
    const [updated] = await db.transaction(async (tx) => {
      const result = await tx.update(remixClips).set(persistedValues(next)).where(eq(remixClips.id, clip.id)).returning();
      await tx.update(remixSessions).set({ version: remix.version + 1, updatedAt: new Date() }).where(eq(remixSessions.id, remix.id));
      return result;
    });
    return NextResponse.json({ operation, clip: updated, version: remix.version + 1 });
  } catch (error) {
    if (error instanceof Response) return error;
    console.error("arrangement clip edit failed", error);
    return NextResponse.json({ error: "Could not apply the clip edit." }, { status: 500 });
  }
}
