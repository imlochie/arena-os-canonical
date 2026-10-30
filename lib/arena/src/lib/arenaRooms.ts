export type ArenaRoomState = "available" | "local" | "approval";

export type ArenaHandoffTargetKind = "operational" | "planning" | "none";

export interface ArenaRoom {
  id: string;
  /** Whether this room can receive a Waveyard/Arena handoff draft. */
  handoffTarget: ArenaHandoffTargetKind;
  name: string;
  eyebrow: string;
  description: string;
  state: ArenaRoomState;
  destination?: {
    href: string;
    label: string;
  };
  secondaryDestination?: {
    href: string;
    label: string;
  };
}

export const ARENA_ROOMS: ArenaRoom[] = [
  {
    id: "assistant",
    handoffTarget: "operational",
    name: "Assistant",
    eyebrow: "Think",
    description: "Create assistants, then choose when to open a direct chat.",
    state: "available",
    destination: { href: "/assistants", label: "Manage assistants" },
    secondaryDestination: { href: "/chat", label: "Open direct chat" },
  },
  {
    id: "orchestrator",
    handoffTarget: "operational",
    name: "Orchestrator",
    eyebrow: "Route",
    description: "Choose an existing workflow; it does not run until you start it.",
    state: "available",
    destination: { href: "/command", label: "Open Command" },
  },
  {
    id: "council",
    handoffTarget: "operational",
    name: "Council",
    eyebrow: "Compare",
    description: "Submit a request to compare perspectives and get a synthesis.",
    state: "available",
    destination: { href: "/council", label: "Open Council" },
  },
  {
    id: "congress",
    handoffTarget: "operational",
    name: "Congress",
    eyebrow: "Decide",
    description: "Run a timed, resumable multi-seat deliberation; you decide when to call the question.",
    state: "available",
    destination: { href: "/congress", label: "Open Congress" },
  },
  {
    id: "spaces",
    handoffTarget: "operational",
    name: "Spaces",
    eyebrow: "Organize",
    description: "Keep a browser session and task history per space. Open pages directly or run model-assisted missions.",
    state: "available",
    destination: { href: "/spaces", label: "Open Spaces" },
    secondaryDestination: { href: "/projects", label: "Open Projects" },
  },
  {
    id: "archive-assistant",
    handoffTarget: "operational",
    name: "Archive Assistant",
    eyebrow: "Bridge",
    description: "Read live Archive Assistant status and workload. This bridge cannot make changes.",
    state: "available",
    // The bridge itself is this room's working surface: the [roomId] page
    // resolves the server-side connection probe and renders the live client.
    destination: { href: "/rooms/archive-assistant", label: "Open live bridge" },
    secondaryDestination: { href: "/archive", label: "Open the assistant surface" },
  },
  {
    id: "classroom",
    handoffTarget: "operational",
    name: "Classroom",
    eyebrow: "Learn",
    description: "Work through lessons, checks, and progression with saved session history.",
    state: "available",
    destination: { href: "/classroom", label: "Open Classroom" },
  },
  {
    id: "college",
    handoffTarget: "none",
    name: "Lochie Life College",
    eyebrow: "Institution",
    description:
      "Use timetable, faculty, curriculum, and governance surfaces; compare scheduled and observed activity.",
    state: "available",
    destination: { href: "/college", label: "Open the College" },
    secondaryDestination: { href: "/college/day", label: "Today at the College" },
  },
  {
    id: "studio",
    handoffTarget: "operational",
    name: "Studio",
    eyebrow: "Make",
    description: "Create multimedia with the procedural engine or connected backends; results identify the engine used.",
    state: "available",
    destination: { href: "/studio", label: "Open Studio" },
  },
  {
    id: "creative",
    handoffTarget: "operational",
    name: "Creative Suite",
    eyebrow: "Make",
    description: "Create research, presentations, podcasts, voices, and captions with engine-labelled outputs.",
    state: "available",
    destination: { href: "/creative", label: "Open Creative Suite" },
    secondaryDestination: { href: "/model-hub", label: "Manage brains (Model Hub)" },
  },
  {
    id: "foundry",
    handoffTarget: "operational",
    name: "App Foundry",
    eyebrow: "Build",
    description: "Build and revise web apps with a connected model; previews run in a sandbox.",
    state: "available",
    destination: { href: "/foundry", label: "Open the Foundry" },
    secondaryDestination: { href: "/model-hub", label: "Wire a bigger brain" },
  },

  {
    id: "deep-agent",
    handoffTarget: "operational",
    name: "Deep Agent",
    eyebrow: "Automate",
    description: "Run bounded plan–act–verify missions with a time budget and a step log.",
    state: "available",
    destination: { href: "/deep-agent", label: "Open Deep Agent" },
    secondaryDestination: { href: "/runtime", label: "Choose its brain" },
  },
  {
    id: "mind",
    handoffTarget: "operational",
    name: "The Mind",
    eyebrow: "Remember",
    description: "Save notes, links, quotes, and images, then search them later.",
    state: "available",
    destination: { href: "/mind", label: "Open the Mind" },
    secondaryDestination: { href: "/archive", label: "See it in the Archive" },
  },
  {
    id: "subscriptions",
    handoffTarget: "operational",
    name: "Subscriptions",
    eyebrow: "Track",
    description: "Track recurring costs and forecasts; receipt extraction uses the configured engine.",
    state: "available",
    destination: { href: "/subscriptions", label: "Open Subscriptions" },
  },
  {
    id: "cut-lab",
    handoffTarget: "operational",
    name: "Cut Lab",
    eyebrow: "Edit",
    description: "Edit imported or generated clips on a browser timeline and export video.",
    state: "available",
    destination: { href: "/cut", label: "Open Cut Lab" },
  },
  {
    id: "waveyard",
    handoffTarget: "operational",
    name: "Waveyard",
    eyebrow: "Listen",
    description: "Upload music, separate stems, swap or isolate them live, then remix and export. The active worker and device determine processing speed.",
    state: "available",
    destination: { href: "/waveyard", label: "Open Waveyard" },
  },
  {
    id: "arcade",
    handoffTarget: "operational",
    name: "Arcade",
    eyebrow: "Play & build",
    description: "Create and revise browser games with a connected model; import supported web games.",
    state: "available",
    destination: { href: "/arcade", label: "Open Arcade" },
  },
  {
    id: "luma",
    handoffTarget: "operational",
    name: "LUMA",
    eyebrow: "See",
    description: "Import or capture photos, apply non-destructive looks, and export images.",
    state: "available",
    destination: { href: "/luma", label: "Open LUMA" },
  },
  {
    id: "market",
    handoffTarget: "none",
    name: "Market",
    eyebrow: "Compare",
    description: "Compare available models and provider options.",
    state: "available",
    destination: { href: "/market", label: "Open Market" },
  },
  {
    id: "device-security",
    handoffTarget: "none",
    name: "Device Security",
    eyebrow: "Protect",
    description: "Check browser-visible security properties and permissions; unobservable items are shown explicitly.",
    state: "available",
    destination: { href: "/device-security", label: "Run security check" },
    secondaryDestination: { href: "/privacy", label: "Privacy controls" },
  },
];

export const ARENA_ROOM_STATE_LABELS: Record<ArenaRoomState, string> = {
  available: "Route exists",
  local: "No service connected",
  approval: "Approval required",
};

export function getArenaRoom(roomId: string): ArenaRoom | undefined {
  return ARENA_ROOMS.find((room) => room.id === roomId);
}