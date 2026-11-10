import { isUuid } from "@workspace/arena/lib/api/ids";

import { nearestBeat } from "@workspace/arena/lib/waveyard/types";
import { and, asc, eq, inArray } from "drizzle-orm";
import type { AutomaticRemixCompatibilityReport } from "@workspace/arena/lib/waveyard/types/automatic-remix";
import { db } from "@workspace/db";
import {
  automaticRemixGenerations,
  remixAutomationPoints,
  remixClips,
  remixSessions,
  remixTracks,
  sourceAnalyses,
  stemAssets,
} from "@workspace/db/waveyardSchema";
import { requireUser } from "@workspace/arena/lib/waveyard/local-context";
import { requireProjectRole } from "@workspace/arena/lib/waveyard/local-context";
import { crossfadeError, normaliseRemixState } from "@workspace/arena/lib/waveyard/remix";

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
  
  const [remix] = await db
    .select()
    .from(remixSessions)
    .where(eq(remixSessions.id, id))
    .limit(1);
  if (!remix) throw new Response("Remix session not found.", { status: 404 });
  await requireProjectRole(userId, remix.projectId, minimum);
  const [linkedProjectRows, linkedClipProjectRows] = await Promise.all([
    db
      .select({ projectId: stemAssets.projectId })
      .from(remixTracks)
      .innerJoin(stemAssets, eq(remixTracks.stemAssetId, stemAssets.id))
      .where(eq(remixTracks.remixSessionId, remix.id)),
    db
      .select({ projectId: stemAssets.projectId })
      .from(remixClips)
      .innerJoin(remixTracks, eq(remixClips.remixTrackId, remixTracks.id))
      .innerJoin(stemAssets, eq(remixClips.stemAssetId, stemAssets.id))
      .where(eq(remixTracks.remixSessionId, remix.id)),
  ]);
  const linkedProjectIds = [...new Set([...linkedProjectRows, ...linkedClipProjectRows]
    .map((row) => row.projectId)
    .filter((projectId) => projectId !== remix.projectId))];
  await Promise.all(linkedProjectIds.map((projectId) =>
    requireProjectRole(userId, projectId, "viewer"),
  ));
  return remix;
}

async function stateFor(remix: typeof remixSessions.$inferSelect) {
  
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
  const [generation] = await db
    .select()
    .from(automaticRemixGenerations)
    .where(eq(automaticRemixGenerations.remixSessionId, remix.id))
    .limit(1);
  const referencedStemIds = [...new Set([
    ...tracks.map((track) => track.stemAssetId),
    ...clips.map((clip) => clip.stemAssetId),
  ])];
  const stems = referencedStemIds.length
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
            referencedStemIds,
          ),
        )
    : [];
  return {
    remix,
    tracks: tracks.map((track) => ({
      ...track,
      inserts: parseStoredInserts(track.inserts),
      clips: clips.filter((clip) => clip.remixTrackId === track.id),
    })),
    generation: generation ? {
      engine: generation.engine,
      engineVersion: generation.engineVersion,
      variant: generation.variant,
      createdAt: generation.createdAt,
      ...(parseStoredCompatibility(generation.provenance) ? { compatibility: parseStoredCompatibility(generation.provenance) } : {}),
    } : null,
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
    if (!isUuid(id)) return Response.json({ error: "Invalid id parameter" }, { status: 400 });
    return Response.json(
      await stateFor(await getRemixAccess(user.id, id, "viewer")),
    );
  } catch (error) {
    if (error instanceof Response) return error;
    throw error;
  }
}

/** Stored insert-chain JSON → parsed chain; corrupt data degrades to empty, never 500s a GET. */
function parseStoredInserts(raw: string | null | undefined): unknown[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function parseStoredCompatibility(raw: string | null | undefined): AutomaticRemixCompatibilityReport | undefined {
  if (!raw) return undefined;
  try {
    const provenance = JSON.parse(raw) as { passageCompatibility?: unknown };
    const report = provenance.passageCompatibility;
    if (!report || typeof report !== "object" || Array.isArray(report)) return undefined;
    const value = report as Partial<AutomaticRemixCompatibilityReport>;
    if (!Number.isSafeInteger(value.evaluatedPairs) || !Number.isSafeInteger(value.eligiblePairs)
      || !Array.isArray(value.pairs) || !Array.isArray(value.missingEvidence) || typeof value.note !== "string") return undefined;
    return value as AutomaticRemixCompatibilityReport;
  } catch {
    return undefined;
  }
}

export async function PUT(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const user = await requireUser();
    const { id } = await params;
    if (!isUuid(id)) return Response.json({ error: "Invalid id parameter" }, { status: 400 });
    const remix = await getRemixAccess(user.id, id, "editor");
    const rawInput = await request.json().catch(() => null);
    const expectedVersion = rawInput && typeof rawInput === "object"
      ? (rawInput as { expectedVersion?: unknown }).expectedVersion
      : undefined;
    if (!Number.isInteger(expectedVersion) || (expectedVersion as number) < 1) {
      return Response.json(
        { error: "A valid arrangement version is required.", code: "REMIX_VERSION_REQUIRED" },
        { status: 400 },
      );
    }
    let input = normaliseRemixState(rawInput);
    if (!input)
      return Response.json(
        { error: "Invalid remix arrangement." },
        { status: 400 },
      );
    
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
      return Response.json(
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
    const referencedStemIds = [...new Set([
      ...existingTracks.map((track) => track.stemAssetId),
      ...input.tracks.flatMap((track) => track.clips.map((clip) => clip.stemAssetId)),
    ])];
    const linkedStemRows = referencedStemIds.length
      ? await db.select({
          id: stemAssets.id,
          sourceAssetId: stemAssets.sourceAssetId,
          durationSeconds: stemAssets.durationSeconds,
          projectId: stemAssets.projectId,
      }).from(stemAssets).where(inArray(stemAssets.id, referencedStemIds))
      : [];
    const linkedProjectIds = [...new Set(linkedStemRows
      .map((stem) => stem.projectId)
      .filter((projectId) => projectId !== remix.projectId))];
    await Promise.all(linkedProjectIds.map((projectId) =>
      requireProjectRole(user.id, projectId, "viewer"),
    ));
    const allowedStems = [...new Map(
      [...projectStems, ...linkedStemRows].map((stem) => [stem.id, stem]),
    ).values()];
    const durationByAssetId = new Map(
      allowedStems.map((stem) => [stem.id, stem.durationSeconds * 1000]),
    );
    // Beat snapping resolves source-side metadata at the persistence boundary.
    // Unavailable analysis deliberately leaves freehand coordinates untouched.
    const sourceIds = [...new Set(allowedStems.map((stem) => stem.sourceAssetId))];
    const analyses = sourceIds.length
      ? await db.select().from(sourceAnalyses).where(inArray(sourceAnalyses.sourceAssetId, sourceIds))
      : [];
    const beatGridBySourceId = new Map(analyses.map((analysis) => [analysis.sourceAssetId, analysis]));
    const sourceByStemId = new Map(allowedStems.map((stem) => [stem.id, stem.sourceAssetId]));
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
      return Response.json(
        { error: "A clip references audio unavailable to this arrangement." },
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
      return Response.json(
        { error: "A clip extends beyond its source stem." },
        { status: 422 },
      );
    const crossfadeMessage = input.tracks.map(crossfadeError).find(Boolean);
    if (crossfadeMessage)
      return Response.json({ error: crossfadeMessage }, { status: 422 });
    await db.transaction(async (tx) => {
      const [claimedVersion] = await tx
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
          ...(input.masterInserts !== undefined
            ? { masterInserts: JSON.stringify(input.masterInserts) }
            : {}),
          version: (expectedVersion as number) + 1,
          updatedAt: new Date(),
        })
        .where(and(
          eq(remixSessions.id, remix.id),
          eq(remixSessions.version, expectedVersion as number),
        ))
        .returning({ id: remixSessions.id });
      if (!claimedVersion) {
        throw Response.json({
          error: "Another Studio edit was saved first. Your arrangement was not changed.",
          code: "REMIX_VERSION_CONFLICT",
        }, { status: 409 });
      }
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
            ...(track.inserts !== undefined
              ? { inserts: JSON.stringify(track.inserts) }
              : {}),
            ...(track.phaseInverted !== undefined
              ? { phaseInverted: track.phaseInverted }
              : {}),
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
    return Response.json(await stateFor(updated));
  } catch (error) {
    if (error instanceof Response) return error;
    console.error("remix save failed", error);
    return Response.json(
      { error: "Remix could not be saved." },
      { status: 500 },
    );
  }
}
