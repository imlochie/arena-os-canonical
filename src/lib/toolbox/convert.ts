/**
 * The Toolbox — local file conversion, no websites.
 *
 * Every conversion runs on this machine through the bundled ffmpeg (the same
 * binary Waveyard uses — static build with libx264/x265/vpx/mp3lame/opus/
 * webp). Nothing is uploaded anywhere, ever.
 *
 * The speed story (honest, each part live-provable):
 *   1. HARDWARE encode when the machine has an encoder (vaapi/videotoolbox/
 *      nvenc/amf are probed with a real 1-frame encode); software otherwise —
 *      the engine used is recorded on every job.
 *   2. Audio stream-copy when source and target codecs already agree.
 *   3. No pointless scaling: presets only downscale, never up.
 *   4. Instant remux for container changes (-c copy, zero quality loss).
 *   5. A small parallel queue (images run alongside, video serially).
 */

import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readdir, rm, stat, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { execTool, requireTool } from "../waveyard/ffmpeg";
import { buildPresetArgs, presetCatalog, type PresetId, type PresetSpec } from "./presets";

export const TOOLBOX_ROOT = join(process.cwd(), ".arena-data", "toolbox");
export const TOOLBOX_IN = join(TOOLBOX_ROOT, "in");
export const TOOLBOX_OUT = join(TOOLBOX_ROOT, "out");
export const MAX_INPUT_BYTES = 2 * 1024 * 1024 * 1024; // 2 GB
export const MAX_QUEUE = 16;
const JOB_TIMEOUT_MS = 30 * 60 * 1000;

export type ToolKind = "video" | "audio" | "image";

export type SourceProbe = {
  kind: ToolKind;
  durationSec: number | null;
  videoCodec: string | null;
  audioCodec: string | null;
  width: number | null;
  height: number | null;
  formatName: string | null;
};

export type ConvertJob = {
  id: string;
  presetId: PresetId | "custom";
  presetLabel: string;
  kind: ToolKind;
  inputPath: string;
  inputName: string;
  outputName: string;
  outputPath: string | null;
  status: "queued" | "running" | "done" | "failed";
  progress: number | null; // 0..1
  speed: string | null; // "12.4x"
  engine: string; // "hardware:h264_vaapi" | "software:libx264"
  inputBytes: number;
  outputBytes: number | null;
  outDurationSec: number | null;
  outCodec: string | null;
  error: string | null;
  createdAt: string;
  finishedAt: string | null;
  custom: { width?: number; fps?: number; quality?: number; targetExt?: string } | null;
};

const jobs = new Map<string, ConvertJob>();
const runningVideo = { count: 0 };
const runningImage = { count: 0 };

/* ------------------------------ storage ---------------------------------- */

export async function ensureToolboxDirs(): Promise<void> {
  await mkdir(TOOLBOX_IN, { recursive: true });
  await mkdir(TOOLBOX_OUT, { recursive: true });
}

/** Only paths directly inside the toolbox input dir are ever accepted. */
export function isToolboxInputPath(path: string): boolean {
  const root = resolve(TOOLBOX_IN) + sep;
  const resolved = resolve(path);
  return resolved.startsWith(root) && !resolved.slice(root.length).includes("..") && !resolved.slice(root.length).includes(sep + "..");
}

export function sanitizeName(name: string): string {
  return (
    name
      .replace(/[/\\]/g, "_")
      .replace(/[^\w .()-]/g, "")
      .trim()
      .slice(0, 120) || "file"
  );
}

export async function storeUpload(input: { name: string; bytes: Uint8Array }): Promise<{ path: string; name: string; size: number; sha256: string }> {
  await ensureToolboxDirs();
  const name = sanitizeName(input.name);
  const hash = createHash("sha256").update(input.bytes).digest("hex").slice(0, 16);
  const unique = `${hash}-${randomUUID().slice(0, 8)}-${name}`;
  const path = join(TOOLBOX_IN, unique);
  await writeFile(path, input.bytes);
  return { path, name, size: input.bytes.byteLength, sha256: hash };
}

/** Best-effort cleanup of inputs/outputs older than cutoffMs. */
export async function pruneToolboxFiles(cutoffMs = 24 * 3600 * 1000): Promise<void> {
  const cutoff = Date.now() - cutoffMs;
  for (const dir of [TOOLBOX_IN, TOOLBOX_OUT]) {
    if (!existsSync(dir)) continue;
    for (const entry of await readdir(dir)) {
      const path = join(dir, entry);
      try {
        const info = await stat(path);
        if (info.isFile() && info.mtimeMs < cutoff) await rm(path, { force: true });
      } catch {
        /* best effort */
      }
    }
  }
}

/* ------------------------------- probing --------------------------------- */

export async function probeSource(path: string): Promise<SourceProbe> {
  const { stdout } = await execTool("ffprobe", [
    "-v", "error",
    "-print_format", "json",
    "-show_format",
    "-show_streams",
    path,
  ]);
  return parseProbe(stdout);
}

/** Separated for direct testing of the honest kind-detection logic. */
export function parseProbe(stdout: string): SourceProbe {
  const parsed = JSON.parse(stdout) as {
    format?: { duration?: string; format_name?: string };
    streams?: Array<{ codec_type?: string; codec_name?: string; width?: number; height?: number; duration?: string }>;
  };
  const streams = parsed.streams ?? [];
  const video = streams.find((s) => s.codec_type === "video");
  const audio = streams.find((s) => s.codec_type === "audio");
  const formatName = parsed.format?.format_name ?? null;
  const hasVideo = Boolean(video);
  const hasAudio = Boolean(audio);
  // An image is a video stream without audio in an image2-family container
  // (ffmpeg reports single-frame pngs/jpegs as image2 / image2pipe / webp…).
  const imageContainer = (formatName ?? "").split(",").some((f) => f.startsWith("image2") || f === "png_pipe" || f === "webp_pipe" || f === "jpeg_pipe" || f === "gif");
  const still = hasVideo && !hasAudio && (imageContainer || !parsed.format?.duration);
  const kind: ToolKind = still ? "image" : hasAudio && !hasVideo ? "audio" : "video";
  return {
    kind,
    durationSec: parsed.format?.duration ? Number(parsed.format.duration) : video?.duration ? Number(video.duration) : null,
    videoCodec: video?.codec_name ?? null,
    audioCodec: audio?.codec_name ?? null,
    width: video?.width ?? null,
    height: video?.height ?? null,
    formatName,
  };
}

/* --------------------------- hardware detection --------------------------- */

type HwState = { probed: boolean; encoder: string | null };
const hwState: HwState = { probed: false, encoder: null };

/**
 * Probe hardware encoders with REAL one-frame encodes (lavfi color source).
 * First encoder that works wins; cached for the process. A machine without
 * GPU (like a CI sandbox) honestly gets null.
 */
export async function detectHardwareEncoder(): Promise<string | null> {
  if (hwState.probed) return hwState.encoder;
  hwState.probed = true;
  const candidates: string[] =
    process.platform === "darwin"
      ? ["h264_videotoolbox"]
      : process.platform === "win32"
        ? ["h264_nvenc", "h264_amf", "h264_qsv"]
        : ["h264_vaapi"];
  for (const encoder of candidates) {
    const extra =
      encoder === "h264_vaapi"
        ? ["-init_hw_device", "vaapi=va:/dev/dri/renderD128", "-filter_hw_device", "va"]
        : [];
    try {
      await execTool("ffmpeg", [
        "-hide_banner",
        ...extra,
        "-f", "lavfi", "-i", "color=black:s=64x64:d=0.04",
        "-c:v", encoder,
        "-f", "null", "-",
      ]);
      hwState.encoder = encoder;
      return encoder;
    } catch {
      /* try next */
    }
  }
  return null;
}

/* -------------------------------- jobs ----------------------------------- */

export function listJobs(): ConvertJob[] {
  return [...jobs.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export function getJob(id: string): ConvertJob | null {
  return jobs.get(id) ?? null;
}

/** Spawn ffmpeg with live progress (-progress pipe:1) and a hard timeout. */
function runFfmpegWithProgress(
  args: string[],
  totalUs: number | null,
  onProgress: (update: { fraction: number | null; speed: string | null }) => void,
): Promise<void> {
  return new Promise<void>((resolvePromise, rejectPromise) => {
    void requireTool("ffmpeg").then((binary) => {
      const child = spawn(binary.path, ["-hide_banner", "-y", "-nostats", "-progress", "pipe:1", ...args], {
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      });
      let stderrTail = "";
      let outTimeUs: number | null = null;
      let speed: string | null = null;
      const timer = setTimeout(() => {
        child.kill("SIGKILL");
        rejectPromise(new Error("conversion timed out (30 min)"));
      }, JOB_TIMEOUT_MS);
      child.stdout.on("data", (chunk: Buffer) => {
        for (const line of String(chunk).split("\n")) {
          const [key, value] = line.split("=");
          if (!key || value === undefined) continue;
          if (key === "out_time_us" || key === "out_time_ms") {
            outTimeUs = Number(value) * (key === "out_time_ms" ? 1000 : 1);
          } else if (key === "speed") {
            speed = value.trim();
          } else if (key === "progress" && value.trim() !== "start") {
            const fraction = totalUs && outTimeUs !== null && outTimeUs > 0 ? Math.min(1, outTimeUs / totalUs) : null;
            onProgress({ fraction, speed });
          }
        }
      });
      child.stderr.on("data", (chunk: Buffer) => {
        stderrTail = (stderrTail + String(chunk)).slice(-1500);
      });
      child.once("error", (error) => {
        clearTimeout(timer);
        rejectPromise(error);
      });
      child.once("close", (code) => {
        clearTimeout(timer);
        if (code === 0) resolvePromise();
        else rejectPromise(new Error(`ffmpeg exited ${code}: ${stderrTail.slice(-600)}`));
      });
    }, rejectPromise);
  });
}

export async function createConversionJob(input: {
  path: string;
  name: string;
  presetId: PresetId | "custom";
  custom?: { width?: number; fps?: number; quality?: number; targetExt?: string };
}): Promise<ConvertJob> {
  if (!isToolboxInputPath(input.path)) {
    throw new Error("Input path must live in the toolbox upload directory.");
  }
  if (!existsSync(input.path)) throw new Error("Input file not found.");
  const info = await stat(input.path);
  if (info.size <= 0 || info.size > MAX_INPUT_BYTES) throw new Error("Input must be between 1 byte and 2 GB.");
  if (jobs.size >= MAX_QUEUE) throw new Error("Toolbox queue is full (16 jobs).");

  await ensureToolboxDirs();
  await pruneToolboxFiles().catch(() => {});

  let probe;
  try {
    probe = await probeSource(input.path);
  } catch (error) {
    throw new Error(
      `This file can't be read as media: ${String((error as Error)?.message ?? error).slice(0, 160)}`,
    );
  }
  const hw = await detectHardwareEncoder();
  const preset: PresetSpec | undefined =
    input.presetId === "custom" ? undefined : presetCatalog().find((p) => p.id === input.presetId);
  if (input.presetId !== "custom" && !preset) throw new Error(`Unknown preset "${input.presetId}".`);

  // Custom jobs may only write formats this engine actually knows how to build.
  const CUSTOM_TARGET_EXTS = new Set(["mp4", "mkv", "webm"]);
  const requestedExt = (input.custom?.targetExt ?? "mp4").replace(/[^a-z0-9]/gi, "").toLowerCase();
  if (!CUSTOM_TARGET_EXTS.has(requestedExt)) {
    throw new Error(`Custom output must be one of: ${[...CUSTOM_TARGET_EXTS].join(", ")}.`);
  }
  const targetExt = preset ? preset.targetExt : requestedExt;
  const baseName = sanitizeName(input.name).replace(/\.[^.]+$/, "");
  const outputName = `${baseName}.${targetExt}`;
  const outputPath = join(TOOLBOX_OUT, `${randomUUID().slice(0, 8)}-${outputName}`);

  const job: ConvertJob = {
    id: randomUUID(),
    presetId: input.presetId,
    presetLabel: preset ? preset.label : "Custom",
    kind: preset?.kind ?? probe.kind,
    inputPath: input.path,
    inputName: input.name,
    outputName,
    outputPath,
    status: "queued",
    progress: null,
    speed: null,
    engine: "pending",
    inputBytes: info.size,
    outputBytes: null,
    outDurationSec: null,
    outCodec: null,
    error: null,
    createdAt: new Date().toISOString(),
    finishedAt: null,
    custom: input.custom ?? null,
  };
  jobs.set(job.id, job);
  drainQueue();
  return job;
}

function drainQueue(): void {
  const queued = [...jobs.values()].filter((j) => j.status === "queued");
  for (const job of queued) {
    const isImage = job.kind === "image";
    if (isImage ? runningImage.count >= 2 : runningVideo.count >= 1) continue;
    void executeJob(job);
  }
}

async function executeJob(job: ConvertJob): Promise<void> {
  const isImage = job.kind === "image";
  if (isImage) runningImage.count += 1;
  else runningVideo.count += 1;
  job.status = "running";
  try {
    const probe = await probeSource(job.inputPath);
    const hw = await detectHardwareEncoder();
    const built = buildPresetArgs(job.presetId, {
      input: job.inputPath,
      output: job.outputPath!,
      source: probe,
      hw,
      custom: job.custom ?? undefined,
    });
    job.engine = built.engine;
    const totalUs = probe.durationSec ? probe.durationSec * 1_000_000 : null;
    await runFfmpegWithProgress(built.args, totalUs, ({ fraction, speed }) => {
      if (fraction !== null) job.progress = fraction;
      if (speed) job.speed = speed;
    });
    const outInfo = await stat(job.outputPath!).catch(() => null);
    if (!outInfo) throw new Error("ffmpeg finished but no output file was produced.");
    job.outputBytes = outInfo.size;
    const outProbe = await probeSource(job.outputPath!).catch(() => null);
    job.outDurationSec = outProbe?.durationSec ?? null;
    job.outCodec = outProbe?.videoCodec ?? outProbe?.audioCodec ?? null;
    job.status = "done";
    job.progress = 1;
  } catch (error) {
    job.status = "failed";
    job.error = String((error as Error)?.message ?? error).slice(0, 500);
    await rm(job.outputPath!, { force: true }).catch(() => {});
  } finally {
    if (isImage) runningImage.count -= 1;
    else runningVideo.count -= 1;
    job.finishedAt = new Date().toISOString();
    drainQueue();
  }
}

export async function deleteJob(id: string): Promise<boolean> {
  const job = jobs.get(id);
  if (!job) return false;
  if (job.status === "running") return false;
  jobs.delete(id);
  await rm(job.outputPath!, { force: true }).catch(() => {});
  await rm(job.inputPath, { force: true }).catch(() => {});
  return true;
}

/** Test-only: reset in-memory state between suites. */
export function resetToolboxForTests(): void {
  if (process.env.NODE_ENV === "production") throw new Error("test helper refused in production");
  jobs.clear();
  runningVideo.count = 0;
  runningImage.count = 0;
  hwState.probed = false;
  hwState.encoder = null;
}
