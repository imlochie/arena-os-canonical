/**
 * PCM decoding for cleanup/analysis — native 16-bit WAV decode with an
 * ffmpeg fallback for compressed formats. When ffmpeg is genuinely absent
 * the caller receives an honest DEPENDENCY_MISSING error naming exactly
 * what is missing. Nothing silently degrades.
 */

import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";

import { decodeWav16 } from "../mixer/synth";
import { resolveToolPath } from "../ffmpeg";

export type DecodedSource = {
  /** Interleaved stereo f32 [-1, 1]. */
  pcm: Float32Array;
  sampleRate: number;
};

export class DependencyMissingError extends Error {
  readonly errorCode = "DEPENDENCY_MISSING" as const;
  constructor(message: string) {
    super(message);
    this.name = "DependencyMissingError";
  }
}

const MAX_DECODE_BYTES = 2 * 4 * 44_100 * 60 * 15; // 15 min stereo f32 cap

/** Test seam: how the ffmpeg binary is located. Production resolves through
 *  the product's central resolver (env override → bundled installer package
 *  → PATH) — a PATH-only probe would miss the desktop app's packaged ffmpeg. */
export type FfmpegResolver = () => Promise<string | null>;

async function defaultResolveFfmpeg(): Promise<string | null> {
  const resolved = await resolveToolPath("ffmpeg");
  return resolved !== null ? resolved.path : null;
}

export async function decodeSourceToStereoPcm(
  filePath: string,
  hint: { sampleRate?: number } = {},
  deps: { resolveFfmpeg?: FfmpegResolver } = {},
  opts: { requireSampleRate?: number } = {},
): Promise<DecodedSource> {
  // 1. Native WAV path — no external dependency. When the caller needs a
  //    specific rate (the separation engine is trained at 44.1 kHz), a
  //    native decode at a different rate is NOT acceptable output: fall
  //    through to the ffmpeg path, which resamples (-ar 44100).
  const bytes = await readFile(filePath).catch(() => null);
  if (bytes !== null) {
    const decoded = decodeWav16(new Uint8Array(bytes));
    if (decoded !== null) {
      const nativeRate = decoded.sampleRate || hint.sampleRate || 44_100;
      const rateAcceptable = opts.requireSampleRate === undefined || nativeRate === opts.requireSampleRate;
      if (rateAcceptable) {
        return {
          pcm: decoded.channels === 2 ? decoded.samples : monoToStereo(decoded.samples),
          sampleRate: nativeRate,
        };
      }
    }
  }

  // 2. ffmpeg fallback for compressed formats (and rate conversion).
  const ffmpeg = await (deps.resolveFfmpeg ?? defaultResolveFfmpeg)();
  if (ffmpeg === null) {
    const rateNote =
      opts.requireSampleRate !== undefined
        ? ` This source decodes natively at a different sample rate than the required ${opts.requireSampleRate} Hz; conversion needs ffmpeg.`
        : "";
    throw new DependencyMissingError(
      "ffmpeg is not available on this machine and the source is not a 16-bit PCM WAV. " +
        "Cleanup analysis needs decodable PCM: install ffmpeg, or import the source as WAV." +
        rateNote,
    );
  }
  return decodeWithFfmpeg(ffmpeg, filePath);
}

function monoToStereo(samples: Float32Array): Float32Array {
  const out = new Float32Array(samples.length * 2);
  for (let i = 0; i < samples.length; i += 1) {
    out[i * 2] = samples[i];
    out[i * 2 + 1] = samples[i];
  }
  return out;
}

function decodeWithFfmpeg(command: string, filePath: string): Promise<DecodedSource> {
  return new Promise<DecodedSource>((resolve, reject) => {
    const child = spawn(
      command,
      ["-i", filePath, "-ac", "2", "-ar", "44100", "-f", "f32le", "-"],
      { stdio: ["ignore", "pipe", "ignore"] },
    );
    const chunks: Buffer[] = [];
    let total = 0;
    child.stdout.on("data", (chunk: Buffer) => {
      if (total + chunk.length > MAX_DECODE_BYTES) {
        child.kill("SIGKILL");
        reject(new Error("Source exceeds the 15-minute cleanup decode limit."));
        return;
      }
      chunks.push(chunk);
      total += chunk.length;
    });
    child.once("error", (error) => reject(error));
    child.once("close", (code) => {
      if (code !== 0) {
        reject(new Error(`ffmpeg exited ${code} while decoding the source.`));
        return;
      }
      const buffer = Buffer.concat(chunks);
      const pcm = new Float32Array(buffer.length / 4);
      for (let i = 0; i < pcm.length; i += 1) pcm[i] = buffer.readFloatLE(i * 4);
      resolve({ pcm, sampleRate: 44_100 });
    });
  });
}
