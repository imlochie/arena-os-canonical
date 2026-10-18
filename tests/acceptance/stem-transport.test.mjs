import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { build } from "esbuild";
import { chromium } from "playwright-core";
import { expect } from "@playwright/test";

// No mocked audio nodes or hook implementation. Uses an installed Playwright
// browser, or CHROMIUM_EXECUTABLE_PATH for an explicitly supplied binary.
// This is browser playback acceptance, NOT Electron or model inference proof.
let server, browser, url;
function tone(frequency) {
  const rate = 44100, frames = rate * 2;
  const wav = Buffer.alloc(44 + frames * 2);
  wav.write("RIFF"); wav.writeUInt32LE(wav.length - 8, 4); wav.write("WAVEfmt ", 8);
  wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(rate, 24); wav.writeUInt32LE(rate * 2, 28);
  wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34);
  wav.write("data", 36); wav.writeUInt32LE(frames * 2, 40);
  for (let i = 0; i < frames; i++) wav.writeInt16LE(Math.round(8192 * Math.sin(2 * Math.PI * frequency * i / rate)), 44 + i * 2);
  return wav;
}
before(async () => {
  const bundled = await build({
    entryPoints: ["tests/acceptance/stem-transport.fixture.tsx"],
    bundle: true, write: false, platform: "browser", format: "iife", jsx: "automatic",
    define: { "process.env.NODE_ENV": '"development"' },
  });
  server = createServer((req, res) => {
    if (req.url === "/fixture.js") {
      res.setHeader("Content-Type", "text/javascript"); res.end(bundled.outputFiles[0].contents);
    } else if (req.url?.startsWith("/tones/")) {
      const audio = tone(req.url.includes("vocals") || req.url.includes("bass") ? 220 : 440);
      res.setHeader("Content-Type", "audio/wav");
      res.setHeader("Accept-Ranges", "bytes");
      const range = req.headers.range?.match(/^bytes=(\d+)-(\d*)$/);
      const start = range ? Number(range[1]) : 0;
      const end = range?.[2] ? Math.min(Number(range[2]), audio.length - 1) : audio.length - 1;
      if (range) {
        res.statusCode = 206;
        res.setHeader("Content-Range", `bytes ${start}-${end}/${audio.length}`);
      }
      res.setHeader("Content-Length", end - start + 1);
      res.end(audio.subarray(start, end + 1));
    } else {
      res.setHeader("Content-Type", "text/html");
      res.end('<!DOCTYPE html><div id="root"></div><script src="/fixture.js"></script>');
    }
  });
  await new Promise((resolve) => server.listen(0, "0.0.0.0", resolve));
  url = `http://127.0.0.1:${server.address().port}`;
  browser = await chromium.launch({
    executablePath: process.env.CHROMIUM_EXECUTABLE_PATH || undefined,
    headless: true, args: ["--no-sandbox", "--disable-dev-shm-usage"],
  });
  console.log(JSON.stringify({
    evidenceKind: "browser-audio-acceptance",
    browser: browser.version(),
    source: "src/lib/waveyard/useStemTransport.ts",
    sourceSha256: createHash("sha256").update(await readFile("src/lib/waveyard/useStemTransport.ts")).digest("hex"),
    inputs: "deterministic 2-second PCM tones (not separation outputs)",
    limitations: ["not Electron acceptance", "not inference evidence", "not sample-perfect synchronisation", "not full session/export acceptance"],
  }));
});
after(async () => {
  await browser?.close();
  await new Promise((resolve) => server ? server.close(resolve) : resolve());
});

async function fixture(t) {
  const page = await browser.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(url);
  await page.waitForFunction(() => window.transport && [...document.querySelectorAll("audio")].every((e) => e.readyState >= 2));
  t.after(async () => {
    await page.close();
    assert.deepEqual(errors, [], "no uncaught React/Web Audio errors");
  });
  return page;
}
async function start(page) {
  await page.getByRole("button", { name: "Play", exact: true }).click();
  await expect(page.getByTestId("playing")).toHaveText("true");
  await expect.poll(() => page.evaluate(() => window.transport.readMeters().master.rms)).toBeGreaterThan(0.05);
}

test("actual stem gain, mute, solo, seek and stop operate on the audio graph", { timeout: 20000 }, async (t) => {
  const page = await fixture(t);
  await start(page);
  await page.getByRole("button", { name: "Mute vocals" }).click();
  await expect.poll(() => page.evaluate(() => window.transport.readMeters().channels.vocals.rms)).toBeLessThan(0.001);
  assert.ok(await page.evaluate(() => window.transport.readMeters().channels.drums.rms > 0.05));
  await page.getByRole("button", { name: "Mute vocals" }).click();
  await expect.poll(() => page.evaluate(() => window.transport.readMeters().channels.vocals.rms)).toBeGreaterThan(0.05);
  await page.getByRole("button", { name: "Solo vocals" }).click();
  await expect.poll(() => page.evaluate(() => window.transport.readMeters().channels.drums.rms)).toBeLessThan(0.001);
  await page.getByRole("button", { name: "Lower vocals" }).click();
  await expect.poll(() => page.evaluate(() => window.transport.readMeters().channels.vocals.rms)).toBeLessThan(0.06);
  await page.getByRole("button", { name: "Seek", exact: true }).click();
  const times = await page.locator("audio").evaluateAll((elements) => elements.map((element) => element.currentTime));
  assert.ok(Math.abs(times[0] - times[1]) < 0.075, `stem drift ${times}`);
  assert.ok(times[0] >= 0.69 && times[0] < 1.1, `seek position ${times}`);
  await page.getByRole("button", { name: "Stop", exact: true }).click();
  await expect(page.getByTestId("playing")).toHaveText("false");
  assert.deepEqual(await page.locator("audio").evaluateAll((elements) => elements.map((element) => [element.paused, element.currentTime])), [[true, 0], [true, 0]]);
});

test("loop crosses multiple boundaries without stale-position restart or stalled clock", { timeout: 20000 }, async (t) => {
  const page = await fixture(t);
  await page.getByRole("button", { name: "Loop", exact: true }).click();
  await start(page);
  // Several loop wraps, measured against actual media times and hook state.
  await page.waitForTimeout(2100);
  const snapshot = await page.evaluate(() => ({
    playing: window.transport.playing, position: window.transport.position,
    times: [...document.querySelectorAll("audio")].map((e) => e.currentTime),
    rms: window.transport.readMeters().master.rms,
  }));
  assert.equal(snapshot.playing, true);
  assert.ok(snapshot.position >= 0.15 && snapshot.position < 0.9, JSON.stringify(snapshot));
  assert.ok(snapshot.times.every((time) => time >= 0.15 && time < 0.9), JSON.stringify(snapshot));
  assert.ok(snapshot.rms > 0.05);
});

test("equivalent asset refresh keeps playback and context alive; a new deck plays cleanly", { timeout: 20000 }, async (t) => {
  const page = await fixture(t);
  await start(page);
  await page.evaluate(() => window.refreshAssets());
  await page.waitForTimeout(200);
  await expect(page.getByTestId("playing")).toHaveText("true");
  assert.ok(await page.evaluate(() => window.transport.readMeters().master.rms > 0.05));
  await page.evaluate(() => window.replaceAssets());
  await expect(page.getByTestId("playing")).toHaveText("false");
  await page.waitForFunction(() => [...document.querySelectorAll("audio")].every((e) => e.readyState >= 2));
  await start(page);
  assert.deepEqual(await page.evaluate(() => Object.keys(window.transport.readMeters().channels).sort()), ["bass", "melody"]);
});

test("missing required stem fails the whole performance instead of reporting partial success", { timeout: 20000 }, async (t) => {
  const page = await fixture(t);
  await page.evaluate(() => window.removeElement());
  await page.getByRole("button", { name: "Play", exact: true }).click();
  await expect(page.getByTestId("error")).toContainText("not loaded");
  await expect(page.getByTestId("playing")).toHaveText("false");
  assert.ok(await page.locator("audio").evaluateAll((elements) => elements.every((element) => element.paused)));
});

test("master inserts restored before first play affect the real master signal", { timeout: 20000 }, async (t) => {
  const page = await fixture(t);
  await page.getByRole("button", { name: "Master insert" }).click();
  await page.getByRole("button", { name: "Play", exact: true }).click();
  await expect(page.getByTestId("playing")).toHaveText("true");
  await expect.poll(() => page.evaluate(() => window.transport.readMeters().channels.vocals.rms)).toBeGreaterThan(0.05);
  await expect.poll(() => page.evaluate(() => window.transport.readMeters().master.rms)).toBeGreaterThan(0.005);
  assert.ok(await page.evaluate(() => window.transport.readMeters().master.rms < 0.05));
});

test("end of audio clears playing state, without endless drift correction", { timeout: 20000 }, async (t) => {
  const page = await fixture(t);
  await start(page);
  await expect(page.getByTestId("playing")).toHaveText("false", { timeout: 5000 });
  assert.ok(await page.evaluate(() => window.transport.position > 1.8));
});


test("remounted media elements reconnect to their actual sources", { timeout: 20000 }, async (t) => {
  const page = await fixture(t);
  await start(page);
  await page.getByRole("button", { name: "Stop", exact: true }).click();
  await page.evaluate(() => window.remountElements());
  await page.waitForFunction(() => [...document.querySelectorAll("audio")].every((e) => e.readyState >= 2));
  await start(page);
});

test("pause cancels a pending start rather than allowing late audio", { timeout: 20000 }, async (t) => {
  const page = await fixture(t);
  // Controlled scheduling of real media playback, not a fake audio result.
  await page.evaluate(() => {
    const realPlay = HTMLMediaElement.prototype.play;
    HTMLMediaElement.prototype.play = function () {
      return new Promise((resolve, reject) => setTimeout(() => realPlay.call(this).then(resolve, reject), 250));
    };
  });
  await page.getByRole("button", { name: "Play", exact: true }).click();
  await page.getByRole("button", { name: "Pause", exact: true }).click();
  await page.waitForTimeout(500);
  await expect(page.getByTestId("playing")).toHaveText("false");
  assert.ok(await page.locator("audio").evaluateAll((elements) => elements.every((element) => element.paused)));
});

test("a media failure stops all stems and can recover after the file is restored", { timeout: 20000 }, async (t) => {
  const page = await fixture(t);
  await start(page);
  await page.evaluate(() => { document.querySelector('audio[data-id="drums"]').src = "/unreadable.wav"; });
  await expect(page.getByTestId("error")).toContainText("unavailable");
  await expect(page.getByTestId("playing")).toHaveText("false");
  assert.ok(await page.locator("audio").evaluateAll((elements) => elements.every((element) => element.paused)));
  await page.evaluate(() => { document.querySelector('audio[data-id="drums"]').src = "/tones/drums.wav"; });
  await page.waitForFunction(() => [...document.querySelectorAll("audio")].every((e) => e.readyState >= 2 && !e.error));
  await start(page);
  await expect(page.getByTestId("error")).toBeEmpty();
});

test("master recording tap produces decodable non-silent mixed audio", { timeout: 20000 }, async (t) => {
  const page = await fixture(t);
  await start(page);
  const recording = await page.evaluate(async () => {
    const stream = window.transport.masterTapStream();
    if (!stream) throw new Error("No master recording stream exists");
    const blob = await new Promise((resolve, reject) => {
      const recorder = new MediaRecorder(stream);
      const chunks = [];
      recorder.ondataavailable = (e) => chunks.push(e.data);
      recorder.onerror = reject;
      recorder.onstop = () => resolve(new Blob(chunks, { type: recorder.mimeType }));
      recorder.start();
      setTimeout(() => recorder.stop(), 350);
    });
    const context = new AudioContext();
    try {
      const audio = await context.decodeAudioData(await blob.arrayBuffer());
      const samples = audio.getChannelData(0);
      let energy = 0;
      for (const sample of samples) energy += sample * sample;
      return { bytes: blob.size, duration: audio.duration, rms: Math.sqrt(energy / samples.length) };
    } finally { await context.close(); }
  });
  assert.ok(recording.bytes > 100, JSON.stringify(recording));
  assert.ok(recording.duration > 0.1, JSON.stringify(recording));
  assert.ok(recording.rms > 0.03, JSON.stringify(recording));
});
