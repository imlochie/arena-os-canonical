/**
 * Local export job handler — a faithful port of the worker's processExport
 * WAV path (waveyard-worker/apps/worker/src/export.ts): snapshot parsing,
 * crossfade validation, tempo/key sync analysis requirements, and the same
 * FFmpeg filter_complex construction, with one documented substitution —
 * the final mix sums explicitly (amerge+pan) instead of `amix normalize=0`
 * because the bundled GPL ffmpeg 4.1 predates that option.
 *
 * MIDI exports are NOT ported: every MIDI kind requires the Python-worker
 * analyses (vocal/drum/harmony) which the desktop cannot run, so a MIDI
 * export fails immediately with an honest error code instead of pretending.
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq, inArray } from "drizzle-orm";

import { db } from "@/db";
import { exportAssets, exportJobs, remixSessions, remixVersions, sourceAnalyses, stemAssets } from "@/db/waveyardSchema";
import { checksumFile, exec, validateAudio } from "@/lib/waveyard/audio";
import { requireTool } from "@/lib/waveyard/ffmpeg";
import { getStorage, privateObjectKey } from "@/lib/waveyard/storage";
import {
  AUTOMATION_PARAMETERS,
  normaliseAutomationPoints,
  normaliseMusicalKey,
  type ExportJobPayload,
  type RemixAutomationLane,
} from "@/lib/waveyard/types";
import { automatedTrackBusFilters, atempoFilterChain, mixSumFilters, padToTimeline, pitchFilterChain, requiredSourceDurationMs, resolveKeySync, sourceDurationFits, tempoRatio, timelineSampleCount } from "./render-helpers";

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
  automation: RemixAutomationLane[];
};

export class ExportFailure extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
  }
}

function finite(value: unknown, lower: number, upper: number) {
  const number = Number(value);
  if (!Number.isFinite(number) || number < lower || number > upper) throw new ExportFailure("invalid_snapshot", "Persisted remix version is invalid.");
  return number;
}

export function parseExportSnapshot(raw: string): ExportSnapshot {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new ExportFailure("invalid_snapshot", "Persisted remix version is invalid JSON.");
  }
  if (!parsed || typeof parsed !== "object") throw new ExportFailure("invalid_snapshot", "Persisted remix version is invalid.");
  const value = parsed as Record<string, unknown>;
  if (!Array.isArray(value.tracks)) throw new ExportFailure("invalid_snapshot", "Persisted remix tracks are missing.");
  const tracks = value.tracks.map((track): SnapshotTrack => {
    if (!track || typeof track !== "object") throw new ExportFailure("invalid_snapshot", "Persisted remix track is invalid.");
    const candidate = track as Record<string, unknown>;
    if (typeof candidate.stemAssetId !== "string" || !Array.isArray(candidate.clips)) throw new ExportFailure("invalid_snapshot", "Persisted remix track is invalid.");
    return {
      id: typeof candidate.id === "string" ? candidate.id : null,
      stemAssetId: candidate.stemAssetId,
      sortOrder: finite(candidate.sortOrder, 0, 99),
      volume: finite(candidate.volume, 0, 2),
      pan: finite(candidate.pan, -1, 1),
      muted: candidate.muted === true,
      solo: candidate.solo === true,
      clips: candidate.clips.map((clip): SnapshotClip => {
        if (!clip || typeof clip !== "object") throw new ExportFailure("invalid_snapshot", "Persisted remix clip is invalid.");
        const item = clip as Record<string, unknown>;
        if (typeof item.stemAssetId !== "string") throw new ExportFailure("invalid_snapshot", "Persisted remix clip is invalid.");
        const durationMs = finite(item.durationMs, 1, 86_400_000);
        const fadeInMs = item.fadeInMs === undefined ? 0 : finite(item.fadeInMs, 0, durationMs);
        const fadeOutMs = item.fadeOutMs === undefined ? 0 : finite(item.fadeOutMs, 0, durationMs);
        if (fadeInMs + fadeOutMs > durationMs) throw new ExportFailure("invalid_snapshot", "Persisted remix clip fades exceed its duration.");
        return {
          stemAssetId: item.stemAssetId,
          timelineStartMs: finite(item.timelineStartMs, 0, 86_400_000),
          durationMs,
          sourceOffsetMs: finite(item.sourceOffsetMs, 0, 86_400_000),
          gain: finite(item.gain, 0, 4),
          fadeInMs,
          fadeOutMs,
          tempoSyncEnabled: item.tempoSyncEnabled === true,
          keySyncEnabled: item.keySyncEnabled === true,
          beatSnapEnabled: item.beatSnapEnabled === true,
        };
      }),
    };
  });
  let automation: RemixAutomationLane[] = [];
  if (value.automation !== undefined) {
    if (!Array.isArray(value.automation)) throw new ExportFailure("invalid_snapshot", "Persisted automation is invalid.");
    automation = value.automation.map((lane): RemixAutomationLane => {
      if (!lane || typeof lane !== "object") throw new ExportFailure("invalid_snapshot", "Persisted automation is invalid.");
      const candidate = lane as Record<string, unknown>;
      if (typeof candidate.remixTrackId !== "string" || !AUTOMATION_PARAMETERS.includes(candidate.parameter as (typeof AUTOMATION_PARAMETERS)[number]))
        throw new ExportFailure("invalid_snapshot", "Persisted automation is invalid.");
      const parameter = candidate.parameter as (typeof AUTOMATION_PARAMETERS)[number];
      const points = normaliseAutomationPoints(parameter, candidate.points);
      if (!points) throw new ExportFailure("invalid_snapshot", "Persisted automation is invalid.");
      return { remixTrackId: candidate.remixTrackId, parameter, points };
    });
    const trackIds = new Set(tracks.map((track) => track.id).filter((trackId): trackId is string => Boolean(trackId)));
    const laneKeys = new Set<string>();
    for (const lane of automation) {
      const key = `${lane.remixTrackId}:${lane.parameter}`;
      if (!trackIds.has(lane.remixTrackId) || laneKeys.has(key)) throw new ExportFailure("invalid_snapshot", "Persisted automation track identity is invalid.");
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
      if ((left.fadeOutMs > 0 || right.fadeInMs > 0) && (left.fadeOutMs !== overlap || right.fadeInMs !== overlap))
        throw new ExportFailure("invalid_snapshot", "Persisted remix crossfade is invalid.");
    }
  }
}

function seconds(milliseconds: number) {
  return (milliseconds / 1000).toFixed(3);
}

function panGains(pan: number) {
  return {
    left: Math.cos(((pan + 1) * Math.PI) / 4).toFixed(6),
    right: Math.sin(((pan + 1) * Math.PI) / 4).toFixed(6),
  };
}

async function updateJob(id: string, patch: Partial<typeof exportJobs.$inferInsert>) {
  await db.update(exportJobs).set({ ...patch, updatedAt: new Date() }).where(eq(exportJobs.id, id));
}

/** Local export from immutable persisted RemixVersion authority. */
export async function handleExportJob(payloadInput: Record<string, unknown>): Promise<void> {
  const payload = payloadInput as unknown as ExportJobPayload;
  const [job] = await db.select().from(exportJobs).where(eq(exportJobs.id, payload.exportJobId)).limit(1);
  if (!job || job.status === "complete" || job.status === "cancelled") return;

  const [existingAsset] = await db.select().from(exportAssets).where(eq(exportAssets.exportJobId, job.id)).limit(1);
  if (existingAsset) {
    await updateJob(job.id, { status: "complete", stage: "complete", completedAt: job.completedAt ?? new Date() });
    return;
  }

  const invalidPayload = job.projectId !== payload.projectId || job.remixSessionId !== payload.remixSessionId || job.remixVersionId !== payload.remixVersionId || job.format !== payload.format;
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

  const [version] = await db.select().from(remixVersions).where(eq(remixVersions.id, job.remixVersionId)).limit(1);
  const [session] = await db.select().from(remixSessions).where(eq(remixSessions.id, job.remixSessionId)).limit(1);
  if (!version || !session || version.remixSessionId !== session.id || session.projectId !== job.projectId) {
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
    // Honest desktop boundary: every MIDI kind requires Python-worker
    // analyses (vocal/drum/harmony) the desktop cannot run.
    await updateJob(job.id, {
      status: "failed",
      stage: "failed",
      errorCode: "midi_requires_worker",
      errorMessage: "MIDI export requires the Waveyard Python worker's vocal/drum/harmony analyses, which are not bundled with the desktop app.",
      completedAt: new Date(),
    });
    throw new ExportFailure("midi_requires_worker", "MIDI export requires the Waveyard Python worker's vocal/drum/harmony analyses, which are not bundled with the desktop app.");
  }
  if (job.format !== "wav") throw new ExportFailure("unsupported_format", "Export format is unsupported.");

  const temporaryDirectory = await mkdtemp(join(tmpdir(), "arena-export-"));
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

    const snapshot = parseExportSnapshot(version.snapshot);
    assertValidCrossfades(snapshot.tracks);
    const hasSolo = snapshot.tracks.some((track) => track.solo && !track.muted);
    const activeTracks = snapshot.tracks.filter((track) => !track.muted && (!hasSolo || track.solo)).sort((left, right) => left.sortOrder - right.sortOrder);
    const clips = activeTracks.flatMap((track) => track.clips.map((clip) => ({ ...clip, track })));
    if (!clips.length) throw new ExportFailure("empty_remix", "The persisted remix version has no audible clips to export.");

    const stemIds = [...new Set(clips.map((clip) => clip.stemAssetId))];
    const stems = await db.select().from(stemAssets).where(inArray(stemAssets.id, stemIds));
    if (stems.length !== stemIds.length || stems.some((stem) => stem.projectId !== job.projectId))
      throw new ExportFailure("asset_missing", "The persisted remix references an unavailable project stem.");
    const stemById = new Map(stems.map((stem) => [stem.id, stem]));
    const transformedSourceIds = [...new Set(clips.filter((clip) => clip.tempoSyncEnabled || clip.keySyncEnabled).map((clip) => stemById.get(clip.stemAssetId)!.sourceAssetId))];
    const analyses = transformedSourceIds.length ? await db.select().from(sourceAnalyses).where(inArray(sourceAnalyses.sourceAssetId, transformedSourceIds)) : [];
    const analysisBySourceId = new Map(analyses.map((analysis) => [analysis.sourceAssetId, analysis]));
    const tempoByClip = new Map<number, { ratio: number; sourceDurationMs: number }>();
    const keyShiftByClip = new Map<number, number>();
    for (const [index, clip] of clips.entries()) {
      const stem = stemById.get(clip.stemAssetId)!;
      let sourceDurationMs = clip.durationMs;
      if (clip.tempoSyncEnabled) {
        const analysis = analysisBySourceId.get(stem.sourceAssetId);
        if (!analysis || analysis.projectId !== job.projectId || analysis.status !== "complete") throw new ExportFailure("tempo_sync_analysis_missing", "Tempo sync requires complete source BPM analysis.");
        if (!Number.isFinite(analysis.bpm) || analysis.bpm! < 40 || analysis.bpm! > 300) throw new ExportFailure("tempo_sync_bpm_unavailable", "Tempo sync requires a usable source BPM.");
        const ratio = tempoRatio(snapshot.tempoBpm, analysis.bpm!);
        sourceDurationMs = requiredSourceDurationMs(clip.durationMs, ratio);
        tempoByClip.set(index, { ratio, sourceDurationMs });
      }
      if (clip.keySyncEnabled) {
        const analysis = analysisBySourceId.get(stem.sourceAssetId);
        const resolution = resolveKeySync(analysis?.projectId === job.projectId ? analysis.status : undefined, normaliseMusicalKey(analysis?.musicalKey), snapshot.targetKey);
        if ("errorCode" in resolution)
          throw new ExportFailure(
            resolution.errorCode,
            resolution.errorCode === "key_sync_analysis_missing" ? "Key sync requires complete source key analysis." : "Key sync requires usable source and target keys.",
          );
        keyShiftByClip.set(index, resolution.semitones);
      }
      if (!sourceDurationFits(clip.sourceOffsetMs, clip.durationMs, clip.tempoSyncEnabled ? tempoByClip.get(index)!.ratio : 1, stem.durationSeconds * 1000))
        throw new ExportFailure(
          "invalid_snapshot",
          clip.tempoSyncEnabled ? "A tempo-synced clip requires more source audio than its stem contains." : "A persisted remix clip extends beyond its source stem.",
        );
    }

    const inputPaths = new Map<string, string>();
    for (const [index, stem] of stems.entries()) {
      const inputPath = join(temporaryDirectory, `stem-${index}.wav`);
      await storage.getToFile(stem.storageKey, inputPath);
      inputPaths.set(stem.id, inputPath);
    }

    await updateJob(job.id, { status: "processing", stage: "rendering" });

    const inputIndex = new Map(stems.map((stem, index) => [stem.id, index]));
    const automationByTrackId = new Map(snapshot.automation.map((lane) => [`${lane.remixTrackId}:${lane.parameter}`, lane.points]));
    const automatedTrackIds = new Set(snapshot.automation.map((lane) => lane.remixTrackId));
    const automatedTrackIndex = new Map(activeTracks.map((track, index) => [track.id, index]));
    // Desktop mix strategy (docs/desktop-runtime-plan.md): the bundled GPL
    // ffmpeg 4.1 predates `amix normalize`, so clips are apad'd to the
    // timeline and summed explicitly (amerge+pan) — mathematically identical
    // to the worker's `amix ... normalize=0 duration=longest`.
    const timelineSamples = timelineSampleCount(clips, job.sampleRate);
    const filters = clips.map((clip, index) => {
      const delay = Math.round(clip.timelineStartMs);
      const tempo = tempoByClip.get(index);
      const keyShift = keyShiftByClip.get(index);
      const fades = [
        clip.fadeInMs > 0 ? `afade=t=in:st=0:d=${seconds(clip.fadeInMs)}` : "",
        clip.fadeOutMs > 0 ? `afade=t=out:st=${seconds(clip.durationMs - clip.fadeOutMs)}:d=${seconds(clip.fadeOutMs)}` : "",
      ]
        .filter(Boolean)
        .join(",");
      const fadeSegment = fades ? `,${fades}` : "";
      const padSegment = `,${padToTimeline(job.sampleRate, timelineSamples, clip.timelineStartMs + clip.durationMs)}`;
      const automated = Boolean(clip.track.id && automatedTrackIds.has(clip.track.id));
      if (automated) {
        const tempoSegment = tempo ? `,${atempoFilterChain(tempo.ratio)},atrim=duration=${seconds(clip.durationMs)}` : "";
        if (keyShift === undefined)
          return `[${inputIndex.get(clip.stemAssetId)}:a]atrim=start=${seconds(clip.sourceOffsetMs)}:duration=${seconds(tempo?.sourceDurationMs ?? clip.durationMs)},asetpts=PTS-STARTPTS${tempoSegment},aformat=sample_rates=${job.sampleRate}:channel_layouts=stereo,volume=${clip.gain.toFixed(6)}${fadeSegment},adelay=${delay}|${delay}${padSegment}[clip${index}]`;
        const keyTempoSegment = tempo ? `,${atempoFilterChain(tempo.ratio)}` : "";
        return `[${inputIndex.get(clip.stemAssetId)}:a]atrim=start=${seconds(clip.sourceOffsetMs)}:duration=${seconds(tempo?.sourceDurationMs ?? clip.durationMs)},asetpts=PTS-STARTPTS${keyTempoSegment},aformat=sample_rates=${job.sampleRate}:channel_layouts=stereo,${pitchFilterChain(keyShift, job.sampleRate)},atrim=duration=${seconds(clip.durationMs)},volume=${clip.gain.toFixed(6)}${fadeSegment},adelay=${delay}|${delay}${padSegment}[clip${index}]`;
      }
      const gains = panGains(clip.track.pan);
      const volume = (clip.track.volume * clip.gain).toFixed(6);
      if (keyShift === undefined) {
        const tempoSegment = tempo ? `,${atempoFilterChain(tempo.ratio)},atrim=duration=${seconds(clip.durationMs)}` : "";
        return `[${inputIndex.get(clip.stemAssetId)}:a]atrim=start=${seconds(clip.sourceOffsetMs)}:duration=${seconds(tempo?.sourceDurationMs ?? clip.durationMs)},asetpts=PTS-STARTPTS${tempoSegment},aformat=sample_rates=${job.sampleRate}:channel_layouts=stereo,pan=stereo|c0=${gains.left}*c0|c1=${gains.right}*c1,volume=${volume}${fadeSegment},adelay=${delay}|${delay}${padSegment}[clip${index}]`;
      }
      const tempoSegment = tempo ? `,${atempoFilterChain(tempo.ratio)}` : "";
      return `[${inputIndex.get(clip.stemAssetId)}:a]atrim=start=${seconds(clip.sourceOffsetMs)}:duration=${seconds(tempo?.sourceDurationMs ?? clip.durationMs)},asetpts=PTS-STARTPTS${tempoSegment},aformat=sample_rates=${job.sampleRate}:channel_layouts=stereo,${pitchFilterChain(keyShift, job.sampleRate)},atrim=duration=${seconds(clip.durationMs)},pan=stereo|c0=${gains.left}*c0|c1=${gains.right}*c1,volume=${volume}${fadeSegment},adelay=${delay}|${delay}${padSegment}[clip${index}]`;
    });
    const trackBusLabels = new Map<string, string>();
    for (const [trackId, trackIndex] of automatedTrackIndex) {
      if (!trackId || !automatedTrackIds.has(trackId)) continue;
      const track = activeTracks[trackIndex];
      const clipLabels = clips.flatMap((clip, clipIndex) => (clip.track.id === trackId ? [`[clip${clipIndex}]`] : []));
      if (!clipLabels.length) continue;
      const trackLabel = `track${trackIndex}`;
      filters.push(
        ...automatedTrackBusFilters(
          clipLabels,
          trackLabel,
          automationByTrackId.get(`${trackId}:volume`) ?? [],
          automationByTrackId.get(`${trackId}:pan`) ?? [],
          track.volume,
          track.pan,
        ),
      );
      trackBusLabels.set(trackId, `[${trackLabel}]`);
    }
    const labels = clips
      .flatMap((clip, index) => {
        if (clip.track.id && trackBusLabels.has(clip.track.id)) {
          const label = trackBusLabels.get(clip.track.id)!;
          trackBusLabels.delete(clip.track.id);
          return [label];
        }
        return clip.track.id && automatedTrackIds.has(clip.track.id) ? [] : [`[clip${index}]`];
      })
      .join("");
    const topLabels = labels.match(/\[[^\]]+\]/g) ?? [];
    filters.push(...mixSumFilters(topLabels, "premaster"));
    filters.push(`[premaster]volume=${snapshot.masterVolume.toFixed(6)}[mix]`);

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
    const ffmpeg = await requireTool("ffmpeg");
    await exec(ffmpeg.path, args, { cwd: temporaryDirectory });

    await updateJob(job.id, { status: "finalizing", stage: "validating" });
    const metadata = await validateAudio(outputPath);
    const checksum = await checksumFile(outputPath);
    storedKey = privateObjectKey(job.projectId, "export", "wav");
    await storage.putFile(storedKey, outputPath, "audio/wav");

    await db.transaction(async (tx) => {
      await tx.insert(exportAssets).values({
        projectId: job.projectId,
        exportJobId: job.id,
        remixVersionId: version.id,
        storageKey: storedKey!,
        filename: `remix-${version.id}.wav`,
        checksumSha256: checksum,
        durationSeconds: Math.max(1, Math.round(metadata.durationSeconds)),
        sampleRate: metadata.sampleRate,
        channels: metadata.channels,
        codec: metadata.codec,
        format: "wav",
        fileSizeBytes: metadata.sizeBytes,
      });
      await tx.update(exportJobs).set({ status: "complete", stage: "complete", completedAt: new Date(), updatedAt: new Date() }).where(eq(exportJobs.id, job.id));
    });
    complete = true;
  } catch (error) {
    const message = error instanceof Error ? error.message.slice(0, 1800) : "Unknown export failure.";
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
