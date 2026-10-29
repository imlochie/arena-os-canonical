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
let failNextQueueDelete = false;
let failNextQueueMove = false;
let failNextQueueClear = false;
let failNextPlaylistCreate = false;
let failNextPlaylistAdd = false;
let failNextPlaylistDelete = false;
let playlistDeleteRequests = 0;
let failNextPlaylistRename = false;
let failNextPlaylistMove = false;
let failNextPlaylistRemove = false;
let playlistDetail = {
  id: "test-set",
  name: "Test playlist",
  trackCount: 2,
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
  items: [library[1], library[2]].map((track, position) => ({ id: `playlist-item-${position}`, position, track })),
};

function wav() {
  // Keep audio alive through the removal scenarios; track metadata remains
  // short so the later automatic-fade check still completes quickly.
  const count = 22050 * 60;
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
  const context = await browser.newContext();
  const page = await context.newPage();
  const routeJson = (route, body, status = 200) => route.fulfill({ status, json: body });

  await context.route("**/api/assets/*", (route) => route.fulfill({ status: 200, contentType: "audio/wav", body: audio }));
  await context.route("**/api/library/tracks", (route) => routeJson(route, { tracks: library }));
  await context.route("**/api/library/playlists", async (route) => {
    if (route.request().method() === "POST" && failNextPlaylistCreate) {
      failNextPlaylistCreate = false;
      return routeJson(route, { error: "synthetic playlist creation failure" }, 503);
    }
    if (route.request().method() === "POST") {
      const { name } = route.request().postDataJSON();
      return routeJson(route, {
        playlist: {
          id: "created-playlist",
          name,
          trackCount: 0,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        },
      }, 201);
    }
    return routeJson(route, {
      playlists: [{ ...playlistDetail, trackCount: playlistDetail.items.length }],
    });
  });
  await context.route("**/api/library/playlists/test-set", (route) => {
    if (route.request().method() === "PATCH") {
      if (failNextPlaylistRename) {
        failNextPlaylistRename = false;
        return routeJson(route, { error: "synthetic playlist rename failure" }, 503);
      }
      playlistDetail.name = route.request().postDataJSON().name;
      return routeJson(route, {
        playlist: { id: playlistDetail.id, name: playlistDetail.name, trackCount: playlistDetail.items.length },
      });
    }
    if (route.request().method() === "DELETE") {
      playlistDeleteRequests += 1;
      if (failNextPlaylistDelete) {
        failNextPlaylistDelete = false;
        return routeJson(route, { error: "synthetic playlist delete failure" }, 503);
      }
      return routeJson(route, { ok: true });
    }
    return routeJson(route, { playlist: playlistDetail });
  });
  await context.route("**/api/library/playlists/test-set/items**", async (route) => {
    if (route.request().method() === "PATCH" && failNextPlaylistMove) {
      failNextPlaylistMove = false;
      return routeJson(route, { error: "synthetic playlist reorder failure" }, 503);
    }
    if (route.request().method() === "DELETE" && failNextPlaylistRemove) {
      failNextPlaylistRemove = false;
      return routeJson(route, { error: "synthetic playlist removal failure" }, 503);
    }
    if (route.request().method() === "POST" && failNextPlaylistAdd) {
      failNextPlaylistAdd = false;
      return routeJson(route, { error: "synthetic playlist add failure" }, 503);
    }
    if (route.request().method() === "PATCH") {
      const { itemId, position } = route.request().postDataJSON();
      const from = playlistDetail.items.findIndex((item) => item.id === itemId);
      if (from < 0) return routeJson(route, { error: "playlist item not found" }, 404);
      const target = Math.min(Math.max(position, 0), playlistDetail.items.length - 1);
      playlistDetail.items.splice(target, 0, playlistDetail.items.splice(from, 1)[0]);
      playlistDetail.items.forEach((item, index) => { item.position = index; });
      return routeJson(route, { playlist: playlistDetail });
    }
    if (route.request().method() === "DELETE") {
      const itemId = new URL(route.request().url()).searchParams.get("itemId");
      playlistDetail.items = playlistDetail.items.filter((item) => item.id !== itemId);
      playlistDetail.items.forEach((item, index) => { item.position = index; });
      playlistDetail.trackCount = playlistDetail.items.length;
      return routeJson(route, { playlist: playlistDetail });
    }
    if (route.request().method() === "POST") {
      const { trackId } = route.request().postDataJSON();
      const track = library.find((item) => item.id === trackId);
      const item = { id: `playlist-item-${playlistDetail.items.length}`, position: playlistDetail.items.length, track };
      playlistDetail.items.push(item);
      playlistDetail.trackCount = playlistDetail.items.length;
      return routeJson(route, { playlist: playlistDetail }, 201);
    }
    return route.continue();
  });
  await context.route("**/api/library/playback-state", (route) => routeJson(route, {
    playbackState: { currentTrackId: null, positionSeconds: 0 },
  }));
  await context.route("**/api/library/collections", (route) => routeJson(route, { collections: [] }));
  await context.route("**/api/library/queue", async (route) => {
    if (route.request().method() === "POST") {
      const { trackId } = route.request().postDataJSON();
      const id = `saved-${++queueSequence}`;
      savedQueue.push({ id, position: savedQueue.length, track: library.find((item) => item.id === trackId) });
      return routeJson(route, { queue: savedQueue, addedQueueItemId: id }, 201);
    }
    if (route.request().method() === "DELETE") {
      if (failNextQueueClear) {
        failNextQueueClear = false;
        return routeJson(route, { error: "synthetic queue clear failure" }, 503);
      }
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
  await context.route("**/api/library/queue/*", async (route) => {
    if (route.request().method() === "PATCH") {
      if (failNextQueueMove) {
        failNextQueueMove = false;
        return routeJson(route, { error: "synthetic queue reorder failure" }, 503);
      }
      const { position, sessionId: requestedSessionId } = route.request().postDataJSON();
      assert.equal(requestedSessionId, sessionId, "queue moves identify the active listening session");
      const id = new URL(route.request().url()).pathname.split("/").at(-1);
      const from = savedQueue.findIndex((item) => item.id === id);
      assert.notEqual(from, -1, "the moved saved row exists");
      const target = Math.min(Math.max(position, 0), savedQueue.length - 1);
      savedQueue.splice(target, 0, savedQueue.splice(from, 1)[0]);
      savedQueue.forEach((item, index) => { item.position = index; });

      const rank = new Map(savedQueue.map((item, index) => [item.id, index]));
      const linked = session.tracks
        .filter((item) => item.queueItemId !== null && rank.has(item.queueItemId))
        .sort((a, b) => rank.get(a.queueItemId) - rank.get(b.queueItemId));
      const positions = session.tracks
        .map((item, index) => item.queueItemId !== null && rank.has(item.queueItemId) ? index : -1)
        .filter((index) => index >= 0);
      const before = session.tracks.map((item) => item.id);
      const reordered = [...session.tracks];
      positions.forEach((slot, index) => { reordered[slot] = linked[index]; });
      session.tracks = reordered;
      session.tracks.forEach((item, index) => { item.position = index; });
      const changed = session.tracks.some((item, index) => item.id !== before[index]);
      return routeJson(route, { queue: savedQueue, affectedSessionIds: changed ? [sessionId] : [] });
    }
    if (route.request().method() !== "DELETE") return route.continue();
    if (failNextQueueDelete) {
      failNextQueueDelete = false;
      return routeJson(route, { error: "synthetic queue deletion failure" }, 503);
    }
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
  await context.route("**/api/library/sessions", async (route) => {
    if (route.request().method() === "POST") {
      session.tracks = [];
      session.currentSessionTrackId = null;
      return routeJson(route, { session: { id: sessionId } });
    }
    return routeJson(route, { sessions: [] });
  });
  await context.route(`**/api/library/sessions/${sessionId}**`, async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (request.method() === "PATCH" && url.pathname.endsWith("/tracks")) {
      const { sessionTrackId, position } = request.postDataJSON();
      const from = session.tracks.findIndex((item) => item.id === sessionTrackId);
      assert.notEqual(from, -1, "the moved session row exists, including playlist-only rows");
      const target = Math.min(Math.max(Math.trunc(position), 0), session.tracks.length - 1);
      session.tracks.splice(target, 0, session.tracks.splice(from, 1)[0]);
      session.tracks.forEach((item, index) => { item.position = index; });
    } else if (request.method() === "POST" && url.pathname.endsWith("/tracks")) {
      const { trackId, position, queueItemId } = request.postDataJSON();
      const track = library.find((item) => item.id === trackId);
      assert.ok(track, `known fixture track ${trackId}`);
      session.tracks.push({
        id: `session-track-${++sessionTrackSequence}`, position,
        queueItemId: queueItemId ?? null,
        track: { id: track.id, title: track.title, artist: track.artist, durationSeconds: track.durationSeconds },
        sourceAssetId: `source-${track.id}`,
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
  let expectedStudioEntryIds = null;
  let preparedFullSourceSessionTrackIds = [];
  await context.route("**/api/stems/passthrough", async (route) => {
    assert.equal(route.request().method(), "POST", "full-source Studio entries create an explicit passthrough bridge");
    const { sourceAssetId: requestedSourceAssetId } = route.request().postDataJSON();
    const item = session.tracks.find((entry) => entry.sourceAssetId === requestedSourceAssetId);
    assert.ok(item, "the passthrough request belongs to a session entry with an original source");
    assert.equal(item.stems.length, 0, "a source-only entry is bridged only when the user selected it");
    const stem = { id: `passthrough-${item.id}`, stemType: "source", engine: "passthrough-unseparated" };
    item.stems = [stem];
    preparedFullSourceSessionTrackIds.push(item.id);
    return routeJson(route, { stem }, 201);
  });
  await context.route(`**/api/library/sessions/${sessionId}/studio-handoff`, async (route) => {
    assert.equal(route.request().method(), "POST", "the session handoff is explicitly requested");
    const body = route.request().postDataJSON();
    assert(expectedStudioEntryIds?.length, "the session fixture must contain selected entries");
    assert.deepEqual(body.sessionTrackIds, expectedStudioEntryIds, "Studio receives every selected session entry and no others");
    return routeJson(route, {
      handoff: { projectId: "derived-studio-project", remixTrackCount: body.sessionTrackIds.length, refused: [] },
    }, 201);
  });

  await page.goto("http://localhost:80/waveyard");
  await page.locator('[data-testid="button-play-550e8400-e29b-41d4-a716-446655440001"]').waitFor();
  failNextPlaylistCreate = true;
  await page.getByLabel("New playlist name").fill("Rejected playlist");
  await page.getByRole("region", { name: "Playlists" }).getByRole("button", { name: "Create", exact: true }).click();
  await page.getByTestId("playlist-mutation-error").getByText("Could not create the playlist", { exact: false }).waitFor();
  await page.getByRole("region", { name: "Playlists" }).getByRole("button", { name: "Create", exact: true }).click();
  await page.getByTestId("playlist-row-created-playlist").waitFor();
  await page.getByText("Empty playlist.", { exact: true }).waitFor();
  assert.equal(await page.getByTestId("playlist-mutation-error").count(), 0, "a successful create clears the prior failure and opens the new playlist");
  failNextPlaylistAdd = true;
  await page.getByLabel("Add Queue fixture 1 to a playlist").selectOption("test-set");
  await page.getByTestId("library-action-message").getByText("Could not add Queue fixture 1 to the playlist", { exact: false }).waitFor();
  assert.equal(playlistDetail.items.length, 2, "a rejected playlist add leaves the playlist unchanged");
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

  failNextQueueDelete = true;
  await page.getByRole("button", { name: "Remove Queue fixture 2 from queue" }).click();
  await page.getByTestId("queue-mutation-error").getByText("Could not remove this track from the saved queue", { exact: false }).waitFor();
  assert.equal(savedQueue.length, 3, "a rejected queue deletion leaves the saved queue unchanged");
  assert.equal(session.tracks.length, 3, "a rejected queue deletion leaves the listening order unchanged");
  failNextQueueMove = true;
  await page.getByRole("button", { name: "Move Queue fixture 2 up from position 2" }).click();
  await page.getByTestId("queue-mutation-error").getByText("Could not update the saved queue order", { exact: false }).waitFor();
  assert.deepEqual(savedQueue.map((item) => item.track.id), [ids[0], ids[1], ids[0]], "a rejected reorder retains the previous queue order");
  failNextQueueClear = true;
  await page.getByRole("button", { name: "Clear", exact: true }).click();
  await page.getByTestId("queue-mutation-error").getByText("Could not clear the saved queue", { exact: false }).waitFor();
  assert.equal(savedQueue.length, 3, "a rejected queue clear retains every saved row");
  assert.equal(session.tracks.length, 3, "a rejected queue clear retains every linked session entry");

  await page.locator("#sess-fade").focus();
  await page.keyboard.press("End");
  assert.equal(await page.locator("#sess-fade").inputValue(), "15", "the long fade leaves time to remove its target");
  await page.waitForFunction(() => {
    const audio = document.querySelector('.sess-deck[data-role="current"] audio');
    return audio instanceof HTMLAudioElement && !audio.paused && audio.currentTime > 0.25;
  });
  const currentAudioTimeBeforeTargetRemoval = await page.locator('.sess-deck[data-role="current"] audio').evaluate((audio) => audio.currentTime);
  const currentSessionTrackIdBeforeTargetRemoval = session.currentSessionTrackId;
  await page.getByTestId("session-transition").click();
  await page.locator(".wy-now .eyebrow").filter({ hasText: "Mixing" }).waitFor();
  await page.getByRole("button", { name: "Remove Queue fixture 2 from queue" }).click();
  await waitForFixture(
    () => session.tracks.length === 2 && savedQueue.length === 2 && session.currentSessionTrackId === currentSessionTrackIdBeforeTargetRemoval,
    "removing the pending mix target",
  );
  await page.getByTestId("queue-mutation-error").waitFor({ state: "detached" });
  await page.getByTestId("session-transition").waitFor();
  await page.getByRole("button", { name: "Pause", exact: true }).waitFor();
  await page.waitForFunction((before) => {
    const current = document.querySelector('.sess-deck[data-role="current"] audio');
    const next = document.querySelector('.sess-deck[data-role="next"] audio');
    return current instanceof HTMLAudioElement
      && !current.paused
      && current.currentTime >= before
      && current.volume > 0.9
      && (next === null || (next instanceof HTMLAudioElement && next.paused));
  }, currentAudioTimeBeforeTargetRemoval);
  assert.deepEqual(session.tracks.map((item) => item.track.id), [ids[0], ids[0]], "removing the target leaves both duplicate current-song entries");
  assert.equal(session.tracks[0].id, currentSessionTrackIdBeforeTargetRemoval, "the retained current entry stays selected");
  assert.equal(session.tracks[0].queueItemId, savedQueue[0].id, "the current queue row remains linked to its original session entry");
  assert.match(await page.locator(".wy-now .eyebrow").innerText(), /^Playing/i, "the current deck continues after the mix target is removed");
  assert.equal(session.currentSessionTrackId, "session-track-1", "removing a pending target does not interrupt the current song");

  await page.getByRole("button", { name: "Test playlist" }).click();
  failNextPlaylistMove = true;
  await page.locator(".playlist-items li").nth(1).getByRole("button", { name: "Move up" }).click();
  await page.getByTestId("playlist-mutation-error").getByText("Could not update the playlist order", { exact: false }).waitFor();
  assert.deepEqual(playlistDetail.items.map((item) => item.track.id), [ids[1], ids[2]], "a rejected playlist reorder keeps the playlist unchanged");
  failNextPlaylistRemove = true;
  await page.locator(".playlist-items li").first().getByRole("button", { name: "Remove Queue fixture 2", exact: true }).click();
  await page.getByTestId("playlist-mutation-error").getByText("Could not remove that track from the playlist", { exact: false }).waitFor();
  assert.equal(playlistDetail.items.length, 2, "a rejected playlist removal keeps both playlist entries");
  await page.getByTestId("playlist-live-test-set").click();
  await waitForFixture(() => session.tracks.length === 4, "the ordered playlist additions");
  assert.deepEqual(session.tracks.map((item) => item.track.id), [ids[0], ids[0], ids[1], ids[2]], "playlist songs append without saved-queue links");
  assert.equal(session.currentSessionTrackId, "session-track-1", "appending the playlist leaves the current song playing");
  assert.equal(savedQueue.length, 2, "playlist-only songs do not create saved-queue rows");
  assert.equal(session.tracks[2].queueItemId, null, "directly appended session songs have no saved-queue link");

  const movedQueueId = savedQueue[1].id;
  const directSessionTrackIds = session.tracks.filter((item) => item.queueItemId === null).map((item) => item.id);
  const currentSessionTrackId = session.currentSessionTrackId;
  const currentPositionSeconds = session.positionSeconds;
  await page.getByRole("button", { name: "Move Queue fixture 1 up from position 2" }).click();
  await waitForFixture(
    () => savedQueue[0].id === movedQueueId && session.tracks[0].queueItemId === movedQueueId,
    "the moved saved row and its exact linked session entry",
  );
  await page.getByRole("button", { name: "Move Queue fixture 1 down from position 1" }).waitFor();
  assert.deepEqual(session.tracks.map((item) => item.queueItemId), [movedQueueId, savedQueue[1].id, null, null]);
  assert.deepEqual(
    session.tracks.filter((item) => item.queueItemId === null).map((item) => item.id),
    directSessionTrackIds,
    "direct playlist additions keep their rows and order when saved queue rows move",
  );
  assert.equal(session.currentSessionTrackId, currentSessionTrackId, "reordering does not interrupt the current song");
  assert.equal(session.positionSeconds, currentPositionSeconds, "reordering does not reset playback position");

  const currentQueueItemId = session.tracks.find((item) => item.id === session.currentSessionTrackId)?.queueItemId;
  const currentQueueIndex = savedQueue.findIndex((item) => item.id === currentQueueItemId);
  assert.notEqual(currentQueueIndex, -1, "the playing session row is linked to a saved queue item");
  await page.waitForFunction(() => {
    const current = document.querySelector('.sess-deck[data-role="current"] audio');
    return current instanceof HTMLAudioElement && !current.paused;
  });
  await page.locator(".queue-panel .queue-list li").nth(currentQueueIndex)
    .getByRole("button", { name: "Remove Queue fixture 1 from queue" }).click();
  await waitForFixture(
    () => session.tracks.length === 3 && savedQueue.length === 1 && session.currentSessionTrackId === "session-track-4",
    "playback selecting a remaining entry after its current linked row is removed",
  );
  assert.deepEqual(session.tracks.map((item) => item.track.id), [ids[0], ids[1], ids[2]]);
  assert.equal(session.tracks[0].queueItemId, savedQueue[0].id, "the duplicate saved song remains linked to its own session row");
  assert.deepEqual(
    session.tracks.filter((item) => item.queueItemId === null).map((item) => item.id),
    directSessionTrackIds,
    "removing the current saved row leaves playlist-only rows untouched",
  );
  assert.ok(session.tracks.some((item) => item.id === session.currentSessionTrackId), "the new current pointer resolves to a remaining session entry");
  assert.equal(session.tracks.find((item) => item.id === session.currentSessionTrackId)?.track.id, ids[1]);
  await page.waitForFunction(() => {
    const current = document.querySelector('.sess-deck[data-role="current"] audio');
    const state = document.querySelector(".wy-now .eyebrow")?.textContent ?? "";
    const title = document.querySelector(".wy-now b")?.textContent ?? "";
    return current instanceof HTMLAudioElement
      && !current.paused
      && title === "Queue fixture 2"
      && /^playing/i.test(state);
  }, undefined, { timeout: 5000 });

  await queueTrack("Queue fixture 2");
  await waitForFixture(() => session.tracks.length === 4 && savedQueue.length === 2, "a distinct queue item for cross-tab reorder");
  const secondPage = await context.newPage();
  await secondPage.goto("http://localhost:80/waveyard");
  await secondPage.getByTestId("listening-workspace").waitFor();
  await secondPage.waitForFunction(
    () => document.querySelectorAll(".sess-queue-list .sess-queue-item").length === 4,
    undefined,
    { timeout: 8000 },
  );
  await page.locator(".wy-drawer > summary").filter({ hasText: "Session order" }).click();
  await secondPage.locator(".wy-drawer > summary").filter({ hasText: "Session order" }).click();

  const readQueueOrder = async (view) =>
    (await view.locator(".queue-list > li > a").allTextContents()).map((title) => title.trim());
  const readSessionOrder = async (view) =>
    view.locator(".sess-queue-item .sess-queue-jump > span:nth-child(2)").evaluateAll((elements) =>
      elements.map((element) => element.childNodes[0]?.textContent?.trim() ?? ""),
    );
  const waitForViewOrder = async (view, expectedQueue, expectedSession, description) => {
    const until = Date.now() + 8000;
    let actualQueue = [];
    let actualSession = [];
    do {
      actualQueue = await readQueueOrder(view);
      actualSession = await readSessionOrder(view);
      if (
        JSON.stringify(actualQueue) === JSON.stringify(expectedQueue)
        && JSON.stringify(actualSession) === JSON.stringify(expectedSession)
      ) return;
      await new Promise((resolve) => setTimeout(resolve, 40));
    } while (Date.now() < until);
    assert.deepEqual({ queue: actualQueue, session: actualSession }, {
      queue: expectedQueue,
      session: expectedSession,
    }, description);
  };

  const initialQueueOrder = ["Queue fixture 1", "Queue fixture 2"];
  const initialSessionOrder = ["Queue fixture 1", "Queue fixture 2", "Queue fixture 3", "Queue fixture 2"];
  assert.deepEqual(await readQueueOrder(page), initialQueueOrder, "the first Waveyard view starts with the fixture queue");
  assert.deepEqual(await readQueueOrder(secondPage), initialQueueOrder, "both tabs start with the same saved queue");
  assert.deepEqual(await readSessionOrder(page), initialSessionOrder, "the first view starts with the shared session order");
  assert.deepEqual(await readSessionOrder(secondPage), initialSessionOrder, "both tabs start with the same linked-session order");
  assert.equal(session.currentSessionTrackId, "session-track-4", "both views retain the same playing direct playlist entry");
  await page.waitForFunction(() => {
    const current = document.querySelector('.sess-deck[data-role="current"] audio');
    return current instanceof HTMLAudioElement && !current.paused;
  });
  await secondPage.waitForFunction(() => {
    const current = document.querySelector('.sess-deck[data-role="current"] audio');
    return current instanceof HTMLAudioElement && current.readyState >= 1;
  });
  const currentTimeBeforeTabMove = await page.locator('.sess-deck[data-role="current"] audio').evaluate((audio) => audio.currentTime);
  const secondTabTimeBeforeMove = await secondPage.locator('.sess-deck[data-role="current"] audio').evaluate((audio) => audio.currentTime);
  const currentTrackBeforeTabMove = session.currentSessionTrackId;
  const savedPositionBeforeTabMove = session.positionSeconds;

  await page.getByRole("button", { name: "Move Queue fixture 2 up from position 2" }).click();
  await waitForFixture(
    () => savedQueue[0].track.id === ids[1] && session.tracks[0]?.queueItemId === savedQueue[0].id,
    "the moved queue item and linked-session row",
  );
  const reorderedQueueOrder = ["Queue fixture 2", "Queue fixture 1"];
  const reorderedSessionOrder = ["Queue fixture 2", "Queue fixture 2", "Queue fixture 3", "Queue fixture 1"];
  await waitForViewOrder(page, reorderedQueueOrder, reorderedSessionOrder, "the initiating tab shows the committed queue and session order");
  await waitForViewOrder(secondPage, reorderedQueueOrder, reorderedSessionOrder, "the other tab refreshes to the committed queue and session order");
  assert.equal(session.currentSessionTrackId, currentTrackBeforeTabMove, "queue reorder does not change the playing session track");
  assert.ok(session.positionSeconds >= savedPositionBeforeTabMove, "queue reorder does not reset the saved playback position while playback advances");
  assert.equal(await page.locator(".wy-now b").innerText(), "Queue fixture 2", "the initiating tab keeps its current track");
  assert.equal(await secondPage.locator(".wy-now b").innerText(), "Queue fixture 2", "the second tab keeps the same current track");
  const currentTimeAfterTabMove = await page.locator('.sess-deck[data-role="current"] audio').evaluate((audio) => audio.currentTime);
  const secondTabTimeAfterMove = await secondPage.locator('.sess-deck[data-role="current"] audio').evaluate((audio) => audio.currentTime);
  assert.ok(currentTimeAfterTabMove >= currentTimeBeforeTabMove - 0.1, "the playing tab is not rewound by a queue move");
  assert.ok(secondTabTimeAfterMove >= secondTabTimeBeforeMove - 0.1, "the other tab is not rewound by the queue refresh");

  await page.getByRole("button", { name: "Clear", exact: true }).click();
  await waitForFixture(() => session.tracks.length === 2 && savedQueue.length === 0, "clearing linked saved rows");
  assert.deepEqual(session.tracks.map((item) => item.track.id), [ids[1], ids[2]], "clearing the saved queue leaves direct playlist songs in the session");
  assert.equal(session.currentSessionTrackId, "session-track-4", "clearing a later queue row keeps the current direct playlist entry");

  await queueTrack("Queue fixture 1");
  await waitForFixture(() => session.tracks.length === 3 && savedQueue.length === 1, "a queue item after clearing");
  const autoCrossfade = page.getByTestId("session-auto-crossfade");
  assert.equal(await autoCrossfade.isChecked(), false, "auto-crossfade stays opt-in");
  await page.getByTestId("session-transition").click();
  await page.getByRole("button", { name: "Finish", exact: true }).click();
  await waitForFixture(() => session.currentSessionTrackId === "session-track-5", "the existing manual mix control");
  await autoCrossfade.check();
  await waitForFixture(() => session.currentSessionTrackId === "session-track-7", "automatic handoff at the selected fade length", 18000);
  const directEntryToMove = session.tracks.find((item) => item.queueItemId === null && item.track.id === ids[2]);
  const otherDirectEntry = session.tracks.find((item) => item.queueItemId === null && item.track.id === ids[1]);
  assert.ok(directEntryToMove && otherDirectEntry, "the session has two independent playlist-only entries");
  assert(
    session.tracks.findIndex((item) => item.id === directEntryToMove.id)
      > session.tracks.findIndex((item) => item.id === otherDirectEntry.id),
    "the playlist-only fixture starts in a known order",
  );
  const currentTrackBeforeDirectReorder = session.currentSessionTrackId;
  const currentAudioTimeBeforeDirectReorder = await page
    .locator('.sess-deck[data-role="current"] audio')
    .evaluate((audio) => audio.currentTime);
  await page.getByRole("button", { name: "Move Queue fixture 3 earlier" }).click();
  await waitForFixture(
    () => session.tracks.findIndex((item) => item.id === directEntryToMove.id)
      < session.tracks.findIndex((item) => item.id === otherDirectEntry.id),
    "the playlist-only entry moves ahead of the other direct entry",
  );
  const directReorderedSessionOrder = session.tracks.map((item) => item.track.title);
  const directReorderQueueOrder = savedQueue.map((item) => item.track.title);
  await waitForViewOrder(page, directReorderQueueOrder, directReorderedSessionOrder, "the initiating tab shows the direct playlist reorder");
  await waitForViewOrder(secondPage, directReorderQueueOrder, directReorderedSessionOrder, "the other tab receives the direct playlist reorder");
  assert.equal(session.currentSessionTrackId, currentTrackBeforeDirectReorder, "moving a playlist-only entry does not change the playing track");
  const currentAudioTimeAfterDirectReorder = await page
    .locator('.sess-deck[data-role="current"] audio')
    .evaluate((audio) => audio.currentTime);
  assert.ok(currentAudioTimeAfterDirectReorder >= currentAudioTimeBeforeDirectReorder - 0.1, "moving a playlist-only entry does not rewind playback");
  // Model the full-source bridge as available before testing Studio handoff.
  // Queue entries remain source-only during the playback/removal assertions.
  session.tracks.forEach((item) => {
    item.stems = [{ id: `passthrough-${item.id}`, stemType: "other", engine: "passthrough-unseparated" }];
  });
  const sourceOnlyEntry = session.tracks.find((entry) => entry.id !== session.currentSessionTrackId);
  assert.ok(sourceOnlyEntry, "the session fixture must contain a non-current entry");
  const currentEntry = session.tracks.find((entry) => entry.id === session.currentSessionTrackId);
  const notStartedEntry = session.tracks.find((entry) => (
    entry.id !== session.currentSessionTrackId && entry.id !== sourceOnlyEntry.id
  ));
  assert.ok(currentEntry && notStartedEntry, "the fixture has a current entry and a separate not-started entry");
  sourceOnlyEntry.stems = [];
  sourceOnlyEntry.playback = { assetIds: [sourceId], kind: "source" };
  library.find((track) => track.id === sourceOnlyEntry.track.id).stemAvailability = {
    status: "failed", reason: "Stem separation failed.", retryJobId: "failed-separation-job",
  };
  notStartedEntry.stems = [];
  notStartedEntry.playback = { assetIds: [sourceId], kind: "source" };
  library.find((track) => track.id === notStartedEntry.track.id).stemAvailability = {
    status: "not-started", reason: "Stem separation has not started.",
  };
  await page.reload();
  assert.equal(await page.getByTestId("session-auto-crossfade").isChecked(), true, "the auto-crossfade preference survives reload");
  const selectedStudioEntries = [sourceOnlyEntry, currentEntry];
  assert.equal(selectedStudioEntries.length, 2, "the session fixture must contain two selectable entries");
  await page.getByRole("button", { name: "Clear selection" }).click();
  const notStartedIndex = session.tracks.findIndex((entry) => entry.id === notStartedEntry.id);
  const notStartedCheckbox = page.getByLabel(
    `Include session entry ${notStartedIndex + 1}, ${notStartedEntry.track.title} by ${notStartedEntry.track.artist}, in Studio`,
  );
  assert.equal(await notStartedCheckbox.isDisabled(), true, "full-source handoff is not offered before separation has started");
  assert(
    (await page.locator(`#studio-readiness-${notStartedEntry.id}`).innerText()).includes("Separation not started"),
    "the disabled source-only track explains how to become eligible",
  );
  for (const entry of selectedStudioEntries) {
    const index = session.tracks.findIndex((item) => item.id === entry.id);
    await page.getByLabel(
      `Include session entry ${index + 1}, ${entry.track.title} by ${entry.track.artist}, in Studio`,
    ).check();
  }
  assert(
    (await page.locator(`#studio-readiness-${sourceOnlyEntry.id}`).innerText()).includes("full source available"),
    "the failed-separation source-only choice is labeled before it is sent",
  );
  expectedStudioEntryIds = selectedStudioEntries.map((entry) => entry.id);
  assert.equal(
    await page.getByTestId("studio-track-selection-count").innerText(),
    `2 selected of ${session.tracks.length - 1} selectable tracks`,
    "the UI selection count excludes the not-started source-only entry",
  );
  const currentEntryBeforeStudioHandoff = session.currentSessionTrackId;
  const positionBeforeStudioHandoff = session.positionSeconds;
  await page.getByTestId("session-handoff").click();
  const studioLink = page.getByRole("link", { name: "Open in Studio" });
  await studioLink.waitFor();
  assert.deepEqual(preparedFullSourceSessionTrackIds, [sourceOnlyEntry.id], "only the explicitly selected source-only entry gets a passthrough bridge");
  assert.equal(session.currentSessionTrackId, currentEntryBeforeStudioHandoff, "preparing a source-only Studio entry does not change the playing session entry");
  assert.equal(session.positionSeconds, positionBeforeStudioHandoff, "preparing a source-only Studio entry does not reset session position");
  await page.getByText(/selected entry uses full-source audio, not separated/).waitFor();
  assert(
    (await page.locator(".sess-handoff").innerText()).includes("1 full-source session entry (not separated)"),
    "the Studio result identifies the unseparated source entry",
  );
  assert.equal(
    await studioLink.getAttribute("href"),
    "/waveyard/projects/derived-studio-project?view=studio",
    "a listening-session handoff opens its derived project directly in Studio",
  );
  await context.route("**/api/waveyard/projects/derived-studio-project", async (route) => routeJson(route, {
    project: { title: "Session handoff", description: "Derived from a listening session", licenseCode: "private", visibility: "private", publicationStatus: "draft", moderationStatus: "pending" },
    role: "owner",
    build: null,
    sources: [],
    studioSources: [
      { id: "linked-source-a", originalFilename: "Session track A", durationSeconds: 12, sampleRate: 44100, channels: 2, codec: "pcm_s16le", mimeType: "audio/wav", fileSizeBytes: 1000, checksumSha256: "source-checksum-a", linkedFromLibrary: true },
      { id: "linked-source-b", originalFilename: "Session track B", durationSeconds: 12, sampleRate: 44100, channels: 2, codec: "pcm_s16le", mimeType: "audio/wav", fileSizeBytes: 1000, checksumSha256: "source-checksum-b", linkedFromLibrary: true },
    ],
    stems: [
      { id: "linked-stem-a", sourceAssetId: "linked-source-a", stemType: "drums", engine: "test", model: "test", modelVersion: "1", durationSeconds: 12, sampleRate: 44100, channels: 2, codec: "pcm_s16le", format: "wav", fileSizeBytes: 1000, checksumSha256: "stem-checksum-a" },
      { id: "linked-stem-b", sourceAssetId: "linked-source-b", stemType: "vocals", engine: "test", model: "test", modelVersion: "1", durationSeconds: 12, sampleRate: 44100, channels: 2, codec: "pcm_s16le", format: "wav", fileSizeBytes: 1000, checksumSha256: "stem-checksum-b" },
    ],
    waveforms: [],
    waveformJobs: [],
    jobs: [],
  }));
  await context.route("**/api/waveyard/projects/derived-studio-project/remixes", async (route) => routeJson(route, {
    remixes: [{ id: "derived-studio-remix" }],
  }));
  let persistedStudioRemix = {
    remix: { id: "derived-studio-remix", name: "Session handoff", masterVolume: 1, masterInserts: "[]", loopStartMs: 0, loopEndMs: null, tempoBpm: 120, timeSignatureNumerator: 4, timeSignatureDenominator: 4, gridDivision: "beat", snapEnabled: true, targetKey: null, version: 1 },
    tracks: [
      { id: "derived-remix-track-a", stemAssetId: "linked-stem-a", name: "Session track A — drums", sortOrder: 0, volume: 1, pan: 0, muted: false, solo: false, inserts: [], phaseInverted: false, clips: [{ id: "handoff-clip-a", timelineStartMs: 0, sourceOffsetMs: 0, durationMs: 12000, gain: 1 }] },
      { id: "derived-remix-track-b", stemAssetId: "linked-stem-b", name: "Session track B — vocals", sortOrder: 1, volume: 1, pan: 0, muted: false, solo: false, inserts: [], phaseInverted: false, clips: [{ id: "handoff-clip-b", timelineStartMs: 12000, sourceOffsetMs: 0, durationMs: 12000, gain: 1 }] },
    ],
    automation: [],
    stems: [
      { id: "linked-stem-a", sourceAssetId: "linked-source-a", stemType: "drums", durationSeconds: 12, sampleRate: 44100, channels: 2, codec: "pcm_s16le", format: "wav", fileSizeBytes: 1000, checksumSha256: "stem-checksum-a" },
      { id: "linked-stem-b", sourceAssetId: "linked-source-b", stemType: "vocals", durationSeconds: 12, sampleRate: 44100, channels: 2, codec: "pcm_s16le", format: "wav", fileSizeBytes: 1000, checksumSha256: "stem-checksum-b" },
    ],
  };
  await context.route("**/api/remixes/derived-studio-remix", async (route) => {
    if (route.request().method() === "PUT") {
      const state = route.request().postDataJSON();
      const { tracks, automation, ...remixFields } = state;
      persistedStudioRemix = {
        ...persistedStudioRemix,
        remix: { ...persistedStudioRemix.remix, ...remixFields },
        tracks: Array.isArray(tracks) ? tracks : persistedStudioRemix.tracks,
        automation: Array.isArray(automation) ? automation : persistedStudioRemix.automation,
      };
    }
    return routeJson(route, persistedStudioRemix);
  });
  await context.route("**/api/remixes/derived-studio-remix/versions", async (route) => routeJson(route, { versions: [] }));
  await studioLink.click();
  await page.getByRole("heading", { name: "Mixer console" }).waitFor();
  await page.waitForFunction(() => {
    const editor = document.getElementById("studio-editor");
    if (!editor) return false;
    const { top } = editor.getBoundingClientRect();
    return top >= 0 && top < window.innerHeight;
  }, null, { timeout: 8000 });
  assert.equal(
    await page.getByTestId("waveyard-mode-studio").getAttribute("aria-selected"),
    "true",
    "the handoff scrolls to the mixer with linked session stems mounted",
  );
  await page.waitForFunction(() => {
    const timeline = document.getElementById("remix-timeline");
    if (!timeline) return false;
    const { top } = timeline.getBoundingClientRect();
    return top >= 0 && top < window.innerHeight;
  }, null, { timeout: 8000 });
  await page.getByLabel("Session track A — drums arrangement volume").waitFor();
  await page.getByLabel("Session track B — vocals arrangement volume").waitFor();
  const cleanupDisclosure = page.locator("details.studio-disclosure").filter({ hasText: "Audio cleanup" });
  assert.equal(await cleanupDisclosure.count(), 1, "advanced tools remain available in the Studio editor");
  assert.equal(await cleanupDisclosure.evaluate((element) => element.open), false, "audio cleanup starts collapsed");
  assert.equal(
    await page.getByRole("region", { name: "Audio cleanup" }).count(),
    0,
    "optional cleanup UI is not mounted in the initial edit workflow",
  );
  await cleanupDisclosure.locator("summary").click();
  await page.getByRole("region", { name: "Audio cleanup" }).waitFor();
  await cleanupDisclosure.locator("summary").click();
  await page.getByRole("region", { name: "Audio cleanup" }).waitFor({ state: "detached" });
  await page.getByLabel("Tempo BPM").fill("132");
  await page.getByRole("button", { name: "Save now" }).click();
  await waitForFixture(
    () => persistedStudioRemix.remix.tempoBpm === 132,
    "Studio save request",
  );
  await page.reload({ waitUntil: "networkidle" });
  await page.getByRole("heading", { name: "Mixer console" }).waitFor();
  await page.getByLabel("Session track A — drums arrangement volume").waitFor();
  await page.getByLabel("Session track B — vocals arrangement volume").waitFor();
  assert.equal(
    await page.getByLabel("Tempo BPM").inputValue(),
    "132",
    "a saved arrangement edit survives reopening its Studio project",
  );

  await page.goto("http://localhost:80/waveyard");
  await page.locator(`[data-testid="button-play-${ids[0]}"]`).waitFor();
  await page.getByLabel("Add Queue fixture 1 to a playlist").selectOption("test-set");
  await page.getByTestId("library-action-message").getByText("Queue fixture 1 added to Test playlist.", { exact: false }).waitFor();
  assert.equal(playlistDetail.items.length, 3, "a successful track-to-playlist action updates the persisted playlist fixture");
  failNextPlaylistRename = true;
  await page.getByRole("button", { name: "Rename playlist Test playlist" }).click();
  await page.getByLabel("New name for Test playlist").fill("Renamed playlist");
  await page.getByRole("button", { name: "Save name" }).click();
  await page.getByTestId("playlist-mutation-error").getByText("Could not rename this playlist", { exact: false }).waitFor();
  assert.equal(playlistDetail.name, "Test playlist", "a rejected rename leaves the playlist name unchanged");
  await page.getByRole("button", { name: "Save name" }).click();
  await page.getByTestId("playlist-row-test-set").getByText("Renamed playlist").waitFor();
  await page.getByRole("button", { name: "Delete playlist Renamed playlist" }).click();
  await page.getByText(/tracks stay in your library/).waitFor();
  await page.getByRole("button", { name: "Cancel delete Renamed playlist" }).click();
  assert.equal(playlistDeleteRequests, 0, "cancelling a playlist deletion does not call the API");
  failNextPlaylistDelete = true;
  await page.getByRole("button", { name: "Delete playlist Renamed playlist" }).click();
  await page.getByRole("button", { name: "Confirm delete Renamed playlist" }).click();
  await page.getByTestId("playlist-mutation-error").getByText("Could not delete this playlist", { exact: false }).waitFor();
  assert.equal(await page.getByTestId("playlist-row-test-set").count(), 1, "a rejected delete keeps the playlist visible");
  await page.getByRole("button", { name: "Confirm delete Renamed playlist" }).click();
  await page.getByTestId("playlist-row-test-set").waitFor({ state: "detached" });
  assert.equal(await page.locator(`[data-testid="button-play-${ids[0]}"]`).count(), 1, "deleting a playlist leaves its library tracks playable");
  console.log("PASS: queue and playlist edits report failures; deletion confirms consequences and preserves library tracks; live continuity, handoff, and Studio reopen survive");
} finally {
  await browser.close();
}
