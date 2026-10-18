import { before, after, test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { build } from "esbuild";
import { chromium } from "playwright-core";
import { expect } from "@playwright/test";

let server, browser, origin;
const sessions = new Map();
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
const tones = new Map([['a', tone(220)], ['b', tone(440)], ['c', tone(880)]]);
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
      if (req.method !== "GET") {
        let raw = ""; for await (const chunk of req) raw += chunk;
        const body = JSON.parse(raw || "{}");
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
        super(...args); const analysers = [], original = this.createAnalyser.bind(this);
        this.createAnalyser = () => { const node = original(); analysers.push(node); return node; };
        window.observedAudio.push({ context: this, analysers });
      }
    };
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
