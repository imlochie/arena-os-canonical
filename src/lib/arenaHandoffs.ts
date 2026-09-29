export type HandoffStatus = "queued" | "reviewed";

export interface ArenaHandoff {
  id: string;
  title: string;
  fromRoomId: string;
  toRoomId: string;
  projectId: string | null;
  payload: string;
  createdAt: string;
  status: HandoffStatus;
}

export type HandoffReadResult =
  | { ok: true; records: ArenaHandoff[] }
  | { ok: false; records: []; error: string };

export type HandoffWriteResult = { ok: true } | { ok: false; error: string };

const STORAGE_KEY = "arena-canonical-handoffs-v1";

function isHandoff(value: unknown): value is ArenaHandoff {
  if (!value || typeof value !== "object") return false;
  const record = value as Partial<ArenaHandoff>;
  return (
    typeof record.id === "string" &&
    typeof record.title === "string" &&
    typeof record.fromRoomId === "string" &&
    typeof record.toRoomId === "string" &&
    (record.projectId === null || typeof record.projectId === "string") &&
    typeof record.payload === "string" &&
    typeof record.createdAt === "string" &&
    (record.status === "queued" || record.status === "reviewed")
  );
}

export function readArenaHandoffs(): HandoffReadResult {
  if (typeof window === "undefined") {
    return { ok: false, records: [], error: "Browser storage is not available." };
  }

  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return { ok: true, records: [] };

    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed) || !parsed.every(isHandoff)) {
      return {
        ok: false,
        records: [],
        error: "Saved handoff data is invalid. It was left unchanged.",
      };
    }

    return { ok: true, records: parsed };
  } catch {
    return {
      ok: false,
      records: [],
      error: "Could not read saved handoffs. Browser storage was left unchanged.",
    };
  }
}

export function writeArenaHandoffs(records: ArenaHandoff[]): HandoffWriteResult {
  if (typeof window === "undefined") {
    return { ok: false, error: "Browser storage is not available." };
  }

  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(records));
    return { ok: true };
  } catch {
    return {
      ok: false,
      error: "Could not save handoffs. Check browser storage and try again.",
    };
  }
}