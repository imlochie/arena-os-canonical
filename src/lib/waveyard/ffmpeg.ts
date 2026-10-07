/**
 * FFmpeg/FFprobe resolution — the single place binaries are discovered.
 *
 * Order (audited in docs/desktop-runtime-plan.md §3):
 *  1. ARENA_FFMPEG_PATH / ARENA_FFPROBE_PATH env (packaged mode: the
 *     desktop supervisor passes explicit paths to bundled binaries)
 *  2. @ffmpeg-installer / @ffprobe-installer (npm platform packages)
 *  3. PATH (development convenience)
 *
 * Every invocation in the app spawns `path + args[]` — never a shell.
 * A missing binary is a hard, named error; nothing silently degrades.
 */

import { spawn } from "node:child_process";
import { access } from "node:fs/promises";
import { constants } from "node:fs";
import { createRequire } from "node:module";

export type FfmpegTool = "ffmpeg" | "ffprobe";

export type ResolvedBinary = {
  tool: FfmpegTool;
  path: string;
  source: "env" | "installer" | "path";
};

async function executable(path: string): Promise<boolean> {
  try {
    await access(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function installerPath(packageName: string): string | null {
  try {
    // createRequire keeps this a runtime-optional dependency: a missing
    // platform package degrades to PATH instead of crashing the server.
    const require = createRequire(import.meta.url);
    const resolved = require(packageName) as { path?: string };
    return typeof resolved?.path === "string" ? resolved.path : null;
  } catch {
    return null;
  }
}

async function resolveTool(tool: FfmpegTool): Promise<ResolvedBinary | null> {
  const envName = tool === "ffmpeg" ? "ARENA_FFMPEG_PATH" : "ARENA_FFPROBE_PATH";
  const envPath = process.env[envName];
  if (envPath !== undefined && envPath !== "" && (await executable(envPath))) {
    return { tool, path: envPath, source: "env" };
  }
  const installer = installerPath(tool === "ffmpeg" ? "@ffmpeg-installer/ffmpeg" : "@ffprobe-installer/ffprobe");
  if (installer !== null && (await executable(installer))) {
    return { tool, path: installer, source: "installer" };
  }
  // PATH discovery: only claim it if the binary actually executes.
  const version = await toolVersion(tool === "ffmpeg" ? "ffmpeg" : "ffprobe");
  if (version !== null) return { tool, path: tool === "ffmpeg" ? "ffmpeg" : "ffprobe", source: "path" };
  return null;
}

const resolvedCache = new Map<FfmpegTool, ResolvedBinary | null>();

/** Resolve (and cache) the active binary for a tool. */
export async function resolveToolPath(tool: FfmpegTool): Promise<ResolvedBinary | null> {
  if (!resolvedCache.has(tool)) {
    resolvedCache.set(tool, await resolveTool(tool));
  }
  return resolvedCache.get(tool) ?? null;
}

export function clearResolvedToolCache(): void {
  resolvedCache.clear();
}

export class FfmpegMissingError extends Error {
  readonly errorCode = "DEPENDENCY_MISSING" as const;
  constructor(tool: FfmpegTool) {
    super(
      `${tool} is not available to Arena. Set ARENA_${tool.toUpperCase()}_PATH to a bundled binary ` +
        `(the desktop app does this automatically), install the @${tool}-installer platform package, ` +
        `or put ${tool} on the PATH.`,
    );
    this.name = "FfmpegMissingError";
  }
}

/** Require a binary or throw the honest named error. */
export async function requireTool(tool: FfmpegTool): Promise<ResolvedBinary> {
  const resolved = await resolveToolPath(tool);
  if (resolved === null) throw new FfmpegMissingError(tool);
  return resolved;
}

export type ExecResult = { stdout: string; stderr: string };

/** Run a tool with an argument array. No shell, ever. */
export async function execTool(tool: FfmpegTool, args: string[], options: { timeoutMs?: number } = {}): Promise<ExecResult> {
  const binary = await requireTool(tool);
  return new Promise<ExecResult>((resolve, reject) => {
    const child = spawn(binary.path, args, {
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
      timeout: options.timeoutMs ?? 120_000,
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += String(chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += String(chunk);
    });
    child.once("error", (error) => reject(error));
    child.once("close", (code) => {
      if (code === 0) resolve({ stdout, stderr });
      else reject(new Error(`${tool} exited ${code}: ${stderr.slice(-1200)}`));
    });
  });
}

/** Best-effort `-version` probe (used for resolution + diagnostics). */
export async function toolVersion(pathOrTool: string): Promise<string | null> {
  const run = (target: string) =>
    new Promise<string | null>((resolve) => {
      const child = spawn(target, ["-version"], { stdio: ["ignore", "pipe", "ignore"], windowsHide: true, timeout: 15_000 });
      let stdout = "";
      child.stdout.on("data", (chunk: Buffer) => {
        stdout += String(chunk);
      });
      child.once("error", () => resolve(null));
      child.once("close", (code) => {
        if (code !== 0) {
          resolve(null);
          return;
        }
        const match = /version\s+(\S+)/.exec(stdout);
        resolve(match === null ? "unknown" : match[1]);
      });
    });
  return run(pathOrTool);
}
