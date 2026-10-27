// Isolated real-browser audio-graph regression. Session persistence is mocked;
// generated WAV bytes are decoded and played by the real application engine.
import assert from "node:assert/strict";
import { createRequire } from "node:module";
const require = createRequire(new URL("../artifacts/api-server/package.json", import.meta.url));
const { chromium } = require("playwright-core");
const sessionId = "00000000-0000-4000-8000-000000000007";
const types = ["vocals", "drums", "bass", "other"];
function wav(seconds, frequency) {
  const n = 22050 * seconds, data = Buffer.alloc(44 + n * 2);
  data.write("RIFF"); data.writeUInt32LE(data.length - 8, 4); data.write("WAVEfmt ", 8);
  data.writeUInt32LE(16, 16); data.writeUInt16LE(1, 20); data.writeUInt16LE(1, 22);
  data.writeUInt32LE(22050, 24); data.writeUInt32LE(44100, 28);
  data.writeUInt16LE(2, 32); data.writeUInt16LE(16, 34); data.write("data", 36);
  data.writeUInt32LE(n * 2, 40);
  for (let i = 0; i < n; i++) data.writeInt16LE(Math.round(2000 * Math.sin(i * frequency * Math.PI * 2 / 22050)), 44 + i * 2);
  return data;
}
const assets = new Map();
const tracks = ["a", "b", "c"].map((id, index) => {
  const duration = [20, 8, 12][index];
  const stems = types.map((stemType, i) => {
    const key = `${id}-${stemType}`;
    assets.set(key, wav(duration, 130 + index * 100 + i * 40));
    return { id: key, stemType, engine: "synthetic-test" };
  });
  return { id, position: index, track: { id, title: `Test ${id}`, artist: "Synthetic fixture", durationSeconds: duration },
    stems, playback: { kind: "stems", assetIds: stems.map(s => s.id) }, stemMix: {},
    transition: { mode: "manual", crossfadeSeconds: 2, keepStems: [] }, analysis: null };
});
const externalStemKeys = types.map(stem => {
  const key = `d-${stem}`;
  assets.set(key, wav(4, 530 + types.indexOf(stem) * 40));
  return { id: key, stemType: stem, engine: "synthetic-test" };
});
const libraryRows = tracks.map((item, index) => ({
  id: item.track.id, title: item.track.title, artist: "Synthetic fixture", album: "",
  durationSeconds: item.track.durationSeconds, playCount: 0, rating: 0, labels: [], lastPlayedAt: null,
  addedAt: new Date().toISOString(), stemAvailability: { status: "separated", stemCount: 4 },
  studioProjectId: `fixture-project-${index}`,
}));
let liveQueue = [];
const session = { id: sessionId, name: "Live layer regression", currentSessionTrackId: "a", positionSeconds: 0,
  tracks, swaps: [], createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
const browser = await chromium.launch({ executablePath: "/repl/tools/bin/chromium",
  args: ["--no-sandbox", "--autoplay-policy=no-user-gesture-required"] });
try {
  const page = await browser.newPage();
  page.on("pageerror", error => console.log("PAGE_ERROR", error.stack));
  await page.addInitScript(() => {
    window.audioProbe = { sources: [], buffers: [] };
    const Base = window.AudioContext;
    window.AudioContext = class extends Base {
      createGain() {
        const node = super.createGain(), connect = node.connect.bind(node);
        node.connect = (target, ...args) => { node.nextNode = target; return connect(target, ...args); };
        return node;
      }
      createMediaElementSource(media) {
        const node = super.createMediaElementSource(media), connect = node.connect.bind(node);
        node.connect = (target, ...args) => { node.inputNode = target; return connect(target, ...args); };
        window.audioProbe.sources.push(node); return node;
      }
      createBufferSource() {
        const node = super.createBufferSource(), start = node.start.bind(node), stop = node.stop.bind(node), connect = node.connect.bind(node);
        node.connect = (target, ...args) => { node.inputNode = target; return connect(target, ...args); };
        node.start = (when, offset, ...args) => { node.startedOffset = offset; return start(when, offset, ...args); };
        node.stop = (...args) => { node.stopCount = (node.stopCount ?? 0) + 1; return stop(...args); };
        window.audioProbe.buffers.push(node); return node;
      }
    };
  });
  let failAsset = null;
  await page.route("**/api/assets/*", async route => {
    const id = new URL(route.request().url()).pathname.split("/").at(-1);
    if (id === failAsset) return route.fulfill({ status: 503, body: "Test failure" });
    const body = assets.get(id);
    if (!body) return route.fulfill({ status: 404 });
    const range = route.request().headers().range?.match(/^bytes=(\d+)-(\d*)$/);
    const start = range ? Number(range[1]) : 0, end = range?.[2] ? Math.min(Number(range[2]), body.length - 1) : body.length - 1;
    return route.fulfill({
      status: range ? 206 : 200, contentType: "audio/wav", body: body.subarray(start, end + 1),
      headers: { "Accept-Ranges": "bytes", "Content-Length": String(end - start + 1),
        ...(range ? { "Content-Range": `bytes ${start}-${end}/${body.length}` } : {}) },
    });
  });
  await page.route("**/api/library/tracks", route => route.fulfill({ json: { tracks: [
    ...libraryRows, { id: "d", title: "Test D", artist: "Synthetic fixture", stemAvailability: { status: "separated" } },
  ] } }));
  await page.route("**/api/library/playlists", route => route.fulfill({ json: { playlists: [
    { id: "test-playlist", name: "Test order", trackCount: 2 },
  ] } }));
  await page.route("**/api/library/playlists/test-playlist", route => route.fulfill({ json: { playlist: {
    id: "test-playlist", name: "Test order",
    items: ["a", "b"].map((id, i) => ({ id: `playlist-${i}`, position: i, track: libraryRows.find(row => row.id === id) })),
  } } }));
  await page.route("**/api/library/queue", async route => {
    if (route.request().method() === "POST") {
      const { trackId } = route.request().postDataJSON();
      liveQueue.push({ id: `queue-${trackId}`, position: liveQueue.length, track: libraryRows.find(row => row.id === trackId) });
    } else if (route.request().method() === "DELETE") liveQueue = [];
    await route.fulfill({ json: { queue: liveQueue } });
  });
  await page.route("**/api/library/queue/*", route => {
    liveQueue = liveQueue.filter(item => item.id !== new URL(route.request().url()).pathname.split("/").at(-1));
    return route.fulfill({ json: { queue: liveQueue } });
  });
  await page.route("**/api/library/sessions", async route => {
    if (route.request().method() === "POST") {
      session.tracks = []; session.swaps = []; session.currentSessionTrackId = null; session.positionSeconds = 0;
      return route.fulfill({ json: { session: { id: sessionId } } });
    }
    return route.fulfill({ json: { sessions: [] } });
  });
  await page.route(`**/api/library/sessions/${sessionId}**`, async route => {
    const request = route.request(), url = new URL(request.url());
    const body = request.postDataJSON();
    if (url.pathname.endsWith("/swaps") && request.method() === "POST") {
      session.swaps = session.swaps.filter(s => !(s.sessionTrackId === body.sessionTrackId && s.stemType === body.stemType));
      session.swaps.push({ ...body, id: `swap-${body.stemType}`, fromTrackId: "a", createdAt: new Date().toISOString(),
        donorTrack: body.toTrackId === "d" ? { id: "d", title: "Test D", stems: externalStemKeys } : undefined });
    } else if (url.pathname.endsWith("/tracks") && request.method() === "POST") {
      const item = tracks.find(t => t.track.id === body.trackId);
      session.tracks.push({ ...item, id: `session-${session.tracks.length + 1}`, position: body.position });
    } else if (request.method() === "DELETE") {
      session.swaps = session.swaps.filter(s => s.id !== url.searchParams.get("swapId"));
    } else if (url.pathname.endsWith("/state") && body) Object.assign(session, body);
    else if (request.method() === "PATCH" && body) Object.assign(tracks.find(t => t.id === url.pathname.split("/").at(-1)), body);
    await route.fulfill({ json: { session } });
  });
  await page.goto("http://localhost:80/waveyard");
  await page.evaluate(() => localStorage.clear());
  await page.goto(`http://localhost:80/waveyard/session/${sessionId}`);
  await page.waitForFunction(() => [...document.querySelectorAll('[data-role="current"] audio')].length === 4 &&
    [...document.querySelectorAll('[data-role="current"] audio')].every(a => a.readyState === 4));
  const current = page.locator('[data-role="current"]');
  const toggle = async () => {
    const button = page.getByTestId("session-play");
    const before = await button.getAttribute("aria-pressed");
    await button.click();
    await page.waitForFunction((before) => document.querySelector('[data-testid="session-play"]').getAttribute("aria-pressed") !== before, before);
  };
  await toggle();
  await current.getByLabel("vocals source", { exact: true }).selectOption("b");
  await page.waitForFunction(() => window.audioProbe.buffers.length === 1);
  await page.waitForTimeout(250);
  await toggle();
  const seek = current.getByTestId("seek-deck-0");
  await seek.fill("6");
  await page.waitForTimeout(150);
  const paused = await current.locator("audio").evaluateAll(elements => elements.map(e => ({ time: e.currentTime, ready: e.readyState, duration: e.duration, paused: e.paused,
    seekable: Array.from({ length: e.seekable.length }, (_, i) => [e.seekable.start(i), e.seekable.end(i)]) })));
  console.log("PAUSED SEEK", JSON.stringify(paused));
  assert.ok(paused.every(e => Math.abs(e.time - 6) < 0.1), "recipient media must seek, not only the slider");
  await toggle();
  const offset = await page.evaluate(() => window.audioProbe.buffers.at(-1).startedOffset);
  assert.ok(Math.abs(offset - 6) < 0.1, `donor resumes from recipient seek, got ${offset}`);
  await current.getByLabel("vocals source", { exact: true }).selectOption("");
  await page.waitForTimeout(400);
  const originalGain = await page.evaluate(() => window.audioProbe.sources.find(s => s.mediaElement.src.endsWith("/a-vocals")).inputNode.gain.value);
  assert.equal(originalGain, 1);
  for (const type of types) {
    await current.getByLabel(`${type} source`, { exact: true }).selectOption("b");
    await page.waitForFunction(() => !document.querySelector('[aria-label="vocals source"]').disabled);
  }
  await page.waitForTimeout(300);
  await toggle();
  await seek.fill("11");
  await toggle();
  const offsets = await page.evaluate(() => window.audioProbe.buffers.slice(-4).map(b => b.startedOffset));
  assert.ok(offsets.every(t => Math.abs(t - 3) < 0.1), `all four donors must follow original clock modulo duration: ${offsets}`);
  const currentVocals = page.locator('[data-role="current"]').getByLabel("vocals source", { exact: true });
  await currentVocals.selectOption("d");
  await page.waitForFunction(() => window.audioProbe.buffers.length >= 7 &&
    [...document.querySelectorAll('[data-role="current"] audio')].every(a => a.currentTime > 10));
  assert.equal(session.swaps.find(s => s.stemType === "vocals").toTrackId, "d", "library donor is saved without being added to the session queue");
  const externalOffset = await page.evaluate(() => window.audioProbe.buffers.at(-1).startedOffset);
  assert.ok(Math.abs(externalOffset - 3) < 0.1, `external library donor follows recipient clock: ${externalOffset}`);
  failAsset = "c-bass";
  await current.getByLabel("bass source", { exact: true }).selectOption("c");
  await current.getByRole("alert").waitFor();
  assert.match(await current.getByRole("alert").textContent(), /previous layer was kept/);
  failAsset = null;
  await current.getByText("Retry live stems", { exact: true }).click();
  await page.waitForFunction(() => !document.querySelector('[data-role="current"] [role="alert"]'));
  await page.setViewportSize({ width: 390, height: 844 });
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), "mobile must not overflow");
  console.log("PASS: live swaps, seek/resume, failure/retry, mobile width");
  console.log("PASS: live swaps, seek/resume, failure/retry, mobile width");
} finally { await browser.close(); }
