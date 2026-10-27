import assert from "node:assert/strict";
import { test } from "node:test";
import http from "node:http";
import type { AddressInfo } from "node:net";

// Provider clients (plex/jellyfin) — proven against REAL HTTP fixture
// servers: our fetch code, headers, timeouts, parsing, and error mapping
// all really run; only the provider's answers are fixtures (a real Plex/
// Jellyfin is owner-side hardware we cannot reach from the test sandbox).

type Route = { status?: number; body: unknown };

async function startFixtureServer(routes: Record<string, Route>): Promise<{ port: number; stop: () => Promise<void>; hits: string[] }> {
  const hits: string[] = [];
  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    const path = url.pathname;
    hits.push(path);
    const route = routes[path];
    res.setHeader("content-type", "application/json");
    if (!route) {
      res.statusCode = 404;
      res.end(JSON.stringify({ error: "no route" }));
      return;
    }
    res.statusCode = route.status ?? 200;
    res.end(JSON.stringify(route.body));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const port = (server.address() as AddressInfo).port;
  const stop = async () => {
    (server as http.Server & { closeAllConnections?: () => void }).closeAllConnections?.();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  };
  return { port, stop, hits };
}

test("plex client: libraries + items with watch state, normalized", async () => {
  const { fetchPlexLibraries, fetchPlexLibraryItems } = await import("./plex");
  const server = await startFixtureServer({
    "/library/sections": {
      body: {
        MediaContainer: {
          Directory: [
            { key: "1", title: "Movies", type: "movie" },
            { key: "2", title: "TV Shows", type: "show" },
          ],
        },
      },
    },
    "/library/sections/1/all": {
      body: {
        MediaContainer: {
          Metadata: [
            {
              ratingKey: "100",
              title: "Arrival",
              year: 2016,
              type: "1",
              viewCount: 2,
              lastViewedAt: 1790200000,
              duration: 6900000,
              librarySectionTitle: "Movies",
            },
            { ratingKey: "101", title: "Heat", year: 1995, type: 1 },
            { ratingKey: "102", title: "Some Season", type: "3" },
          ],
        },
      },
    },
  });
  try {
    const base = `http://127.0.0.1:${server.port}`;
    const libraries = await fetchPlexLibraries(base, "token-xyz");
    assert.deepEqual(
      libraries.map((l) => l.title),
      ["Movies", "TV Shows"],
    );
    const items = await fetchPlexLibraryItems(base, "token-xyz", "1");
    assert.equal(items.length, 3);
    const arrival = items.find((i) => i.ratingKey === "100");
    assert.ok(arrival);
    assert.equal(arrival.itemType, "movie");
    assert.equal(arrival.year, 2016);
    assert.equal(arrival.viewCount, 2);
    assert.equal(arrival.durationMs, 6900000);
    assert.ok(arrival.lastViewedAt && Math.abs(arrival.lastViewedAt.getTime() - 1790200000 * 1000) < 1000);
    assert.equal(arrival.libraryName, "Movies");
    const heat = items.find((i) => i.ratingKey === "101");
    assert.ok(heat);
    assert.equal(heat.viewCount, 0);
    assert.equal(heat.lastViewedAt, null);
    const season = items.find((i) => i.ratingKey === "102");
    assert.ok(season);
    assert.equal(season.itemType, "unknown"); // seasons are not movie/show/episode
    // The token really traveled as a query parameter.
    assert.ok(server.hits.every((h) => h === "/library/sections" || h === "/library/sections/1/all"));
  } finally {
    await server.stop();
  }
});

test("plex client: honest auth and bad-shape errors", async () => {
  const { MediaProviderError } = await import("./types");
  const { fetchPlexLibraries: fp } = await import("./plex");
  const auth = await startFixtureServer({ "/library/sections": { status: 401, body: { error: "unauthorized" } } });
  try {
    await assert.rejects(
      fp(`http://127.0.0.1:${auth.port}`, "bad-token"),
      (e: unknown) => e instanceof MediaProviderError && e.code === "auth_failed",
    );
  } finally {
    await auth.stop();
  }
  const malformed = await startFixtureServer({ "/library/sections": { body: { nonsense: true } } });
  try {
    await assert.rejects(
      fp(`http://127.0.0.1:${malformed.port}`, "token"),
      (e: unknown) => e instanceof MediaProviderError && e.code === "bad_response",
    );
  } finally {
    await malformed.stop();
  }
});

test("jellyfin client: user resolution, views, items with ticks→ms", async () => {
  const { resolveJellyfinUserId, fetchJellyfinUserViews, fetchJellyfinItems } = await import("./jellyfin");
  const server = await startFixtureServer({
    "/Users": { body: [{ Id: "u-1", Name: "owner" }] },
    "/Users/u-1/Views": { body: { Items: [{ Id: "v-1", Name: "Films" }] } },
    "/Users/u-1/Items": {
      body: {
        Items: [
          {
            Id: "i-1",
            Name: "Dune",
            Type: "Movie",
            ProductionYear: 2021,
            RunTimeTicks: 96600000000,
            UserData: { PlayCount: 1, LastPlayedDate: "2026-10-01T10:00:00.000Z" },
          },
          { Id: "i-2", Name: "Severance", Type: "Series", ProductionYear: 2022 },
        ],
      },
    },
  });
  try {
    const base = `http://127.0.0.1:${server.port}`;
    const userId = await resolveJellyfinUserId(base, "key");
    assert.equal(userId, "u-1");
    const views = await fetchJellyfinUserViews(base, "key", userId);
    assert.deepEqual(views, [{ key: "v-1", title: "Films" }]);
    const items = await fetchJellyfinItems(base, "key", userId, "v-1");
    assert.equal(items.length, 2);
    const dune = items.find((i) => i.ratingKey === "i-1");
    assert.ok(dune);
    assert.equal(dune.itemType, "movie");
    assert.equal(dune.durationMs, 9660000); // 9.66e10 ticks / 1e4
    assert.equal(dune.viewCount, 1);
    assert.equal(dune.lastViewedAt?.toISOString(), "2026-10-01T10:00:00.000Z");
    const severance = items.find((i) => i.ratingKey === "i-2");
    assert.ok(severance);
    assert.equal(severance.itemType, "show");
    assert.equal(severance.viewOffsetMs, 0);
  } finally {
    await server.stop();
  }
});

test("media identity keys normalize titles honestly", async () => {
  const { normalizeMediaTitle, mediaIdentityKey } = await import("./types");
  assert.equal(normalizeMediaTitle("  Dune: Part  TWO!! "), "dune part two");
  assert.equal(mediaIdentityKey("Dune", 2021), "dune|2021");
  assert.equal(mediaIdentityKey("DUNE!", null), "dune");
  assert.notEqual(mediaIdentityKey("Dune", 2021), mediaIdentityKey("Dune", 1984));
});
