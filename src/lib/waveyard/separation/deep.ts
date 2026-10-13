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
import { mkdir, readdir, stat } from "node:fs/promises";
import { join } from "node:path";

import { SeparationUnavailableError } from "./session";
import { processingModeExplanation, resolveProcessingMode } from "../worker-local/runtime-policy";
import {
  DEEP_LABEL,
  DEEP_MODEL_ID,
  DEEP_STEM_TYPES,
  type DeepStemType,
} from "./modes";

/** The Demucs model family the deep pass runs (six sources). */
export const DEEP_MODEL_NAME = "htdemucs_6s";

const PROBE_TIMEOUT_MS = 20_000;
const DEFAULT_RUN_TIMEOUT_MS = 60 * 60 * 1000;

/** How the machine is prepared — the exact step to take when it is not. */
export function deepPrepareHint(): string {
  const interpreter = process.platform === "win32" ? "py -3" : "python3";
  return (
    `Install Demucs on this machine ("${interpreter} -m pip install demucs"), or point ` +
    "WAVEYARD_DEEP_PYTHON at an interpreter that has it, then retry. The deep pass runs " +
    "your own local engine — nothing is downloaded from here."
  );
}

// ------------------------------------------------------------ interpreter

export type DeepPythonCandidate = {
  bin: string;
  /** Prefix args (Windows launcher: py -3). */
  prefixArgs: string[];
  source: "env" | "path";
};

/** Candidate interpreters, most explicit first. */
export function deepPythonCandidates(env: NodeJS.ProcessEnv = process.env): DeepPythonCandidate[] {
  const candidates: DeepPythonCandidate[] = [];
  const seen = new Set<string>();
  const push = (bin: string | undefined, prefixArgs: string[], source: "env" | "path") => {
    const trimmed = bin?.trim();
    if (!trimmed || seen.has(trimmed)) return;
    seen.add(trimmed);
    candidates.push({ bin: trimmed, prefixArgs, source });
  };
  push(env.WAVEYARD_DEEP_PYTHON, [], "env");
  push(env.PYTHON_BIN, [], "env");
  if (process.platform === "win32") {
    push(env.WAVEYARD_DEEP_PYTHON ? undefined : "py", ["-3"], "path");
    push("python", [], "path");
  } else {
    push("python3", [], "path");
    push("python", [], "path");
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
  pythonSource: "env" | "path";
  demucsVersion: string;
  modelId: string;
  modelName: string;
  label: string;
  stems: readonly DeepStemType[];
};

export type DeepEngineMissing = {
  prepared: false;
  python: string | null;
  reason: string;
  modelId: string;
  modelName: string;
  label: string;
  stems: readonly DeepStemType[];
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

const probeCache = new Map<string, DeepEngineStatus>();

/** Test seam: probes are cached per interpreter set; tests reset between
 *  stub drivers. */
export function resetDeepProbeCacheForTests(): void {
  probeCache.clear();
}

/**
 * Is this machine prepared for the deep pass? Cheap, synchronous, cached per
 * interpreter set — safe to call from a route to gate a request before any
 * work is queued. Never throws.
 */
export function probeDeepEngine(options: { env?: NodeJS.ProcessEnv; force?: boolean } = {}): DeepEngineStatus {
  const env = options.env ?? process.env;
  const candidates = deepPythonCandidates(env);
  const cacheKey = candidates.map((candidate) => `${candidate.bin} ${candidate.prefixArgs.join(" ")}`).join("|");
  if (!options.force) {
    const cached = probeCache.get(cacheKey);
    if (cached !== undefined) return cached;
  }

  const base = { modelId: DEEP_MODEL_ID, modelName: DEEP_MODEL_NAME, label: DEEP_LABEL, stems: DEEP_STEM_TYPES } as const;
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
      const status: DeepEngineStatus = {
        ...base,
        prepared: true,
        python: candidate.bin,
        pythonSource: candidate.source,
        demucsVersion,
      };
      probeCache.set(cacheKey, status);
      return status;
    }
    // The interpreter ran but has no Demucs — remember it as the reason.
    lastError = `Demucs is not installed for "${candidate.bin}".`;
  }

  const reason =
    lastError === null || candidates.length === 0
      ? `Deep separation needs a Python interpreter with Demucs installed, and none was found on this machine. ${deepPrepareHint()}`
      : `${lastError} ${deepPrepareHint()}`;
  const status: DeepEngineStatus = { ...base, prepared: false, python: null, reason };
  probeCache.set(cacheKey, status);
  return status;
}

/**
 * The runtime-aware answer routes and UI should use: the deep pass executes
 * in-process (it shells out from the app's own local worker), so a
 * deployment that processes through an external worker or has no processor
 * at all reports that honestly instead of probing for an engine it would
 * never run.
 */
export function deepEngineStatusForThisRuntime(env: NodeJS.ProcessEnv = process.env): DeepEngineStatus {
  const mode = resolveProcessingMode(env);
  if (mode !== "in-process") {
    return {
      prepared: false,
      python: null,
      reason: `The deep pass runs on this machine's own engine, inside the app process. ${processingModeExplanation(mode)}`,
      modelId: DEEP_MODEL_ID,
      modelName: DEEP_MODEL_NAME,
      label: DEEP_LABEL,
      stems: DEEP_STEM_TYPES,
    };
  }
  return probeDeepEngine({ env });
}

// -------------------------------------------------------------------- run

export type DeepRunRequest = {
  /** Input audio file (the handler writes the decoded 44.1 kHz WAV here). */
  inputPath: string;
  /** Directory Demucs writes into; scanned recursively for the six stems. */
  outputDirectory: string;
  requestedDevice?: "auto" | "cpu" | "cuda";
  /** The engine's own percent, throttled by the caller. */
  onProgress?: (percent: number) => void;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
};

export type DeepRunStem = { stemType: DeepStemType; path: string; bytes: number };

export type DeepRunResult = {
  engine: "demucs";
  model: string;
  modelName: string;
  modelVersion: string;
  resolvedDevice: "cpu" | "cuda";
  stems: DeepRunStem[];
};

type SpawnedOutcome = { status: number | null; stdout: string; stderr: string; error: Error | null };

function runPython(
  bin: string,
  args: string[],
  env: NodeJS.ProcessEnv,
  options: { timeoutMs: number; onStderr?: (chunk: string) => void; onStdout?: (chunk: string) => void },
): Promise<SpawnedOutcome> {
  return new Promise((resolvePromise) => {
    const child = spawn(bin, args, { env: childEnv(env), stdio: ["ignore", "pipe", "pipe"] });
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
      stdout += text;
      options.onStdout?.(text);
    });
    child.stderr?.on("data", (data: Buffer) => {
      const text = data.toString();
      stderr += text;
      options.onStderr?.(text);
    });
    const finish = (outcome: SpawnedOutcome) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolvePromise(outcome);
    };
    child.once("error", (error: Error) => finish({ status: null, stdout, stderr, error }));
    child.once("close", (code: number | null) =>
      finish({
        status: code,
        stdout,
        stderr,
        error: timedOut ? new Error(`timed out after ${Math.round(options.timeoutMs / 1000)}s`) : null,
      }),
    );
  });
}

async function resolveTorchDevice(
  candidate: DeepPythonCandidate,
  env: NodeJS.ProcessEnv,
  requested: "auto" | "cuda",
  timeoutMs: number,
): Promise<"cpu" | "cuda"> {
  const outcome = await runPython(candidate.bin, [...candidate.prefixArgs, "-c", TORCH_SNIPPET], env, { timeoutMs });
  const parsed = outcome.status === 0 ? parseJsonLine(outcome.stdout) : null;
  if (parsed === null) {
    throw new SeparationUnavailableError(
      `The deep engine's PyTorch runtime could not be interrogated (${
        outcome.error?.message ?? (outcome.stderr || `exit ${outcome.status}`).trim().slice(-200)
      }). ${deepPrepareHint()}`,
    );
  }
  if (typeof parsed.error === "string") {
    throw new SeparationUnavailableError(`PyTorch is not installed for "${candidate.bin}". ${deepPrepareHint()}`);
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
export async function runDeepSeparation(request: DeepRunRequest): Promise<DeepRunResult> {
  const env = request.env ?? process.env;
  const status = probeDeepEngine({ env });
  if (!status.prepared) throw new SeparationUnavailableError(status.reason);
  const ready: DeepEngineReady = status;
  const candidate =
    deepPythonCandidates(env).find((entry) => entry.bin === ready.python) ?? deepPythonCandidates(env)[0];
  if (candidate === undefined) throw new SeparationUnavailableError(deepPrepareHint());

  const requestedDevice = request.requestedDevice ?? "auto";
  const timeoutMs = request.timeoutMs ?? DEFAULT_RUN_TIMEOUT_MS;
  const resolvedDevice =
    requestedDevice === "cpu" ? "cpu" : await resolveTorchDevice(candidate, env, requestedDevice, PROBE_TIMEOUT_MS);

  await mkdir(request.outputDirectory, { recursive: true });
  const args = [
    ...candidate.prefixArgs,
    "-m",
    "demucs",
    "--name",
    DEEP_MODEL_NAME,
    "--device",
    resolvedDevice,
    "--out",
    request.outputDirectory,
    request.inputPath,
  ];

  let lastPercent = -1;
  const outcome = await runPython(candidate.bin, args, env, {
    timeoutMs,
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

  const tail = (outcome.stderr || outcome.stdout).trim().slice(-2000);
  if (outcome.error !== null && outcome.status === null) {
    throw new SeparationUnavailableError(`The deep engine could not run (${outcome.error.message}). ${deepPrepareHint()}`);
  }
  if (outcome.status !== 0) {
    if (/No module named ['"]?(demucs|torch)/i.test(tail)) {
      throw new SeparationUnavailableError(`The deep engine is incomplete: ${tail.slice(-400)}. ${deepPrepareHint()}`);
    }
    throw new Error(`Demucs failed (exit ${outcome.status}): ${tail}`);
  }

  const candidates = await collectWavFiles(request.outputDirectory);
  const stems: DeepRunStem[] = [];
  const missing: string[] = [];
  for (const stemType of DEEP_STEM_TYPES) {
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
        `The engine is expected to produce all ${DEEP_STEM_TYPES.length} stems — nothing was stored. ` +
        (tail ? `Engine tail: ${tail.slice(-600)}` : ""),
    );
  }

  return {
    engine: "demucs",
    model: DEEP_MODEL_ID,
    modelName: DEEP_MODEL_NAME,
    modelVersion: `${DEEP_MODEL_NAME}@demucs-${ready.demucsVersion}`,
    resolvedDevice,
    stems,
  };
}
