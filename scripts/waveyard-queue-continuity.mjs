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
  await context.route("**/api/library/playlists", (route) => routeJson(route, {
    playlists: [{ id: "test-set", name: "Test playlist", trackCount: 2 }],
  }));
  await context.route("**/api/library/playlists/test-set", (route) => routeJson(route, {
    playlist: {
      id: "test-set", name: "Test playlist",
      items: [library[1], library[2]].map((track, position) => ({ id: `playlist-item-${position}`, position, track })),
    },
  }));
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
  await context.route(`**/api/library/sessions/${sessionId}/studio-handoff`, async (route) => {
    assert.equal(route.request().method(), "POST", "the session handoff is explicitly requested");
    return routeJson(route, {
      handoff: { projectId: "derived-studio-project", remixTrackCount: 3, refused: [] },
    }, 201);
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
    return current instanceof HTMLAudioElement
      && !current.paused
      && /^playing/i.test(state);
  }, undefined, { timeout: 5000 });
  assert.match(await page.locator(".wy-now .eyebrow").innerText(), /^Playing/i, "playback resumes on a valid remaining entry");

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
  assert.equal(session.positionSeconds, savedPositionBeforeTabMove, "queue reorder does not change the saved playback position");
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
  await page.reload();
  assert.equal(await page.getByTestId("session-auto-crossfade").isChecked(), true, "the auto-crossfade preference survives reload");
  await page.getByTestId("session-handoff").click();
  const studioLink = page.getByRole("link", { name: "Open in Studio" });
  await studioLink.waitFor();
  assert.equal(
    await studioLink.getAttribute("href"),
    "/waveyard/projects/derived-studio-project",
    "a listening-session handoff opens its derived project, not the upload form",
  );
  console.log("PASS: queue edits converge across tabs without rewinding playback; removals preserve valid session entries and fade behavior");
} finally {
  await browser.close();
}
