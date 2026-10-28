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
assets.set("a-source", wav(20, 130));
const tracks = ["a", "b", "c"].map((id, index) => {
  const duration = [20, 8, 12][index];
  const stems = types.map((stemType, i) => {
    const key = `${id}-${stemType}`;
    assets.set(key, wav(duration, 130 + index * 100 + i * 40));
    return { id: key, stemType, engine: "synthetic-test" };
  });
  return { id, position: index, sourceAssetId: id === "a" ? "a-source" : null,
    track: { id, title: `Test ${id}`, artist: "Synthetic fixture", durationSeconds: duration },
    stems, playback: { kind: "stems", assetIds: stems.map(s => s.id) }, stemMix: {},
    transition: { mode: "manual", crossfadeSeconds: 2, keepStems: [] },
    analysis: { bpm: 120, musicalKey: ["A minor", "C major", "C# major"][index], beatGridMs: null } };
});
const sourceOnlyTrack = { ...tracks[0], stems: [], playback: { kind: "source", assetIds: ["a-source"] } };
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
let exposeSeparatedSource = false;
let heldAssetId = null;
let heldAssetGate = null;
let signalHeldAssetRequest = null;
const session = { id: sessionId, name: "Live layer regression", currentSessionTrackId: "a", positionSeconds: 0,
  tracks, swaps: [], createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
const browser = await chromium.launch({ executablePath: "/repl/tools/bin/chromium",
  args: ["--no-sandbox", "--autoplay-policy=no-user-gesture-required"] });
try {
  const context = await browser.newContext();
  let page = await context.newPage();
  page.on("pageerror", error => console.log("PAGE_ERROR", error.stack));
  await context.addInitScript(() => {
    window.audioProbe = { sources: [], buffers: [], masterGains: [] };
    const Base = window.AudioContext;
    window.AudioContext = class extends Base {
      constructor(...args) {
        super(...args);
        this.probeFirstGain = true;
      }
      createGain() {
        const node = super.createGain(), connect = node.connect.bind(node);
        node.connect = (target, ...args) => { node.nextNode = target; return connect(target, ...args); };
        if (this.probeFirstGain) {
          window.audioProbe.masterGains.push(node);
          this.probeFirstGain = false;
        }
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
  await context.route("**/api/assets/*", async route => {
    const id = new URL(route.request().url()).pathname.split("/").at(-1);
    if (id === heldAssetId && heldAssetGate !== null) {
      signalHeldAssetRequest?.();
      await heldAssetGate;
    }
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
  await context.route("**/api/library/tracks", route => route.fulfill({ json: { tracks: [
    ...libraryRows, { ...libraryRows[0], id: "d", title: "Test D", stemAvailability: { status: "separated", stemCount: 4 }, studioProjectId: "fixture-project-d" },
  ] } }));
  await context.route("**/api/library/playlists", route => route.fulfill({ json: { playlists: [
    { id: "test-playlist", name: "Test order", trackCount: 2 },
  ] } }));
  await context.route("**/api/library/playlists/test-playlist", route => route.fulfill({ json: { playlist: {
    id: "test-playlist", name: "Test order",
    items: ["a", "b"].map((id, i) => ({ id: `playlist-${i}`, position: i, track: libraryRows.find(row => row.id === id) })),
  } } }));
  await context.route("**/api/library/queue", async route => {
    if (route.request().method() === "POST") {
      const { trackId } = route.request().postDataJSON();
      liveQueue.push({ id: `queue-${trackId}`, position: liveQueue.length, track: libraryRows.find(row => row.id === trackId) });
    } else if (route.request().method() === "DELETE") liveQueue = [];
    await route.fulfill({ json: { queue: liveQueue } });
  });
  await context.route("**/api/library/queue/*", route => {
    liveQueue = liveQueue.filter(item => item.id !== new URL(route.request().url()).pathname.split("/").at(-1));
    return route.fulfill({ json: { queue: liveQueue } });
  });
  await context.route("**/api/library/sessions", async route => {
    if (route.request().method() === "POST") {
      session.tracks = []; session.swaps = []; session.currentSessionTrackId = null; session.positionSeconds = 0;
      return route.fulfill({ json: { session: { id: sessionId } } });
    }
    return route.fulfill({ json: { sessions: [] } });
  });
  await context.route(`**/api/library/sessions/${sessionId}**`, async route => {
    const request = route.request(), url = new URL(request.url());
    const body = request.postDataJSON();
    if (request.method() === "GET" && exposeSeparatedSource) {
      return route.fulfill({ json: { session: {
        ...session,
        tracks: session.tracks.map(item => item.id === "a" ? tracks[0] : item),
      } } });
    }
    if (url.pathname.endsWith("/swaps") && request.method() === "POST") {
      session.swaps = session.swaps.filter(s => !(s.sessionTrackId === body.sessionTrackId && s.stemType === body.stemType));
      session.swaps.push({ ...body, id: `swap-${body.stemType}`, fromTrackId: "a", createdAt: new Date().toISOString(),
        donorTrack: body.toTrackId === "d" ? { id: "d", title: "Test D", stems: externalStemKeys } : undefined });
    } else if (url.pathname.endsWith("/tracks") && request.method() === "POST") {
      const item = tracks.find(t => t.track.id === body.trackId);
      session.tracks.push({ ...item, id: `session-${session.tracks.length + 1}`, position: body.position });
    } else if (url.pathname.endsWith("/tracks") && request.method() === "PATCH") {
      const from = session.tracks.findIndex(item => item.id === body.sessionTrackId);
      const to = Math.max(0, Math.min(session.tracks.length - 1, Number(body.position)));
      if (from >= 0) {
        const [item] = session.tracks.splice(from, 1);
        session.tracks.splice(to, 0, item);
        session.tracks.forEach((track, index) => { track.position = index; });
      }
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
  let current = page.locator('[data-role="current"]');
  const firstPage = page;
  const toggle = async () => {
    const button = page.getByTestId("session-play");
    const before = await button.getAttribute("aria-pressed");
    await button.click();
    await page.waitForFunction((before) => document.querySelector('[data-testid="session-play"]').getAttribute("aria-pressed") !== before, before);
  };
  const wheel = page.getByTestId("session-camelot-wheel");
  assert.equal(await wheel.getByTestId("camelot-key-8A").getAttribute("aria-pressed"), "true", "the current A minor track maps to 8A");
  assert.match(await wheel.getByTestId("camelot-key-8B").getAttribute("class"), /compatible/, "the relative-major 8B cell is highlighted");
  const camelotCell = wheel.getByTestId("camelot-key-3B");
  await camelotCell.scrollIntoViewIfNeeded();
  const wheelHitTest = await camelotCell.evaluate(button => {
    const rect = button.getBoundingClientRect();
    const target = document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2);
    return {
      reachable: button.contains(target),
      rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
      target: target ? `${target.tagName.toLowerCase()}${target.id ? `#${target.id}` : ""}.${String(target.className || "").toString().replaceAll(" ", ".")}` : "none",
    };
  });
  assert.ok(wheelHitTest.reachable, `wheel button centers must be pointer reachable: ${JSON.stringify(wheelHitTest)}`);
  await camelotCell.evaluate(button => button.click());
  await wheel.getByRole("button", { name: "Set Test c as next" }).click();
  assert.equal(session.tracks[1].id, "c", "selecting a Camelot key can reorder a compatible session track to next");

  const secondPage = await context.newPage();
  secondPage.on("pageerror", error => console.log("SECOND_PAGE_ERROR", error.stack));
  await secondPage.goto(`http://localhost:80/waveyard/session/${sessionId}`);
  await secondPage.waitForFunction(() => [...document.querySelectorAll('[data-role="current"] audio')].length === 4 &&
    [...document.querySelectorAll('[data-role="current"] audio')].every(a => a.readyState === 4));
  await toggle();
  await secondPage.waitForFunction(() => document.querySelector('[data-testid="session-play"]')?.getAttribute("aria-pressed") === "true");
  assert.ok(await secondPage.evaluate(() => [...document.querySelectorAll('[data-role="current"] audio')].every(a => a.paused)),
    "the other tab mirrors playback without starting duplicate audio");
  await firstPage.getByLabel("Seek current track", { exact: true }).press("Home");
  await secondPage.waitForFunction(() => document.querySelector('[aria-label="Seek current track"]')?.value === "0");
  assert.equal(await firstPage.getByTestId("session-play").getAttribute("aria-pressed"), "true", "remote seek does not pause the active deck");

  await current.getByLabel("Isolate vocals", { exact: true }).click();
  await page.waitForFunction(() => {
    const get = type => window.audioProbe.sources.find(item => item.mediaElement.src.endsWith(`/a-${type}`))?.inputNode?.nextNode?.gain?.value;
    return get("vocals") > 0.9 && ["drums", "bass", "other"].every(type => get(type) < 0.01);
  });
  await current.getByLabel("Isolate vocals", { exact: true }).click();
  await page.waitForFunction(() => ["vocals", "drums", "bass", "other"].every(type => {
    const source = window.audioProbe.sources.find(item => item.mediaElement.src.endsWith(`/a-${type}`));
    return source?.inputNode?.nextNode?.gain?.value > 0.9;
  }));
  await current.getByLabel("Mute drums", { exact: true }).click();
  await page.waitForFunction(() => {
    const get = type => window.audioProbe.sources.find(item => item.mediaElement.src.endsWith(`/a-${type}`))?.inputNode?.nextNode?.gain?.value;
    return get("drums") < 0.01 && ["vocals", "bass", "other"].every(type => get(type) > 0.9);
  });
  await current.getByLabel("Restore all current stems", { exact: true }).click();
  await page.waitForFunction(() => ["vocals", "drums", "bass", "other"].every(type => {
    const source = window.audioProbe.sources.find(item => item.mediaElement.src.endsWith(`/a-${type}`));
    return source?.inputNode?.nextNode?.gain?.value > 0.9;
  }));

  await current.getByLabel("vocals source", { exact: true }).selectOption("b");
  await page.waitForFunction(() => window.audioProbe.buffers.length === 1);
  await page.waitForTimeout(250);
  await toggle();
  const seek = current.getByTestId("seek-deck-0");
  await seek.fill("6");
  await page.waitForTimeout(150);
  const paused = await current.locator("audio").evaluateAll(elements => elements.map(e => ({ time: e.currentTime, ready: e.readyState, duration: e.duration, paused: e.paused,
    seekable: Array.from({ length: e.seekable.length }, (_, i) => [e.seekable.start(i), e.seekable.end(i)]) })));
  assert.ok(paused.every(e => Math.abs(e.time - 6) < 0.1), "recipient media must seek, not only the slider");
  await toggle();
  const resumed = await page.evaluate(() => ({
    offset: window.audioProbe.buffers.at(-1).startedOffset,
    recipientTime: document.querySelector('[data-role="current"] audio')?.currentTime,
    paused: document.querySelector('[data-role="current"] audio')?.paused,
  }));
  assert.ok(Math.abs(resumed.offset - 6) < 0.1, `donor resumes from recipient seek: ${JSON.stringify(resumed)}`);
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
  await page.getByTestId("session-transition").click();
  await page.getByRole("button", { name: "Finish", exact: true }).click();
  await secondPage.waitForFunction(() => document.querySelector('[data-role="current"]')?.textContent.includes("Test c"));
  assert.ok(await secondPage.evaluate(() => [...document.querySelectorAll('[data-role="current"] audio')].every(a => a.paused)),
    "a track change mirrors to the other tab without starting duplicate audio");
  await secondPage.getByTestId("session-play").click();
  await page.waitForFunction(() => document.querySelector('[data-testid="session-play"]')?.getAttribute("aria-pressed") === "false");
  await page.waitForFunction(() => [...document.querySelectorAll('[data-role="current"] audio')].every(element => element.paused));
  assert.ok(await page.evaluate(() => [...document.querySelectorAll('[data-role="current"] audio')].every(a => a.paused)),
    "a pause command in the mirror tab pauses the active tab");
  await secondPage.close();

  // A source-only deck must keep playing while completed stems are prepared.
  session.tracks = [sourceOnlyTrack];
  session.swaps = [];
  session.currentSessionTrackId = "a";
  session.positionSeconds = 0;
  exposeSeparatedSource = false;
  await page.goto(`http://localhost:80/waveyard/session/${sessionId}`);
  await page.waitForFunction(() => {
    const audio = document.querySelector('[data-role="current"] audio');
    return audio?.src.endsWith("/a-source") && audio.readyState >= 2;
  });
  current = page.locator('[data-role="current"]');
  await toggle();
  await current.getByTestId("seek-deck-0").fill("2");
  await page.waitForTimeout(150);
  exposeSeparatedSource = true;
  const switchButton = page.getByTestId("button-switch-stems-a");
  await switchButton.waitFor({ timeout: 15000 });

  failAsset = "a-bass";
  await switchButton.click();
  await page.getByRole("alert").filter({ hasText: "original track is still playing" }).waitFor();
  const failedHandoff = await current.locator("audio").evaluateAll(elements => elements.map(e => ({
    src: e.src, paused: e.paused, time: e.currentTime,
  })));
  assert.equal(failedHandoff.length, 1, "failed preparation must leave only the original source mounted");
  assert.ok(failedHandoff[0].src.endsWith("/a-source") && !failedHandoff[0].paused,
    "failed preparation must keep the original source playing");

  failAsset = null;
  const beforeHandoff = await current.locator("audio").evaluate(element => element.currentTime);
  const handoffStarted = Date.now();
  await page.getByTestId("button-switch-stems-a").click();
  await page.waitForFunction(() => {
    const audio = [...document.querySelectorAll('[data-role="current"] audio')];
    return audio.length === 4 && audio.every(element => element.readyState >= 2 && !element.paused);
  });
  const afterHandoff = await current.locator("audio").evaluateAll(elements => elements.map(element => element.currentTime));
  const expectedPosition = beforeHandoff + (Date.now() - handoffStarted) / 1000;
  assert.ok(afterHandoff.every(time => Math.abs(time - expectedPosition) < 0.4),
    `successful handoff must preserve the live playhead; expected ${expectedPosition}, received ${afterHandoff}`);
  const handoffGains = await page.evaluate(() => window.audioProbe.sources.map(source => ({
    url: source.mediaElement.src,
    gain: source.inputNode?.nextNode?.gain?.value,
  })).filter(source => source.url.includes("/a-source") || ["vocals", "drums", "bass", "other"].some(type => source.url.endsWith(`/a-${type}`))));
  assert.equal(handoffGains.find(source => source.url.endsWith("/a-source"))?.gain, 0,
    "the original source must be silent after the stem handoff");
  assert.ok(types.every(type => handoffGains.find(source => source.url.endsWith(`/a-${type}`))?.gain > 0),
    "all prepared stems must be audible after the handoff");

  const masterVolume = page.getByLabel("Master volume", { exact: true });
  await masterVolume.fill("0.63");
  assert.equal(await masterVolume.inputValue(), "0.63", "the chosen master level is active before returning");
  assert.ok(Math.abs(await page.evaluate(() => window.audioProbe.masterGains.at(-1)?.gain.value) - 0.63) < 0.01,
    "the live master gain matches its control before returning");
  const beforeReturn = await current.locator("audio").evaluateAll(elements => Math.max(...elements.map(element => element.currentTime)));
  const returnStartedAt = Date.now();
  let notifyHeldRequest;
  const heldRequest = new Promise(resolve => { notifyHeldRequest = resolve; });
  let releaseHeldRequest;
  heldAssetGate = new Promise(resolve => { releaseHeldRequest = resolve; });
  heldAssetId = "a-source";
  signalHeldAssetRequest = notifyHeldRequest;
  await page.getByTestId("button-return-full-track-a").click();
  await heldRequest;
  await page.getByTestId("source-handoff-status").waitFor();
  const duringReturn = await current.locator("audio").evaluateAll(elements => elements.map(element => ({
    src: element.src, paused: element.paused, time: element.currentTime,
  })));
  assert.equal(duringReturn.length, 5, "the original source is prepared alongside the playing stem mix");
  assert.ok(duringReturn.slice(0, 4).every(element => !element.paused),
    "the separated mix continues playing while the original source is still loading");
  assert.ok(duringReturn[4].src.endsWith("/a-source") && duringReturn[4].paused,
    "the staged full-track element does not start before it is ready");
  assert.ok(duringReturn[0].time > beforeReturn, "the existing stem mix advances during source preparation");
  assert.ok(Math.abs(await page.evaluate(() => window.audioProbe.masterGains.at(-1)?.gain.value) - 0.63) < 0.01,
    "the master gain stays unchanged while the original is prepared");
  heldAssetId = null;
  heldAssetGate = null;
  signalHeldAssetRequest = null;
  releaseHeldRequest();
  await page.waitForFunction(() => {
    const audio = [...document.querySelectorAll('[data-role="current"] audio')];
    return audio.length === 1 && audio[0].src.endsWith("/a-source") && audio[0].readyState >= 2 && !audio[0].paused;
  });
  const afterReturn = await current.locator("audio").evaluate(element => element.currentTime);
  const expectedReturnPosition = beforeReturn + (Date.now() - returnStartedAt) / 1000;
  assert.ok(Math.abs(afterReturn - expectedReturnPosition) < 0.5,
    `returning to the full track preserves the live playhead; expected ${expectedReturnPosition}, received ${afterReturn}`);
  assert.equal(await masterVolume.inputValue(), "0.63", "returning does not reset the master-volume control");
  assert.ok(Math.abs(await page.evaluate(() => window.audioProbe.masterGains.at(-1)?.gain.value) - 0.63) < 0.01,
    "returning preserves the actual master gain");
  const returnGains = await page.evaluate(() => window.audioProbe.sources.map(source => ({
    url: source.mediaElement.src, gain: source.inputNode?.nextNode?.gain?.value,
  })));
  assert.ok(returnGains.filter(source => source.url.endsWith("/a-source")).at(-1)?.gain > 0.9,
    "the original full-track signal is audible after the handoff");
  assert.ok(types.every(type => returnGains.filter(source => source.url.endsWith(`/a-${type}`)).at(-1)?.gain < 0.01),
    "the separated layer signals are silent after returning to the full track");
  assert.equal(await page.getByTestId("session-play").getAttribute("aria-pressed"), "true",
    "the deck remains in the playing state after returning to the full track");

  await page.getByTestId("button-switch-stems-a").click();
  await page.waitForFunction(() => {
    const audio = [...document.querySelectorAll('[data-role="current"] audio')];
    return audio.length === 4 && audio.every(element => !element.paused && element.src.includes("/a-"));
  });
  const beforeFailedReturn = await current.locator("audio").evaluateAll(elements => Math.max(...elements.map(element => element.currentTime)));
  failAsset = "a-source";
  await page.getByTestId("button-return-full-track-a").click();
  const sourceError = page.getByRole("alert");
  await sourceError.waitFor();
  assert.match(await sourceError.textContent(), /full track could not load/i,
    "the source failure message identifies the original track");
  assert.match(await sourceError.textContent(), /current stem mix is still playing/i,
    "the source failure message confirms stems remain active");
  await page.getByTestId("button-retry-full-track-a").waitFor();
  assert.equal(await page.getByText("Retry live stems", { exact: true }).count(), 0,
    "a full-track load error does not offer the unrelated stem retry");
  const afterFailedReturn = await current.locator("audio").evaluateAll(elements => ({
    count: elements.length,
    playing: elements.every(element => !element.paused),
    position: Math.max(...elements.map(element => element.currentTime)),
  }));
  assert.equal(afterFailedReturn.count, 4, "a failed full-track load removes only the staged source");
  assert.ok(afterFailedReturn.playing, "all original stems continue playing after the source fails");
  assert.ok(afterFailedReturn.position > beforeFailedReturn, "the current stem mix advances while the source is unavailable");
  assert.ok(Math.abs(await page.evaluate(() => window.audioProbe.masterGains.at(-1)?.gain.value) - 0.63) < 0.01,
    "a failed source load leaves the master level unchanged");
  assert.equal(await page.getByTestId("session-play").getAttribute("aria-pressed"), "true",
    "the transport remains in the playing state after the source fails");

  failAsset = null;
  const retryPosition = afterFailedReturn.position;
  const retryStartedAt = Date.now();
  await page.getByTestId("button-retry-full-track-a").click();
  await page.waitForFunction(() => {
    const audio = [...document.querySelectorAll('[data-role="current"] audio')];
    return audio.length === 1 && audio[0].src.endsWith("/a-source") && audio[0].readyState >= 2 && !audio[0].paused;
  });
  const afterRetry = await current.locator("audio").evaluate(element => element.currentTime);
  const expectedRetryPosition = retryPosition + (Date.now() - retryStartedAt) / 1000;
  assert.ok(Math.abs(afterRetry - expectedRetryPosition) < 0.5,
    `retry returns to the full track at the live playhead; expected ${expectedRetryPosition}, received ${afterRetry}`);
  assert.equal(await page.getByTestId("session-play").getAttribute("aria-pressed"), "true",
    "successful retry keeps playback active");
  assert.ok(Math.abs(await page.evaluate(() => window.audioProbe.masterGains.at(-1)?.gain.value) - 0.63) < 0.01,
    "successful retry also preserves the master level");
  const retryGains = await page.evaluate(() => window.audioProbe.sources.map(source => ({
    url: source.mediaElement.src, gain: source.inputNode?.nextNode?.gain?.value,
  })));
  assert.ok(retryGains.filter(source => source.url.endsWith("/a-source")).at(-1)?.gain > 0.9,
    "the retried original source is audible");
  assert.ok(types.every(type => retryGains.filter(source => source.url.endsWith(`/a-${type}`)).at(-1)?.gain < 0.01),
    "the stem layers are silent after the retry completes");

  await page.setViewportSize({ width: 390, height: 844 });
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), "mobile must not overflow");
  console.log("PASS: live swaps, seek/resume, gapless handoffs, failed-source recovery, mobile width");
} finally { await browser.close(); }
