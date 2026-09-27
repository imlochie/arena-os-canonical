import { NextResponse } from "next/server";
import { and, eq } from "drizzle-orm";
import {
  getDb,
  remixClips,
  remixSessions,
  remixTracks,
  sourceAnalyses,
  sourceAssets,
  sourceSectionAnalyses,
  sourceSections,
  stemAssets,
} from "@waveyard/database";
import {
  createSectionArrangementClips,
  sectionActionProvenanceReason,
  tempoRatioForBpm,
  usableBeatGrid,
  type MusicalClipInput,
  type SectionArrangementAction,
} from "@waveyard/types";
import { requireUser } from "@/lib/auth";
import { requireProjectRole } from "@/lib/permissions";

function parsedBeatGrid(value: string | null) {
  if (!value) return null;
  try {
    return usableBeatGrid(JSON.parse(value));
  } catch {
    return null;
  }
}

function actionFrom(value: unknown): SectionArrangementAction | null {
  return value === "add" || value === "insert" || value === "loop" ? value : null;
}

/**
 * Turns current source-section metadata into ordinary, persisted RemixClips.
 * The section is only an authenticated source-coordinate input; export later
 * sees the same immutable RemixVersion clip snapshot as every other action.
 */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const user = await requireUser();
    const { id } = await params;
    const body = await request.json().catch(() => ({}));
    const sectionId = String(body.sectionId ?? "");
    const stemAssetId = String(body.stemAssetId ?? "");
    const remixTrackId = String(body.remixTrackId ?? "");
    const contextClipId = body.contextClipId ? String(body.contextClipId) : null;
    const action = actionFrom(body.action);
    const position = Number(body.timelineStartMs);
    const timelineStartMs = Number.isFinite(position) ? Math.round(position) : Number.NaN;
    const repetitions = Number(body.repetitions ?? 1);
    if (!sectionId || !stemAssetId || !remixTrackId || !action)
      return NextResponse.json({ error: "A section, stem, arrangement track, and action are required." }, { status: 400 });

    const db = getDb();
    const [remix] = await db.select().from(remixSessions).where(eq(remixSessions.id, id)).limit(1);
    if (!remix) return NextResponse.json({ error: "Remix session not found." }, { status: 404 });
    await requireProjectRole(user.id, remix.projectId, "editor");

    const [section] = await db.select().from(sourceSections).where(eq(sourceSections.id, sectionId)).limit(1);
    if (!section || section.projectId !== remix.projectId)
      return NextResponse.json({ errorCode: "section_action_unavailable", error: "This source section is unavailable in the remix project." }, { status: 422 });
    const [[source], [analysis], [sectionAnalysis], [stem], [track]] = await Promise.all([
      db.select().from(sourceAssets).where(and(eq(sourceAssets.id, section.sourceAssetId), eq(sourceAssets.projectId, remix.projectId))).limit(1),
      db.select().from(sourceAnalyses).where(and(eq(sourceAnalyses.id, section.sourceAnalysisId), eq(sourceAnalyses.projectId, remix.projectId))).limit(1),
      db.select().from(sourceSectionAnalyses).where(and(eq(sourceSectionAnalyses.id, section.sourceSectionAnalysisId), eq(sourceSectionAnalyses.projectId, remix.projectId))).limit(1),
      db.select().from(stemAssets).where(and(eq(stemAssets.id, stemAssetId), eq(stemAssets.projectId, remix.projectId))).limit(1),
      db.select().from(remixTracks).where(and(eq(remixTracks.id, remixTrackId), eq(remixTracks.remixSessionId, remix.id))).limit(1),
    ]);
    if (!source || !analysis || !sectionAnalysis || !stem || !track
      || source.id !== section.sourceAssetId
      || analysis.sourceAssetId !== source.id
      || sectionAnalysis.sourceAssetId !== source.id
      || sectionAnalysis.sourceAnalysisId !== analysis.id
      || sectionAnalysis.sourceChecksumSha256 !== source.checksumSha256
      || stem.sourceAssetId !== source.id
      || track.stemAssetId !== stem.id)
      return NextResponse.json({ errorCode: "section_action_unavailable", error: "The section, source, stem, and arrangement track must belong to one project." }, { status: 422 });
    if (analysis.status !== "complete")
      return NextResponse.json({ errorCode: "section_action_unavailable", error: "A complete current source beat analysis is required." }, { status: 422 });
    const provenanceError = sectionActionProvenanceReason({
      sourceChecksumSha256: source.checksumSha256,
      sectionChecksumSha256: section.sourceChecksumSha256,
      sourceAnalysisId: analysis.id,
      sectionSourceAnalysisId: section.sourceAnalysisId,
      sectionAnalysisStatus: sectionAnalysis.status,
      sectionAnalysisEngine: sectionAnalysis.analysisEngine,
      sectionAnalysisEngineVersion: sectionAnalysis.analysisEngineVersion,
      sectionEngine: section.analysisEngine,
      sectionEngineVersion: section.analysisEngineVersion,
    });
    if (provenanceError)
      return NextResponse.json({ errorCode: provenanceError, error: "This structural analysis is stale or no longer complete. Re-run section analysis before arranging it." }, { status: 422 });
    const beatGrid = parsedBeatGrid(analysis.beatGrid);
    if (!beatGrid)
      return NextResponse.json({ errorCode: "section_action_unavailable", error: "The current source beat grid is unavailable." }, { status: 422 });

    let context: typeof remixClips.$inferSelect | null = null;
    if (contextClipId) {
      const [found] = await db.select().from(remixClips).where(eq(remixClips.id, contextClipId)).limit(1);
      if (!found) return NextResponse.json({ error: "The selected arrangement context clip no longer exists." }, { status: 409 });
      const [contextTrack] = await db.select().from(remixTracks).where(eq(remixTracks.id, found.remixTrackId)).limit(1);
      if (!contextTrack || contextTrack.remixSessionId !== remix.id)
        return NextResponse.json({ error: "The selected arrangement context clip is outside this remix." }, { status: 403 });
      // Only a context clip on this destination track inherits intent. This is
      // deterministic and avoids copying another source's editing context.
      if (contextTrack.id === track.id && found.stemAssetId === stem.id) context = found;
    }
    const template: MusicalClipInput = context
      ? {
        stemAssetId: stem.id,
        timelineStartMs,
        durationMs: context.durationMs,
        sourceOffsetMs: context.sourceOffsetMs,
        gain: context.gain,
        fadeInMs: context.fadeInMs,
        fadeOutMs: context.fadeOutMs,
        tempoSyncEnabled: context.tempoSyncEnabled,
        keySyncEnabled: context.keySyncEnabled,
        beatSnapEnabled: context.beatSnapEnabled,
      }
      : {
        // Established remix creation defaults: untransformed full-gain audio,
        // zero fades, and no sync intent until the editor enables it.
        stemAssetId: stem.id,
        timelineStartMs,
        durationMs: 1,
        sourceOffsetMs: 0,
        gain: 1,
        fadeInMs: 0,
        fadeOutMs: 0,
        tempoSyncEnabled: false,
        keySyncEnabled: false,
        beatSnapEnabled: false,
      };
    let ratio = 1;
    if (template.tempoSyncEnabled) {
      ratio = tempoRatioForBpm(remix.tempoBpm, analysis.bpm ?? Number.NaN) ?? 0;
      if (!ratio || analysis.bpm! < 40 || analysis.bpm! > 300)
        return NextResponse.json({ errorCode: "tempo_sync_bpm_unavailable", error: "Tempo-synced section placement requires a usable current source BPM." }, { status: 422 });
    }
    const current = await db.select({ id: remixClips.id }).from(remixClips).where(eq(remixClips.remixTrackId, track.id));
    const result = createSectionArrangementClips(
      template,
      { startBeatIndex: section.startBeatIndex, endBeatIndex: section.endBeatIndex },
      beatGrid,
      Math.round(stem.durationSeconds * 1000),
      timelineStartMs,
      ratio,
      action,
      256 - current.length,
      repetitions,
    );
    if (!result.ok) {
      const message = result.reason === "clip_capacity_exceeded"
        ? "This section action would exceed the 256-clip track limit."
        : result.reason === "loop_repetitions_invalid"
          ? "Section loop repeats must be an integer from 1 to 64."
          : result.reason === "timeline_bounds_invalid"
            ? "Section placement exceeds the arrangement timeline limit."
            : "The selected section no longer resolves to a valid source beat range.";
      return NextResponse.json({ errorCode: result.reason, error: message }, { status: 422 });
    }
    const created = await db.transaction(async (tx) => {
      const clips = await tx.insert(remixClips).values(result.clips.map((clip) => ({
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
      }))).returning();
      await tx.update(remixSessions).set({ version: remix.version + 1, updatedAt: new Date() }).where(eq(remixSessions.id, remix.id));
      return clips;
    });
    return NextResponse.json({ clips: created, trackId: track.id, action }, { status: 201 });
  } catch (error) {
    if (error instanceof Response) return error;
    console.error("section arrangement action failed", error);
    return NextResponse.json({ error: "Could not create clips from the selected source section." }, { status: 500 });
  }
}
