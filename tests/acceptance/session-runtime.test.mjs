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
const evidenceDir = process.env.ARENA_SESSION_EVIDENCE_DIR ?? `.data/acceptance/session-runtime/${Date.now()}-${process.pid}`;
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
          else state.swaps.push({ id: `swap-${state.swaps.length}`, fromStemAssetId: state.tracks.find(track => track.id === body.sessionTrackId)?.stems.find(stem => stem.stemType === body.stemType)?.id, toStemAssetId: body.toStemAssetId ?? "b", sessionTrackId: body.sessionTrackId, stemType: body.stemType, toTrackId: body.toTrackId, atSeconds: body.atSeconds });
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
  await expect(donor).toHaveAttribute("data-active-source", "b");
  await expect(donor).toHaveAttribute("src", "/api/assets/a"); // Original media stays the clock; real donor feeds the same analysed lane.
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
  await page.route("**/api/assets/b", async route => { await gate; await route.continue().catch(() => {}); });
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
  await audible(page, 220); // Pause cancelled the uncommitted donor; resuming must NOT silently replay it.
  await expect(audio).toHaveAttribute("data-active-source", "a");
  assert.deepEqual(session("slow-donor").swaps, []);
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
  await page.getByRole("group", { name: "Source for drums" }).getByRole("button", { name: "A · Song A", exact: true }).click();
  await audible(page, 220);
  release();
  await expect.poll(() => page.getByTestId("session-deck-current").locator("audio").evaluate(el => !el.paused && el.src.endsWith("/a"))).toBe(true);
  await page.unroute("**/api/assets/b");
  await page.route("**/api/assets/b", route => route.fulfill({ status: 404, body: "Missing retained audio" }));
  await page.getByRole("button", { name: "Swap", exact: true }).click();
  await expect(page.getByTestId("session-status")).toContainText("HTTP 404");
  assert.equal(await page.getByTestId("session-deck-current").locator("audio").evaluate(el => el.paused), false, "failed preparation does not pause the working mix");
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
  const evidence = { kind: "quantised-source-clock", scope: "Actual SessionExperience/useStemTransport, synthetic PCM and controlled HTTP persistence; NOT trained inference, database or native GUI", targetSourceSeconds: target, inputSha256: createHash("sha256").update(tones.get("a")).digest("hex"), observations };
  await mkdir(evidenceDir, { recursive: true });
  await writeFile(`${evidenceDir}/quantised-audio.json`, JSON.stringify(evidence, null, 2));
  console.log(JSON.stringify(evidence));
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

test("restore-point writes serialize a delayed seek before the latest stop and survive reload", { timeout: 15000 }, async t => {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const writes = [];
  const page = await pageFor(t, "cursor-order", async page => {
    await page.route("**/api/library/sessions/cursor-order/state", async route => {
      writes.push(route.request().postDataJSON());
      if (writes.length === 1) await gate;
      await route.continue();
    });
  });
  t.after(() => release());
  await page.getByLabel("Session position", { exact: true }).fill("4");
  await expect.poll(() => writes.length).toBe(1);
  await page.getByLabel("Session position", { exact: true }).fill("9");
  await page.getByTestId("session-stop").click();
  await page.waitForTimeout(250);
  assert.equal(writes.length, 1, "later cursor writes must wait for the unacknowledged predecessor");
  release();
  await expect(page.getByLabel("Restore point save status")).toHaveText("restore point saved");
  await expect.poll(() => session("cursor-order").positionSeconds).toBe(0);
  assert.equal(writes.at(-1).positionSeconds, 0);
  await page.reload();
  await expect(page.getByLabel("Session position", { exact: true })).toHaveValue("0");
});

test("restore-point rejection keeps the latest cursor for explicit retry and fresh page reopen", { timeout: 15000 }, async t => {
  let reject = true, attempts = 0;
  const page = await pageFor(t, "cursor-retry", async page => {
    await page.route("**/api/library/sessions/cursor-retry/state", async route => {
      attempts++;
      if (reject) await route.fulfill({ status: 503, contentType: "application/json", body: '{"error":"cursor storage unavailable"}' });
      else await route.continue();
    });
  });
  await page.getByLabel("Session position", { exact: true }).fill("8");
  await expect(page.getByLabel("Restore point save status")).toContainText("save failed");
  await expect(page.getByRole("alert")).toContainText("HTTP 503: cursor storage unavailable");
  await page.getByLabel("Session position", { exact: true }).fill("11");
  assert.equal(session("cursor-retry").positionSeconds, 0);
  assert.equal(attempts, 1);
  reject = false;
  await page.getByRole("button", { name: "Retry saving restore point", exact: true }).click();
  await expect(page.getByLabel("Restore point save status")).toHaveText("restore point saved");
  assert.equal(session("cursor-retry").positionSeconds, 11);
  await page.reload();
  await expect(page.getByLabel("Session position", { exact: true })).toHaveValue("11");
});

const categories = ["vocals", "drums", "bass", "instruments"];
const sourceHz = { a: [220, 440, 660, 880], b: [1100, 1320, 1540, 1760] };
function fourSongSession(id, levels = [.73, .41, .62, .91]) {
  const state = session(id); state.tracks = state.tracks.slice(0, 2);
  for (const [index, track] of state.tracks.entries()) {
    const song = index ? "b" : "a";
    track.stems = categories.map((stemType, i) => {
      const asset = `four-${song}-${stemType}`;
      if (!tones.has(asset)) tones.set(asset, tone(sourceHz[song][i]));
      return { id: asset, stemType, engine: "synthetic-fixture" };
    });
    track.playback.assetIds = track.stems.map(stem => stem.id);
    track.stemMix = Object.fromEntries(categories.map((name, i) => [name, levels[i]]));
  }
  return state;
}
async function laneSignals(page) {
  return page.evaluate(({ categories, sourceHz }) => Object.fromEntries(window.observedAudio.flatMap(({ context, stems }) => stems.filter(({ element }) => element.getAttribute("src")?.startsWith("/api/assets/four-a-")).map(({ node, element }) => {
    const category = element.getAttribute("src").split("four-a-")[1], index = categories.indexOf(category);
    const pcm = new Float32Array(node.fftSize); node.getFloatTimeDomainData(pcm);
    const amplitude = hz => { let re = 0, im = 0; for (let i = 0; i < pcm.length; i++) { const phase = 2 * Math.PI * hz * i / context.sampleRate; re += pcm[i] * Math.cos(phase); im += pcm[i] * Math.sin(phase); } return 2 * Math.hypot(re, im) / pcm.length; };
    return [category, { a: amplitude(sourceHz.a[index]), b: amplitude(sourceHz.b[index]), rms: Math.sqrt(pcm.reduce((sum, x) => sum + x*x, 0) / pcm.length), position: element.currentTime }];
  }))), { categories, sourceHz });
}
async function assertFourSources(page, selection, levels = [.73, .41, .62, .91]) {
  await expect.poll(async () => {
    const signals = await laneSignals(page);
    if (process.env.DEBUG_SESSION) console.log("four-lane-probe", JSON.stringify(signals));
    return categories.every((category, i) => {
      const signal = signals[category], selected = selection[category] ?? "a", other = selected === "a" ? "b" : "a";
      return signal && (levels[i] === 0 ? signal.rms < .001 : Math.abs(signal[selected] - .25 * Math.SQRT1_2 * levels[i]) < .01 && signal[other] < .015);
    });
  }, { intervals: [10] }).toBe(true);
}

test("four independent lane signals prove repeated A/B replacements in every category, unchanged levels, and saved recall", { timeout: 35000 }, async t => {
  const state = fourSongSession("four-sources");
  const page = await pageFor(t, "four-sources");
  await page.getByTestId("session-play").click();
  const selected = {};
  await assertFourSources(page, selected);
  await page.getByRole("button", { name: "Mute bass", exact: true }).click();
  await page.getByRole("group", { name: "Source for vocals", exact: true }).getByRole("button", { name: "B · Song B", exact: true }).click();
  await assertFourSources(page, { vocals: "b" }, [.73, .41, 0, .91]);
  await page.getByRole("button", { name: "Mute bass", exact: true }).click();
  await page.getByRole("group", { name: "Source for vocals", exact: true }).getByRole("button", { name: "A · Song A", exact: true }).click();
  await assertFourSources(page, {});
  const observations = [];
  for (let repeat = 0; repeat < 2; repeat++) for (const category of categories) for (const song of ["b", "a"]) {
    const before = await laneSignals(page);
    await page.getByRole("group", { name: `Source for ${category}`, exact: true }).getByRole("button", { name: `${song.toUpperCase()} · Song ${song.toUpperCase()}`, exact: true }).click();
    selected[category] = song;
    await assertFourSources(page, selected);
    const after = await laneSignals(page);
    for (const other of categories.filter(name => name !== category)) assert.ok(Math.abs(before[other][selected[other] ?? "a"] - after[other][selected[other] ?? "a"]) < .02, `${other} signal unchanged by ${category}`);
    observations.push({ category, song, repeat, before, after });
  }
  await page.getByRole("group", { name: "Source for vocals", exact: true }).getByRole("button", { name: "B · Song B", exact: true }).click();
  await assertFourSources(page, { vocals: "b" });
  await expect(page.getByLabel("Stem selection save status")).toContainText("saved");
  assert.equal(state.swaps.filter(swap => swap.stemType === "vocals").at(-1).toStemAssetId, "four-b-vocals");
  await page.reload(); await page.getByTestId("session-play").click();
  await assertFourSources(page, { vocals: "b" });
  console.log(JSON.stringify({ kind: "four-category-independent-lane-signals", scope: "real UI/WebAudio, synthetic distinguishable PCM, controlled HTTP not SQL or inference", observations }));
});

test("true held isolation restores exact non-unity/pre-muted mix on outside release, cancellation, blur, seek and touch release", { timeout: 25000 }, async t => {
  const levels = [.73, .41, 0, .91], state = fourSongSession("held-four", levels), original = { ...state.tracks[0].stemMix };
  const page = await pageFor(t, "held-four"); await page.getByTestId("session-play").click();
  await assertFourSources(page, {}, levels);
  const hold = page.getByRole("button", { name: "Hold to isolate bass", exact: true });
  const held = async () => expect.poll(async () => { const signals = await laneSignals(page); return Math.abs((signals.bass?.a ?? 0) - .25 * Math.SQRT1_2) < .01 && categories.filter(name => name !== "bass").every(name => signals[name]?.rms < .001); }).toBe(true);
  for (const interruption of ["outside-release", "pointercancel", "lostcapture", "blur", "seek"]) {
    await hold.hover(); await page.mouse.down(); await held();
    if (interruption === "outside-release") { await page.mouse.move(1, 1); await page.mouse.up(); }
    if (interruption === "pointercancel") { await hold.dispatchEvent("pointercancel", { pointerId: 1 }); await page.mouse.up(); }
    if (interruption === "lostcapture") { await hold.dispatchEvent("lostpointercapture", { pointerId: 1 }); await page.mouse.up(); }
    if (interruption === "blur") { await page.evaluate(() => window.dispatchEvent(new Event("blur"))); await page.mouse.up(); }
    if (interruption === "seek") { await page.getByLabel("Session position", { exact: true }).fill("5"); await page.mouse.up(); }
    await assertFourSources(page, {}, levels);
    assert.deepEqual(state.tracks[0].stemMix, original, "temporary monitoring never persisted as a new mix");
  }
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 1 });
  await hold.scrollIntoViewIfNeeded();
  const box = await hold.boundingBox();
  await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: box.x + box.width/2, y: box.y + box.height/2 }] });
  await held();
  await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  await assertFourSources(page, {}, levels);
  assert.deepEqual(state.tracks[0].stemMix, original);
});

test("held quantised start/release and persisted Instant Restore use actual source clock; a short hold cannot stick later", { timeout: 25000 }, async t => {
  const state = fourSongSession("held-boundaries");
  state.tracks[0].analysis = { bpm: 30, musicalKey: null, beatGridMs: Array.from({ length: 16 }, (_, i) => i*2000) };
  state.tracks[0].transition.performance = { snap: "beat", instantRestore: false, recall: {}, isolatedStem: null, beforeIsolation: null };
  const page = await pageFor(t, "held-boundaries"); await page.getByTestId("session-play").click();
  const audio = page.getByTestId("session-deck-current").locator("audio").first();
  const hold = page.getByRole("button", { name: "Hold to isolate vocals", exact: true });
  await hold.hover(); await page.mouse.down(); await page.mouse.up();
  await expect.poll(() => audio.evaluate(el => el.currentTime > 2.15)).toBe(true);
  await assertFourSources(page, {});
  await hold.hover(); await page.mouse.down();
  await expect.poll(async () => (await laneSignals(page)).drums?.rms < .001, { intervals: [10] }).toBe(true);
  const startAt = await audio.evaluate(el => el.currentTime); assert.ok(startAt >= 4 && startAt < 4.15, `held start at measured 4s: ${startAt}`);
  await page.mouse.up();
  await expect(page.getByRole("status", { name: "", exact: true }).filter({ hasText: "Pending stem changes" })).toBeVisible();
  assert.ok((await laneSignals(page)).drums.rms < .001, "Instant Restore off keeps the actual isolation until the next beat");
  await assertFourSources(page, {});
  const restoredAt = await audio.evaluate(el => el.currentTime); assert.ok(restoredAt >= 6 && restoredAt < 6.15, `held restore at 6s: ${restoredAt}`);
  await page.getByLabel("Instant Restore", { exact: true }).check();
  await hold.hover(); await page.mouse.down();
  await expect.poll(async () => (await laneSignals(page)).drums?.rms < .001, { intervals: [10] }).toBe(true);
  await page.mouse.up(); await assertFourSources(page, {});
  assert.ok(await audio.evaluate(el => el.currentTime) < 9, "Instant Restore on audibly restores without waiting for beat 10");
  await expect(page.getByLabel("Session edit save status")).toContainText("saved");
  assert.equal(state.tracks[0].transition.performance.instantRestore, true);
});

for (const [snap, bpm, rate] of [["off", 80, 1], ["quarter", 80, 1], ["half", 137, 1], ["beat", 80, 1.25], ["quarter", 137, 1.25]]) {
  test(`prepared ${snap} swap: audible measured boundary at ${bpm} BPM, nonzero origin/offset, rate ${rate}`, { timeout: 15000 }, async t => {
    const id = `prepared-${snap}-${bpm}-${rate}`, state = session(id), grid = Array.from({ length: 50 }, (_, i) => Math.round(125 + i * 60000 / bpm));
    state.tracks[0].analysis = { bpm, musicalKey: null, beatGridMs: grid };
    state.tracks[0].transition.performance = { snap: "off", instantRestore: true, recall: {}, isolatedStem: null, beforeIsolation: null };
    const page = await pageFor(t, id, async candidate => candidate.addInitScript(() => {
      window.bufferStarts = [];
      const nativeStart = AudioBufferSourceNode.prototype.start;
      AudioBufferSourceNode.prototype.start = function(when, offset, ...rest) {
        window.bufferStarts.push({ when, offset, contextTime: this.context.currentTime, rate: this.playbackRate.value });
        return nativeStart.call(this, when, offset, ...rest);
      };
    }));
    await start(page);
    // Exercise preparation separately: the measured gesture below switches an
    // already validated/decoded donor. Cold/missed preparation is tested below.
    await page.getByRole("button", { name: "Swap", exact: true }).click(); await audible(page, 440);
    await page.getByRole("button", { name: "Revert", exact: true }).click(); await audible(page, 220);
    await page.getByLabel("Snap stem changes", { exact: true }).selectOption(snap);
    await page.evaluate(() => { window.bufferStarts = []; });
    await page.getByTestId("session-deck-current").locator("audio").evaluate((audio, rate) => { audio.playbackRate = rate; audio.preservesPitch = false; }, rate);
    await audible(page, 220*rate);
    const divisions = snap === "quarter" ? 4 : snap === "half" ? 2 : 1;
    const target = (grid[8] + (grid[9] - grid[8]) * (divisions === 4 ? .75 : divisions === 2 ? .5 : 1)) / 1000;
    const result = await page.evaluate(async ({ target, rate, snap }) => {
      const deck = document.querySelector('[data-testid="session-deck-current"]'), audio = deck.querySelector("audio");
      // Playback rate was settled before this measured, nonzero-offset seek.
      await new Promise(resolve => { audio.addEventListener("seeked", resolve, { once: true }); audio.currentTime = target - .065 * rate; });
      await new Promise(requestAnimationFrame);
      const before = audio.currentTime;
      const measured = [];
      const sample = () => {
        const raw = window.observedAudio.filter(({ context }) => context.state === "running").map(({ context, analysers }) => {
          const pcm = new Float32Array(analysers[0].fftSize); analysers[0].getFloatTimeDomainData(pcm);
          const amplitude = hz => { let re = 0, im = 0; for (let i = 0; i < pcm.length; i++) { const phase = 2*Math.PI*hz*i/context.sampleRate; re += pcm[i]*Math.cos(phase); im += pcm[i]*Math.sin(phase); } return 2*Math.hypot(re, im)/pcm.length; };
          return { a: amplitude(220*rate), b: amplitude(440*rate) };
        });
        measured.push({ sourceSeconds: audio.currentTime, signals: window.audioSnapshot(), raw });
      };
      sample();
      document.querySelector('[role="group"][aria-label="Source for drums"]').querySelectorAll("button")[1].click();
      while (audio.currentTime < target + .16) { await new Promise(requestAnimationFrame); sample(); }
      return { before, measured, starts: window.bufferStarts, status: document.querySelector('[data-testid="session-status"]').textContent };
    }, { target, rate, snap });
    assert.equal(result.starts.length, 1, JSON.stringify(result));
    if (snap !== "off") assert.ok(Math.abs(result.starts[0].offset - target) < 1e-6, `prepared source offset equals measured boundary: ${JSON.stringify(result.starts)}`);
    assert.equal(result.starts[0].rate, rate);
    const expected = snap === "off" ? result.before : target;
    const firstDonor = result.measured.find(sample => sample.raw.some(signal => signal.b > .025));
    assert.ok(firstDonor, JSON.stringify(result));
    assert.ok(firstDonor.sourceSeconds >= expected - .025 && firstDonor.sourceSeconds <= expected + .08, JSON.stringify({ expected, firstDonor, result }));
    for (const sample of result.measured.filter(sample => sample.sourceSeconds < expected - .025)) assert.ok(sample.signals.some(signal => signal.rms > .08 && Math.abs(signal.hz - 220*rate) < 30), `original remains audible until its boundary: ${JSON.stringify(result)}`);
    console.log(JSON.stringify({ kind: "prepared-audible-source-boundary", snap, bpm, rate, target: expected, result, scope: "real UI/WebAudio and independent actual signal, synthetic PCM/controlled HTTP, no trained/key-match claim" }));
  });
}

test("missed donor preparation, decode error, rapid supersession, pause/seek, and unavailable bar never save a pending success", { timeout: 20000 }, async t => {
  const state = session("prepared-fences");
  state.tracks[0].analysis = { bpm: 120, musicalKey: null, beatGridMs: Array.from({ length: 61 }, (_, i) => i*500) };
  state.tracks[0].transition.performance = { snap: "beat", instantRestore: true, recall: {}, isolatedStem: null, beforeIsolation: null };
  const page = await pageFor(t, "prepared-fences"); await start(page);
  let release; const gate = new Promise(resolve => { release = resolve; }); t.after(() => release());
  await page.route("**/api/assets/b", async route => { await gate; await route.continue().catch(() => {}); });
  const audio = page.getByTestId("session-deck-current").locator("audio").first();
  const requested = page.waitForRequest("**/api/assets/b");
  await page.getByRole("button", { name: "Swap", exact: true }).click(); await requested;
  await expect.poll(() => audio.evaluate(el => el.currentTime > 1.2)).toBe(true);
  release(); await expect(page.getByTestId("session-status")).toContainText("missed");
  await audible(page, 220); assert.deepEqual(state.swaps, []);
  await page.getByLabel("Snap stem changes", { exact: true }).selectOption("bar");
  await page.getByRole("button", { name: "Swap", exact: true }).click();
  await expect(page.getByTestId("session-status")).toContainText("no verified downbeat");
  assert.deepEqual(state.swaps, []); await audible(page, 220);
  await page.getByLabel("Snap stem changes", { exact: true }).selectOption("off");
  // Use a fresh asset identity so the deliberately decoded-but-late donor
  // cache cannot disguise the following corrupt response.
  state.tracks[1].stems[0].id = "corrupt-donor"; state.tracks[1].playback.assetIds = ["corrupt-donor"];
  tones.set("corrupt-donor", Buffer.from("not audio"));
  await page.reload(); await start(page);
  await page.getByRole("button", { name: "Swap", exact: true }).click();
  await expect(page.getByTestId("session-status")).toContainText(/decod|audio/i);
  await audible(page, 220); assert.deepEqual(state.swaps, []);
});

test("audible selection survives failed saves; acknowledged serial retry saves latest rapid A/B intent and reloads it", { timeout: 20000 }, async t => {
  const state = fourSongSession("selection-save"); const page = await pageFor(t, "selection-save");
  await page.getByTestId("session-play").click(); await assertFourSources(page, {});
  const source = page.getByRole("group", { name: "Source for vocals", exact: true });
  let posts = 0, release; const gate = new Promise(resolve => { release = resolve; }); t.after(() => release());
  await page.route("**/api/library/sessions/selection-save/swaps?*", async route => {
    posts++;
    if (posts === 1) { await gate; await route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ error: "Controlled selection rejection" }) }); }
    else await route.continue();
  });
  await source.getByRole("button", { name: "B · Song B", exact: true }).click(); await assertFourSources(page, { vocals: "b" });
  await expect.poll(() => posts).toBe(1);
  await source.getByRole("button", { name: "A · Song A", exact: true }).click(); await assertFourSources(page, {});
  await source.getByRole("button", { name: "B · Song B", exact: true }).click(); await assertFourSources(page, { vocals: "b" });
  assert.equal(posts, 1, "latest selections cannot race a withheld predecessor ACK");
  release(); await expect(page.getByLabel("Stem selection save status")).toContainText("error");
  await assertFourSources(page, { vocals: "b" }); assert.deepEqual(state.swaps, [], "HTTP failure was not a saved selection");
  await page.getByRole("button", { name: "Retry saving stem selections", exact: true }).click();
  await expect(page.getByLabel("Stem selection save status")).toContainText("saved");
  assert.equal(posts, 2); assert.equal(state.swaps.at(-1).toStemAssetId, "four-b-vocals");
  await page.reload(); await page.getByTestId("session-play").click(); await assertFourSources(page, { vocals: "b" });
});

test("held isolation cannot stick across AudioContext interruption and committed donor resumes after seek/pause", { timeout: 15000 }, async t => {
  fourSongSession("context-hold"); const page = await pageFor(t, "context-hold");
  await page.getByTestId("session-play").click(); await assertFourSources(page, {});
  await page.getByRole("group", { name: "Source for drums", exact: true }).getByRole("button", { name: "B · Song B", exact: true }).click();
  await assertFourSources(page, { drums: "b" });
  const hold = page.getByRole("button", { name: "Hold to isolate vocals", exact: true });
  await hold.hover(); await page.mouse.down();
  await expect.poll(async () => (await laneSignals(page)).drums?.rms < .001).toBe(true);
  await page.evaluate(async () => { await Promise.all(window.observedAudio.filter(({ context }) => context.state === "running").map(({ context }) => context.suspend())); });
  await expect(page.getByTestId("session-play")).toHaveText("Play");
  await page.mouse.up(); await page.getByTestId("session-play").click(); await assertFourSources(page, { drums: "b" });
  await page.getByLabel("Session position", { exact: true }).fill("8"); await assertFourSources(page, { drums: "b" });
  await page.getByTestId("session-play").click(); await page.getByTestId("session-play").click(); await assertFourSources(page, { drums: "b" });
});

test("prepared start failure preserves audio; scheduled swaps are fenced by seek and playback-rate changes", { timeout: 20000 }, async t => {
  const state = session("start-and-schedule-fences");
  state.tracks[0].analysis = { bpm: 30, musicalKey: null, beatGridMs: Array.from({ length: 16 }, (_, i) => i*2000) };
  const page = await pageFor(t, "start-and-schedule-fences", candidate => candidate.addInitScript(() => {
    const native = AudioBufferSourceNode.prototype.start;
    window.rejectDonorStart = true;
    AudioBufferSourceNode.prototype.start = function(...args) { if (window.rejectDonorStart) throw new DOMException("Controlled donor start rejection", "NotSupportedError"); return native.apply(this, args); };
  }));
  await start(page);
  await page.getByRole("button", { name: "Swap", exact: true }).click();
  await expect(page.getByTestId("session-status")).toContainText("could not start");
  await audible(page, 220); assert.deepEqual(state.swaps, []);
  await page.evaluate(() => { window.rejectDonorStart = false; });
  await page.getByRole("button", { name: "Swap", exact: true }).click(); await audible(page, 440);
  await page.getByRole("button", { name: "Revert", exact: true }).click(); await audible(page, 220);
  await expect(page.getByLabel("Stem selection save status")).toContainText("saved");
  const committed = state.swaps.length;
  await page.getByLabel("Snap stem changes", { exact: true }).selectOption("beat");
  await page.getByRole("button", { name: "Swap", exact: true }).click();
  await expect(page.getByTestId("session-status")).toContainText("scheduled at source");
  await page.getByLabel("Session position", { exact: true }).fill("5");
  await audible(page, 220); await expect(page.getByTestId("session-status")).toContainText("cancelled");
  assert.equal(state.swaps.length, committed);
  await page.getByRole("button", { name: "Swap", exact: true }).click();
  await expect(page.getByTestId("session-status")).toContainText("scheduled at source");
  await page.getByTestId("session-deck-current").locator("audio").evaluate(audio => { audio.playbackRate = 1.25; });
  await expect(page.getByTestId("session-status")).toContainText("cancelled");
  await audible(page, 220); assert.equal(state.swaps.length, committed);
});

test("removing a membership forgets only its acknowledged selection writes and cannot poison a later donor save", { timeout: 20000 }, async t => {
  const state = session("selection-removal"); const page = await pageFor(t, "selection-removal"); await start(page);
  let release, posts = 0; const gate = new Promise(resolve => { release = resolve; }); t.after(() => release());
  await page.route("**/api/library/sessions/selection-removal/swaps?*", async route => {
    posts++;
    if (posts === 1) { await gate; await route.fulfill({ status: 404, contentType: "application/json", body: JSON.stringify({ error: "Membership removed after this write started" }) }); }
    else await route.continue();
  });
  await page.getByRole("button", { name: "Swap", exact: true }).click(); await audible(page, 440);
  await expect.poll(() => posts).toBe(1);
  await page.getByRole("button", { name: "Remove Song A", exact: true }).click(); await current(page, "Song B");
  await page.getByTestId("session-play").click(); await audible(page, 440);
  await page.getByRole("button", { name: "Swap", exact: true }).click(); await audible(page, 880);
  release(); await expect(page.getByLabel("Stem selection save status")).toContainText("saved");
  assert.equal(posts, 2); assert.equal(state.swaps.at(-1).sessionTrackId, "b"); assert.equal(state.swaps.at(-1).toStemAssetId, "c");
});

function fixtureBoundary(seconds, grid, snap) {
  const divisions = snap === "quarter" ? 4 : snap === "half" ? 2 : 1;
  for (let i = 0; i < grid.length - 1; i++) for (let part = 0; part < divisions; part++) {
    const boundary = (grid[i] + (grid[i+1] - grid[i])*part/divisions)/1000;
    if (boundary > seconds + .000001) return boundary;
  }
  throw new Error("Fixture grid exhausted");
}
async function waitForMonitorGestureLead(page, grid, snap) {
  // Keep this positive full-window observation case away from DOM locator
  // races at very short subdivisions. Near-boundary swaps have separate raw
  // waveform tests; this does not relax an audio assertion or a deadline.
  await page.evaluate(async ({ grid, divisions }) => {
    const audio = document.querySelector('[data-testid="session-deck-current"] audio');
    for (;;) {
      const now = audio.currentTime;
      let next = null;
      for (let i = 0; i < grid.length-1 && next === null; i++) for (let part = 0; part < divisions; part++) {
        const boundary = (grid[i] + (grid[i+1]-grid[i])*part/divisions)/1000;
        if (boundary > now + .000001) { next = boundary; break; }
      }
      if (next === null) throw new Error("Fixture beat grid exhausted");
      if (next-now > .16) return;
      await new Promise(requestAnimationFrame);
    }
  }, { grid, divisions: snap === "quarter" ? 4 : snap === "half" ? 2 : 1 });
}
async function recordDrumsThrough(page, target) {
  return page.evaluate(async target => {
    const observed = window.observedAudio.flatMap(({ stems }) => stems).find(({ element }) => element.getAttribute("src") === "/api/assets/four-a-drums");
    const observations = [];
    do {
      await new Promise(requestAnimationFrame);
      const pcm = new Float32Array(observed.node.fftSize); observed.node.getFloatTimeDomainData(pcm);
      observations.push({ sourceSeconds: observed.element.currentTime, rms: Math.sqrt(pcm.reduce((s,x) => s+x*x, 0)/pcm.length) });
    } while (observed.element.currentTime < target + .15);
    return observations;
  }, target);
}
for (const [snap, bpm] of [["quarter", 80], ["half", 137], ["beat", 120]]) {
  test(`${snap} mute and true held start/release audibly follow measured ${bpm} BPM boundaries with nonzero offset`, { timeout: 20000 }, async t => {
    const id = `monitor-${snap}-${bpm}`, state = fourSongSession(id), grid = Array.from({ length: 65 }, (_, i) => Math.round(125 + i*60000/bpm));
    state.tracks[0].analysis = { bpm, musicalKey: null, beatGridMs: grid };
    state.tracks[0].transition.performance = { snap, instantRestore: false, recall: {}, isolatedStem: null, beforeIsolation: null };
    state.positionSeconds = 3.2;
    const page = await pageFor(t, id); await page.getByTestId("session-play").click(); await assertFourSources(page, {});
    const audio = page.getByTestId("session-deck-current").locator("audio").first();
    const records = [];
    for (const muted of [true, false]) {
      await waitForMonitorGestureLead(page, grid, snap);
      const before = await audio.evaluate(el => el.currentTime);
      await page.getByRole("button", { name: "Mute drums", exact: true }).click();
      const after = await audio.evaluate(el => el.currentTime);
      const pending = page.getByRole("status").filter({ hasText: /^Pending stem changes/ });
      const match = (await pending.innerText()).match(/source ([\d.]+)s/); assert.ok(match);
      const target = Number(match[1]);
      assert.ok([fixtureBoundary(before, grid, snap), fixtureBoundary(after, grid, snap)].some(value => Math.abs(value-target) < .0011), "target is the next measured subdivision of the actual gesture, not a wall clock");
      const samples = await recordDrumsThrough(page, target);
      for (const sample of samples.filter(sample => sample.sourceSeconds < target-.005)) assert.ok(muted ? sample.rms > .04 : sample.rms < .001, "no premature audible mute/unmute");
      assert.ok(samples.some(sample => sample.sourceSeconds >= target && sample.sourceSeconds <= target+.15 && (muted ? sample.rms < .001 : sample.rms > .04)), JSON.stringify(samples));
      records.push({ action: muted ? "mute" : "unmute", before, after, target, samples });
    }
    const hold = page.getByRole("button", { name: "Hold to isolate vocals", exact: true }); await hold.hover();
    for (const starting of [true, false]) {
      await waitForMonitorGestureLead(page, grid, snap);
      const before = await audio.evaluate(el => el.currentTime);
      if (starting) await page.mouse.down(); else await page.mouse.up();
      const after = await audio.evaluate(el => el.currentTime);
      const pending = page.getByRole("status").filter({ hasText: /^Pending stem changes/ });
      const match = (await pending.innerText()).match(/source ([\d.]+)s/); assert.ok(match);
      const target = Number(match[1]);
      assert.ok([fixtureBoundary(before, grid, snap), fixtureBoundary(after, grid, snap)].some(value => Math.abs(value-target) < .0011));
      const samples = await recordDrumsThrough(page, target);
      for (const sample of samples.filter(sample => sample.sourceSeconds < target-.005)) assert.ok(starting ? sample.rms > .04 : sample.rms < .001, "held isolation/release never applies early");
      assert.ok(samples.some(sample => sample.sourceSeconds >= target && sample.sourceSeconds <= target+.15 && (starting ? sample.rms < .001 : sample.rms > .04)), JSON.stringify(samples));
      records.push({ action: starting ? "hold-start" : "hold-release", before, after, target, samples });
    }
    await assertFourSources(page, {});
    console.log(JSON.stringify({ kind: "source-clock-monitor-boundaries", snap, bpm, records, scope: "raw independent drums lane PCM; controlled HTTP/synthetic input, 150ms full-window settle bound, existing 80ms dispatch guard unchanged" }));
  });
}

test("a shorter committed donor ends only its lane, reports silence honestly, and returns to A without stopping other categories", { timeout: 15000 }, async t => {
  const state = fourSongSession("donor-end");
  const short = Buffer.from(tones.get("four-b-drums").subarray(0, 44+44100*2)); short.writeUInt32LE(short.length-8,4); short.writeUInt32LE(short.length-44,40);
  tones.set("short-donor", short); state.tracks[1].stems[1].id = "short-donor"; state.tracks[1].playback.assetIds[1] = "short-donor";
  const page = await pageFor(t, "donor-end"); await page.getByTestId("session-play").click(); await assertFourSources(page, {});
  const source = page.getByRole("group", { name: "Source for drums", exact: true });
  await source.getByRole("button", { name: "B · Song B", exact: true }).click(); await assertFourSources(page, { drums: "b" });
  await expect(page.getByRole("status").filter({ hasText: "drums donor ended" })).toBeVisible();
  assert.equal(await page.getByTestId("session-deck-current").locator("audio").first().evaluate(el => el.paused), false);
  await assertFourSources(page, {}, [.73, 0, .62, .91]);
  await source.getByRole("button", { name: "A · Song A", exact: true }).click(); await assertFourSources(page, {});
  await expect(page.getByRole("status").filter({ hasText: "drums donor ended" })).toHaveCount(0);
});

test("an already-audible donor is not rolled back or duplicated when its UI completion frame is delayed and B is pressed again", { timeout: 15000 }, async t => {
  session("due-rapid"); const page = await pageFor(t, "due-rapid", candidate => candidate.addInitScript(() => {
    window.voiceStarts = 0; window.holdCompletionFrames = false; window.heldFrames = [];
    const nativeStart = AudioBufferSourceNode.prototype.start;
    AudioBufferSourceNode.prototype.start = function(...args) { window.voiceStarts++; return nativeStart.apply(this,args); };
    const raf = window.requestAnimationFrame.bind(window);
    window.requestAnimationFrame = callback => raf(time => { if (window.holdCompletionFrames) window.heldFrames.push(callback); else callback(time); });
    window.releaseCompletionFrames = () => { window.holdCompletionFrames = false; for (const callback of window.heldFrames.splice(0)) raf(callback); };
  }));
  await start(page);
  await page.evaluate(() => { window.holdCompletionFrames = true; });
  const source = page.getByRole("group", {name:"Source for drums", exact:true});
  await source.getByRole("button",{name:"B · Song B", exact:true}).click();
  await audible(page,440);
  assert.equal(await page.evaluate(() => window.voiceStarts),1);
  await expect(source.getByRole("button",{name:"A · Song A",exact:true})).toHaveAttribute("aria-pressed","true");
  const before = await page.evaluate(() => ({ starts: window.voiceStarts, signal: window.audioSnapshot() }));
  await source.getByRole("button",{name:"B · Song B",exact:true}).click();
  await expect(source.getByRole("button",{name:"B · Song B",exact:true})).toHaveAttribute("aria-pressed","true");
  assert.equal(await page.evaluate(() => window.voiceStarts),1,"already executed source commit is promoted, not rolled back and restarted");
  await page.evaluate(() => window.releaseCompletionFrames());
  await audible(page,440);
  console.log(JSON.stringify({kind:"already-audible-latest-intent",before,after:await page.evaluate(() => ({ starts: window.voiceStarts, signal: window.audioSnapshot() })),scope:"actual scheduled audio with deliberately withheld UI/clock frames; a newer identical B intent must not restart or roll back it"}));
});
