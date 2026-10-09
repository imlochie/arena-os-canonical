/**
 * Regression test: the abnormal-shutdown RECOVERY verdict.
 *
 * The 3006139 Windows acceptance run failed ONLY on "PROCESS CLEANUP" after
 * the recovery launch. The harness judged recovery with
 * `recovery.body.ok !== true` — but the recovery run executes the same
 * in-app acceptance against an ALREADY-INITIALIZED database, so its
 * firstLaunch section necessarily fails the first-ever-launch invariant
 * ("first run initialised the database cluster", firstRun=false on purpose)
 * and body.ok is false even when every recovery-relevant check passes.
 *
 * The verdict lives in scripts/lib/recovery-verdict.mjs (evaluateRecovery):
 * recovery requires supervisor ready + health + every other firstLaunch step
 * + every other section, exempts ONLY the first-run invariant, and fails if
 * the recovery launch re-initialises the cluster (data loss). The normal
 * launch verdict is untouched — it still requires firstRun=true.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";

import {
  FIRST_RUN_INVARIANT_STEP,
  REQUIRED_FIRST_LAUNCH_STEPS,
  REQUIRED_RECOVERY_SECTIONS,
  evaluateRecovery,
  formatAcceptanceStepLines,
  recoveryPrintExemptions,
} from "../scripts/lib/recovery-verdict.mjs";

const repoRoot = path.resolve(path.dirname(process.argv[1] ?? "."), "..");

/** A faithful recovery-launch report: every section passes EXCEPT the
 * first-ever-launch invariant inside firstLaunch (firstRun=false — the
 * database was already initialised during the normal run). This mirrors the
 * real recovery.json of the failing acceptance run. */
function recoveryBody(): {
  ok: boolean;
  sections: Record<string, { ok: boolean; steps: Array<{ name: string; ok: boolean; info?: string }> }>;
} {
  const section = (ok: boolean, steps: Array<[string, boolean]>): { ok: boolean; steps: Array<{ name: string; ok: boolean }> } => ({
    ok: ok && steps.every(([, stepOk]) => stepOk),
    steps: steps.map(([name, stepOk]) => ({ name, ok: stepOk })),
  });
  const body = {
    ok: false, // computed like acceptance.ts:597 — every section must pass
    sections: {
      firstLaunch: section(false, [
        ["packaged ffmpeg resolved under app root", true],
        ["packaged ffprobe resolved under app root", true],
        ["packaged embedded postgres resolved under app root", true],
        ["window created", true],
        ["app is the packaged build", true],
        ["supervisor reaches ready", true],
        [FIRST_RUN_INVARIANT_STEP, false], // firstRun=false — EXPECTED on recovery
        ["GET /api/health ok", true],
      ]),
      paths: section(true, [["dir \"projects\" lives under the data root", true]]),
      workflow: section(true, [["create project", true]]),
      failureTests: section(true, [["missing asset 404s", true]]),
      restartPersistence: section(true, [
        ["restart does NOT re-initdb", true],
        ["project persisted across restart", true],
      ]),
      processCleanup: section(true, [
        ["supervisor reports stopped", true],
        ["postgres reached stopped state", true],
        ["shell child-process registry empty", true],
        ["all workflow URLs were loopback-only", true],
      ]),
      packagingAudit: section(true, [["no symlink in the app tree escapes the install", true]]),
      offline: section(true, [["every request in this run targeted 127.0.0.1", true]]),
    },
  };
  body.ok = Object.values(body.sections).every((entry) => entry.ok);
  return body;
}

test("recovery with firstRun=false passes the recovery verdict (no PROCESS CLEANUP fail)", () => {
  const body = recoveryBody();
  // Preconditions — this is exactly the false-negative scenario:
  assert.equal(body.sections.firstLaunch.ok, false, "firstLaunch fails on the invariant step");
  assert.equal(body.ok, false, "body.ok is false (the old harness check would have failed)");
  assert.equal(body.sections.processCleanup.ok, true);
  assert.equal(body.sections.restartPersistence.ok, true);
  assert.equal(
    body.sections.firstLaunch.steps.find((step) => step.name === "supervisor reaches ready")?.ok,
    true,
  );

  const verdict = evaluateRecovery(body);
  assert.deepEqual(verdict.failures, [], "recovery must not be judged by the first-run invariant");
  assert.equal(verdict.ok, true, "a fully-recovered app must NOT mark PROCESS CLEANUP as FAIL");
  assert.ok(verdict.exempted.length > 0, "the exemption is recorded honestly for the report");
  assert.match(verdict.exempted.join(" "), /first-ever-launch invariant/);
});

test("a failing processCleanup section still fails recovery", () => {
  const body = recoveryBody();
  body.sections.processCleanup = { ok: false, steps: [{ name: "supervisor reports stopped", ok: false }] };
  const verdict = evaluateRecovery(body);
  assert.equal(verdict.ok, false);
  assert.ok(verdict.failures.includes("processCleanup"));
});

test("supervisor not reaching ready fails recovery", () => {
  const body = recoveryBody();
  const step = body.sections.firstLaunch.steps.find((entry) => entry.name === "supervisor reaches ready");
  assert.ok(step !== undefined);
  step.ok = false;
  const verdict = evaluateRecovery(body);
  assert.equal(verdict.ok, false);
  assert.ok(verdict.failures.includes("firstLaunch/supervisor reaches ready"));
});

test("a missing section (crash before it ran) fails recovery", () => {
  const body = recoveryBody();
  delete body.sections.restartPersistence;
  const verdict = evaluateRecovery(body);
  assert.equal(verdict.ok, false);
  assert.ok(verdict.failures.includes("section missing: restartPersistence"));
});

test("a crashed recovery run (no report / report error) fails recovery", () => {
  assert.equal(evaluateRecovery(undefined).ok, false);
  assert.equal(evaluateRecovery(null).ok, false);
  const crashed = evaluateRecovery({ error: "TypeError: boom", sections: {} });
  assert.equal(crashed.ok, false);
  assert.ok(crashed.failures.some((failure) => failure.startsWith("report error:")));
});

test("recovery re-initialising the database cluster fails (data loss, not recovery)", () => {
  const body = recoveryBody();
  const invariant = body.sections.firstLaunch.steps.find((step) => step.name === FIRST_RUN_INVARIANT_STEP);
  assert.ok(invariant !== undefined);
  invariant.ok = true; // firstRun=true on a RECOVERY launch = the data dir was destroyed
  body.sections.firstLaunch.ok = true;
  body.ok = true;
  const verdict = evaluateRecovery(body);
  assert.equal(verdict.ok, false);
  assert.ok(
    verdict.failures.some((failure) => failure.includes("re-initialised the database cluster")),
    `failures: ${verdict.failures.join("; ")}`,
  );
});

test("any other failing firstLaunch step (e.g. health) fails recovery", () => {
  const body = recoveryBody();
  const step = body.sections.firstLaunch.steps.find((entry) => entry.name === "GET /api/health ok");
  assert.ok(step !== undefined);
  step.ok = false;
  const verdict = evaluateRecovery(body);
  assert.equal(verdict.ok, false);
  assert.ok(verdict.failures.includes("firstLaunch/GET /api/health ok"));
});

test("verdict tables stay in sync with desktop/acceptance.ts (drift guard)", () => {
  const source = readFileSync(path.join(repoRoot, "desktop", "acceptance.ts"), "utf8");
  const sectionNames = [...source.matchAll(/section\("([^"]+)"\)/g)].map((match) => match[1]);
  assert.deepEqual(
    [...REQUIRED_RECOVERY_SECTIONS].sort(),
    [...new Set(sectionNames)].sort(),
    "REQUIRED_RECOVERY_SECTIONS must list exactly the sections the in-app acceptance emits",
  );
  for (const stepName of [...REQUIRED_FIRST_LAUNCH_STEPS, FIRST_RUN_INVARIANT_STEP]) {
    assert.ok(source.includes(`"${stepName}"`), `acceptance.ts must still contain the step "${stepName}"`);
  }
});

test("windows-acceptance judges recovery via evaluateRecovery, not body.ok (wiring guard)", () => {
  const source = readFileSync(path.join(repoRoot, "scripts", "windows-acceptance.mjs"), "utf8");
  assert.ok(
    source.includes('from "./lib/recovery-verdict.mjs"'),
    "the harness must import the recovery verdict helper",
  );
  assert.ok(
    source.includes("evaluateRecovery(recovery.body)"),
    "the recovery verdict must come from evaluateRecovery",
  );
  assert.ok(
    !source.includes("recovery.body?.ok !== true"),
    "the harness must not require body.ok on the recovery launch (the false negative)",
  );
  // The normal launch still requires the FULL firstLaunch section
  // (firstRun=true included) — the distinction stays explicit.
  assert.ok(
    source.includes('mark("FIRST_LAUNCH", sectionOk("firstLaunch")'),
    "the normal-launch verdict must keep requiring the full firstLaunch section (via the canonical report key)",
  );
});

test("presentation: the recovery dump labels the one expected failure [EXPECTED], not a misleading [FAIL]", () => {
  const body = recoveryBody();
  const exemptions = recoveryPrintExemptions(body);
  assert.deepEqual(exemptions, [FIRST_RUN_INVARIANT_STEP]);

  const lines = formatAcceptanceStepLines(body, exemptions);
  const invariantLine = lines.find((line) => line.includes(FIRST_RUN_INVARIANT_STEP));
  assert.ok(invariantLine !== undefined, "the invariant step is printed");
  assert.ok(invariantLine.startsWith("[EXPECTED]"), `the expected failure prints as [EXPECTED], got: ${invariantLine}`);
  assert.match(invariantLine, /expected on the recovery launch/);
  assert.ok(!lines.some((line) => line.startsWith("[FAIL]")), "a fully-recovered launch prints NO [FAIL] lines at all");
  assert.ok(lines.some((line) => line.startsWith("[PASS]")), "passing steps still print [PASS]");
});

test("presentation: real recovery failures still print [FAIL]; re-initialisation is never exempted", () => {
  // A failing health step is NOT exempt — it must print [FAIL].
  const body = recoveryBody();
  body.sections.firstLaunch.steps = body.sections.firstLaunch.steps.map((step) =>
    step.name === "GET /api/health ok" ? { ...step, ok: false } : step,
  );
  const lines = formatAcceptanceStepLines(body, recoveryPrintExemptions(body));
  assert.ok(lines.some((line) => line.startsWith("[FAIL] firstLaunch · GET /api/health ok")), "real failures print [FAIL]");

  // The invariant PASSING (re-initialisation = data loss) is exempted from NOTHING.
  const reinitialised = recoveryBody();
  reinitialised.sections.firstLaunch.steps = reinitialised.sections.firstLaunch.steps.map((step) =>
    step.name === FIRST_RUN_INVARIANT_STEP ? { ...step, ok: true } : step,
  );
  assert.deepEqual(recoveryPrintExemptions(reinitialised), []);
  const reinitLines = formatAcceptanceStepLines(reinitialised, recoveryPrintExemptions(reinitialised));
  assert.ok(
    reinitLines.some((line) => line.startsWith("[PASS]") && line.includes(FIRST_RUN_INVARIANT_STEP)),
    "a re-initialised recovery prints the invariant as a plain [PASS] — evaluateRecovery is what fails it (data loss)",
  );

  // Absent invariant / degenerate bodies: exempt nothing, print without throwing.
  const noInvariant = recoveryBody();
  noInvariant.sections.firstLaunch.steps = noInvariant.sections.firstLaunch.steps.filter(
    (step) => step.name !== FIRST_RUN_INVARIANT_STEP,
  );
  assert.deepEqual(recoveryPrintExemptions(noInvariant), []);
  assert.deepEqual(recoveryPrintExemptions(null), []);
  assert.deepEqual(recoveryPrintExemptions(undefined), []);
  assert.deepEqual(formatAcceptanceStepLines(null), []);
  assert.deepEqual(
    formatAcceptanceStepLines({ ok: false, error: "installed app exited without writing the acceptance report" } as never),
    ["[FAIL] runner error: installed app exited without writing the acceptance report"],
  );
});

test("presentation: the report body is never rewritten — only the console lines are labeled", () => {
  const body = recoveryBody();
  const before = JSON.stringify(body);
  formatAcceptanceStepLines(body, recoveryPrintExemptions(body));
  assert.equal(JSON.stringify(body), before, "formatting must not mutate the recorded report");
  const invariant = body.sections.firstLaunch!.steps.find((step) => step.name === FIRST_RUN_INVARIANT_STEP)!;
  assert.equal(invariant.ok, false, "the recorded fact stays ok=false (honesty: firstRun WAS false)");
});

test("windows-acceptance presents the recovery run self-explanatorily (wiring guard)", () => {
  const source = readFileSync(path.join(repoRoot, "scripts", "windows-acceptance.mjs"), "utf8");
  // Both dumps are labeled with WHICH launch they belong to (initial vs recovery).
  assert.ok(source.includes("normal launch — in-app acceptance detail"), "the normal-run dump must be labeled");
  assert.ok(source.includes("recovery launch — in-app acceptance detail"), "the recovery dump must be labeled");
  // The recovery dump explains the expected firstRun=false BEFORE the steps print.
  assert.ok(source.includes("recovery note: this launch runs against the ALREADY-INITIALISED database"), "the recovery note must precede the dump");
  // The recovery dump passes the exemption list (the [EXPECTED] labeling).
  assert.ok(source.includes("printAcceptance(recovery.body, { exemptedSteps: recoveryPrintExemptions(recovery.body) })"), "the recovery dump must use the exemptions");
  // The verdict prints immediately after the dump — the reader sees the judgment, not just raw steps.
  assert.ok(source.includes("recovery verdict: "), "the recovery verdict line must print");
  // The final table explains sections that never executed instead of mixing NOT RUN with PASS unexplained.
  assert.ok(source.includes("NOT RUN: "), "the final report must explain NOT RUN sections");
  assert.ok(source.includes("they never executed"), "the NOT RUN explanation must be explicit");
  // The NORMAL launch still prints raw (no exemptions there — firstRun must be true on a true first launch).
  const normalPrint = 'console.log("[windows-acceptance] normal launch — in-app acceptance detail:");\n  printAcceptance(run1.body);';
  assert.ok(source.includes(normalPrint), "the normal-launch dump must stay unexempted");
});
