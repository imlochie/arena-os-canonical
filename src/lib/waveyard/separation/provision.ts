/**
 * Deep-engine provisioning — the PURE planning, state and validation
 * layer (no filesystem, no network, no subprocesses).
 *
 * This module answers, for the environment it is handed:
 *  - what is present vs missing (Python, dependencies, checkpoint,
 *    FFmpeg);
 *  - what the ordered preparation plan is;
 *  - what the owner must consent to (installs, downloads) and why;
 *  - which lifecycle state the preparation is in, and how it moves.
 *
 * It is deliberately free of I/O so it can be unit-tested without a
 * machine, imported by server routes, and (for the vocabulary it
 * exports) shared with the client. Every I/O fact (a version string, a
 * file's presence, a download's bytes) is gathered by
 * provision-runtime.ts and passed IN as data — never discovered here.
 *
 * Authoritative upstream facts this module encodes (verified against
 * facebookresearch/demucs and PyPI, 2026-10; see
 * docs/DEEP-ENGINE-PROVISIONING.md):
 *  - Demucs 4.0.1 is the selected legacy-checkpoint compatibility baseline;
 *    4.1.0 is now published and is NOT silently installed.
 *  - Its runtime pins `torchaudio>=0.8,<2.1`; torchaudio 2.0.x ships
 *    Windows wheels only for CPython 3.8–3.11, so the reliable baseline
 *    is CPython 3.10/3.11 + torch 2.0.1 + torchaudio 2.0.1 (CPU).
 *    Python 3.12 cannot run that stack — the single most common
 *    "prepared the wrong way" trap on a fresh Windows machine.
 *  - The one checkpoint the deep pass loads is `5c90dfd2-34c22ccb.th`
 *    (htdemucs_6s). Demucs' own integrity gate is the 8-hex sha256
 *    prefix encoded in the filename (`repo.check_checksum`); Arena
 *    verifies the SAME prefix, never an invented digest.
 *  - The checkpoint's authoritative source is Demucs' own remote
 *    index (`dl.fbaipublicfiles.com/demucs/hybrid_transformer/…`).
 */

import { DEEP_MODEL_ID, deepModelSpec } from "./modes";

// ---------------------------------------------------------------- pins

/** Explicit legacy-checkpoint baseline, NOT a claim of the latest release. */
export const DEMUCS_VERSION = "4.0.1";
/** torch/torchaudio pair that satisfies Demucs' `torchaudio>=0.8,<2.1`
 *  pin and has Windows wheels for the supported CPython range. */
export const TORCH_VERSION = "2.0.1";
export const TORCHAUDIO_VERSION = "2.0.2";
/** PyTorch's official CPU-wheel index — the reliable baseline (GPU is an
 *  additional, separately-verifiable capability, never the default). */
export const PYTORCH_CPU_INDEX = "https://download.pytorch.org/whl/cpu";
/** The official Python package index. */
export const PYPI_INDEX = "https://pypi.org/simple";

/** The managed CPython Arena can acquire when no compatible system
 *  interpreter exists (the newest CPython with torchaudio 2.0.x
 *  wheels). */
export const MANAGED_PYTHON_VERSION = "3.11.9";

/** CPython versions the pinned Demucs stack can run on. */
export const SUPPORTED_PYTHON_RANGE = { minMajor: 3, minMinor: 10, maxMajor: 3, maxMinor: 11 } as const;

// ------------------------------------------------------------ python fit

export type PythonFit =
  | { ok: true; python: string; version: string }
  | { ok: false; reason: string };

/** Evaluate a candidate interpreter's version against the supported
 *  range. Pure: the version string is whatever discovery reported. */
export function evaluatePythonVersion(version: string | null): PythonFit {
  if (version === null) {
    return { ok: false, reason: "The interpreter did not report a version." };
  }
  const match = /^(\d+)\.(\d+)(?:\.(\d+))?/.exec(version.trim());
  if (match === null) {
    return { ok: false, reason: `Could not read the interpreter version ("${version}").` };
  }
  const major = Number(match[1]);
  const minor = Number(match[2]);
  const { minMajor, minMinor, maxMajor, maxMinor } = SUPPORTED_PYTHON_RANGE;
  const tooOld = major < minMajor || (major === minMajor && minor < minMinor);
  const tooNew = major > maxMajor || (major === maxMajor && minor > maxMinor);
  if (tooOld) {
    return {
      ok: false,
      reason:
        `Python ${major}.${minor} is too old — the deep engine (Demucs ${DEMUCS_VERSION} on ` +
        `torch ${TORCH_VERSION}) needs Python ${minMajor}.${minMinor}–${maxMajor}.${maxMinor}.`,
    };
  }
  if (tooNew) {
    return {
      ok: false,
      reason:
        `Python ${major}.${minor} cannot run this engine reliably: Demucs ${DEMUCS_VERSION} needs ` +
        `torchaudio ≤ 2.1 (its own Windows guide), and torchaudio 2.0.x/2.1.x ship wheels only for ` +
        `CPython 3.8–3.11 — there is no CPython ${major}.${minor} wheel for that line. ` +
        `Python ${minMajor}.${minMinor}–${maxMajor}.${maxMinor} is the reliable baseline.`,
    };
  }
  return { ok: true, python: `${major}.${minor}`, version };
}

// ---------------------------------------------------------------- states

/**
 * The preparation lifecycle — honest, distinguishable states. Adapted
 * to the product's existing vocabulary (a preparation is a machine-level
 * concern, not a per-project processing job, so it keeps its own small
 * state set rather than reusing the job queue's states).
 */
export type PreparationState =
  | "not_prepared"
  | "checking"
  | "awaiting_consent"
  | "preparing_python"
  | "installing_dependencies"
  | "acquiring_model"
  | "verifying_model"
  | "testing_engine"
  | "ready"
  | "failed"
  | "cancelled"
  | "recovering";

/** Ordered steps of a preparation run (the plan the UI renders). */
export type PreparationStepId =
  | "discover"
  | "python"
  | "environment"
  | "dependencies"
  | "checkpoint"
  | "verify"
  | "probe";

export type PreparationStep = {
  id: PreparationStepId;
  label: string;
  detail: string;
};

export type PreparationPhase = {
  /** The lifecycle state this phase lands in while it runs. */
  state: PreparationState;
  steps: readonly PreparationStep[];
};

/** The plan: which phases are needed, given what discovery found. */
export type PreparationPlan = {
  phases: readonly PreparationPhase[];
  /** True when a substantial download/install needs explicit consent. */
  needsConsent: boolean;
  consent: readonly ConsentItem[];
};

export type ConsentItem = {
  id: string;
  kind: "runtime" | "install" | "download";
  /** What will happen, in product vocabulary. */
  label: string;
  /** Why it is required. */
  reason: string;
  /** Expected size in bytes where verified upstream, else null. */
  sizeBytes: number | null;
  /** The verified source (host) it comes from. */
  source: string;
  /** Where it is stored. */
  destination: string;
  /** Material licensing / usage conditions the owner must see. */
  license: string;
};

// ------------------------------------------------------------- environment

export type DiscoveredPython = {
  bin: string;
  prefixArgs: readonly string[];
  source: "env" | "managed" | "system";
  /** e.g. "3.11.9"; null when the interpreter could not be run. */
  version: string | null;
  /** The Demucs package version it reports, or null when absent. */
  demucsVersion: string | null;
};

export type DiscoveredCheckpoint = {
  path: string;
  present: boolean;
  /** sha256 hex of the on-disk file, when present. */
  sha256: string | null;
  sizeBytes: number | null;
};

export type EnvironmentReport = {
  python: readonly DiscoveredPython[];
  /** The interpreter preparation should build on, if any is compatible. */
  compatiblePython: DiscoveredPython | null;
  checkpoint: DiscoveredCheckpoint;
  ffmpegPresent: boolean;
  ffprobePresent: boolean;
  /** True when Arena already prepared a managed environment here. */
  managedEnvironmentExists: boolean;
};

/** Is a discovered interpreter within the supported CPython range? */
export function interpreterIsCompatible(candidate: DiscoveredPython): boolean {
  return evaluatePythonVersion(candidate.version).ok;
}

/** The interpreter preparation should use: a compatible managed one
 *  first (Arena's own prepared environment), then any compatible
 *  system/env interpreter. Null when none is usable. */
export function selectBaseInterpreter(report: EnvironmentReport): DiscoveredPython | null {
  for (const candidate of report.python) {
    if (interpreterIsCompatible(candidate)) return candidate;
  }
  return null;
}

// ------------------------------------------------------------ checkpoint

/** The upstream integrity contract: the checkpoint's filename encodes
 *  the first 8 hex chars of its sha256 (Demucs `repo.check_checksum`).
 *  A downloaded or imported file is valid only when its full sha256
 *  begins with that prefix. */
export function checkpointChecksumMatches(sha256Hex: string, modelId = DEEP_MODEL_ID): boolean {
  return sha256Hex.toLowerCase() === deepModelSpec(modelId).sha256;
}

/** The checkpoint's provenance string (family@signature-checksum/engine). */
export function checkpointProvenance(demucsVersion: string, modelId = DEEP_MODEL_ID): string {
  const spec = deepModelSpec(modelId); return `${spec.name}@${spec.signature}-${spec.checksum}/demucs-${demucsVersion}`;
}

// --------------------------------------------------------------- planning

/**
 * Build the ordered preparation plan from a real environment report.
 * Pure: the same report always yields the same plan, so planning is
 * unit-testable without a machine.
 */
export function planPreparation(report: EnvironmentReport, opts: { modelsDir: string; envDir: string; modelId?: string }): PreparationPlan {
  const phases: PreparationPhase[] = [];
  const spec = deepModelSpec(opts.modelId);
  const consent: ConsentItem[] = [];

  phases.push({
    state: "checking",
    steps: [{ id: "discover", label: "Inspecting this machine", detail: "Python, dependencies, checkpoint and FFmpeg." }],
  });

  const base = selectBaseInterpreter(report);
  if (base === null) {
    // No compatible interpreter: acquire Arena's own managed CPython.
    phases.push({
      state: "preparing_python",
      steps: [{ id: "python", label: "Preparing a managed Python", detail: `CPython ${MANAGED_PYTHON_VERSION}, isolated inside Arena's data directory.` }],
    });
    consent.push({
      id: "python-runtime",
      kind: "runtime",
      label: `Download CPython ${MANAGED_PYTHON_VERSION} (embeddable, ~11 MB)`,
      reason:
        "No compatible Python interpreter (3.10–3.11) was found. Demucs " +
        `${DEMUCS_VERSION} needs Python 3.10–3.11; the interpreter on this machine reports a version ` +
        "its torchaudio pin has no wheels for. Arena keeps this runtime inside its own data directory — nothing is installed system-wide.",
      sizeBytes: 11_000_000,
      source: "www.python.org (the official CPython distribution)",
      destination: opts.envDir,
      license: "Python Software Foundation License (PSF); the runtime is downloaded, not redistributed by Arena.",
    });
  }

  const needsVenv = base !== null || report.managedEnvironmentExists === false;
  if (base !== null && !report.managedEnvironmentExists) {
    phases.push({
      state: "preparing_python",
      steps: [{ id: "environment", label: "Creating an isolated environment", detail: `A virtual environment inside ${opts.envDir}, separate from global Python.` }],
    });
  }

  const dependenciesMissing =
    base === null || base.demucsVersion === null || !report.managedEnvironmentExists;
  if (dependenciesMissing) {
    phases.push({
      state: "installing_dependencies",
      steps: [{ id: "dependencies", label: "Installing the engine's dependencies", detail: `Demucs ${DEMUCS_VERSION}, PyTorch ${TORCH_VERSION} (CPU) and torchaudio ${TORCHAUDIO_VERSION} — pinned, inside the isolated environment only.` }],
    });
    consent.push({
      id: "python-packages",
      kind: "install",
      label: `Install Demucs ${DEMUCS_VERSION} + PyTorch ${TORCH_VERSION} (CPU) into the isolated environment`,
      reason: "The deep engine runs Demucs, which needs PyTorch. These are installed only into Arena's isolated environment — global Python is untouched.",
      sizeBytes: null, // exact size is read from the download at runtime
      source: `${PYPI_INDEX} and ${PYTORCH_CPU_INDEX} (the packages' official indexes)`,
      destination: opts.envDir,
      license: "Demucs and PyTorch are BSD/MIT-style licensed; the model weights are separate (see the checkpoint step).",
    });
  }

  if (!report.checkpoint.present || !checkpointChecksumMatches(report.checkpoint.sha256 ?? "", spec.id)) {
    phases.push({
      state: "acquiring_model",
      steps: [{ id: "checkpoint", label: "Acquiring the deep model", detail: `${spec.file} (${spec.name}, ~${Math.round(spec.approximateBytes / 1_000_000)} MB) from Demucs' official model store.` }],
    });
    consent.push({
      id: "model-checkpoint",
      kind: "download",
      label: `Download the ${spec.name} model checkpoint`,
      reason:
        "The deep pass loads exactly this checkpoint. Arena fetches it from Demucs' own published model store — the same file Demucs itself downloads — and verifies its integrity before use.",
      sizeBytes: spec.approximateBytes,
      source: "dl.fbaipublicfiles.com (Meta's official Demucs model store)",
      destination: opts.modelsDir,
      license:
        "Upstream declares Demucs MIT (https://github.com/adefossez/demucs/blob/main/LICENSE). A separate checkpoint-use grant was not independently established; review your permission before acquisition. " +
        "Code licensing does not establish recording permissions or a commercial-use warranty.",
    });
  }

  phases.push({
    state: "verifying_model",
    steps: [{ id: "verify", label: "Verifying the model and dependencies", detail: "Checksum the checkpoint and confirm the engine imports." }],
  });
  phases.push({
    state: "testing_engine",
    steps: [{ id: "probe", label: "Testing real inference", detail: "Run the engine on a short signal and confirm all six stems come back." }],
  });

  return { phases, needsConsent: consent.length > 0, consent };
}

// ---------------------------------------------------------- state machine

/** Terminal states: nothing further happens without a new request. */
export const TERMINAL_STATES: readonly PreparationState[] = ["ready", "failed", "cancelled"];

export function isTerminal(state: PreparationState): boolean {
  return (TERMINAL_STATES as readonly string[]).includes(state);
}

/** The state a preparation is in after a restart mid-run. Honest: the
 *  process that was doing the work is gone, so it cannot claim to be
 *  mid-step — it reports that it was interrupted and can be resumed. */
export function stateAfterInterruption(state: PreparationState): PreparationState {
  if (state === "ready") return "ready";
  if (isTerminal(state)) return state;
  return "recovering";
}

/** Validate a consent grant against what the plan actually requires.
 *  Pure — the route checks this before starting anything. */
export function consentSatisfiesPlan(
  plan: PreparationPlan,
  grants: readonly string[],
): { ok: boolean; missing: readonly string[] } {
  const granted = new Set(grants);
  const missing = plan.consent.map((item) => item.id).filter((id) => !granted.has(id));
  return { ok: missing.length === 0, missing };
}
