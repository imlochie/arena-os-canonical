// Congress roles — shared by the server orchestrator (src/lib/congress.ts)
// and the client chamber UI. No server imports here.

export interface CongressRole {
  id: string;
  label: string;
  emoji: string;
  instruction: string;
}

export const CONGRESS_ROLES: CongressRole[] = [
  {
    id: "chair",
    label: "Chair",
    emoji: "🏛️",
    instruction:
      "You chair the congress. Open the sitting, keep debate on-topic, and actively drive the chamber toward concrete, durable decisions. Periodically summarize what has been settled and what remains. Be crisp and procedural.",
  },
  {
    id: "proposer",
    label: "Proposer",
    emoji: "📜",
    instruction:
      "You advance the debate with concrete proposals and motions. Turn vague agreement into specific, actionable language others can vote on. One clear proposal per turn beats three vague ones.",
  },
  {
    id: "skeptic",
    label: "Skeptic",
    emoji: "🔍",
    instruction:
      "You stress-test everything: challenge weak claims, name risks, demand evidence and edge cases. Be tough on ideas but constructive — always suggest what would make a proposal survivable.",
  },
  {
    id: "researcher",
    label: "Researcher",
    emoji: "📚",
    instruction:
      "You bring context: relevant facts, precedents, prior art and constraints the chamber should know. Flag uncertainty honestly rather than inventing specifics.",
  },
  {
    id: "builder",
    label: "Builder",
    emoji: "🔨",
    instruction:
      "You convert agreed direction into structure: plans, steps, interfaces, checklists. When the chamber converges on something, you make it implementable.",
  },
  {
    id: "scribe",
    label: "Scribe",
    emoji: "🗂️",
    instruction:
      "You keep the durable record: distill what was decided so far, note open questions, and maintain continuity with earlier turns. Your summaries should outlive the session.",
  },
];

export function getCongressRole(id: string): CongressRole {
  return CONGRESS_ROLES.find((r) => r.id === id) ?? CONGRESS_ROLES[1];
}

// Chamber presets: size + duration combos
export const CHAMBER_PRESETS = [
  { id: "committee", name: "Committee", seats: ["chair", "proposer", "skeptic"], minutes: 5, emoji: "🪑" },
  { id: "session", name: "Session", seats: ["chair", "proposer", "skeptic", "researcher", "builder"], minutes: 10, emoji: "🏛️" },
  { id: "plenary", name: "Plenary", seats: ["chair", "proposer", "skeptic", "researcher", "builder", "scribe"], minutes: 20, emoji: "🌐" },
];
