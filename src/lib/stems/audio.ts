import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { extname } from "node:path";

export const STEM_TYPES = ["vocals", "drums", "bass", "other"] as const;
export type StemType = (typeof STEM_TYPES)[number];
const ACCEPTED_EXTENSIONS = new Set([".wav", ".mp3", ".flac", ".m4a", ".aac", ".ogg"]);

export type AudioMetadata = {
  durationSeconds: number;
  sampleRate: number;
  channels: number;
  codec: string;
  bitrate: number | null;
  container: string;
  sizeBytes: number;
};

export function acceptedAudioFilename(filename: string) {
  return ACCEPTED_EXTENSIONS.has(extname(filename).toLowerCase());
}

export function sanitizedFilename(filename: string) {
  const clean = filename.normalize("NFKC")
    .replace(/[\\/\0]/g, "_")
    .replace(/[^\w.() -]/g, "_")
    .trim()
    .slice(0, 180);
  return clean || "upload";
}

export function extensionFor(filename: string) {
  const extension = extname(filename).replace(/[^a-zA-Z0-9.]/g, "").toLowerCase();
  return ACCEPTED_EXTENSIONS.has(extension) ? extension.slice(1) : "bin";
}

export async function checksumFile(path: string): Promise<string> {
  const hash = createHash("sha256");
  await new Promise<void>((resolve, reject) => {
    createReadStream(path).on("data", (chunk) => hash.update(chunk)).on("error", reject).on("end", resolve);
  });
  return hash.digest("hex");
}

export async function run(command: string, args: string[], cwd?: string) {
  return new Promise<{ stdout: string; stderr: string }>((resolve, reject) => {
    const child = spawn(command, args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += String(chunk); });
    child.stderr.on("data", (chunk) => { stderr += String(chunk); });
    child.once("error", reject);
    child.once("close", (code) => code === 0
      ? resolve({ stdout, stderr })
      : reject(new Error(`${command} exited ${code}: ${stderr.slice(-1200)}`)));
  });
}

export async function probeAudio(path: string): Promise<AudioMetadata> {
  const { stdout } = await run("ffprobe", [
    "-v", "error", "-show_entries", "format=format_name,duration,bit_rate:stream=codec_name,sample_rate,channels",
    "-of", "json", path,
  ]);
  const report = JSON.parse(stdout) as {
    format?: { format_name?: string; duration?: string; bit_rate?: string };
    streams?: Array<{ codec_name?: string; sample_rate?: string; channels?: number }>;
  };
  const stream = report.streams?.find((candidate) => candidate.codec_name && candidate.sample_rate && candidate.channels);
  const durationSeconds = Math.round(Number(report.format?.duration ?? 0) * 1000) / 1000;
  const sizeBytes = (await stat(path)).size;
  if (!stream?.codec_name || !stream.sample_rate || !stream.channels || !Number.isFinite(durationSeconds) || durationSeconds <= 0 || sizeBytes <= 0) {
    throw new Error("Audio could not be decoded into a valid timed stream.");
  }
  return {
    durationSeconds,
    sampleRate: Number(stream.sample_rate),
    channels: stream.channels,
    codec: stream.codec_name,
    bitrate: report.format?.bit_rate ? Number(report.format.bit_rate) : null,
    container: report.format?.format_name ?? "unknown",
    sizeBytes,
  };
}

export async function assertNonZeroSignal(path: string) {
  const { stderr } = await run("ffmpeg", ["-v", "info", "-i", path, "-af", "volumedetect", "-f", "null", "-"]);
  const maxVolume = stderr.match(/max_volume:\s*([^\s]+)/)?.[1];
  if (!maxVolume || maxVolume === "-inf") throw new Error("Audio output has no detectable signal.");
}

export async function validateAudio(path: string) {
  const metadata = await probeAudio(path);
  await assertNonZeroSignal(path);
  return metadata;
}
