import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq, inArray } from "drizzle-orm";
import { checksumFile, exec, validateAudio } from "@waveyard/audio";
import {
  exportAssets,
  exportJobs,
  getDb,
  remixSessions,
  remixVersions,
  stemAssets,
} from "@waveyard/database";
import { consumeTestFault } from "@waveyard/queue";
import { getStorage, privateObjectKey } from "@waveyard/storage";
import type { ExportJobPayload } from "@waveyard/types";

type SnapshotClip = {
  stemAssetId: string;
  timelineStartMs: number;
  durationMs: number;
  sourceOffsetMs: number;
  gain: number;
  fadeInMs: number;
  fadeOutMs: number;
};
type SnapshotTrack = {
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
  tracks: SnapshotTrack[];
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

function parseSnapshot(raw: string): ExportSnapshot {
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
        };
      }),
    };
  });
  return { masterVolume: finite(value.masterVolume, 0, 2), tracks };
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

/** Worker-owned FFmpeg mixdown of an immutable persisted RemixVersion. */
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

    const snapshot = parseSnapshot(version.snapshot);
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
    for (const clip of clips) {
      const stem = stemById.get(clip.stemAssetId)!;
      if (clip.sourceOffsetMs + clip.durationMs > stem.durationSeconds * 1000)
        throw new ExportFailure(
          "invalid_snapshot",
          "A persisted remix clip extends beyond its source stem.",
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
    const filters = clips.map((clip, index) => {
      const gains = panGains(clip.track.pan);
      const volume = (clip.track.volume * clip.gain).toFixed(6);
      const delay = Math.round(clip.timelineStartMs);
      const fades = [
        clip.fadeInMs > 0 ? `afade=t=in:st=0:d=${seconds(clip.fadeInMs)}` : "",
        clip.fadeOutMs > 0
          ? `afade=t=out:st=${seconds(clip.durationMs - clip.fadeOutMs)}:d=${seconds(clip.fadeOutMs)}`
          : "",
      ].filter(Boolean).join(",");
      const fadeSegment = fades ? `,${fades}` : "";
      return `[${inputIndex.get(clip.stemAssetId)}:a]atrim=start=${seconds(clip.sourceOffsetMs)}:duration=${seconds(clip.durationMs)},asetpts=PTS-STARTPTS,aformat=sample_rates=${job.sampleRate}:channel_layouts=stereo,pan=stereo|c0=${gains.left}*c0|c1=${gains.right}*c1,volume=${volume}${fadeSegment},adelay=${delay}|${delay}[clip${index}]`;
    });
    const labels = clips.map((_clip, index) => `[clip${index}]`).join("");
    filters.push(
      `${labels}amix=inputs=${clips.length}:duration=longest:dropout_transition=0:normalize=0,volume=${snapshot.masterVolume.toFixed(6)}[mix]`,
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
