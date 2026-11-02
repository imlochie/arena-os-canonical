import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { createServer } from "node:http";
import { createRequire } from "node:module";
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

let server;
let browser;
let url;

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
    if (request.url === "/api/assets/fixture-stem") {
      response.setHeader("Content-Type", "audio/wav");
      response.setHeader("Content-Length", audio.length);
      response.end(audio);
      return;
    }
    response.setHeader("Content-Type", "text/html");
    response.end('<!doctype html><div id="root"></div><script type="module" src="/fixture.js"></script>');
  });
  await new Promise((resolve) => server.listen(0, "0.0.0.0", resolve));
  url = `http://127.0.0.1:${server.address().port}`;
  browser = await chromium.launch({
    executablePath: process.env.CHROMIUM_PATH || "/repl/tools/bin/chromium",
    headless: true,
    args: ["--no-sandbox", "--disable-dev-shm-usage"],
  });
});

after(async () => {
  await browser?.close();
  if (server) await new Promise((resolve) => server.close(resolve));
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
    document.querySelector('[data-testid="error"]')?.textContent?.includes("Tap Preview arrangement to try again"),
  null, { timeout: 5_000 });
  assert(Number(await page.locator('[data-testid="position"]').innerText()) >= before);
  await page.getByRole("button", { name: "Play preview" }).click();
  await waitForOutput(page, "playing", "true");
  await waitForOutput(page, "error", "");
  assert.equal(await page.evaluate(() => document.visibilityState), "visible");
});
