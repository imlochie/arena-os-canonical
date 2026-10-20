/**
 * FFmpeg/FFprobe resolution — the single place binaries are discovered.
 *
 * Order (audited in docs/desktop-runtime-plan.md §3):
 *  1. ARENA_FFMPEG_PATH / ARENA_FFPROBE_PATH env (packaged mode: the
 *     desktop supervisor passes explicit paths to bundled binaries)
 *  2. ARENA_APP_BIN_DIR (the packaged app's bin/)
 *  3. @ffmpeg-installer / @ffprobe-installer (npm platform packages)
 *  4. system PATH - secondary, reported as source "system", absolute path
 *
 * Every invocation in the app spawns `path + args[]` — never a shell.
 * A missing binary is a hard, named error; nothing silently degrades.
 */

import { spawn } from "node:child_process";
import { access } from "node:fs/promises";
import { constants, existsSync } from "node:fs";
import { createRequire } from "node:module";
import { delimiter, dirname, join } from "node:path";

import { resolveExecutable } from "@/lib/capabilities/resolver";

export type FfmpegTool = "ffmpeg" | "ffprobe";

export type ResolvedBinary = {
  tool: FfmpegTool;
  path: string;
  source: "env" | "bundled" | "installer" | "system";
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
    // Works in plain node (tests, worker processes).
    const require = createRequire(import.meta.url);
    const resolved = require(packageName) as { path?: string };
    return typeof resolved?.path === "string" ? resolved.path : null;
  } catch {
    // Bundled contexts (Turbopack dev / standalone server) rewrite
    // createRequire and reject dynamic module names ("expression is too
    // dynamic") — proven live. Fall through to filesystem discovery.
  }
  return installerPathFromFileSystem(packageName);
}

/**
 * Bundler-proof tier-2 discovery: the installer packages have a fixed
 * layout (node_modules/@ffprobe-installer/<platform>/<binary>), so probe
 * the filesystem directly — no require, nothing for a bundler to rewrite.
 * Anchors: the process working directory (dev server: repo root; packaged
 * server: the standalone tree, where desktop-dist traces the packages).
 */
function installerPathFromFileSystem(packageName: string): string | null {
  // The npm layout is node_modules/@ffprobe-installer/linux-x64/ffprobe —
  // the PLATFORM package is a sibling of the wrapper, not a child of it
  // (verified live: the wrapper's own createRequire resolves exactly this).
  const tool = packageName.endsWith("ffmpeg") ? "ffmpeg" : "ffprobe";
  const scope = packageName.startsWith("@") ? packageName.slice(0, packageName.indexOf("/")) : "";
  const platformDir =
    process.platform === "win32" ? "win32-x64"
    : process.platform === "darwin" ? (process.arch === "arm64" ? "darwin-arm64" : "darwin-x64")
    : process.arch === "arm64" ? "linux-arm64" : "linux-x64";
  const binary = tool + (process.platform === "win32" ? ".exe" : "");
  const candidates = [
    join(process.cwd(), "node_modules", scope, platformDir, binary),
    join(process.cwd(), "node_modules", packageName, platformDir, binary),
    join(process.cwd(), "node_modules", packageName, binary),
  ];
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

async function resolveTool(tool: FfmpegTool): Promise<ResolvedBinary | null> {
  const envName = tool === "ffmpeg" ? "ARENA_FFMPEG_PATH" : "ARENA_FFPROBE_PATH";
  const local = resolveExecutable(tool, { envVar: envName, allowSystem: false });
  if (local !== null && (await executable(local.path))) return { tool, path: local.path, source: local.source as "env" | "bundled" };
  const installer = installerPath(tool === "ffmpeg" ? "@ffmpeg-installer/ffmpeg" : "@ffprobe-installer/ffprobe");
  if (installer !== null && (await executable(installer))) {
    return { tool, path: installer, source: "installer" };
  }
  // System fallback: absolute path, and only claimed if it actually executes.
  const system = resolveExecutable(tool);
  if (system !== null && (await toolVersion(system.path)) !== null) return { tool, path: system.path, source: "system" };
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
        `or install ${tool} on the system PATH (fallback only).`,
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
export async function execTool(tool: FfmpegTool, args: string[], options: { timeoutMs?: number; signal?: AbortSignal; maxOutputBytes?: number } = {}): Promise<ExecResult> {
  const binary = await requireTool(tool);
  return new Promise<ExecResult>((resolve, reject) => {
    const child = spawn(binary.path, args, {
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
      signal: options.signal,
    });
    let stdout = "";
    let stderr = "";
    let outputBytes = 0;
    let executionError: Error | undefined;
    let forceKill: ReturnType<typeof setTimeout> | undefined;
    const escalate = () => {
      // Allow normal trailer/cleanup handlers, but stopped/TERM-ignoring tools
      // must not hold cancellation or timeout indefinitely.
      forceKill ??= setTimeout(() => child.kill("SIGKILL"), 1000);
      forceKill.unref();
    };
    const terminate = () => { child.kill("SIGTERM"); escalate(); };
    const timeoutMs = options.timeoutMs ?? 120_000;
    const deadline = timeoutMs > 0 ? setTimeout(() => { executionError ??= new Error(`${tool} timed out after ${timeoutMs}ms; partial output was not certified.`); terminate(); }, timeoutMs) : undefined;
    deadline?.unref();
    const bounded = (chunk: Buffer) => {
      outputBytes += chunk.byteLength;
      if (options.maxOutputBytes && outputBytes > options.maxOutputBytes) { executionError ??= new Error("Media tool diagnostic output exceeded its bounded limit."); terminate(); return false; }
      return !options.maxOutputBytes || outputBytes <= options.maxOutputBytes;
    };
    child.stdout.on("data", (chunk: Buffer) => {
      if (bounded(chunk)) stdout += String(chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      if (bounded(chunk)) stderr += String(chunk);
    });
    // Abort emits error before the process actually exits. Consumers may remove
    // temporary inputs only once close confirms child/stdio termination.
    child.once("error", (error) => { executionError ??= error; if (error.name === "AbortError") escalate(); });
    child.once("close", (code, signal) => {
      clearTimeout(deadline); if (forceKill) clearTimeout(forceKill);
      if (executionError) reject(executionError);
      else if (code === 0) resolve({ stdout, stderr });
      else reject(new Error(`${tool} exited ${code ?? signal}: ${stderr.slice(-1200)}`));
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


/** CLI libraries (Demucs) launch ffmpeg/ffprobe by basename. Give those child
 * processes Arena's resolved native tools, not an accidental system install. */
export async function audioToolEnvironment(env: NodeJS.ProcessEnv = process.env): Promise<NodeJS.ProcessEnv> {
  const tools = await Promise.all([requireTool("ffmpeg"), requireTool("ffprobe")]);
  const key = Object.keys(env).find(name => name.toLowerCase() === "path") ?? "PATH";
  const directories = [...new Set(tools.map(tool => dirname(tool.path)))];
  return { ...env, [key]: [...directories, env[key] ?? ""].join(delimiter), PYTHONUNBUFFERED: "1", PYTHONIOENCODING: "utf-8" };
}
