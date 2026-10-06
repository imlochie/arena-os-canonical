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
    description: "Design personal assistants and open a direct chat when you choose.",
    state: "available",
    destination: { href: "/assistants", label: "Manage assistants" },
    secondaryDestination: { href: "/chat", label: "Open direct chat" },
  },
  {
    id: "orchestrator",
    handoffTarget: "operational",
    name: "Orchestrator",
    eyebrow: "Route",
    description: "Choose an existing workflow for the work. Nothing launches automatically.",
    state: "available",
    destination: { href: "/command", label: "Open Command" },
  },
  {
    id: "council",
    handoffTarget: "operational",
    name: "Council",
    eyebrow: "Compare",
    description: "Compare perspectives and synthesize a result after you submit a request.",
    state: "available",
    destination: { href: "/council", label: "Open Council" },
  },
  {
    id: "congress",
    handoffTarget: "operational",
    name: "Congress",
    eyebrow: "Decide",
    description: "Timed multi-seat AI deliberation with durable, resumable records. Each seat speaks in turn; you call the question. Runs locally, no keys.",
    state: "available",
    destination: { href: "/congress", label: "Open Congress" },
  },
  {
    id: "spaces",
    handoffTarget: "operational",
    name: "Spaces",
    eyebrow: "Organize",
    description: "A multi-agent work environment: give a space a standing task, staff it with an agent fleet (role + runtime per agent), run all agents concurrently, and get a synthesized deliverable with per-agent runtime provenance.",
    state: "available",
    destination: { href: "/spaces", label: "Open Spaces" },
    secondaryDestination: { href: "/projects", label: "Open Projects" },
  },
  {
    id: "archive-assistant",
    handoffTarget: "operational",
    name: "Archive Assistant",
    eyebrow: "Bridge",
    description: "A live, read-only bridge to the Archive Assistant app — overview, workload, reconciliation, and provider state, fetched fresh when you open the room. Arena can read, never act.",
    state: "available",
    // The bridge itself is this room's working surface: the [roomId] page
    // resolves the server-side connection probe and renders the live client.
    destination: { href: "/rooms/archive-assistant", label: "Open live bridge" },
  },
  {
    id: "classroom",
    handoffTarget: "operational",
    name: "Classroom",
    eyebrow: "Learn",
    description: "An executable teaching loop — lessons with memory, checks, and progression. AI instruction runs locally, no keys.",
    state: "available",
    destination: { href: "/classroom", label: "Open Classroom" },
  },
  {
    id: "studio",
    handoffTarget: "operational",
    name: "Studio",
    eyebrow: "Make",
    description: "Multimedia generation jobs. The procedural demo engine works offline end-to-end (video/image/audio); WanGP, ComfyUI and DashScope backends show live connection status and never fake output.",
    state: "available",
    destination: { href: "/studio", label: "Open Studio" },
  },
  {
    id: "cut-lab",
    handoffTarget: "operational",
    name: "Cut Lab",
    eyebrow: "Edit",
    description: "Browser-native video editing: import media or generate procedural clips, cut a timeline, and export a real video file (MediaRecorder). Projects persist.",
    state: "available",
    destination: { href: "/cut", label: "Open Cut Lab" },
  },
  {
    id: "waveyard",
    handoffTarget: "operational",
    name: "Waveyard",
    eyebrow: "Listen",
    description: "A music workspace: upload audio (waveform peaks computed in your browser), arrange clips across tracks, play back via Web Audio, and save arrangement versions. Stem/analysis worker features report honestly as unavailable.",
    state: "available",
    destination: { href: "/waveyard", label: "Open Waveyard" },
  },
  {
    id: "luma",
    handoffTarget: "operational",
    name: "LUMA",
    eyebrow: "See",
    description: "Photography: capture or import YOUR photos, apply non-destructive looks through the real LUMA color pipeline, and export image files. No text-to-image — that is the separate Image surface.",
    state: "available",
    destination: { href: "/luma", label: "Open LUMA" },
  },
  {
    id: "device-security",
    handoffTarget: "none",
    name: "Device Security",
    eyebrow: "Protect",
    description: "Browser-observable security and runtime posture: secure context, transport, WebCrypto, WebGPU, storage, and permissions — measured live, with explicit 'not observable' limits. Privacy controls remain a separate surface.",
    state: "available",
    destination: { href: "/device-security", label: "Run security check" },
    secondaryDestination: { href: "/privacy", label: "Privacy controls" },
  },
];

export const ARENA_ROOM_STATE_LABELS: Record<ArenaRoomState, string> = {
  available: "Existing app surface",
  local: "No service connected",
  approval: "Approval required",
};

export function getArenaRoom(roomId: string): ArenaRoom | undefined {
  return ARENA_ROOMS.find((room) => room.id === roomId);
}