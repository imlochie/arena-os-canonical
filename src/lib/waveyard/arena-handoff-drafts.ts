import { getArenaRoom } from "@/lib/arenaRooms";

export const ARENA_PROJECTS_ENDPOINT = "/api/arena/projects";
export const ARENA_HANDOFF_DRAFT_STORAGE_KEY = "arena-handoff-drafts-v1";
export const MAX_ARENA_HANDOFF_DRAFTS = 50;
export const MAX_ARENA_HANDOFF_TITLE_LENGTH = 160;
export const MAX_ARENA_HANDOFF_PAYLOAD_LENGTH = 8_000;
export const MAX_ARENA_PROJECT_REFERENCE_LENGTH = 180;

export type ArenaHandoffDraftStatus = "queued" | "reviewed";
export type ArenaHandoffDraftTargetKind = "operational" | "planning";

/**
 * This is an optional browser-local review record, not an Arena handoff
 * transport and not a replacement for persisted arena_room_handoffs records.
 */
export type ArenaHandoffDraft = {
  id: string;
  title: string;
  fromRoomId: string;
  toRoomId: string;
  targetKind: ArenaHandoffDraftTargetKind;
  arenaProjectId: string | null;
  payload: string;
  createdAt: string;
  status: ArenaHandoffDraftStatus;
};

export type ArenaHandoffDraftInput = Omit<
  ArenaHandoffDraft,
  "targetKind" | "createdAt" | "status"
>;

type DraftResult<T> = { ok: true; value: T } | { ok: false; error: string };
export type DraftReadResult = DraftResult<ArenaHandoffDraft[]>;
export type DraftWriteResult = DraftResult<undefined>;

export type StorageLike = Pick<Storage, "getItem" | "setItem" | "removeItem">;

function browserStorage(): StorageLike | null {
  if (typeof window === "undefined") return null;
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

function boundedString(value: unknown, maximum: number, required = true): value is string {
  return typeof value === "string"
    && value.length <= maximum
    && (!required || value.trim().length > 0);
}

function targetKindForRoom(roomId: string): ArenaHandoffDraftTargetKind | null {
  const room = getArenaRoom(roomId);
  if (room?.handoffTarget === "operational") return "operational";
  if (room?.handoffTarget === "planning") return "planning";
  return null;
}

function isValidDate(value: unknown): value is string {
  return typeof value === "string" && value.length <= 64 && !Number.isNaN(Date.parse(value));
}

export function validateArenaHandoffDraft(value: unknown): DraftResult<ArenaHandoffDraft> {
  if (!value || typeof value !== "object") return { ok: false, error: "A draft must be an object." };
  const record = value as Partial<ArenaHandoffDraft>;
  if (!boundedString(record.id, 128)) return { ok: false, error: "Draft id is invalid." };
  if (!boundedString(record.title, MAX_ARENA_HANDOFF_TITLE_LENGTH)) return { ok: false, error: "Draft title is invalid." };
  if (!boundedString(record.fromRoomId, 80)) return { ok: false, error: "Draft source room is invalid." };
  if (!boundedString(record.toRoomId, 80)) return { ok: false, error: "Draft destination room is invalid." };
  if (record.fromRoomId === record.toRoomId) return { ok: false, error: "Draft source and destination must differ." };
  if (!boundedString(record.payload, MAX_ARENA_HANDOFF_PAYLOAD_LENGTH)) return { ok: false, error: "Draft payload is invalid." };
  if (!isValidDate(record.createdAt)) return { ok: false, error: "Draft date is invalid." };
  if (record.status !== "queued" && record.status !== "reviewed") return { ok: false, error: "Draft status is invalid." };
  if (record.arenaProjectId !== null && !boundedString(record.arenaProjectId, MAX_ARENA_PROJECT_REFERENCE_LENGTH))
    return { ok: false, error: "Arena project reference is invalid." };

  const source = getArenaRoom(record.fromRoomId);
  if (!source || source.handoffTarget === "none") return { ok: false, error: "Draft source room is not recognised." };
  const targetKind = targetKindForRoom(record.toRoomId);
  if (!targetKind) return { ok: false, error: "Draft destination is not an allowed target." };
  if (record.targetKind !== targetKind) return { ok: false, error: "Draft destination mode is invalid." };

  return { ok: true, value: record as ArenaHandoffDraft };
}

export function validateArenaHandoffDrafts(value: unknown): DraftResult<ArenaHandoffDraft[]> {
  if (!Array.isArray(value)) return { ok: false, error: "Saved handoff drafts are not a list." };
  if (value.length > MAX_ARENA_HANDOFF_DRAFTS)
    return { ok: false, error: `Saved handoff drafts exceed the ${MAX_ARENA_HANDOFF_DRAFTS}-draft limit.` };
  const records: ArenaHandoffDraft[] = [];
  for (const item of value) {
    const result = validateArenaHandoffDraft(item);
    if (!result.ok) return { ok: false, error: "Saved handoff drafts are invalid and were left unchanged." };
    records.push(result.value);
  }
  return { ok: true, value: records };
}

export function createArenaHandoffDraft(input: ArenaHandoffDraftInput, createdAt = new Date().toISOString()): DraftResult<ArenaHandoffDraft> {
  const targetKind = targetKindForRoom(input.toRoomId);
  if (!targetKind) return { ok: false, error: "Choose an operational room or a clearly labelled planning target." };
  return validateArenaHandoffDraft({
    ...input,
    title: typeof input.title === "string" ? input.title.trim() : input.title,
    payload: typeof input.payload === "string" ? input.payload.trim() : input.payload,
    arenaProjectId: input.arenaProjectId || null,
    targetKind,
    createdAt,
    status: "queued",
  });
}

export function readArenaHandoffDrafts(storage: StorageLike | null = browserStorage()): DraftReadResult {
  if (!storage) return { ok: false, error: "Browser storage is not available." };
  try {
    const raw = storage.getItem(ARENA_HANDOFF_DRAFT_STORAGE_KEY);
    if (!raw) return { ok: true, value: [] };
    return validateArenaHandoffDrafts(JSON.parse(raw) as unknown);
  } catch {
    return { ok: false, error: "Saved handoff drafts could not be read and were left unchanged." };
  }
}

export function writeArenaHandoffDrafts(
  drafts: ArenaHandoffDraft[],
  storage: StorageLike | null = browserStorage(),
): DraftWriteResult {
  if (!storage) return { ok: false, error: "Browser storage is not available." };
  const valid = validateArenaHandoffDrafts(drafts);
  if (!valid.ok) return { ok: false, error: valid.error };
  try {
    storage.setItem(ARENA_HANDOFF_DRAFT_STORAGE_KEY, JSON.stringify(valid.value));
    return { ok: true, value: undefined };
  } catch {
    return { ok: false, error: "Handoff drafts could not be saved. Check browser storage and try again." };
  }
}

export function clearArenaHandoffDrafts(storage: StorageLike | null = browserStorage()): DraftWriteResult {
  if (!storage) return { ok: false, error: "Browser storage is not available." };
  try {
    storage.removeItem(ARENA_HANDOFF_DRAFT_STORAGE_KEY);
    return { ok: true, value: undefined };
  } catch {
    return { ok: false, error: "Handoff drafts could not be cleared. Check browser storage and try again." };
  }
}
