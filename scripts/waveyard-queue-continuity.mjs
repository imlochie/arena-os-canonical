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
  album: "", durationSeconds: 12, rating: 0, playCount: 0, labels: [],
  addedAt: new Date().toISOString(), lastPlayedAt: null,
  stemAvailability: { status: "source-only" }, studioProjectId: null,
}));
const session = {
  id: sessionId, name: "Queue continuity test", currentSessionTrackId: null,
  positionSeconds: 0, tracks: [], swaps: [],
  createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
};
let savedQueue = [];
let queueSequence = 0;
let sessionTrackSequence = 0;

function wav() {
  const count = 22050 * 12;
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
      const id = `saved-${++queueSequence}`;
      savedQueue.push({ id, position: savedQueue.length, track: library.find((item) => item.id === trackId) });
      return routeJson(route, { queue: savedQueue, addedQueueItemId: id }, 201);
    }
    if (route.request().method() === "DELETE") {
      const linkedIds = new Set(savedQueue.map((item) => item.id));
      const removed = session.tracks.filter((item) => linkedIds.has(item.queueItemId));
      session.tracks = session.tracks.filter((item) => !linkedIds.has(item.queueItemId));
      session.tracks.forEach((item, position) => { item.position = position; });
      if (removed.some((item) => item.id === session.currentSessionTrackId)) {
        session.currentSessionTrackId = null;
        session.positionSeconds = 0;
      }
      savedQueue = [];
      return routeJson(route, { queue: [], affectedSessionIds: removed.length > 0 ? [sessionId] : [] });
    }
    await routeJson(route, { queue: savedQueue });
  });
  await page.route("**/api/library/queue/*", async (route) => {
    if (route.request().method() !== "DELETE") return route.continue();
    const id = new URL(route.request().url()).pathname.split("/").at(-1);
    const removedQueueItem = savedQueue.find((item) => item.id === id);
    savedQueue = savedQueue.filter((item) => item.id !== id);
    savedQueue.forEach((item, position) => { item.position = position; });
    const linkedIds = new Set(removedQueueItem ? [removedQueueItem.id] : []);
    const removed = session.tracks.filter((item) => linkedIds.has(item.queueItemId));
    session.tracks = session.tracks.filter((item) => !linkedIds.has(item.queueItemId));
    session.tracks.forEach((item, position) => { item.position = position; });
    if (removed.some((item) => item.id === session.currentSessionTrackId)) {
      session.currentSessionTrackId = null;
      session.positionSeconds = 0;
    }
    return routeJson(route, { queue: savedQueue, affectedSessionIds: removed.length > 0 ? [sessionId] : [] });
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
      const { trackId, position, queueItemId } = request.postDataJSON();
      const track = library.find((item) => item.id === trackId);
      assert.ok(track, `known fixture track ${trackId}`);
      session.tracks.push({
        id: `session-track-${++sessionTrackSequence}`, position,
        queueItemId: queueItemId ?? null,
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
  const waitForFixture = async (predicate, description, timeoutMs = 8000) => {
    const until = Date.now() + timeoutMs;
    while (!predicate() && Date.now() < until) await new Promise((resolve) => setTimeout(resolve, 30));
    assert.ok(predicate(), `timed out waiting for ${description}`);
  };
  const queueTrack = (title) => page.locator('[data-testid="library-track"]').filter({ hasText: title })
    .getByRole("button", { name: "+ Queue" }).click();
  await queueTrack("Queue fixture 1");
  await waitForFixture(() => session.tracks.length === 1 && savedQueue.length === 1, "the first queue addition");
  await waitForFixture(() => session.currentSessionTrackId === session.tracks[0]?.id, "the idle session to start");
  assert.equal(session.tracks[0].queueItemId, savedQueue[0].id, "the saved row is linked to its exact session entry");

  await queueTrack("Queue fixture 2");
  await queueTrack("Queue fixture 1");
  await waitForFixture(() => session.tracks.length === 3 && savedQueue.length === 3, "the repeated queued songs");
  assert.equal(session.tracks[0].track.id, session.tracks[2].track.id, "the duplicate songs remain separate entries");
  assert.notEqual(session.tracks[0].queueItemId, session.tracks[2].queueItemId, "repeated songs have distinct saved-row links");
  await page.getByRole("button", { name: "Remove Queue fixture 2 from queue" }).click();
  await waitForFixture(() => session.tracks.length === 2 && savedQueue.length === 2, "removing one saved queue row");
  assert.deepEqual(session.tracks.map((item) => item.track.id), [ids[0], ids[0]], "removing a queued song leaves the repeated song copies intact");
  assert.equal(session.currentSessionTrackId, "session-track-1", "removing a later queue item does not interrupt the current song");

  await page.getByRole("button", { name: "Test playlist" }).click();
  await page.getByTestId("playlist-live-test-set").click();
  await waitForFixture(() => session.tracks.length === 4, "the ordered playlist additions");
  assert.deepEqual(session.tracks.map((item) => item.track.id), [ids[0], ids[0], ids[1], ids[2]], "playlist songs append without saved-queue links");
  assert.equal(session.currentSessionTrackId, "session-track-1", "appending the playlist leaves the current song playing");
  assert.equal(savedQueue.length, 2, "playlist-only songs do not create saved-queue rows");
  assert.equal(session.tracks[2].queueItemId, null, "directly appended session songs have no saved-queue link");

  await page.getByRole("button", { name: "Clear", exact: true }).click();
  await waitForFixture(() => session.tracks.length === 2 && savedQueue.length === 0, "clearing linked saved rows");
  assert.deepEqual(session.tracks.map((item) => item.track.id), [ids[1], ids[2]], "clearing the saved queue leaves direct playlist songs in the session");
  await waitForFixture(() => session.currentSessionTrackId === "session-track-4", "playback advances to the first remaining session song");

  await queueTrack("Queue fixture 1");
  await waitForFixture(() => session.tracks.length === 3 && savedQueue.length === 1, "a queue item after clearing");
  const autoCrossfade = page.getByTestId("session-auto-crossfade");
  assert.equal(await autoCrossfade.isChecked(), false, "auto-crossfade stays opt-in");
  await page.getByTestId("session-transition").click();
  await page.getByRole("button", { name: "Finish", exact: true }).click();
  await waitForFixture(() => session.currentSessionTrackId === "session-track-5", "the existing manual mix control");
  await autoCrossfade.check();
  await page.locator(".wy-now .eyebrow").filter({ hasText: "Mixing" }).waitFor({ timeout: 16000 });
  await waitForFixture(() => session.currentSessionTrackId === "session-track-6", "automatic handoff at the selected fade length", 18000);
  await page.reload();
  assert.equal(await page.getByTestId("session-auto-crossfade").isChecked(), true, "the auto-crossfade preference survives reload");
  console.log("PASS: exact queue/session links, duplicate preservation, clear behavior, manual and automatic fades");
} finally {
  await browser.close();
}
