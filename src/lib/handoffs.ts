// Client-safe: the Think → Challenge → Synthesize → Create → Test → Learn loop.
// Client helpers for persisted handoffs. URLs carry identity only; inherited
// context and provenance are loaded from the durable handoff record.

export type HandoffTarget = "arena" | "collab" | "council";

export function handoffDestination(target: HandoffTarget, handoffId: string, targetSessionId: string): string {
  const params = new URLSearchParams({ handoffId, sessionId: targetSessionId });
  if (target === "arena") return `/?${params.toString()}`;
  return `/${target}?${params.toString()}`;
}

export async function fetchHandoffContext(handoffId: string): Promise<{
  handoff: any;
  targetSession: any;
  input: any;
}> {
  const response = await fetch(`/api/handoffs/${encodeURIComponent(handoffId)}`, { cache: "no-store" });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error?.message ?? "Unable to load handoff.");
  return {
    handoff: data.handoff,
    targetSession: data.targetSession,
    input: (data.inputs ?? []).find((item: any) => item.id === data.handoff.payload?.inputId) ?? data.inputs?.[0],
  };
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
