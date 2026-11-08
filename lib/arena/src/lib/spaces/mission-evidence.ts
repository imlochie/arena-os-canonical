/** Read-only view of journaled tool outcomes, not a second mission state machine.
 * Ported from PR #20. A zero exit from run_tests/run_command is a command
 * outcome, not proof the product is correct; a model saying "done" and human
 * reconciliation never count as machine-observed success. Outcomes that carry
 * no provenance (everything journaled before provenance existed, and every
 * outcome the current runner records) are counted as outcomes only. */
export interface EvidenceAction {
  tool: string;
  ok: boolean;
  requestId?: string;
  provenance?: string;
  uncertain?: boolean;
}
export interface EvidenceMission {
  journal: { actions: EvidenceAction[] }[];
  artifacts?: { state?: string; artifactId?: string; revisionId?: string; checksumSha256?: string }[];
}

const MACHINE_PROVENANCE = ["executed", "approval-ledger"];

export function missionEvidence(mission: EvidenceMission) {
  // A repeated requestId is the same request; the latest record wins.
  const latest = new Map<string, EvidenceAction>();
  mission.journal.forEach((step, si) =>
    step.actions.forEach((action, ai) => latest.set(action.requestId ?? `legacy:${si}:${ai}`, action)));
  const actions = [...latest.values()];
  const machine = (action: EvidenceAction) => !action.uncertain && MACHINE_PROVENANCE.includes(action.provenance ?? "");
  const tests = actions.filter(action => action.tool === "run_tests" && machine(action));
  const artifacts = mission.artifacts ?? [];
  return {
    toolOutcomes: actions.length,
    testCommandSuccesses: tests.filter(action => action.ok).length,
    testCommandFailures: tests.filter(action => !action.ok).length,
    commandSuccesses: actions.filter(action => action.tool === "run_command" && action.ok && machine(action)).length,
    humanReviewed: actions.filter(action => action.provenance === "human-reconciliation").length,
    uncertain: actions.filter(action => action.uncertain).length,
    immutableOutputs: artifacts.filter(output => output.state === "complete" && output.artifactId && output.revisionId && /^[a-f0-9]{64}$/.test(output.checksumSha256 ?? "")).length,
    unavailableOutputs: artifacts.filter(output => output.state === "unavailable").length,
  };
}
