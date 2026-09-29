import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  ARENA_DISCOVERY_ROOMS,
  ARENA_NAVIGATION_ROOMS,
  ARENA_ROOM_REGISTRY,
  explicitDraftTargetAction,
  getArenaRoom,
  validateArenaRoomRegistry,
} from "../../apps/web/src/lib/arena-rooms";
import {
  ARENA_HANDOFF_DRAFT_STORAGE_KEY,
  ARENA_PROJECTS_ENDPOINT,
  clearArenaHandoffDrafts,
  MAX_ARENA_HANDOFF_DRAFTS,
  MAX_ARENA_HANDOFF_PAYLOAD_LENGTH,
  MAX_ARENA_HANDOFF_TITLE_LENGTH,
  createArenaHandoffDraft,
  readArenaHandoffDrafts,
  validateArenaHandoffDrafts,
  writeArenaHandoffDrafts,
  type ArenaHandoffDraft,
  type StorageLike,
} from "../../apps/web/src/lib/arena-handoff-drafts";

class MemoryStorage implements StorageLike {
  private records = new Map<string, string>();
  getItem(key: string) { return this.records.get(key) ?? null; }
  setItem(key: string, value: string) { this.records.set(key, value); }
  removeItem(key: string) { this.records.delete(key); }
}

function validDraft(overrides: Partial<ArenaHandoffDraft> = {}): ArenaHandoffDraft {
  return {
    id: "draft-1",
    title: "Review this context",
    fromRoomId: "command",
    toRoomId: "waveyard",
    targetKind: "operational",
    arenaProjectId: "arena-project-1",
    payload: "A written note only.",
    createdAt: "2026-09-30T00:00:00.000Z",
    status: "queued",
    ...overrides,
  };
}

describe("canonical Arena room registry", () => {
  it("keeps the shell navigation and the discovery taxonomy in one validated registry", () => {
    expect(validateArenaRoomRegistry()).toEqual([]);
    expect(ARENA_DISCOVERY_ROOMS).toHaveLength(12);
    expect(ARENA_NAVIGATION_ROOMS.map((room) => room.href)).toEqual([
      "/command", "/", "/council", "/collab", "/projects", "/artifacts", "/chat",
      "/assistants", "/arcade", "/image", "/leaderboard", "/guide", "/privacy",
      "/waveyard", "/rooms", "/handoffs",
    ]);
    expect(new Set(ARENA_ROOM_REGISTRY.map((room) => room.id)).size).toBe(ARENA_ROOM_REGISTRY.length);
  });

  it("maps discovery rooms only to canonical routes and keeps Waveyard live", () => {
    expect(getArenaRoom("command")?.href).toBe("/command");
    expect(getArenaRoom("collab")?.href).toBe("/collab");
    expect(getArenaRoom("waveyard")).toMatchObject({
      href: "/waveyard",
      availability: "operational",
      dataBoundary: "metadata-only",
    });
    expect(getArenaRoom("studio")).toBeUndefined();
  });

  it("exposes planning targets as non-executable references", () => {
    expect(getArenaRoom("congress")).toMatchObject({ availability: "planning", handoffTarget: "planning" });
    expect(getArenaRoom("congress")?.href).toBeUndefined();
    expect(getArenaRoom("cut-lab")).toMatchObject({ availability: "planning", handoffTarget: "planning" });
    expect(getArenaRoom("cut-lab")?.href).toBeUndefined();
    expect(explicitDraftTargetAction("congress")).toEqual({ kind: "planning-reference" });
    expect(explicitDraftTargetAction("cut-lab")).toEqual({ kind: "planning-reference" });
  });

  it("keeps explicit navigation payload-free", () => {
    expect(explicitDraftTargetAction("waveyard")).toEqual({ kind: "open-operational-room", href: "/waveyard" });
    expect(explicitDraftTargetAction("waveyard")).not.toHaveProperty("payload");
    expect(explicitDraftTargetAction("waveyard")).not.toMatchObject({ href: expect.stringContaining("?") });
  });
});

describe("Arena local handoff drafts", () => {
  it("rejects malformed or unknown records without overwriting stored data", () => {
    const storage = new MemoryStorage();
    const malformed = [validDraft({ toRoomId: "unknown-room", targetKind: "operational" })];
    const raw = JSON.stringify(malformed);
    storage.setItem(ARENA_HANDOFF_DRAFT_STORAGE_KEY, raw);

    const result = readArenaHandoffDrafts(storage);
    expect(result).toMatchObject({ ok: false });
    expect(storage.getItem(ARENA_HANDOFF_DRAFT_STORAGE_KEY)).toBe(raw);
  });

  it("enforces bounded title, payload, collection, and target validation", () => {
    expect(createArenaHandoffDraft({
      id: "too-long-title", title: "t".repeat(MAX_ARENA_HANDOFF_TITLE_LENGTH + 1), fromRoomId: "command", toRoomId: "council", arenaProjectId: null, payload: "context",
    })).toMatchObject({ ok: false });
    expect(createArenaHandoffDraft({
      id: "too-long-payload", title: "Valid", fromRoomId: "command", toRoomId: "council", arenaProjectId: null, payload: "p".repeat(MAX_ARENA_HANDOFF_PAYLOAD_LENGTH + 1),
    })).toMatchObject({ ok: false });
    expect(createArenaHandoffDraft({
      id: "unknown-target", title: "Valid", fromRoomId: "command", toRoomId: "unknown-room", arenaProjectId: null, payload: "context",
    })).toMatchObject({ ok: false });
    expect(validateArenaHandoffDrafts(Array.from({ length: MAX_ARENA_HANDOFF_DRAFTS + 1 }, (_, index) => validDraft({ id: `draft-${index}` })))).toMatchObject({ ok: false });

    const storage = new MemoryStorage();
    const result = writeArenaHandoffDrafts(Array.from({ length: MAX_ARENA_HANDOFF_DRAFTS + 1 }, (_, index) => validDraft({ id: `draft-${index}` })), storage);
    expect(result).toMatchObject({ ok: false });
    expect(storage.getItem(ARENA_HANDOFF_DRAFT_STORAGE_KEY)).toBeNull();
  });

  it("clears only browser-local drafts on an explicit action", () => {
    const storage = new MemoryStorage();
    expect(writeArenaHandoffDrafts([validDraft()], storage)).toMatchObject({ ok: true });
    expect(clearArenaHandoffDrafts(storage)).toMatchObject({ ok: true });
    expect(storage.getItem(ARENA_HANDOFF_DRAFT_STORAGE_KEY)).toBeNull();
  });

  it("models planning targets as drafts and Waveyard as a metadata-only reference", () => {
    const planning = createArenaHandoffDraft({
      id: "planning-draft", title: "Future decision", fromRoomId: "council", toRoomId: "congress", arenaProjectId: null, payload: "Discuss a future decision room.",
    });
    expect(planning).toMatchObject({ ok: true, value: { targetKind: "planning", status: "queued" } });

    const waveyard = createArenaHandoffDraft({
      id: "waveyard-draft", title: "Music note", fromRoomId: "command", toRoomId: "waveyard", arenaProjectId: null, payload: "Written context and provenance only.",
    });
    expect(waveyard).toMatchObject({ ok: true, value: { targetKind: "operational", toRoomId: "waveyard" } });
    if (waveyard.ok) {
      expect(Object.keys(waveyard.value)).not.toEqual(expect.arrayContaining(["sourceAssetId", "stemAssetId", "mediaUrl", "exportId"]));
    }
  });
});

describe("Arena Rooms integration mapping", () => {
  it("defines the three active app routes without nested old-root pages", () => {
    for (const route of [
      "apps/web/src/app/rooms/page.tsx",
      "apps/web/src/app/rooms/[roomId]/page.tsx",
      "apps/web/src/app/handoffs/page.tsx",
    ]) expect(existsSync(resolve(process.cwd(), route))).toBe(true);

    const detailRoute = readFileSync(resolve(process.cwd(), "apps/web/src/app/rooms/[roomId]/page.tsx"), "utf8");
    expect(detailRoute).toContain("getArenaRoom");
    expect(detailRoute).toContain("notFound");
  });

  it("uses the namespaced Arena project API rather than the Waveyard project API", () => {
    expect(ARENA_PROJECTS_ENDPOINT).toBe("/api/arena/projects");
    const detail = readFileSync(resolve(process.cwd(), "apps/web/src/components/arena/ArenaRoomDetail.tsx"), "utf8");
    expect(detail).toContain("fetch(ARENA_PROJECTS_ENDPOINT");
    expect(detail).not.toContain('fetch("/api/projects"');
  });
});
