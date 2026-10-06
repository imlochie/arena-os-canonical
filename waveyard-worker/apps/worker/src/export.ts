import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq, inArray } from "drizzle-orm";
import { checksumFile, exec, validateAudio } from "@waveyard/audio";
import {
  drumAnalyses,
  drumEvents,
  exportAssets,
  exportJobs,
  getDb,
  harmonyAnalyses,
  harmonyEvents,
  remixSessions,
  remixVersions,
  sourceAnalyses,
  sourceAssets,
  stemAssets,
  vocalAnalyses,
  vocalPitchFrames,
} from "@waveyard/database";
import { consumeTestFault } from "@waveyard/queue";
import { getStorage, privateObjectKey } from "@waveyard/storage";
import { AUTOMATION_PARAMETERS, drumAnalysisProvenanceReason, drumEventsToMidiNotes, harmonyAnalysisProvenanceReason, harmonyEventsToMidiNotes, MIDI_PPQ, normaliseDrumEvents, normaliseHarmonyEvents, normaliseAutomationPoints, normaliseMusicalKey, vocalAnalysisProvenanceReason, vocalFramesToMidiNotes, type ExportJobPayload, type RemixAutomationLane } from "@waveyard/types";
import { pitchFilterChain, resolveKeySync } from "./key";
import { atempoFilterChain, requiredSourceDurationMs, sourceDurationFits, tempoRatio } from "./tempo";
import { automatedTrackBusFilters } from "./automation";
import { writeMidiFile } from "./midi";

type SnapshotClip = {
  stemAssetId: string;
  timelineStartMs: number;
  durationMs: number;
  sourceOffsetMs: number;
  gain: number;
  fadeInMs: number;
  fadeOutMs: number;
  tempoSyncEnabled: boolean;
  keySyncEnabled: boolean;
  beatSnapEnabled: boolean;
};
type SnapshotTrack = {
  id: string | null;
  stemAssetId: string;
  sortOrder: number;
  volume: number;
  pan: number;
  muted: boolean;
  solo: boolean;
  clips: SnapshotClip[];
};
type ExportSnapshot = {
  masterVolume: number;
  tempoBpm: number;
  targetKey: string | null;
  tracks: SnapshotTrack[];
  // Parsed from the immutable RemixVersion even though V1 deliberately keeps
  // the existing static FFmpeg track-volume/pan export boundary.
  automation: RemixAutomationLane[];
};

class ExportFailure extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

function finite(value: unknown, lower: number, upper: number) {
  const number = Number(value);
  if (!Number.isFinite(number) || number < lower || number > upper)
    throw new ExportFailure("invalid_snapshot", "Persisted remix version is invalid.");
  return number;
}

export function parseExportSnapshot(raw: string): ExportSnapshot {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new ExportFailure("invalid_snapshot", "Persisted remix version is invalid JSON.");
  }
  if (!parsed || typeof parsed !== "object")
    throw new ExportFailure("invalid_snapshot", "Persisted remix version is invalid.");
  const value = parsed as Record<string, unknown>;
  if (!Array.isArray(value.tracks))
    throw new ExportFailure("invalid_snapshot", "Persisted remix tracks are missing.");
  const tracks = value.tracks.map((track): SnapshotTrack => {
    if (!track || typeof track !== "object")
      throw new ExportFailure("invalid_snapshot", "Persisted remix track is invalid.");
    const candidate = track as Record<string, unknown>;
    if (typeof candidate.stemAssetId !== "string" || !Array.isArray(candidate.clips))
      throw new ExportFailure("invalid_snapshot", "Persisted remix track is invalid.");
    return {
      id: typeof candidate.id === "string" ? candidate.id : null,
      stemAssetId: candidate.stemAssetId,
      sortOrder: finite(candidate.sortOrder, 0, 99),
      volume: finite(candidate.volume, 0, 2),
      pan: finite(candidate.pan, -1, 1),
      muted: candidate.muted === true,
      solo: candidate.solo === true,
      clips: candidate.clips.map((clip): SnapshotClip => {
        if (!clip || typeof clip !== "object")
          throw new ExportFailure("invalid_snapshot", "Persisted remix clip is invalid.");
        const item = clip as Record<string, unknown>;
        if (typeof item.stemAssetId !== "string")
          throw new ExportFailure("invalid_snapshot", "Persisted remix clip is invalid.");
        const durationMs = finite(item.durationMs, 1, 86_400_000);
        const fadeInMs = item.fadeInMs === undefined
          ? 0
          : finite(item.fadeInMs, 0, durationMs);
        const fadeOutMs = item.fadeOutMs === undefined
          ? 0
          : finite(item.fadeOutMs, 0, durationMs);
        if (fadeInMs + fadeOutMs > durationMs)
          throw new ExportFailure("invalid_snapshot", "Persisted remix clip fades exceed its duration.");
        return {
          stemAssetId: item.stemAssetId,
          timelineStartMs: finite(item.timelineStartMs, 0, 86_400_000),
          durationMs,
          sourceOffsetMs: finite(item.sourceOffsetMs, 0, 86_400_000),
          gain: finite(item.gain, 0, 4),
          fadeInMs,
          fadeOutMs,
          // Historical versions are intentionally rendered without a transform.
          tempoSyncEnabled: item.tempoSyncEnabled === true,
          // Historical versions are intentionally rendered without a transform.
          keySyncEnabled: item.keySyncEnabled === true,
          // Snap is already reflected in persisted clip coordinates; preserve intent in provenance.
          beatSnapEnabled: item.beatSnapEnabled === true,
        };
      }),
    };
  });
  let automation: RemixAutomationLane[] = [];
  if (value.automation !== undefined) {
    if (!Array.isArray(value.automation))
      throw new ExportFailure("invalid_snapshot", "Persisted automation is invalid.");
    automation = value.automation.map((lane): RemixAutomationLane => {
      if (!lane || typeof lane !== "object")
        throw new ExportFailure("invalid_snapshot", "Persisted automation is invalid.");
      const candidate = lane as Record<string, unknown>;
      if (typeof candidate.remixTrackId !== "string" || !AUTOMATION_PARAMETERS.includes(candidate.parameter as typeof AUTOMATION_PARAMETERS[number]))
        throw new ExportFailure("invalid_snapshot", "Persisted automation is invalid.");
      const parameter = candidate.parameter as typeof AUTOMATION_PARAMETERS[number];
      const points = normaliseAutomationPoints(parameter, candidate.points);
      if (!points)
        throw new ExportFailure("invalid_snapshot", "Persisted automation is invalid.");
      return { remixTrackId: candidate.remixTrackId, parameter, points };
    });
    const trackIds = new Set(tracks.map((track) => track.id).filter((trackId): trackId is string => Boolean(trackId)));
    const laneKeys = new Set<string>();
    for (const lane of automation) {
      const key = `${lane.remixTrackId}:${lane.parameter}`;
      if (!trackIds.has(lane.remixTrackId) || laneKeys.has(key))
        throw new ExportFailure("invalid_snapshot", "Persisted automation track identity is invalid.");
      laneKeys.add(key);
    }
  }
  return {
    masterVolume: finite(value.masterVolume, 0, 2),
    tempoBpm: finite(value.tempoBpm ?? 120, 20, 300),
    targetKey: normaliseMusicalKey(value.targetKey),
    tracks,
    automation,
  };
}

function assertValidCrossfades(tracks: SnapshotTrack[]) {
  for (const track of tracks) {
    const clips = [...track.clips].sort((left, right) => left.timelineStartMs - right.timelineStartMs);
    for (let index = 0; index < clips.length - 1; index += 1) {
      const left = clips[index];
      const right = clips[index + 1];
      const overlap = left.timelineStartMs + left.durationMs - right.timelineStartMs;
      if (overlap <= 0) continue;
      if ((left.fadeOutMs > 0 || right.fadeInMs > 0) &&
          (left.fadeOutMs !== overlap || right.fadeInMs !== overlap))
        throw new ExportFailure("invalid_snapshot", "Persisted remix crossfade is invalid.");
    }
  }
}

function seconds(milliseconds: number) {
  return (milliseconds / 1000).toFixed(3);
}

function panGains(pan: number) {
  // Equal-power stereo balance. Inputs are normalized to stereo before pan.
  return {
    left: Math.cos(((pan + 1) * Math.PI) / 4).toFixed(6),
    right: Math.sin(((pan + 1) * Math.PI) / 4).toFixed(6),
  };
}

async function updateJob(
  id: string,
  patch: Partial<typeof exportJobs.$inferInsert>,
) {
  await getDb()
    .update(exportJobs)
    .set({ ...patch, updatedAt: new Date() })
    .where(eq(exportJobs.id, id));
}

async function processMidiExport(
  job: typeof exportJobs.$inferSelect,
  version: typeof remixVersions.$inferSelect,
  reportStage: (stage: string) => Promise<void>,
) {
  const db = getDb();
  if (job.format !== "midi" || !job.midiKind || !job.midiSourceAssetId || !job.midiAnalysisId || !job.midiSourceChecksumSha256 || !job.midiAnalysisEngine || !job.midiAnalysisEngineVersion || job.midiPpq !== MIDI_PPQ)
    throw new ExportFailure("invalid_midi_export", "MIDI export provenance is incomplete.");
  const [source] = await db.select().from(sourceAssets).where(eq(sourceAssets.id, job.midiSourceAssetId)).limit(1);
  if (!source || source.projectId !== job.projectId)
    throw new ExportFailure("midi_source_missing", "MIDI export source is unavailable in this project.");
  if (source.checksumSha256 !== job.midiSourceChecksumSha256)
    throw new ExportFailure("midi_analysis_stale", "MIDI export source checksum no longer matches its analysis snapshot.");
  const snapshot = parseExportSnapshot(version.snapshot);
  const snapshotStemIds = [...new Set(snapshot.tracks.map((track) => track.stemAssetId))];
  const snapshotStems = snapshotStemIds.length ? await db.select().from(stemAssets).where(inArray(stemAssets.id, snapshotStemIds)) : [];
  if (!snapshotStems.some((stem) => stem.projectId === job.projectId && stem.sourceAssetId === source.id))
    throw new ExportFailure("midi_version_scope_missing", "The immutable remix version does not contain the requested source.");
  const [sourceAnalysis] = await db.select().from(sourceAnalyses).where(eq(sourceAnalyses.sourceAssetId, source.id)).limit(1);
  if (!sourceAnalysis || sourceAnalysis.projectId !== job.projectId || sourceAnalysis.status !== "complete" || !Number.isFinite(sourceAnalysis.bpm) || sourceAnalysis.bpm! < 40 || sourceAnalysis.bpm! > 300)
    throw new ExportFailure("midi_tempo_missing", "Source-relative MIDI export requires complete source BPM analysis.");
  await updateJob(job.id, { status: "preparing", stage: "resolving-analysis", attempts: job.attempts + 1, startedAt: new Date(), completedAt: null, errorCode: null, errorMessage: null });
  await reportStage("resolving-analysis");
  let notes;
  if (job.midiKind === "vocal" || job.midiKind === "drums") {
    if (!job.midiStemAssetId) throw new ExportFailure("midi_stem_missing", "Stem MIDI export requires an isolated source stem.");
    const [stem] = await db.select().from(stemAssets).where(eq(stemAssets.id, job.midiStemAssetId)).limit(1);
    if (!stem || stem.projectId !== job.projectId || stem.sourceAssetId !== source.id || !snapshotStemIds.includes(stem.id))
      throw new ExportFailure("midi_stem_missing", "The immutable remix version does not contain the requested project stem.");
    if (job.midiKind === "vocal") {
      if (stem.stemType !== "vocals") throw new ExportFailure("midi_stem_unsupported", "Vocal MIDI requires an isolated vocals stem.");
      const [analysis] = await db.select().from(vocalAnalyses).where(eq(vocalAnalyses.stemAssetId, stem.id)).limit(1);
      const reason = !analysis ? "analysis_missing" : vocalAnalysisProvenanceReason({
        sourceAssetId: analysis.sourceAssetId, expectedSourceAssetId: source.id, stemAssetId: analysis.stemAssetId, expectedStemAssetId: stem.id,
        sourceChecksumSha256: analysis.sourceChecksumSha256, expectedSourceChecksumSha256: source.checksumSha256, stemChecksumSha256: analysis.stemChecksumSha256, expectedStemChecksumSha256: stem.checksumSha256,
        analysisEngine: analysis.analysisEngine, analysisEngineVersion: analysis.analysisEngineVersion,
      });
      if (!analysis || analysis.id !== job.midiAnalysisId || analysis.analysisEngine !== job.midiAnalysisEngine || analysis.analysisEngineVersion !== job.midiAnalysisEngineVersion || analysis.projectId !== job.projectId || analysis.status !== "complete" || reason)
        throw new ExportFailure("midi_analysis_missing", "Vocal MIDI requires complete current vocal analysis.");
      const frames = await db.select().from(vocalPitchFrames).where(eq(vocalPitchFrames.vocalAnalysisId, analysis.id)).orderBy(vocalPitchFrames.frameIndex);
      notes = vocalFramesToMidiNotes(frames);
    } else {
      if (stem.stemType !== "drums" && stem.stemType !== "percussion") throw new ExportFailure("midi_stem_unsupported", "Drum MIDI requires an isolated drums/percussion stem.");
      const [analysis] = await db.select().from(drumAnalyses).where(eq(drumAnalyses.stemAssetId, stem.id)).limit(1);
      const reason = !analysis ? "analysis_missing" : drumAnalysisProvenanceReason({
        sourceAssetId: analysis.sourceAssetId, expectedSourceAssetId: source.id, stemAssetId: analysis.stemAssetId, expectedStemAssetId: stem.id,
        sourceChecksumSha256: analysis.sourceChecksumSha256, expectedSourceChecksumSha256: source.checksumSha256, stemChecksumSha256: analysis.stemChecksumSha256, expectedStemChecksumSha256: stem.checksumSha256,
        analysisEngine: analysis.analysisEngine, analysisEngineVersion: analysis.analysisEngineVersion,
      });
      if (!analysis || analysis.id !== job.midiAnalysisId || analysis.analysisEngine !== job.midiAnalysisEngine || analysis.analysisEngineVersion !== job.midiAnalysisEngineVersion || analysis.projectId !== job.projectId || analysis.status !== "complete" || reason)
        throw new ExportFailure("midi_analysis_missing", "Drum MIDI requires complete current drum analysis.");
      const rows = await db.select().from(drumEvents).where(eq(drumEvents.drumAnalysisId, analysis.id)).orderBy(drumEvents.eventIndex);
      const events = normaliseDrumEvents(rows, Math.round(stem.durationSeconds * 1000));
      if (!events) throw new ExportFailure("midi_analysis_invalid", "Drum analysis evidence is invalid.");
      notes = drumEventsToMidiNotes(events.map((event) => ({ ...event, nearestBeatIndex: null, beatOffsetMs: null })));
    }
  } else if (job.midiKind === "harmony") {
    const [analysis] = await db.select().from(harmonyAnalyses).where(eq(harmonyAnalyses.sourceAssetId, source.id)).limit(1);
    const reason = !analysis ? "analysis_missing" : harmonyAnalysisProvenanceReason({
      sourceAssetId: analysis.sourceAssetId, expectedSourceAssetId: source.id,
      sourceChecksumSha256: analysis.sourceChecksumSha256, expectedSourceChecksumSha256: source.checksumSha256,
      analysisEngine: analysis.analysisEngine, analysisEngineVersion: analysis.analysisEngineVersion,
    });
    if (!analysis || analysis.id !== job.midiAnalysisId || analysis.analysisEngine !== job.midiAnalysisEngine || analysis.analysisEngineVersion !== job.midiAnalysisEngineVersion || analysis.projectId !== job.projectId || analysis.status !== "complete" || reason)
      throw new ExportFailure("midi_analysis_missing", "Harmony MIDI requires complete current harmony analysis.");
    const rows = await db.select().from(harmonyEvents).where(eq(harmonyEvents.harmonyAnalysisId, analysis.id)).orderBy(harmonyEvents.eventIndex);
    const events = normaliseHarmonyEvents(rows, Math.round(source.durationSeconds * 1000));
    if (!events) throw new ExportFailure("midi_analysis_invalid", "Harmony analysis evidence is invalid.");
    notes = harmonyEventsToMidiNotes(events);
  } else throw new ExportFailure("midi_kind_unsupported", "Unsupported MIDI export analysis kind.");
  if (!notes.length) throw new ExportFailure("midi_no_supported_events", "No sufficiently confident analysis events can be exported as MIDI.");
  const temporaryDirectory = await mkdtemp(join(tmpdir(), "waveyard-midi-export-"));
  const storage = getStorage();
  let storedKey: string | undefined;
  let complete = false;
  try {
    await updateJob(job.id, { status: "processing", stage: "encoding-midi" });
    await reportStage("encoding-midi");
    const outputPath = join(temporaryDirectory, "analysis.mid");
    await writeMidiFile(outputPath, notes, sourceAnalysis.bpm!);
    const checksumSha256 = await checksumFile(outputPath);
    const metadata = await stat(outputPath);
    storedKey = privateObjectKey(job.projectId, "export", "mid");
    await storage.putFile(storedKey, outputPath, "audio/midi");
    await db.transaction(async (tx) => {
      await tx.insert(exportAssets).values({
        projectId: job.projectId, exportJobId: job.id, remixVersionId: version.id, storageKey: storedKey!,
        filename: `${job.midiKind}-${version.id}.mid`, checksumSha256,
        durationSeconds: Math.max(1, Math.ceil(Math.max(...notes.map((note) => note.startMs + note.durationMs)) / 1000)),
        sampleRate: 0, channels: 0, codec: "smf", format: "midi", fileSizeBytes: metadata.size,
      });
      await tx.update(exportJobs).set({ status: "complete", stage: "complete", completedAt: new Date(), updatedAt: new Date() }).where(eq(exportJobs.id, job.id));
    });
    complete = true;
    await reportStage("complete");
  } catch (error) {
    const message = error instanceof Error ? error.message.slice(0, 1800) : "Unknown MIDI export failure.";
    await updateJob(job.id, { status: "failed", stage: "failed", errorCode: error instanceof ExportFailure ? error.code : "midi_export_failed", errorMessage: message, completedAt: new Date() });
    throw error;
  } finally {
    if (!complete && storedKey) await storage.delete(storedKey).catch(() => undefined);
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
}

/** Worker-owned export from immutable persisted RemixVersion authority. */
export async function processExport(
  payload: ExportJobPayload,
  reportStage: (stage: string) => Promise<void>,
) {
  const db = getDb();
  const [job] = await db
    .select()
    .from(exportJobs)
    .where(eq(exportJobs.id, payload.exportJobId))
    .limit(1);
  if (!job || job.status === "complete" || job.status === "cancelled") return;

  const [existingAsset] = await db
    .select()
    .from(exportAssets)
    .where(eq(exportAssets.exportJobId, job.id))
    .limit(1);
  if (existingAsset) {
    await updateJob(job.id, {
      status: "complete",
      stage: "complete",
      completedAt: job.completedAt ?? new Date(),
    });
    return;
  }

  const invalidPayload =
    job.projectId !== payload.projectId ||
    job.remixSessionId !== payload.remixSessionId ||
    job.remixVersionId !== payload.remixVersionId ||
    job.format !== payload.format;
  if (invalidPayload) {
    await updateJob(job.id, {
      status: "failed",
      stage: "failed",
      errorCode: "invalid_payload",
      errorMessage: "Export queue payload does not match its durable job target.",
      completedAt: new Date(),
    });
    throw new Error("Export payload does not match its durable job target.");
  }

  const [version] = await db
    .select()
    .from(remixVersions)
    .where(eq(remixVersions.id, job.remixVersionId))
    .limit(1);
  const [session] = await db
    .select()
    .from(remixSessions)
    .where(eq(remixSessions.id, job.remixSessionId))
    .limit(1);
  if (
    !version ||
    !session ||
    version.remixSessionId !== session.id ||
    session.projectId !== job.projectId
  ) {
    await updateJob(job.id, {
      status: "failed",
      stage: "failed",
      errorCode: "provenance_missing",
      errorMessage: "Export remix provenance is unavailable.",
      completedAt: new Date(),
    });
    throw new Error("Export remix provenance is unavailable.");
  }

  if (job.format === "midi") {
    try {
      await processMidiExport(job, version, reportStage);
    } catch (error) {
      const message = error instanceof Error ? error.message.slice(0, 1800) : "Unknown MIDI export failure.";
      await updateJob(job.id, { status: "failed", stage: "failed", errorCode: error instanceof ExportFailure ? error.code : "midi_export_failed", errorMessage: message, completedAt: new Date() });
      throw error;
    }
    return;
  }
  if (job.format !== "wav") throw new ExportFailure("unsupported_format", "Export format is unsupported.");

  const temporaryDirectory = await mkdtemp(join(tmpdir(), "waveyard-export-"));
  const storage = getStorage();
  let storedKey: string | undefined;
  let complete = false;
  try {
    await updateJob(job.id, {
      status: "preparing",
      stage: "resolving-remix",
      attempts: (job.attempts ?? 0) + 1,
      startedAt: new Date(),
      completedAt: null,
      errorCode: null,
      errorMessage: null,
    });
    await reportStage("resolving-remix");

    const snapshot = parseExportSnapshot(version.snapshot);
    assertValidCrossfades(snapshot.tracks);
    const hasSolo = snapshot.tracks.some((track) => track.solo && !track.muted);
    const activeTracks = snapshot.tracks
      .filter((track) => !track.muted && (!hasSolo || track.solo))
      .sort((left, right) => left.sortOrder - right.sortOrder);
    const clips = activeTracks.flatMap((track) =>
      track.clips.map((clip) => ({ ...clip, track })),
    );
    if (!clips.length)
      throw new ExportFailure(
        "empty_remix",
        "The persisted remix version has no audible clips to export.",
      );

    const stemIds = [...new Set(clips.map((clip) => clip.stemAssetId))];
    const stems = await db
      .select()
      .from(stemAssets)
      .where(inArray(stemAssets.id, stemIds));
    if (stems.length !== stemIds.length || stems.some((stem) => stem.projectId !== job.projectId))
      throw new ExportFailure(
        "asset_missing",
        "The persisted remix references an unavailable project stem.",
      );
    const stemById = new Map(stems.map((stem) => [stem.id, stem]));
    const transformedSourceIds = [...new Set(clips
      .filter((clip) => clip.tempoSyncEnabled || clip.keySyncEnabled)
      .map((clip) => stemById.get(clip.stemAssetId)!.sourceAssetId))];
    const analyses = transformedSourceIds.length
      ? await db.select().from(sourceAnalyses).where(inArray(sourceAnalyses.sourceAssetId, transformedSourceIds))
      : [];
    const analysisBySourceId = new Map(analyses.map((analysis) => [analysis.sourceAssetId, analysis]));
    const tempoByClip = new Map<number, { ratio: number; sourceDurationMs: number }>();
    const keyShiftByClip = new Map<number, number>();
    for (const [index, clip] of clips.entries()) {
      const stem = stemById.get(clip.stemAssetId)!;
      let sourceDurationMs = clip.durationMs;
      if (clip.tempoSyncEnabled) {
        const analysis = analysisBySourceId.get(stem.sourceAssetId);
        if (!analysis || analysis.projectId !== job.projectId || analysis.status !== "complete")
          throw new ExportFailure("tempo_sync_analysis_missing", "Tempo sync requires complete source BPM analysis.");
        if (!Number.isFinite(analysis.bpm) || analysis.bpm! < 40 || analysis.bpm! > 300)
          throw new ExportFailure("tempo_sync_bpm_unavailable", "Tempo sync requires a usable source BPM.");
        const ratio = tempoRatio(snapshot.tempoBpm, analysis.bpm!);
        sourceDurationMs = requiredSourceDurationMs(clip.durationMs, ratio);
        tempoByClip.set(index, { ratio, sourceDurationMs });
      }
      if (clip.keySyncEnabled) {
        const analysis = analysisBySourceId.get(stem.sourceAssetId);
        const resolution = resolveKeySync(
          analysis?.projectId === job.projectId ? analysis.status : undefined,
          normaliseMusicalKey(analysis?.musicalKey),
          snapshot.targetKey,
        );
        if ("errorCode" in resolution)
          throw new ExportFailure(
            resolution.errorCode,
            resolution.errorCode === "key_sync_analysis_missing"
              ? "Key sync requires complete source key analysis."
              : "Key sync requires usable source and target keys.",
          );
        keyShiftByClip.set(index, resolution.semitones);
      }
      if (!sourceDurationFits(
        clip.sourceOffsetMs,
        clip.durationMs,
        clip.tempoSyncEnabled ? tempoByClip.get(index)!.ratio : 1,
        stem.durationSeconds * 1000,
      ))
        throw new ExportFailure(
          "invalid_snapshot",
          clip.tempoSyncEnabled
            ? "A tempo-synced clip requires more source audio than its stem contains."
            : "A persisted remix clip extends beyond its source stem.",
        );
    }

    const inputPaths = new Map<string, string>();
    for (const [index, stem] of stems.entries()) {
      const inputPath = join(temporaryDirectory, `stem-${index}.wav`);
      await storage.getToFile(stem.storageKey, inputPath);
      inputPaths.set(stem.id, inputPath);
    }

    await updateJob(job.id, { status: "processing", stage: "rendering" });
    await reportStage("rendering");
    if (await consumeTestFault("export-render"))
      throw new ExportFailure("render_failed", "Injected export render failure.");

    const inputIndex = new Map(stems.map((stem, index) => [stem.id, index]));
    const automationByTrackId = new Map(snapshot.automation.map((lane) => [
      `${lane.remixTrackId}:${lane.parameter}`,
      lane.points,
    ]));
    const automatedTrackIds = new Set(snapshot.automation.map((lane) => lane.remixTrackId));
    const automatedTrackIndex = new Map(activeTracks.map((track, index) => [track.id, index]));
    const filters = clips.map((clip, index) => {
      const delay = Math.round(clip.timelineStartMs);
      const tempo = tempoByClip.get(index);
      const keyShift = keyShiftByClip.get(index);
      const fades = [
        clip.fadeInMs > 0 ? `afade=t=in:st=0:d=${seconds(clip.fadeInMs)}` : "",
        clip.fadeOutMs > 0
          ? `afade=t=out:st=${seconds(clip.durationMs - clip.fadeOutMs)}:d=${seconds(clip.fadeOutMs)}`
          : "",
      ].filter(Boolean).join(",");
      const fadeSegment = fades ? `,${fades}` : "";
      const automated = Boolean(clip.track.id && automatedTrackIds.has(clip.track.id));
      if (automated) {
        // Clip-local transform/gain/fades/delay precede one combined track bus.
        const tempoSegment = tempo
          ? `,${atempoFilterChain(tempo.ratio)},atrim=duration=${seconds(clip.durationMs)}`
          : "";
        if (keyShift === undefined)
          return `[${inputIndex.get(clip.stemAssetId)}:a]atrim=start=${seconds(clip.sourceOffsetMs)}:duration=${seconds(tempo?.sourceDurationMs ?? clip.durationMs)},asetpts=PTS-STARTPTS${tempoSegment},aformat=sample_rates=${job.sampleRate}:channel_layouts=stereo,volume=${clip.gain.toFixed(6)}${fadeSegment},adelay=${delay}|${delay}[clip${index}]`;
        const keyTempoSegment = tempo ? `,${atempoFilterChain(tempo.ratio)}` : "";
        return `[${inputIndex.get(clip.stemAssetId)}:a]atrim=start=${seconds(clip.sourceOffsetMs)}:duration=${seconds(tempo?.sourceDurationMs ?? clip.durationMs)},asetpts=PTS-STARTPTS${keyTempoSegment},aformat=sample_rates=${job.sampleRate}:channel_layouts=stereo,${pitchFilterChain(keyShift, job.sampleRate)},atrim=duration=${seconds(clip.durationMs)},volume=${clip.gain.toFixed(6)}${fadeSegment},adelay=${delay}|${delay}[clip${index}]`;
      }
      const gains = panGains(clip.track.pan);
      const volume = (clip.track.volume * clip.gain).toFixed(6);
      // No-automation clips retain the established Phase 6 filter order.
      if (keyShift === undefined) {
        const tempoSegment = tempo
          ? `,${atempoFilterChain(tempo.ratio)},atrim=duration=${seconds(clip.durationMs)}`
          : "";
        return `[${inputIndex.get(clip.stemAssetId)}:a]atrim=start=${seconds(clip.sourceOffsetMs)}:duration=${seconds(tempo?.sourceDurationMs ?? clip.durationMs)},asetpts=PTS-STARTPTS${tempoSegment},aformat=sample_rates=${job.sampleRate}:channel_layouts=stereo,pan=stereo|c0=${gains.left}*c0|c1=${gains.right}*c1,volume=${volume}${fadeSegment},adelay=${delay}|${delay}[clip${index}]`;
      }
      const tempoSegment = tempo ? `,${atempoFilterChain(tempo.ratio)}` : "";
      return `[${inputIndex.get(clip.stemAssetId)}:a]atrim=start=${seconds(clip.sourceOffsetMs)}:duration=${seconds(tempo?.sourceDurationMs ?? clip.durationMs)},asetpts=PTS-STARTPTS${tempoSegment},aformat=sample_rates=${job.sampleRate}:channel_layouts=stereo,${pitchFilterChain(keyShift, job.sampleRate)},atrim=duration=${seconds(clip.durationMs)},pan=stereo|c0=${gains.left}*c0|c1=${gains.right}*c1,volume=${volume}${fadeSegment},adelay=${delay}|${delay}[clip${index}]`;
    });
    const trackBusLabels = new Map<string, string>();
    for (const [trackId, trackIndex] of automatedTrackIndex) {
      if (!trackId || !automatedTrackIds.has(trackId)) continue;
      const track = activeTracks[trackIndex];
      const clipLabels = clips.flatMap((clip, clipIndex) => clip.track.id === trackId ? [`[clip${clipIndex}]`] : []);
      if (!clipLabels.length) continue;
      const trackLabel = `track${trackIndex}`;
      filters.push(...automatedTrackBusFilters(
        clipLabels,
        trackLabel,
        automationByTrackId.get(`${trackId}:volume`) ?? [],
        automationByTrackId.get(`${trackId}:pan`) ?? [],
        track.volume,
        track.pan,
      ));
      trackBusLabels.set(trackId, `[${trackLabel}]`);
    }
    const labels = clips.flatMap((clip, index) => {
      if (clip.track.id && trackBusLabels.has(clip.track.id)) {
        const label = trackBusLabels.get(clip.track.id)!;
        trackBusLabels.delete(clip.track.id);
        return [label];
      }
      return clip.track.id && automatedTrackIds.has(clip.track.id) ? [] : [`[clip${index}]`];
    }).join("");
    filters.push(
      `${labels}amix=inputs=${labels.match(/\[/g)?.length ?? 0}:duration=longest:dropout_transition=0:normalize=0,volume=${snapshot.masterVolume.toFixed(6)}[mix]`,
    );
    const outputPath = join(temporaryDirectory, "export.wav");
    const args = [
      "-y",
      ...stems.flatMap((stem) => ["-i", inputPaths.get(stem.id)!]),
      "-filter_complex",
      filters.join(";"),
      "-map",
      "[mix]",
      "-vn",
      "-c:a",
      "pcm_s16le",
      "-ar",
      String(job.sampleRate),
      "-ac",
      String(job.channels),
      outputPath,
    ];
    await exec("ffmpeg", args, { cwd: temporaryDirectory });

    await updateJob(job.id, { status: "finalizing", stage: "validating" });
    await reportStage("validating");
    const metadata = await validateAudio(outputPath);
    const checksumSha256 = await checksumFile(outputPath);
    storedKey = privateObjectKey(job.projectId, "export", "wav");
    await storage.putFile(storedKey, outputPath, "audio/wav");

    await db.transaction(async (tx) => {
      await tx.insert(exportAssets).values({
        projectId: job.projectId,
        exportJobId: job.id,
        remixVersionId: version.id,
        storageKey: storedKey!,
        filename: `remix-${version.id}.wav`,
        checksumSha256,
        durationSeconds: Math.max(1, Math.round(metadata.durationSeconds)),
        sampleRate: metadata.sampleRate,
        channels: metadata.channels,
        codec: metadata.codec,
        format: "wav",
        fileSizeBytes: metadata.sizeBytes,
      });
      await tx
        .update(exportJobs)
        .set({
          status: "complete",
          stage: "complete",
          completedAt: new Date(),
          updatedAt: new Date(),
        })
        .where(eq(exportJobs.id, job.id));
    });
    complete = true;
    await reportStage("complete");
  } catch (error) {
    const message =
      error instanceof Error ? error.message.slice(0, 1800) : "Unknown export failure.";
    await updateJob(job.id, {
      status: "failed",
      stage: "failed",
      errorCode: error instanceof ExportFailure ? error.code : "export_failed",
      errorMessage: message,
      completedAt: new Date(),
    });
    throw error;
  } finally {
    if (!complete && storedKey) await storage.delete(storedKey).catch(() => undefined);
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
}
