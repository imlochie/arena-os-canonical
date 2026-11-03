import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const apiRequire = createRequire(new URL("../artifacts/api-server/package.json", import.meta.url));
const { chromium } = apiRequire("playwright-core");
const { build } = apiRequire("esbuild");

// Real browser media and Web Audio acceptance. Synthetic tones verify the
// transport graph only; this is not separation-model or Windows evidence.
const fixtureEntry = fileURLToPath(new URL(
  "../lib/arena/src/lib/waveyard/useStemTransport.fixture.tsx",
  import.meta.url,
));
const hookSource = fileURLToPath(new URL(
  "../lib/arena/src/lib/waveyard/useStemTransport.ts",
  import.meta.url,
));
const frontendNodeModules = fileURLToPath(new URL(
  "../artifacts/arenaforge/node_modules",
  import.meta.url,
));

let server;
let browser;
let url;

function tone(frequency) {
  const rate = 44_100;
  const frames = rate * 2;
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
      Math.round(8192 * Math.sin(2 * Math.PI * frequency * i / rate)),
      44 + i * 2,
    );
  }
  return wav;
}

before(async () => {
  const bundled = await build({
    entryPoints: [fixtureEntry],
    bundle: true,
    write: false,
    platform: "browser",
    format: "esm",
    jsx: "automatic",
    nodePaths: [frontendNodeModules],
    define: { "process.env.NODE_ENV": '"development"' },
    plugins: [{
      name: "waveyard-worklet-url-fixture",
      setup(build) {
        build.onResolve({ filter: /(?:live-stem|output-peak)-worklet\.ts\?worker&url$/ }, args => ({
          path: args.path,
          namespace: "waveyard-worklet-url",
        }));
        build.onLoad({ filter: /.*/, namespace: "waveyard-worklet-url" }, args => ({
          contents: `export default ${JSON.stringify(`/test/${args.path.split("/").at(-1).replace(".ts?worker&url", ".js")}`)};`,
          loader: "js",
        }));
      },
    }],
  });
  server = createServer((request, response) => {
    if (request.url === "/fixture.js") {
      response.setHeader("Content-Type", "text/javascript");
      response.end(bundled.outputFiles[0].contents);
      return;
    }
    if (request.url?.startsWith("/tones/")) {
      const audio = tone(
        request.url.includes("vocals") || request.url.includes("bass") ? 220 : 440,
      );
      response.setHeader("Content-Type", "audio/wav");
      response.setHeader("Accept-Ranges", "bytes");
      const range = request.headers.range?.match(/^bytes=(\d+)-(\d*)$/);
      const start = range ? Number(range[1]) : 0;
      const end = range?.[2] ? Math.min(Number(range[2]), audio.length - 1) : audio.length - 1;
      if (range) {
        response.statusCode = 206;
        response.setHeader("Content-Range", `bytes ${start}-${end}/${audio.length}`);
      }
      response.setHeader("Content-Length", end - start + 1);
      response.end(audio.subarray(start, end + 1));
      return;
    }
    response.setHeader("Content-Type", "text/html");
    response.end('<!DOCTYPE html><div id="root"></div><script type="module" src="/fixture.js"></script>');
  });
  await new Promise((resolve) => server.listen(0, "0.0.0.0", resolve));
  url = `http://127.0.0.1:${server.address().port}`;
  browser = await chromium.launch({
    executablePath: process.env.CHROMIUM_PATH || "/repl/tools/bin/chromium",
    headless: true,
    args: ["--no-sandbox", "--disable-dev-shm-usage"],
  });
  console.log(JSON.stringify({
    evidenceKind: "browser-audio-acceptance",
    browser: browser.version(),
    source: "lib/arena/src/lib/waveyard/useStemTransport.ts",
    sourceSha256: createHash("sha256").update(await readFile(hookSource)).digest("hex"),
    inputs: "deterministic two-second PCM tones, not separation outputs",
    limitations: [
      "not Windows or Electron acceptance",
      "not model inference evidence",
      "not sample-perfect synchronization",
      "not full session or export acceptance",
    ],
  }));
});

after(async () => {
  await browser?.close();
  if (server) await new Promise((resolve) => server.close(resolve));
});

async function openFixture(t) {
  const page = await browser.newPage();
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(url);
  await page.waitForFunction(() => (
    window.transport &&
    [...document.querySelectorAll("audio")].every((element) => element.readyState >= 2)
  ));
  t.after(async () => {
    await page.close();
    assert.deepEqual(errors, [], "no uncaught React or Web Audio errors");
  });
  return page;
}

async function waitForText(page, testId, text, timeout = 5_000) {
  await page.waitForFunction(
    ({ id, expected }) => document.querySelector(`[data-testid="${id}"]`)?.textContent?.includes(expected),
    { id: testId, expected: text },
    { timeout },
  );
}

async function waitForEmpty(page, testId, timeout = 5_000) {
  await page.waitForFunction(
    (id) => document.querySelector(`[data-testid="${id}"]`)?.textContent?.trim() === "",
    testId,
    { timeout },
  );
}

async function waitForValue(page, read, predicate, message, timeout = 5_000) {
  const started = Date.now();
  let value;
  while (Date.now() - started < timeout) {
    value = await page.evaluate(read);
    if (predicate(value)) return value;
    await page.waitForTimeout(50);
  }
  value = await page.evaluate(read);
  assert.ok(predicate(value), `${message}; last value was ${JSON.stringify(value)}`);
  return value;
}

async function start(page) {
  await page.getByRole("button", { name: "Play", exact: true }).click();
  await waitForText(page, "playing", "true");
  await waitForValue(
    page,
    () => window.transport.readMeters().master.rms,
    (rms) => rms > 0.05,
    "master audio meter should show real signal",
  );
}

test("real stem gain, mute, solo, seek and stop operate on the audio graph", { timeout: 20_000 }, async (t) => {
  const page = await openFixture(t);
  await start(page);
  await page.getByRole("button", { name: "Mute vocals" }).click();
  await waitForValue(
    page,
    () => window.transport.readMeters().channels.vocals.rms,
    (rms) => rms < 0.001,
    "muted vocals should produce no signal",
  );
  assert.ok(await page.evaluate(() => window.transport.readMeters().channels.drums.rms > 0.05));
  await page.getByRole("button", { name: "Mute vocals" }).click();
  await waitForValue(
    page,
    () => window.transport.readMeters().channels.vocals.rms,
    (rms) => rms > 0.05,
    "unmuted vocals should return",
  );
  await page.getByRole("button", { name: "Solo vocals" }).click();
  await waitForValue(
    page,
    () => window.transport.readMeters().channels.drums.rms,
    (rms) => rms < 0.001,
    "solo should silence other stems",
  );
  await page.getByRole("button", { name: "Lower vocals" }).click();
  await waitForValue(
    page,
    () => window.transport.readMeters().channels.vocals.rms,
    (rms) => rms < 0.06,
    "lowered stem should reduce its meter",
  );
  await page.getByRole("button", { name: "Seek", exact: true }).click();
  const times = await page.locator("audio")
    .evaluateAll((elements) => elements.map((element) => element.currentTime));
  assert.ok(Math.abs(times[0] - times[1]) < 0.075, `stem drift ${times}`);
  assert.ok(times[0] >= 0.69 && times[0] < 1.1, `seek position ${times}`);
  await page.getByRole("button", { name: "Stop", exact: true }).click();
  await waitForText(page, "playing", "false");
  assert.deepEqual(
    await page.locator("audio").evaluateAll((elements) => elements.map((element) => [element.paused, element.currentTime])),
    [[true, 0], [true, 0]],
  );
});

test("loops continue across boundaries without stale-position restart", { timeout: 20_000 }, async (t) => {
  const page = await openFixture(t);
  await page.getByRole("button", { name: "Loop", exact: true }).click();
  await start(page);
  await page.waitForTimeout(2_100);
  const snapshot = await page.evaluate(() => ({
    playing: window.transport.playing,
    position: window.transport.position,
    times: [...document.querySelectorAll("audio")].map((element) => element.currentTime),
    rms: window.transport.readMeters().master.rms,
  }));
  assert.equal(snapshot.playing, true);
  assert.ok(snapshot.position >= 0.15 && snapshot.position < 0.9, JSON.stringify(snapshot));
  assert.ok(snapshot.times.every((time) => time >= 0.15 && time < 0.9), JSON.stringify(snapshot));
  assert.ok(snapshot.rms > 0.05);
});

test("equivalent asset refresh keeps playback; replacing the deck starts cleanly", { timeout: 20_000 }, async (t) => {
  const page = await openFixture(t);
  await start(page);
  await page.evaluate(() => window.refreshAssets());
  await page.waitForTimeout(200);
  await waitForText(page, "playing", "true");
  assert.ok(await page.evaluate(() => window.transport.readMeters().master.rms > 0.05));
  await page.evaluate(() => window.replaceAssets());
  await waitForText(page, "playing", "false");
  await page.waitForFunction(() => (
    [...document.querySelectorAll("audio")].every((element) => element.readyState >= 2)
  ));
  await start(page);
  assert.deepEqual(
    await page.evaluate(() => Object.keys(window.transport.readMeters().channels).sort()),
    ["bass", "melody"],
  );
});

test("a missing stem rejects playback instead of reporting partial success", { timeout: 20_000 }, async (t) => {
  const page = await openFixture(t);
  await page.evaluate(() => window.removeElement());
  await page.getByRole("button", { name: "Play", exact: true }).click();
  await waitForText(page, "error", "not loaded");
  await waitForText(page, "playing", "false");
  assert.ok(await page.locator("audio").evaluateAll((elements) => elements.every((element) => element.paused)));
});

test("an unavailable staged channel does not interrupt the active mix", { timeout: 20_000 }, async (t) => {
  const page = await openFixture(t);
  await page.getByRole("button", { name: "Play", exact: true }).click();
  await waitForText(page, "playing", "true");
  const playbackStart = await page.locator('audio[data-id="vocals"]').evaluate((audio) => audio.currentTime);
  await page.evaluate(() => window.stageMissingNonPlaybackChannel());
  await page.waitForFunction((before) => {
    const audio = document.querySelector('audio[data-id="vocals"]');
    return window.transport.playing &&
      audio instanceof HTMLAudioElement &&
      !audio.paused &&
      audio.currentTime > before + 0.1;
  }, playbackStart, { timeout: 5_000 });
  await waitForEmpty(page, "error");
  await page.evaluate(() => window.restoreStagedChannel());
  await page.waitForFunction(() => ["bass", "other"].every((id) => {
    const audio = document.querySelector(`audio[data-id="${id}"]`);
    return audio instanceof HTMLAudioElement && audio.readyState >= 2;
  }));
  await page.evaluate(() => window.activateStagedChannels());
  await page.waitForFunction(() => {
    const audio = document.querySelector('audio[data-id="bass"]');
    return window.transport.playing &&
      audio instanceof HTMLAudioElement &&
      !audio.paused &&
      audio.currentTime > 0;
  }, null, { timeout: 5_000 });
  await waitForEmpty(page, "error");
});

test("saved master inserts affect the real signal on first play", { timeout: 20_000 }, async (t) => {
  const page = await openFixture(t);
  await page.getByRole("button", { name: "Master insert" }).click();
  await page.getByRole("button", { name: "Play", exact: true }).click();
  await waitForText(page, "playing", "true");
  await waitForValue(
    page,
    () => window.transport.readMeters().channels.vocals.rms,
    (rms) => rms > 0.05,
    "stem signal should remain measurable through master processing",
  );
  await waitForValue(
    page,
    () => window.transport.readMeters().master.rms,
    (rms) => rms > 0.005,
    "processed master output should remain audible",
  );
  assert.ok(await page.evaluate(() => window.transport.readMeters().master.rms < 0.05));
});

test("end of audio clears playing state", { timeout: 20_000 }, async (t) => {
  const page = await openFixture(t);
  await start(page);
  await waitForText(page, "playing", "false", 5_000);
  assert.ok(await page.evaluate(() => window.transport.position > 1.8));
});

test("remounted media elements reconnect to their actual audio sources", { timeout: 20_000 }, async (t) => {
  const page = await openFixture(t);
  await start(page);
  await page.getByRole("button", { name: "Stop", exact: true }).click();
  await page.evaluate(() => window.remountElements());
  await page.waitForFunction(() => (
    [...document.querySelectorAll("audio")].every((element) => element.readyState >= 2)
  ));
  await start(page);
});

test("pause cancels a pending start instead of allowing late audio", { timeout: 20_000 }, async (t) => {
  const page = await openFixture(t);
  await page.evaluate(() => {
    const realPlay = HTMLMediaElement.prototype.play;
    HTMLMediaElement.prototype.play = function () {
      return new Promise((resolve, reject) => {
        setTimeout(() => realPlay.call(this).then(resolve, reject), 250);
      });
    };
  });
  await page.getByRole("button", { name: "Play", exact: true }).click();
  await page.getByRole("button", { name: "Pause", exact: true }).click();
  await page.waitForTimeout(500);
  await waitForText(page, "playing", "false");
  assert.ok(await page.locator("audio").evaluateAll((elements) => elements.every((element) => element.paused)));
});

test("foreground audio-context interruption resumes stems at the current playhead", { timeout: 20_000 }, async (t) => {
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
  await start(page);
  const before = await page.locator("audio").first().evaluate((audio) => audio.currentTime);
  await page.evaluate(() => window.__smokeAudioContexts[0].suspend());
  await page.waitForFunction(() =>
    document.visibilityState === "visible" &&
    window.__smokeAudioContexts[0]?.state === "running" &&
    window.transport.playing &&
    [...document.querySelectorAll("audio")].some((audio) => !audio.paused),
  null, { timeout: 5_000 });
  await page.waitForFunction((previousPosition) =>
    [...document.querySelectorAll("audio")].some((audio) => !audio.paused && audio.currentTime > previousPosition + 0.15),
  before, { timeout: 5_000 });
  await waitForEmpty(page, "error");
});

test("a media failure stops all stems and playback can recover", { timeout: 20_000 }, async (t) => {
  const page = await openFixture(t);
  await start(page);
  await page.evaluate(() => {
    document.querySelector('audio[data-id="drums"]').src = "/unreadable.wav";
  });
  await waitForText(page, "error", "unavailable");
  await waitForText(page, "playing", "false");
  assert.ok(await page.locator("audio").evaluateAll((elements) => elements.every((element) => element.paused)));
  await page.evaluate(() => {
    document.querySelector('audio[data-id="drums"]').src = "/tones/drums.wav";
  });
  await page.waitForFunction(() => (
    [...document.querySelectorAll("audio")].every((element) => element.readyState >= 2 && !element.error)
  ));
  await start(page);
  await waitForEmpty(page, "error");
});
