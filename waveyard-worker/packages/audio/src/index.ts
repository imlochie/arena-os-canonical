import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { extname } from "node:path";
import { spawn } from "node:child_process";
import {
  WAVEFORM_RESOLUTIONS,
  type AudioMetadata,
  type StemType,
  type WaveformDocument,
  type WaveformPeaks,
} from "@waveyard/types";

const ACCEPTED_EXTENSIONS = new Set([
  ".wav",
  ".mp3",
  ".flac",
  ".m4a",
  ".aac",
  ".ogg",
]);
export const MAX_UPLOAD_BYTES = Number(
  process.env.MAX_UPLOAD_BYTES ?? 524_288_000,
);
const WAVEFORM_PCM_SAMPLE_RATE = 44_100;
const configuredWaveformPcmLimit = Number(
  process.env.MAX_WAVEFORM_PCM_BYTES ?? 1_000_000_000,
);
const MAX_WAVEFORM_PCM_BYTES =
  Number.isSafeInteger(configuredWaveformPcmLimit) &&
  configuredWaveformPcmLimit > 0
    ? configuredWaveformPcmLimit
    : 1_000_000_000;

export function acceptedAudioFilename(filename: string) {
  return ACCEPTED_EXTENSIONS.has(extname(filename).toLowerCase());
}

export function sanitizedFilename(filename: string) {
  const result = filename
    .normalize("NFKC")
    .replace(/[\\/\0]/g, "_")
    .replace(/[^\w.() -]/g, "_")
    .trim()
    .slice(0, 180);
  return result || "upload";
}

export async function checksumFile(path: string): Promise<string> {
  const hash = createHash("sha256");
  await new Promise<void>((resolve, reject) =>
    createReadStream(path)
      .on("data", (chunk) => hash.update(chunk))
      .on("error", reject)
      .on("end", resolve),
  );
  return hash.digest("hex");
}

async function exec(
  command: string,
  args: string[],
  options: { cwd?: string } = {},
) {
  return new Promise<{ stdout: string; stderr: string }>((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += String(chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });
    child.once("error", (error) => reject(error));
    child.once("close", (code) =>
      code === 0
        ? resolve({ stdout, stderr })
        : reject(
            new Error(`${command} exited ${code}: ${stderr.slice(-1200)}`),
          ),
    );
  });
}

export async function probeAudio(path: string): Promise<AudioMetadata> {
  const { stdout } = await exec("ffprobe", [
    "-v",
    "error",
    "-show_entries",
    "format=format_name,duration,bit_rate:stream=codec_name,sample_rate,channels",
    "-of",
    "json",
    path,
  ]);
  const report = JSON.parse(stdout) as {
    format?: { format_name?: string; duration?: string; bit_rate?: string };
    streams?: Array<{
      codec_name?: string;
      sample_rate?: string;
      channels?: number;
    }>;
  };
  const stream = report.streams?.find(
    (candidate) =>
      candidate.codec_name && candidate.sample_rate && candidate.channels,
  );
  const durationSeconds =
    Math.round(Number(report.format?.duration ?? 0) * 1000) / 1000;
  const sizeBytes = (await stat(path)).size;
  const codec = stream?.codec_name;
  const sampleRate = stream?.sample_rate;
  const channels = stream?.channels;
  if (
    !stream ||
    !codec ||
    !Number.isFinite(durationSeconds) ||
    durationSeconds <= 0 ||
    !sampleRate ||
    !channels ||
    sizeBytes <= 0
  ) {
    throw new Error("Audio could not be decoded into a valid timed stream.");
  }
  return {
    durationSeconds,
    sampleRate: Number(sampleRate),
    channels,
    codec,
    bitrate: report.format?.bit_rate ? Number(report.format.bit_rate) : null,
    container: report.format?.format_name ?? "unknown",
    sizeBytes,
  };
}

export async function assertNonZeroSignal(path: string): Promise<void> {
  const { stderr } = await exec("ffmpeg", [
    "-v",
    "info",
    "-i",
    path,
    "-af",
    "volumedetect",
    "-f",
    "null",
    "-",
  ]);
  const max = stderr.match(/max_volume:\s*([^\s]+)/)?.[1];
  if (!max || max === "-inf")
    throw new Error("Audio output has no detectable signal.");
}

export async function validateAudio(path: string) {
  const metadata = await probeAudio(path);
  await assertNonZeroSignal(path);
  return metadata;
}

/** Pure deterministic min/max reduction, exposed for isolated waveform tests. */
export function waveformPeaksForResolution(
  samples: Int16Array,
  resolution: number,
): WaveformPeaks {
  const min = new Array<number>(resolution).fill(0);
  const max = new Array<number>(resolution).fill(0);
  for (let bucket = 0; bucket < resolution; bucket += 1) {
    const start = Math.floor((bucket * samples.length) / resolution);
    const end = Math.floor(((bucket + 1) * samples.length) / resolution);
    if (start >= end) continue;
    let low = 32767;
    let high = -32768;
    for (let i = start; i < end; i += 1) {
      const value = samples[i];
      if (value < low) low = value;
      if (value > high) high = value;
    }
    min[bucket] = Number((low / 32768).toFixed(6));
    max[bucket] = Number((high / 32768).toFixed(6));
  }
  return { min, max };
}

/**
 * Reduces PCM from disk without loading the decoded audio into memory. FFmpeg
 * owns decoding; this function does not invent or decorate waveform samples.
 */
async function waveformPeaksFromPcmFile(
  path: string,
): Promise<Record<string, WaveformPeaks>> {
  const pcmSize = (await stat(path)).size;
  const sampleCount = Math.floor(pcmSize / 2);
  if (sampleCount < 1)
    throw new Error(
      "Decoded audio contains no PCM samples for waveform generation.",
    );

  // Only five bounded peak arrays are retained. Decoded PCM can be much larger
  // than the upload, so whole-file reads would make worker memory unbounded.
  const reductions = WAVEFORM_RESOLUTIONS.map((resolution) => ({
    resolution,
    min: new Array<number>(resolution).fill(32767),
    max: new Array<number>(resolution).fill(-32768),
    seen: new Array<boolean>(resolution).fill(false),
  }));
  let sampleIndex = 0;
  for await (const chunk of createReadStream(path, {
    highWaterMark: 64 * 1024,
  })) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    const usable = bytes.byteLength - (bytes.byteLength % 2);
    for (
      let offset = 0;
      offset < usable && sampleIndex < sampleCount;
      offset += 2, sampleIndex += 1
    ) {
      const value = bytes.readInt16LE(offset);
      for (const reduction of reductions) {
        const bucket = Math.min(
          reduction.resolution - 1,
          Math.floor((sampleIndex * reduction.resolution) / sampleCount),
        );
        reduction.seen[bucket] = true;
        if (value < reduction.min[bucket]) reduction.min[bucket] = value;
        if (value > reduction.max[bucket]) reduction.max[bucket] = value;
      }
    }
  }
  const resolutions: Record<string, WaveformPeaks> = {};
  for (const reduction of reductions) {
    resolutions[String(reduction.resolution)] = {
      min: reduction.min.map((value, index) =>
        reduction.seen[index] ? Number((value / 32768).toFixed(6)) : 0,
      ),
      max: reduction.max.map((value, index) =>
        reduction.seen[index] ? Number((value / 32768).toFixed(6)) : 0,
      ),
    };
  }
  return resolutions;
}

export async function generateWaveform(
  path: string,
  temporaryPcmPath: string,
): Promise<WaveformDocument> {
  const metadata = await probeAudio(path);
  const estimatedPcmBytes =
    metadata.durationSeconds * WAVEFORM_PCM_SAMPLE_RATE * 2;
  if (
    !Number.isFinite(estimatedPcmBytes) ||
    estimatedPcmBytes > MAX_WAVEFORM_PCM_BYTES
  ) {
    throw new Error("Audio is too long to derive a bounded waveform artifact.");
  }
  await exec("ffmpeg", [
    "-v",
    "error",
    "-i",
    path,
    "-map",
    "0:a:0",
    "-ac",
    "1",
    "-ar",
    String(WAVEFORM_PCM_SAMPLE_RATE),
    "-f",
    "s16le",
    "-y",
    temporaryPcmPath,
  ]);
  const document: WaveformDocument = {
    format: "waveyard-peaks-v1",
    durationSeconds: metadata.durationSeconds,
    sampleRate: WAVEFORM_PCM_SAMPLE_RATE,
    channels: 1,
    resolutions: await waveformPeaksFromPcmFile(temporaryPcmPath),
  };
  validateWaveform(document);
  return document;
}

export function validateWaveform(document: WaveformDocument) {
  if (
    document.format !== "waveyard-peaks-v1" ||
    !Number.isFinite(document.durationSeconds) ||
    document.durationSeconds <= 0 ||
    document.sampleRate !== WAVEFORM_PCM_SAMPLE_RATE ||
    document.channels !== 1
  )
    throw new Error("Invalid waveform header.");
  for (const resolution of WAVEFORM_RESOLUTIONS) {
    const peaks = document.resolutions[String(resolution)];
    if (
      !peaks ||
      peaks.min.length !== resolution ||
      peaks.max.length !== resolution
    )
      throw new Error(`Invalid ${resolution}-bucket waveform.`);
    for (let index = 0; index < resolution; index += 1) {
      const low = peaks.min[index];
      const high = peaks.max[index];
      if (
        !Number.isFinite(low) ||
        !Number.isFinite(high) ||
        low < -1 ||
        high > 1 ||
        low > high
      )
        throw new Error("Invalid waveform peak values.");
    }
  }
}

export interface SeparationEngineMetadata {
  id?: string;
  engine: string;
  model: string;
  modelVersion?: string;
  version?: string;
  requestedDevice: string;
  resolvedDevice: string;
}
export interface ValidatedStem {
  stemType: StemType;
  path: string;
  metadata: AudioMetadata;
  checksumSha256: string;
}
export interface SeparationEngine {
  prepare(inputPath: string): Promise<void>;
  separate(
    inputPath: string,
    outputDirectory: string,
  ): Promise<SeparationEngineMetadata>;
  validate(outputDirectory: string): Promise<ValidatedStem[]>;
  cleanup(): Promise<void>;
}

export { exec };
