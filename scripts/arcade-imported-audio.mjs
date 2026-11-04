import assert from "node:assert/strict";
import { createRequire } from "node:module";

const base = process.env.TEST_BASE_URL || "http://localhost:80";
const apiRequire = createRequire(new URL("../artifacts/api-server/package.json", import.meta.url));
const arenaRequire = createRequire(new URL("../artifacts/arenaforge/package.json", import.meta.url));
const { chromium } = apiRequire("playwright-core");
const JSZip = arenaRequire("jszip");

function makePcmWav(frequency = 440, durationSeconds = 0.7) {
  const sampleRate = 16_000;
  const sampleCount = sampleRate * durationSeconds;
  const pcm = Buffer.alloc(sampleCount * 2);
  for (let index = 0; index < sampleCount; index += 1) {
    const envelope = Math.min(1, index / 320, (sampleCount - index) / 320);
    const sample = Math.sin((2 * Math.PI * frequency * index) / sampleRate) * 0.18 * envelope;
    pcm.writeInt16LE(Math.round(sample * 32_767), index * 2);
  }
  const header = Buffer.alloc(44);
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write("WAVE", 8);
  header.write("fmt ", 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36);
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}

async function installPlaybackProbe(audio) {
  await audio.evaluate((element) => {
    const frame = element.ownerDocument.defaultView;
    const prototype = frame.HTMLMediaElement.prototype;
    const play = prototype.play;
    frame.__arenaPlaybackProbe = { promise: "not-called", playing: false, pausedAtPlaying: null, currentTimeAtPlaying: null };
    element.addEventListener("playing", () => {
      frame.__arenaPlaybackProbe.playing = true;
      frame.__arenaPlaybackProbe.pausedAtPlaying = element.paused;
      frame.__arenaPlaybackProbe.currentTimeAtPlaying = element.currentTime;
    }, { once: true });
    prototype.play = function (...args) {
      const result = play.apply(this, args);
      if (this === element && result && typeof result.then === "function") {
        frame.__arenaPlaybackProbe.promise = "pending";
        result.then(
          () => { frame.__arenaPlaybackProbe.promise = "resolved"; },
          (error) => { frame.__arenaPlaybackProbe.promise = `rejected:${error?.name ?? "PlaybackError"}`; },
        );
      }
      return result;
    };
  });
}

async function awaitPlaybackProbe(audio) {
  return audio.evaluate(async (element) => {
    const frame = element.ownerDocument.defaultView;
    const deadline = Date.now() + 3_000;
    while (Date.now() < deadline) {
      const probe = frame.__arenaPlaybackProbe;
      if (probe?.promise === "resolved" && probe.playing) return probe;
      if (probe?.promise?.startsWith("rejected:")) return probe;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    return frame.__arenaPlaybackProbe;
  });
}

const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM_PATH || "/repl/tools/bin/chromium",
  headless: true,
  args: ["--no-sandbox", "--disable-dev-shm-usage"],
});
const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, serviceWorkers: "block" });
const page = await context.newPage();
const pageErrors = [];
const importedExternalRequests = [];
let revisionRequests = 0;
page.on("pageerror", (error) => pageErrors.push(error.message));
page.on("request", (request) => {
  if (request.frame() !== page.mainFrame() && new URL(request.url()).origin !== new URL(base).origin) {
    importedExternalRequests.push(request.url());
  }
});
await context.addInitScript(() => {
  localStorage.setItem("af_local_mode", "0");
  localStorage.setItem("af_key_openrouter", "arcade-imported-audio-smoke");
});
await page.route("**/api/arcade/import/revise", async (route) => {
  const body = route.request().postDataJSON();
  revisionRequests += 1;
  assert.equal(body.ephemeral, true, "a local imported-game edit must not publish to the shared catalog");
  assert.match(body.priorCode, /data:ARENA_ASSET_TOKEN_0001/, "bundled WAV bytes must stay out of the revision request");
  assert(!body.priorCode.includes("data:audio/wav;base64,"), "raw WAV data must remain inside this browser");
  assert(body.priorCode.includes("score++"), "the real imported source must reach the revision route");
  const revised = body.priorCode.replace("score++", "score += 2");
  assert.notEqual(revised, body.priorCode, "the mocked model must make a real source change");
  await route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify({ code: revised }),
  });
});

try {
  await page.goto(`${base}/arcade`, { waitUntil: "domcontentloaded" });
  await page.getByRole("tab", { name: "Import and emulate" }).click();
  await page.getByLabel(/I own this game or have permission to use and play it/).check();

  const archive = new JSZip();
  archive.file("game/index.html", '<!doctype html><html><head><title>Arcade audio fixture</title></head><body><p id="score">Clicks 0</p><audio id="sound" src="assets/tone.wav"></audio><button id="play-sound">Play sound</button><script src="game.js"></script></body></html>');
  archive.file("game/game.js", 'let score=Number(localStorage.getItem("audio-score")||0);const label=document.getElementById("score"),sound=document.getElementById("sound");label.textContent="Clicks "+score;document.getElementById("play-sound").addEventListener("click",()=>{score++;localStorage.setItem("audio-score",String(score));label.textContent="Clicks "+score;void sound.play()});');
  archive.file("game/assets/tone.wav", makePcmWav());
  const archiveBuffer = await archive.generateAsync({ type: "nodebuffer", compression: "DEFLATE" });
  await page.locator('input[accept=".html,.htm,.zip,text/html,application/zip"]').setInputFiles({
    name: "arcade-audio-fixture.zip",
    mimeType: "application/zip",
    buffer: archiveBuffer,
  });

  const frameElement = page.locator('iframe[title="Playable game: arcade-audio-fixture.zip"]');
  const frame = page.frameLocator('iframe[title="Playable game: arcade-audio-fixture.zip"]');
  const audio = frame.locator("#sound");
  const playButton = frame.getByRole("button", { name: "Play sound", exact: true });
  await playButton.waitFor({ timeout: 15_000 });
  assert.equal(await frameElement.getAttribute("sandbox"), "allow-scripts", "the imported game must keep the restricted sandbox");
  assert.equal(await audio.getAttribute("src").then((src) => src?.startsWith("data:audio/wav;base64,")), true,
    "the imported WAV must be bundled into the offline game document");
  assert.equal(await audio.evaluate((element) => element.paused), true, "import must not autoplay game audio");

  await installPlaybackProbe(audio);
  await playButton.click();
  const originalPlayback = await awaitPlaybackProbe(audio);
  assert.equal(originalPlayback.promise, "resolved", `original imported WAV play() promise: ${JSON.stringify(originalPlayback)}`);
  assert.equal(originalPlayback.playing, true, "the original user click must produce a real playing event");
  assert.equal(originalPlayback.pausedAtPlaying, false, "the original media must be unpaused when playback begins");
  assert.equal(await frame.locator("#score").innerText(), "Clicks 1", "the game's own Play button must handle the click");
  await audio.evaluate((element) => element.pause());

  await page.getByLabel("Revise this browser game").fill("Make each Play click add two points.");
  await page.getByRole("button", { name: "Apply revision", exact: true }).click();
  await page.getByText("Revision applied. Play it, then keep it or undo it.", { exact: true }).waitFor({ timeout: 15_000 });
  const revisionDeadline = Date.now() + 10_000;
  let revisedScript = "";
  do {
    revisedScript = await frame.locator("script").evaluateAll((scripts) => scripts.map((script) => script.textContent ?? "").join("\n"));
    if (revisedScript.includes("score += 2")) break;
    await page.waitForTimeout(50);
  } while (Date.now() < revisionDeadline);
  assert(revisedScript.includes("score += 2"), "the active iframe must load the revised game source");
  const revisedAudio = frame.locator("#sound");
  assert.equal(await revisedAudio.getAttribute("src").then((src) => src?.startsWith("data:audio/wav;base64,")), true,
    "the bundled local WAV must survive source revision");
  assert.equal(await revisedAudio.evaluate((element) => element.readyState >= HTMLMediaElement.HAVE_ENOUGH_DATA), true,
    "the revised local WAV must be fully loaded before its user click");
  assert.equal(await revisedAudio.evaluate((element) => element.paused), true, "source revision must not autoplay audio");

  await installPlaybackProbe(revisedAudio);
  await frame.getByRole("button", { name: "Play sound", exact: true }).click();
  const revisedPlayback = await awaitPlaybackProbe(revisedAudio);
  assert.equal(revisedPlayback.promise, "resolved", `revised imported WAV play() promise: ${JSON.stringify(revisedPlayback)}`);
  assert.equal(revisedPlayback.playing, true, "the revised game's user click must produce a real playing event");
  assert.equal(revisedPlayback.pausedAtPlaying, false, "revised media must be unpaused when playback begins");
  assert.equal(await frame.locator("#score").innerText(), "Clicks 3", "the revised game button must still run after source replacement");
  assert.equal(revisionRequests, 1, "the UI must call the selected source-revision route once");

  const validAudioSource = await revisedAudio.getAttribute("src");
  await revisedAudio.evaluate((element) => {
    element.pause();
    element.src = "data:text/plain;base64,ZmFrZS1hdWRpbw==";
    element.load();
  });
  await revisedAudio.evaluate((element) => new Promise((resolve) => {
    if (element.error) return resolve(true);
    element.addEventListener("error", () => resolve(true), { once: true });
    setTimeout(() => resolve(false), 3_000);
  })).then((loaded) => assert.equal(loaded, true, "the deliberate unsupported-media fixture must reach a decode error"));
  await installPlaybackProbe(revisedAudio);
  await frame.getByRole("button", { name: "Play sound", exact: true }).click();
  await page.getByTestId("imported-audio-playback-error").waitFor({ timeout: 3_000 });
  const audioError = await page.getByTestId("imported-audio-playback-error").innerText();
  assert.match(audioError, /could not start/i);
  assert.match(audioError, /click play/i);
  assert.match(audioError, /NotSupportedError|PlaybackError/);
  assert.equal(await revisedAudio.evaluate((element) => element.paused), true, "failed play must not be presented as active");

  await revisedAudio.evaluate((element, source) => {
    element.src = source;
    element.load();
  }, validAudioSource);
  await revisedAudio.evaluate((element) => new Promise((resolve) => {
    if (element.readyState >= HTMLMediaElement.HAVE_ENOUGH_DATA) return resolve(true);
    element.addEventListener("canplay", () => resolve(true), { once: true });
    setTimeout(() => resolve(false), 3_000);
  })).then((loaded) => assert.equal(loaded, true, "the original bundled WAV must reload for recovery"));
  await installPlaybackProbe(revisedAudio);
  await frame.getByRole("button", { name: "Play sound", exact: true }).click();
  const recoveredPlayback = await awaitPlaybackProbe(revisedAudio);
  assert.equal(recoveredPlayback.promise, "resolved", "a later user click must recover after the failed audio attempt");
  await page.getByTestId("imported-audio-playback-error").waitFor({ state: "detached", timeout: 3_000 });
  assert.deepEqual(importedExternalRequests, [], "restricted imported audio must not make external requests");
  assert.deepEqual(pageErrors, [], "handled media failure must not escape as an uncaught page error");
  console.log("PASS: imported WAV plays after user clicks before and after source revision; failed playback shows an actionable error without autoplay or network access.");
} finally {
  await context.close();
  await browser.close();
}
