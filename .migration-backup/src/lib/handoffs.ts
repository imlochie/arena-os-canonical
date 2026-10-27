// Client-safe: the Think → Challenge → Synthesize → Create → Test → Learn loop.
// Helpers to pass work between Arena / Collab / Council with project +
// source lineage preserved in the URL.

export type HandoffTarget = "arena" | "collab" | "council";

export interface Handoff {
  text: string;
  projectId?: string;
  source?: string; // e.g. "artifact:uuid" | "battle:uuid" | "council:uuid" | "collab:uuid"
  jobId?: string; // council only
  strategy?: string; // collab only
}

export function handoffUrl(target: HandoffTarget, h: Handoff): string {
  const params = new URLSearchParams();
  if (target === "arena") {
    params.set("prompt", h.text.slice(0, 4000));
    if (h.source) params.set("source", h.source);
    if (h.projectId) params.set("projectId", h.projectId);
    return `/?${params.toString()}`;
  }
  if (target === "collab") {
    params.set("challenge", h.text.slice(0, 6000));
    if (h.strategy) params.set("strategy", h.strategy);
    if (h.source) params.set("source", h.source);
    if (h.projectId) params.set("projectId", h.projectId);
    return `/collab?${params.toString()}`;
  }
  params.set("material", h.text.slice(0, 8000));
  if (h.jobId) params.set("jobId", h.jobId);
  if (h.source) params.set("source", h.source);
  if (h.projectId) params.set("projectId", h.projectId);
  return `/council?${params.toString()}`;
}

export function parseSource(source?: string | null): { type: string; id: string } | null {
  if (!source || !source.includes(":")) return null;
  const [type, ...rest] = source.split(":");
  return { type, id: rest.join(":") };
}

// Canonical loop recipes shown in the UI.
export const LOOP_RECIPES = [
  {
    emoji: "🔬",
    title: "Research Brief → Arena Battle",
    desc: "Council researches, Arena pressure-tests the claim.",
    from: "council" as const,
    to: "arena" as const,
  },
  {
    emoji: "🎨",
    title: "Creative Brief → Collab Session",
    desc: "Council concepts, Collab produces the artifact.",
    from: "council" as const,
    to: "collab" as const,
  },
  {
    emoji: "⚙️",
    title: "Systems Blueprint → Plan",
    desc: "Blueprint becomes an implementation plan + checklist.",
    from: "council" as const,
    to: "collab" as const,
  },
  {
    emoji: "⚔️",
    title: "Refined Thesis → Debate",
    desc: "Thought-editor output enters blind battle.",
    from: "council" as const,
    to: "arena" as const,
  },
  {
    emoji: "🏆",
    title: "Winning Proposal → Implementation",
    desc: "Arena winner becomes Collab input.",
    from: "arena" as const,
    to: "collab" as const,
  },
  {
    emoji: "💎",
    title: "Synthesis → Project Decision",
    desc: "Collab output recorded as project memory.",
    from: "collab" as const,
    to: "council" as const,
  },
];
