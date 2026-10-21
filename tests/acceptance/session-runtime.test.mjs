import { before, after, test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { readFile, mkdir, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { build } from "esbuild";
import { chromium } from "playwright-core";
import { expect } from "@playwright/test";

let server, browser, origin;
const sessions = new Map();
const handoffRequests = new Map();
function session(id) {
  if (!sessions.has(id)) sessions.set(id, {
    id, name: "Actual session UI acceptance", currentSessionTrackId: "a", positionSeconds: 0, swaps: [],
    tracks: ["a", "b", "c"].map((key, position) => ({ id: key, position,
      track: { id: `track-${key}`, title: `Song ${key.toUpperCase()}`, artist: "PCM fixture", durationSeconds: 30 },
      stems: [{ id: key, stemType: "drums", engine: "synthetic-fixture" }], playback: { assetIds: [key], kind: "stems" },
      stemMix: { drums: 1 }, transition: { mode: "manual", crossfadeSeconds: 0, keepStems: [] }, analysis: null,
    })),
  });
  return sessions.get(id);
}
function tone(hz) {
  const rate = 44100, frames = rate * 30, data = Buffer.alloc(44 + frames * 2);
  data.write("RIFF"); data.writeUInt32LE(data.length - 8, 4); data.write("WAVEfmt ", 8);
  data.writeUInt32LE(16, 16); data.writeUInt16LE(1, 20); data.writeUInt16LE(1, 22);
  data.writeUInt32LE(rate, 24); data.writeUInt32LE(rate * 2, 28); data.writeUInt16LE(2, 32); data.writeUInt16LE(16, 34);
  data.write("data", 36); data.writeUInt32LE(frames * 2, 40);
  for (let i = 0; i < frames; i++) data.writeInt16LE(Math.round(8192 * Math.sin(2 * Math.PI * hz * i / rate)), 44 + 2 * i);
  return data;
}
const tones = new Map([['a', tone(220)], ['b', tone(440)], ['c', tone(880)], ['bass-a', tone(660)]]);
before(async () => {
  const bundle = await build({ entryPoints: ["tests/acceptance/session-runtime.fixture.tsx"], bundle: true, write: false, platform: "browser", format: "iife", jsx: "automatic", define: { "process.env": JSON.stringify({ NODE_ENV: "development" }) } });
  server = createServer(async (req, res) => {
    const url = new URL(req.url, "http://fixture");
    const json = (value, status = 200) => { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(value)); };
    if (url.pathname === "/fixture.js") { res.setHeader("content-type", "text/javascript"); return res.end(bundle.outputFiles[0].contents); }
    if (url.pathname.startsWith("/api/assets/")) {
      const key = url.pathname.split("/").at(-1), data = tones.get(key);
      if (!data) { res.writeHead(404); return res.end(); }
      const match = req.headers.range?.match(/^bytes=(\d+)-(\d*)$/);
      const start = match ? Number(match[1]) : 0, end = match?.[2] ? Math.min(Number(match[2]), data.length - 1) : data.length - 1;
      res.writeHead(match ? 206 : 200, { "content-type": "audio/wav", "accept-ranges": "bytes", "content-length": end - start + 1, ...(match ? { "content-range": `bytes ${start}-${end}/${data.length}` } : {}) });
      return res.end(data.subarray(start, end + 1));
    }
    if (url.pathname === "/api/library/tracks") return json({ tracks: ["a", "b", "c"].map((key) => ({ id: `track-${key}`, title: `Song ${key.toUpperCase()}`, artist: "PCM fixture" })) });
    const parts = url.pathname.split("/");
    if (parts[3] === "sessions") {
      const state = session(parts[4]);
      if (parts[5] === "studio-handoff") {
        let raw = ""; for await (const chunk of req) raw += chunk;
        handoffRequests.set(parts[4], JSON.parse(raw));
        return json({ handoff: { projectId: "derived-project", remixTrackCount: state.tracks.length, notice: "Controlled handoff response; database/render acceptance runs separately." } }, 201);
      }
      if (req.method !== "GET") {
        let raw = ""; for await (const chunk of req) raw += chunk;
        const body = JSON.parse(raw || "{}");
        if (parts[5] === "swaps") {
          if (req.method === "DELETE") state.swaps = state.swaps.filter(swap => swap.id !== url.searchParams.get("swapId"));
          else state.swaps.push({ id: "swap-drums", fromStemAssetId: "a", toStemAssetId: body.toStemAssetId ?? "b", sessionTrackId: body.sessionTrackId, stemType: body.stemType, toTrackId: body.toTrackId, atSeconds: body.atSeconds });
        }
        if (parts[5] === "state") { if (process.env.DEBUG_SESSION) console.log(parts[4], body); Object.assign(state, body); }
        if (req.method === "DELETE" && parts[5] === "tracks") state.tracks = state.tracks.filter((track) => track.id !== url.searchParams.get("sessionTrackId"));
        if (parts[5] === "tracks" && parts[6]) Object.assign(state.tracks.find((track) => track.id === parts[6]), body);
      }
      return json({ session: state });
    }
    if (url.pathname.startsWith("/api/")) return json({});
    res.setHeader("content-type", "text/html"); res.end('<!doctype html><div id="root"></div><script src="/fixture.js"></script>');
  });
  await new Promise((resolve) => server.listen(0, "0.0.0.0", resolve));
  origin = `http://127.0.0.1:${server.address().port}`;
  browser = await chromium.launch({ executablePath: process.env.CHROMIUM_EXECUTABLE_PATH || undefined, headless: true, args: ["--no-sandbox", "--disable-dev-shm-usage", "--autoplay-policy=no-user-gesture-required"] });
  console.log(JSON.stringify({ kind: "actual-session-ui-audio", browser: browser.version(), sourceSha256: createHash("sha256").update(await readFile("src/components/waveyard/library/SessionExperience.tsx")).digest("hex"), limitations: ["controlled HTTP state, not database persistence", "synthetic PCM, not inference", "browser not Electron"] }));
});
after(async () => { await browser?.close(); await new Promise((resolve) => server ? server.close(resolve) : resolve()); });
async function pageFor(t, id, prepare) {
  const page = await browser.newPage();
  if (process.env.DEBUG_SESSION) page.on("console", message => console.log(message.text()));
  const errors = []; page.on("pageerror", (e) => errors.push(e.message));
  await page.addInitScript(() => {
    window.observedAudio = [];
    const Native = window.AudioContext;
    window.AudioContext = class extends Native {
      constructor(...args) {
        super(...args); const analysers = [], stems = [], original = this.createAnalyser.bind(this);
        const nativeSource = this.createMediaElementSource.bind(this);
        let source = null;
        this.createMediaElementSource = element => { source = element; return nativeSource(element); };
        this.createAnalyser = () => {
          const node = original(); analysers.push(node);
          if (source) { stems.push({ node, element: source }); source = null; }
          return node;
        };
        window.observedAudio.push({ context: this, analysers, stems });
      }
    };
    window.stemAudioSnapshot = () => window.observedAudio.flatMap(({ context, stems }) => stems.map(({ node, element }) => {
      const pcm = new Float32Array(node.fftSize); node.getFloatTimeDomainData(pcm);
      return { label: element.getAttribute("aria-label"), src: element.currentSrc, rms: context.state === "closed" ? 0 : Math.sqrt(pcm.reduce((sum, x) => sum + x * x, 0) / pcm.length) };
    }));
    window.audioSnapshot = () => window.observedAudio.map(({ context, analysers }) => {
      const node = analysers[0]; if (!node || context.state === "closed") return { rms: 0, hz: 0 };
      const pcm = new Float32Array(node.fftSize); node.getFloatTimeDomainData(pcm);
      const bins = new Float32Array(node.frequencyBinCount); node.getFloatFrequencyData(bins);
      let peak = 0; for (let i = 1; i < bins.length; i++) if (bins[i] > bins[peak]) peak = i;
      return { rms: Math.sqrt(pcm.reduce((sum, x) => sum + x * x, 0) / pcm.length), hz: peak * context.sampleRate / node.fftSize };
    });
  });
  t.after(async () => { await page.close(); assert.deepEqual(errors, [], "no renderer exceptions"); });
  await prepare?.(page);
  await page.goto(`${origin}/${id}`); await expect(page.getByTestId("session-stage")).toBeVisible();
  return page;
}
async function audible(page, hz) {
  await expect.poll(() => page.evaluate((expected) => window.audioSnapshot().some((x) => x.rms > 0.08 && Math.abs(x.hz - expected) < 30), hz)).toBe(true);
}
async function start(page) { await page.getByTestId("session-play").click(); await audible(page, 220); }
async function current(page, title) { await expect(page.getByTestId("session-deck-current").getByRole("heading")).toHaveText(title); }

test("hard cut advances actual UI, audio and restore point; another cut succeeds", { timeout: 20000 }, async (t) => {
  const page = await pageFor(t, "cuts"); await start(page);
  await page.getByTestId("session-transition").click();
  await current(page, "Song B"); await audible(page, 440);
  await expect.poll(() => session("cuts").currentSessionTrackId).toBe("b");
  await page.getByTestId("session-transition").click();
  await current(page, "Song C"); await audible(page, 880);
  await expect.poll(() => session("cuts").currentSessionTrackId).toBe("c");
  await expect.poll(() => session("cuts").tracks[0].transition.cue?.toSessionTrackId).toBe("b");
  assert.deepEqual([session("cuts").tracks[0].transition.cue.fromDeck, session("cuts").tracks[0].transition.cue.toDeck], [0, 1]);
  await expect.poll(() => session("cuts").tracks[1].transition.cue?.toSessionTrackId).toBe("c");
  assert.equal(await page.locator("audio").evaluateAll((nodes) => nodes.filter((node) => !node.paused).length), 1);
  await page.reload(); await current(page, "Song C");
  await expect(page.getByTestId("session-play")).toHaveText("Play");
  await page.getByTestId("session-play").click(); await audible(page, 880);
});

test("timed crossfade completes and consecutive playback remains usable", { timeout: 20000 }, async (t) => {
  const page = await pageFor(t, "fade"); await start(page);
  await page.locator("#sess-fade").fill("1");
  const started = Date.now();
  await page.getByTestId("session-transition").click();
  await expect(page.getByRole("button", { name: "Freeze", exact: true })).toBeVisible();
  await expect.poll(() => page.evaluate(() => window.audioSnapshot().filter((x) => x.rms > 0.02).length)).toBe(2);
  await current(page, "Song B"); await audible(page, 440);
  assert.ok(Date.now() - started >= 800, "configured one-second fade was not replaced by an early cut");
  await page.getByTestId("session-transition").click(); await current(page, "Song C"); await audible(page, 880);
});

test("missing incoming audio cannot claim transition completion; current deck recovers", { timeout: 20000 }, async (t) => {
  session("missing").tracks[1].playback.assetIds = ["missing"];
  session("missing").tracks[1].stems[0].id = "missing";
  const page = await pageFor(t, "missing"); await start(page);
  await page.getByTestId("session-transition").click();
  await expect(page.getByTestId("session-status")).toContainText(/could not|failed|unavailable/i);
  await current(page, "Song A");
  await expect(page.getByTestId("session-play")).toHaveText("Play");
  await page.getByTestId("session-play").click(); await audible(page, 220);
});

async function silent(page) {
  await expect.poll(() => page.evaluate(() => window.audioSnapshot().every((x) => x.rms < 0.001))).toBe(true);
  assert.equal(await page.locator("audio").evaluateAll((nodes) => nodes.filter((node) => !node.paused).length), 0);
}

test("pause, seek and stop abort live fades without an audible standby or stale restore", { timeout: 20000 }, async (t) => {
  const page = await pageFor(t, "recover"); await start(page);
  await page.locator("#sess-fade").fill("4");
  for (const action of ["pause", "seek", "stop"]) {
    await page.getByTestId("session-transition").click();
    await expect(page.getByRole("button", { name: "Freeze", exact: true })).toBeVisible();
    await expect.poll(() => page.evaluate(() => window.audioSnapshot().filter((x) => x.rms > 0.02).length)).toBe(2);
    if (action === "pause") await page.getByTestId("session-play").click();
    if (action === "seek") await page.getByRole("slider", { name: "Session position" }).fill("8");
    if (action === "stop") await page.getByTestId("session-stop").click();
    await silent(page); await current(page, "Song A");
    await expect(page.getByTestId("session-play")).toHaveText("Play");
    if (action === "seek") await expect.poll(() => session("recover").positionSeconds).toBe(8);
    if (action === "stop") await expect.poll(() => session("recover").positionSeconds).toBe(0);
    await page.getByTestId("session-play").click(); await audible(page, 220);
  }
  await page.locator("#sess-fade").fill("0");
  await page.getByTestId("session-transition").click(); await current(page, "Song B"); await audible(page, 440);
});

test("freeze preserves a live mix, but pause silences BOTH decks and resume restores current levels", { timeout: 15000 }, async (t) => {
  const page = await pageFor(t, "freeze"); await start(page);
  await page.locator("#sess-fade").fill("4"); await page.getByTestId("session-transition").click();
  await expect.poll(() => page.evaluate(() => window.audioSnapshot().filter((x) => x.rms > 0.02).length)).toBe(2);
  await page.getByRole("button", { name: "Freeze", exact: true }).click();
  await page.getByTestId("session-play").click(); await silent(page);
  await page.getByTestId("session-play").click(); await audible(page, 220);
  assert.equal(await page.locator("audio").evaluateAll((nodes) => nodes.filter((node) => !node.paused).length), 1);
});

test("removing the incoming track during a fade cancels it instead of promoting its replacement", { timeout: 15000 }, async (t) => {
  const page = await pageFor(t, "replace"); await start(page);
  await page.locator("#sess-fade").fill("4"); await page.getByTestId("session-transition").click();
  await expect(page.getByRole("button", { name: "Freeze", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Remove Song B", exact: true }).click();
  await expect(page.getByTestId("session-status")).toContainText(/track changed|interrupted/);
  await silent(page); await current(page, "Song A");
  await page.getByTestId("session-play").click(); await audible(page, 220);
  await page.locator("#sess-fade").fill("0"); await page.getByTestId("session-transition").click();
  await current(page, "Song C"); await audible(page, 880);
});

test("cancelled pending media start cannot play later when the asset arrives", { timeout: 15000 }, async (t) => {
  let release; const gate = new Promise((resolve) => { release = resolve; });
  t.after(() => release());
  const page = await pageFor(t, "pending", async (candidate) => {
    await candidate.route("**/api/assets/b", async (route) => { await gate; await route.continue().catch(() => {}); });
  });
  await start(page); await page.getByTestId("session-transition").click();
  await expect(page.getByRole("button", { name: "Cancel start", exact: true })).toBeVisible();
  await page.getByTestId("session-stop").click(); release();
  await page.waitForFunction(() => document.querySelector('audio[src="/api/assets/b"]')?.readyState >= 2);
  await silent(page); await current(page, "Song A");
  await page.getByTestId("session-play").click(); await audible(page, 220);
  await page.getByTestId("session-transition").click(); await current(page, "Song B"); await audible(page, 440);
});

test("a browser-rejected play promise leaves the current identity intact and reports failure", { timeout: 15000 }, async (t) => {
  const page = await pageFor(t, "rejected"); await start(page);
  // Fault injection into a real browser promise: this is a failure test, not
  // evidence of successful playback or inference.
  await page.evaluate(() => {
    const realPlay = HTMLMediaElement.prototype.play;
    HTMLMediaElement.prototype.play = function () { return this.src.endsWith("/b") ? Promise.reject(new DOMException("Playback denied in acceptance", "NotAllowedError")) : realPlay.call(this); };
  });
  await page.getByTestId("session-transition").click();
  await expect(page.getByTestId("session-status")).toContainText("next track could not start");
  await current(page, "Song A"); await silent(page);
  assert.equal(session("rejected").currentSessionTrackId, "a");
  await page.getByTestId("session-play").click(); await audible(page, 220);
});

test("natural end uses the same checked promotion path without restarting the outgoing track", { timeout: 15000 }, async (t) => {
  const page = await pageFor(t, "ended"); await start(page);
  await page.getByRole("slider", { name: "Session position" }).fill("29.7");
  await current(page, "Song B"); await audible(page, 440);
  await expect.poll(() => session("ended").currentSessionTrackId).toBe("b");
});

for (const kind of ["stems", "source"]) test(`${kind} playback with an empty saved mix really attenuates the outgoing graph during crossfade`, { timeout: 15000 }, async (t) => {
  const id = `default-${kind}`;
  for (const track of session(id).tracks) { track.stemMix = {}; track.playback.kind = kind; if (kind === "source") track.stems = []; }
  const page = await pageFor(t, id); await start(page);
  await expect.poll(() => page.evaluate(() => window.audioSnapshot().some((x) => Math.abs(x.hz - 220) < 30 && x.rms > 0.08))).toBe(true);
  await page.locator("#sess-fade").fill("2"); await page.getByTestId("session-transition").click();
  await page.evaluate(() => { window.acceptanceFadeStart = performance.now(); });
  await expect.poll(() => page.evaluate(() => {
    if (performance.now() - window.acceptanceFadeStart < 600) return false;
    const snapshots = window.audioSnapshot();
    const outgoing = snapshots.find((x) => Math.abs(x.hz - 220) < 30);
    const incoming = snapshots.find((x) => Math.abs(x.hz - 440) < 30);
    return outgoing?.rms > 0.005 && outgoing.rms < 0.06 && incoming?.rms > 0.02 && !document.querySelector('audio[src="/api/assets/a"]').paused;
  })).toBe(true);
  await current(page, "Song B"); await audible(page, 440);
});


test("explicit sequential handoff links to the actual existing-project workspace", async (t) => {
  const page = await pageFor(t, "handoff-navigation");
  await page.getByTestId("session-handoff").click();
  await expect(page.getByTestId("handoff-confirmation")).toContainText("Completed transitions preserve");
  await page.getByRole("button", { name: "Create sequential Studio edit", exact: true }).click();
  await expect(page.getByRole("link", { name: "Open it in the Studio", exact: true })).toHaveAttribute("href", "/waveyard/projects/derived-project");
});

 test("completed browser crossfade and hard cut are included in the explicit faithful handoff", async (t) => {
  const page = await pageFor(t, "completed-cues"); await start(page);
  await page.locator("#sess-fade").fill("1");
  await page.getByTestId("session-transition").click(); await current(page, "Song B");
  await expect.poll(() => session("completed-cues").tracks[0].transition.cue?.toSessionTrackId).toBe("b");
  assert.equal(session("completed-cues").tracks[0].transition.crossfadeSeconds, 1);
  await page.locator("#sess-fade").fill("0");
  await page.getByTestId("session-transition").click(); await current(page, "Song C");
  await expect.poll(() => session("completed-cues").tracks[1].transition.cue?.toSessionTrackId).toBe("c");
  await page.reload(); await current(page, "Song C");
  await page.getByTestId("session-handoff").click();
  await page.getByTestId("handoff-transitions").click();
  await expect.poll(() => handoffRequests.get("completed-cues")?.mode).toBe("transitions");
  const edits = handoffRequests.get("completed-cues").trackEdits;
  assert.equal(edits[0].transition.cue.toSessionTrackId, "b");
  assert.equal(edits[1].transition.cue.toSessionTrackId, "c");
  assert.deepEqual([edits[0].transition.cue.fromDeck, edits[1].transition.cue.fromDeck], [0, 1]);
});


test("live donor replacement and revert keep the other lane running and resume the real donor at the deck clock", { timeout: 25000 }, async t => {
  const state = session("live-donor");
  state.tracks[0].stems.push({ id: "bass-a", stemType: "bass", engine: "synthetic-fixture" });
  state.tracks[0].playback.assetIds.push("bass-a");
  state.tracks[0].stemMix.bass = 1;
  const page = await pageFor(t, "live-donor");
  const deck = page.getByTestId("session-deck-current");
  await page.getByTestId("session-play").click();
  await expect.poll(() => deck.locator("audio").first().evaluate(el => !el.paused && el.currentTime > 1)).toBe(true);
  await deck.locator("audio").first().evaluate(el => { el.currentTime = 7; });
  await expect.poll(() => deck.locator('audio[aria-label="bass audio"]').evaluate(el => el.currentTime > 6.9)).toBe(true);
  await deck.locator('audio[aria-label="bass audio"]').evaluate(el => { window.originalBass = el; window.bassLoads = 0; el.addEventListener("loadstart", () => window.bassLoads++); });
  const before = await deck.locator("audio").first().evaluate(el => el.currentTime);
  await page.getByRole("button", { name: "Swap", exact: true }).first().click();
  const donor = deck.locator('audio[aria-label="drums audio (swapped layer)"]');
  await expect(donor).toHaveAttribute("src", "/api/assets/b");
  await expect.poll(() => donor.evaluate(el => !el.paused && el.currentTime > 6.9), { timeout: 5000 }).toBe(true);
  const clocks = await deck.locator("audio").evaluateAll(els => els.map(el => el.currentTime));
  assert.ok(Math.abs(clocks[0] - clocks[1]) < 0.12, `donor synchronized to unaffected clock: ${clocks}`);
  assert.ok(clocks[0] >= before - 0.12, "no restart at zero");
  await expect.poll(() => page.evaluate(() => window.observedAudio.some(({ context, analysers }) => analysers.some(node => {
    const pcm = new Float32Array(node.fftSize); node.getFloatTimeDomainData(pcm);
    const bins = new Float32Array(node.frequencyBinCount); node.getFloatFrequencyData(bins);
    let peak = 0; for (let i = 1; i < bins.length; i++) if (bins[i] > bins[peak]) peak = i;
    return Math.sqrt(pcm.reduce((sum, x) => sum + x * x, 0) / pcm.length) > 0.08 && Math.abs(peak * context.sampleRate / node.fftSize - 440) < 30;
  })))).toBe(true);
  await page.getByRole("button", { name: "Revert", exact: true }).click();
  await expect(deck.locator('audio[aria-label="drums audio"]')).toHaveAttribute("src", "/api/assets/a");
  await expect.poll(() => deck.locator('audio[aria-label="drums audio"]').evaluate(el => !el.paused && el.currentTime > 6.9)).toBe(true);
  const continuity = await deck.locator('audio[aria-label="bass audio"]').evaluate(el => ({ same: el === window.originalBass, reloads: window.bassLoads, paused: el.paused }));
  assert.deepEqual(continuity, { same: true, reloads: 0, paused: false });
});

test("a slow single-lane donor retains the real cursor and cannot auto-resume after an explicit pause", { timeout: 20000 }, async t => {
  const page = await pageFor(t, "slow-donor");
  await start(page);
  const deck = page.getByTestId("session-deck-current");
  const audio = deck.locator("audio").first();
  await audio.evaluate(el => { el.currentTime = 7; });
  await expect.poll(() => audio.evaluate(el => el.currentTime > 7.1)).toBe(true);
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  t.after(() => release());
  await page.route("**/api/assets/b", async route => { await gate; await route.continue(); });
  const requested = page.waitForRequest("**/api/assets/b");
  await page.getByRole("button", { name: "Swap", exact: true }).click();
  await requested;
  const savedPosition = session("slow-donor").positionSeconds;
  await page.getByTestId("session-play").click(); // explicit pause while metadata is unavailable
  release();
  await expect.poll(() => audio.evaluate(el => el.readyState >= 2)).toBe(true);
  assert.equal(await audio.evaluate(el => el.paused), true);
  await expect.poll(() => audio.evaluate(el => el.currentTime > 6.9)).toBe(true);
  await page.getByTestId("session-play").click();
  await audible(page, 440);
  assert.ok(await audio.evaluate(el => el.currentTime) > 6.9);
  console.log(JSON.stringify({ kind: "single-lane-delayed-donor", retainedSeconds: await audio.evaluate(el => el.currentTime), savedPosition, scope: "real browser audio, controlled delayed HTTP, not inference/persistence" }));
});

test("revert fences a pending donor load; a missing donor reports failure and recovers without replacing the session", { timeout: 20000 }, async t => {
  const page = await pageFor(t, "fenced-donor"); await start(page);
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  t.after(() => release());
  await page.route("**/api/assets/b", async route => { await gate; await route.continue().catch(() => {}); });
  const requested = page.waitForRequest("**/api/assets/b");
  await page.getByRole("button", { name: "Swap", exact: true }).click(); await requested;
  await page.getByRole("button", { name: "Revert", exact: true }).click();
  await audible(page, 220);
  release();
  await expect.poll(() => page.getByTestId("session-deck-current").locator("audio").evaluate(el => !el.paused && el.src.endsWith("/a"))).toBe(true);
  await page.unroute("**/api/assets/b");
  await page.route("**/api/assets/b", route => route.fulfill({ status: 404, body: "Missing retained audio" }));
  await page.getByRole("button", { name: "Swap", exact: true }).click();
  await expect(page.getByTestId("session-deck-current").getByRole("alert")).toBeVisible();
  await expect.poll(() => page.getByTestId("session-deck-current").locator("audio").evaluate(el => el.paused)).toBe(true);
  await page.getByRole("button", { name: "Revert", exact: true }).click();
  await page.getByTestId("session-play").click();
  await audible(page, 220);
  assert.equal(session("fenced-donor").tracks.length, 3);
  assert.deepEqual(session("fenced-donor").swaps, []);
});


test("actual session labels distinguish six-stem residual from four-stem melody without folding guitar or piano", async t => {
  for (const [key, model, expected] of [["deep-label", "deep_6s", "Other"], ["mdx-label", "kuielab_b_other", "Melody"]]) {
    const state = session(key);
    state.tracks[0].stems[0] = { id: "a", stemType: "other", model, engine: "synthetic-fixture" };
    const page = await pageFor(t, key);
    await expect(page.getByLabel(expected, { exact: true })).toBeVisible();
    await expect(page.getByLabel(expected === "Other" ? "Melody" : "Other", { exact: true })).toHaveCount(0);
  }
});

test("quantised mute changes real audio only at the measured beat; persisted restore gain/settings survive reload", { timeout: 20000 }, async t => {
  const state = session("performance");
  state.tracks[0].analysis = { bpm: 30, musicalKey: null, beatGridMs: Array.from({ length: 16 }, (_, i) => i * 2000) };
  state.tracks[0].stemMix = { drums: .7 };
  state.tracks[0].transition.cue = { toSessionTrackId: "b", fromDeck: 0, toDeck: 1, fromSeconds: 10, incomingSeconds: 0 };
  const page = await pageFor(t, "performance");
  await page.getByLabel("Snap stem changes").selectOption("beat");
  await page.getByTestId("session-play").click();
  await expect.poll(() => page.evaluate(() => window.audioSnapshot().some(x => x.rms > .06))).toBe(true);
  await page.getByRole("button", { name: "Mute drums", exact: true }).click();
  await expect(page.getByText(/Pending stem changes at source/)).toBeVisible();
  const target = Number((await page.getByText(/Pending stem changes at source/).innerText()).match(/source ([\d.]+)s/)[1]);
  // Observe the actual analyser and HTML source clock in the same renderer turn.
  const observations = await page.evaluate(async target => {
    const samples = [];
    await new Promise(resolve => {
      function sample() {
        const audio = [...document.querySelectorAll('audio')].find(a => !a.paused);
        if (!audio) return resolve();
        const rms = window.audioSnapshot()[0].rms;
        samples.push({ position: audio.currentTime, rms });
        if (audio.currentTime > target + .18) resolve(); else requestAnimationFrame(sample);
      }
      sample();
    });
    return samples;
  }, target);
  await mkdir(".data/waveyard-performance", { recursive: true });
  await writeFile(".data/waveyard-performance/quantised-audio.json", JSON.stringify({ scope: "Actual SessionExperience/useStemTransport, synthetic PCM and controlled HTTP persistence; NOT trained inference, database or native GUI", targetSourceSeconds: target, inputSha256: createHash("sha256").update(tones.get("a")).digest("hex"), observations }, null, 2));
  assert.ok(observations.some(x => x.position < target - .1 && x.rms > .06), "remains audible before scheduled beat");
  assert.ok(observations.filter(x => x.position < target - .08).every(x => x.rms > .04), "no premature mute");
  assert.ok(observations.some(x => x.position >= target && x.position < target + .15 && x.rms < .001), "actual audio muted near source beat");
  await expect.poll(() => state.tracks[0].stemMix.drums).toBe(0);
  assert.equal(state.tracks[0].transition.performance.recall.drums, .7);
  assert.equal(state.tracks[0].transition.cue.toSessionTrackId, "b", "performance preferences preserve completed transition cues");
  await page.getByTestId("session-play").click();
  await page.reload();
  await expect(page.getByLabel("Snap stem changes")).toHaveValue("beat");
  await page.getByRole("button", { name: "Restore stem mix", exact: true }).click();
  await expect.poll(() => state.tracks[0].stemMix.drums).toBe(.7);
  await page.getByTestId("session-play").click();
  await expect.poll(() => page.evaluate(() => window.audioSnapshot().some(x => x.rms > .06))).toBe(true);
});

test("queued performance is cancelled by pause and seek; unknown beat evidence cannot claim quantisation", { timeout: 20000 }, async t => {
  const state = session("performance-cancel");
  state.tracks[0].analysis = { bpm: 15, musicalKey: null, beatGridMs: [0, 4000, 8000, 12000, 16000, 20000, 24000, 28000] };
  const page = await pageFor(t, "performance-cancel");
  await page.getByLabel("Snap stem changes").selectOption("beat");
  await start(page);
  await page.getByRole("button", { name: "Mute drums", exact: true }).click();
  await expect(page.getByText(/Pending stem changes at source/)).toBeVisible();
  await page.getByTestId("session-play").click();
  await expect(page.getByText(/Pending stem changes at source/)).toHaveCount(0);
  assert.equal(state.tracks[0].stemMix.drums, 1);
  await page.getByTestId("session-play").click();
  await page.getByRole("button", { name: "Mute drums", exact: true }).click();
  await page.getByLabel("Session position").fill("6");
  await expect(page.getByText(/Pending stem changes at source/)).toHaveCount(0);
  await page.getByRole("button", { name: "Mute drums", exact: true }).click();
  await page.getByRole("button", { name: "Cancel pending stem changes" }).click();
  await expect(page.getByText(/Pending stem changes at source/)).toHaveCount(0);
  await audible(page, 220);
  const missing = await pageFor(t, "performance-missing-grid");
  await missing.getByLabel("Snap stem changes").selectOption("half");
  await start(missing);
  await missing.getByRole("button", { name: "Mute drums", exact: true }).click();
  await expect(missing.getByTestId("session-status")).toContainText("Cannot quantise");
  await audible(missing, 220);
});


test("isolate preserves the previous mix including a muted lane; Instant Restore bypasses beat delay", { timeout: 20000 }, async t => {
  const state = session("performance-isolate");
  state.tracks[0].stems.push({ id: "bass-a", stemType: "bass", engine: "synthetic-fixture" });
  state.tracks[0].playback.assetIds.push("bass-a");
  state.tracks[0].stemMix = { drums: .7, bass: .4 };
  state.tracks[0].analysis = { bpm: 30, musicalKey: null, beatGridMs: Array.from({ length: 16 }, (_, i) => i * 2000) };
  const page = await pageFor(t, "performance-isolate");
  await page.getByRole("button", { name: "Isolate bass", exact: true }).click();
  await expect.poll(() => state.tracks[0].stemMix.drums).toBe(0);
  await page.reload();
  await page.getByTestId("session-play").click();
  await expect.poll(() => page.evaluate(() => window.stemAudioSnapshot().find(x => x.label === "bass audio")?.rms ?? 0)).toBeGreaterThan(.04);
  await expect.poll(() => page.evaluate(() => window.stemAudioSnapshot().find(x => x.label === "drums audio")?.rms ?? 1)).toBeLessThan(.001);
  await page.getByLabel("Snap stem changes").selectOption("four-beats");
  await page.getByRole("button", { name: "Isolate bass", exact: true }).click();
  await expect(page.getByText(/Pending stem changes at source/)).toHaveCount(0);
  await expect.poll(() => page.evaluate(() => window.stemAudioSnapshot().find(x => x.label === "drums audio")?.rms ?? 0)).toBeGreaterThan(.06);
  await expect.poll(() => state.tracks[0].stemMix.drums).toBe(.7);
  assert.equal(state.tracks[0].stemMix.bass, .4);
});

test("rejected mix save stays visible and explicitly retries the latest settings through reload", { timeout: 20000 }, async t => {
  let reject = true, patches = 0;
  const page = await pageFor(t, "save-retry", async page => {
    await page.route("**/api/library/sessions/save-retry/tracks/*", async route => {
      patches++;
      if (reject) await route.fulfill({ status: 503, contentType: "application/json", body: '{"error":"offline fixture"}' });
      else await route.continue();
    });
  });
  await page.getByRole("button", { name: "Mute drums", exact: true }).click();
  await expect(page.getByLabel("Session edit save status")).toContainText("save failed");
  await expect(page.getByRole("alert")).toContainText("HTTP 503: offline fixture");
  assert.equal(session("save-retry").tracks[0].stemMix.drums, 1);
  await page.getByLabel("Snap stem changes").selectOption("half");
  await page.waitForTimeout(750);
  assert.equal(patches, 1, "failure must not silently retry");
  reject = false;
  await page.getByRole("button", { name: "Retry saving edits", exact: true }).click();
  await expect(page.getByLabel("Session edit save status")).toContainText("settings saved");
  assert.equal(session("save-retry").tracks[0].stemMix.drums, 0);
  assert.equal(session("save-retry").tracks[0].transition.performance.snap, "half");
  await page.reload();
  await expect(page.getByLabel("Snap stem changes")).toHaveValue("half");
  await expect(page.getByRole("button", { name: "Mute drums", exact: true })).toHaveAttribute("aria-pressed", "true");
});

test("an in-flight save is serialized with later edits even after advancing decks", { timeout: 20000 }, async t => {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  let requests = 0;
  const page = await pageFor(t, "save-order", async page => {
    await page.route("**/api/library/sessions/save-order/tracks/*", async route => {
      if (++requests === 1) await gate;
      await route.continue();
    });
  });
  t.after(() => release());
  await page.getByRole("button", { name: "Mute drums", exact: true }).click();
  await expect.poll(() => requests).toBe(1);
  await page.getByRole("button", { name: "Restore stem mix", exact: true }).click();
  await page.getByTestId("session-transition").click();
  await current(page, "Song B");
  await page.waitForTimeout(750);
  assert.equal(requests, 1, "cue and mix writes must not bypass a delayed predecessor");
  release();
  await expect(page.getByLabel("Session edit save status")).toContainText("settings saved");
  assert.equal(session("save-order").tracks[0].stemMix.drums, 1);
  assert.equal(session("save-order").tracks[0].transition.cue.toSessionTrackId, "b");
});

test("reload warns about an unacknowledged edit and flushes it without waiting for debounce", { timeout: 15000 }, async t => {
  const page = await pageFor(t, "save-close");
  let warned = false;
  page.on("dialog", async dialog => { warned = dialog.type() === "beforeunload"; await dialog.accept(); });
  await page.getByRole("button", { name: "Mute drums", exact: true }).click();
  await expect(page.getByLabel("Session edit save status")).toContainText("not saved yet");
  await page.reload();
  assert.equal(warned, true, "browser must warn before discarding unacknowledged state");
  await expect(page.getByRole("button", { name: "Mute drums", exact: true })).toHaveAttribute("aria-pressed", "true");
  assert.equal(session("save-close").tracks[0].stemMix.drums, 0);
});

test("acknowledged removal while saving cannot strand later deck edits behind a stale 404", { timeout: 15000 }, async t => {
  let release, started = false;
  const gate = new Promise(resolve => { release = resolve; });
  const page = await pageFor(t, "save-remove", async page => {
    await page.route("**/api/library/sessions/save-remove/tracks/a", async route => {
      started = true; await gate;
      await route.fulfill({ status: 404, contentType: "application/json", body: '{"error":"membership removed"}' });
    });
  });
  t.after(() => release());
  await page.getByRole("button", { name: "Mute drums", exact: true }).click();
  await expect.poll(() => started).toBe(true);
  await page.getByRole("button", { name: "Remove Song A", exact: true }).click();
  await current(page, "Song B");
  await page.getByRole("button", { name: "Mute drums", exact: true }).click();
  release();
  await expect(page.getByLabel("Session edit save status")).toContainText("settings saved");
  assert.equal(session("save-remove").tracks.some(item => item.id === "a"), false);
  assert.equal(session("save-remove").tracks[0].stemMix.drums, 0);
});
