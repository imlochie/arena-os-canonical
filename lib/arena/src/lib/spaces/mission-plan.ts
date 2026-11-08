export interface MissionAgentSelection {
  name: string;
  role: string;
  modelId: string;
  systemPrompt?: string;
}

/** The model a mission used when no Space model is recorded. */
export const LEGACY_DEFAULT_MODEL = "openai";

function defaultPlan(spaceModel: string): MissionAgentSelection[] {
  return [
    { name: "Planner", role: "plan the work into concrete file-level steps", modelId: spaceModel },
    { name: "Builder", role: "implement the files and commands", modelId: spaceModel },
    { name: "Reviewer", role: "verify the result with read/commands and finish or hand back", modelId: spaceModel },
  ];
}

/**
 * Precedence: a checkpoint's stored plan, then an explicit per-mission plan,
 * then the Space's configured fleet, then the default three roles on the model
 * selected for the Space.
 */
export function selectMissionPlan(input: {
  resumingPlan?: MissionAgentSelection[];
  explicitPlan?: MissionAgentSelection[];
  fleet: MissionAgentSelection[];
  spaceModel?: string;
}): MissionAgentSelection[] {
  if (input.resumingPlan?.length) return input.resumingPlan;
  if (input.explicitPlan?.length) return input.explicitPlan;
  if (input.fleet.length) return input.fleet;
  return defaultPlan(input.spaceModel || LEGACY_DEFAULT_MODEL);
}
