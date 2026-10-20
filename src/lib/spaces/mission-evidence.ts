/** Read-only view of saved observations, not a second mission state machine.
 * Human reconciliation and old unqualified observations must not masquerade
 * as machine-observed test passes. Results remain scoped to their commands.
 */
export interface EvidenceAction {
  tool: string;
  ok: boolean;
  requestId?: string;
  provenance?: string;
  uncertain?: boolean;
}
export interface EvidenceMission {
  journal: { actions: EvidenceAction[] }[];
  artifacts: { state?: string; artifactId?: string; revisionId?: string; checksumSha256?: string }[];
}
export function missionEvidence(mission: EvidenceMission) {
  const latest = new Map<string, EvidenceAction>();
  mission.journal.forEach((step, si) => step.actions.forEach((action, ai) => latest.set(action.requestId ?? `legacy:${si}:${ai}`, action)));
  const actions = [...latest.values()];
  const machine = (action: EvidenceAction) => !action.uncertain && ["executed", "approval-ledger"].includes(action.provenance ?? "");
  const tests = actions.filter(action => action.tool === "run_tests" && machine(action));
  return {
    toolOutcomes: actions.length,
    testCommandSuccesses: tests.filter(action => action.ok).length,
    testCommandFailures: tests.filter(action => !action.ok).length,
    commandSuccesses: actions.filter(action => action.tool === "run_command" && action.ok && machine(action)).length,
    humanReviewed: actions.filter(action => action.provenance === "human-reconciliation").length,
    uncertain: actions.filter(action => action.uncertain).length,
    immutableOutputs: mission.artifacts.filter(output => output.state === "complete" && output.artifactId && output.revisionId && /^[a-f0-9]{64}$/.test(output.checksumSha256 ?? "")).length,
    unavailableOutputs: mission.artifacts.filter(output => output.state === "unavailable").length,
  };
}
