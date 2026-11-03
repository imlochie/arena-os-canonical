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
const LONG_AUDIO_SECONDS = 90;

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
      response.setHeader("Cache-Control", "no-store");
      if (assetId === "preview-long-encoded") {
        response.setHeader("Content-Type", "audio/mpeg");
        response.setHeader("Content-Length", longEncodedAudio.length);
        response.end(longEncodedAudio);
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

test("long and many-stem arrangements are rejected before any full asset is fetched", { timeout: 20_000 }, async (t) => {
  const page = await openFixture(t);
  const before = assetRequests.length;
  await page.getByRole("button", { name: "Play long preview" }).click();
  await page.waitForTimeout(500);
  const longStatus = await page.evaluate(() => ({
    error: window.preview.error,
    pending: window.preview.pending,
    playing: window.preview.playing,
  }));
  assert.match(
    longStatus.error ?? "",
    /estimated to need/i,
    JSON.stringify({ longStatus, requests: assetRequests.slice(before) }),
  );
  assert.equal(assetRequests.length, before, "a long source is rejected before downloading or decoding");

  await page.getByRole("button", { name: "Play many-stem preview" }).click();
  await page.waitForTimeout(500);
  const manyStatus = await page.evaluate(() => ({
    error: window.preview.error,
    pending: window.preview.pending,
    playing: window.preview.playing,
  }));
  assert.match(manyStatus.error ?? "", /estimated to need/i, JSON.stringify(manyStatus));
  assert.equal(assetRequests.length, before, "many audible long stems are rejected before any decode");
});

test("realistic long encoded preview reports browser memory and releases its buffer after a switch", {
  timeout: 60_000,
  skip: process.platform !== "linux" ? "requires Linux Chromium process-tree memory reporting" : false,
}, async (t) => {
  const page = await openFixture(t);
  await page.evaluate(() => {
    const contexts = [];
    const decoded = [];
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
    Object.defineProperty(window, "__previewMemoryProbe", {
      configurable: true,
      value: { contexts, decoded },
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
    await page.waitForFunction(
      (expectedCount) => window.__previewMemoryProbe?.decoded.length === expectedCount,
      longBufferIndex + 1,
      { timeout: 20_000 },
    );

    const activeAudio = await page.evaluate((index) => ({
      sampleRate: window.__previewMemoryProbe.contexts[0]?.sampleRate,
      memoryBudget: window.__previewMemoryBudget,
      decoded: {
        bytes: window.__previewMemoryProbe.decoded[index].bytes,
        durationSeconds: window.__previewMemoryProbe.decoded[index].durationSeconds,
        sampleRate: window.__previewMemoryProbe.decoded[index].sampleRate,
        channels: window.__previewMemoryProbe.decoded[index].channels,
      },
      error: window.preview.error,
    }), longBufferIndex);
    assert.equal(activeAudio.error, null);
    assert.equal(activeAudio.sampleRate, activeAudio.decoded.sampleRate);
    assert.equal(activeAudio.decoded.channels, 2);
    assert.ok(Math.abs(activeAudio.decoded.durationSeconds - LONG_AUDIO_SECONDS) < 1,
      JSON.stringify(activeAudio.decoded));

    const estimateBytes = Math.ceil(
      LONG_AUDIO_SECONDS * activeAudio.sampleRate * activeAudio.decoded.channels
        * Float32Array.BYTES_PER_ELEMENT * activeAudio.memoryBudget.decodeHeadroomFactor,
    ) + longEncodedAudio.length;
    assert.ok(
      estimateBytes < activeAudio.memoryBudget.limitBytes,
      JSON.stringify({ estimateBytes, memoryLimitBytes: activeAudio.memoryBudget.limitBytes, sampleRate: activeAudio.sampleRate }),
    );

    samples.push(await chromiumProcessMemory());
    await page.getByRole("button", { name: "Play switch arrangement B" }).click();
    await waitForOutput(page, "playing", "true");
    cdp = await page.context().newCDPSession(page);
    await cdp.send("HeapProfiler.enable");
    await cdp.send("HeapProfiler.collectGarbage");
    await page.waitForTimeout(100);
    await cdp.send("HeapProfiler.collectGarbage");

    const bufferReleased = await page.evaluate((index) =>
      window.__previewMemoryProbe.decoded[index].ref.deref() === undefined,
    longBufferIndex);
    assert.equal(bufferReleased, true, "switching away releases the decoded long AudioBuffer");
    const afterSwitch = await chromiumProcessMemory();
    samples.push(afterSwitch);
    assert.deepEqual(
      assetRequests.slice(requestStart),
      ["preview-long-encoded", "preview-switch-b"],
      "the long MP3 used the real fetch path before the arrangement switch",
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
      durationSeconds: activeAudio.decoded.durationSeconds,
      encodedBytes: longEncodedAudio.length,
      decodedPcmBytes: activeAudio.decoded.bytes,
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
      decodedBufferReleased: bufferReleased,
    };
    t.diagnostic(JSON.stringify(memoryReport));
    assert.ok(peakDeltaBytes > activeAudio.decoded.bytes * 0.5,
      JSON.stringify({ peakDeltaBytes, decodedPcmBytes: activeAudio.decoded.bytes, samples: samples.length }));
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
