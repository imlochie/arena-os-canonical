export type ArenaRoomState = "available" | "local" | "approval";

export interface ArenaRoom {
  id: string;
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
    name: "Assistant",
    eyebrow: "Think",
    description: "Design personal assistants and open a direct chat when you choose.",
    state: "available",
    destination: { href: "/assistants", label: "Manage assistants" },
    secondaryDestination: { href: "/chat", label: "Open direct chat" },
  },
  {
    id: "orchestrator",
    name: "Orchestrator",
    eyebrow: "Route",
    description: "Choose an existing workflow for the work. Nothing launches automatically.",
    state: "available",
    destination: { href: "/command", label: "Open Command" },
  },
  {
    id: "council",
    name: "Council",
    eyebrow: "Compare",
    description: "Compare perspectives and synthesize a result after you submit a request.",
    state: "available",
    destination: { href: "/council", label: "Open Council" },
  },
  {
    id: "congress",
    name: "Congress",
    eyebrow: "Decide",
    description: "A distinct decision room. No separate Congress service is connected yet.",
    state: "local",
  },
  {
    id: "spaces",
    name: "Spaces",
    eyebrow: "Organize",
    description: "Keep project work, artifacts, and memory together in the existing project workspace.",
    state: "available",
    destination: { href: "/projects", label: "Open Projects" },
  },
  {
    id: "archive-assistant",
    name: "Archive Assistant",
    eyebrow: "Bridge",
    description: "A live, read-only bridge to the Archive Assistant app — overview, workload, reconciliation, and provider state, fetched fresh when you open the room. Arena can read, never act.",
    state: "available",
  },
  {
    id: "classroom",
    name: "Classroom",
    eyebrow: "Learn",
    description: "No classroom, tutor, or course runs from this room yet. The teaching runtime exists only on an unmounted branch. The Guide is separate app documentation, not a course.",
    state: "local",
  },
  {
    id: "studio",
    name: "Studio",
    eyebrow: "Make",
    description: "No media studio is connected. The multimodal Studio exists only on an unmounted branch. Collab is a different surface — iterative multi-model work, not media production.",
    state: "local",
  },
  {
    id: "cut-lab",
    name: "Cut Lab",
    eyebrow: "Edit",
    description: "Media editing is not connected here. No files are processed.",
    state: "local",
  },
  {
    id: "waveyard",
    name: "Waveyard",
    eyebrow: "Listen",
    description: "Audio services are not connected. No audio is generated or processed.",
    state: "local",
  },
  {
    id: "luma",
    name: "LUMA",
    eyebrow: "See",
    description: "The LUMA camera app is a standalone offline photography tool and is not connected to Arena. Image is a different surface — text-to-image generation, not photography.",
    state: "local",
  },
  {
    id: "device-security",
    name: "Device Security",
    eyebrow: "Protect",
    description: "Review privacy controls. Approval settings do not authorize a service by themselves.",
    state: "approval",
    destination: { href: "/privacy", label: "Review Privacy Controls" },
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