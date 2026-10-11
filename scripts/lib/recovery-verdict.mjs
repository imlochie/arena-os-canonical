/**
 * Verdict for the abnormal-shutdown RECOVERY launch (windows-acceptance).
 *
 * The recovery run executes the SAME in-app acceptance (desktop/acceptance.ts)
 * against an ALREADY-INITIALIZED database, so its firstLaunch section
 * necessarily fails the first-ever-launch invariant
 * ("first run initialised the database cluster" — firstRun=false on purpose).
 * The old harness verdict (`recovery.body.ok !== true`) turned that expected
 * fact into "PROCESS CLEANUP: FAIL" even when every recovery-relevant check
 * passed — a false negative on the final report.
 *
 * Recovery succeeds when the recovery launch:
 *   - reaches supervisor ready and answers GET /api/health (runtime health),
 *   - passes every OTHER firstLaunch step (packaged tool resolution, …),
 *   - passes every other section the in-app acceptance defines
 *     (paths, workflow, failureTests, restartPersistence, processCleanup,
 *     packagingAudit, offline),
 *   - does NOT re-initialise the database cluster (firstRun=true on a
 *     recovery launch would mean the abnormal shutdown destroyed the data
 *     dir — data loss, not recovery).
 *
 * The normal-launch verdict is untouched: it still requires the FULL
 * firstLaunch section with firstRun=true (the distinction between a clean
 * first launch and a recovery launch stays explicit).
 */

/**
 * firstLaunch step that is a FIRST-EVER-LAUNCH invariant only. On a recovery
 * launch the cluster already exists, so firstRun=false is correct there and
 * this step is exempt from the recovery verdict (exempted — never required).
 */
export const FIRST_RUN_INVARIANT_STEP = "first run initialised the database cluster";

/** firstLaunch steps a recovery launch MUST still pass (mandate: supervisor
 * ready + runtime health). Missing counts as failing. */
export const REQUIRED_FIRST_LAUNCH_STEPS = [
  "supervisor reaches ready",
  "GET /api/health ok",
];

/** Every section the in-app acceptance emits; a recovery launch must pass
 * ALL of them (firstLaunch via its steps, see above). Kept in sync with
 * `section("…")` occurrences in desktop/acceptance.ts by
 * desktop/recovery-verdict.test.ts. */
export const REQUIRED_RECOVERY_SECTIONS = [
  "firstLaunch",
  "paths",
  "workflow",
  "failureTests",
  "restartPersistence",
  "processCleanup",
  "packagingAudit",
  "offline",
];

/**
 * Evaluate a recovery-launch acceptance report.
 *
 * @param {import("./recovery-verdict.d.mts").RecoveryReport | null | undefined} body
 * @returns {{ ok: boolean, failures: string[], exempted: string[] }}
 *   ok — the recovery launch satisfied every recovery requirement;
 *   failures — human-readable list of what did not recover (empty when ok);
 *   exempted — what was deliberately NOT required and why (report honesty).
 */
/**
 * Step names whose FAILURE is the expected, correct outcome for this
 * recovery launch — used by the harness to print them as [EXPECTED] instead
 * of a misleading [FAIL]. The first-ever-launch invariant is the only one:
 * on a recovery launch the cluster already exists, so firstRun=false is
 * right. If the invariant PASSED (re-initialisation = data loss) nothing is
 * exempt — that is a real recovery failure and must print [FAIL].
 */
export function recoveryPrintExemptions(body) {
  const steps = body?.sections?.firstLaunch?.steps;
  if (!Array.isArray(steps)) return [];
  const invariant = steps.find((entry) => entry?.name === FIRST_RUN_INVARIANT_STEP);
  return invariant !== undefined && invariant.ok !== true ? [FIRST_RUN_INVARIANT_STEP] : [];
}

/**
 * Console lines for an in-app acceptance report. Steps whose failure is
 * EXPECTED on this kind of launch (see recoveryPrintExemptions) print as
 * [EXPECTED] with the reason; everything else prints its raw PASS/FAIL.
 * The report BODY is never altered — ok=false stays ok=false in the JSON
 * (honesty: only the presentation is labeled, the recorded fact is not).
 */
export function formatAcceptanceStepLines(body, exemptedSteps = []) {
  const exemptions = new Set(Array.isArray(exemptedSteps) ? exemptedSteps : []);
  const lines = [];
  for (const [name, section] of Object.entries(body?.sections ?? {})) {
    for (const step of section?.steps ?? []) {
      const info = step?.info !== undefined ? ` — ${step.info}` : "";
      if (step?.ok !== true && exemptions.has(step?.name)) {
        lines.push(`[EXPECTED] ${name} · ${step.name}${info} (expected on the recovery launch — the cluster already exists; exempted from the recovery verdict)`);
      } else {
        lines.push(`[${step?.ok ? "PASS" : "FAIL"}] ${name} · ${step?.name ?? "unnamed step"}${info}`);
      }
    }
  }
  if (body?.error !== undefined) lines.push(`[FAIL] runner error: ${String(body.error).slice(0, 400)}`);
  return lines;
}

export function evaluateRecovery(body) {
  const failures = [];
  const exempted = [];

  if (body === null || body === undefined || typeof body !== "object") {
    return {
      ok: false,
      failures: ["no acceptance report — the recovery launch crashed before writing one"],
      exempted,
    };
  }
  if (body.error !== undefined && body.error !== null) {
    failures.push(`report error: ${String(body.error)}`);
  }

  const sections = body.sections ?? {};
  for (const name of REQUIRED_RECOVERY_SECTIONS) {
    const section = sections[name];
    if (section === undefined) {
      failures.push(`section missing: ${name}`);
      continue;
    }
    if (name !== "firstLaunch") {
      if (section.ok !== true) failures.push(name);
      continue;
    }
    // firstLaunch is evaluated step-by-step: everything must pass EXCEPT the
    // first-ever-launch invariant, and the mandated steps must be present.
    const steps = Array.isArray(section.steps) ? section.steps : [];
    for (const required of REQUIRED_FIRST_LAUNCH_STEPS) {
      const step = steps.find((entry) => entry?.name === required);
      if (step === undefined) failures.push(`firstLaunch step missing: ${required}`);
      else if (step.ok !== true) failures.push(`firstLaunch/${required}`);
    }
    for (const step of steps) {
      if (step?.name === FIRST_RUN_INVARIANT_STEP) continue;
      if (step.ok !== true) failures.push(`firstLaunch/${String(step?.name)}`);
    }
    const invariant = steps.find((entry) => entry?.name === FIRST_RUN_INVARIANT_STEP);
    if (invariant === undefined) {
      exempted.push(`"${FIRST_RUN_INVARIANT_STEP}" not reported (step absent this launch)`);
    } else if (invariant.ok === true) {
      failures.push(
        `recovery re-initialised the database cluster (${FIRST_RUN_INVARIANT_STEP} passed) — the abnormal shutdown must not destroy the data dir`,
      );
    } else {
      exempted.push(
        `"${FIRST_RUN_INVARIANT_STEP}" (ok=false, firstRun=false) — first-ever-launch invariant only; the cluster already exists on a recovery launch`,
      );
    }
  }

  return { ok: failures.length === 0, failures, exempted };
}
