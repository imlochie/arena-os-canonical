import { isUuid } from "@/lib/api/ids";
import { NextResponse } from "next/server";
import { eq, inArray } from "drizzle-orm";
import {
  MAX_CLIPS_PER_TRACK,
  clipWindowIsValid,
  duplicateEditableClips,
  hasClipCapacity,
  moveEditableClips,
  tempoRatioForBpm,
} from "@/lib/waveyard/types";
import { db } from "@/db";
import {
  remixClips,
  remixSessions,
  remixTracks,
  sourceAnalyses,
  stemAssets,
} from "@/db/waveyardSchema";
import { requireUser } from "@/lib/waveyard/local-context";
import { requireProjectRole } from "@/lib/waveyard/local-context";
import { crossfadeError, type RemixClipInput } from "@/lib/waveyard/remix";
import { barMs, beatMs, type MusicalTiming } from "@/lib/waveyard/timing";

const operations = new Set(["move", "nudge", "duplicate", "delete"]);
type Operation = "move" | "nudge" | "duplicate" | "delete";

function numberInput(value: unknown) {
  if (value === null || value === "" || typeof value === "boolean" || typeof value === "object") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function editable(clip: typeof remixClips.$inferSelect) {
  return {
    id: clip.id,
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

function values(clip: Omit<ReturnType<typeof editable>, "id"> & { id?: string }) {
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

type CrossfadeAddition = { remixTrackId: string; clip: RemixClipInput };

function crossfadeMessageForCandidateTracks(
  current: Array<typeof remixClips.$inferSelect>,
  replacements = new Map<string, RemixClipInput>(),
  removedIds = new Set<string>(),
  additions: CrossfadeAddition[] = [],
) {
  const byTrackId = new Map<string, RemixClipInput[]>();
  const add = (trackId: string, clip: RemixClipInput) => {
    byTrackId.set(trackId, [...(byTrackId.get(trackId) ?? []), clip]);
  };
  for (const clip of current) {
    if (removedIds.has(clip.id)) continue;
    add(clip.remixTrackId, replacements.get(clip.id) ?? editable(clip));
  }
  for (const addition of additions) add(addition.remixTrackId, addition.clip);
  return [...byTrackId.values()]
    .map((clips) => crossfadeError({ clips }))
    .find(Boolean) ?? null;
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const user = await requireUser();
    const { id } = await params;
    if (!isUuid(id)) return NextResponse.json({ error: "Invalid id parameter" }, { status: 400 });
    const body = await request.json().catch(() => ({}));
    const operation = String(body.operation ?? "") as Operation;
    const rawClipIds: unknown[] = Array.isArray(body.clipIds) ? body.clipIds as unknown[] : [];
    const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    const clipIds = [...new Set(rawClipIds.filter((clipId): clipId is string => typeof clipId === "string" && UUID_RE.test(clipId)))];
    if (!operations.has(operation) || !clipIds.length)
      return NextResponse.json({ error: "A supported group operation and one or more clips are required." }, { status: 400 });
    
    const [remix] = await db.select().from(remixSessions).where(eq(remixSessions.id, id)).limit(1);
    if (!remix) return NextResponse.json({ error: "Remix session not found." }, { status: 404 });
    await requireProjectRole(user.id, remix.projectId, "editor");
    const selectedRows = await db.select().from(remixClips).where(inArray(remixClips.id, clipIds));
    if (selectedRows.length !== clipIds.length)
      return NextResponse.json({ error: "One or more selected clips do not exist." }, { status: 404 });
    // Preserve the browser's selection order for deterministic UI reconciliation.
    const selectedById = new Map(selectedRows.map((clip) => [clip.id, clip]));
    const selected = clipIds.map((clipId) => selectedById.get(clipId)!);
    const trackIds = [...new Set(selected.map((clip) => clip.remixTrackId))];
    const tracks = await db.select().from(remixTracks).where(inArray(remixTracks.id, trackIds));
    if (tracks.length !== trackIds.length || tracks.some((track) => track.remixSessionId !== remix.id))
      return NextResponse.json({ error: "One or more clips are outside this remix session." }, { status: 403 });
    const stems = await db.select().from(stemAssets).where(inArray(stemAssets.id, [...new Set(selected.map((clip) => clip.stemAssetId))]));
    if (stems.length !== new Set(selected.map((clip) => clip.stemAssetId)).size || stems.some((stem) => stem.projectId !== remix.projectId))
      return NextResponse.json({ error: "A selected clip references a source outside this project." }, { status: 403 });
    const analyses = stems.length
      ? await db.select().from(sourceAnalyses).where(inArray(sourceAnalyses.sourceAssetId, [...new Set(stems.map((stem) => stem.sourceAssetId))]))
      : [];
    const stemById = new Map(stems.map((stem) => [stem.id, stem]));
    const analysisBySourceId = new Map(analyses.map((analysis) => [analysis.sourceAssetId, analysis]));
    for (const clip of selected) {
      const stem = stemById.get(clip.stemAssetId)!;
      const analysis = analysisBySourceId.get(stem.sourceAssetId);
      const ratio = clip.tempoSyncEnabled
        ? tempoRatioForBpm(remix.tempoBpm, analysis?.status === "complete" && analysis.projectId === remix.projectId ? analysis.bpm ?? Number.NaN : Number.NaN)
        : 1;
      if (!ratio || !clipWindowIsValid(editable(clip), Math.round(stem.durationSeconds * 1000), ratio))
        return NextResponse.json({ error: "A selected clip has an invalid immutable source window." }, { status: 422 });
    }
    const timing: MusicalTiming = {
      tempoBpm: remix.tempoBpm,
      timeSignatureNumerator: remix.timeSignatureNumerator,
      timeSignatureDenominator: remix.timeSignatureDenominator,
      gridDivision: remix.gridDivision as MusicalTiming["gridDivision"],
      snapEnabled: remix.snapEnabled,
    };
    const allOnTracks = await db
      .select()
      .from(remixClips)
      .where(inArray(remixClips.remixTrackId, trackIds));
    let updated: ReturnType<typeof editable>[] = [];
    let created: ReturnType<typeof editable>[] = [];
    if (operation === "move" || operation === "nudge") {
      const delta = operation === "move"
        ? numberInput(body.timelineDeltaMs)
        : (() => {
            const direction = body.direction === -1 || body.direction === "back" ? -1 : 1;
            const amount = body.amount === "10ms" ? 10
              : body.amount === "beat" ? beatMs(timing)
                : body.amount === "bar" ? barMs(timing) : 1;
            return direction * Math.round(amount);
          })();
      const moved = delta === null ? null : moveEditableClips(selected.map(editable), delta);
      if (!moved)
        return NextResponse.json({ error: "This group move would exceed the arrangement timeline." }, { status: 422 });
      const crossfadeMessage = crossfadeMessageForCandidateTracks(
        allOnTracks,
        new Map(moved.map((clip) => [clip.id!, clip])),
      );
      if (crossfadeMessage)
        return NextResponse.json({ error: crossfadeMessage }, { status: 422 });
      updated = await db.transaction(async (tx) => {
        const result = await Promise.all(moved.map(async (clip) => {
          const [row] = await tx.update(remixClips).set(values(clip)).where(eq(remixClips.id, clip.id!)).returning();
          return row;
        }));
        await tx.update(remixSessions).set({ version: remix.version + 1, updatedAt: new Date() }).where(eq(remixSessions.id, remix.id));
        return result.map(editable);
      });
    } else if (operation === "duplicate") {
      const offset = body.timelineOffsetMs === undefined ? undefined : numberInput(body.timelineOffsetMs);
      if (body.timelineOffsetMs !== undefined && offset === null)
        return NextResponse.json({ error: "Duplicate offset must be finite." }, { status: 400 });
      const duplicates = duplicateEditableClips(selected.map(editable), offset ?? undefined);
      if (!duplicates)
        return NextResponse.json({ error: "Duplicate placement would exceed the arrangement timeline." }, { status: 422 });
      const selectedPerTrack = new Map<string, number>();
      for (const clip of selected) selectedPerTrack.set(clip.remixTrackId, (selectedPerTrack.get(clip.remixTrackId) ?? 0) + 1);
      if ([...selectedPerTrack].some(([trackId, additions]) => !hasClipCapacity(allOnTracks.filter((clip) => clip.remixTrackId === trackId).length, additions, MAX_CLIPS_PER_TRACK)))
        return NextResponse.json({ error: `A selected track would exceed the ${MAX_CLIPS_PER_TRACK}-clip limit.` }, { status: 422 });
      const crossfadeMessage = crossfadeMessageForCandidateTracks(
        allOnTracks,
        undefined,
        undefined,
        duplicates.map((clip, index) => ({
          remixTrackId: selected[index].remixTrackId,
          clip,
        })),
      );
      if (crossfadeMessage)
        return NextResponse.json({ error: crossfadeMessage }, { status: 422 });
      created = await db.transaction(async (tx) => {
        const rows = await Promise.all(duplicates.map(async (clip, index) => {
          const [row] = await tx.insert(remixClips).values({ remixTrackId: selected[index].remixTrackId, ...values(clip) }).returning();
          return row;
        }));
        await tx.update(remixSessions).set({ version: remix.version + 1, updatedAt: new Date() }).where(eq(remixSessions.id, remix.id));
        return rows.map(editable);
      });
    } else {
      const crossfadeMessage = crossfadeMessageForCandidateTracks(
        allOnTracks,
        undefined,
        new Set(clipIds),
      );
      if (crossfadeMessage)
        return NextResponse.json({ error: crossfadeMessage }, { status: 422 });
      await db.transaction(async (tx) => {
        await tx.delete(remixClips).where(inArray(remixClips.id, clipIds));
        await tx.update(remixSessions).set({ version: remix.version + 1, updatedAt: new Date() }).where(eq(remixSessions.id, remix.id));
      });
    }
    return NextResponse.json({ operation, clips: operation === "duplicate" ? created : updated, removedClipIds: operation === "delete" ? clipIds : [] });
  } catch (error) {
    if (error instanceof Response) return error;
    console.error("arrangement group edit failed", error);
    return NextResponse.json({ error: "Could not apply the group clip edit." }, { status: 500 });
  }
}
