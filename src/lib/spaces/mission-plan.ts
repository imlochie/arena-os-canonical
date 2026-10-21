export interface MissionAgentSelection {
  name: string;
  role: string;
  modelId: string;
  systemPrompt?: string;
}

function defaultPlan(spaceModel: string): MissionAgentSelection[] {
  return [
    { name: "Planner", role: "plan the work into concrete file-level steps", modelId: spaceModel },
    { name: "Builder", role: "implement the files and commands", modelId: spaceModel },
    { name: "Reviewer", role: "verify the result with read/commands and finish or hand back", modelId: spaceModel },
  ];
}

/** Existing checkpoint plans and explicit/fleet choices outrank the space default. */
export function selectMissionPlan(input: {
  resumingPlan?: MissionAgentSelection[];
  explicitPlan?: MissionAgentSelection[];
  fleet: MissionAgentSelection[];
  spaceModel?: string;
}): MissionAgentSelection[] {
  if (input.resumingPlan?.length) return input.resumingPlan;
  if (input.explicitPlan?.length) return input.explicitPlan;
  if (input.fleet.length) return input.fleet;
  return defaultPlan(input.spaceModel || "openai");
}
