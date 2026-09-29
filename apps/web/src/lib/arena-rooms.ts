export type ArenaRoomAvailability = "operational" | "planning";
export type ArenaHandoffTargetKind = "operational" | "planning" | "none";
export type ArenaDataBoundary = "arena-context" | "metadata-only";

export type ArenaRoom = {
  id: string;
  label: string;
  taxonomyLabel?: string;
  emoji: string;
  description: string;
  href?: string;
  availability: ArenaRoomAvailability;
  handoffTarget: ArenaHandoffTargetKind;
  dataBoundary: ArenaDataBoundary;
  navigation: boolean;
  discovery: boolean;
};

/**
 * Arena owns this registry. The navigation and the optional Rooms discovery
 * taxonomy both derive from it, so a directory card can never invent a route
 * or imply a service that the shell does not recognise.
 */
export const ARENA_ROOM_REGISTRY: readonly ArenaRoom[] = [
  {
    id: "command", label: "Command", taxonomyLabel: "Orchestrator", emoji: "🧭",
    description: "Choose an existing Arena workflow. Nothing begins until you submit there.",
    href: "/command", availability: "operational", handoffTarget: "operational", dataBoundary: "arena-context", navigation: true, discovery: true,
  },
  {
    id: "arena", label: "Arena", emoji: "⚔️",
    description: "Pressure-test a prompt in the existing blind battle surface.",
    href: "/", availability: "operational", handoffTarget: "operational", dataBoundary: "arena-context", navigation: true, discovery: false,
  },
  {
    id: "council", label: "Council", emoji: "🧠",
    description: "Compare perspectives and synthesize a result after you submit a request.",
    href: "/council", availability: "operational", handoffTarget: "operational", dataBoundary: "arena-context", navigation: true, discovery: true,
  },
  {
    id: "collab", label: "Collab", emoji: "🤝",
    description: "Develop work through Arena's existing collaborative workflow when you choose.",
    href: "/collab", availability: "operational", handoffTarget: "operational", dataBoundary: "arena-context", navigation: true, discovery: true,
  },
  {
    id: "projects", label: "Projects", taxonomyLabel: "Spaces", emoji: "📁",
    description: "Keep Arena project work, artifacts, and memory together.",
    href: "/projects", availability: "operational", handoffTarget: "operational", dataBoundary: "arena-context", navigation: true, discovery: true,
  },
  {
    id: "artifacts", label: "Artifacts", taxonomyLabel: "Archive", emoji: "📦",
    description: "Browse reusable Arena artifacts. This directory does not claim a separate retrieval service.",
    href: "/artifacts", availability: "operational", handoffTarget: "operational", dataBoundary: "arena-context", navigation: true, discovery: true,
  },
  {
    id: "chat", label: "Chat", emoji: "💬",
    description: "Open the existing direct-chat surface.",
    href: "/chat", availability: "operational", handoffTarget: "operational", dataBoundary: "arena-context", navigation: true, discovery: false,
  },
  {
    id: "assistants", label: "Assistants", taxonomyLabel: "Assistant", emoji: "🧬",
    description: "Design personal assistants and open a direct chat when you choose.",
    href: "/assistants", availability: "operational", handoffTarget: "operational", dataBoundary: "arena-context", navigation: true, discovery: true,
  },
  {
    id: "arcade", label: "Arcade", emoji: "🎮",
    description: "Open Arena's local game surface.",
    href: "/arcade", availability: "operational", handoffTarget: "operational", dataBoundary: "arena-context", navigation: true, discovery: false,
  },
  {
    id: "image", label: "Image", taxonomyLabel: "LUMA", emoji: "🖼️",
    description: "Open the existing image workflow. Generation starts only after you submit there.",
    href: "/image", availability: "operational", handoffTarget: "operational", dataBoundary: "arena-context", navigation: true, discovery: true,
  },
  {
    id: "leaderboard", label: "Board", emoji: "🏆",
    description: "Review the existing Arena leaderboard.",
    href: "/leaderboard", availability: "operational", handoffTarget: "operational", dataBoundary: "arena-context", navigation: true, discovery: false,
  },
  {
    id: "guide", label: "Guide", taxonomyLabel: "Classroom", emoji: "📖",
    description: "Read Arena's existing guide. No automated tutor runs from this directory.",
    href: "/guide", availability: "operational", handoffTarget: "operational", dataBoundary: "arena-context", navigation: true, discovery: true,
  },
  {
    id: "privacy", label: "Privacy", taxonomyLabel: "Device Security", emoji: "🛡️",
    description: "Review privacy controls. A review setting alone does not authorize a service.",
    href: "/privacy", availability: "operational", handoffTarget: "operational", dataBoundary: "arena-context", navigation: true, discovery: true,
  },
  {
    id: "waveyard", label: "Waveyard", emoji: "〰️",
    description: "Open the live music room for authorised source intake, separation, analysis, Studio work, playback, export, and publication.",
    href: "/waveyard", availability: "operational", handoffTarget: "operational", dataBoundary: "metadata-only", navigation: true, discovery: true,
  },
  {
    id: "congress", label: "Congress", emoji: "🗳️",
    description: "A planning-only decision-room concept. No separate Congress service is connected.",
    availability: "planning", handoffTarget: "planning", dataBoundary: "arena-context", navigation: false, discovery: true,
  },
  {
    id: "cut-lab", label: "Cut Lab", emoji: "✂️",
    description: "A planning-only media-editing concept. No Cut Lab service or file-processing path is connected.",
    availability: "planning", handoffTarget: "planning", dataBoundary: "arena-context", navigation: false, discovery: true,
  },
  {
    id: "rooms", label: "Rooms", emoji: "⌘",
    description: "Browse Arena's discovery taxonomy and verified room surfaces.",
    href: "/rooms", availability: "operational", handoffTarget: "none", dataBoundary: "arena-context", navigation: true, discovery: false,
  },
  {
    id: "handoffs", label: "Drafts", emoji: "⇄",
    description: "Review browser-local, non-authoritative handoff drafts.",
    href: "/handoffs", availability: "operational", handoffTarget: "none", dataBoundary: "arena-context", navigation: true, discovery: false,
  },
] as const;

export const ARENA_NAVIGATION_ROOMS = ARENA_ROOM_REGISTRY.filter((room) => room.navigation);
export const ARENA_DISCOVERY_ROOMS = ARENA_ROOM_REGISTRY.filter((room) => room.discovery);
export const ARENA_OPERATIONAL_DESTINATIONS = ARENA_ROOM_REGISTRY.filter(
  (room) => room.handoffTarget === "operational",
);
export const ARENA_PLANNING_DESTINATIONS = ARENA_ROOM_REGISTRY.filter(
  (room) => room.handoffTarget === "planning",
);

export function getArenaRoom(roomId: string): ArenaRoom | undefined {
  return ARENA_ROOM_REGISTRY.find((room) => room.id === roomId);
}

export function roomTitle(room: ArenaRoom): string {
  return room.taxonomyLabel ?? room.label;
}

export type ExplicitDraftTargetAction =
  | { kind: "open-operational-room"; href: string }
  | { kind: "planning-reference" }
  | null;

/**
 * Draft navigation is deliberately payload-free. A user may open an
 * operational room, but no draft content is inserted into its URL or sent to
 * it. Planning rooms have no executable route.
 */
export function explicitDraftTargetAction(roomId: string): ExplicitDraftTargetAction {
  const room = getArenaRoom(roomId);
  if (!room) return null;
  if (room.handoffTarget === "operational" && room.href)
    return { kind: "open-operational-room", href: room.href };
  if (room.handoffTarget === "planning") return { kind: "planning-reference" };
  return null;
}

export function validateArenaRoomRegistry(): string[] {
  const problems: string[] = [];
  const seen = new Set<string>();
  for (const room of ARENA_ROOM_REGISTRY) {
    if (seen.has(room.id)) problems.push(`Duplicate room id: ${room.id}`);
    seen.add(room.id);
    if (room.navigation && (!room.href || room.availability !== "operational"))
      problems.push(`Navigation room must be operational and routable: ${room.id}`);
    if (room.handoffTarget === "operational" && (!room.href || room.availability !== "operational"))
      problems.push(`Operational destination must be operational and routable: ${room.id}`);
    if (room.handoffTarget === "planning" && room.href)
      problems.push(`Planning target must not have an executable route: ${room.id}`);
    if (room.id === "waveyard" && room.dataBoundary !== "metadata-only")
      problems.push("Waveyard must remain a metadata-only cross-room boundary.");
  }
  return problems;
}
