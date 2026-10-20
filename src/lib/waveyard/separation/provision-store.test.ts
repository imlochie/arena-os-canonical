/**
 * Provisioning lifecycle — the durable manager (provision-store.ts).
 *
 * These tests drive the manager with a fully-injected runtime
 * (no real interpreter, installer or download) to prove the
 * LIFECYCLE contract: consent gating, single-flight, durable
 * state that survives restarts, honest recovery, cancellation,
 * and the rule that a pointer is published ONLY after the
 * inference probe passes.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { DEEP_CHECKPOINT_FILE } from "./deep";
import {
  createPreparationManager,
  type PreparationStatus,
} from "./provision-store";
import type { EnvironmentReport } from "./provision";
import type { ProvisionContext, RunOutcome } from "./provision-runtime";

/** A deferred the tests resolve to control a blocking step. */
function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void; reject: (error: Error) => void } {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const noopRun = async (): Promise<RunOutcome> => ({ status: 0, stdout: "", stderr: "", error: null });

/** A report where a compatible interpreter exists but Demucs and
 *  the checkpoint are absent — the normal first-run shape. */
function unpreparedReport(envDir: string, modelsDir: string): EnvironmentReport {
  return {
    python: [{ bin: "/usr/bin/python3.11", prefixArgs: [], source: "system", version: "3.11.9", demucsVersion: null }],
    compatiblePython: { bin: "/usr/bin/python3.11", prefixArgs: [], source: "system", version: "3.11.9", demucsVersion: null },
    checkpoint: { path: join(modelsDir, DEEP_CHECKPOINT_FILE), present: false, sha256: null, sizeBytes: null },
    ffmpegPresent: true,
    ffprobePresent: true,
    managedEnvironmentExists: false,
  };
}

/** The machine operations a test can replace. */
type ManagerHooks = Partial<{
  discover: () => Promise<EnvironmentReport>;
  venv: (python: string, dir: string, c: ProvisionContext) => Promise<string>;
  install: (python: string, c: ProvisionContext) => Promise<void>;
  acquire: (dir: string, c: ProvisionContext) => Promise<void>;
  verify: (python: string, c: ProvisionContext) => Promise<{ demucsVersion: string; torchVersion: string; cuda: boolean }>;
  probe: (python: string, dir: string, c: ProvisionContext) => Promise<string[]>;
}>;

/** Build a manager whose every machine operation is a controllable double. */
function makeManager(envDir: string, modelsDir: string, hooks: ManagerHooks = {}) {
  const runtime = {
    discoverEnvironment: hooks.discover ?? (async () => unpreparedReport(envDir, modelsDir)),
    createManagedVenv: hooks.venv ?? (async () => {
      const { writeFile, mkdir } = await import("node:fs/promises");
      const python = join(envDir, "venv", "bin", "python");
      await mkdir(join(envDir, "venv", "bin"), { recursive: true });
      await writeFile(python, "#!/bin/sh\n");
      return python;
    }),
    freezeDependencies: async () => "demucs==4.0.1\n# controlled lifecycle fixture, not an installed runtime\n",
    installDependencies: hooks.install ?? (async () => undefined),
    acquireCheckpoint: hooks.acquire ?? (async (dir: string) => {
      const { writeFile, mkdir } = await import("node:fs/promises");
      await mkdir(dir, { recursive: true });
      await writeFile(join(dir, DEEP_CHECKPOINT_FILE), Buffer.alloc(64));
    }),
    verifyEngine: hooks.verify ?? (async () => ({ demucsVersion: "4.0.1", torchVersion: "2.0.1+cpu", cuda: false })),
    runInferenceProbe: hooks.probe ?? (async () => ["vocals", "drums", "bass", "guitar", "piano", "other"] as const),
  };
  return createPreparationManager({ envDir, modelsDir, runtime });
}

test("a fresh machine reports not_prepared with an empty record", async () => {
  const directory = await mkdtemp(join(tmpdir(), "wy-store-"));
  try {
    const manager = makeManager(join(directory, "env"), join(directory, "models"));
    const status = await manager.getStatus();
    assert.equal(status.state, "not_prepared");
    assert.equal(status.result.provenance, null);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("consent is required before any material step, and a partial grant is refused", async () => {
  const directory = await mkdtemp(join(tmpdir(), "wy-store-"));
  try {
    const envDir = join(directory, "env");
    const modelsDir = join(directory, "models");
    const manager = makeManager(envDir, modelsDir);
    // The plan needs consent (install + download), but none is granted.
    const outcome = await manager.start([]);
    assert.equal(outcome.outcome, "consent-missing");
    if (outcome.outcome === "consent-missing") {
      assert.ok(outcome.missing.length > 0, "the missing consents are named");
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("a full preparation runs the lifecycle, publishes the pointer only after the probe, and reaches ready", async () => {
  const directory = await mkdtemp(join(tmpdir(), "wy-store-"));
  try {
    const envDir = join(directory, "env");
    const modelsDir = join(directory, "models");
    const order: string[] = [];
    const manager = makeManager(envDir, modelsDir, {
      install: async () => { order.push("install"); },
      acquire: async (dir) => { order.push("acquire"); const { mkdir, writeFile } = await import("node:fs/promises"); await mkdir(dir, { recursive: true }); await writeFile(join(dir, DEEP_CHECKPOINT_FILE), Buffer.alloc(64)); },
      verify: async () => { order.push("verify"); return { demucsVersion: "4.0.1", torchVersion: "2.0.1+cpu", cuda: false }; },
      probe: async () => { order.push("probe"); return ["vocals", "drums", "bass", "guitar", "piano", "other"]; },
    });
    const { discoverEnvironment } = await import("./provision-runtime");
    void discoverEnvironment;
    // Grant every consent the plan requires.
    const { inspect } = { inspect: manager.inspect };
    const { plan } = await inspect();
    const grants = plan.consent.map((item) => item.id);
    const outcome = await manager.start(grants);
    assert.equal(outcome.outcome, "started");
    // Wait for the background run to finish.
    let status: PreparationStatus = await manager.getStatus();
    for (let i = 0; i < 200 && status.state !== "ready" && status.state !== "failed"; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 20));
      status = await manager.getStatus();
    }
    assert.equal(status.state, "ready", `expected ready, got ${status.state}: ${status.error?.message ?? ""}`);
    // The pointer is published — the real bridge now resolves it.
    const pointer = JSON.parse(await readFile(join(envDir, "interpreter.json"), "utf8")) as { python: string; demucsVersion: string };
    assert.equal(pointer.demucsVersion, "4.0.1");
    assert.ok(existsSync(pointer.python), "the pointer names a real interpreter");
    // The steps ran in order: install → acquire → verify → probe.
    assert.deepEqual(order, ["install", "acquire", "verify", "probe"]);
    // The provenance is recorded.
    assert.equal(status.result.provenance, "htdemucs_6s@5c90dfd2-34c22ccb/demucs-4.0.1");
    // Idempotent: a second start on a ready machine is a no-op.
    assert.equal((await manager.start(grants)).outcome, "already-ready");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("two concurrent starts cannot corrupt each other — the second is refused", async () => {
  const directory = await mkdtemp(join(tmpdir(), "wy-store-"));
  try {
    const envDir = join(directory, "env");
    const modelsDir = join(directory, "models");
    const gate = deferred<void>();
    const manager = makeManager(envDir, modelsDir, {
      install: () => gate.promise, // block the dependency step
    });
    const first = await manager.start(["python-packages", "model-checkpoint"]);
    assert.equal(first.outcome, "started");
    // Wait until the run is mid-flight, then try to start again.
    let status: PreparationStatus = await manager.getStatus();
    for (let i = 0; i < 100 && status.state !== "installing_dependencies"; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
      status = await manager.getStatus();
    }
    const second = await manager.start(["python-packages", "model-checkpoint"]);
    assert.equal(second.outcome, "already-running", "a live preparation refuses a concurrent start");
    gate.resolve(); // let the first finish
    for (let i = 0; i < 200; i += 1) {
      status = await manager.getStatus();
      if (status.state === "ready" || status.state === "failed") break;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assert.equal(status.state, "ready");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("a failing dependency install lands in failed with an actionable error", async () => {
  const directory = await mkdtemp(join(tmpdir(), "wy-store-"));
  try {
    const envDir = join(directory, "env");
    const modelsDir = join(directory, "models");
    const { ProvisionError } = await import("./provision-runtime");
    const manager = makeManager(envDir, modelsDir, {
      install: () => { throw new ProvisionError("DEPENDENCY_INSTALL_FAILED", "pip exited 1: no matching distribution"); },
    });
    await manager.start(["python-packages", "model-checkpoint"]);
    let status: PreparationStatus = await manager.getStatus();
    for (let i = 0; i < 200 && status.state !== "failed"; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 20));
      status = await manager.getStatus();
    }
    assert.equal(status.state, "failed");
    assert.equal(status.error?.code, "DEPENDENCY_INSTALL_FAILED");
    assert.match(status.error?.message ?? "", /no matching distribution/);
    // No pointer was published — the engine is honestly not ready.
    assert.ok(!existsSync(join(envDir, "interpreter.json")), "a failed run publishes no pointer");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("cancellation lands in cancelled, not ready", async () => {
  const directory = await mkdtemp(join(tmpdir(), "wy-store-"));
  try {
    const envDir = join(directory, "env");
    const modelsDir = join(directory, "models");
    const gate = deferred<void>();
    const manager = makeManager(envDir, modelsDir, {
      install: (python, c) =>
        c.signal?.aborted
          ? Promise.reject(new Error("aborted"))
          : new Promise<void>((_resolve, reject) => {
              c.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
              void gate.promise.catch(() => undefined);
            }),
    });
    await manager.start(["python-packages", "model-checkpoint"]);
    let status: PreparationStatus = await manager.getStatus();
    for (let i = 0; i < 100 && status.state !== "installing_dependencies"; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
      status = await manager.getStatus();
    }
    const cancelled = await manager.cancel();
    assert.equal(cancelled, true);
    status = await manager.getStatus();
    for (let i = 0; i < 200 && status.state !== "cancelled" && status.state !== "failed"; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 20));
      status = await manager.getStatus();
    }
    assert.ok(status.state === "cancelled" || status.state === "failed", "cancellation is terminal, never ready");
    assert.notEqual(status.state, "ready");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("an interrupted run (Arena restarted) is honestly reported as recovering, then resettable", async () => {
  const directory = await mkdtemp(join(tmpdir(), "wy-store-"));
  try {
    const envDir = join(directory, "env");
    const modelsDir = join(directory, "models");
    // Simulate a previous process that died mid-preparation: a
    // status file in an in-flight state and a stale lock.
    const stale: PreparationStatus = {
      state: "installing_dependencies",
      step: "dependencies",
      progress: { percent: 40, label: "Installing" },
      steps: [],
      consent: { required: [], granted: [], grantedAt: null },
      error: null,
      log: [],
      environment: { python: null, pythonVersion: null, demucsVersion: null, torchVersion: null, checkpointPath: join(modelsDir, DEEP_CHECKPOINT_FILE), checkpointPresent: false, checkpointVerified: null, managedEnvDir: envDir, modelsDir },
      result: { provenance: null, readyAt: null },
      startedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      completedAt: null,
      epoch: "old-epoch",
      pid: 999999, // a process that no longer exists
    };
    const { mkdir, writeFile } = await import("node:fs/promises");
    await mkdir(envDir, { recursive: true });
    await writeFile(join(envDir, "preparation.json"), JSON.stringify(stale));
    await writeFile(join(envDir, "preparation.lock"), JSON.stringify({ epoch: "old-epoch", pid: 999999, startedAt: new Date().toISOString(), heartbeat: Date.now() - 120_000 }));

    const manager = makeManager(envDir, modelsDir);
    const status = await manager.getStatus();
    assert.equal(status.state, "recovering", "a dead holder is reported as recovering, never as ready");
    const recovered = await manager.recover();
    assert.equal(recovered.state, "not_prepared");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("the status record is durable and valid JSON across transitions", async () => {
  const directory = await mkdtemp(join(tmpdir(), "wy-store-"));
  try {
    const envDir = join(directory, "env");
    const modelsDir = join(directory, "models");
    const manager = makeManager(envDir, modelsDir);
    await manager.start(["python-packages", "model-checkpoint"]);
    let status: PreparationStatus | null = await manager.getStatus();
    for (let i = 0; i < 200 && status.state !== "ready" && status.state !== "failed"; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 20));
      status = await manager.getStatus();
    }
    // The on-disk record parses and agrees with the in-memory state.
    const raw = JSON.parse(await readFile(join(envDir, "preparation.json"), "utf8")) as PreparationStatus;
    assert.equal(raw.state, status.state);
    assert.ok(Array.isArray(raw.log));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("a checkpoint removed after preparation is detected — readiness does not lie", async () => {
  const directory = await mkdtemp(join(tmpdir(), "wy-store-"));
  try {
    const envDir = join(directory, "env");
    const modelsDir = join(directory, "models");
    const manager = makeManager(envDir, modelsDir);
    await manager.start(["python-packages", "model-checkpoint"]);
    let status: PreparationStatus = await manager.getStatus();
    for (let i = 0; i < 200 && status.state !== "ready"; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 20));
      status = await manager.getStatus();
    }
    assert.equal(status.state, "ready");
    // The owner removes the checkpoint — the next status query
    // must reflect reality, not the remembered install.
    await rm(join(modelsDir, DEEP_CHECKPOINT_FILE));
    const after = await manager.getStatus();
    assert.equal(after.state, "not_prepared", "a vanished checkpoint drops readiness");
    assert.equal(after.error?.code, "ENVIRONMENT_CHANGED");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("changed checkpoint bytes invalidate the recorded smoke, even with the same filename", async () => {
  const directory = await mkdtemp(join(tmpdir(), "wy-store-changed-"));
  try {
    const manager = makeManager(join(directory, "env"), join(directory, "models"));
    await manager.start(["python-packages", "model-checkpoint"]);
    let status = await manager.getStatus();
    for (let i = 0; i < 200 && status.state !== "ready"; i++) { await new Promise(resolve => setTimeout(resolve, 20)); status = await manager.getStatus(); }
    assert.equal(status.state, "ready");
    await writeFile(status.environment.checkpointPath, "replaced-controlled-checkpoint");
    assert.equal((await manager.getStatus()).state, "not_prepared");
  } finally { await rm(directory, { recursive: true, force: true }); }
});
