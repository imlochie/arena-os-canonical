/**
 * The DEEP separation bridge (A7) — the engine the owner prepares.
 *
 * The in-process MDX-Net machine (worker-local/separation.ts + mdx.ts) is the
 * zero-setup pass. This bridge is the deep pass: it runs the owner's OWN
 * Demucs install (htdemucs_6s → vocals, drums, bass, guitar, piano, other)
 * as a child process and hands the six WAVs back to the SAME durable job
 * pipeline, so stems are persisted, attributed, waveform-queued and surfaced
 * exactly like every other separation. Nothing is bundled and nothing is
 * faked: when the machine is not prepared, the bridge reports exactly that
 * and the job records the honest unavailable state with the prepare step.
 *
 * Two things make a machine "prepared", and the probe checks both:
 *  1. an interpreter with Demucs installed (see interpreter resolution);
 *  2. the ONE local checkpoint the deep pass loads — `5c90dfd2-34c22ccb.th`,
 *     the htdemucs_6s weights — inside the app's models directory
 *     (WAVEYARD_MODELS_DIR). The run hands that directory to Demucs with
 *     `--repo` and asks for the checkpoint's signature, so Demucs loads the
 *     local file (verifying the checksum its filename encodes) and never
 *     reaches for its remote weight store. A machine without the file is not
 *     prepared, and the reason names the exact path that was checked.
 *     Presence is a readiness gate, not proof of valid weights: Demucs'
 *     own checksum check on load is the integrity gate.
 *
 * Why a child process and not spawnSync: the local worker drains jobs inside
 * the app's own server process (src/instrumentation.ts). A synchronous
 * Demucs run would block every HTTP request for the whole pass — the UI
 * would look hung. The run streams the engine's own percent into the job
 * row's metadata (the same contract the MDX path keeps).
 *
 * Interpreter resolution (probe and run use the SAME interpreter): an
 * explicit WAVEYARD_DEEP_PYTHON (the owner-prepared install) → PYTHON_BIN
 * (the override the Python worker already honours) → the platform's usual
 * names ("py -3" first on Windows, then python/python3). The probe is
 * deliberately cheap — it asks the interpreter's package metadata for
 * Demucs' version and never imports torch.
 */

import { spawn, spawnSync } from "node:child_process";
import { ownedPythonModuleArgs } from "./python-guardian";
import { checksumFile } from "../audio";
import { audioToolEnvironment } from "../ffmpeg";
import { resolveExecutable } from "@/lib/capabilities/resolver";
import { existsSync, readFileSync, statSync } from "node:fs";
import { mkdir, readdir, stat } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";

import { resolveModelsDir, SeparationUnavailableError } from "./session";
import { processingModeExplanation, resolveProcessingMode } from "../worker-local/runtime-policy";
import {
  deepModelSpec,
  DEEP_LABEL,
  DEEP_MODEL_ID,
  DEEP_STEM_TYPES,
  type DeepStemType,
} from "./modes";

/** The Demucs model family the deep pass runs (six sources). */
export const DEEP_MODEL_NAME = "htdemucs_6s";

/** The signature of the one checkpoint behind `htdemucs_6s` (its bag file in
 *  Demucs' own remote index is exactly `models: ['5c90dfd2']` — no weights or
 *  segment overrides — so loading the signature IS loading the family). */
export const DEEP_MODEL_SIGNATURE = "5c90dfd2";

/** The sha256 prefix Demucs encodes in the checkpoint's filename and verifies
 *  on load (`demucs/repo.py`, LocalRepo.get_model → check_checksum). */
export const DEEP_CHECKPOINT_CHECKSUM = "34c22ccb";

/** The only file the deep pass will load: `<signature>-<checksum>.th`. */
export const DEEP_CHECKPOINT_FILE = `${DEEP_MODEL_SIGNATURE}-${DEEP_CHECKPOINT_CHECKSUM}.th`;

/** Where Demucs itself publishes that file (remote index `files.txt`, root
 *  `hybrid_transformer/`). Documentation for the owner's preparation step —
 *  the app NEVER downloads it. */
export const DEEP_CHECKPOINT_URL = `https://dl.fbaipublicfiles.com/demucs/hybrid_transformer/${DEEP_CHECKPOINT_FILE}`;

const PROBE_TIMEOUT_MS = 20_000;
const DEFAULT_RUN_TIMEOUT_MS = 60 * 60 * 1000;

/** The absolute path of the local checkpoint for the given environment —
 *  the SAME resolution the probe, the run and every diagnostic use. */
export function deepCheckpointPath(env: NodeJS.ProcessEnv = process.env, modelId = DEEP_MODEL_ID): string {
  return join(resolveModelsDir(env), deepModelSpec(modelId).file);
}

/** The provenance string every deep stem row carries: model family, the
 *  exact checkpoint identity (signature + checksum) and the engine version
 *  that ran it. Two outputs from different weights can never share it. */
export function deepModelVersion(demucsVersion: string, modelId = DEEP_MODEL_ID): string {
  const spec = deepModelSpec(modelId);
  return `${spec.name}@${spec.signature}-${spec.checksum}/demucs-${demucsVersion}`;
}

/** The checkpoint half of the prepare step — names the exact path for the
 *  environment being asked about. */
export function deepCheckpointHint(env: NodeJS.ProcessEnv = process.env): string {
  return (
    `Place the ${DEEP_MODEL_NAME} checkpoint ${DEEP_CHECKPOINT_FILE} at ${deepCheckpointPath(env)} ` +
    "(the app's models directory, WAVEYARD_MODELS_DIR) — it is the file Demucs downloads for " +
    `${DEEP_MODEL_NAME}, so copy it from Demucs' own cache (…/torch/hub/checkpoints/) or fetch ` +
    `${DEEP_CHECKPOINT_URL} yourself. The deep pass loads only that local file — nothing is downloaded from here.`
  );
}

/** How the machine is prepared — the exact steps to take when it is not,
 *  for the SAME environment the probe and run resolve against (an injected
 *  WAVEYARD_MODELS_DIR is reported, never the default). */
export function deepPrepareHint(env: NodeJS.ProcessEnv = process.env): string {
  const interpreter = process.platform === "win32" ? "py -3" : "python3";
  return (
    `Use Prepare deep separation in Arena for an isolated runtime, or install Demucs on this machine ("${interpreter} -m pip install demucs"), or point ` +
    "WAVEYARD_DEEP_PYTHON at an interpreter that has it, and place the " +
    `${DEEP_MODEL_NAME} checkpoint ${DEEP_CHECKPOINT_FILE} at ${deepCheckpointPath(env)} ` +
    "(WAVEYARD_MODELS_DIR), then retry. The deep pass runs your own local engine and loads only " +
    "that local checkpoint — nothing is downloaded from here."
  );
}

// ------------------------------------------------------------ interpreter

export type DeepPythonCandidate = {
  bin: string;
  /** Prefix args (Windows launcher: py -3). */
  prefixArgs: string[];
  source: "env" | "managed" | "system";
};

/** Where Arena keeps the isolated environment it prepares for the
 *  deep pass (the venv / managed CPython and its packages). Mirrors
 *  resolveModelsDir's env convention so diagnostics, preparation and
 *  execution all resolve the SAME directory and report it. */
export function resolveDeepEnvDir(env: NodeJS.ProcessEnv = process.env): string {
  const root = env.WAVEYARD_DEEP_ENV_DIR ?? join(dirname(resolveModelsDir(env)), "waveyard-deep-env");
  return resolve(/*turbopackIgnore: true*/ process.cwd(), root);
}

/** The prepared-environment pointer the provisioner writes on
 *  success: the exact interpreter the deep pass should run, plus
 *  the versions it verified. Read on every candidate resolution so
 *  replacing/removing the interpreter is detected (no remembered
 *  install result). */
export type DeepManagedInterpreter = {
  python: string;
  pythonVersion: string;
  demucsVersion: string;
  venv: string;
  preparedAt: string;
  checkpointSha256?: string;
  smokeVerified?: boolean;
  modelId?: string;
};

const POINTER_FILE = "interpreter.json";

/** The managed interpreter for this environment, or null when none
 *  was prepared (or the pointer is stale — the file it names is
 *  gone, which must drop readiness rather than keep a phantom). */
export function readManagedInterpreter(env: NodeJS.ProcessEnv = process.env): DeepManagedInterpreter | null {
  const path = join(resolveDeepEnvDir(env), POINTER_FILE);
  try {
    const raw = readFileSync(path, "utf8");
    const parsed = JSON.parse(raw) as DeepManagedInterpreter;
    if (
      typeof parsed.python !== "string" ||
      !isAbsolute(parsed.python) ||
      !existsSync(parsed.python)
    ) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

/** Candidate interpreters, most explicit first. The managed
 *  environment Arena prepared ranks just below the owner's own
 *  explicit override: once provisioned, it IS the engine, but an
 *  owner who points WAVEYARD_DEEP_PYTHON somewhere still wins. */
export function deepPythonCandidates(env: NodeJS.ProcessEnv = process.env): DeepPythonCandidate[] {
  const candidates: DeepPythonCandidate[] = [];
  const seen = new Set<string>();
  const push = (bin: string | undefined, prefixArgs: string[], source: "env" | "managed" | "system") => {
    const trimmed = bin?.trim();
    if (!trimmed || seen.has(trimmed)) return;
    seen.add(trimmed);
    candidates.push({ bin: trimmed, prefixArgs, source });
  };
  push(env.WAVEYARD_DEEP_PYTHON, [], "env");
  const managed = readManagedInterpreter(env);
  push(managed?.python, [], "managed");
  push(env.PYTHON_BIN, [], "env");
  // System interpreters are a labelled fallback, resolved to absolute paths.
  const system = (name: string) => resolveExecutable(name, { env })?.path;
  if (process.platform === "win32") {
    push(env.WAVEYARD_DEEP_PYTHON ? undefined : system("py"), ["-3"], "system");
    push(system("python"), [], "system");
  } else {
    push(system("python3"), [], "system");
    push(system("python"), [], "system");
  }
  return candidates;
}

function childEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return { ...process.env, ...env, PYTHONUNBUFFERED: "1", PYTHONIOENCODING: "utf-8" };
}

// ------------------------------------------------------------------ probe

export type DeepEngineReady = {
  prepared: true;
  python: string;
  pythonSource: "env" | "managed" | "system";
  demucsVersion: string;
  modelId: string;
  modelName: string;
  label: string;
  stems: readonly DeepStemType[];
  /** The local checkpoint the run will load (present, by definition). */
  checkpointPath: string;
  checkpointPresent: true;
};

export type DeepEngineMissing = {
  prepared: false;
  /** The interpreter that has Demucs, when the gap is only the checkpoint. */
  python: string | null;
  demucsVersion: string | null;
  reason: string;
  modelId: string;
  modelName: string;
  label: string;
  stems: readonly DeepStemType[];
  /** The exact path that was checked for the checkpoint. */
  checkpointPath: string;
  checkpointPresent: boolean;
};

export type DeepEngineStatus = DeepEngineReady | DeepEngineMissing;

/** Asks the interpreter's own package metadata for Demucs' version — cheap
 *  (no torch import) and honest (absent = not prepared). */
const PROBE_SNIPPET = [
  "import json",
  "try:",
  "    from importlib.metadata import version as _version",
  "    demucs_version = _version('demucs')",
  "except Exception:",
  "    demucs_version = None",
  "print(json.dumps({'demucs': demucs_version}))",
].join("\n");

const TORCH_SNIPPET = [
  "import json",
  "try:",
  "    import torch",
  "except Exception as _error:",
  "    print(json.dumps({'error': str(_error)}))",
  "else:",
  "    print(json.dumps({'cuda': bool(torch.cuda.is_available())}))",
].join("\n");

function parseJsonLine(stdout: string): Record<string, unknown> | null {
  const line = stdout.trim().split("\n").at(-1) ?? "";
  try {
    const parsed = JSON.parse(line);
    return typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** The expensive half of the probe (one interpreter spawn per candidate),
 *  cached per interpreter set. The checkpoint is NOT part of this cache: a
 *  stat is microseconds, and the owner placing the file must flip readiness
 *  without a restart. */
type InterpreterProbe =
  | { found: true; candidate: DeepPythonCandidate; demucsVersion: string }
  | { found: false; reason: string };

const interpreterCache = new Map<string, { at: number; probe: InterpreterProbe }>();

/** Test seam: probes are cached per interpreter set; tests reset between
 *  stub drivers. */
export function resetDeepProbeCacheForTests(): void {
  interpreterCache.clear();
  readinessCache.clear();
}

function probeInterpreter(env: NodeJS.ProcessEnv, force: boolean): InterpreterProbe {
  const candidates = deepPythonCandidates(env);
  const cacheKey = JSON.stringify([candidates, env.PYTHONPATH ?? process.env.PYTHONPATH, env.PYTHONHOME ?? process.env.PYTHONHOME]);
  if (!force) {
    const cached = interpreterCache.get(cacheKey);
    if (cached !== undefined && Date.now() - cached.at < 10_000) return cached.probe;
  }

  let lastError: string | null = null;
  for (const candidate of candidates) {
    const result = spawnSync(candidate.bin, [...candidate.prefixArgs, "-c", PROBE_SNIPPET], {
      encoding: "utf8",
      timeout: PROBE_TIMEOUT_MS,
      env: childEnv(env),
    });
    if (result.error || result.status !== 0) {
      lastError =
        result.error?.message ??
        (result.stderr || result.stdout || `exited ${result.status}`).toString().trim().slice(-300);
      continue;
    }
    const parsed = parseJsonLine(result.stdout ?? "");
    const demucsVersion = typeof parsed?.demucs === "string" ? parsed.demucs : null;
    if (demucsVersion !== null) {
      const probe: InterpreterProbe = { found: true, candidate, demucsVersion };
      interpreterCache.set(cacheKey, { at: Date.now(), probe });
      return probe;
    }
    // The interpreter ran but has no Demucs — remember it as the reason.
    lastError = `Demucs is not installed for "${candidate.bin}".`;
  }

  const probe: InterpreterProbe = {
    found: false,
    reason:
      lastError === null || candidates.length === 0
        ? "Deep separation needs a Python interpreter with Demucs installed, and none was found on this machine."
        : lastError,
  };
  interpreterCache.set(cacheKey, { at: Date.now(), probe });
  return probe;
}

/** Is the local checkpoint there? A regular, non-empty file at the exact
 *  path for this environment. (Validity is Demucs' checksum check on load.) */
function checkpointPresent(path: string): boolean {
  try {
    const details = statSync(path);
    return details.isFile() && details.size > 0;
  } catch {
    return false;
  }
}

/**
 * Is this machine prepared for the deep pass? Cheap, synchronous, cached per
 * interpreter set (the checkpoint is re-checked every call) — safe to call
 * from a route to gate a request before any work is queued. Never throws.
 */
export function probeDeepEngine(options: { env?: NodeJS.ProcessEnv; modelId?: string; force?: boolean } = {}): DeepEngineStatus {
  const env = options.env ?? process.env;
  const spec = deepModelSpec(options.modelId);
  const checkpointPath = deepCheckpointPath(env, spec.id);
  const present = checkpointPresent(checkpointPath);
  const base = {
    modelId: spec.id,
    modelName: spec.name,
    label: spec.label,
    stems: spec.stems,
    checkpointPath,
  } as const;

  const interpreter = probeInterpreter(env, options.force === true);
  if (!interpreter.found) {
    return {
      ...base,
      prepared: false,
      python: null,
      demucsVersion: null,
      checkpointPresent: present,
      reason: `${interpreter.reason} ${deepPrepareHint(env)}`,
    };
  }
  if (!present) {
    return {
      ...base,
      prepared: false,
      python: interpreter.candidate.bin,
      demucsVersion: interpreter.demucsVersion,
      checkpointPresent: false,
      reason:
        `Demucs ${interpreter.demucsVersion} is ready for "${interpreter.candidate.bin}", but the deep model ` +
        `checkpoint is not at ${checkpointPath}. ${deepCheckpointHint(env)}`,
    };
  }
  return {
    ...base,
    prepared: true,
    python: interpreter.candidate.bin,
    pythonSource: interpreter.candidate.source,
    demucsVersion: interpreter.demucsVersion,
    checkpointPresent: true,
  };
}

/**
 * The runtime-aware answer routes and UI should use: the deep pass executes
 * in-process (it shells out from the app's own local worker), so a
 * deployment that processes through an external worker or has no processor
 * at all reports that honestly instead of probing for an engine it would
 * never run.
 */
export function deepEngineStatusForThisRuntime(env: NodeJS.ProcessEnv = process.env, modelId = DEEP_MODEL_ID): DeepEngineStatus {
  const mode = resolveProcessingMode(env);
  if (mode !== "in-process") {
    const checkpointPath = deepCheckpointPath(env);
    return {
      prepared: false,
      python: null,
      demucsVersion: null,
      reason: `The deep pass runs on this machine's own engine, inside the app process. ${processingModeExplanation(mode)}`,
      modelId: DEEP_MODEL_ID,
      modelName: DEEP_MODEL_NAME,
      label: DEEP_LABEL,
      stems: DEEP_STEM_TYPES,
      checkpointPath,
      checkpointPresent: checkpointPresent(checkpointPath),
    };
  }
  return probeDeepEngine({ env, modelId });
}

// -------------------------------------------------------------------- run

export type DeepRunRequest = {
  /** Input audio file (the handler writes the decoded 44.1 kHz WAV here). */
  inputPath: string;
  modelId?: string;
  /** Directory Demucs writes into; scanned recursively for the six stems. */
  outputDirectory: string;
  requestedDevice?: "auto" | "cpu" | "cuda";
  /** The engine's own percent, throttled by the caller. */
  onProgress?: (percent: number) => void;
  onSpawn?: (pid: number) => Promise<void>;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
  signal?: AbortSignal;
};

export type DeepRunStem = { stemType: DeepStemType; path: string; bytes: number };

export type DeepRunResult = {
  engine: "demucs";
  model: string;
  modelName: string;
  /** `htdemucs_6s@5c90dfd2-34c22ccb/demucs-<version>` — see deepModelVersion. */
  modelVersion: string;
  /** The local checkpoint that produced the stems. */
  checkpointPath: string;
  checkpointSha256?: string;
  resolvedDevice: "cpu" | "cuda";
  stems: DeepRunStem[];
};

type SpawnedOutcome = { status: number | null; stdout: string; stderr: string; error: Error | null };

function runPython(
  bin: string,
  args: string[],
  env: NodeJS.ProcessEnv,
  options: { timeoutMs: number; onSpawn?: (pid: number) => Promise<void>; startGate?: boolean; signal?: AbortSignal; onStderr?: (chunk: string) => void; onStdout?: (chunk: string) => void },
): Promise<SpawnedOutcome> {
  return new Promise((resolvePromise) => {
    if (options.signal?.aborted) return resolvePromise({ status: null, stdout: "", stderr: "", error: new DOMException("Separation cancelled", "AbortError") });
    const child = spawn(bin, args, { env: childEnv(env), stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
    let abortError: Error | null = null;
    let spawnError: Error | null = null;
    let forceKill: ReturnType<typeof setTimeout> | undefined;
    const abort = () => {
      abortError = new DOMException("Separation cancelled", "AbortError");
      child.kill("SIGTERM"); forceKill ??= setTimeout(() => child.kill("SIGKILL"), 1000);
    };
    options.signal?.addEventListener("abort", abort, { once: true });
    let stdout = "";
    let stderr = "";
    let settled = false;
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, options.timeoutMs);
    child.stdout?.on("data", (data: Buffer) => {
      const text = data.toString();
      stdout = (stdout + text).slice(-16384);
      options.onStdout?.(text);
    });
    child.stderr?.on("data", (data: Buffer) => {
      const text = data.toString();
      stderr = (stderr + text).slice(-16384);
      options.onStderr?.(text);
    });
    const finish = (outcome: SpawnedOutcome) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer); if (forceKill) clearTimeout(forceKill);
      options.signal?.removeEventListener("abort", abort);
      resolvePromise(outcome);
    };
    if (options.startGate) child.once("spawn", () => {
      void (async () => {
        try { await options.onSpawn?.(child.pid!); if (!options.signal?.aborted) child.stdin?.write("S"); }
        catch (error) { spawnError = error instanceof Error ? error : new Error(String(error)); child.kill("SIGKILL"); }
      })();
    });
    child.stdin?.on("error", (error: Error) => { spawnError ??= error; child.kill("SIGKILL"); });
    child.once("error", (error: Error) => { spawnError = error; });
    child.once("close", (code: number | null) =>
      finish({
        status: code,
        stdout,
        stderr,
        error: abortError ?? spawnError ?? (timedOut ? new Error(`timed out after ${Math.round(options.timeoutMs / 1000)}s`) : null),
      }),
    );
  });
}

export type DeepRuntimeReadiness = {
  prepared: boolean;
  reason: string | null;
  runtimeLoadable: boolean;
  checkpointSha256: string | null;
  /** Importing packages and checking bytes is never learned-inference proof. */
  inferenceVerified: false;
};
const readinessCache = new Map<string, { until: number; result: Promise<DeepRuntimeReadiness> }>();

/** Stronger public readiness than the cheap intake probe: import the selected
 * CLI (including its native dependencies), then hash the checkpoint WITHOUT
 * deserialising pickle. The 8-hex upstream prefix is integrity, not a signature
 * or an independent permission/security attestation. */
export async function inspectDeepRuntimeReadiness(options: { env?: NodeJS.ProcessEnv; modelId?: string; force?: boolean } = {}): Promise<DeepRuntimeReadiness> {
  const env = options.env ?? process.env;
  if (options.force && resolveProcessingMode(env) === "in-process") probeDeepEngine({ env, modelId: options.modelId, force: true });
  const status = deepEngineStatusForThisRuntime(env, options.modelId);
  const unavailable = (reason: string, runtimeLoadable = false, checkpointSha256: string | null = null): DeepRuntimeReadiness => ({ prepared: false, reason, runtimeLoadable, checkpointSha256, inferenceVerified: false });
  if (!status.prepared) return unavailable(status.reason);
  const candidate = deepPythonCandidates(env).find(value => value.bin === status.python);
  if (!candidate) return unavailable("The selected deep interpreter is no longer resolvable.");
  const info = await stat(status.checkpointPath).catch(() => null);
  if (!info?.isFile()) return unavailable("The deep checkpoint is no longer a regular file.");
  const key = JSON.stringify([candidate, env.PYTHONPATH ?? process.env.PYTHONPATH, env.PYTHONHOME ?? process.env.PYTHONHOME, status.checkpointPath, info.size, info.mtimeMs, info.ctimeMs, status.demucsVersion]);
  const cached = readinessCache.get(key);
  if (!options.force && cached && Date.now() < cached.until) return cached.result;
  const result = (async (): Promise<DeepRuntimeReadiness> => {
    try {
      const outcome = await runPython(candidate.bin, [...candidate.prefixArgs, "-c", "import demucs.separate; import torch; print('ARENA_DEEP_RUNTIME_OK')"], env, { timeoutMs: PROBE_TIMEOUT_MS });
      if (outcome.error || outcome.status !== 0 || !outcome.stdout.includes("ARENA_DEEP_RUNTIME_OK")) {
        const detail = outcome.error?.message ?? (outcome.stderr || outcome.stdout).trim().slice(-1000);
        return unavailable(`Demucs package metadata exists, but its CLI/native runtime cannot load: ${detail}`);
      }
      const digest = await checksumFile(status.checkpointPath);
      if (digest !== deepModelSpec(options.modelId).sha256) return unavailable("The local deep checkpoint does not match the pinned full SHA-256; replace it with the authorised original checkpoint.", true, digest);
      return { prepared: true, reason: null, runtimeLoadable: true, checkpointSha256: digest, inferenceVerified: false };
    } catch (error) { return unavailable(`Deep readiness could not be verified: ${error instanceof Error ? error.message : String(error)}`); }
  })();
  if (readinessCache.size >= 8) readinessCache.clear();
  readinessCache.set(key, { until: Date.now() + 20_000, result });
  return result;
}

async function resolveTorchDevice(
  candidate: DeepPythonCandidate,
  env: NodeJS.ProcessEnv,
  requested: "auto" | "cuda",
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<"cpu" | "cuda"> {
  const outcome = await runPython(candidate.bin, [...candidate.prefixArgs, "-c", TORCH_SNIPPET], env, { timeoutMs, signal });
  signal?.throwIfAborted();
  const parsed = outcome.status === 0 ? parseJsonLine(outcome.stdout) : null;
  if (parsed === null) {
    throw new SeparationUnavailableError(
      `The deep engine's PyTorch runtime could not be interrogated (${
        outcome.error?.message ?? (outcome.stderr || `exit ${outcome.status}`).trim().slice(-200)
      }). ${deepPrepareHint(env)}`,
    );
  }
  if (typeof parsed.error === "string") {
    throw new SeparationUnavailableError(`PyTorch is not installed for "${candidate.bin}". ${deepPrepareHint(env)}`);
  }
  const cuda = parsed.cuda === true;
  if (requested === "cuda" && !cuda) {
    throw new Error("CUDA was requested but this machine's PyTorch reports torch.cuda.is_available() = false.");
  }
  return cuda ? "cuda" : "cpu";
}

/** Recursively collect every `*.wav` under a directory (Demucs writes
 *  <out>/<model>/<track>/<stem>.wav; the walk matches the Python adapter's
 *  rglob so both engines accept the same layouts). */
async function collectWavFiles(directory: string): Promise<Map<string, string>> {
  const found = new Map<string, string>();
  const walk = async (current: string) => {
    let entries;
    try {
      entries = await readdir(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const path = join(current, entry.name);
      if (entry.isDirectory()) await walk(path);
      else if (/\.wav$/i.test(entry.name)) found.set(entry.name, path); // last wins, like the Python adapter
    }
  };
  await walk(directory);
  return found;
}

/**
 * Run the deep pass. Resolves with the six validated stem files (or rejects
 * with the honest reason — unavailable engine, failed run, missing output).
 * The caller persists; this function never touches the database.
 */
export async function verifyDeepCheckpoint(path: string, expected: string): Promise<string> {
  const digest = await checksumFile(path);
  if (digest !== expected) throw new SeparationUnavailableError("The selected Demucs checkpoint does not match its pinned full SHA-256. No inference was started; import or prepare the authorised original.");
  return digest;
}

export async function runDeepSeparation(request: DeepRunRequest, deps: { verifyCheckpoint?: typeof verifyDeepCheckpoint } = {}): Promise<DeepRunResult> {
  request.signal?.throwIfAborted();
  const env = request.env ?? process.env;
  const spec = deepModelSpec(request.modelId);
  const status = probeDeepEngine({ env, modelId: spec.id });
  if (!status.prepared) throw new SeparationUnavailableError(status.reason);
  const ready: DeepEngineReady = status;
  const candidate =
    deepPythonCandidates(env).find((entry) => entry.bin === ready.python) ?? deepPythonCandidates(env)[0];
  if (candidate === undefined) throw new SeparationUnavailableError(deepPrepareHint(env));

  const checkpointSha256 = await (deps.verifyCheckpoint ?? verifyDeepCheckpoint)(ready.checkpointPath, spec.sha256);
  const requestedDevice = request.requestedDevice ?? "auto";
  const timeoutMs = request.timeoutMs ?? DEFAULT_RUN_TIMEOUT_MS;
  const resolvedDevice =
    requestedDevice === "cpu" ? "cpu" : await resolveTorchDevice(candidate, env, requestedDevice, PROBE_TIMEOUT_MS, request.signal);
  request.signal?.throwIfAborted();

  await mkdir(request.outputDirectory, { recursive: true });
  // `--repo <models dir>` makes Demucs read ONLY that local repository, and
  // `--name <signature>` selects the checkpoint by the signature its
  // filename carries — Demucs verifies the encoded checksum before loading.
  const args = [
    ...candidate.prefixArgs,
    ...ownedPythonModuleArgs("demucs", [
      "--name",
      spec.signature,
      "--repo",
      resolveModelsDir(env),
      "--device",
      resolvedDevice,
      "--out",
      request.outputDirectory,
      request.inputPath,
    ], true),
  ];

  let lastPercent = -1;
  const outcome = await runPython(candidate.bin, args, await audioToolEnvironment(env), {
    timeoutMs,
    signal: request.signal,
    startGate: true,
    onSpawn: request.onSpawn,
    onStderr: (chunk) => {
      // Demucs renders its progress on stderr with carriage returns; forward
      // the engine's own percent, at most once per whole percent.
      for (const match of chunk.matchAll(/(\d{1,3})%/g)) {
        const percent = Math.min(100, Number(match[1]));
        if (percent === lastPercent) continue;
        lastPercent = percent;
        request.onProgress?.(percent);
      }
    },
  });

  request.signal?.throwIfAborted();
  const tail = (outcome.stderr || outcome.stdout).trim().slice(-2000);
  if (outcome.error !== null && outcome.status === null) {
    throw new SeparationUnavailableError(`The deep engine could not run (${outcome.error.message}). ${deepPrepareHint(env)}`);
  }
  if (outcome.status !== 0) {
    if (/No module named ['"]?(demucs|torch)/i.test(tail)) {
      throw new SeparationUnavailableError(`The deep engine is incomplete: ${tail.slice(-400)}. ${deepPrepareHint(env)}`);
    }
    if (/Invalid checksum|Could not find (a )?pre-trained model|ModelLoadingError/i.test(tail)) {
      // The file is there but is not the checkpoint it claims to be (or the
      // local repository is unreadable) — Demucs' own integrity gate.
      throw new SeparationUnavailableError(
        `The deep model checkpoint at ${ready.checkpointPath} was refused by Demucs: ${tail.slice(-400)}. ${deepCheckpointHint(env)}`,
      );
    }
    throw new Error(`Demucs failed (exit ${outcome.status}): ${tail}`);
  }

  const candidates = await collectWavFiles(request.outputDirectory);
  const stems: DeepRunStem[] = [];
  const missing: string[] = [];
  for (const stemType of spec.stems) {
    const path = candidates.get(`${stemType}.wav`);
    if (path === undefined) {
      missing.push(stemType);
      continue;
    }
    const details = await stat(path);
    if (details.size <= 44) missing.push(stemType);
    else stems.push({ stemType, path, bytes: details.size });
  }
  if (missing.length > 0) {
    throw new Error(
      `Demucs completed without usable output for: ${missing.join(", ")}. ` +
        `The engine is expected to produce all ${spec.stems.length} stems — nothing was stored. ` +
        (tail ? `Engine tail: ${tail.slice(-600)}` : ""),
    );
  }

  return {
    engine: "demucs",
    model: spec.id,
    modelName: spec.name,
    modelVersion: deepModelVersion(ready.demucsVersion, spec.id),
    checkpointPath: ready.checkpointPath,
    checkpointSha256,
    resolvedDevice,
    stems,
  };
}
