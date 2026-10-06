/**
 * Room directory routing contract tests.
 *
 * Regression guard for the "painted door" bug class: a room card that links to
 * a URL no route actually serves. Every room must open its real working
 * surface, and every destination href (internal, /-prefixed) must resolve to a
 * page that exists under src/app — checked against the filesystem, not a
 * status string.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { readdirSync } from "node:fs";
import { join } from "node:path";

import { ARENA_ROOMS, getArenaRoom } from "./arenaRooms";

/** The fixed 12-room inventory. Rooms are addresses; surfaces are not rooms. */
const EXPECTED_ROOM_IDS = [
  "assistant",
  "orchestrator",
  "council",
  "congress",
  "spaces",
  "archive-assistant",
  "classroom",
  "studio",
  "cut-lab",
  "waveyard",
  "luma",
  "device-security",
] as const;

/** Where each room card must send the user: the real working surface. */
const EXPECTED_DESTINATIONS: Record<string, string> = {
  assistant: "/assistants",
  orchestrator: "/command",
  council: "/council",
  congress: "/congress",
  spaces: "/spaces",
  "archive-assistant": "/rooms/archive-assistant",
  classroom: "/classroom",
  studio: "/studio",
  "cut-lab": "/cut",
  waveyard: "/waveyard",
  luma: "/luma",
  "device-security": "/device-security",
};

/** Collect every route Next.js actually serves (page.tsx / page.ts files). */
function collectRoutes(dir: string, prefix: string): Set<string> {
  const routes = new Set<string>();
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return routes;
  }
  for (const entry of entries) {
    if (entry.name.startsWith("(") && entry.name.endsWith(")")) {
      // Route groups do not contribute to the URL path.
      for (const r of collectRoutes(join(dir, entry.name), prefix)) routes.add(r);
      continue;
    }
    if (entry.isDirectory()) {
      for (const r of collectRoutes(join(dir, entry.name), `${prefix}/${entry.name}`)) routes.add(r);
    } else if (entry.name === "page.tsx" || entry.name === "page.ts" || entry.name === "page.js") {
      routes.add(prefix === "" ? "/" : prefix);
    }
  }
  return routes;
}

const APP_DIR = join(process.cwd(), "src", "app");
const ROUTES = collectRoutes(APP_DIR, "");

/** A href is served if a static route matches, or a [dynamic] segment matches
 *  exactly one path segment. */
function routeIsServed(href: string): boolean {
  if (!href.startsWith("/")) return false;
  if (ROUTES.has(href)) return true;
  const segments = href.split("/").filter(Boolean);
  for (const route of ROUTES) {
    const routeSegments = route.split("/").filter(Boolean);
    if (routeSegments.length !== segments.length) continue;
    const matched = routeSegments.every(
      (seg, i) => (seg.startsWith("[") && seg.endsWith("]")) || seg === segments[i],
    );
    if (matched) return true;
  }
  return false;
}

test("room inventory is exactly the fixed 12 rooms", () => {
  assert.deepEqual(
    ARENA_ROOMS.map((r) => r.id),
    [...EXPECTED_ROOM_IDS],
  );
});

test("every room in the inventory exists and is addressable by id", () => {
  for (const id of EXPECTED_ROOM_IDS) {
    const room = getArenaRoom(id);
    assert.ok(room, `room ${id} missing from getArenaRoom`);
    assert.equal(room.state, "available", `room ${id} should be available`);
    assert.ok(room.destination, `available room ${id} must have a destination — no "address only" rooms`);
  }
});

test("every room card routes to its real working surface", () => {
  for (const [id, href] of Object.entries(EXPECTED_DESTINATIONS)) {
    const room = getArenaRoom(id);
    assert.ok(room, `room ${id} missing`);
    assert.equal(
      room!.destination?.href,
      href,
      `room ${id} destination must be ${href}, got ${room!.destination?.href ?? "(none)"}`,
    );
  }
});

test("every destination href resolves to a route that actually exists", () => {
  assert.ok(ROUTES.size > 20, `route scan looks wrong (found ${ROUTES.size} routes)`);
  for (const room of ARENA_ROOMS) {
    const hrefs = [room.destination?.href, room.secondaryDestination?.href].filter(
      (h): h is string => typeof h === "string",
    );
    for (const href of hrefs) {
      assert.ok(
        routeIsServed(href),
        `${room.id} destination ${href} has no matching route under src/app (painted door: card links somewhere no page serves)`,
      );
    }
  }
});

test("archive-assistant destination is its live bridge surface, not an address-only room", () => {
  const room = getArenaRoom("archive-assistant");
  assert.ok(room);
  assert.equal(room!.destination?.href, "/rooms/archive-assistant");
  assert.match(room!.destination?.label ?? "", /bridge/i);
});
