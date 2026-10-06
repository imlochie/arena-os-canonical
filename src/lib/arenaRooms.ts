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
    name: "Archive",
    eyebrow: "Recall",
    description: "Browse saved artifacts from projects and battles. The AI archive assistant is not connected from this room.",
    state: "available",
    destination: { href: "/artifacts", label: "Browse Artifacts" },
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
    description: "Open the existing image workflow. Generation starts only after you submit there.",
    state: "available",
    destination: { href: "/image", label: "Open Image" },
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