// Client-safe: Model ↔ Role ↔ Job abstraction.
// Models are interchangeable workers. Roles describe capabilities.
// Jobs describe cognitive work. The OS picks roles for jobs, then
// the best available model for each role (Elo-informed, server-side).

export interface WorkforceRole {
  id: string;
  name: string;
  emoji: string;
  description: string;
  // Fragment appended to system prompts when this role is assigned.
  promptFragment: string;
  // Preferred model ids in order (first available wins; server may
  // override with live Elo leaders per category).
  preferredModels: string[];
  // Cognitive job ids this role serves well.
  jobs: string[];
  // Leaderboard category used for Elo-based recommendation.
  eloCategory: string;
}

export const WORKFORCE_ROLES: WorkforceRole[] = [
  {
    id: "researcher",
    name: "Researcher",
    emoji: "🔬",
    description: "Deep dives: how things work, comparisons, edge cases, implementation paths.",
    promptFragment:
      "Act as a senior Researcher: be specific (names, numbers, steps), compare alternatives, name limits and edge cases.",
    preferredModels: ["deepseek", "openai", "gemini", "kimi"],
    jobs: ["deep_research", "second_brain", "thinking_instrument"],
    eloCategory: "reasoning",
  },
  {
    id: "critic",
    name: "Critic",
    emoji: "🔥",
    description: "Pressure-tests ideas: assumptions, counter-evidence, failure modes.",
    promptFragment:
      "Act as a sharp but fair Critic: attack weak reasoning, surface hidden assumptions and counter-examples, concede strong points honestly.",
    preferredModels: ["claude", "deepseek", "openai"],
    jobs: ["thinking_instrument", "thought_editor", "simulation_partner"],
    eloCategory: "reasoning",
  },
  {
    id: "architect",
    name: "Architect",
    emoji: "🏗️",
    description: "Designs systems: workflows, taxonomies, templates, reusable machines.",
    promptFragment:
      "Act as a Systems Architect: output copy-paste usable workflows, templates, naming conventions, checklists. One-off advice is failure.",
    preferredModels: ["openai", "deepseek", "qwen"],
    jobs: ["systems_designer", "second_brain"],
    eloCategory: "coding",
  },
  {
    id: "engineer",
    name: "Engineer",
    emoji: "⚙️",
    description: "Builds and debugs: code, specs, implementation plans,root-cause fixes.",
    promptFragment:
      "Act as a senior Engineer: minimal correct code, complexity notes, edge cases, test steps. Direct, no fluff.",
    preferredModels: ["deepseek", "qwen", "openai"],
    jobs: ["systems_designer", "deep_research"],
    eloCategory: "coding",
  },
  {
    id: "creative_director",
    name: "Creative Director",
    emoji: "🎨",
    description: "Concepts, naming, lore, formats, taste. Makes things interesting.",
    promptFragment:
      "Act as a Creative Director with taste: vivid, specific, opinionated directions. Avoid clichés. Commit to a point of view.",
    preferredModels: ["claude", "openai", "grok"],
    jobs: ["creative_workshop", "simulation_partner"],
    eloCategory: "writing",
  },
  {
    id: "strategist",
    name: "Strategist",
    emoji: "🧭",
    description: "Decisions under uncertainty: options, trade-offs, recommendations, experiments.",
    promptFragment:
      "Act as a Strategist: lay out options with trade-offs, give a clear recommendation with reasoning, propose the cheapest decisive experiment.",
    preferredModels: ["openai", "claude", "gemini"],
    jobs: ["simulation_partner", "thinking_instrument", "creative_workshop"],
    eloCategory: "general",
  },
  {
    id: "editor",
    name: "Editor",
    emoji: "📡",
    description: "Finds signal in noise: interprets raw material, reframes sharply.",
    promptFragment:
      "Act as an Editor of thinking: extract the signal, offer competing readings briefly, propose a sharper reframing and the next question.",
    preferredModels: ["claude", "openai", "mistral"],
    jobs: ["thought_editor", "second_brain"],
    eloCategory: "writing",
  },
  {
    id: "operator",
    name: "Operator",
    emoji: "📋",
    description: "Turns decisions into checklists, plans, and next actions that get done.",
    promptFragment:
      "Act as an Operator: convert conclusions into numbered next actions with owners, effort estimates, and done-definitions.",
    preferredModels: ["mistral", "openai", "llama"],
    jobs: ["systems_designer", "second_brain", "creative_workshop"],
    eloCategory: "general",
  },
];

export function getRole(id: string): WorkforceRole {
  return WORKFORCE_ROLES.find((r) => r.id === id) ?? WORKFORCE_ROLES[0];
}

// Which roles a cognitive job wants (2 debate roles + synthesizer role).
export const JOB_ROLE_MAP: Record<string, { a: string; b: string; synth: string }> = {
  creative_workshop: { a: "creative_director", b: "strategist", synth: "creative_director" },
  second_brain: { a: "architect", b: "editor", synth: "operator" },
  thinking_instrument: { a: "strategist", b: "critic", synth: "strategist" },
  deep_research: { a: "researcher", b: "critic", synth: "researcher" },
  systems_designer: { a: "architect", b: "engineer", synth: "architect" },
  simulation_partner: { a: "strategist", b: "critic", synth: "strategist" },
  thought_editor: { a: "editor", b: "critic", synth: "editor" },
};

// Collab strategy → roles (for 2-4 collaborators + synthesizer).
export const STRATEGY_ROLE_MAP: Record<string, { roles: string[]; synth: string }> = {
  council: { roles: ["strategist", "creative_director", "critic", "operator"], synth: "strategist" },
  debate: { roles: ["architect", "critic", "researcher", "operator"], synth: "strategist" },
  brainstorm: { roles: ["creative_director", "strategist", "editor", "operator"], synth: "creative_director" },
  "second-brain": { roles: ["architect", "operator", "critic", "editor"], synth: "operator" },
  systems: { roles: ["architect", "engineer", "operator", "critic"], synth: "architect" },
  scenarios: { roles: ["strategist", "strategist", "critic", "operator"], synth: "strategist" },
  signal: { roles: ["editor", "critic", "strategist", "researcher"], synth: "editor" },
};

export function rolesForJob(jobId: string): { a: WorkforceRole; b: WorkforceRole; synth: WorkforceRole } {
  const m = JOB_ROLE_MAP[jobId] ?? JOB_ROLE_MAP.second_brain;
  return { a: getRole(m.a), b: getRole(m.b), synth: getRole(m.synth) };
}
