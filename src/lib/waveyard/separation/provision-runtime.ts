/**
 * Deep-engine provisioning — the RUNTIME executors (the machine
 * operations behind the plan). Every operation here is a primitive
 * the preparation manager sequences; the plan itself is pure
 * (provision.ts) and the lifecycle/persistence is provision-store.ts.
 *
 * Security properties (mandate §6), each tested:
 *  - Argument-array process spawning — never a shell, never string
 *    interpolation, so spaces and Unicode in Windows paths are safe.
 *  - Trusted-source downloads only: an explicit host allowlist,
 *    HTTPS enforced, and redirects validated against the same list.
 *  - Bounded network: connection + overall timeouts, a max byte cap.
 *  - Integrity before trust: a download is verified (sha256) BEFORE
 *    it is atomically placed; a wrong or truncated file never becomes
 *    the engine's input.
 *  - Cancellation: every long operation honours an AbortSignal and
 *    kills its child; a cancelled run leaves no half-installed state
 *    reported as ready.
 *  - Honest failures: exit codes and a bounded diagnostic tail are
 *    captured; no subprocess environment is ever logged.
 */

import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { existsSync } from "node:fs";
import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";

import { deepModelSpec } from "./modes";
import { decodeWav16 } from "../mixer/synth";
import { checksumFile } from "../audio";
import { audioToolEnvironment, resolveToolPath } from "@/lib/waveyard/ffmpeg";
import {
  DEEP_CHECKPOINT_FILE,
  deepCheckpointPath,
  resolveDeepEnvDir,
} from "./deep";
import { resolveModelsDir } from "./session";
import {
  DEMUCS_VERSION,
  MANAGED_PYTHON_VERSION,
  PYPI_INDEX,
  PYTORCH_CPU_INDEX,
  TORCHAUDIO_VERSION,
  TORCH_VERSION,
  interpreterIsCompatible,
  type DiscoveredPython,
  type EnvironmentReport,
} from "./provision";

// ----------------------------------------------------------------- errors

export class ProvisionError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "ProvisionError";
    this.code = code;
  }
}

export class ProvisionCancelledError extends ProvisionError {
  constructor() {
    super("PROVISION_CANCELLED", "Preparation was cancelled.");
    this.name = "ProvisionCancelledError";
  }
}

// ------------------------------------------------------------ seams/context

export type RunOutcome = {
  status: number | null;
  stdout: string;
  stderr: string;
  error: Error | null;
};

export type RunProcess = (
  bin: string,
  args: readonly string[],
  opts: {
    cwd?: string;
    env?: NodeJS.ProcessEnv;
    timeoutMs: number;
    signal?: AbortSignal;
    onStderr?: (chunk: string) => void;
  },
) => Promise<RunOutcome>;

export type FetchLike = (url: string, init?: { signal?: AbortSignal }) => Promise<Response>;

export type ProvisionContext = {
  /** Aborts the whole preparation (owner cancelled). */
  signal?: AbortSignal;
  /** Sanitized progress/log sink (never a subprocess environment). */
  log: (line: string) => void;
  runProcess?: RunProcess;
  fetch?: FetchLike;
};

// ------------------------------------------------------------- process run

/** The default process runner: argument-array spawn, bounded by a
 *  timeout and a cancellation signal. Never uses a shell. */
export const defaultRunProcess: RunProcess = (bin, args, opts) =>
  new Promise((resolvePromise) => {
    const child = spawn(bin, [...args], {
      cwd: opts.cwd,
      env: opts.env,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    let processError: Error | null = null;
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, opts.timeoutMs);
    const cancel = () => {
      timedOut = true;
      child.kill("SIGKILL");
    };
    if (opts.signal !== undefined) {
      if (opts.signal.aborted) cancel();
      else opts.signal.addEventListener("abort", cancel, { once: true });
    }
    child.stdout?.on("data", (chunk: Buffer) => {
      stdout = (stdout + chunk.toString()).slice(-16384);
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      const text = chunk.toString();
      stderr = (stderr + text).slice(-16384);
      opts.onStderr?.(text);
    });
    const finish = (outcome: RunOutcome) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      opts.signal?.removeEventListener("abort", cancel);
      resolvePromise(outcome);
    };
    child.once("error", (error) => { processError = error; });
    child.once("close", (code) =>
      finish({
        status: code,
        stdout,
        stderr,
        error: processError ?? (timedOut && code === null ? new Error(`timed out after ${Math.round(opts.timeoutMs / 1000)}s`) : null),
      }),
    );
  });

function throwIfCancelled(ctx: ProvisionContext): void {
  if (ctx.signal?.aborted) throw new ProvisionCancelledError();
}

/** Run a process and throw a typed ProvisionError when it fails. */
async function mustRun(
  ctx: ProvisionContext,
  bin: string,
  args: readonly string[],
  opts: { cwd?: string; env?: NodeJS.ProcessEnv; timeoutMs: number; code: string; label: string; onStderr?: (chunk: string) => void },
): Promise<string> {
  const run = ctx.runProcess ?? defaultRunProcess;
  const outcome = await run(bin, args, { cwd: opts.cwd, env: opts.env, timeoutMs: opts.timeoutMs, signal: ctx.signal, onStderr: opts.onStderr });
  if (outcome.error !== null) {
    if (ctx.signal?.aborted) throw new ProvisionCancelledError();
    throw new ProvisionError(opts.code, `${opts.label} could not run: ${outcome.error.message}`);
  }
  if (outcome.status !== 0) {
    if (ctx.signal?.aborted) throw new ProvisionCancelledError();
    const tail = (outcome.stderr || outcome.stdout).trim().slice(-800);
    throw new ProvisionError(opts.code, `${opts.label} failed (exit ${outcome.status}): ${tail}`);
  }
  return outcome.stdout;
}

// ------------------------------------------------- trusted-source downloads

/** Hosts Arena is willing to fetch engine artifacts from. The list
 *  is closed and upstream-authoritative: Demucs' own model store,
 *  the CPython distribution, and the package indexes. Anything
 *  else — including a lookalike domain — is refused before a byte
 *  is fetched. */
export const TRUSTED_DOWNLOAD_HOSTS: readonly string[] = [
  "dl.fbaipublicfiles.com", // Demucs' official model store (Meta)
  "www.python.org", // the official CPython distribution
  "pypi.org",
  "files.pythonhosted.org", // PyPI package files
  "download.pytorch.org", // PyTorch's official wheel index
];

/** Validate a URL against the trusted-host policy: HTTPS only, host
 *  on the allowlist, no userinfo, no non-default port trickery. */
export function validateTrustedUrl(url: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new ProvisionError("UNTRUSTED_SOURCE", `Refusing to fetch a malformed URL: ${url}`);
  }
  if (parsed.protocol !== "https:") {
    throw new ProvisionError("UNTRUSTED_SOURCE", `Refusing to fetch over ${parsed.protocol} (only HTTPS): ${url}`);
  }
  if (parsed.port && parsed.port !== "443") throw new ProvisionError("UNTRUSTED_SOURCE", "Only the upstream HTTPS port is permitted.");
  if (parsed.username !== "" || parsed.password !== "") {
    throw new ProvisionError("UNTRUSTED_SOURCE", "Refusing to fetch a URL that carries credentials.");
  }
  if (!TRUSTED_DOWNLOAD_HOSTS.includes(parsed.hostname.toLowerCase())) {
    throw new ProvisionError("UNTRUSTED_SOURCE", `Refusing to fetch from untrusted host "${parsed.hostname}".`);
  }
  return parsed;
}

/** Fetch with trusted-host validation and a bounded timeout, and
 *  follow redirects only to other trusted hosts. */
export async function trustedFetch(
  url: string,
  opts: { fetch?: FetchLike; signal?: AbortSignal; timeoutMs?: number } = {},
): Promise<Response> {
  const doFetch = opts.fetch ?? ((target: string, init?: RequestInit) => fetch(target, { ...init, redirect: "manual" }));
  const timeoutMs = opts.timeoutMs ?? 60_000;
  const visit = async (target: string, redirects: number): Promise<Response> => {
    if (redirects > 5) {
      throw new ProvisionError("DOWNLOAD_FAILED", `Too many redirects fetching ${target}.`);
    }
    validateTrustedUrl(target);
    const controller = new AbortController();
    const overall = setTimeout(() => controller.abort(), timeoutMs);
    const onAbort = () => controller.abort();
    opts.signal?.addEventListener("abort", onAbort, { once: true });
    try {
      const response = await doFetch(target, { signal: controller.signal });
      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get("location");
        if (location === null) {
          throw new ProvisionError("DOWNLOAD_FAILED", `Redirect without a location (${response.status}).`);
        }
        // Re-validate the redirect target against the same policy.
        const next = new URL(location, target).toString();
        return await visit(next, redirects + 1);
      }
      if (!response.ok) {
        throw new ProvisionError("DOWNLOAD_FAILED", `The source refused the request (HTTP ${response.status}) for ${target}.`);
      }
      return response;
    } finally {
      clearTimeout(overall);
      opts.signal?.removeEventListener("abort", onAbort);
    }
  };
  return await visit(url, 0);
}

export type DownloadResult = { bytes: number; sha256: string };

/** Stream a trusted URL to a temp file, then return its size and
 *  sha256 — the caller places it atomically only after it verifies. */
export async function downloadToTemp(
  url: string,
  tempPath: string,
  opts: {
    ctx: ProvisionContext;
    expectedBytes?: number;
    maxBytes?: number;
    onProgress?: (done: number, total: number | null) => void;
  },
): Promise<DownloadResult> {
  const { ctx } = opts;
  throwIfCancelled(ctx);
  const response = await trustedFetch(url, { fetch: ctx.fetch, signal: ctx.signal, timeoutMs: 60_000 });
  const declared = Number(response.headers.get("content-length") ?? NaN);
  const total = Number.isFinite(declared) ? declared : null;
  // A declared length that is wildly off the expectation is refused
  // before any byte is written — an HTML error page or a moved file.
  if (total !== null && opts.expectedBytes !== undefined) {
    if (total < opts.expectedBytes * 0.5 || total > opts.expectedBytes * 1.5) {
      throw new ProvisionError(
        "DOWNLOAD_WRONG_SIZE",
        `The source reported ${total} bytes but the expected artifact is ~${opts.expectedBytes} — refusing.`,
      );
    }
  }
  if (response.body === null) {
    throw new ProvisionError("DOWNLOAD_FAILED", "The source returned an empty body.");
  }
  await mkdir(dirname(tempPath), { recursive: true });
  // Count bytes as they flow THROUGH the pipeline to the file — a
  // separate 'data' listener would put the source into flowing mode
  // and steal the bytes from the write stream (and an error on a
  // bare 'data' listener becomes an uncaught exception).
  let bytes = 0;
  const maxBytes = opts.maxBytes ?? 4_000_000_000;
  const counter = new Transform({
    transform(chunk: Buffer, _encoding: string, callback: (error?: Error | null, data?: Buffer) => void) {
      bytes += chunk.length;
      if (bytes > maxBytes) {
        callback(new Error("size cap exceeded"));
        return;
      }
      opts.onProgress?.(bytes, total);
      callback(null, chunk);
    },
  });
  const source = Readable.fromWeb(response.body as import("node:stream/web").ReadableStream);
  try {
    await pipeline(source, counter, createWriteStream(tempPath), { signal: ctx.signal ? AbortSignal.any([ctx.signal, AbortSignal.timeout(120_000)]) : AbortSignal.timeout(120_000) });
  } catch (error) {
    await rm(tempPath, { force: true }).catch(() => undefined);
    if (ctx.signal?.aborted) throw new ProvisionCancelledError();
    if (error instanceof ProvisionError) throw error;
    if (/size cap exceeded/.test(String((error as Error)?.message ?? error))) {
      throw new ProvisionError(
        "DOWNLOAD_TOO_LARGE",
        `The download exceeded the ${maxBytes}-byte safety cap and was discarded.`,
      );
    }
    throw new ProvisionError(
      "DOWNLOAD_INTERRUPTED",
      `The download was interrupted: ${error instanceof Error ? error.message : String(error)}.`,
    );
  }
  throwIfCancelled(ctx);
  const sha256 = await checksumFile(tempPath);
  return { bytes, sha256 };
}

// ------------------------------------------------------------ discovery

/** Probe one interpreter: its version and whether Demucs is present
 *  (package metadata — cheap, no torch import). */
async function probeInterpreter(
  ctx: ProvisionContext,
  candidate: { bin: string; prefixArgs: readonly string[]; source: DiscoveredPython["source"] },
): Promise<DiscoveredPython> {
  const run = ctx.runProcess ?? defaultRunProcess;
  const snippet = [
    "import json",
    "try:",
    "    from importlib.metadata import version as _v",
    "    demucs_version = _v('demucs')",
    "except Exception:",
    "    demucs_version = None",
    "import sys",
    "print(json.dumps({'version': '%d.%d.%d' % sys.version_info[:3], 'demucs': demucs_version}))",
  ].join("\n");
  const outcome = await run(candidate.bin, [...candidate.prefixArgs, "-c", snippet], {
    env: { ...process.env, PYTHONUNBUFFERED: "1", PYTHONIOENCODING: "utf-8" },
    timeoutMs: 20_000,
    signal: ctx.signal,
  });
  if (outcome.error !== null || outcome.status !== 0) {
    return { bin: candidate.bin, prefixArgs: candidate.prefixArgs, source: candidate.source, version: null, demucsVersion: null };
  }
  const line = outcome.stdout.trim().split("\n").at(-1) ?? "";
  let parsed: Record<string, unknown> | null = null;
  try {
    const value = JSON.parse(line);
    if (typeof value === "object" && value !== null) parsed = value as Record<string, unknown>;
  } catch {
    parsed = null;
  }
  return {
    bin: candidate.bin,
    prefixArgs: candidate.prefixArgs,
    source: candidate.source,
    version: typeof parsed?.version === "string" ? parsed.version : null,
    demucsVersion: typeof parsed?.demucs === "string" ? parsed.demucs : null,
  };
}

/**
 * Discover the real machine state: every reachable interpreter (with
 * its version and Demucs presence), the checkpoint (presence, size,
 * sha256), FFmpeg/ffprobe, and whether a managed environment already
 * exists. This is the honest self-diagnosis — nothing is assumed
 * from a remembered install.
 */
export async function discoverEnvironment(opts: { ctx?: ProvisionContext; env?: NodeJS.ProcessEnv; modelId?: string } = {}): Promise<EnvironmentReport> {
  const ctx: ProvisionContext = opts.ctx ?? { log: () => undefined };
  const env = opts.env ?? process.env;

  const { deepPythonCandidates } = await import("./deep");
  const candidates = deepPythonCandidates(env);
  const python: DiscoveredPython[] = [];
  for (const candidate of candidates) {
    python.push(await probeInterpreter(ctx, candidate));
  }

  const checkpointPath = deepCheckpointPath(env, opts.modelId);
  let checkpoint: EnvironmentReport["checkpoint"] = { path: checkpointPath, present: false, sha256: null, sizeBytes: null };
  try {
    const details = await stat(checkpointPath);
    if (details.isFile() && details.size > 0) {
      checkpoint = { path: checkpointPath, present: true, sha256: await checksumFile(checkpointPath), sizeBytes: details.size };
    }
  } catch {
    /* absent */
  }

  const envDir = resolveDeepEnvDir(env);
  const pointer = join(envDir, "interpreter.json");
  let managedEnvironmentExists = false;
  try {
    await stat(pointer);
    managedEnvironmentExists = true;
  } catch {
    managedEnvironmentExists = false;
  }

  const ffmpeg = await resolveToolPath("ffmpeg");
  const ffprobe = await resolveToolPath("ffprobe");

  return {
    python,
    compatiblePython: python.find(interpreterIsCompatible) ?? null,
    checkpoint,
    ffmpegPresent: ffmpeg !== null,
    ffprobePresent: ffprobe !== null,
    managedEnvironmentExists,
  };
}

// --------------------------------------------------------- managed Python

/** The official CPython embeddable package URL (the authoritative
 *  distribution for a portable, non-system runtime). */
export function managedPythonUrl(platform: NodeJS.Platform = process.platform, arch: string = process.arch): string {
  if (platform !== "win32") {
    throw new ProvisionError("UNSUPPORTED_PLATFORM", "The managed CPython runtime is provided for Windows; on macOS/Linux use a system Python 3.10–3.11.");
  }
  const archName = arch === "arm64" ? "arm64" : "amd64";
  return `https://www.python.org/ftp/python/${MANAGED_PYTHON_VERSION}/python-${MANAGED_PYTHON_VERSION}-embed-${archName}.zip`;
}

/** Extract a zip with the system `tar` (bsdtar, present on Windows
 *  10 1803+ and every POSIX) — argument-array, no shell. */
async function extractZip(ctx: ProvisionContext, zipPath: string, destDir: string): Promise<void> {
  await mkdir(destDir, { recursive: true });
  await mustRun(ctx, "tar", ["-xf", zipPath, "-C", destDir], {
    timeoutMs: 120_000,
    code: "RUNTIME_EXTRACT_FAILED",
    label: "Extracting the managed Python runtime",
  });
}

/** Enable `import site` in the embeddable runtime's ._pth so its
 *  site-packages (where pip installs) are importable. */
async function enableSitePackages(pythonDir: string, ctx: ProvisionContext): Promise<void> {
  const pthFiles = ["python311._pth", "python310._pth"];
  for (const name of pthFiles) {
    const path = join(pythonDir, name);
    if (!existsSync(path)) continue;
    const content = await readFile(path, "utf8");
    const updated = content
      .split("\n")
      .map((line) => (line.trim() === "#import site" ? "import site" : line))
      .join("\n");
    await writeFile(path, updated, "utf8");
    return;
  }
  throw new ProvisionError("RUNTIME_SETUP_FAILED", "The managed Python runtime's path file was not found after extraction.");
}

/** Install pip into the managed runtime WITHOUT executing a remote
 *  bootstrap script: download the official pip wheel from PyPI
 *  (sha256-verified against PyPI's own metadata) and unpack it into
 *  site-packages — a wheel's layout IS the installed layout. */
async function bootstrapPip(pythonDir: string, ctx: ProvisionContext): Promise<void> {
  const fetchImpl = ctx.fetch ?? ((url: string, init?: { signal?: AbortSignal }) => globalThis.fetch(url, init));
  const metadataUrl = "https://pypi.org/pypi/pip/json";
  validateTrustedUrl(metadataUrl);
  const metadataResponse = await fetchImpl(metadataUrl, { signal: ctx.signal });
  if (!metadataResponse.ok) {
    throw new ProvisionError("RUNTIME_PIP_FAILED", `Could not read pip's package metadata (HTTP ${metadataResponse.status}).`);
  }
  const metadata = (await metadataResponse.json()) as { info?: { version?: string }; urls?: Array<{ filename: string; url: string; digests?: { sha256?: string }; size?: number }> };
  const wheel = metadata.urls?.find((file) => /py3-none-any\.whl$/.test(file.filename));
  if (wheel === undefined || wheel.url === undefined) {
    throw new ProvisionError("RUNTIME_PIP_FAILED", "No platform-independent pip wheel was published.");
  }
  const expectedSha = wheel.digests?.sha256;
  if (expectedSha === undefined) {
    throw new ProvisionError("RUNTIME_PIP_FAILED", "PyPI did not publish a sha256 for the pip wheel — refusing an unverified install.");
  }
  const tempPath = join(pythonDir, `.pip-${wheel.filename}`);
  const { sha256 } = await downloadToTemp(wheel.url, tempPath, { ctx, expectedBytes: wheel.size });
  if (sha256 !== expectedSha) {
    await rm(tempPath, { force: true }).catch(() => undefined);
    throw new ProvisionError("INTEGRITY_FAILED", "The pip wheel failed its integrity check — refusing to install it.");
  }
  const sitePackages = join(pythonDir, "Lib", "site-packages");
  await mkdir(sitePackages, { recursive: true });
  // A wheel is a zip whose root is the installed package layout.
  await extractZip(ctx, tempPath, sitePackages);
  await rm(tempPath, { force: true }).catch(() => undefined);
}

/**
 * Acquire Arena's own managed CPython (used when the machine has no
 * compatible interpreter). Downloads the official embeddable package
 * from python.org, extracts it into the managed directory, bootstraps
 * a checksum-verified pip, and proves the runtime works by executing
 * it. The result is isolated inside Arena's data directory — nothing
 * is installed system-wide.
 */
export async function acquireManagedPython(
  envDir: string,
  ctx: ProvisionContext,
  opts: { platform?: NodeJS.Platform; arch?: string; expectedBytes?: number } = {},
): Promise<string> {
  throwIfCancelled(ctx);
  const url = managedPythonUrl(opts.platform ?? process.platform, opts.arch ?? process.arch);
  const pythonDir = join(envDir, "python");
  const zipPath = join(envDir, ".python-download.zip");
  ctx.log(`Downloading the managed CPython ${MANAGED_PYTHON_VERSION} runtime from python.org…`);
  const { sha256 } = await downloadToTemp(url, zipPath, {
    ctx,
    expectedBytes: opts.expectedBytes ?? 11_000_000,
    maxBytes: 64_000_000,
  });
  // python.org does not publish a stable machine-readable sha256 for
  // the embeddable zip; integrity is established by HTTPS from the
  // official host plus the version self-check below (the runtime
  // executes and reports exactly the expected version).
  ctx.log(`Runtime downloaded (${(sha256.slice(0, 12))}…). Extracting…`);
  await rm(pythonDir, { recursive: true, force: true }).catch(() => undefined);
  await extractZip(ctx, zipPath, pythonDir);
  await rm(zipPath, { force: true }).catch(() => undefined);
  await enableSitePackages(pythonDir, ctx);
  await bootstrapPip(pythonDir, ctx);

  const pythonExe = join(pythonDir, "python.exe");
  if (!existsSync(pythonExe)) {
    throw new ProvisionError("RUNTIME_SETUP_FAILED", "The managed Python runtime did not extract a python.exe.");
  }
  // Prove the runtime is real and the right version — a corrupted or
  // wrong download cannot report the exact expected version.
  const versionOut = await mustRun(ctx, pythonExe, ["--version"], {
    timeoutMs: 30_000,
    code: "RUNTIME_SETUP_FAILED",
    label: "Verifying the managed Python runtime",
  });
  const reported = versionOut.trim();
  if (!reported.startsWith(`Python ${MANAGED_PYTHON_VERSION}`)) {
    throw new ProvisionError("RUNTIME_SETUP_FAILED", `The managed runtime reports "${reported}", expected Python ${MANAGED_PYTHON_VERSION}.`);
  }
  ctx.log(`Managed Python ${MANAGED_PYTHON_VERSION} ready (${reported.trim()}).`);
  return pythonExe;
}

// ------------------------------------------------------------ venv + deps

/** Create an isolated virtual environment on a compatible interpreter. */
export async function createManagedVenv(basePython: string, envDir: string, ctx: ProvisionContext): Promise<string> {
  throwIfCancelled(ctx);
  const venvDir = join(envDir, "venv");
  await rm(venvDir, { recursive: true, force: true }).catch(() => undefined);
  ctx.log(`Creating an isolated Python environment in ${venvDir}…`);
  await mustRun(ctx, basePython, ["-m", "venv", venvDir], {
    timeoutMs: 180_000,
    code: "VENV_FAILED",
    label: "Creating the isolated environment",
  });
  const python = join(venvDir, process.platform === "win32" ? "Scripts" : "bin", process.platform === "win32" ? "python.exe" : "python");
  if (!existsSync(python)) {
    throw new ProvisionError("VENV_FAILED", `The isolated environment did not produce a Python at ${python}.`);
  }
  return python;
}

/** Install the pinned Demucs stack into the environment. The CPU
 *  PyTorch index is the reliable baseline; versions are pinned so a
 *  repeat preparation reproduces the same environment. */
export async function installDependencies(python: string, ctx: ProvisionContext): Promise<void> {
  throwIfCancelled(ctx);
  const env: NodeJS.ProcessEnv = { ...process.env, PIP_CONFIG_FILE: process.platform === "win32" ? "NUL" : "/dev/null", PIP_DISABLE_PIP_VERSION_CHECK: "1", PIP_NO_INPUT: "1" };
  delete env.PIP_EXTRA_INDEX_URL;
  delete env.PIP_INDEX_URL;
  ctx.log("Upgrading pip in the isolated environment…");
  await mustRun(ctx, python, ["-m", "pip", "--isolated", "install", "pip==25.0.1", "--index-url", PYPI_INDEX], {
    cwd: undefined,
    env,
    timeoutMs: 300_000,
    code: "DEPENDENCY_INSTALL_FAILED",
    label: "Upgrading pip",
  });
  ctx.log(`Installing PyTorch ${TORCH_VERSION} (CPU) and torchaudio ${TORCHAUDIO_VERSION}…`);
  await mustRun(
    ctx,
    python,
    ["-m", "pip", "--isolated", "install", `torch==${TORCH_VERSION}`, `torchaudio==${TORCHAUDIO_VERSION}`, "--index-url", PYTORCH_CPU_INDEX],
    {
      env,
      timeoutMs: 30 * 60_000,
      code: "DEPENDENCY_INSTALL_FAILED",
      label: "Installing PyTorch (CPU)",
    },
  );
  ctx.log(`Installing Demucs ${DEMUCS_VERSION}…`);
  await mustRun(ctx, python, ["-m", "pip", "--isolated", "install", `demucs==${DEMUCS_VERSION}`, "numpy==1.26.4", "--index-url", PYPI_INDEX], {
    env,
    timeoutMs: 30 * 60_000,
    code: "DEPENDENCY_INSTALL_FAILED",
    label: "Installing Demucs",
  });
}

// -------------------------------------------------------------- checkpoint

/**
 * Acquire the deep model checkpoint from Demucs' own published model
 * store, verify it with Demucs' OWN integrity contract (the sha256
 * prefix its filename encodes — `repo.check_checksum`), and place it
 * atomically into the app's models directory. A truncated, corrupt or
 * wrong-model file is detected and never installed.
 *
 * The expected prefix defaults to the upstream checkpoint's constant;
 * a test may supply its own to exercise the SAME verification and
 * atomic-placement code with a genuinely-matching file (the production
 * prefix is the upstream fact, never a test invention).
 */
export async function freezeDependencies(python: string, ctx: ProvisionContext): Promise<string> {
  const result = await mustRun(ctx, python, ["-m", "pip", "freeze", "--all"], { timeoutMs: 30_000, code: "DEPENDENCY_RECORD_FAILED", label: "Recording resolved dependencies" });
  if (!result.trim()) throw new ProvisionError("DEPENDENCY_RECORD_FAILED", "pip returned no resolved dependencies; readiness was not published.");
  return result;
}

export async function acquireCheckpoint(
  modelsDir: string,
  ctx: ProvisionContext,
  opts: { checksumPrefix?: string; expectedBytes?: number; modelId?: string } = {},
): Promise<void> {
  throwIfCancelled(ctx);
  const expectedPrefix = opts.checksumPrefix ?? deepModelSpec(opts.modelId).sha256;
  const finalPath = join(modelsDir, deepModelSpec(opts.modelId).file);
  const tempPath = join(modelsDir, `.download-${deepModelSpec(opts.modelId).file}.tmp`);
  await mkdir(modelsDir, { recursive: true });
  ctx.log(`Downloading the ${deepModelSpec(opts.modelId).file} model from Demucs' official store…`);
  const { bytes, sha256 } = await downloadToTemp(`https://dl.fbaipublicfiles.com/demucs/hybrid_transformer/${deepModelSpec(opts.modelId).file}`, tempPath, {
    ctx,
    expectedBytes: opts.expectedBytes,
    maxBytes: 200_000_000,
    onProgress: (done, total) => ctx.log(`  model download: ${(done / 1_000_000).toFixed(1)} MB${total === null ? "" : ` / ${(total / 1_000_000).toFixed(1)} MB`}`),
  });
  // The upstream integrity contract: the first 8 hex chars of the
  // file's sha256 equal the checksum encoded in its filename.
  if (!sha256.toLowerCase().startsWith(expectedPrefix.toLowerCase())) {
    await rm(tempPath, { force: true }).catch(() => undefined);
    throw new ProvisionError(
      "INTEGRITY_FAILED",
      `The downloaded model failed Demucs' integrity check (sha256 ${sha256.slice(0, 12)}…, expected prefix ${expectedPrefix}). Nothing was installed.`,
    );
  }
  // Atomic placement: the engine only ever sees a complete file.
  await rename(tempPath, finalPath);
  ctx.log(`Model installed and verified (${(bytes / 1_000_000).toFixed(1)} MB, sha256 ${sha256.slice(0, 12)}…).`);
}

/**
 * Import a checkpoint the owner already possesses. The file is
 * validated (it must BE the htdemucs_6s checkpoint — the sha256
 * prefix Demucs itself encodes) before it is copied into the models
 * directory, so a mislabelled or wrong file is rejected, never
 * silently accepted because of its filename.
 *
 * As with acquisition, the expected prefix defaults to the upstream
 * constant; a test may supply its own to exercise the real
 * validation + atomic-import path with a genuinely-matching file.
 */
export async function importCheckpoint(
  sourcePath: string,
  modelsDir: string,
  ctx: ProvisionContext,
  opts: { checksumPrefix?: string; modelId?: string } = {},
): Promise<void> {
  throwIfCancelled(ctx);
  if (!isAbsolute(sourcePath)) {
    throw new ProvisionError("IMPORT_INVALID", "The checkpoint to import must be an absolute path.");
  }
  const details = await stat(sourcePath).catch(() => null);
  if (details === null || !details.isFile() || details.size <= 0 || details.size > 200_000_000) {
    throw new ProvisionError("IMPORT_INVALID", `No bounded readable checkpoint was found at ${sourcePath}.`);
  }
  const spec = deepModelSpec(opts.modelId);
  const expectedPrefix = opts.checksumPrefix ?? spec.sha256;
  await mkdir(modelsDir, { recursive: true });
  const finalPath = deepCheckpointPath({ ...process.env, WAVEYARD_MODELS_DIR: modelsDir }, spec.id);
  const tempPath = `${finalPath}.${randomUUID()}.import.tmp`;
  try {
    let bytes = 0;
    const bound = new Transform({ transform(chunk: Buffer, _encoding, callback) {
      bytes += chunk.length;
      callback(bytes > 200_000_000 ? new ProvisionError("IMPORT_INVALID", "The checkpoint grew beyond the import size limit.") : null, chunk);
    } });
    await pipeline(createReadStream(sourcePath), bound, createWriteStream(tempPath, { flags: "wx" }), { signal: ctx.signal });
    throwIfCancelled(ctx);
    // Validate the exact staged bytes, not a source path that can change
    // between hashing and copying. Never unlink a working model first.
    const sha256 = await checksumFile(tempPath);
    if (!sha256.toLowerCase().startsWith(expectedPrefix.toLowerCase())) {
      throw new ProvisionError("INTEGRITY_FAILED", `The imported bytes are not ${spec.name} (${spec.file}). Existing checkpoints were retained.`);
    }
    throwIfCancelled(ctx);
    await rename(tempPath, finalPath);
    ctx.log(`Imported checkpoint verified (sha256 ${sha256}) and placed at ${finalPath}.`);
  } finally { await rm(tempPath, { force: true }).catch(() => undefined); }
}

// --------------------------------------------------------------- verify/probe

/** Confirm the environment imports Demucs and PyTorch and report
 *  their real versions — the versions provenance records. */
export async function verifyEngine(python: string, ctx: ProvisionContext): Promise<{ demucsVersion: string; torchVersion: string; cuda: boolean }> {
  throwIfCancelled(ctx);
  const snippet = [
    "import json",
    "try:",
    "    import torch, demucs, demucs.separate, torchaudio",
    "    from importlib.metadata import version as _v",
    "    print(json.dumps({'demucs': _v('demucs'), 'torch': torch.__version__, 'cuda': bool(torch.cuda.is_available())}))",
    "except Exception as error:",
    "    print(json.dumps({'error': str(error)}))",
  ].join("\n");
  const stdout = await mustRun(ctx, python, ["-c", snippet], {
    timeoutMs: 120_000,
    code: "ENGINE_VERIFY_FAILED",
    label: "Verifying the engine's dependencies",
  });
  const line = stdout.trim().split("\n").at(-1) ?? "";
  let parsed: Record<string, unknown> | null = null;
  try {
    const value = JSON.parse(line);
    if (typeof value === "object" && value !== null) parsed = value as Record<string, unknown>;
  } catch {
    parsed = null;
  }
  if (parsed === null || typeof parsed.error === "string") {
    throw new ProvisionError("ENGINE_VERIFY_FAILED", `The engine's dependencies could not be imported: ${parsed?.error ?? "no output"}`);
  }
  return {
    demucsVersion: String(parsed.demucs),
    torchVersion: String(parsed.torch),
    cuda: parsed.cuda === true,
  };
}

/** Generate a short, silent 44.1 kHz stereo WAV for the inference
 *  smoke test (a locally generated signal — NOT a substitute for the
 *  real-audio acceptance, which stays an owner-machine step). */
export function smokeTestWav(): Buffer {
  // 6 seconds, 44.1 kHz, stereo, 16-bit — enough for the model's
  // receptive field, small enough to run quickly on CPU.
  const sampleRate = 44_100;
  const seconds = 6;
  const frames = sampleRate * seconds;
  const data = new Int16Array(frames * 2);
  for (let i = 0; i < frames; i += 1) {
    const value = Math.round(Math.sin((2 * Math.PI * 220 * i) / sampleRate) * 8000);
    data[i * 2] = value;
    data[i * 2 + 1] = Math.round(Math.cos((2 * Math.PI * 220 * i) / sampleRate) * 8000);
  }
  const header = Buffer.alloc(44);
  header.write("RIFF", 0, "ascii");
  header.writeUInt32LE(36 + data.length * 2, 4);
  header.write("WAVE", 8, "ascii");
  header.write("fmt ", 12, "ascii");
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20); // PCM
  header.writeUInt16LE(2, 22); // stereo
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * 4, 28);
  header.writeUInt16LE(4, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36, "ascii");
  header.writeUInt32LE(data.length * 2, 40);
  return Buffer.concat([header, Buffer.from(data.buffer)]);
}

/**
 * The genuine inference smoke test: run the REAL Demucs CLI on a
 * short signal through the managed interpreter and the local
 * checkpoint, and confirm all six stems come back non-empty. This is
 * the same invocation the separation worker uses, so a passing probe
 * is real evidence the engine runs — not that a package was installed.
 */
export async function runInferenceProbe(python: string, modelsDir: string, ctx: ProvisionContext, modelId?: string): Promise<readonly string[]> {
  const spec = deepModelSpec(modelId);
  throwIfCancelled(ctx);
  const workDir = join(modelsDir, "..", `deep-probe-${spec.id}`);
  await mkdir(workDir, { recursive: true });
  const inputPath = join(workDir, "probe.wav");
  await writeFile(inputPath, smokeTestWav());
  const outDir = join(workDir, "probe-out");
  await rm(outDir, { recursive: true, force: true }).catch(() => undefined);
  ctx.log("Running a real inference smoke test on a short signal…");
  await mustRun(
    ctx,
    python,
    [
      "-m",
      "demucs",
      "--name",
      spec.signature,
      "--repo",
      modelsDir,
      "--device",
      "cpu",
      "--out",
      outDir,
      inputPath,
    ],
    { env: await audioToolEnvironment(), timeoutMs: 15 * 60_000, code: "ENGINE_PROBE_FAILED", label: "Running the inference smoke test" },
  );
  // Demucs writes <out>/<model>/<track>/<stem>.wav — collect the six.
  const stems = spec.stems;
  const found: string[] = [];
  const outputChecksums: Record<string, string> = {};
  const walk = async (directory: string): Promise<void> => {
    const entries = await readdir(directory, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) await walk(path);
      else if (/\.wav$/i.test(entry.name)) {
        const details = await stat(path);
        if (details.size > 44) {
          const decoded = decodeWav16(new Uint8Array(await readFile(path)));
          if (!decoded || decoded.frames !== 6 * 44100 || decoded.sampleRate !== 44100 || decoded.channels !== 2) throw new ProvisionError("ENGINE_PROBE_FAILED", `Invalid smoke output: ${entry.name} is not source-aligned 44100 Hz stereo PCM.`);
          const name = entry.name.replace(/\.wav$/i, "");
          found.push(name); outputChecksums[name] = await checksumFile(path);
        }
      }
    }
  };
  await walk(outDir);
  const missing = stems.filter((stem) => !found.includes(stem));
  if (missing.length > 0) {
    throw new ProvisionError("ENGINE_PROBE_FAILED", `The engine did not produce every stem (missing: ${missing.join(", ")}).`);
  }
  if (new Set(Object.values(outputChecksums)).size < 2) throw new ProvisionError("ENGINE_PROBE_FAILED", "Smoke outputs are identical; real separated output was not established.");
  await writeFile(join(workDir, "receipt.json"), JSON.stringify({ python, inputSha256: await checksumFile(inputPath), checkpointSha256: await checksumFile(join(modelsDir, spec.file)), outputChecksums, scope: "trained-engine synthetic-signal smoke; not music quality acceptance", testedAt: new Date().toISOString() }, null, 2));
  ctx.log(`Inference smoke test passed — all ${spec.stems.length} ${spec.name} stems were produced.`);
  return stems;
}

// re-exported for the manager's path resolution
export { resolveModelsDir, DEEP_CHECKPOINT_FILE, resolveDeepEnvDir };
