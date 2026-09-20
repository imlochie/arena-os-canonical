import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { extname } from "node:path";
import { spawn } from "node:child_process";
import type { AudioMetadata, StemType } from "@waveyard/types";

const ACCEPTED_EXTENSIONS = new Set([".wav", ".mp3", ".flac", ".m4a", ".aac", ".ogg"]);
export const MAX_UPLOAD_BYTES = Number(process.env.MAX_UPLOAD_BYTES ?? 524_288_000);

export function acceptedAudioFilename(filename: string) {
  return ACCEPTED_EXTENSIONS.has(extname(filename).toLowerCase());
}

export function sanitizedFilename(filename: string) {
  const result = filename.normalize("NFKC").replace(/[\\/\0]/g, "_").replace(/[^\w.() -]/g, "_").trim().slice(0, 180);
  return result || "upload";
}

export async function checksumFile(path: string): Promise<string> {
  const hash = createHash("sha256");
  await new Promise<void>((resolve, reject) => createReadStream(path).on("data", (chunk) => hash.update(chunk)).on("error", reject).on("end", resolve));
  return hash.digest("hex");
}

async function exec(command: string, args: string[], options: { cwd?: string } = {}) {
  return new Promise<{ stdout: string; stderr: string }>((resolve, reject) => {
    const child = spawn(command, args, { cwd: options.cwd, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += String(chunk); });
    child.stderr.on("data", (chunk) => { stderr += String(chunk); });
    child.once("error", (error) => reject(error));
    child.once("close", (code) => code === 0 ? resolve({ stdout, stderr }) : reject(new Error(`${command} exited ${code}: ${stderr.slice(-1200)}`)));
  });
}

export async function probeAudio(path: string): Promise<AudioMetadata> {
  const { stdout } = await exec("ffprobe", ["-v", "error", "-show_entries", "format=format_name,duration,bit_rate:stream=codec_name,sample_rate,channels", "-of", "json", path]);
  const report = JSON.parse(stdout) as { format?: { format_name?: string; duration?: string; bit_rate?: string }; streams?: Array<{ codec_name?: string; sample_rate?: string; channels?: number }> };
  const stream = report.streams?.find((candidate) => candidate.codec_name && candidate.sample_rate && candidate.channels);
  const durationSeconds = Math.round(Number(report.format?.duration ?? 0) * 1000) / 1000;
  const sizeBytes = (await stat(path)).size;
  const codec = stream?.codec_name;
  const sampleRate = stream?.sample_rate;
  const channels = stream?.channels;
  if (!stream || !codec || !Number.isFinite(durationSeconds) || durationSeconds <= 0 || !sampleRate || !channels || sizeBytes <= 0) {
    throw new Error("Audio could not be decoded into a valid timed stream.");
  }
  return { durationSeconds, sampleRate: Number(sampleRate), channels, codec, bitrate: report.format?.bit_rate ? Number(report.format.bit_rate) : null, container: report.format?.format_name ?? "unknown", sizeBytes };
}

export async function assertNonZeroSignal(path: string): Promise<void> {
  const { stderr } = await exec("ffmpeg", ["-v", "info", "-i", path, "-af", "volumedetect", "-f", "null", "-"]);
  const max = stderr.match(/max_volume:\s*([^\s]+)/)?.[1];
  if (!max || max === "-inf") throw new Error("Audio output has no detectable signal.");
}

export async function validateAudio(path: string) {
  const metadata = await probeAudio(path);
  await assertNonZeroSignal(path);
  return metadata;
}

export interface SeparationEngineMetadata { id?: string; engine: string; model: string; modelVersion?: string; version?: string; requestedDevice: string; resolvedDevice: string; }
export interface ValidatedStem { stemType: StemType; path: string; metadata: AudioMetadata; checksumSha256: string; }
export interface SeparationEngine { prepare(inputPath: string): Promise<void>; separate(inputPath: string, outputDirectory: string): Promise<SeparationEngineMetadata>; validate(outputDirectory: string): Promise<ValidatedStem[]>; cleanup(): Promise<void>; }

export { exec };
