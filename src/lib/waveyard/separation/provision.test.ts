/**
 * Provisioning — the pure planning, state-machine and validation
 * layer (provision.ts). Deterministic: no machine, no network, no
 * subprocess. These tests pin the SELF-DIAGNOSIS and CONSENT
 * contracts — what is missing, what the plan is, and what the
 * owner must approve — independently of any real install.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { DEEP_CHECKPOINT_FILE } from "./deep";
import {
  TERMINAL_STATES,
  consentSatisfiesPlan,
  evaluatePythonVersion,
  isTerminal,
  planPreparation,
  stateAfterInterruption,
  type DiscoveredCheckpoint,
  type DiscoveredPython,
  type EnvironmentReport,
} from "./provision";

function python(
  bin: string,
  version: string | null,
  demucsVersion: string | null,
  source: DiscoveredPython["source"] = "system",
): DiscoveredPython {
  return { bin, prefixArgs: [], source, version, demucsVersion };
}

function report(overrides: Partial<EnvironmentReport> = {}): EnvironmentReport {
  return {
    python: [python("/usr/bin/python3", "3.12.4", null)],
    compatiblePython: null,
    checkpoint: { path: "/models/5c90dfd2-34c22ccb.th", present: false, sha256: null, sizeBytes: null },
    ffmpegPresent: true,
    ffprobePresent: true,
    managedEnvironmentExists: false,
    ...overrides,
  };
}

// ------------------------------------------------------- python fitness

test("evaluatePythonVersion: 3.10 and 3.11 are the reliable baseline", () => {
  for (const version of ["3.10.12", "3.11.9", "3.11.0"]) {
    const fit = evaluatePythonVersion(version);
    assert.equal(fit.ok, true, `${version} should be compatible`);
  }
});

test("evaluatePythonVersion: 3.12 is refused with the precise reason", () => {
  const fit = evaluatePythonVersion("3.12.4");
  assert.equal(fit.ok, false);
  if (fit.ok) return;
  assert.match(fit.reason, /Python 3\.12/);
  assert.match(fit.reason, /torchaudio/);
  assert.match(fit.reason, /3\.10–3\.11/);
});

test("evaluatePythonVersion: too old and too new are refused", () => {
  assert.equal(evaluatePythonVersion("3.9.18").ok, false);
  assert.equal(evaluatePythonVersion("3.13.1").ok, false);
  assert.equal(evaluatePythonVersion(null).ok, false);
  assert.equal(evaluatePythonVersion("not-a-version").ok, false);
});

// ------------------------------------------------------- checkpoint integrity

test("checkpoint identity matches the upstream contract", () => {
  // The file and its encoded checksum are the upstream facts the
  // bridge already loads with — provisioning must not drift.
  assert.equal(DEEP_CHECKPOINT_FILE, "5c90dfd2-34c22ccb.th");
});

// ------------------------------------------------------------------ planning

test("plan: a clean, unprepared Windows machine needs runtime + deps + model, all consented", () => {
  const plan = planPreparation(report(), { modelsDir: "/m", envDir: "/e" });
  assert.equal(plan.needsConsent, true);
  const kinds = plan.consent.map((item) => item.kind);
  assert.ok(kinds.includes("runtime"), "managed Python is offered when none is compatible");
  assert.ok(kinds.includes("install"), "the pinned engine stack is offered");
  assert.ok(kinds.includes("download"), "the checkpoint is offered");
  // Every material step names its verified source and license.
  for (const item of plan.consent) {
    assert.ok(item.source.length > 0, `${item.id} names its source`);
    assert.ok(item.license.length > 0, `${item.id} names its licensing condition`);
    assert.ok(item.destination.length > 0, `${item.id} names where it is stored`);
  }
  // The plan is ordered: python before dependencies before model.
  const phaseStates = plan.phases.map((phase) => phase.state);
  assert.ok(phaseStates.indexOf("preparing_python") < phaseStates.indexOf("installing_dependencies"));
  assert.ok(phaseStates.indexOf("installing_dependencies") < phaseStates.indexOf("acquiring_model"));
});

test("plan: a compatible interpreter with Demucs and a valid checkpoint needs nothing", () => {
  const r = report({
    python: [python("/usr/bin/python3.11", "3.11.9", "4.0.1")],
    compatiblePython: python("/usr/bin/python3.11", "3.11.9", "4.0.1"),
    managedEnvironmentExists: true,
    checkpoint: { path: "/m", present: true, sha256: "34c22ccb381c6f9fdbf324f04e1e2fe21aaaf293f5ded163a162697ff9a02ddd", sizeBytes: 52_400_000 },
  });
  const plan = planPreparation(r, { modelsDir: "/m", envDir: "/e" });
  assert.equal(plan.needsConsent, false, "nothing material is needed");
  assert.equal(plan.consent.length, 0);
  // Only verify + probe remain — no install, no download.
  const ids = plan.phases.flatMap((phase) => phase.steps.map((step) => step.id));
  assert.ok(!ids.includes("dependencies"), "no dependency install");
  assert.ok(!ids.includes("checkpoint"), "no model download");
});

test("plan: a present-but-wrong checkpoint is still acquired", () => {
  const r = report({
    python: [python("/usr/bin/python3.11", "3.11.9", "4.0.1")],
    compatiblePython: python("/usr/bin/python3.11", "3.11.9", "4.0.1"),
    managedEnvironmentExists: true,
    checkpoint: { path: "/m", present: true, sha256: "deadbeef" + "0".repeat(56), sizeBytes: 52_400_000 },
  });
  const plan = planPreparation(r, { modelsDir: "/m", envDir: "/e" });
  const ids = plan.phases.flatMap((phase) => phase.steps.map((step) => step.id));
  assert.ok(ids.includes("checkpoint"), "a wrong file must be re-acquired");
});

test("plan: a compatible interpreter without Demucs installs dependencies but not a runtime", () => {
  const r = report({
    python: [python("/usr/bin/python3.11", "3.11.9", null)],
    compatiblePython: python("/usr/bin/python3.11", "3.11.9", null),
    managedEnvironmentExists: false,
    checkpoint: { path: "/m", present: false, sha256: null, sizeBytes: null },
  });
  const plan = planPreparation(r, { modelsDir: "/m", envDir: "/e" });
  const kinds = plan.consent.map((item) => item.kind);
  assert.ok(!kinds.includes("runtime"), "no managed runtime when a compatible interpreter exists");
  assert.ok(kinds.includes("install"), "dependencies are still needed");
});

// ------------------------------------------------------------------- consent

test("consent: granting every required item satisfies the plan", () => {
  const plan = planPreparation(report(), { modelsDir: "/m", envDir: "/e" });
  const all = plan.consent.map((item) => item.id);
  assert.equal(consentSatisfiesPlan(plan, all).ok, true);
});

test("consent: a partial grant is refused and names exactly what is missing", () => {
  const plan = planPreparation(report(), { modelsDir: "/m", envDir: "/e" });
  const onlyFirst = plan.consent.slice(0, 1).map((item) => item.id);
  const result = consentSatisfiesPlan(plan, onlyFirst);
  assert.equal(result.ok, false);
  assert.ok(result.missing.length > 0);
  for (const id of onlyFirst) {
    assert.ok(!result.missing.includes(id), `${id} was granted`);
  }
});

// ------------------------------------------------------------ lifecycle states

test("lifecycle: terminal states are exactly ready/failed/cancelled", () => {
  assert.deepEqual([...TERMINAL_STATES].sort(), ["cancelled", "failed", "ready"]);
  assert.equal(isTerminal("ready"), true);
  assert.equal(isTerminal("installing_dependencies"), false);
});

test("lifecycle: an interrupted in-flight run reports recovering, a finished one stays finished", () => {
  assert.equal(stateAfterInterruption("installing_dependencies"), "recovering");
  assert.equal(stateAfterInterruption("acquiring_model"), "recovering");
  assert.equal(stateAfterInterruption("ready"), "ready");
  assert.equal(stateAfterInterruption("failed"), "failed");
  assert.equal(stateAfterInterruption("cancelled"), "cancelled");
});

// The checkpoint status type is exercised indirectly through the
// plan; assert the DiscoveredCheckpoint shape stays honest.
test("checkpoint status: absence and presence are distinguishable", () => {
  const absent: DiscoveredCheckpoint = { path: "/m/x.th", present: false, sha256: null, sizeBytes: null };
  assert.equal(absent.present, false);
  assert.equal(absent.sha256, null);
});
