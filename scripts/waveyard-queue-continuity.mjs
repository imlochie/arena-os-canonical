// Browser regression for library queue and playlist → listening-session flow.
// All database/API responses and WAV bytes are isolated Playwright fixtures.
import assert from "node:assert/strict";
import { createRequire } from "node:module";
const require = createRequire(new URL("../artifacts/api-server/package.json", import.meta.url));
const { chromium } = require("playwright-core");

const sessionId = "550e8400-e29b-41d4-a716-446655440010";
const sourceId = "550e8400-e29b-41d4-a716-446655440020";
const ids = ["550e8400-e29b-41d4-a716-446655440001", "550e8400-e29b-41d4-a716-446655440002", "550e8400-e29b-41d4-a716-446655440003"];
const library = ids.map((id, i) => ({
  id, title: `Queue fixture ${i + 1}`, artist: "Synthetic test",
  album: "", durationSeconds: 4, rating: 0, playCount: 0, labels: [],
  addedAt: new Date().toISOString(), lastPlayedAt: null,
  stemAvailability: { status: "source-only" }, studioProjectId: null,
}));
const session = {
  id: sessionId, name: "Queue continuity test", currentSessionTrackId: null,
  positionSeconds: 0, tracks: [], swaps: [],
  createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
};
let savedQueue = [];

function wav() {
  const count = 22050 * 4;
  const bytes = Buffer.alloc(44 + count * 2);
  bytes.write("RIFF"); bytes.writeUInt32LE(bytes.length - 8, 4); bytes.write("WAVEfmt ", 8);
  bytes.writeUInt32LE(16, 16); bytes.writeUInt16LE(1, 20); bytes.writeUInt16LE(1, 22);
  bytes.writeUInt32LE(22050, 24); bytes.writeUInt32LE(44100, 28); bytes.writeUInt16LE(2, 32);
  bytes.writeUInt16LE(16, 34); bytes.write("data", 36); bytes.writeUInt32LE(count * 2, 40);
  for (let i = 0; i < count; i++) bytes.writeInt16LE(Math.round(1200 * Math.sin(2 * Math.PI * 220 * i / 22050)), 44 + i * 2);
  return bytes;
}
const audio = wav();
const browser = await chromium.launch({
  executablePath: "/repl/tools/bin/chromium",
  args: ["--no-sandbox", "--autoplay-policy=no-user-gesture-required"],
});
try {
  const page = await browser.newPage();
  const routeJson = (route, body, status = 200) => route.fulfill({ status, json: body });

  await page.route("**/api/assets/*", (route) => route.fulfill({ status: 200, contentType: "audio/wav", body: audio }));
  await page.route("**/api/library/tracks", (route) => routeJson(route, { tracks: library }));
  await page.route("**/api/library/playlists", (route) => routeJson(route, {
    playlists: [{ id: "test-set", name: "Test playlist", trackCount: 2 }],
  }));
  await page.route("**/api/library/playlists/test-set", (route) => routeJson(route, {
    playlist: {
      id: "test-set", name: "Test playlist",
      items: [library[1], library[2]].map((track, position) => ({ id: `playlist-item-${position}`, position, track })),
    },
  }));
  await page.route("**/api/library/playback-state", (route) => routeJson(route, {
    playbackState: { currentTrackId: null, positionSeconds: 0 },
  }));
  await page.route("**/api/library/collections", (route) => routeJson(route, { collections: [] }));
  await page.route("**/api/library/queue", async (route) => {
    if (route.request().method() === "POST") {
      const { trackId } = route.request().postDataJSON();
      savedQueue.push({ id: `saved-${trackId}`, position: savedQueue.length, track: library.find((item) => item.id === trackId) });
    }
    await routeJson(route, { queue: savedQueue });
  });
  await page.route("**/api/library/sessions", async (route) => {
    if (route.request().method() === "POST") {
      session.tracks = [];
      session.currentSessionTrackId = null;
      return routeJson(route, { session: { id: sessionId } });
    }
    return routeJson(route, { sessions: [] });
  });
  await page.route(`**/api/library/sessions/${sessionId}**`, async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (request.method() === "POST" && url.pathname.endsWith("/tracks")) {
      const { trackId, position } = request.postDataJSON();
      const track = library.find((item) => item.id === trackId);
      assert.ok(track, `known fixture track ${trackId}`);
      session.tracks.push({
        id: `session-track-${session.tracks.length + 1}`, position,
        track: { id: track.id, title: track.title, artist: track.artist, durationSeconds: track.durationSeconds },
        stems: [], playback: { assetIds: [sourceId], kind: "source" }, stemMix: {},
        transition: { mode: "manual", crossfadeSeconds: 1, keepStems: [] }, analysis: null,
      });
    } else if (request.method() === "PUT" && url.pathname.endsWith("/state")) {
      const body = request.postDataJSON();
      session.currentSessionTrackId = body.currentSessionTrackId;
      session.positionSeconds = body.positionSeconds;
    }
    await routeJson(route, { session });
  });

  await page.goto("http://localhost:80/waveyard");
  await page.locator('[data-testid="button-play-550e8400-e29b-41d4-a716-446655440001"]').waitFor();
  await page.locator('[data-testid="library-track"]').filter({ hasText: "Queue fixture 1" })
    .getByRole("button", { name: "+ Queue" }).click();
  const waitForFixture = async (predicate, description) => {
    const until = Date.now() + 8000;
    while (!predicate() && Date.now() < until) await new Promise((resolve) => setTimeout(resolve, 30));
    assert.ok(predicate(), `timed out waiting for ${description}`);
  };
  await waitForFixture(() => session.tracks.length === 1, "the first queue addition");
  await waitForFixture(() => session.currentSessionTrackId === session.tracks[0]?.id, "the idle session to start");
  assert.equal(session.currentSessionTrackId, "session-track-1", "the first queued song starts an idle listening session");

  await page.getByRole("button", { name: "Test playlist" }).click();
  await page.getByTestId("playlist-live-test-set").click();
  await waitForFixture(() => session.tracks.length === 3, "the ordered playlist additions");
  assert.deepEqual(session.tracks.map((item) => item.track.id), [ids[0], ids[1], ids[2]], "playlist order appends intact");
  assert.equal(session.currentSessionTrackId, "session-track-1", "appending the playlist leaves the current song playing");
  assert.equal(savedQueue.length, 1, "the library's saved queue remains intact too");
  const autoCrossfade = page.getByTestId("session-auto-crossfade");
  assert.equal(await autoCrossfade.isChecked(), false, "auto-crossfade stays opt-in");
  await page.getByTestId("session-transition").click();
  await page.getByRole("button", { name: "Finish", exact: true }).click();
  await waitForFixture(() => session.currentSessionTrackId === "session-track-2", "the existing manual mix control");
  await autoCrossfade.check();
  await page.locator(".wy-now .eyebrow").filter({ hasText: "Mixing" }).waitFor({ timeout: 8000 });
  await waitForFixture(() => session.currentSessionTrackId === "session-track-3", "automatic handoff at the selected fade length");
  await page.reload();
  assert.equal(await page.getByTestId("session-auto-crossfade").isChecked(), true, "the auto-crossfade preference survives reload");
  console.log("PASS: queue order, manual mix, opt-in automatic crossfade, and preference persistence");
} finally {
  await browser.close();
}
