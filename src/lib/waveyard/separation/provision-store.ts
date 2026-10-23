/**
 * Deep-engine provisioning — the persistent lifecycle manager.
 *
 * Preparation is a MACHINE-level concern (not a per-project
 * processing job), so it does not ride the processing_jobs table
 * or the queue — and it must not require Redis. Instead it keeps
 * its own small, durable record in the managed environment
 * directory:
 *
 *   preparation.json — the lifecycle state, the plan, progress,
 *     the consent that was granted, the log (sanitized) and the
 *     verified result. Written atomically, so a crash mid-write
 *     never corrupts the last honest state.
 *   preparation.lock — a single-flight guard with a heartbeat.
 *     Two concurrent preparations can never corrupt each other;
 *     a crashed run's lock goes stale and is honestly reported
 *     as recoverable rather than silently retried or stuck.
 *
 * Long-running operations run as a background task in the server
 * process: the start request returns immediately and the UI polls
 * the status, which survives navigation and reconnect (it is on
 * disk). Restarting Arena mid-preparation is detected honestly —
 * the heartbeat of the dead process is stale, so the state is
 * reported as `recovering`, never as a phantom `ready`.
 */

import { DEEP_MODEL_ID, deepModelSpec } from "./modes";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { replaceFile } from "../../fs-replace";

import {
  checkpointChecksumMatches,
  consentSatisfiesPlan,
  isTerminal,
  MANAGED_PYTHON_VERSION,
  planPreparation,
  stateAfterInterruption,
  type EnvironmentReport,
  type PreparationPlan,
  type PreparationState,
  type PreparationStepId,
} from "./provision";
import {
  acquireCheckpoint,
  acquireManagedPython,
  createManagedVenv,
  discoverEnvironment,
  importCheckpoint,
  installDependencies,
  runInferenceProbe,
  freezeDependencies,
  verifyEngine,
  ProvisionCancelledError,
  ProvisionError,
  type ProvisionContext,
} from "./provision-runtime";
import { deepCheckpointPath, resolveDeepEnvDir } from "./deep";
import { resolveModelsDir } from "./session";

// ------------------------------------------------------------ status shape

export type StepState = "pending" | "active" | "done" | "failed" | "skipped";

export type PreparationStatus = {
  state: PreparationState;
  /** The step currently running (null when idle/terminal). */
  step: PreparationStepId | null;
  progress: { percent: number; label: string } | null;
  steps: Array<{ id: PreparationStepId; label: string; state: StepState }>;
  consent: { required: readonly string[]; granted: readonly string[]; grantedAt: string | null };
  error: { code: string; message: string } | null;
  /** Capped, sanitized log — diagnostic output, never secrets. */
  log: readonly string[];
  environment: {
    python: string | null;
    pythonVersion: string | null;
    demucsVersion: string | null;
    torchVersion: string | null;
    checkpointPath: string;
    checkpointPresent: boolean;
    checkpointVerified: boolean | null;
    checkpointSha256?: string;
    dependencyRecordSha256?: string;
    managedEnvDir: string;
    modelsDir: string;
  };
  result: { provenance: string | null; readyAt: string | null };
  startedAt: string | null;
  updatedAt: string;
  completedAt: string | null;
  epoch: string;
  pid: number | null;
};

// ---------------------------------------------------------------- storage

const STATUS_FILE = "preparation.json";
const LOCK_FILE = "preparation.lock";
const MAX_LOG_LINES = 400;

function statusPath(envDir: string, modelId = DEEP_MODEL_ID): string {
  return join(envDir, modelId === DEEP_MODEL_ID ? STATUS_FILE : `preparation-${modelId}.json`);
}

function lockPath(envDir: string): string {
  return join(envDir, LOCK_FILE);
}

/** Write a JSON file atomically (temp + rename) so a crash can
 *  never leave a half-written status. The replace tolerates Windows sharing
 *  violations: `getStatus()` polls this exact file, and a reader holding it
 *  makes the raw rename fail with EPERM (observed on the Windows runner). */
async function writeJsonAtomic(path: string, value: unknown): Promise<void> {
  await mkdir(join(path, ".."), { recursive: true });
  const temp = `${path}.tmp`;
  await writeFile(temp, JSON.stringify(value, null, 2), "utf8");
  await replaceFile(temp, path);
}

async function readJson<T>(path: string): Promise<T | null> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as T;
  } catch {
    return null;
  }
}

// ------------------------------------------------------------ single flight

type LockRecord = { epoch: string; pid: number; startedAt: string; heartbeat: number };

/** A lock is "fresh" when its holder updated its heartbeat within
 *  the window — a crashed process's heartbeat goes stale and the
 *  lock becomes recoverable. */
const LOCK_STALE_MS = 30_000;

async function readLock(envDir: string): Promise<LockRecord | null> {
  return readJson<LockRecord>(lockPath(envDir));
}

async function acquireLock(envDir: string, epoch: string): Promise<boolean> {
  const path = lockPath(envDir);
  const existing = await readLock(envDir);
  if (existing !== null && Date.now() - existing.heartbeat < LOCK_STALE_MS ) {
    return false; // a live preparation is running in another process
  }
  const record: LockRecord = {
    epoch,
    pid: process.pid,
    startedAt: new Date().toISOString(),
    heartbeat: Date.now(),
  };
  if (existing) return false; // stale ownership must be explicitly recovered first
  await mkdir(envDir, { recursive: true });
  try { await writeFile(path, JSON.stringify(record), { flag: "wx" }); return true; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "EEXIST") return false; throw error; }
}

async function releaseLock(envDir: string, epoch: string): Promise<void> {
  const existing = await readLock(envDir);
  if (existing !== null && existing.epoch === epoch) {
    await rm(lockPath(envDir), { force: true }).catch(() => undefined);
  }
}

async function heartbeatLock(envDir: string, epoch: string): Promise<void> {
  const existing = await readLock(envDir);
  if (existing !== null && existing.epoch === epoch) {
    await writeJsonAtomic(lockPath(envDir), { ...existing, heartbeat: Date.now() });
  }
}

// ------------------------------------------------------------ the manager

function freshStatus(envDir: string, modelsDir: string, modelId = DEEP_MODEL_ID): PreparationStatus {
  return {
    state: "not_prepared",
    step: null,
    progress: null,
    steps: [],
    consent: { required: [], granted: [], grantedAt: null },
    error: null,
    log: [],
    environment: {
      python: null,
      pythonVersion: null,
      demucsVersion: null,
      torchVersion: null,
      checkpointPath: deepCheckpointPath({ ...process.env, WAVEYARD_MODELS_DIR: modelsDir }, modelId),
      checkpointPresent: false,
      checkpointVerified: null,
      managedEnvDir: envDir,
      modelsDir,
    },
    result: { provenance: null, readyAt: null },
    startedAt: null,
    updatedAt: new Date().toISOString(),
    completedAt: null,
    epoch: randomUUID(),
    pid: null,
  };
}

export type StartOutcome =
  | { outcome: "started"; epoch: string }
  | { outcome: "already-running"; state: PreparationState }
  | { outcome: "already-ready" }
  | { outcome: "consent-missing"; missing: readonly string[] };

export type PreparationManager = {
  /** The durable status (with honest restart recovery). */
  getStatus(): Promise<PreparationStatus>;
  /** The current environment + the plan + what consent is needed. */
  inspect(): Promise<{ report: EnvironmentReport; plan: PreparationPlan }>;
  /** Start (or resume) preparation with the granted consents. */
  start(grants: readonly string[], retest?: boolean): Promise<StartOutcome>;
  /** Cancel a running preparation. */
  cancel(): Promise<boolean>;
  /** Recover from an interrupted run (clears a stale lock). */
  recover(): Promise<{ ok: boolean; state: PreparationState }>;
  /** Import an owner-owned checkpoint (validated before use). */
  importCheckpoint(sourcePath: string): Promise<{ ok: boolean; error?: string }>;
};

type ManagerState = {
  envDir: string;
  modelsDir: string;
  /** The in-flight run, if any (same-process single flight). */
  active: { epoch: string; cancel: () => void; promise: Promise<void> } | null;
  status: PreparationStatus | null;
};

/** Build the manager bound to a specific environment directory.
 *  Injectable dependencies keep it unit-testable without touching
 *  a real machine. */
export function createPreparationManager(
  options: {
    envDir: string;
    modelsDir: string;
    modelId?: string;
    /** Injectable machine operations (tests supply doubles). */
    runtime?: Partial<typeof import("./provision-runtime")>;
    now?: () => number;
    /** Controlled lifecycle boundary; production has no callback. */
    onReadyPublished?: () => Promise<void>;
  } = { envDir: resolveDeepEnvDir(), modelsDir: resolveModelsDir() },
): PreparationManager {
  const spec = deepModelSpec(options.modelId);
  const modelId = spec.id;
  const envDir = options.envDir;
  const modelsDir = options.modelsDir;
  const runtime = options.runtime ?? ({} as Partial<typeof import("./provision-runtime")>);
  const discover = runtime.discoverEnvironment ?? discoverEnvironment;
  const runManagedPython = runtime.acquireManagedPython ?? acquireManagedPython;
  const runVenv = runtime.createManagedVenv ?? createManagedVenv;
  const runInstall = runtime.installDependencies ?? installDependencies;
  const runAcquire = runtime.acquireCheckpoint ?? acquireCheckpoint;
  const runImport = runtime.importCheckpoint ?? importCheckpoint;
  const runVerify = runtime.verifyEngine ?? verifyEngine;
  const runProbe = runtime.runInferenceProbe ?? runInferenceProbe;
  const runFreeze = runtime.freezeDependencies ?? freezeDependencies;

  const state: ManagerState = { envDir, modelsDir, active: null, status: null };

  const log = (line: string): void => {
    const current = state.status ?? freshStatus(envDir, modelsDir, modelId);
    const stamped = `[${new Date().toISOString()}] ${line}`;
    const log = [...current.log, stamped].slice(-MAX_LOG_LINES);
    state.status = { ...current, log, updatedAt: new Date().toISOString() };
  };

  const persist = async (): Promise<void> => {
    if (state.status !== null) {
      await writeJsonAtomic(statusPath(envDir, modelId), state.status);
    }
  };

  const transition = async (patch: Partial<PreparationStatus>): Promise<void> => {
    const current = state.status ?? freshStatus(envDir, modelsDir, modelId);
    state.status = { ...current, ...patch, updatedAt: new Date().toISOString() };
    await persist();
  };

  /** The durable status, with honest restart recovery: an in-flight
   *  state whose holder died is reported as `recovering`. */
  async function getStatus(): Promise<PreparationStatus> {
    const stored = await readJson<PreparationStatus>(statusPath(envDir, modelId));
    if (stored && !state.active) state.status = stored;
    if (stored === null) {
      // Nothing recorded yet — but reflect the REAL machine state:
      // a valid pointer + checkpoint means ready even with no status file.
      const { readManagedInterpreter } = await import("./deep");
      const managed = readManagedInterpreter({ ...process.env, WAVEYARD_DEEP_ENV_DIR: envDir });
      const checkpoint = deepCheckpointPath({ ...process.env, WAVEYARD_MODELS_DIR: modelsDir }, modelId);
      const present = existsSync(checkpoint);
      if (managed !== null && managed.smokeVerified === true && managed.modelId === modelId && present && managed.checkpointSha256 === await runtimeChecksum(checkpoint).catch(() => null)) {
        return { ...freshStatus(envDir, modelsDir, modelId), state: "ready", result: { provenance: `${spec.name}@${spec.signature}-${spec.checksum}/demucs-${managed.demucsVersion}`, readyAt: managed.preparedAt } };
      }
      return freshStatus(envDir, modelsDir, modelId);
    }
    if (!isTerminal(stored.state) && stored.pid !== null && !state.active) {
      const lock = await readLock(envDir);
      const live = lock !== null && Date.now() - lock.heartbeat < LOCK_STALE_MS;
      if (!live) {
        // The process that was preparing is gone — honest recovery.
        return { ...stored, state: stateAfterInterruption(stored.state) };
      }
    }
    // A remembered `ready` must still be true on disk: if the
    // interpreter or the checkpoint was replaced or removed, the
    // engine is no longer prepared — report that honestly instead
    // of a stale readiness. (The inference gate re-probes anyway;
    // this keeps the STATUS record from lying.)
    if (stored.state === "ready") {
      const pythonGone = stored.environment.python !== null && !existsSync(stored.environment.python);
      const checkpointGone = !existsSync(stored.environment.checkpointPath) || (stored.environment.checkpointSha256 !== undefined && await runtimeChecksum(stored.environment.checkpointPath).catch(() => null) !== stored.environment.checkpointSha256) || (stored.environment.dependencyRecordSha256 !== undefined && await runtimeChecksum(join(envDir, "dependencies.lock.txt")).catch(() => null) !== stored.environment.dependencyRecordSha256);
      if (pythonGone || checkpointGone) {
        const gone = pythonGone ? "the prepared Python interpreter" : "the model checkpoint";
        return {
          ...stored,
          state: "not_prepared",
          error: {
            code: "ENVIRONMENT_CHANGED",
            message:
              `The deep engine is no longer prepared: ${gone} that preparation verified is gone ` +
              `(${pythonGone ? stored.environment.python : stored.environment.checkpointPath}). ` +
              "Run preparation again to restore it.",
          },
        };
      }
    }
    return stored;
  }

  async function inspect(): Promise<{ report: Awaited<ReturnType<typeof discoverEnvironment>>; plan: PreparationPlan }> {
    const report = await discover({ ctx: { log }, modelId });
    const plan = planPreparation(report, { modelsDir, envDir, modelId });
    return { report, plan };
  }

  async function start(grants: readonly string[], retest = false): Promise<StartOutcome> {
    // Same-process single flight.
    if (state.active !== null) {
      const active = state.active;
      const current = await getStatus();
      // Ready is persisted before final heartbeat/lock cleanup settles. A
      // caller observing ready must join that cleanup, not get a phantom run.
      if (current.state === "ready") {
        await active.promise;
        return start(grants, retest);
      }
      return { outcome: "already-running", state: current.state };
    }
    const status = await getStatus();
    if (status.state === "ready" && !retest) {
      // Idempotent: a working, still-valid environment is not
      // reinstalled. (A re-probe is cheap and proves it still runs.)
      return { outcome: "already-ready" };
    }

    const { report, plan } = await inspect();
    if (plan.needsConsent) {
      const check = consentSatisfiesPlan(plan, grants);
      if (!check.ok) {
        return { outcome: "consent-missing", missing: check.missing };
      }
    }

    const epoch = randomUUID();
    const tookLock = await acquireLock(envDir, epoch);
    if (!tookLock) {
      return { outcome: "already-running", state: await currentOrRecoveringState() };
    }

    const controller = new AbortController();
    state.status = {
      ...freshStatus(envDir, modelsDir, modelId),
      state: "checking",
      epoch,
      pid: process.pid,
      startedAt: new Date().toISOString(),
      consent: {
        required: plan.consent.map((item) => item.id),
        granted: [...grants],
        grantedAt: plan.needsConsent ? new Date().toISOString() : null,
      },
      steps: flattenSteps(plan),
    };
    await persist();

    const promise = runPlan(plan, report, { signal: controller.signal, log }, epoch, controller).finally(async () => {
      try { await releaseLock(envDir, epoch); }
      finally { if (state.active?.epoch === epoch) state.active = null; }
    });
    state.active = { epoch, cancel: () => controller.abort(), promise };
    // Track settlement INCLUDING cleanup; active is not cleared prematurely.
    void promise.catch(error => { console.error("Preparation lifecycle persistence failed", error instanceof Error ? error.message : "unknown error"); });
    return { outcome: "started", epoch };
  }

  async function currentOrRecoveringState(): Promise<PreparationState> {
    const status = await getStatus();
    return status.state;
  }

  function flattenSteps(plan: PreparationPlan): PreparationStatus["steps"] {
    const seen = new Set<string>();
    const steps: PreparationStatus["steps"] = [];
    for (const phase of plan.phases) {
      for (const step of phase.steps) {
        if (seen.has(step.id)) continue;
        seen.add(step.id);
        steps.push({ id: step.id, label: step.label, state: "pending" });
      }
    }
    return steps;
  }

  async function runPlan(
    plan: PreparationPlan,
    report: Awaited<ReturnType<typeof discoverEnvironment>>,
    ctx: ProvisionContext,
    epoch: string,
    controller: AbortController,
  ): Promise<void> {
    const setPhase = async (phaseState: PreparationState, stepId: PreparationStepId, label: string) => {
      const current = state.status ?? freshStatus(envDir, modelsDir, modelId);
      const steps = current.steps.map((step) => ({
        ...step,
        state: step.id === stepId ? ("active" as StepState) : step.state === "active" ? ("done" as StepState) : step.state,
      }));
      await transition({ state: phaseState, step: stepId, progress: { percent: 0, label }, steps });
    };

    let pendingHeartbeat = Promise.resolve();
    const heartbeat = setInterval(() => { pendingHeartbeat = pendingHeartbeat.then(async () => { await heartbeatLock(envDir, epoch); await persist(); }).catch(error => { controller.abort(error); }); }, 5_000);
    heartbeat.unref?.();

    try {
      // --- discovering (already done for planning; re-affirm) ---
      await setPhase("checking", "discover", "Inspecting this machine");
      const base = report.compatiblePython;
      const managedPointer = await import("./deep").then((m) => m.readManagedInterpreter({ ...process.env, WAVEYARD_DEEP_ENV_DIR: envDir }));

      // --- python / environment ---
      let python: string | null = managedPointer?.python ?? null;
      if (base === null && python === null) {
        await setPhase("preparing_python", "python", "Preparing a managed Python");
        python = await runManagedPython(envDir, ctx);
      } else if (base !== null && python === null) {
        await setPhase("preparing_python", "environment", "Creating an isolated environment");
        python = await runVenv(base.bin, envDir, ctx);
      }
      if (python === null) {
        throw new ProvisionError("NO_INTERPRETER", "No compatible Python interpreter could be prepared.");
      }

      // --- dependencies ---
      const needsDeps = base === null || base.demucsVersion === null || !existsSync(join(envDir, "interpreter.json"));
      if (needsDeps) {
        await setPhase("installing_dependencies", "dependencies", "Installing the engine's dependencies");
        await runInstall(python, ctx);
      }

      // --- checkpoint ---
      const checkpointFinal = deepCheckpointPath({ ...process.env, WAVEYARD_MODELS_DIR: modelsDir }, modelId);
      const checkpointOk =
        existsSync(checkpointFinal) &&
        checkpointChecksumMatches(await runtimeChecksum(checkpointFinal), modelId);
      if (!checkpointOk) {
        await setPhase("acquiring_model", "checkpoint", "Acquiring the deep model");
        await runAcquire(modelsDir, ctx, { modelId });
      }

      // --- verify ---
      await setPhase("verifying_model", "verify", "Verifying the model and dependencies");
      const verified = await runVerify(python, ctx);

      // --- probe (the genuine readiness gate) ---
      await setPhase("testing_engine", "probe", "Testing real inference");
      await runProbe(python, modelsDir, ctx, modelId);
      const frozen = await runFreeze(python, ctx);
      await writeFile(join(envDir, "dependencies.lock.txt"), frozen);
      if (ctx.signal?.aborted) throw new ProvisionCancelledError();

      // --- ready: publish the pointer ONLY after the probe passes ---
      const pointer = {
        python,
        pythonVersion: base?.version ?? MANAGED_PYTHON_VERSION,
        demucsVersion: verified.demucsVersion,
        venv: join(envDir, "venv"),
        preparedAt: new Date().toISOString(),
        checkpointSha256: await runtimeChecksum(checkpointFinal),
        smokeVerified: true,
        modelId,
      };
      await writeJsonAtomic(join(envDir, "interpreter.json"), pointer);
      const provenance = `${spec.name}@${spec.signature}-${spec.checksum}/demucs-${verified.demucsVersion}`;
      await transition({
        state: "ready",
        step: null,
        progress: { percent: 100, label: "Ready" },
        environment: {
          python,
          pythonVersion: pointer.pythonVersion,
          demucsVersion: verified.demucsVersion,
          torchVersion: verified.torchVersion,
          checkpointPath: checkpointFinal,
          checkpointPresent: true,
          checkpointVerified: true,
          checkpointSha256: pointer.checkpointSha256,
          dependencyRecordSha256: await runtimeChecksum(join(envDir, "dependencies.lock.txt")),
          managedEnvDir: envDir,
          modelsDir,
        },
        result: { provenance, readyAt: new Date().toISOString() },
        completedAt: new Date().toISOString(),
      });
      await options.onReadyPublished?.();
      if (state.status !== null) {
        const steps = state.status.steps.map((step) => ({ ...step, state: "done" as StepState }));
        state.status.steps = steps;
        await persist();
      }
      log(`Deep separation engine is ready (${provenance}).`);
    } catch (error) {
      const cancelled = error instanceof ProvisionCancelledError || (ctx.signal?.aborted === true && error instanceof Error && /abort/i.test(error.message));
      const code = error instanceof ProvisionError ? error.code : "PROVISION_FAILED";
      const message = error instanceof Error ? error.message : String(error);
      log(`${cancelled ? "Cancelled" : "Failed"}: ${message}`);
      await transition({
        state: cancelled ? "cancelled" : "failed",
        step: null,
        progress: null,
        error: { code, message },
        completedAt: new Date().toISOString(),
      });
      if (state.status !== null) {
        const steps = state.status.steps.map((step) => ({
          ...step,
          state: step.state === "active" ? ("failed" as StepState) : step.state,
        }));
        state.status.steps = steps;
        await persist();
      }
    } finally {
      clearInterval(heartbeat);
      await pendingHeartbeat;
    }
  }

  async function runtimeChecksum(path: string): Promise<string> {
    const { checksumFile } = await import("../audio");
    return checksumFile(path);
  }

  async function cancel(): Promise<boolean> {
    if (state.active !== null) {
      state.active.cancel();
      return true;
    }
    const status = await getStatus();
    const peer = await readLock(envDir);
    if (peer && Date.now() - peer.heartbeat < LOCK_STALE_MS) return false;
    if (!isTerminal(status.state)) {
      await transition({ state: "cancelled", completedAt: new Date().toISOString() });
      return true;
    }
    return false;
  }

  async function recover(): Promise<{ ok: boolean; state: PreparationState }> {
    const lock = await readLock(envDir);
    if (state.active || (lock !== null && Date.now() - lock.heartbeat < LOCK_STALE_MS)) return { ok: false, state: (await getStatus()).state };
    if (lock !== null) {
      await rm(lockPath(envDir), { force: true }).catch(() => undefined);
    }
    const status = await getStatus();
    if (status.state === "recovering") {
      await transition({ state: "not_prepared", pid: null });
    }
    return { ok: true, state: (await getStatus()).state };
  }

  async function importOwnerCheckpoint(sourcePath: string): Promise<{ ok: boolean; error?: string }> {
    try {
      const ctx: ProvisionContext = { log };
      await runImport(sourcePath, modelsDir, ctx, { modelId });
      return { ok: true };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { ok: false, error: message };
    }
  }

  return { getStatus, inspect, start, cancel, recover, importCheckpoint: importOwnerCheckpoint };
}

// The process-wide manager (Turbopack may instantiate this module
// twice; like the local broker it lives on globalThis).
const globalForProvision = globalThis as typeof globalThis & {
  __arenaDeepProvision?: Map<string, ReturnType<typeof createPreparationManager>>;
};

/** The app's preparation manager, bound to the configured
 *  environment and models directories. */
export function getPreparationManager(modelId = DEEP_MODEL_ID): PreparationManager {
  const spec = deepModelSpec(modelId);
  globalForProvision.__arenaDeepProvision ??= new Map();
  let manager = globalForProvision.__arenaDeepProvision.get(spec.id);
  if (!manager) { manager = createPreparationManager({ envDir: resolveDeepEnvDir(), modelsDir: resolveModelsDir(), modelId }); globalForProvision.__arenaDeepProvision.set(spec.id, manager); }
  return manager;
}

export function resetPreparationManagerForTests(): void {
  delete globalForProvision.__arenaDeepProvision;
}
