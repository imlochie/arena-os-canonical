import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { createServer } from "node:http";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const apiRequire = createRequire(new URL("../artifacts/api-server/package.json", import.meta.url));
const { chromium } = apiRequire("playwright-core");
const { build } = apiRequire("esbuild");
const fixtureEntry = fileURLToPath(new URL(
  "../lib/arena/src/lib/waveyard/useArrangementPreview.fixture.tsx",
  import.meta.url,
));
const frontendNodeModules = fileURLToPath(new URL(
  "../artifacts/arenaforge/node_modules",
  import.meta.url,
));
const LONG_AUDIO_SECONDS = 240;
const LONG_STEM_SECONDS = 300;
const MAX_STREAM_FILE_BYTES = 64 * 1024 * 1024;
const PCM_RATE = 44_100;
const PCM_CHANNELS = 2;
const LONG_STEM_DATA_BYTES = LONG_STEM_SECONDS * PCM_RATE * PCM_CHANNELS * 2;
const LONG_STEM_FILE_BYTES = 44 + LONG_STEM_DATA_BYTES;

function tone() {
  const rate = 44_100;
  const frames = rate * 8;
  const wav = Buffer.alloc(44 + frames * 2);
  wav.write("RIFF");
  wav.writeUInt32LE(wav.length - 8, 4);
  wav.write("WAVEfmt ", 8);
  wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20);
  wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(rate, 24);
  wav.writeUInt32LE(rate * 2, 28);
  wav.writeUInt16LE(2, 32);
  wav.writeUInt16LE(16, 34);
  wav.write("data", 36);
  wav.writeUInt32LE(frames * 2, 40);
  for (let i = 0; i < frames; i += 1) {
    wav.writeInt16LE(
      Math.round(8192 * Math.sin(2 * Math.PI * 330 * i / rate)),
      44 + i * 2,
    );
  }
  return wav;
}

function longStemHeader() {
  const header = Buffer.alloc(44);
  header.write("RIFF");
  header.writeUInt32LE(LONG_STEM_FILE_BYTES - 8, 4);
  header.write("WAVEfmt ", 8);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(PCM_CHANNELS, 22);
  header.writeUInt32LE(PCM_RATE, 24);
  header.writeUInt32LE(PCM_RATE * PCM_CHANNELS * 2, 28);
  header.writeUInt16LE(PCM_CHANNELS * 2, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36);
  header.writeUInt32LE(LONG_STEM_DATA_BYTES, 40);
  return header;
}

function longStemRange(rangeHeader) {
  const match = /^bytes=(\d+)-(\d+)$/.exec(rangeHeader ?? "");
  if (!match) return null;
  const start = Number(match[1]);
  const end = Number(match[2]);
  if (start < 0 || end < start || end >= LONG_STEM_FILE_BYTES) return null;
  const bytes = Buffer.alloc(end - start + 1);
  const header = longStemHeader();
  for (let index = 0; index < bytes.length; index += 1) {
    const position = start + index;
    if (position < header.length) {
      bytes[index] = header[position];
      continue;
    }
    const pcmOffset = position - header.length;
    const sampleIndex = Math.floor(pcmOffset / 2);
    const frame = Math.floor(sampleIndex / PCM_CHANNELS);
    const channel = sampleIndex % PCM_CHANNELS;
    const sample = Math.round(8192 * Math.sin(2 * Math.PI * (330 + channel * 110) * frame / PCM_RATE));
    const unsigned = sample & 0xffff;
    bytes[index] = pcmOffset % 2 === 0 ? unsigned & 0xff : unsigned >>> 8;
  }
  return { start, end, bytes, fileSize: LONG_STEM_FILE_BYTES };
}

async function chromiumProcessMemory() {
  if (process.platform !== "linux") {
    throw new Error("Chromium process memory measurement requires Linux /proc.");
  }
  const { processInfo } = await browserCdpSession.send("SystemInfo.getProcessInfo");
  const memory = await Promise.all(processInfo.map(async (process) => {
    try {
      const rollup = await readFile(`/proc/${process.id}/smaps_rollup`, "utf8");
      const match = /^Pss:\s+(\d+)\s+kB$/m.exec(rollup);
      return { type: process.type, pid: process.id, pssBytes: match ? Number(match[1]) * 1_024 : 0 };
    } catch {
      return { type: process.type, pid: process.id, pssBytes: 0 };
    }
  }));
  const pssByType = Object.fromEntries([...new Set(memory.map((entry) => entry.type))]
    .map((type) => [type, memory.filter((entry) => entry.type === type)
      .reduce((sum, entry) => sum + entry.pssBytes, 0)]));
  return {
    processCount: processInfo.length,
    pssBytes: memory.reduce((sum, entry) => sum + entry.pssBytes, 0),
    rendererPssBytes: pssByType.renderer ?? 0,
    pssByType,
  };
}

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

let server;
let browser;
let browserCdpSession;
let url;
let tempRoot;
let longEncodedAudio;
const assetRequests = [];
const assetRangeRequests = [];

async function openFixture(t) {
  const page = await browser.newPage();
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(url);
  t.after(async () => {
    await page.close();
    assert.deepEqual(errors, [], "no uncaught React or Web Audio errors");
  });
  return page;
}

async function waitForOutput(page, testId, value, timeout = 5_000) {
  await page.waitForFunction(
    ({ id, expected }) =>
      document.querySelector(`[data-testid="${id}"]`)?.textContent === expected,
    { id: testId, expected: value },
    { timeout },
  );
}

before(async () => {
  tempRoot = await mkdtemp(join(tmpdir(), "waveyard-arrangement-preview-"));
  const encodedAudioPath = join(tempRoot, "realistic-long-preview.mp3");
  execFileSync("ffmpeg", [
    "-hide_banner",
    "-loglevel", "error",
    "-f", "lavfi",
    "-i", `aevalsrc=0.16*sin(2*PI*110*t)+0.08*sin(2*PI*220*t)+0.05*sin(2*PI*440*t)+0.02*sin(2*PI*880*t):s=44100:d=${LONG_AUDIO_SECONDS}`,
    "-ac", "2",
    "-ar", "44100",
    "-c:a", "libmp3lame",
    "-b:a", "128k",
    "-write_xing", "0",
    "-y", encodedAudioPath,
  ]);
  longEncodedAudio = await readFile(encodedAudioPath);
  const bundled = await build({
    entryPoints: [fixtureEntry],
    bundle: true,
    write: false,
    platform: "browser",
    format: "esm",
    jsx: "automatic",
    nodePaths: [frontendNodeModules],
    define: { "process.env.NODE_ENV": '"development"' },
  });
  const audio = tone();
  server = createServer((request, response) => {
    if (request.url === "/fixture.js") {
      response.setHeader("Content-Type", "text/javascript");
      response.end(bundled.outputFiles[0].contents);
      return;
    }
    if (request.url?.startsWith("/api/assets/")) {
      const assetId = new URL(request.url, "http://localhost").pathname.split("/").at(-1);
      assetRequests.push(assetId);
      assetRangeRequests.push({ assetId, range: request.headers.range ?? null });
      response.setHeader("Cache-Control", "no-store");
      if (assetId === "preview-long-encoded") {
        response.setHeader("Content-Type", "audio/mpeg");
        response.setHeader("Accept-Ranges", "bytes");
        const match = /^bytes=(\d+)-(\d*)$/.exec(request.headers.range ?? "");
        if (match) {
          const start = Number(match[1]);
          const end = Math.min(Number(match[2] || longEncodedAudio.length - 1), longEncodedAudio.length - 1);
          if (start < 0 || end < start || start >= longEncodedAudio.length) {
            response.writeHead(416, { "Content-Range": `bytes */${longEncodedAudio.length}` });
            response.end();
            return;
          }
          response.writeHead(206, {
            "Content-Length": end - start + 1,
            "Content-Range": `bytes ${start}-${end}/${longEncodedAudio.length}`,
          });
          response.end(longEncodedAudio.subarray(start, end + 1));
          return;
        }
        response.setHeader("Content-Length", longEncodedAudio.length);
        response.end(longEncodedAudio);
        return;
      }
      if (assetId === "preview-long" || assetId?.startsWith("preview-many-")) {
        const ranged = longStemRange(request.headers.range);
        if (!ranged) {
          response.writeHead(416, { "Content-Range": `bytes */${LONG_STEM_FILE_BYTES}` });
          response.end();
          return;
        }
        response.writeHead(206, {
          "Content-Type": "audio/wav",
          "Content-Length": ranged.bytes.length,
          "Content-Range": `bytes ${ranged.start}-${ranged.end}/${ranged.fileSize}`,
          "Accept-Ranges": "bytes",
          "Cache-Control": "no-store",
        });
        response.end(ranged.bytes);
        return;
      }
      response.setHeader("Content-Type", "audio/wav");
      response.setHeader("Content-Length", audio.length);
      response.end(audio);
      return;
    }
    response.setHeader("Content-Type", "text/html");
    const fixtureConfig = JSON.stringify({
      longAudioSeconds: LONG_AUDIO_SECONDS,
      longAudioFileSizeBytes: longEncodedAudio.length,
      oversizedAudioFileSizeBytes: MAX_STREAM_FILE_BYTES + 1,
    });
    response.end(`<!doctype html><div id="root"></div><script>window.__previewFixtureConfig=${fixtureConfig};</script><script type="module" src="/fixture.js"></script>`);
  });
  await new Promise((resolve) => server.listen(0, "0.0.0.0", resolve));
  url = `http://127.0.0.1:${server.address().port}`;
  browser = await chromium.launch({
    executablePath: process.env.CHROMIUM_PATH || "/repl/tools/bin/chromium",
    headless: true,
    args: ["--no-sandbox", "--disable-dev-shm-usage"],
  });
  browserCdpSession = await browser.newBrowserCDPSession();
});

after(async () => {
  await browserCdpSession?.detach();
  await browser?.close();
  if (server) await new Promise((resolve) => server.close(resolve));
  if (tempRoot) await rm(tempRoot, { recursive: true, force: true });
});

test("foreground arrangement interruption resumes from its playhead and manual pause stays paused", { timeout: 20_000 }, async (t) => {
  const page = await openFixture(t);
  await page.evaluate(() => {
    const contexts = [];
    const NativeAudioContext = window.AudioContext;
    Object.defineProperty(window, "__smokeAudioContexts", { configurable: true, value: contexts });
    window.AudioContext = new Proxy(NativeAudioContext, {
      construct(target, args, newTarget) {
        const audioContext = Reflect.construct(target, args, newTarget);
        contexts.push(audioContext);
        return audioContext;
      },
    });
  });

  await page.getByRole("button", { name: "Play preview" }).click();
  await waitForOutput(page, "playing", "true");
  await page.waitForFunction(() => Number(document.querySelector('[data-testid="position"]')?.textContent ?? 0) > 150);
  const positionBefore = Number(await page.locator('[data-testid="position"]').innerText());
  await page.evaluate(() => window.__smokeAudioContexts[0].suspend());
  await page.waitForFunction(() =>
    document.visibilityState === "visible" &&
    window.__smokeAudioContexts[0]?.state === "running" &&
    document.querySelector('[data-testid="playing"]')?.textContent === "true",
  null, { timeout: 5_000 });
  await page.waitForFunction((before) =>
    Number(document.querySelector('[data-testid="position"]')?.textContent ?? 0) > before + 100,
  positionBefore, { timeout: 5_000 });
  await waitForOutput(page, "error", "");

  await page.getByRole("button", { name: "Pause preview" }).click();
  await waitForOutput(page, "playing", "false");
  const pausedPosition = await page.locator('[data-testid="position"]').innerText();
  await page.evaluate(() => window.__smokeAudioContexts[0].suspend());
  await page.waitForTimeout(250);
  await waitForOutput(page, "playing", "false");
  assert.equal(await page.locator('[data-testid="position"]').innerText(), pausedPosition);
});

test("blocked foreground arrangement recovery exposes a working retry", { timeout: 20_000 }, async (t) => {
  const page = await openFixture(t);
  await page.evaluate(() => {
    const contexts = [];
    const NativeAudioContext = window.AudioContext;
    Object.defineProperty(window, "__smokeAudioContexts", { configurable: true, value: contexts });
    window.AudioContext = new Proxy(NativeAudioContext, {
      construct(target, args, newTarget) {
        const audioContext = Reflect.construct(target, args, newTarget);
        contexts.push(audioContext);
        return audioContext;
      },
    });
  });
  await page.getByRole("button", { name: "Play preview" }).click();
  await waitForOutput(page, "playing", "true");
  await page.waitForFunction(() => Number(document.querySelector('[data-testid="position"]')?.textContent ?? 0) > 150);
  const before = Number(await page.locator('[data-testid="position"]').innerText());
  await page.evaluate(async () => {
    const audio = window.__smokeAudioContexts[0];
    const realResume = audio.resume.bind(audio);
    let rejectOnce = true;
    audio.resume = () => {
      if (rejectOnce) {
        rejectOnce = false;
        return Promise.reject(new DOMException("simulated interruption", "NotAllowedError"));
      }
      return realResume();
    };
    await audio.suspend();
  });
  await page.waitForFunction(() =>
    document.visibilityState === "visible" &&
    document.querySelector('[data-testid="playing"]')?.textContent === "false" &&
    document.querySelector('[data-testid="error"]')?.textContent?.includes("Activate Preview arrangement to try again"),
  null, { timeout: 5_000 });
  assert(Number(await page.locator('[data-testid="position"]').innerText()) >= before);
  await page.getByRole("button", { name: "Play preview" }).click();
  await waitForOutput(page, "playing", "true");
  await waitForOutput(page, "error", "");
  assert.equal(await page.evaluate(() => document.visibilityState), "visible");
});

test("long and multi-stem arrangements play from bounded PCM ranges and remain seekable", { timeout: 30_000 }, async (t) => {
  const page = await openFixture(t);
  const beforeRanges = assetRangeRequests.length;
  await page.getByRole("button", { name: "Play long preview" }).click();
  await waitForOutput(page, "playing", "true");
  await waitForOutput(page, "error", "");
  const firstWindowRanges = assetRangeRequests.slice(beforeRanges);
  assert.ok(firstWindowRanges.length >= 4, "a bounded header and PCM ranges are fetched");
  assert.ok(firstWindowRanges.every((request) => request.assetId === "preview-long" && request.range),
    JSON.stringify(firstWindowRanges));
  assert.ok(firstWindowRanges.every((request) => {
    const range = /^bytes=(\d+)-(\d+)$/.exec(request.range ?? "");
    return range && Number(range[2]) - Number(range[1]) + 1 <= 5 * PCM_RATE * PCM_CHANNELS * 2;
  }), "every request is a short header or audio window, never the full long WAV");

  await page.evaluate(() => window.preview.seek(12_000));
  await waitForOutput(page, "pending", "true");
  await page.waitForFunction(() =>
    window.preview.playing &&
    !window.preview.pending &&
    window.previewPosition >= 12_000,
  null, { timeout: 10_000 });
  const seekRanges = assetRangeRequests.slice(beforeRanges + firstWindowRanges.length);
  const seekDataRanges = seekRanges
    .filter((request) => request.assetId === "preview-long" && request.range !== "bytes=0-43")
    .map((request) => Number(/^bytes=(\d+)-/.exec(request.range ?? "")?.[1]));
  assert.ok(seekDataRanges.some((start) => start >= 44 + 12 * PCM_RATE * PCM_CHANNELS * 2),
    JSON.stringify({ firstWindowRanges, seekRanges }));
  await page.waitForFunction(() => window.previewPosition >= 17_250, null, { timeout: 10_000 });
  assert.equal(await page.locator('[data-testid="error"]').innerText(), "");
  const prefetchedLaterWindow = assetRangeRequests
    .slice(beforeRanges)
    .filter((request) => request.assetId === "preview-long" && request.range !== "bytes=0-43")
    .some((request) => Number(/^bytes=(\d+)-/.exec(request.range ?? "")?.[1])
      >= 44 + 27 * PCM_RATE * PCM_CHANNELS * 2);
  assert.equal(prefetchedLaterWindow, true, "playhead crosses a segment and schedules the next one ahead");

  const beforeMany = assetRangeRequests.length;
  await page.evaluate(() => {
    const starts = [];
    const curves = [];
    const buffers = [];
    const nativeStart = AudioBufferSourceNode.prototype.start;
    const nativeCurve = AudioParam.prototype.setValueCurveAtTime;
    const nativeCreateBuffer = AudioContext.prototype.createBuffer;
    AudioBufferSourceNode.prototype.start = function (when, offset, duration) {
      starts.push({ when, offset, duration });
      return nativeStart.call(this, when, offset, duration);
    };
    AudioParam.prototype.setValueCurveAtTime = function (values, startTime, duration) {
      curves.push({ values: Array.from(values), startTime, duration });
      return nativeCurve.call(this, values, startTime, duration);
    };
    AudioContext.prototype.createBuffer = function (channels, frames, sampleRate) {
      const buffer = nativeCreateBuffer.call(this, channels, frames, sampleRate);
      buffers.push({
        ref: new WeakRef(buffer),
        bytes: buffer.length * buffer.numberOfChannels * Float32Array.BYTES_PER_ELEMENT,
      });
      return buffer;
    };
    Object.defineProperty(window, "__segmentScheduleProbe", {
      configurable: true,
      value: { starts, curves, buffers },
    });
  });
  await page.getByRole("button", { name: "Play many-stem preview" }).click();
  await waitForOutput(page, "pending", "true");
  await waitForOutput(page, "pending", "false");
  await waitForOutput(page, "playing", "true");
  await waitForOutput(page, "error", "");
  const multiStemRanges = assetRangeRequests.slice(beforeMany);
  assert.equal(new Set(multiStemRanges.map((request) => request.assetId)).size, 4, JSON.stringify(multiStemRanges));
  assert.ok(multiStemRanges.every((request) => request.range), JSON.stringify(multiStemRanges));
  const firstDataRanges = multiStemRanges
    .filter((request) => request.range !== "bytes=0-43")
    .reduce((byAsset, request) => {
      if (!byAsset.has(request.assetId)) {
        byAsset.set(request.assetId, Number(/^bytes=(\d+)-/.exec(request.range ?? "")?.[1]));
      }
      return byAsset;
    }, new Map());
  assert.deepEqual(
    [...firstDataRanges.values()].sort((left, right) => left - right),
    [44, 44 + PCM_RATE * PCM_CHANNELS * 2, 44 + 2 * PCM_RATE * PCM_CHANNELS * 2, 44 + 3 * PCM_RATE * PCM_CHANNELS * 2],
    "each aligned stem starts at its clip's own source offset",
  );
  const scheduleProbe = await page.evaluate(() => ({
    starts: window.__segmentScheduleProbe.starts,
    curves: window.__segmentScheduleProbe.curves,
    liveSegmentBuffers: window.__segmentScheduleProbe.buffers.filter((entry) => entry.ref.deref() !== undefined).length,
    liveSegmentBytes: window.__segmentScheduleProbe.buffers
      .filter((entry) => entry.ref.deref() !== undefined)
      .reduce((sum, entry) => sum + entry.bytes, 0),
  }));
  assert.ok(scheduleProbe.liveSegmentBuffers <= 12,
    `four tracks should retain only three lookahead windows; got ${scheduleProbe.liveSegmentBuffers}`);
  assert.ok(scheduleProbe.liveSegmentBytes < 128 * 1024 * 1024,
    `bounded PCM windows remain under the 128 MiB ceiling; got ${scheduleProbe.liveSegmentBytes}`);
  const firstStemStarts = scheduleProbe.starts.slice(0, 4).map((entry) => entry.when);
  assert.equal(firstStemStarts.length, 4);
  assert.ok(Math.max(...firstStemStarts) - Math.min(...firstStemStarts) < 0.001,
    JSON.stringify(firstStemStarts));
  const firstTrackWindowStarts = [0, 4, 8].map((index) => scheduleProbe.starts[index]?.when);
  assert.ok(firstTrackWindowStarts.every(Number.isFinite), JSON.stringify(firstTrackWindowStarts));
  assert.ok(Math.abs((firstTrackWindowStarts[1] - firstTrackWindowStarts[0]) - 5) < 0.01);
  assert.ok(Math.abs((firstTrackWindowStarts[2] - firstTrackWindowStarts[1]) - 5) < 0.01);
  assert.ok(scheduleProbe.curves.some((curve) => curve.values[0] <= 0.01 && curve.values.at(-1) >= 0.99),
    "segmented playback preserves the clip fade-in");
  assert.ok(scheduleProbe.curves.some((curve) => curve.values[0] >= 0.99 && curve.values.at(-1) <= 0.01),
    "segmented playback preserves the clip fade-out");
});

test("seeking long arrangements does not accumulate decoded segment buffers", { timeout: 30_000 }, async (t) => {
  const page = await openFixture(t);
  await page.evaluate(() => {
    const nativeCreateBuffer = AudioContext.prototype.createBuffer;
    const refs = [];
    AudioContext.prototype.createBuffer = function (channels, frames, sampleRate) {
      const buffer = nativeCreateBuffer.call(this, channels, frames, sampleRate);
      refs.push({
        ref: new WeakRef(buffer),
        bytes: buffer.length * buffer.numberOfChannels * Float32Array.BYTES_PER_ELEMENT,
      });
      return buffer;
    };
    Object.defineProperty(window, "__segmentBufferRefs", { configurable: true, value: refs });
  });
  await page.getByRole("button", { name: "Play long preview" }).click();
  await waitForOutput(page, "playing", "true");
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("HeapProfiler.enable");
  try {
    for (const positionMs of [12_000, 20_000, 8_000]) {
      await page.evaluate((position) => window.preview.seek(position), positionMs);
      await waitForOutput(page, "pending", "true");
      await page.waitForFunction((position) =>
        window.preview.playing &&
        !window.preview.pending &&
        window.previewPosition >= position,
      positionMs, { timeout: 10_000 });
      await page.waitForTimeout(100);
      await cdp.send("HeapProfiler.collectGarbage");
      const retained = await page.evaluate(() =>
        window.__segmentBufferRefs.filter((entry) => entry.ref.deref() !== undefined).length,
      );
      assert.ok(retained <= 4, `only the active bounded lookahead should remain; retained=${retained}`);
    }
  } finally {
    await cdp.detach();
  }
});

test("four-minute encoded preview streams within the memory cap, seeks, and releases after a switch", {
  timeout: 60_000,
  skip: process.platform !== "linux" ? "requires Linux Chromium process-tree memory reporting" : false,
}, async (t) => {
  const page = await openFixture(t);
  await page.evaluate(() => {
    const contexts = [];
    const decoded = [];
    const media = [];
    const NativeAudioContext = window.AudioContext;
    const originalDecode = NativeAudioContext.prototype.decodeAudioData;
    NativeAudioContext.prototype.decodeAudioData = function (data) {
      return originalDecode.call(this, data).then((buffer) => {
        decoded.push({
          ref: new WeakRef(buffer),
          bytes: buffer.length * buffer.numberOfChannels * Float32Array.BYTES_PER_ELEMENT,
          durationSeconds: buffer.duration,
          sampleRate: buffer.sampleRate,
          channels: buffer.numberOfChannels,
        });
        return buffer;
      });
    };
    const originalPlay = HTMLMediaElement.prototype.play;
    HTMLMediaElement.prototype.play = function (...args) {
      media.push({ ref: new WeakRef(this), initialSource: this.src });
      return originalPlay.apply(this, args);
    };
    Object.defineProperty(window, "__previewMemoryProbe", {
      configurable: true,
      value: { contexts, decoded, media },
    });
    Object.defineProperty(window, "AudioContext", {
      configurable: true,
      value: new Proxy(NativeAudioContext, {
        construct(target, args, newTarget) {
          const audioContext = Reflect.construct(target, args, newTarget);
          contexts.push(audioContext);
          return audioContext;
        },
      }),
    });
  });

  await page.getByRole("button", { name: "Play preview" }).click();
  await waitForOutput(page, "playing", "true");
  await page.getByRole("button", { name: "Stop preview" }).click();
  await waitForOutput(page, "playing", "false");
  const longBufferIndex = await page.evaluate(() => window.__previewMemoryProbe.decoded.length);
  assert.equal(longBufferIndex, 1, "warm-up initializes the audio pipeline before the memory baseline");
  await page.waitForTimeout(250);
  const baseline = await chromiumProcessMemory();
  const samples = [baseline];
  let sampling = true;
  let sampleError;
  const sampler = (async () => {
    while (sampling) {
      await sleep(100);
      if (!sampling) break;
      try {
        samples.push(await chromiumProcessMemory());
      } catch (error) {
        sampleError = error;
        return;
      }
    }
  })();
  let cdp;
  try {
    const requestStart = assetRequests.length;
    await page.getByRole("button", { name: "Play realistic long encoded preview" }).click();
    await waitForOutput(page, "playing", "true", 20_000);
    await waitForOutput(page, "pending", "false", 20_000);
    await page.waitForFunction(() => {
      const media = window.__previewMemoryProbe?.media.at(-1)?.ref.deref();
      return media && media.currentTime > 0.25 && Number.isFinite(media.duration);
    }, null, { timeout: 20_000 });

    const activeAudio = await page.evaluate(() => {
      const media = window.__previewMemoryProbe.media.at(-1)?.ref.deref();
      return {
      sampleRate: window.__previewMemoryProbe.contexts[0]?.sampleRate,
      memoryBudget: window.__previewMemoryBudget,
      decodedCount: window.__previewMemoryProbe.decoded.length,
      media: media ? {
        durationSeconds: media.duration,
        currentTime: media.currentTime,
        paused: media.paused,
        source: media.currentSrc,
      } : null,
      error: window.preview.error,
      };
    });
    assert.equal(activeAudio.error, null);
    assert.equal(activeAudio.decodedCount, longBufferIndex,
      "the long MP3 must not become a full-duration AudioBuffer");
    assert.equal(activeAudio.media?.paused, false);
    assert.ok(Math.abs(activeAudio.media?.durationSeconds - LONG_AUDIO_SECONDS) < 1,
      JSON.stringify(activeAudio.media));
    assert.ok(activeAudio.media?.currentTime > 0.25, JSON.stringify(activeAudio.media));

    const estimateBytes = Math.ceil(
      Math.min(activeAudio.memoryBudget.streamWindowMs / 1_000, LONG_AUDIO_SECONDS) * activeAudio.sampleRate * 2
        * Float32Array.BYTES_PER_ELEMENT * activeAudio.memoryBudget.decodeHeadroomFactor,
    ) + longEncodedAudio.length + activeAudio.memoryBudget.streamElementOverheadBytes;
    assert.ok(
      estimateBytes < activeAudio.memoryBudget.limitBytes,
      JSON.stringify({ estimateBytes, memoryLimitBytes: activeAudio.memoryBudget.limitBytes, sampleRate: activeAudio.sampleRate }),
    );

    await page.evaluate(() => window.preview.seek(35_000));
    await page.waitForFunction(() => {
      const media = window.__previewMemoryProbe?.media.at(-1)?.ref.deref();
      return media && !media.paused && media.currentTime >= 35;
    }, null, { timeout: 20_000 });
    await page.waitForFunction(() => window.previewPosition >= 35_000, null, { timeout: 5_000 });
    const seekAudio = await page.evaluate(() => {
      const media = window.__previewMemoryProbe.media.at(-1)?.ref.deref();
      return media ? { currentTime: media.currentTime, paused: media.paused } : null;
    });
    assert.ok(seekAudio && seekAudio.currentTime >= 35 && !seekAudio.paused, JSON.stringify(seekAudio));

    samples.push(await chromiumProcessMemory());
    await page.getByRole("button", { name: "Play switch arrangement B" }).click();
    await waitForOutput(page, "playing", "true");
    await waitForOutput(page, "pending", "false");
    cdp = await page.context().newCDPSession(page);
    await cdp.send("HeapProfiler.enable");
    await cdp.send("HeapProfiler.collectGarbage");
    await page.waitForTimeout(100);
    await cdp.send("HeapProfiler.collectGarbage");

    const streamReleased = await page.evaluate(() => window.__previewMemoryProbe.media
      .every(({ ref }) => {
        const media = ref.deref();
        return !media || (media.paused && media.getAttribute("src") === null);
      }));
    assert.equal(streamReleased, true, "switching arrangements pauses streams and removes their media URLs");
    const afterSwitch = await chromiumProcessMemory();
    samples.push(afterSwitch);
    const requestedIds = assetRequests.slice(requestStart);
    assert.ok(requestedIds.includes("preview-long-encoded"), JSON.stringify(requestedIds));
    assert.ok(requestedIds.includes("preview-switch-b"), JSON.stringify(requestedIds));
    assert.equal(
      assetRangeRequests.slice(requestStart).some(({ assetId, range }) =>
        assetId === "preview-long-encoded" && range !== null),
      true,
      "the encoded audio endpoint serves browser range requests for seeking",
    );

    sampling = false;
    await sampler;
    if (sampleError) throw sampleError;
    const peak = samples.reduce((largest, sample) =>
      sample.pssBytes > largest.pssBytes ? sample : largest, baseline);
    const rendererPeak = samples.reduce((largest, sample) =>
      sample.rendererPssBytes > largest.rendererPssBytes ? sample : largest, baseline);
    const peakDeltaBytes = peak.pssBytes - baseline.pssBytes;
    const rendererPeakDeltaBytes = rendererPeak.rendererPssBytes - baseline.rendererPssBytes;
    const rendererAfterSwitchDeltaBytes = afterSwitch.rendererPssBytes - baseline.rendererPssBytes;
    const afterSwitchDeltaBytes = Math.max(0, afterSwitch.pssBytes - baseline.pssBytes);
    const memoryReport = {
      measurement: "Chromium process proportional set size (PSS)",
      activeSampleRate: activeAudio.sampleRate,
      encodedFormat: "MP3",
      durationSeconds: activeAudio.media.durationSeconds,
      encodedBytes: longEncodedAudio.length,
      decodedPcmBytes: null,
      estimatedPeakBytes: estimateBytes,
      memoryLimitBytes: activeAudio.memoryBudget.limitBytes,
      processCount: peak.processCount,
      baselinePssBytes: baseline.pssBytes,
      peakPssBytes: peak.pssBytes,
      allChromiumProcessPeakDeltaBytes: peakDeltaBytes,
      rendererPeakPssBytes: rendererPeak.rendererPssBytes,
      rendererPeakDeltaBytes,
      rendererPeakPssByType: rendererPeak.pssByType,
      postSwitchPssBytes: afterSwitch.pssBytes,
      allChromiumProcessPostSwitchDeltaBytes: afterSwitchDeltaBytes,
      rendererAfterSwitchDeltaBytes,
      postSwitchPssByType: afterSwitch.pssByType,
      fullDurationDecodeCount: activeAudio.decodedCount - longBufferIndex,
      streamReleased,
    };
    t.diagnostic(JSON.stringify(memoryReport));
    assert.ok(peakDeltaBytes < activeAudio.memoryBudget.limitBytes, JSON.stringify(memoryReport));
    assert.ok(rendererPeakDeltaBytes < activeAudio.memoryBudget.limitBytes,
      JSON.stringify(memoryReport));
    assert.ok(rendererAfterSwitchDeltaBytes < activeAudio.memoryBudget.limitBytes,
      JSON.stringify(memoryReport));
    assert.ok(rendererAfterSwitchDeltaBytes < rendererPeakDeltaBytes,
      JSON.stringify(memoryReport));
  } finally {
    sampling = false;
    await sampler;
    await cdp?.detach();
  }
});

test("oversized encoded assets are rejected before the browser requests their bytes", { timeout: 10_000 }, async (t) => {
  const page = await openFixture(t);
  const requestStart = assetRequests.length;
  await page.getByRole("button", { name: "Reject oversized encoded preview" }).click();
  await page.waitForFunction(
    () => window.preview.error?.includes("safe 64 MiB streaming limit"),
    null,
    { timeout: 5_000 },
  );
  assert.equal(await page.getByTestId("playing").textContent(), "false");
  assert.equal(await page.getByTestId("pending").textContent(), "false");
  assert.deepEqual(assetRequests.slice(requestStart), [], "oversized metadata must fail before any asset request");
});

test("muted stems are excluded from both preview fetches and the memory estimate", { timeout: 10_000 }, async (t) => {
  const page = await openFixture(t);
  const before = assetRequests.length;
  await page.getByRole("button", { name: "Play muted arrangement" }).click();
  await waitForOutput(page, "playing", "true");

  assert.deepEqual(
    assetRequests.slice(before),
    ["preview-muted-vocals"],
    "only the audible donor is fetched and decoded",
  );
});

test("switching arrangements releases inactive decoded donors before loading the next one", { timeout: 15_000 }, async (t) => {
  const page = await openFixture(t);
  const before = assetRequests.length;
  await page.getByRole("button", { name: "Play switch arrangement A" }).click();
  await waitForOutput(page, "playing", "true");
  await page.getByRole("button", { name: "Play switch arrangement B" }).click();
  await waitForOutput(page, "playing", "true");
  await page.getByRole("button", { name: "Play switch arrangement A" }).click();
  await waitForOutput(page, "playing", "true");

  assert.deepEqual(
    assetRequests.slice(before),
    ["preview-switch-a", "preview-switch-b", "preview-switch-a"],
    "switching away releases the previous arrangement's cached donor",
  );
});
