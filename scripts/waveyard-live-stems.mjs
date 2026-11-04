// Isolated real-browser audio-graph regression. Session persistence is mocked;
// generated WAV bytes are decoded and played by the real application engine.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { existsSync } from "node:fs";
import { runAutomaticFadeAcceptance, runLoudAutomaticFadeAcceptance } from "./waveyard-auto-fades.mjs";
const timingOnly = process.argv.includes("--live-stem-timing-only");
const studioConflictOnly = process.argv.includes("--studio-conflict-only");
const studioSelectionFreshnessOnly = process.argv.includes("--studio-selection-freshness-only");
const requireBrowserEngines = process.env.WAVEYARD_REQUIRE_BROWSER_ENGINES === "1"
  || process.argv.includes("--require-browser-engines");
const headedWebKit = process.argv.includes("--headed-webkit");
if (process.argv.includes("--live-stem-timing-matrix")) {
  const { spawnSync } = await import("node:child_process");
  const skippedEngines = [];
  for (const engine of ["chromium", "webkit", "firefox"]) {
    console.log(`LIVE_STEM_TIMING_ENGINE ${engine}`);
    const args = [process.argv[1], "--live-stem-timing-only", `--engine=${engine}`];
    if (requireBrowserEngines) args.push("--require-browser-engines");
    const result = spawnSync(process.execPath, args, {
      stdio: "inherit",
      env: process.env,
    });
    if (result.error) throw result.error;
    if (result.status === 3 && !requireBrowserEngines) {
      skippedEngines.push(engine);
      continue;
    }
    if (result.status !== 0) process.exit(result.status ?? 1);
  }
  if (skippedEngines.length > 0) {
    console.log(`PARTIAL: timing checks skipped for ${skippedEngines.join(", ")}; this is not full cross-browser coverage.`);
  } else {
    console.log("PASS: Chromium, WebKit, and Firefox timing checks all completed.");
  }
  process.exit(0);
}
const require = createRequire(new URL("../artifacts/api-server/package.json", import.meta.url));
const { chromium, firefox, webkit } = require("playwright-core");
const engineName = process.argv.find(argument => argument.startsWith("--engine="))?.slice("--engine=".length) ?? "chromium";
const browserTypes = { chromium, firefox, webkit };
const browserType = browserTypes[engineName];
if (!browserType) throw new Error(`Unknown browser engine "${engineName}". Choose chromium, firefox, or webkit.`);
const sessionId = "00000000-0000-4000-8000-000000000007";
const loudFadesOnly = process.argv.includes("--loud-fades-only");
const automaticFadesOnly = loudFadesOnly || process.argv.includes("--automatic-fades-only");
const donorReplacementOnly = process.argv.includes("--donor-replacement-only");
const parallelStemSwapsOnly = process.argv.includes("--parallel-stem-swaps-only");
const sharedDonorRetryOnly = process.argv.includes("--shared-donor-retry-only");
const sameStemSwapsOnly = process.argv.includes("--same-stem-swaps-only");
const stemControlsReopenOnly = process.argv.includes("--stem-controls-reopen-only");
const pitchModesOnly = process.argv.includes("--pitch-modes-only");
const keyMatchingOnly = process.argv.includes("--key-matching-only");
const crossTabSpeedOnly = process.argv.includes("--cross-tab-speed-only");
const mobileBrowserEmulation = process.argv.includes("--mobile-browser-emulation");
const disableBroadcastChannel = process.argv.includes("--disable-broadcast-channel");
const crossTabStemMixOnly = process.argv.includes("--cross-tab-stem-mix-only");
let donorSwapSequence = 0;
let failNextDonorRestore = false;
const donorRestoreRequests = [];
const types = ["vocals", "drums", "bass", "other"];
let parallelDonorResponses = null;
const parallelDonorRequestOrder = [];
const parallelDonorResponseOrder = [];
let parallelSwapResponses = null;
const parallelSwapRequestOrder = [];
const parallelSwapResponseOrder = [];
const parallelSwapDeleteRequests = [];
let sameStemSaveResponses = null;
const sameStemSaveRequestOrder = [];
const sameStemSaveResponseOrder = [];
let holdStemMixPatchResponses = false;
const pendingStemMixPatchRequests = [];
function waitForSignal(signal, label, timeoutMs = 15_000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Timed out waiting for ${label} after ${timeoutMs}ms.`)), timeoutMs);
    Promise.resolve(signal).then(
      value => { clearTimeout(timer); resolve(value); },
      error => { clearTimeout(timer); reject(error); },
    );
  });
}
async function setSessionRateInPage(targetPage, rate) {
  await targetPage.getByTestId("session-playback-speed").evaluate((element, value) => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set;
    setter.call(element, String(value));
    element.dispatchEvent(new Event("input", { bubbles: true }));
    element.dispatchEvent(new Event("change", { bubbles: true }));
  }, rate);
  await targetPage.waitForFunction(value =>
    document.querySelector('[data-testid="session-speed-value"]')?.textContent === `${Number(value).toFixed(2)}×`,
  rate);
}
async function waitForSessionRateInPage(targetPage, rate, bpm) {
  try {
    await targetPage.waitForFunction(({ expectedRate, expectedBpm }) => {
      const slider = document.querySelector('[data-testid="session-playback-speed"]');
      const text = slider?.getAttribute("aria-valuetext") ?? "";
      return slider instanceof HTMLInputElement
        && Math.abs(Number(slider.value) - expectedRate) < 0.001
        && text.includes(`${expectedBpm} BPM`);
    }, { expectedRate: rate, expectedBpm: bpm }, { timeout: 8_000 });
  } catch (error) {
    const state = await targetPage.evaluate(() => ({
      current: document.querySelector('[data-role="current"]')?.textContent?.trim(),
      speed: document.querySelector('[data-testid="session-playback-speed"]')?.getAttribute("aria-valuetext"),
      outputs: [...document.querySelectorAll('[data-testid="session-speed-value"]')].map(node => node.textContent),
      playing: [...document.querySelectorAll('[data-role="current"] audio')].map(audio => audio.paused),
      rates: [...document.querySelectorAll('[data-role="current"] audio')].map(audio => audio.playbackRate),
      messages: window.audioProbe.transportMessages.slice(-8),
    }));
    console.error("SESSION_RATE_TIMEOUT", JSON.stringify({ rate, bpm, state }));
    throw error;
  }
}
function wav(seconds, frequency, amplitude = 2000 / 32767, held = false, channels = 1) {
  const n = 22050 * seconds, data = Buffer.alloc(44 + n * 2 * channels);
  data.write("RIFF"); data.writeUInt32LE(data.length - 8, 4); data.write("WAVEfmt ", 8);
  data.writeUInt32LE(16, 16); data.writeUInt16LE(1, 20); data.writeUInt16LE(channels, 22);
  data.writeUInt32LE(22050, 24); data.writeUInt32LE(44100 * channels, 28);
  data.writeUInt16LE(2 * channels, 32); data.writeUInt16LE(16, 34); data.write("data", 36);
  data.writeUInt32LE(n * 2 * channels, 40);
  for (let i = 0; i < n; i++) for (let ch = 0; ch < channels; ch++)
    data.writeInt16LE(Math.round(32767 * amplitude * (held ? 1 : Math.sin(i * frequency * Math.PI * 2 / 22050))), 44 + (i * channels + ch) * 2);
  return data;
}
function downsampleFixtureWav(data, sampleRate = 8000) {
  const channels = data.readUInt16LE(22);
  const sourceRate = data.readUInt32LE(24);
  const sourceFrames = Math.floor((data.length - 44) / (channels * 2));
  const targetFrames = Math.floor(sourceFrames * sampleRate / sourceRate);
  const converted = Buffer.alloc(44 + targetFrames * channels * 2);
  converted.write("RIFF");
  converted.writeUInt32LE(converted.length - 8, 4);
  converted.write("WAVEfmt ", 8);
  converted.writeUInt32LE(16, 16);
  converted.writeUInt16LE(1, 20);
  converted.writeUInt16LE(channels, 22);
  converted.writeUInt32LE(sampleRate, 24);
  converted.writeUInt32LE(sampleRate * channels * 2, 28);
  converted.writeUInt16LE(channels * 2, 32);
  converted.writeUInt16LE(16, 34);
  converted.write("data", 36);
  converted.writeUInt32LE(targetFrames * channels * 2, 40);
  for (let frame = 0; frame < targetFrames; frame += 1) {
    const sourceFrame = Math.floor(frame * sourceRate / sampleRate);
    for (let channel = 0; channel < channels; channel += 1) {
      converted.writeInt16LE(
        data.readInt16LE(44 + (sourceFrame * channels + channel) * 2),
        44 + (frame * channels + channel) * 2,
      );
    }
  }
  return converted;
}
const assets = new Map();
assets.set("a-source", wav(20, 130));
assets.set("b-source", wav(8, 230));
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
    analysis: {
      bpm: index === 1 ? 124 : 120,
      musicalKey: ["A minor", "C major", "C# major"][index],
      beatGridMs: index === 0 ? Array.from({ length: 6 }, (_, beat) => beat * 4_000) : null,
    } };
});
const sourceOnlyTrack = { ...tracks[0], stems: [], playback: { kind: "source", assetIds: ["a-source"] } };
const externalStemKeys = types.map(stem => {
  const key = `d-${stem}`;
  assets.set(key, wav(4, 530 + types.indexOf(stem) * 40));
  return { id: key, stemType: stem, engine: "synthetic-test" };
});
const webkitAudioFixtures = engineName === "webkit" && mobileBrowserEmulation
  ? Object.fromEntries([...assets.entries()].map(([id, data]) => [
      `/api/assets/${id}`,
      `data:audio/wav;base64,${downsampleFixtureWav(data).toString("base64")}`,
    ]))
  : {};
const libraryRows = tracks.map((item, index) => ({
  id: item.track.id, title: item.track.title, artist: "Synthetic fixture", album: "",
  durationSeconds: item.track.durationSeconds, playCount: 0, rating: 0, labels: [], lastPlayedAt: null,
  addedAt: new Date().toISOString(), stemAvailability: { status: "separated", stemCount: 4, stemTypes: types },
  studioProjectId: `fixture-project-${index}`,
}));
const preparationDonorId = "prep-source";
const preparationDonorRow = {
  id: preparationDonorId,
  title: "Prepared library source",
  artist: "Synthetic fixture",
  album: "",
  durationSeconds: 18,
  playCount: 0,
  rating: 0,
  labels: [],
  lastPlayedAt: null,
  addedAt: new Date().toISOString(),
  stemAvailability: { status: "not-started", reason: "Stem separation has not started." },
  studioProjectId: "fixture-project-prep",
};
const retryDonorId = "retry-source";
const retryDonorRow = {
  ...preparationDonorRow,
  id: retryDonorId,
  title: "Retryable library source",
  stemAvailability: { status: "failed", reason: "A previous attempt failed.", retryJobId: "retry-prep-job" },
  studioProjectId: "fixture-project-retry",
};
let liveQueue = [];
let exposeSeparatedSource = false;
let showSeparationProgress = false;
let suppressSessionStateWritesForStemSwitchFixture = false;
let unstartedCurrentSessionTrack = false;
let currentSessionSeparationRequests = 0;
let ignoreSessionStateWrites = false;
let preparationRequested = false;
let preparationStartRequests = 0;
let retryRequested = false;
let preparationRetryRequests = 0;
let abortNextLibraryUpload = false;
let libraryUploadRequests = 0;
let heldAssetId = null;
let heldAssetGate = null;
let signalHeldAssetRequest = null;
let signalHeldAssetRouteFinished = null;
let pendingSwapSaveGate = null;
let signalPendingSwapSaveStarted = null;
let pendingSwapDeleteGate = null;
let timedAssetId = null;
let timedAssetDelayMs = 0;
const session = { id: sessionId, name: "Live layer regression", currentSessionTrackId: "a", positionSeconds: 0,
  tracks, swaps: [], createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
const pitchAcceptanceTrackSnapshot = structuredClone(tracks);
const studioProjectId = "00000000-0000-4000-8000-000000000008";
const studioRemixId = "00000000-0000-4000-8000-000000000009";
const secondStudioProjectId = "00000000-0000-4000-8000-000000000010";
let failStudioHandoff = false;
let holdStudioHandoff = false;
let releaseStudioHandoff = null;
let signalStudioHandoffStarted = null;
let studioHandoffRequests = 0;
let lastStudioHandoffSelection = [];
let forcedStudioRefusals = new Map();
let studioProjectCreations = 0;
let studioProjectData = null;
let studioRemixData = null;
let holdSecondStudioProjectLoad = false;
let secondStudioProjectLoadSignal = null;
let secondStudioProjectLoadGate = null;
let studioHasRemix = true;
let automaticRemixAttempts = 0;
let holdNextStudioRemixPut = false;
let signalHeldStudioRemixPut = null;
let releaseHeldStudioRemixPut = null;
let studioRemixPutCount = 0;
let sourceEventRequests = 0;
let meetingPointRequests = 0;
let sectionArrangementRequests = 0;
let projectLoadAttempts = 0;
let failFirstProjectLoad = false;
let failNextModelCheck = false;
const assetSnapshot = () => [...assets.entries()]
  .map(([id, bytes]) => [id, createHash("sha256").update(bytes).digest("hex")])
  .sort(([left], [right]) => left.localeCompare(right));
let browser;
try {
  const chromiumExecutable = process.env.CHROMIUM_PATH
    ?? (existsSync("/repl/tools/bin/chromium") ? "/repl/tools/bin/chromium" : undefined);
  browser = await browserType.launch(engineName === "chromium"
    ? { ...(chromiumExecutable ? { executablePath: chromiumExecutable } : {}),
      args: ["--no-sandbox", "--autoplay-policy=no-user-gesture-required"] }
    : { headless: engineName === "webkit" ? !headedWebKit : true });
  console.log("BROWSER_ENGINE", JSON.stringify({
    engine: engineName,
    version: browser.version(),
    mobileEmulation: mobileBrowserEmulation,
    physicalDevice: false,
  }));
} catch (error) {
  if (timingOnly) {
    const detail = error instanceof Error ? error.message.split("\n")[0] : String(error);
    if (requireBrowserEngines) {
      console.error(`ERROR: required ${engineName} timing coverage cannot start: ${detail}`);
      process.exit(1);
    }
    console.log(`SKIP: ${engineName} timing coverage is unavailable here: ${detail}`);
    process.exit(3);
  }
  throw error;
}
try {
  const context = await browser.newContext({
    serviceWorkers: "block",
    ...(mobileBrowserEmulation
      ? { viewport: { width: 1280, height: 800 }, deviceScaleFactor: 3, hasTouch: true }
      : {}),
  });
  let page = await context.newPage();
  page.on("pageerror", error => console.log("PAGE_ERROR", error.stack));
  page.on("console", message => {
    if (message.type() === "error") console.log("BROWSER_CONSOLE_ERROR", message.text());
  });
  if (engineName === "webkit") {
    page.on("requestfailed", request => console.log("WEBKIT_REQUEST_FAILED", JSON.stringify({
      url: request.url(),
      failure: request.failure()?.errorText ?? "unknown",
    })));
    page.on("response", response => {
      if (response.status() >= 400) {
        console.log("WEBKIT_HTTP_ERROR", response.status(), response.url());
      }
    });
  }
  await context.addInitScript(({
    fixtureSessionId,
    probeAutoFades,
    disableBroadcastChannel,
    webkitAudioFixtures,
  }) => {
    if (disableBroadcastChannel) {
      Object.defineProperty(window, "BroadcastChannel", { configurable: true, value: undefined });
    }
    if (Object.keys(webkitAudioFixtures).length > 0) {
      const webkitAudioFixtureUrls = Object.fromEntries(
        Object.entries(webkitAudioFixtures).map(([path, dataUri]) => {
          const base64 = dataUri.slice(dataUri.indexOf(",") + 1);
          const decoded = atob(base64);
          const bytes = new Uint8Array(decoded.length);
          for (let index = 0; index < decoded.length; index += 1) {
            bytes[index] = decoded.charCodeAt(index);
          }
          return [path, URL.createObjectURL(new Blob([bytes], { type: "audio/wav" }))];
        }),
      );
      const srcDescriptor = Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, "src");
      const currentSrcDescriptor = Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, "currentSrc");
      const setMediaSource = (element, value) => {
        const logicalUrl = new URL(element.dataset.waveyardAssetUrl ?? String(value), window.location.href);
        element.dataset.waveyardFixtureSrc = logicalUrl.href;
        element.dataset.waveyardMediaSrc = String(value);
        const source = String(value).startsWith("blob:")
          ? value
          : webkitAudioFixtureUrls[logicalUrl.pathname] ?? value;
        srcDescriptor.set.call(element, source);
      };
      Object.defineProperty(HTMLMediaElement.prototype, "src", {
        ...srcDescriptor,
        get() {
          return this.dataset.waveyardFixtureSrc ?? srcDescriptor.get.call(this);
        },
        set(value) {
          setMediaSource(this, value);
        },
      });
      if (currentSrcDescriptor?.configurable) {
        Object.defineProperty(HTMLMediaElement.prototype, "currentSrc", {
          ...currentSrcDescriptor,
          get() {
            return this.dataset.waveyardFixtureSrc ?? currentSrcDescriptor.get.call(this);
          },
        });
      }
      const nativeSetAttribute = Element.prototype.setAttribute;
      Element.prototype.setAttribute = function (name, value) {
        if (this instanceof HTMLMediaElement && name.toLowerCase() === "src") {
          setMediaSource(this, value);
          return;
        }
        return nativeSetAttribute.call(this, name, value);
      };
    }
    window.audioProbe = {
      sources: [], buffers: [], worklets: [], masterGains: [], outputAnalyzers: [], decodedAudio: [],
      combinedInputs: [], combinedOutputs: [], playStarts: [],
      workletLoads: [], workletSeeks: [], workletRates: [], keyShifts: [], transportMessages: [],
      storageTransportMessages: [], storageTransportReceives: [], contexts: [],
    };
    window.audioProbe.currentStemGain = stemType => {
      const deck = document.querySelector('[data-role="current"]');
      const audio = [...(deck?.querySelectorAll("audio") ?? [])]
        .find(element => element.src.endsWith(`/a-${stemType}`));
      const source = window.audioProbe.sources.find(entry => entry.mediaElement === audio);
      return source?.inputNode?.nextNode?.gain?.value ?? null;
    };
    window.audioProbe.currentMasterGain = () => {
      const deckIndex = document.querySelector('[data-role="current"]')?.getAttribute("data-testid") === "session-deck-b" ? 1 : 0;
      return window.audioProbe.masterGains
        .find(master => master.probeDeckIndex === deckIndex)?.gain.value ?? null;
    };
    window.addEventListener("storage", event => {
      if (event.key !== "waveyard:queue-change" || event.newValue === null) return;
      try {
        const message = JSON.parse(event.newValue);
        if (message?.transport) window.audioProbe.storageTransportReceives.push(message);
      } catch {
        // The app independently ignores malformed storage events.
      }
    });
    const nativeStorageSetItem = Storage.prototype.setItem;
    Storage.prototype.setItem = function (key, value) {
      if (key === "waveyard:queue-change") {
        try {
          const message = JSON.parse(String(value));
          if (message?.transport) {
            window.audioProbe.transportMessages.push(message);
            window.audioProbe.storageTransportMessages.push(message);
          }
        } catch {
          // The app independently ignores malformed storage events.
        }
      }
      return nativeStorageSetItem.call(this, key, value);
    };
    if (probeAutoFades) {
      const nativePlay = HTMLMediaElement.prototype.play;
      HTMLMediaElement.prototype.play = function (...args) {
        const deckId = this.closest('[data-testid="session-deck-a"], [data-testid="session-deck-b"]')?.getAttribute("data-testid");
        const deck = deckId === "session-deck-a" ? 0 : deckId === "session-deck-b" ? 1 : null;
        window.audioProbe.playStarts.push({ deck, src: this.src,
          master: deck === null ? null : window.audioProbe.masterGains[deck]?.gain.value ?? null });
        return nativePlay.apply(this, args);
      };
    }
    if (window.BroadcastChannel) {
      const nativePostMessage = window.BroadcastChannel.prototype.postMessage;
      window.BroadcastChannel.prototype.postMessage = function (message, ...args) {
        if (this.name === "waveyard:queue-sync" && message?.transport) {
          window.audioProbe.transportMessages.push(JSON.parse(JSON.stringify(message)));
        }
        return nativePostMessage.call(this, message, ...args);
      };
    }
    window.liveStemTimings = [];
    window.liveStemSelectionStart = null;
    window.liveStemObservedAudibleAt = null;
    window.liveAssetFetchTrace = [];
    window.addEventListener("waveyard:live-stem-timing", event => {
      window.liveStemTimings.push(event.detail);
    });
    window.modelStatusFetchModes = [];
    window.liveStemAssetFetchTrace = [];
    let leavingDocument = false;
    window.addEventListener("pagehide", () => { leavingDocument = true; }, { once: true });
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "hidden") leavingDocument = true;
    });
    const originalFetch = window.fetch.bind(window);
    window.fetch = (input, init) => {
      const rawUrl = input instanceof Request ? input.url : String(input);
      const url = new URL(rawUrl, window.location.href);
      const keepalive = init?.keepalive ?? (input instanceof Request && input.keepalive);
      if (url.pathname === "/api/waveyard/separation/models") {
        window.modelStatusFetchModes.push(init?.cache ?? "default");
      }
      if (url.pathname.startsWith("/api/assets/")) {
        window.liveStemAssetFetchTrace.push(url.pathname);
      }
      if (url.pathname === "/api/assets/d-vocals") {
        window.liveAssetFetchTrace.push(performance.now());
      }
      // Keep fixture-session unload saves out of the real API; Playwright cannot
      // reliably route keepalive fetches once the page is leaving.
      if (keepalive && leavingDocument && url.pathname === `/api/library/sessions/${fixtureSessionId}/state`) {
        return Promise.resolve(new Response(JSON.stringify({ saved: true }), {
          status: 200, headers: { "Content-Type": "application/json" },
        }));
      }
      return originalFetch(input, init);
    };
    const Base = window.AudioContext;
    window.AudioContext = class extends Base {
      constructor(...args) {
        super(...args);
        window.audioProbe.contexts.push(this);
      }
      decodeAudioData(...args) {
        return super.decodeAudioData(...args).then(buffer => {
          window.audioProbe.decodedAudio.push({ context: this, duration: buffer.duration });
          return buffer;
        });
      }
      createGain() {
        const node = super.createGain(), connect = node.connect.bind(node);
        node.connect = (target, ...args) => {
          node.nextNode = target;
          if (target instanceof AnalyserNode) {
            (node.probeAnalysers ??= []).push(target);
          }
          if (target instanceof ChannelSplitterNode && !window.audioProbe.masterGains.includes(node)) {
            window.audioProbe.masterGains.push(node);
            this.probePendingMaster = node;
            node.waveyardProbeMaster = probeAutoFades;
            if (probeAutoFades && node.probeAnalysers?.[0])
              window.audioProbe.outputAnalyzers.push({ analyser: node.probeAnalysers[0], master: node });
          }
          if (probeAutoFades && target.probeName === "waveyard-output-peak") {
            const analyser = this.createAnalyser();
            analyser.fftSize = 2048;
            connect(analyser);
            window.audioProbe.combinedInputs.push(analyser);
          }
          if (node.waveyardProbeMaster && target instanceof AnalyserNode &&
              !window.audioProbe.outputAnalyzers.some(entry => entry.analyser === target)) {
            window.audioProbe.outputAnalyzers.push({ analyser: target, master: node });
          }
          return connect(target, ...args);
        };
        return node;
      }
      createMediaElementSource(media) {
        if (this.probePendingMaster) {
          const deck = media.closest('[data-testid="session-deck-a"], [data-testid="session-deck-b"]');
          const index = deck?.getAttribute("data-testid") === "session-deck-b" ? 1 : 0;
          this.probePendingMaster.probeDeckIndex = index;
          this.probePendingMaster = null;
          // Saved standby donors can build their graph first. Creation order
          // is not physical-deck identity when both decks share one context.
          window.audioProbe.masterGains.sort((a, b) => (a.probeDeckIndex ?? 9) - (b.probeDeckIndex ?? 9));
          window.audioProbe.outputAnalyzers.sort((a, b) => (a.master.probeDeckIndex ?? 9) - (b.master.probeDeckIndex ?? 9));
        }
        const node = super.createMediaElementSource(media), connect = node.connect.bind(node);
        node.connect = (target, ...args) => { node.inputNode = target; return connect(target, ...args); };
        window.audioProbe.sources.push(node); return node;
      }
      createBufferSource() {
        const node = super.createBufferSource(), start = node.start.bind(node), stop = node.stop.bind(node), connect = node.connect.bind(node);
        node.connect = (target, ...args) => { node.inputNode = target; return connect(target, ...args); };
        node.start = (when, offset, ...args) => {
          node.startedOffset = offset;
          node.startedContextTime = typeof when === "number" && when > this.currentTime
            ? when
            : this.currentTime;
          node.recipientTimeAtStart = document.querySelector('[data-role="current"] audio')?.currentTime ?? null;
          return start(when, offset, ...args);
        };
        node.stop = (...args) => { node.stopCount = (node.stopCount ?? 0) + 1; return stop(...args); };
        window.audioProbe.buffers.push(node); return node;
      }
    };
    if (window.AudioWorkletNode) {
      const NativeAudioWorkletNode = window.AudioWorkletNode;
      window.AudioWorkletNode = class extends NativeAudioWorkletNode {
        constructor(...args) {
          super(...args);
          this.probeName = args[1];
          this.probeConnections = [];
          const postMessage = this.port.postMessage.bind(this.port);
          this.port.postMessage = (message, ...postArgs) => {
            if (message?.type === "load") {
              const channelCount = message.channels?.length ?? 0;
              const firstChannel = channelCount > 0 ? new Float32Array(message.channels[0]) : new Float32Array();
              let firstCrossing = null;
              let lastCrossing = null;
              let crossingCount = 0;
              const sampleLimit = Math.min(firstChannel.length, Math.round(this.context.sampleRate * 0.25));
              for (let index = 1; index < sampleLimit; index += 1) {
                const previous = firstChannel[index - 1], current = firstChannel[index];
                if (previous <= 0 && current > 0) {
                  const crossing = index - 1 + (-previous / (current - previous));
                  firstCrossing ??= crossing;
                  lastCrossing = crossing;
                  crossingCount += 1;
                }
              }
              window.audioProbe.workletLoads.push({
                node: this,
                context: this.context,
                channelCount,
                pcmBytes: (message.channels ?? []).reduce((total, channel) => total + channel.byteLength, 0),
                duration: channelCount > 0
                  ? message.channels[0].byteLength / Float32Array.BYTES_PER_ELEMENT / this.context.sampleRate
                  : 0,
                startFrame: message.startFrame,
                rate: message.rate,
                pitchPreserving: message.pitchPreserving,
                inputHz: crossingCount > 1 && lastCrossing !== firstCrossing
                  ? this.context.sampleRate * (crossingCount - 1) / (lastCrossing - firstCrossing)
                  : 0,
                at: performance.now(),
              });
            } else if (message?.type === "seek") {
              window.audioProbe.workletSeeks.push({
                node: this,
                context: this.context,
                frame: message.frame,
                at: performance.now(),
                contextTime: this.context.currentTime,
              });
            } else if (message?.type === "rate") {
              window.audioProbe.workletRates.push({
                node: this,
                context: this.context,
                rate: message.value,
                at: performance.now(),
                contextTime: this.context.currentTime,
              });
            } else if (message?.type === "key-shift") {
              window.audioProbe.keyShifts.push({ node: this, context: this.context, semitones: message.semitones, at: performance.now() });
            }
            return postMessage(message, ...postArgs);
          };
          const connect = this.connect.bind(this);
          this.connect = (target, ...connectArgs) => {
            this.probeConnections.push(target);
            if (probeAutoFades && this.probeName === "waveyard-output-peak" && target instanceof AnalyserNode)
              window.audioProbe.combinedOutputs.push(target);
            return connect(target, ...connectArgs);
          };
          if (this.probeName !== "waveyard-output-peak") window.audioProbe.worklets.push(this);
        }
      };
    }
  }, {
    fixtureSessionId: sessionId,
    probeAutoFades: automaticFadesOnly,
    disableBroadcastChannel,
    webkitAudioFixtures,
  });
  let failAsset = null;
  let failedAssetRequests = 0;
  const liveSwapRequestOrder = [];
  const assetRequestTrace = [];
  let externalDonorSaveGate = null;
  let signalExternalDonorSave;
  let signalExternalDonorWarm;
  await context.route("**/api/assets/*", async route => {
    const id = new URL(route.request().url()).pathname.split("/").at(-1);
    assetRequestTrace.push({
      id,
      resourceType: route.request().resourceType(),
      range: route.request().headers().range ?? null,
    });
    if (id === timedAssetId && timedAssetDelayMs > 0) {
      await new Promise(resolve => setTimeout(resolve, timedAssetDelayMs));
    }
    if (id === "b-vocals" && heldAssetId === "b-vocals") liveSwapRequestOrder.push("donor-preload");
    if (id === "d-vocals") {
      liveSwapRequestOrder.push("donor-preload:d-vocals");
      signalExternalDonorWarm?.();
    }
    // Hold the live-swap fetch, not the separate <audio> request used to preload
    // the same song for upcoming playback.
    const parallelDonor = route.request().resourceType() === "fetch"
      ? parallelDonorResponses?.get(id)
      : null;
    if (parallelDonor) {
      parallelDonorRequestOrder.push(id);
      parallelDonor.signalStarted();
      await parallelDonor.promise;
      parallelDonorResponseOrder.push(id);
      parallelDonor.signalFinished?.();
    }
    const isHeldAssetRequest = id === heldAssetId && heldAssetGate !== null;
    if (isHeldAssetRequest) {
      signalHeldAssetRequest?.(route.request());
      await heldAssetGate;
    }
    if (id === failAsset) {
      failedAssetRequests += 1;
      try {
        await route.fulfill({ status: 503, headers: { "Cache-Control": "no-store" }, body: "Test failure" });
      } catch {
        if (!parallelDonor) throw new Error(`Asset ${id} failed after its browser request had already been cancelled.`);
      }
      return;
    }
    const body = assets.get(id);
    if (!body) return route.fulfill({ status: 404 });
    const range = route.request().headers().range?.match(/^bytes=(\d+)-(\d*)$/);
    const start = range ? Number(range[1]) : 0, end = range?.[2] ? Math.min(Number(range[2]), body.length - 1) : body.length - 1;
    const response = {
      status: range ? 206 : 200, contentType: "audio/wav", body: body.subarray(start, end + 1),
      headers: { "Accept-Ranges": "bytes", "Content-Length": String(end - start + 1),
        "Cache-Control": "no-store",
        ...(range ? { "Content-Range": `bytes ${start}-${end}/${body.length}` } : {}) },
    };
    if (!isHeldAssetRequest) {
      try {
        await route.fulfill(response);
      } catch {
        if (!parallelDonor) throw new Error(`Asset ${id} could not be fulfilled.`);
      }
      return;
    }
    try {
      await route.fulfill(response);
    } catch {
      // The application may abort this deliberately held request when the user cancels.
    } finally {
      signalHeldAssetRouteFinished?.(route.request());
    }
  });
  await context.route("**/api/library/tracks", route => {
    if (route.request().method() === "POST") {
      libraryUploadRequests += 1;
      if (abortNextLibraryUpload) {
        abortNextLibraryUpload = false;
        return route.abort("failed");
      }
      return route.fulfill({ status: 201, json: { track: libraryRows[0], created: true, separationQueued: true } });
    }
    const visibleLibraryRows = showSeparationProgress
      ? libraryRows.map(row => row.id === libraryRows[0].id
        ? {
            ...row,
            stemAvailability: {
              status: "processing",
              reason: "Stem separation is still running.",
              stage: "separating",
              progress: { percent: 36, phase: "2/4" },
            },
          }
        : row)
      : unstartedCurrentSessionTrack
        ? libraryRows.map(row => row.id === "a"
          ? { ...row, stemAvailability: { status: "not-started", reason: "Stem separation has not started." } }
          : row)
        : libraryRows;
    return route.fulfill({ json: { tracks: [
      ...visibleLibraryRows,
      {
        ...preparationDonorRow,
        stemAvailability: preparationRequested
          ? { status: "processing", reason: "Stem separation is running.", stage: "separating", progress: { percent: 12, phase: "1/4" } }
          : preparationDonorRow.stemAvailability,
      },
      {
        ...retryDonorRow,
        stemAvailability: retryRequested
          ? { status: "processing", reason: "Stem separation retry is running.", stage: "separating", progress: { percent: 8, phase: "1/4" } }
          : retryDonorRow.stemAvailability,
      },
      { ...libraryRows[0], id: "d", title: "Test D", stemAvailability: { status: "separated", stemCount: 4, stemTypes: types }, studioProjectId: "fixture-project-d" },
    ] } });
  });
  await context.route("**/api/library/tracks/d", route => route.fulfill({ json: { track: {
    id: "d",
    stems: externalStemKeys,
    analysis: null,
  } } }));
  await context.route(`**/api/library/tracks/${preparationDonorId}/separation`, route => {
    if (route.request().method() !== "POST") return route.fallback();
    preparationStartRequests += 1;
    preparationRequested = true;
    return route.fulfill({ status: 202, json: { state: "queued", jobId: "prep-job", stemCount: null, error: null } });
  });
  await context.route("**/api/jobs/retry-prep-job/retry", route => {
    if (route.request().method() !== "POST") return route.fallback();
    preparationRetryRequests += 1;
    retryRequested = true;
    return route.fulfill({ status: 200, json: { job: { id: "retry-prep-job", status: "queued" } } });
  });
  await context.route("**/api/library/tracks/a/separation", route => {
    if (route.request().method() !== "POST") return route.fallback();
    currentSessionSeparationRequests += 1;
    unstartedCurrentSessionTrack = false;
    showSeparationProgress = true;
    return route.fulfill({ status: 202, json: { state: "queued", jobId: "session-separation-job", stemCount: null, error: null } });
  });
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
        // Separation refreshes library assets, not the session's saved faders
        // or transition settings.
        tracks: session.tracks.map(item => item.id === "a" ? {
          ...item,
          sourceAssetId: tracks[0].sourceAssetId,
          stems: tracks[0].stems,
          playback: tracks[0].playback,
        } : item),
      } } });
    }
    if (url.pathname.endsWith("/swaps") && request.method() === "POST") {
      if (body.expectedSwapId) {
        donorRestoreRequests.push(body);
        if (failNextDonorRestore) {
          failNextDonorRestore = false;
          return route.fulfill({ status: 503, json: { error: "Temporary restore outage." } });
        }
        const selected = session.swaps.find(s => s.sessionTrackId === body.sessionTrackId && s.stemType === body.stemType);
        if (selected?.id !== body.expectedSwapId) return route.fulfill({ json: { session } });
      }
      const sameStemSave = sameStemSaveResponses?.get(body.toTrackId);
      if (sameStemSave?.failBeforePersist) {
        sameStemSaveRequestOrder.push(body.toTrackId);
        sameStemSave.signalStarted();
        await sameStemSave.promise;
        sameStemSaveResponseOrder.push(body.toTrackId);
        sameStemSave.signalFinished?.();
        return route.fulfill({ status: 503, json: { error: "An earlier donor save failed after a newer choice was made." } });
      }
      if (body.toTrackId === "b" && body.stemType === "vocals") liveSwapRequestOrder.push("save");
      if (body.toTrackId === "b" && body.stemType === "vocals" && pendingSwapSaveGate) {
        signalPendingSwapSaveStarted?.();
        await pendingSwapSaveGate;
      }
      if (body.toTrackId === "d" && body.stemType === "vocals" && externalDonorSaveGate) {
        liveSwapRequestOrder.push("save-start:d");
        signalExternalDonorSave?.();
        await externalDonorSaveGate;
        liveSwapRequestOrder.push("save-complete:d");
      }
      session.swaps = session.swaps.filter(s => !(s.sessionTrackId === body.sessionTrackId && s.stemType === body.stemType));
      session.swaps.push({ ...body, id: donorReplacementOnly || sameStemSwapsOnly ? `swap-${++donorSwapSequence}` : `swap-${body.stemType}`,
        toStemAssetId: body.toStemAssetId
          ?? (body.toTrackId === "d"
            ? externalStemKeys.find(stem => stem.stemType === body.stemType)?.id
            : `${body.toTrackId}-${body.stemType}`),
        fromTrackId: "a", createdAt: new Date().toISOString(),
        donorTrack: body.toTrackId === "d" ? { id: "d", title: "Test D", stems: externalStemKeys } : undefined });
      if (sameStemSave) {
        sameStemSaveRequestOrder.push(body.toTrackId);
        sameStemSave.snapshot = structuredClone(session);
        sameStemSave.signalStarted();
        await sameStemSave.promise;
        sameStemSaveResponseOrder.push(body.toTrackId);
        sameStemSave.signalFinished?.();
        if (sameStemSave.failAfterPersist) {
          return route.fulfill({ status: 503, json: { error: "The older donor response failed after a newer choice was saved." } });
        }
        return route.fulfill({ json: { session: sameStemSave.snapshot } });
      }
      const parallelSave = parallelSwapResponses?.get(body.stemType);
      if (parallelSave) {
        parallelSwapRequestOrder.push(body.stemType);
        parallelSave.snapshot = structuredClone(session);
        parallelSave.signalStarted();
        await parallelSave.promise;
        parallelSwapResponseOrder.push(body.stemType);
        return route.fulfill({ json: { session: parallelSave.snapshot } });
      }
    } else if (url.pathname.endsWith("/tracks") && request.method() === "POST") {
      const template = body.trackId === "d"
        ? {
            ...tracks[0],
            id: "d",
            sourceAssetId: "d-source",
            track: { ...tracks[0].track, id: "d", title: "Test D" },
            stems: externalStemKeys,
            playback: { kind: "stems", assetIds: externalStemKeys.map(stem => stem.id) },
          }
        : tracks.find(t => t.track.id === body.trackId);
      if (template) {
        session.tracks.push({
          ...template,
          id: `session-${session.tracks.length + 1}`,
          position: Number.isInteger(body.position) ? body.position : session.tracks.length,
        });
        session.tracks.forEach((item, index) => { item.position = index; });
      }
    } else if (url.pathname.endsWith("/tracks") && request.method() === "PATCH") {
      const from = session.tracks.findIndex(item => item.id === body.sessionTrackId);
      const to = Math.max(0, Math.min(session.tracks.length - 1, Number(body.position)));
      if (from >= 0) {
        const [item] = session.tracks.splice(from, 1);
        session.tracks.splice(to, 0, item);
        session.tracks.forEach((track, index) => { track.position = index; });
      }
    } else if (url.pathname.endsWith("/tracks") && request.method() === "DELETE") {
      const sessionTrackId = url.searchParams.get("sessionTrackId");
      session.tracks = session.tracks.filter(item => item.id !== sessionTrackId);
      session.tracks.forEach((item, index) => { item.position = index; });
    } else if (request.method() === "DELETE") {
      parallelSwapDeleteRequests.push(url.searchParams.get("swapId"));
      if (pendingSwapDeleteGate) await pendingSwapDeleteGate;
      session.swaps = session.swaps.filter(s => s.id !== url.searchParams.get("swapId"));
    } else if (url.pathname.endsWith("/state") && body) {
      if (!suppressSessionStateWritesForStemSwitchFixture && !ignoreSessionStateWrites) {
        Object.assign(session, body);
      }
    }
    else if (request.method() === "PATCH" && body) {
      const targetId = url.pathname.split("/").at(-1);
      const sessionTrack = session.tracks.find(item => item.id === targetId);
      if (sessionTrack) {
        const { stemMix, stemMixPatch, ...trackPatch } = body;
        if (stemMixPatch !== undefined && holdStemMixPatchResponses) {
          const pending = { patch: structuredClone(stemMixPatch), body: structuredClone(body), release: null };
          pendingStemMixPatchRequests.push(pending);
          await new Promise(resolve => { pending.release = resolve; });
        }
        if (stemMix !== undefined) sessionTrack.stemMix = { ...stemMix };
        if (stemMixPatch !== undefined) {
          sessionTrack.stemMix = { ...sessionTrack.stemMix, ...stemMixPatch };
        }
        Object.assign(sessionTrack, trackPatch);
      } else {
        const track = tracks.find(t => t.id === targetId);
        if (track) Object.assign(track, body);
      }
    }
    await route.fulfill({ json: { session } });
  });
  await context.route(`**/api/library/sessions/${sessionId}/studio-handoff`, async route => {
    assert.equal(route.request().method(), "POST", "the session-to-Studio handoff is explicitly requested");
    studioHandoffRequests += 1;
    if (failStudioHandoff) {
      return route.fulfill({ status: 503, json: { error: "Studio is temporarily unavailable. Try again." } });
    }
    if (holdStudioHandoff) {
      await new Promise(resolve => {
        releaseStudioHandoff = resolve;
        signalStudioHandoffStarted?.();
      });
    }
    const body = route.request().postDataJSON();
    assert.ok(Array.isArray(body?.sessionTrackIds), "the handoff sends an explicit session-entry selection");
    assert.ok(Array.isArray(body?.trackEdits), "the handoff sends the current mixer snapshot");
    lastStudioHandoffSelection = [...body.sessionTrackIds];
    const selectedIds = new Set(body.sessionTrackIds);
    assert.equal(selectedIds.size, body.sessionTrackIds.length, "a session entry can only be selected once");
    const handoffMixById = new Map();
    for (const edit of body.trackEdits) {
      assert.ok(selectedIds.has(edit.sessionTrackId), "mixer snapshots only include selected entries");
      handoffMixById.set(edit.sessionTrackId, edit.stemMix);
    }
    assert.equal(handoffMixById.size, selectedIds.size, "every selected entry gets a current mixer snapshot");
    let timelineStartMs = 0;
    const sources = [];
    const stems = [];
    const remixTracks = [];
    const refused = [];
    for (const item of session.tracks.filter(entry => selectedIds.has(entry.id))) {
      const forcedRefusal = forcedStudioRefusals.get(item.id);
      if (forcedRefusal) {
        refused.push({ title: item.track.title, reason: forcedRefusal });
        continue;
      }
      if (item.stems.length === 0) {
        refused.push({ title: item.track.title, reason: "No separated stems or full-source audio are available." });
        continue;
      }
      const sourceId = item.sourceAssetId ?? `${item.track.id}-source`;
      if (!sources.some(source => source.id === sourceId)) {
        sources.push({
          id: sourceId, originalFilename: `${item.track.title} original.wav`,
          durationSeconds: item.track.durationSeconds, sampleRate: 22050, channels: 1,
          codec: "pcm_s16le", mimeType: "audio/wav", fileSizeBytes: 1000,
          checksumSha256: createHash("sha256").update(assets.get(sourceId) ?? Buffer.alloc(0)).digest("hex"),
          linkedFromLibrary: sourceId !== "a-source",
          ...(sourceId === "a-source" ? {
            sectionAnalysis: {
              id: "section-analysis-a", status: "complete", stage: "complete", attempts: 1,
              analysisEngine: "synthetic-fixture", analysisEngineVersion: "1",
              errorCode: null, errorMessage: null, analyzedAt: new Date().toISOString(),
            },
            sections: [{
              id: "section-a-1", sectionIndex: 0, startMs: 0, endMs: 8000,
              startBeatIndex: 0, endBeatIndex: 16, startBar: 1, endBar: 5,
              label: "section", labelConfidence: 0, structuralConfidence: 0.8,
              analysisEngine: "synthetic-fixture", analysisEngineVersion: "1",
              sourceChecksumSha256: createHash("sha256").update(assets.get(sourceId) ?? Buffer.alloc(0)).digest("hex"),
            }],
          } : {}),
        });
      }
      for (const stem of item.stems) {
        stems.push({
          id: stem.id, sourceAssetId: sourceId, stemType: stem.stemType, engine: stem.engine,
          model: "synthetic-fixture", modelVersion: "1", durationSeconds: item.track.durationSeconds,
          sampleRate: 22050, channels: 1, codec: "pcm_s16le", format: "wav",
          fileSizeBytes: 1000, checksumSha256: `checksum-${stem.id}`,
        });
        const trackId = `studio-${item.id}-${stem.stemType}`;
        remixTracks.push({
          id: trackId, stemAssetId: stem.id, name: `${item.track.title} — ${stem.stemType}`,
          sortOrder: remixTracks.length,
          volume: handoffMixById.get(item.id)?.[stem.stemType] ?? item.stemMix[stem.stemType] ?? 1,
          pan: 0, muted: false, solo: false, inserts: [], phaseInverted: false,
          clips: [{
            id: `clip-${trackId}`, remixTrackId: trackId, stemAssetId: stem.id,
            timelineStartMs, sourceOffsetMs: 0,
            durationMs: Math.round(item.track.durationSeconds * 1000), gain: 1,
            beatSnapEnabled: false, tempoRatio: 1,
          }],
        });
      }
      timelineStartMs += Math.max(1, Math.round(item.track.durationSeconds * 1000));
    }
    if (remixTracks.length === 0) {
      return route.fulfill({
        status: 409,
        json: { error: `No selected session entry can be opened in Studio. ${refused.map(item => `${item.title}: ${item.reason}`).join("; ")}. No Studio project was created. Restore or re-separate the named tracks in the Library, or remove them from the selection, then retry.` },
      });
    }
    studioProjectCreations += 1;
    studioProjectData = {
      project: {
        title: `Session · ${session.name}`,
        description: "Derived from this listening session. Original tracks and stems are referenced, never copied or modified.",
        licenseCode: "private", visibility: "private", publicationStatus: "draft", moderationStatus: "pending",
      },
      role: "owner", build: null, sources, studioSources: sources, stems, waveforms: [], waveformJobs: [], jobs: [],
    };
    studioRemixData = {
      remix: {
        id: studioRemixId, name: `Session · ${session.name}`, masterVolume: 1,
        masterInserts: "[]", loopStartMs: 0, loopEndMs: null, tempoBpm: 120,
        timeSignatureNumerator: 4, timeSignatureDenominator: 4,
        gridDivision: "beat", snapEnabled: true, targetKey: null, version: 1,
      },
      tracks: remixTracks, automation: [],
    };
    return route.fulfill({
      status: 201,
      json: { handoff: {
        projectId: studioProjectId, remixSessionId: studioRemixId,
        remixTrackCount: remixTracks.length, preservedSwapCount: 0, refused: refused.length ? refused : undefined,
      } },
    });
  });
  await context.route(`**/api/waveyard/projects/${studioProjectId}/**`, async route => {
    const pathname = new URL(route.request().url()).pathname;
    if (pathname.endsWith("/automatic-remixes")) {
      automaticRemixAttempts += 1;
      if (automaticRemixAttempts === 1) {
        await route.abort("failed");
        return;
      }
      return route.fulfill({
        status: 201,
        json: { remix: { id: studioRemixId }, plan: { notices: [] } },
      });
    }
    if (pathname.endsWith("/master")) {
      return route.fulfill({ status: 404, json: { error: "The fixture has no master analysis." } });
    }
    if (pathname.endsWith("/arena-handoff")) return route.fulfill({ json: { linked: false } });
    if (pathname.endsWith("/sound-design")) return route.fulfill({ json: { assets: [] } });
    if (pathname.endsWith("/cleanup")) return route.fulfill({ json: { versions: [] } });
    if (pathname.endsWith("/publication/audit")) return route.fulfill({ json: { events: [] } });
    if (pathname.endsWith("/publication")) {
      return route.fulfill({ json: {
        publication: {
          visibility: "private", publicationStatus: "draft", moderationStatus: "pending",
          publishedExportAssetId: null, licenseCode: "private", downloadPermission: "owner-only",
          rightsAcknowledgementVersion: "", rightsAcknowledgementStatement: "", tags: [],
        },
        exports: [], exportJobs: [],
      } });
    }
    return route.fulfill({ json: {} });
  });
  await context.route("**/api/assets/*/waveform", route =>
    route.fulfill({ json: { waveform: { durationSeconds: 1, resolutions: { "256": { min: [0], max: [0] } } } } }));
  await context.route("**/api/sources/*/events", async route => {
    sourceEventRequests += 1;
    if (sourceEventRequests === 1) return route.abort("failed");
    const source = studioProjectData.sources.find(item => item.id === "a-source");
    source.eventAnalysis = {
      id: "event-analysis-a", status: "queued", stage: "queued", attempts: 1,
      analysisEngine: "synthetic-fixture", analysisEngineVersion: "1",
      errorCode: null, errorMessage: null, analyzedAt: null,
    };
    return route.fulfill({ status: 202, json: { queued: true } });
  });
  await context.route(`**/api/remixes/${studioRemixId}/meeting-points`, async route => {
    meetingPointRequests += 1;
    if (meetingPointRequests === 1) return route.abort("failed");
    return route.fulfill({ json: { points: [] } });
  });
  await context.route(`**/api/remixes/${studioRemixId}/clips/from-section`, async route => {
    sectionArrangementRequests += 1;
    if (sectionArrangementRequests === 1) return route.abort("failed");
    const body = route.request().postDataJSON();
    assert.equal(body.sectionId, "section-a-1", "the selected source section is sent to arrangement creation");
    const clip = {
      id: "section-clip-a-1", remixTrackId: body.remixTrackId, stemAssetId: body.stemAssetId,
      timelineStartMs: body.timelineStartMs, sourceOffsetMs: 0, durationMs: 8000,
      gain: 1, beatSnapEnabled: false, tempoRatio: 1,
    };
    const targetTrack = studioRemixData.tracks.find(track => track.id === body.remixTrackId);
    assert.ok(targetTrack, "the selected source section resolves to an arrangement track");
    targetTrack.clips.push(clip);
    return route.fulfill({ json: { clips: [clip] } });
  });
  await context.route("**/api/streaming/accounts", route => route.fulfill({ json: { accounts: [] } }));
  await context.route(`**/api/waveyard/projects/${studioProjectId}`, route => {
    projectLoadAttempts += 1;
    if (failFirstProjectLoad) {
      failFirstProjectLoad = false;
      return route.fulfill({ status: 503, json: { error: "Temporary project refresh outage." } });
    }
    return route.fulfill({ json: studioProjectData ?? {} });
  });
  await context.route(`**/api/waveyard/projects/${secondStudioProjectId}/**`, route => {
    const pathname = new URL(route.request().url()).pathname;
    if (pathname.endsWith("/publication/audit")) {
      return route.fulfill({ json: { events: [] } });
    }
    if (pathname.endsWith("/publication")) {
      return route.fulfill({ json: {
        publication: {
          visibility: "private", publicationStatus: "draft", moderationStatus: "pending",
          publishedExportAssetId: null, licenseCode: "private", downloadPermission: "owner-only",
          rightsAcknowledgementVersion: "", rightsAcknowledgementStatement: "", tags: [],
        },
        exports: [], exportJobs: [],
      } });
    }
    return route.fulfill({ json: {} });
  });
  await context.route(`**/api/waveyard/projects/${secondStudioProjectId}/remixes`, route =>
    route.fulfill({ json: { remixes: studioHasRemix ? [{ id: studioRemixId }] : [] } }));
  await context.route(`**/api/waveyard/projects/${secondStudioProjectId}`, async route => {
    if (holdSecondStudioProjectLoad && secondStudioProjectLoadGate !== null) {
      secondStudioProjectLoadSignal?.();
      await secondStudioProjectLoadGate;
    }
    const projectData = studioProjectData;
    return route.fulfill({
      json: projectData === null
        ? {}
        : { ...projectData, project: { ...projectData.project, title: "Second derived arrangement" } },
    });
  });
  await context.route(`**/api/waveyard/projects/${studioProjectId}/remixes`, route =>
    route.fulfill({ json: { remixes: studioHasRemix ? [{ id: studioRemixId }] : [] } }));
  await context.route(`**/api/remixes/${studioRemixId}`, async route => {
    if (route.request().method() === "PUT" && studioRemixData !== null) {
      studioRemixPutCount += 1;
      const input = route.request().postDataJSON();
      const { tracks: inputTracks, automation: inputAutomation, expectedVersion, ...remixInput } = input;
      if (holdNextStudioRemixPut) {
        holdNextStudioRemixPut = false;
        signalHeldStudioRemixPut?.();
        await new Promise(resolve => { releaseHeldStudioRemixPut = resolve; });
      }
      if (expectedVersion !== studioRemixData.remix.version) {
        return route.fulfill({
          status: 409,
          json: {
            error: "Another Studio edit was saved first. Your arrangement was not changed.",
            code: "REMIX_VERSION_CONFLICT",
          },
        });
      }
      studioRemixData = {
        remix: { ...studioRemixData.remix, ...remixInput, version: studioRemixData.remix.version + 1 },
        tracks: inputTracks ?? studioRemixData.tracks,
        automation: inputAutomation ?? studioRemixData.automation,
      };
    }
    await route.fulfill({ json: studioRemixData ?? {} });
  });
  await context.route(`**/api/remixes/${studioRemixId}/versions`, route =>
    route.fulfill({ json: { versions: [] } }));
  await context.route("**/api/waveyard/separation/models", route => {
    if (failNextModelCheck) {
      failNextModelCheck = false;
      return route.fulfill({ status: 503, json: { error: "Temporary model status outage." } });
    }
    return route.fulfill({
      json: {
        models: ["kim_vocal_2", "kuielab_b_drums", "kuielab_b_bass", "kuielab_b_other"]
          .map(id => ({ id, label: id, ready: true, sizeBytes: 0 })),
      },
    });
  });
  async function verifyStemSwitchRecovery() {
    await page.bringToFront();
    suppressSessionStateWritesForStemSwitchFixture = true;
    for (const scenario of ["cancel", "timeout"]) {
      // Let the old page finish its keepalive state save before forcing a
      // deterministic fixture track for this scenario.
      await page.goto("http://localhost:80/waveyard");
      await page.bringToFront();
      await page.evaluate(() => window.localStorage.removeItem("waveyard:queue-change"));
      session.currentSessionTrackId = "a";
      session.positionSeconds = 0;
      session.swaps = [];
      await page.goto(`http://localhost:80/waveyard/session/${sessionId}`);
      await page.bringToFront();
      await page.waitForFunction(() => {
        const audio = [...document.querySelectorAll('[data-role="current"] audio')];
        return audio.length === 4 && audio.every(element =>
          element.readyState === 4 && new URL(element.src).pathname.includes("/a-"),
        );
      });
      const deck = page.locator('[data-role="current"]');
      let releaseDonor, signalRequest, finishRoute, releaseDelete;
      heldAssetId = "b-vocals";
      heldAssetGate = new Promise(resolve => { releaseDonor = resolve; });
      const requested = new Promise(resolve => { signalRequest = resolve; });
      const routeFinished = new Promise(resolve => { finishRoute = resolve; });
      signalHeldAssetRequest = signalRequest;
      signalHeldAssetRouteFinished = finishRoute;
      const buffersBefore = await page.evaluate(() => window.audioProbe.buffers.length);
      try {
        await page.getByTestId("session-play").click();
        await deck.getByTestId("open-live-swap-vocals").click();
        await deck.getByTestId("live-swap-candidate-vocals-b").click();
        await waitForSignal(requested, `the stalled donor for ${scenario}`);
        const pending = page.getByTestId("live-swap-pending-vocals");
        await pending.filter({ hasText: /Preparing.*current playback continues/ }).waitFor();
        if (scenario === "cancel") {
          // Persistence is stalled too: cancellation must take effect locally.
          pendingSwapDeleteGate = new Promise(resolve => { releaseDelete = resolve; });
          await page.getByTestId("cancel-live-stem-swap-swap-vocals").click();
        }
        try {
          await page.getByTestId("session-status")
            .filter({ hasText: scenario === "cancel" ? /vocals switch cancelled/i : /stem switch timed out after 15 seconds/i })
            .waitFor({ timeout: 20_000 });
        } catch (error) {
          console.error("STEM_SWITCH_RECOVERY_STATE", JSON.stringify({
            scenario,
            serverCurrentTrackId: session.currentSessionTrackId,
            suppressSessionStateWrites: suppressSessionStateWritesForStemSwitchFixture,
            openPages: context.pages().map(candidate => ({ url: candidate.url(), closed: candidate.isClosed() })),
            visibility: await page.evaluate(() => document.visibilityState),
            body: (await page.locator("body").innerText()).slice(-1200),
            pending: await page.locator('[data-testid*="pending"]').allTextContents(),
            audio: await deck.locator("audio").evaluateAll(elements => elements.map(element => ({
              src: element.src, paused: element.paused, time: element.currentTime,
            }))),
          }));
          throw error;
        }
        const afterStop = await deck.locator("audio").evaluateAll(elements => elements.map(audio => ({
          time: audio.currentTime, paused: audio.paused,
        })));
        assert.ok(afterStop.every(audio => !audio.paused && (scenario !== "timeout" || audio.time > 14)),
          `${scenario} leaves every original channel playing: ${JSON.stringify(afterStop)}`);
        assert.ok(Math.max(...afterStop.map(audio => audio.time)) - Math.min(...afterStop.map(audio => audio.time)) < 0.2,
          `${scenario} keeps original channels aligned`);
        await page.waitForFunction(before => {
          const audio = document.querySelector('[data-role="current"] audio[data-waveyard-fixture-src$="/a-vocals"]');
          return audio instanceof HTMLAudioElement && !audio.paused && audio.currentTime > before + 0.2;
        }, afterStop[0].time, { timeout: 3000 });
        heldAssetId = null;
        heldAssetGate = null;
        releaseDonor();
        await waitForSignal(routeFinished, `the late ${scenario} donor response`);
        await page.waitForTimeout(250);
        assert.equal(await page.evaluate(() => window.audioProbe.buffers.length), buffersBefore,
          `a late ${scenario} response cannot install a donor buffer`);
        assert.ok(Math.abs(await page.evaluate(() =>
          window.audioProbe.sources.find(source => source.mediaElement.src.endsWith("/a-vocals"))?.inputNode?.gain.value ?? 0,
        ) - 1) < 0.01, `${scenario} keeps the original vocal signal audible`);
        if (scenario === "cancel") {
          assert.equal(session.swaps.length, 1, "cancellation is effective while deletion is still pending");
          pendingSwapDeleteGate = null;
          releaseDelete();
        }
        await pending.waitFor({ state: "detached" });
        assert.equal(session.swaps.length, 0, `${scenario} removes the saved pending choice`);
        await page.getByTestId("session-play").click();
      } finally {
        heldAssetId = null;
        heldAssetGate = null;
        signalHeldAssetRequest = null;
        signalHeldAssetRouteFinished = null;
        pendingSwapDeleteGate = null;
        releaseDonor?.();
        releaseDelete?.();
      }
    }
    console.log("PASS: cancellation and the real preparation timeout keep original audio audible and aligned; late donors stay silent even while cancellation persistence stalls");
  }

  async function verifyCrossTabStemSwitchRecovery() {
    for (const scenario of ["cancel", "timeout"]) {
      session.currentSessionTrackId = "a";
      session.positionSeconds = 0;
      session.swaps = [];
      await page.goto(`http://localhost:80/waveyard/session/${sessionId}`);
      const mirror = await context.newPage();
      mirror.on("pageerror", error => { throw error; });
      const pages = [page, mirror];
      const releases = [];
      let holdDonor;
      try {
        await mirror.goto(`http://localhost:80/waveyard/session/${sessionId}`);
        for (const target of pages) {
          await target.waitForFunction(() => {
            const audio = [...document.querySelectorAll('[data-role="current"] audio')];
            return audio.length === 4 && audio.every(element =>
              element.readyState === 4 && new URL(element.src).pathname.includes("/a-"),
            );
          });
        }
        const requestedPages = new Set();
        const finishedPages = new Set();
        let signalBothRequested, signalBothFinished;
        const bothRequested = new Promise(resolve => { signalBothRequested = resolve; });
        const bothFinished = new Promise(resolve => { signalBothFinished = resolve; });
        // Use one gate per page: each late response is released and checked
        // independently, so a single successful request cannot stand in for two.
        const gates = new Map(pages.map(target => [target, new Promise(resolve => { releases.push(resolve); })]));
        heldAssetId = "b-vocals";
        heldAssetGate = Promise.resolve();
        signalHeldAssetRequest = request => {
          requestedPages.add(request.frame().page());
          if (pages.every(target => requestedPages.has(target))) signalBothRequested();
        };
        signalHeldAssetRouteFinished = request => {
          finishedPages.add(request.frame().page());
          if (pages.every(target => finishedPages.has(target))) signalBothFinished();
        };
        holdDonor = async route => {
          const target = route.request().frame().page();
          signalHeldAssetRequest(route.request());
          await gates.get(target);
          await route.fallback();
        };
        await context.route("**/api/assets/b-vocals", holdDonor);
        // Keep HTTP responses in flight even when the layer is cancelled. This
        // exercises the generation guard, not just successful fetch abortion.
        await Promise.all(pages.map(target => target.evaluate(() => {
          const nativeFetch = window.fetch;
          window.fetch = (input, init) => {
            const url = new URL(input instanceof Request ? input.url : String(input), location.href);
            return nativeFetch(input, url.pathname === "/api/assets/b-vocals"
              ? { ...init, signal: undefined } : init);
          };
        })));
        await page.bringToFront();
        await page.getByTestId("session-play").click();
        await mirror.waitForFunction(() =>
          document.querySelector('[data-testid="session-play"]')?.getAttribute("aria-pressed") === "true",
        );
        await page.locator('[data-role="current"]').getByTestId("open-live-swap-vocals").click();
        await page.getByTestId("live-swap-candidate-vocals-b").click();
        // The save notification must reach the mirror without a focus/reload.
        // Observe requests before releasing either page's response.
        await mirror.getByTestId("restore-live-swap-vocals").waitFor();
        await waitForSignal(bothRequested, `both stalled ${scenario} donor requests`);
        assert.equal(session.swaps.length, 1, "both tabs prepare the same persisted donor");
        // A silent mirror creates its first media graph lazily when preparing.
        // Snapshot after that preparation begins, before either response arrives.
        const baseline = await Promise.all(pages.map(target => target.evaluate(() => ({
          buffers: window.audioProbe.buffers.length,
          workletLoads: window.audioProbe.workletLoads.length,
          sources: window.audioProbe.sources.length,
        }))));
        if (scenario === "cancel") await page.getByTestId("cancel-live-stem-swap-swap-vocals").click();
        await page.getByTestId("session-status")
          .filter({ hasText: scenario === "cancel" ? /vocals switch cancelled/i : /stem switch timed out after 15 seconds/i })
          .waitFor({ timeout: 20_000 });
        for (const target of pages) {
          await target.getByTestId("restore-live-swap-vocals").waitFor({ state: "detached" });
          await target.getByTestId("live-swap-pending-vocals").waitFor({ state: "detached" });
        }
        assert.equal(session.swaps.length, 0, `${scenario} removes the saved choice in both tabs`);
        const clock = await page.locator('[data-role="current"] audio').first().evaluate(audio => audio.currentTime);
        for (const [index, release] of releases.entries()) {
          const responseFinished = pages[index].waitForResponse(response =>
            new URL(response.url()).pathname === "/api/assets/b-vocals" && response.ok(),
          );
          release();
          await responseFinished;
        }
        await waitForSignal(bothFinished, `both late ${scenario} donor responses`);
        await context.unroute("**/api/assets/b-vocals", holdDonor);
        await page.waitForFunction(before => {
          const audio = document.querySelector('[data-role="current"] audio[data-waveyard-fixture-src$="/a-vocals"]');
          return audio && !audio.paused && audio.currentTime > before + 0.3;
        }, clock);
        for (const [index, target] of pages.entries()) {
          const state = await target.evaluate(() => ({
            buffers: window.audioProbe.buffers.length,
            workletLoads: window.audioProbe.workletLoads.length,
            sources: window.audioProbe.sources.length,
            playing: [...document.querySelectorAll("audio")].filter(audio => !audio.paused).length,
            current: [...document.querySelectorAll('[data-role="current"] audio')].map(audio => ({
              time: audio.currentTime, paused: audio.paused,
              gain: window.audioProbe.sources.find(source => source.mediaElement === audio)?.inputNode?.gain.value,
            })),
          }));
          assert.equal(state.buffers, baseline[index].buffers, `${scenario}: late response creates no donor source in tab ${index}`);
          assert.equal(state.workletLoads, baseline[index].workletLoads, `${scenario}: late response loads no worklet in tab ${index}`);
          assert.equal(state.sources, baseline[index].sources, `${scenario}: original audio graph remains intact in tab ${index}`);
          assert.equal(state.playing, index === 0 ? 4 : 0, `${scenario}: only the owner plays`);
          if (index === 0) {
            assert.ok(state.current.every(audio => !audio.paused && audio.gain > 0.99), "all original channels stay audible");
            assert.ok(Math.max(...state.current.map(audio => audio.time)) - Math.min(...state.current.map(audio => audio.time)) < 0.2,
              "original channels stay aligned");
          }
        }
        await page.getByTestId("session-play").click();
        console.log(`PASS: cross-tab ${scenario} clears both saved choices; both late responses stay silent and only the original owner clock advances`);
      } finally {
        releases.forEach(release => release());
        if (holdDonor) await context.unroute("**/api/assets/b-vocals", holdDonor);
        heldAssetId = null;
        heldAssetGate = null;
        signalHeldAssetRequest = null;
        signalHeldAssetRouteFinished = null;
        await mirror.close();
      }
    }
    suppressSessionStateWritesForStemSwitchFixture = false;
  }

  async function verifyStudioSaveReload() {
    const originalAssets = assetSnapshot();
    const originalStemMetadata = structuredClone(tracks.map(track => track.stems));
    await page.getByRole("tab", { name: "Edit" }).click();
    const volume = page.getByLabel("Test a original.wav — Vocals arrangement volume");
    await volume.waitFor();
    assert.equal(await volume.inputValue(), "0.42", "Studio starts with the handed-off session fader");
    const saved = page.waitForResponse(response =>
      response.url().endsWith(`/api/remixes/${studioRemixId}`) && response.request().method() === "PUT",
    );
    await volume.fill("0.55");
    assert.ok((await saved).ok(), "the arrangement edit receives a successful save response");
    await page.locator(".save-state.saved").waitFor();
    await page.reload({ waitUntil: "domcontentloaded" });
    const reloaded = page.getByLabel("Test a original.wav — Vocals arrangement volume");
    await reloaded.waitFor();
    assert.equal(await reloaded.inputValue(), "0.55", "the edited fader survives reopening the project");
    assert.deepEqual(assetSnapshot(), originalAssets, "editing the arrangement does not change source or stem bytes");
    assert.deepEqual(tracks.map(track => track.stems), originalStemMetadata, "original library stem metadata stays unchanged");
    return reloaded;
  }

  if (studioConflictOnly) {
    session.tracks = tracks.slice(0, 2).map((item, index) => ({
      ...item,
      position: index,
      sourceAssetId: index === 0 ? "a-source" : "b-source",
      stemMix: index === 0
        ? { vocals: 0.42, drums: 0.78, bass: 1, other: 1 }
        : { vocals: 1, drums: 1, bass: 0.31, other: 1 },
    }));
    session.currentSessionTrackId = "a";
    session.positionSeconds = 0;
    session.swaps = [];
    await page.goto(`http://localhost:80/waveyard/session/${sessionId}`);
    await page.waitForFunction(() => document.querySelectorAll('[data-role="current"] audio').length === 4);
    await page.getByRole("button", { name: "Current only" }).click();
    await page.getByTestId("session-handoff").click();
    const studioLink = page.getByRole("link", { name: "Open in Studio" });
    await studioLink.waitFor();
    await studioLink.click();
    await page.getByRole("heading", { name: "Mixer console" }).waitFor();
    await page.getByRole("tab", { name: "Edit" }).click();
    const volume = page.getByLabel("Test a original.wav — Vocals arrangement volume");
    await volume.waitFor();
    assert.equal(await volume.inputValue(), "0.42", "the handoff loaded the initial authoritative arrangement");
    const originalAssets = assetSnapshot();

    // A second editor commits against the same initial version. The open
    // Studio tab must keep its local draft while it exposes the newer state.
    studioRemixData.remix.version += 1;
    studioRemixData.tracks[0].volume = 0.43;
    const staleSave = page.waitForResponse(response =>
      response.url().endsWith(`/api/remixes/${studioRemixId}`) && response.request().method() === "PUT",
    );
    await volume.fill("0.68");
    assert.equal((await staleSave).status(), 409, "the stale client is rejected by the version guard");
    await page.getByText(/Another Studio tab saved newer changes first/).waitFor();
    assert.equal(await volume.inputValue(), "0.68", "the unsaved value remains in the editor after conflict");

    await page.getByRole("button", { name: "Load latest and keep my draft" }).click();
    await page.getByRole("button", { name: "Restore draft and replace latest" }).waitFor();
    assert.equal(await volume.inputValue(), "0.43", "reload selects the newer saved arrangement");
    await page.getByRole("button", { name: "Restore draft and replace latest" }).click();
    await page.locator(".save-state.saved").waitFor();
    assert.equal(studioRemixData.tracks[0].volume, 0.68,
      "the preserved draft can be explicitly restored against the latest version");
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.getByRole("heading", { name: "Mixer console" }).waitFor();
    assert.equal(await page.getByLabel("Test a original.wav — Vocals arrangement volume").inputValue(), "0.68",
      "the explicit draft restore survives reload");
    assert.deepEqual(assetSnapshot(), originalAssets, "conflict recovery leaves source and stem audio unchanged");
    console.log("PASS: competing Studio arrangement versions reject stale writes, retain the draft, and reload the selected state");
    await context.close();
    await browser.close();
    process.exit(0);
  } else if (timingOnly) {
    session.tracks = tracks;
    session.swaps = [];
    session.currentSessionTrackId = "a";
    session.positionSeconds = 0;
    const timings = {};
    const scenarios = [
      { name: "nativeTempo", donorId: "c", ratio: 1 },
      { name: "tempoMatched", donorId: "b", ratio: 124 / 120 },
      { name: "delayedDownload", donorId: "d", ratio: 1, delayMs: 450 },
    ];

    for (const scenario of scenarios) {
      session.swaps = [];
      session.currentSessionTrackId = "a";
      session.positionSeconds = 0;
      await page.goto(`http://localhost:80/waveyard/session/${sessionId}`);
      await page.waitForFunction(() => {
        const audio = [...document.querySelectorAll('[data-role="current"] audio')];
        return audio.length === 4 && audio.every(element =>
          element.readyState === 4 && new URL(element.src).pathname.includes("/a-"),
        );
      }, null, { timeout: 15_000 });
      const deck = page.locator('[data-role="current"]');
      const play = page.getByTestId("session-play");
      if (await play.getAttribute("aria-pressed") !== "true") await play.click();
      await page.waitForFunction(() =>
        document.querySelector('[data-testid="session-play"]')?.getAttribute("aria-pressed") === "true",
      );
      await deck.getByTestId("open-live-swap-vocals").click();
      const candidate = deck.getByTestId(`live-swap-candidate-vocals-${scenario.donorId}`);
      await candidate.waitFor();
      const before = await page.evaluate(() => ({
        buffers: window.audioProbe.buffers.length,
        timings: window.liveStemTimings.length,
      }));
      timedAssetId = `${scenario.donorId}-vocals`;
      timedAssetDelayMs = scenario.delayMs ?? 0;
      await candidate.evaluate(button => {
        window.liveStemSelectionStart = null;
        window.liveStemObservedAudibleAt = null;
        button.addEventListener("click", () => {
          window.liveStemSelectionStart = performance.now();
        }, { once: true });
      });
      await candidate.click();
      try {
        await page.waitForFunction(({ bufferCount }) => {
          const source = window.audioProbe.buffers.slice(bufferCount)
            .find(item => item.inputNode?.gain?.value > 0.03);
          if (!source) return false;
          window.liveStemObservedAudibleAt = performance.now();
          return true;
        }, { bufferCount: before.buffers }, { timeout: 20_000 });
        await page.waitForFunction(timingCount => window.liveStemTimings.length > timingCount,
          before.timings, { timeout: 20_000 });
      } finally {
        timedAssetId = null;
        timedAssetDelayMs = 0;
      }
      const measurement = await page.evaluate(({ timingIndex }) => {
        const timing = window.liveStemTimings[timingIndex];
        return {
          ...timing,
          observedSelectionToAudibleMs: window.liveStemObservedAudibleAt - window.liveStemSelectionStart,
        };
      }, { timingIndex: before.timings });
      assert.equal(measurement.tempoStretchRatio, scenario.ratio,
        `${engineName} ${scenario.name} must use the intended tempo mode: ${JSON.stringify(measurement)}`);
      for (const field of ["selectionToAudibleMs", "observedSelectionToAudibleMs", "downloadMs", "decodeMs", "tempoMatchMs"]) {
        assert.ok(Number.isFinite(measurement[field]) && measurement[field] >= 0,
          `${engineName} timing must report a finite ${field}: ${JSON.stringify(measurement)}`);
      }
      assert.ok(measurement.transferBytes > 0,
        `${engineName} timing must report the downloaded donor size: ${JSON.stringify(measurement)}`);
      if (scenario.ratio === 1) {
        assert.equal(measurement.tempoMatchMs, 0, `${engineName} native-tempo swaps skip tempo matching`);
      } else {
        assert.ok(measurement.tempoMatchMs > 0,
          `${engineName} tempo-matched swaps report the matching stage`);
      }
      if (scenario.delayMs) {
        assert.ok(measurement.downloadMs >= scenario.delayMs,
          `${engineName} download timing must include the injected ${scenario.delayMs}ms response delay: ${JSON.stringify(measurement)}`);
      }
      timings[scenario.name] = measurement;

      const restore = deck.getByTestId("restore-live-swap-vocals");
      await restore.waitFor();
      await restore.click();
      await page.waitForFunction(() => {
        const source = window.audioProbe.sources.find(item => item.mediaElement.src.endsWith("/a-vocals"));
        return source?.inputNode?.gain?.value > 0.9;
      });
    }
    console.log("LIVE_STEM_SWAP_TIMINGS", JSON.stringify({ browserEngine: engineName, timings }));
    console.log(`PASS: ${engineName} native-tempo, tempo-matched, and injected-delay live stem timings`);
  } else if (process.argv.includes("--live-stem-device-benchmark-only")) {
    // This is a functional check of the real-device harness in a simulated
    // mobile viewport. It is not a physical-device performance result.
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto("http://localhost:80/waveyard/stem-device-benchmark");
    await page.getByRole("heading", { name: "Measure live stem swaps" }).waitFor();
    await page.getByLabel("Device class").selectOption("Phone");
    await page.getByLabel("Paired trials per tempo mode").selectOption("3");
    await page.getByTestId("run-stem-device-benchmark").click();
    const results = page.getByTestId("stem-benchmark-results");
    await results.waitFor({ timeout: 90_000 });
    const report = JSON.parse(await results.getAttribute("data-report"));
    assert.equal(await results.getByTestId("stem-duration-comparison").count(), 2,
      "the page renders a separate comparison for each donor duration");
    for (const durationSeconds of [8, 30]) {
      await results.getByRole("heading", { name: `${durationSeconds}-second donor` }).waitFor();
    }
    assert.equal(report.schemaVersion, 2, "the device report identifies its duration-aware schema");
    assert.deepEqual(report.fixtures.map(item => item.durationSeconds), [8, 30],
      "physical-device runs include short and longer donor fixtures");
    assert.equal(report.observations.length, 12,
      "the harness records both modes for each trial and each donor duration");
    for (const durationSeconds of [8, 30]) {
      const observations = report.observations.filter(item => item.fixtureDurationSeconds === durationSeconds);
      assert.equal(observations.length, 6, `${durationSeconds}-second donors have all paired trial observations`);
      assert.ok(observations.some(item => item.mode === "nativeTempo"),
        `${durationSeconds}-second donors include native-tempo swaps`);
      assert.ok(observations.some(item => item.mode === "tempoMatched"),
        `${durationSeconds}-second donors include tempo-matched swaps`);
    }
    assert.equal(report.environment.deviceClass, "Phone",
      "each result records the selected device class");
    assert.ok(report.environment.browser && report.environment.operatingSystem && report.environment.userAgent,
      "each result records browser, operating system, and user-agent details");
    assert.deepEqual(report.durationComparisons.map(item => item.durationSeconds), [8, 30],
      "the report provides a separate comparison for each fixture duration");
    for (const comparison of report.durationComparisons) {
      assert.ok(Number.isFinite(comparison.nativeTempoMedianMs) &&
        Number.isFinite(comparison.tempoMatchedMedianMs) &&
        Number.isFinite(comparison.tempoMatchedMinusNativeMedianMs),
      `${comparison.durationSeconds}-second results compare both tempo modes without imposing a latency threshold`);
    }
    console.log("LIVE_STEM_DEVICE_BENCHMARK_SMOKE", JSON.stringify({
      simulatedViewport: "390x844",
      observationCount: report.observations.length,
      deviceClass: report.environment.deviceClass,
      browser: report.environment.browser,
      operatingSystem: report.environment.operatingSystem,
      durationComparisons: report.durationComparisons.map(({ durationSeconds, nativeTempoMedianMs, tempoMatchedMedianMs }) => ({
        durationSeconds,
        nativeTempoMedianMs,
        tempoMatchedMedianMs,
      })),
    }));
    console.log("PASS: device benchmark compares native and tempo-matched timing for short and longer donors");
  } else if (crossTabStemMixOnly) {
    session.tracks = tracks;
    session.swaps = [];
    session.currentSessionTrackId = "a";
    session.positionSeconds = 0;
    tracks[0].stemMix = { vocals: 0.8, drums: 0.61, bass: 1, other: 1 };
    tracks[0].transition = {
      mode: "manual",
      crossfadeSeconds: 2,
      keepStems: [],
    };

    const firstTab = page;
    const secondTab = await context.newPage();
    await Promise.all([
      firstTab.goto(`http://localhost:80/waveyard/session/${sessionId}`),
      secondTab.goto(`http://localhost:80/waveyard/session/${sessionId}`),
    ]);
    const waitForStemAudio = targetPage => targetPage.waitForFunction(() => {
      const audio = [...document.querySelectorAll('[data-role="current"] audio')];
      return audio.length === 4 && audio.every(element => element.readyState === 4);
    });
    await Promise.all([waitForStemAudio(firstTab), waitForStemAudio(secondTab)]);
    const setFader = async (targetPage, stem, level) => {
      const input = targetPage.locator('[data-role="current"]')
        .getByLabel(`${stem} level, current deck`, { exact: true });
      await input.evaluate((element, value) => {
        const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set;
        setter.call(element, String(value));
        element.dispatchEvent(new Event("input", { bubbles: true }));
        element.dispatchEvent(new Event("change", { bubbles: true }));
      }, level);
      assert.equal(await input.inputValue(), String(level), `${stem} fader changes in its own tab`);
    };
    const waitForGains = async (targetPage, { vocals, drums }) => {
      await targetPage.waitForFunction(({ vocals: targetVocals, drums: targetDrums }) => {
        const gain = type => window.audioProbe.sources
          .filter(source => source.mediaElement.src.endsWith(`/a-${type}`))
          .at(-1)?.inputNode?.nextNode?.gain?.value;
        return Math.abs(gain("vocals") - targetVocals) < 0.01
          && Math.abs(gain("drums") - targetDrums) < 0.01;
      }, { vocals, drums }, { timeout: 5_000 });
    };

    await firstTab.waitForTimeout(700);
    assert.equal(pendingStemMixPatchRequests.length, 0, "opening either tab does not create a mix edit");
    holdStemMixPatchResponses = true;
    pendingStemMixPatchRequests.length = 0;

    const firstSaveResponse = firstTab.waitForResponse(response =>
      response.request().method() === "PATCH"
      && response.url().endsWith(`/tracks/${tracks[0].id}`)
      && response.request().postDataJSON()?.stemMixPatch?.vocals === 0.37,
    );
    await setFader(firstTab, "vocals", 0.37);
    for (let attempt = 0; attempt < 60 && pendingStemMixPatchRequests.length < 1; attempt += 1) {
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    assert.equal(pendingStemMixPatchRequests.length, 1, "the first tab submits its vocals edit");
    assert.deepEqual(pendingStemMixPatchRequests[0].patch, { vocals: 0.37 },
      "the first tab sends only the stem it changed");
    assert.equal(pendingStemMixPatchRequests[0].body.transition, undefined,
      "a normal fader change does not send an unrelated stale transition snapshot");

    const secondSaveResponse = secondTab.waitForResponse(response =>
      response.request().method() === "PATCH"
      && response.url().endsWith(`/tracks/${tracks[0].id}`)
      && response.request().postDataJSON()?.stemMixPatch?.drums === 0,
    );
    await secondTab.locator('[data-role="current"]').getByLabel("Mute drums", { exact: true }).click();
    for (let attempt = 0; attempt < 60 && pendingStemMixPatchRequests.length < 2; attempt += 1) {
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    assert.equal(pendingStemMixPatchRequests.length, 2, "the second tab submits its drums mute while the first save is pending");
    assert.deepEqual(pendingStemMixPatchRequests[1].patch, { drums: 0 },
      "the second tab sends a drums-only mute patch");

    // Release the newer request first, then the older one. The server must
    // merge each changed channel instead of applying either tab's full snapshot.
    pendingStemMixPatchRequests[1].release();
    const drumsResponse = await secondSaveResponse;
    assert.ok(drumsResponse.ok(), "the later drums mute saves successfully first");
    assert.deepEqual(session.tracks[0].stemMix, { vocals: 0.8, drums: 0, bass: 1, other: 1 },
      "the first save is still pending when the drums mute commits");

    pendingStemMixPatchRequests[0].release();
    const vocalsResponse = await firstSaveResponse;
    assert.ok(vocalsResponse.ok(), "the older vocals fader save succeeds after the mute");
    holdStemMixPatchResponses = false;
    assert.deepEqual(session.tracks[0].stemMix, { vocals: 0.37, drums: 0, bass: 1, other: 1 },
      "the final saved mix retains both tabs' independent changes");
    assert.equal(session.tracks[0].transition.performance.recall.drums, 0.61,
      "the mute's prior fader level remains available for unmute");

    await secondTab.close();
    await firstTab.reload({ waitUntil: "domcontentloaded" });
    await waitForStemAudio(firstTab);
    const play = firstTab.getByTestId("session-play");
    if (await play.getAttribute("aria-pressed") !== "true") await play.click();
    await firstTab.waitForFunction(() =>
      document.querySelector('[data-testid="session-play"]')?.getAttribute("aria-pressed") === "true",
    );
    const reloadedDeck = firstTab.locator('[data-role="current"]');
    assert.equal(await reloadedDeck.getByLabel("vocals level, current deck", { exact: true }).inputValue(), "0.37",
      "reopening the session restores the first tab's vocals fader");
    assert.equal(await reloadedDeck.getByLabel("drums level, current deck", { exact: true }).inputValue(), "0",
      "reopening the session restores the second tab's drums mute");
    assert.equal(await reloadedDeck.getByLabel("Mute drums", { exact: true }).getAttribute("aria-pressed"), "true",
      "reopening reflects the saved mute state");
    await waitForGains(firstTab, { vocals: 0.37, drums: 0 });
    console.log("PASS: two tabs save independent fader and mute edits in reverse response order; reload restores both audible stem gains");
  } else if (stemControlsReopenOnly) {
    session.tracks = tracks;
    session.swaps = [];
    session.currentSessionTrackId = "a";
    session.positionSeconds = 0;
    tracks[0].stemMix = {};
    tracks[0].transition = { mode: "manual", crossfadeSeconds: 2, keepStems: [] };
    await page.goto(`http://localhost:80/waveyard/session/${sessionId}`);
    const deck = page.locator('[data-role="current"]');
    await page.waitForFunction(() => {
      const audio = [...document.querySelectorAll('[data-role="current"] audio')];
      return audio.length === 4 && audio.every(element => element.readyState === 4);
    });
    const play = page.getByTestId("session-play");
    if (await play.getAttribute("aria-pressed") !== "true") await play.click();
    await page.waitForFunction(() =>
      document.querySelector('[data-testid="session-play"]')?.getAttribute("aria-pressed") === "true",
    );
    const setFader = async (stem, level) => {
      const input = deck.getByLabel(`${stem} level, current deck`, { exact: true });
      await input.evaluate((element, value) => {
        const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set;
        setter.call(element, value);
        element.dispatchEvent(new Event("input", { bubbles: true }));
        element.dispatchEvent(new Event("change", { bubbles: true }));
      }, String(level));
      assert.equal(await input.inputValue(), String(level), `${stem} fader accepts its chosen level`);
    };
    const assertStemGains = async ({ vocals, drums }) => {
      await page.waitForFunction(({ vocals: targetVocals, drums: targetDrums }) => {
        const gain = type => window.audioProbe.currentStemGain(type);
        return Math.abs(gain("vocals") - targetVocals) < 0.01
          && Math.abs(gain("drums") - targetDrums) < 0.01;
      }, { vocals, drums }, { timeout: 5_000 });
    };
    await setFader("vocals", 0.37);
    await setFader("drums", 0.61);
    await deck.getByLabel("Mute drums", { exact: true }).click();
    await assertStemGains({ vocals: 0.37, drums: 0 });
    await page.getByTestId("button-return-full-track-a").click();
    await page.waitForFunction(() => {
      const audio = [...document.querySelectorAll('[data-role="current"] audio')];
      return audio.length === 1 && audio[0].src.endsWith("/a-source") && !audio[0].paused;
    });
    await page.getByTestId("button-switch-stems-a").click();
    await page.waitForFunction(() => {
      const audio = [...document.querySelectorAll('[data-role="current"] audio')];
      return audio.length === 4 && audio.every(element => !element.paused && element.src.includes("/a-"));
    });
    assert.equal(await deck.getByLabel("vocals level, current deck", { exact: true }).inputValue(), "0.37");
    assert.equal(await deck.getByLabel("drums level, current deck", { exact: true }).inputValue(), "0");
    assert.equal(await deck.getByLabel("Mute drums", { exact: true }).getAttribute("aria-pressed"), "true");
    await assertStemGains({ vocals: 0.37, drums: 0 });
    for (let attempt = 0; attempt < 40 && session.tracks[0].transition.performance?.recall?.drums !== 0.61; attempt += 1) {
      await page.waitForTimeout(50);
    }
    assert.equal(session.tracks[0].stemMix.vocals, 0.37, "the session saves the non-default vocals level");
    assert.equal(session.tracks[0].stemMix.drums, 0, "the session saves drums as muted");
    assert.equal(session.tracks[0].transition.performance.recall.drums, 0.61,
      "the session saves the muted drums fader's previous level");

    await page.reload({ waitUntil: "domcontentloaded" });
    await page.waitForFunction(() => {
      const audio = [...document.querySelectorAll('[data-role="current"] audio')];
      return audio.length === 4 && audio.every(element => element.readyState === 4);
    });
    const reloadedPlay = page.getByTestId("session-play");
    if (await reloadedPlay.getAttribute("aria-pressed") !== "true") await reloadedPlay.click();
    await page.waitForFunction(() =>
      document.querySelector('[data-testid="session-play"]')?.getAttribute("aria-pressed") === "true",
    );
    const reloadedDeck = page.locator('[data-role="current"]');
    assert.equal(await reloadedDeck.getByLabel("vocals level, current deck", { exact: true }).inputValue(), "0.37",
      "reopening restores the distinctive vocals fader");
    assert.equal(await reloadedDeck.getByLabel("drums level, current deck", { exact: true }).inputValue(), "0",
      "reopening restores the muted drums fader");
    assert.equal(await reloadedDeck.getByLabel("Mute drums", { exact: true }).getAttribute("aria-pressed"), "true",
      "reopening restores the drums mute control");
    await assertStemGains({ vocals: 0.37, drums: 0 });
    await reloadedDeck.getByLabel("Mute drums", { exact: true }).click();
    await assertStemGains({ vocals: 0.37, drums: 0.61 });
    assert.equal(await reloadedDeck.getByLabel("drums level, current deck", { exact: true }).inputValue(), "0.61",
      "unmuting restores the prior drums fader value after reopening");
    for (let attempt = 0; attempt < 40 && session.tracks[0].stemMix.drums !== 0.61; attempt += 1) {
      await page.waitForTimeout(50);
    }
    assert.equal(session.tracks[0].stemMix.drums, 0.61,
      "the restored drums level is saved back to the session");
    console.log("PASS: stem levels and mute state survive a full-track round trip and session reload; unmuting recalls the prior fader level");
  } else if (studioSelectionFreshnessOnly) {
    session.tracks = [sourceOnlyTrack, ...tracks.slice(1)];
    session.currentSessionTrackId = "a";
    session.positionSeconds = 0;
    session.swaps = [];
    exposeSeparatedSource = false;
    libraryRows[0] = {
      ...libraryRows[0],
      stemAvailability: { status: "source-only", reason: "Separation has not started." },
    };
    await page.goto(`http://localhost:80/waveyard/session/${sessionId}`);
    await page.waitForFunction(() => {
      const audio = [...document.querySelectorAll('[data-role="current"] audio')];
      return audio.length === 1 && audio[0].readyState === 4;
    });
    assert.equal((await page.getByTestId("studio-track-selection-count").innerText()).trim(),
      "2 selected of 3 selectable tracks", "the picker initially selects ready tracks, not the source-only current entry");
    const sourceOnlyChoice = page.getByRole("checkbox", { name: /Include session entry 1, Test a/ });
    assert.equal(await sourceOnlyChoice.isDisabled(), false, "the current original source can be selected for Studio");
    await sourceOnlyChoice.check();
    assert.equal((await page.getByTestId("studio-track-selection-count").innerText()).trim(),
      "3 selected of 3 selectable tracks");

    await page.locator("summary").filter({ hasText: "Session order" }).click();
    await page.getByRole("button", { name: "Remove Test b", exact: true }).click();
    await page.getByRole("button", { name: "Remove Test b", exact: true }).waitFor({ state: "detached" });
    assert.equal((await page.getByTestId("studio-track-selection-count").innerText()).trim(),
      "2 selected of 2 selectable tracks", "removing an entry immediately filters its selected ID");
    await page.locator("#sess-add").selectOption("d");
    await page.getByTestId("session-add-track").click();
    const addedChoice = page.getByRole("checkbox", { name: /Include session entry 3, Test D/ });
    await addedChoice.waitFor();
    assert.equal((await page.getByTestId("studio-track-selection-count").innerText()).trim(),
      "2 selected of 3 selectable tracks", "a newly added ready entry is visible but does not silently join an explicit selection");
    assert.equal(await addedChoice.isChecked(), false);

    const nowUnavailable = session.tracks.find(item => item.id === "a");
    assert.ok(nowUnavailable, "the selected original-source entry remains in the server session");
    nowUnavailable.sourceAssetId = null;
    nowUnavailable.playback = { kind: "source", assetIds: [] };
    libraryRows[0] = {
      ...libraryRows[0],
      stemAvailability: { status: "unavailable", reason: "The original source was removed." },
    };
    await page.waitForFunction(() => {
      const count = document.querySelector('[data-testid="studio-track-selection-count"]')?.textContent?.trim();
      const source = [...document.querySelectorAll('input[aria-label^="Include session entry"]')]
        .find(input => input.getAttribute("aria-label")?.includes("Test a"));
      return count === "1 selected of 2 selectable tracks" && source?.disabled && !source.checked;
    }, undefined, { timeout: 15_000 });
    const currentReadyChoice = page.getByRole("checkbox", { name: /Include session entry 2, Test c/ });
    assert.equal(await currentReadyChoice.isChecked(), true, "the surviving ready selection remains selected");
    assert.equal(await addedChoice.isChecked(), false, "the newly added session entry stays unselected");
    assert.equal(await sourceOnlyChoice.isDisabled(), true, "source readiness loss disables the stale selection");

    studioHandoffRequests = 0;
    lastStudioHandoffSelection = [];
    await page.getByTestId("session-handoff").click();
    await page.getByRole("link", { name: "Open in Studio" }).waitFor();
    assert.deepEqual(lastStudioHandoffSelection, ["c"],
      "the handoff contains only the selected entry still present and selectable");
    assert.equal(studioRemixData.tracks.length, 4,
      "the derived Studio project contains only the surviving selected entry");
    console.log("PASS: Studio handoff choices track session removal/addition and source-readiness changes");
  } else if (process.argv.includes("--studio-persistence-only")) {
    tracks[0].stemMix = { vocals: 0.42 };
    const originalAssets = assetSnapshot();
    await page.goto(`http://localhost:80/waveyard/session/${sessionId}`);
    assert.equal((await page.getByTestId("studio-track-selection-count").innerText()).trim(),
      "3 selected of 3 selectable tracks", "all initially bindable entries are selected");
    const projectsBeforePartial = studioProjectCreations;
    forcedStudioRefusals = new Map([
      ["b", "Its audio disappeared after selection."],
      ["c", "Its source file was removed during submission."],
    ]);
    await page.getByTestId("session-handoff").click();
    const studioLink = page.getByRole("link", { name: "Open in Studio" });
    await studioLink.waitFor();
    assert.deepEqual(lastStudioHandoffSelection, ["a", "b", "c"],
      "the selected tracks are sent even when availability changes after selection");
    assert.equal(studioProjectCreations, projectsBeforePartial + 1,
      "the available track still creates a partial Studio arrangement");
    assert.equal(studioRemixData.tracks.length, 4, "the arrangement keeps every available lane");
    const partialMessage = await studioLink.locator("xpath=..").innerText();
    assert.match(partialMessage, /Test b \(Its audio disappeared after selection\.\)/);
    assert.match(partialMessage, /Test c \(Its source file was removed during submission\.\)/);

    const projectsBeforeAllRefused = studioProjectCreations;
    forcedStudioRefusals = new Map([
      ["a", "Its source file is missing."],
      ["b", "Its stems are missing."],
      ["c", "Its recording is unavailable."],
    ]);
    await page.getByTestId("session-handoff").click();
    const recoveryLink = page.getByTestId("link-studio-handoff-recovery");
    await recoveryLink.waitFor();
    assert.equal(await recoveryLink.getAttribute("href"), "/waveyard",
      "the all-refused result links to the Library recovery workflow");
    const allRefusedStatus = await page.getByTestId("session-status").innerText();
    for (const trackId of ["a", "b", "c"]) assert.ok(allRefusedStatus.includes(`Test ${trackId}:`));
    assert.match(allRefusedStatus, /No Studio project was created/);
    assert.equal(await page.getByRole("link", { name: "Open in Studio" }).count(), 0,
      "all-refused audio never shows a Studio project link");
    assert.equal(studioProjectCreations, projectsBeforeAllRefused,
      "an all-refused handoff creates no Studio project");
    forcedStudioRefusals = new Map();
    studioHandoffRequests = 0;

    await page.getByRole("button", { name: "Clear selection" }).click();
    assert.equal(await page.getByTestId("session-handoff").isDisabled(), true,
      "an empty Studio selection cannot be submitted");
    assert.equal(studioHandoffRequests, 0, "an empty selection does not create a Studio project");
    await page.getByRole("button", { name: "Current only" }).click();
    assert.equal((await page.getByTestId("studio-track-selection-count").innerText()).trim(), "1 selected of 3 selectable tracks");
    await page.getByTestId("session-handoff").click();
    await studioLink.waitFor();
    assert.deepEqual(lastStudioHandoffSelection, ["a"], "the UI sends only the explicitly selected session entry");
    assert.equal(studioRemixData.tracks.length, 4, "the Studio arrangement contains only the selected track's lanes");
    await studioLink.click();
    await page.getByRole("heading", { name: "Mixer console" }).waitFor();
    await page.waitForFunction(() => document.querySelectorAll(".timeline-track").length === 4);
    assert.equal(await page.locator(".timeline-track").count(), 4, "Studio opens with the selected track and no unselected tracks");
    await verifyStudioSaveReload();
    const serverVolumeBeforeInterruptedSave = studioRemixData.tracks[0].volume;
    const interruptedSaveCount = studioRemixPutCount;
    await page.getByLabel("Test a original.wav — Vocals arrangement volume").fill("0.73");
    await page.locator(".save-state.unsaved").waitFor();
    assert.equal(studioRemixPutCount, interruptedSaveCount,
      "the hard-close fixture exits before the 700ms autosave begins");
    const browserDraft = await page.evaluate(() => {
      const key = Object.keys(localStorage).find(candidate => candidate.startsWith("waveyard-studio-recovery-v1:"));
      return key ? { key, payload: JSON.parse(localStorage.getItem(key)) } : null;
    });
    assert.ok(browserDraft, "the edit is synchronously kept as a browser recovery draft before the debounce");
    assert.equal(browserDraft.key,
      `waveyard-studio-recovery-v1:${encodeURIComponent(studioProjectId)}:${encodeURIComponent(studioRemixId)}`,
      "the recovery key is isolated to the handed-off project and remix");
    assert.equal(browserDraft.payload.projectId, studioProjectId);
    assert.equal(browserDraft.payload.remixId, studioRemixId);
    assert.equal("previewAssets" in browserDraft.payload.state, false,
      "the local draft stores arrangement references, not source or stem assets");
    let exitWarningShown = false;
    page.on("dialog", async dialog => {
      if (dialog.type() === "beforeunload") exitWarningShown = true;
      await dialog.accept();
    });
    const interruptedStudioUrl = page.url();
    await page.close({ runBeforeUnload: true });
    page = await context.newPage();
    await page.goto(interruptedStudioUrl);
    await page.getByRole("heading", { name: "Mixer console" }).waitFor();
    assert.equal(
      await page.getByLabel("Test a original.wav — Vocals arrangement volume").inputValue(),
      String(serverVolumeBeforeInterruptedSave),
      "the server correctly remains unchanged after closing before autosave starts",
    );
    await page.getByRole("alert").filter({ hasText: "local Studio draft" }).waitFor();
    assert.equal(exitWarningShown, true,
      "the browser gives supported hosts an exit warning for unsaved arrangement edits");
    await page.getByRole("button", { name: "Restore local draft", exact: true }).click();
    await page.locator(".save-state.saved").waitFor();
    assert.equal(studioRemixData.tracks[0].volume, 0.73,
      "restoring the interrupted draft explicitly saves the edit to the remix");
    assert.equal(await page.evaluate(() => Object.keys(localStorage)
      .some(key => key.startsWith("waveyard-studio-recovery-v1:"))), false,
    "the confirmed save clears its matching recovery draft");
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.getByRole("heading", { name: "Mixer console" }).waitFor();
    assert.equal(
      await page.getByLabel("Test a original.wav — Vocals arrangement volume").inputValue(),
      "0.73",
      "the recovered edit is now persisted through the remix API",
    );
    console.log("PASS: a hard close before autosave leaves a scoped browser draft that can be restored and saved.");
    await page.setViewportSize({ width: 390, height: 844 });
    await page.evaluate(() => {
      const prototype = window.AudioContext.prototype;
      const originalAddEventListener = prototype.addEventListener;
      window.audioProbe.suppressedStateChangeListeners = 0;
      prototype.addEventListener = function (type, listener, ...options) {
        if (type === "statechange") {
          window.audioProbe.suppressedStateChangeListeners += 1;
          return;
        }
        return originalAddEventListener.call(this, type, listener, ...options);
      };
    });
    const blockNextResume = () => page.evaluate(() => {
      const prototype = window.AudioContext.prototype;
      const originalResume = prototype.resume;
      const originalState = Object.getOwnPropertyDescriptor(prototype, "state");
      Object.defineProperty(prototype, "state", { configurable: true, get: () => "suspended" });
      prototype.resume = function (...args) {
        prototype.resume = originalResume;
        if (originalState) Object.defineProperty(prototype, "state", originalState);
        else delete prototype.state;
        return Promise.reject(new DOMException("A user activation is required.", "NotAllowedError"));
      };
    });
    const assertRecoveryControl = async (name, message) => {
      const alert = page.getByRole("alert").filter({ hasText: message }).last();
      await alert.waitFor();
      const button = page.getByRole("button", { name, exact: true });
      assert.equal(await button.isDisabled(), false, `${name} stays enabled after blocked audio recovery`);
      const alertId = await alert.getAttribute("id");
      assert.ok(alertId, `${name} recovery prompt has a stable accessible id`);
      assert.equal(await button.getAttribute("aria-describedby"), alertId,
        `${name} announces the matching recovery guidance when focused`);
      await button.focus();
      assert.equal(await button.evaluate(element => document.activeElement === element), true,
        `${name} is keyboard-focusable after the alert`);
      return button;
    };
    const position = async () => Number(await page.getByRole("slider", { name: "Seek project", exact: true }).inputValue());
    const waitForAudioContext = async (previousCount) => {
      await page.waitForFunction(count => window.audioProbe.contexts.length > count, previousCount);
      const index = await page.evaluate(() => window.audioProbe.contexts.length - 1);
      assert.ok(index >= previousCount, "Studio creates an audio context for each preview engine");
      return index;
    };
    const suspendContext = async (index) => {
      await page.evaluate(async (contextIndex) => {
        if (document.visibilityState !== "visible") throw new Error("Output-switch simulation must stay in the foreground.");
        const audio = window.audioProbe.contexts[contextIndex];
        if (!audio) throw new Error(`No audio context exists at index ${contextIndex}.`);
        await audio.suspend();
        if (audio.state !== "suspended") throw new Error("The output-switch fixture did not suspend its audio context.");
      }, index);
    };
    const notifyOutputChange = async () => page.evaluate(() => {
      if (!navigator.mediaDevices?.dispatchEvent) {
        throw new Error("The browser cannot simulate a media-device output change.");
      }
      navigator.mediaDevices.dispatchEvent(new Event("devicechange"));
    });
    const assertRecoveredOutput = async ({ contextIndex, playingButton, before }) => {
      await page.waitForFunction(({ index, buttonName }) =>
        document.visibilityState === "visible"
        && window.audioProbe.contexts[index]?.state === "running"
        && [...document.querySelectorAll("button")].some(button => button.getAttribute("aria-label") === buttonName),
      { index: contextIndex, buttonName: playingButton }, { timeout: 10_000 });
      await page.waitForFunction((previousPosition) =>
        Number(document.querySelector('[aria-label="Seek project"]')?.value ?? 0) > previousPosition + 0.1,
      before, { timeout: 10_000 });
    };
    const assertBlockedOutputRecovery = async ({ contextIndex, retryButton, playingButton, message }) => {
      const before = await position();
      await suspendContext(contextIndex);
      await blockNextResume();
      await notifyOutputChange();
      const action = await assertRecoveryControl(retryButton, message);
      assert.equal(await page.getByRole("button", { name: playingButton, exact: true }).count(), 0,
        `${retryButton} is not left in a false-playing state while output recovery is blocked`);
      assert(await position() >= before - 0.15,
        `${retryButton} recovery preserves the playhead instead of restarting from zero`);
      await action.click();
      await page.getByRole("button", { name: playingButton, exact: true }).waitFor({ timeout: 10_000 });
      await page.waitForFunction((previousPosition) =>
        Number(document.querySelector('[aria-label="Seek project"]')?.value ?? 0) > previousPosition + 0.1,
      before, { timeout: 10_000 });
    };

    let contextCount = await page.evaluate(() => window.audioProbe.contexts.length);
    await page.getByRole("button", { name: "Play stems", exact: true }).click();
    await page.getByRole("button", { name: "Pause stems", exact: true }).waitFor();
    const stemContextIndex = await waitForAudioContext(contextCount);
    assert.equal(await page.evaluate(() => window.audioProbe.suppressedStateChangeListeners > 0), true,
      "the route-switch test isolates the media-device event from AudioContext statechange recovery");
    let previousPosition = await position();
    await suspendContext(stemContextIndex);
    await notifyOutputChange();
    await assertRecoveredOutput({ contextIndex: stemContextIndex, playingButton: "Pause stems", before: previousPosition });
    await assertBlockedOutputRecovery({
      contextIndex: stemContextIndex,
      retryButton: "Play stems",
      playingButton: "Pause stems",
      message: "Audio playback was interrupted. Activate Play stems to resume.",
    });
    await page.getByRole("button", { name: "Pause stems", exact: true }).click();

    contextCount = await page.evaluate(() => window.audioProbe.contexts.length);
    await page.getByRole("button", { name: "Preview arrangement", exact: true }).click();
    await page.getByRole("button", { name: "Pause arrangement", exact: true }).waitFor();
    const arrangementContextIndex = await waitForAudioContext(contextCount);
    previousPosition = await position();
    await suspendContext(arrangementContextIndex);
    await notifyOutputChange();
    await assertRecoveredOutput({
      contextIndex: arrangementContextIndex,
      playingButton: "Pause arrangement",
      before: previousPosition,
    });
    await assertBlockedOutputRecovery({
      contextIndex: arrangementContextIndex,
      retryButton: "Preview arrangement",
      playingButton: "Pause arrangement",
      message: "Audio couldn't resume automatically. Activate Preview arrangement to try again.",
    });
    await page.getByRole("button", { name: "Pause arrangement", exact: true }).click();
    assert.deepEqual(assetSnapshot(), originalAssets, "handoff and editing preserve original audio");
    console.log("PASS: mobile-sized Bluetooth output-switch simulation resumes stem and arrangement playback at their current positions; blocked resumes expose linked, focusable retry controls");
  } else if (sharedDonorRetryOnly) {
    tracks[0].track.durationSeconds = 90;
    for (const [index, type] of types.entries()) assets.set(`a-${type}`, wav(90, 130 + index * 40));
    session.tracks = tracks;
    session.swaps = [];
    session.currentSessionTrackId = "a";
    session.positionSeconds = 0;
    const validDonor = assets.get("b-vocals");
    assets.set("b-vocals", Buffer.from("RIFFcorrupt!"));
    await page.goto(`http://localhost:80/waveyard/session/${sessionId}`);
    await page.waitForFunction(() => {
      const audio = [...document.querySelectorAll('[data-role="current"] audio')];
      return audio.length === 4 && audio.every(element => element.readyState === 4);
    });
    const standby = page.locator('[data-role="next"] audio[data-waveyard-asset-url$="/b-vocals"]');
    await page.waitForFunction(() => {
      const audio = document.querySelector('[data-role="next"] audio[data-waveyard-asset-url$="/b-vocals"]');
      return audio instanceof HTMLAudioElement && audio.error !== null;
    });
    const corruptSrc = await standby.getAttribute("src");
    await page.getByTestId("session-play").click();
    const deck = page.locator('[data-role="current"]');
    const before = await deck.locator("audio").first().evaluate(audio => audio.currentTime);
    await deck.getByTestId("open-live-swap-vocals").click();
    await deck.getByTestId("live-swap-candidate-vocals-b").click();
    await deck.getByText("Retry live stems", { exact: true }).waitFor();
    const failedTransfers = assetRequestTrace.filter(request => request.id === "b-vocals").length;
    assert.ok(failedTransfers > 0, "the corrupt asset reached the shared audio pool");
    assets.set("b-vocals", validDonor);
    await deck.getByText("Retry live stems", { exact: true }).click();
    await page.waitForFunction(() => {
      const audio = document.querySelector('[data-role="next"] audio[data-waveyard-asset-url$="/b-vocals"]');
      return audio?.readyState === 4 && audio.error === null;
    });
    assert.notEqual(await standby.getAttribute("src"), corruptSrc,
      "the standby deck adopts a fresh lease after donor retry replaces corrupt bytes");
    await page.waitForFunction(expected => window.audioProbe.buffers.some(node =>
      Math.abs(node.buffer.duration - expected) < 0.03
      && node.inputNode?.gain.value > 0.9 && (node.stopCount ?? 0) === 0,
    ), 8 * 124 / 120);
    assert.equal(assetRequestTrace.filter(request => request.id === "b-vocals").length, failedTransfers + 1,
      "one fresh response repairs both the donor and standby deck");
    await page.waitForFunction(before => {
      const audio = document.querySelector('[data-role="current"] audio');
      return audio && !audio.paused && audio.currentTime > before + 0.15;
    }, before);
    await page.getByTestId("session-transition").click();
    await page.getByRole("button", { name: "Finish", exact: true }).click();
    await page.waitForFunction(() => {
      const audio = [...document.querySelectorAll('[data-role="current"] audio')];
      return audio.length === 4 && audio.every(element =>
        element.dataset.waveyardAssetUrl?.includes("/b-")
        && !element.paused && element.currentTime > 0.1 && element.error === null);
    });
    assert.equal(session.currentSessionTrackId, "b", "the repaired upcoming track becomes current");
    console.log("PASS: corrupt shared next-track bytes recover on donor retry; one fresh transfer repairs both decks and the next track plays after transition");
  } else if (parallelStemSwapsOnly) {
    const gate = () => {
      let release;
      let signalStarted;
      return {
        promise: new Promise(resolve => { release = resolve; }),
        started: new Promise(resolve => { signalStarted = resolve; }),
        release: () => release(),
        signalStarted: () => signalStarted(),
        snapshot: null,
      };
    };
    const vocalSave = gate();
    const drumSave = gate();
    const vocalDonor = gate();
    const drumDonor = gate();
    const expectedVocalDuration = 8 * (tracks[1].analysis.bpm / tracks[0].analysis.bpm);
    parallelSwapResponses = new Map([["vocals", vocalSave], ["drums", drumSave]]);
    parallelDonorResponses = new Map([["b-vocals", vocalDonor], ["c-drums", drumDonor]]);
    tracks[0].track.durationSeconds = 90;
    for (const [index, type] of types.entries()) assets.set(`a-${type}`, wav(90, 130 + index * 40));
    session.tracks = tracks;
    session.swaps = [];
    session.currentSessionTrackId = "a";
    session.positionSeconds = 0;

    try {
      await page.goto(`http://localhost:80/waveyard/session/${sessionId}`);
      const deck = page.locator('[data-role="current"]');
      await page.waitForFunction(() => {
        const audio = [...document.querySelectorAll('[data-role="current"] audio')];
        return audio.length === 4 && audio.every(element => element.readyState === 4);
      });
      const play = page.getByTestId("session-play");
      await play.click();
      await page.waitForFunction(() => document.querySelector('[data-testid="session-play"]')?.getAttribute("aria-pressed") === "true");
      const choose = async (stemType, donorId) => {
        await deck.getByTestId(`open-live-swap-${stemType}`).click();
        const candidate = deck.getByTestId(`live-swap-candidate-${stemType}-${donorId}`);
        await candidate.waitFor();
        await candidate.click();
      };
      const responseFor = (stemType) => page.waitForResponse(response => {
        if (!response.url().endsWith("/swaps") || response.request().method() !== "POST") return false;
        return response.request().postDataJSON().stemType === stemType;
      }).catch(() => null);

      const clockBeforeSaves = await page.locator('[data-role="current"] audio').first().evaluate(audio => audio.currentTime);
      const vocalSaveResponse = responseFor("vocals");
      await choose("vocals", "b");
      await vocalSave.started;
      await vocalDonor.started;

      const drumsPickerTrigger = deck.getByTestId("open-live-swap-drums");
      await drumsPickerTrigger.click();
      const drumsCandidate = deck.getByTestId("live-swap-candidate-drums-c");
      await drumsCandidate.waitFor();
      assert.equal(await drumsCandidate.isDisabled(), false,
        "a vocals save must not disable the independent drums picker");
      const drumSaveResponse = responseFor("drums");
      await drumsCandidate.click();
      await Promise.all([drumSave.started, drumDonor.started]);
      assert.deepEqual(parallelSwapRequestOrder, ["vocals", "drums"],
        "both stem choices reach the session save route before either response is released");
      assert.deepEqual(parallelDonorResponseOrder, [],
        "neither selected donor has finished loading before both choices are made");

      await page.waitForTimeout(350);
      const pendingPlayback = await page.locator('[data-role="current"] audio').evaluateAll(audio =>
        audio.map(element => ({ paused: element.paused, currentTime: element.currentTime })),
      );
      assert.ok(pendingPlayback.every(item => !item.paused && item.currentTime > clockBeforeSaves + 0.15),
        "all recipient stems continue playing while both swaps and donors are pending");

      drumSave.release();
      const drumSaveResult = await drumSaveResponse;
      assert.ok(drumSaveResult?.ok(), "the second channel's saved-swap response succeeds first");
      assert.deepEqual(parallelSwapResponseOrder, ["drums"]);
      assert.deepEqual(drumSave.snapshot.swaps.map(swap => swap.stemType).sort(), ["drums", "vocals"],
        "the later server snapshot contains both saved channel choices");

      vocalSave.release();
      const vocalSaveResult = await vocalSaveResponse;
      assert.ok(vocalSaveResult?.ok(), "the first channel's stale snapshot arrives last without removing drums");
      assert.deepEqual(parallelSwapResponseOrder, ["drums", "vocals"]);
      assert.deepEqual(vocalSave.snapshot.swaps.map(swap => swap.stemType), ["vocals"],
        "the late vocal response intentionally represents its older one-channel snapshot");
      assert.deepEqual(session.swaps.map(swap => swap.stemType).sort(), ["drums", "vocals"],
        "the server-side saved session contains both independent swaps");

      drumDonor.release();
      await page.waitForFunction(() => window.audioProbe.buffers.some(node =>
        Math.abs(node.buffer.duration - 12) < 0.01 && node.inputNode?.gain.value > 0.9 && (node.stopCount ?? 0) === 0,
      ));
      const drumGraph = await page.evaluate(() => window.audioProbe.buffers
        .filter(node => Math.abs(node.buffer.duration - 12) < 0.01)
        .map(node => ({ gain: node.inputNode?.gain.value ?? 0, stopped: node.stopCount ?? 0 })));
      assert.ok(drumGraph.some(node => node.gain > 0.9 && node.stopped === 0),
        "the first completed donor response installs the chosen drums audio graph");
      assert.ok(!await page.evaluate(expected => window.audioProbe.buffers.some(node => Math.abs(node.buffer.duration - expected) < 0.03),
        expectedVocalDuration),
        "the still-delayed vocal donor has not been installed early");

      vocalDonor.release();
      try {
        await page.waitForFunction(expected => {
          const nodes = window.audioProbe.buffers;
          return nodes.some(node => Math.abs(node.buffer.duration - expected) < 0.03 &&
            node.inputNode?.gain.value > 0.9 && (node.stopCount ?? 0) === 0) &&
            nodes.some(node => Math.abs(node.buffer.duration - 12) < 0.01 &&
              node.inputNode?.gain.value > 0.9 && (node.stopCount ?? 0) === 0);
        }, expectedVocalDuration, { timeout: 8000 });
      } catch (error) {
        const graphs = await page.evaluate(() => window.audioProbe.buffers.map(node => ({
          duration: node.buffer.duration,
          gain: node.inputNode?.gain.value ?? 0,
          stopped: node.stopCount ?? 0,
        }))).catch(() => []);
        const pending = await page.locator('[data-testid^="live-swap-pending-"]').allTextContents().catch(() => []);
        throw new Error(`Late vocal donor did not become active: ${error instanceof Error ? error.message : error}; graphs=${JSON.stringify(graphs)}; donorRequests=${JSON.stringify(parallelDonorRequestOrder)}; donorResponses=${JSON.stringify(parallelDonorResponseOrder)}; deletes=${JSON.stringify(parallelSwapDeleteRequests)}; serverSwaps=${JSON.stringify(session.swaps)}; pending=${JSON.stringify(pending)}; status=${JSON.stringify(await deck.innerText().catch(() => ""))}`);
      }
      const donorGraphs = await page.evaluate(() => window.audioProbe.buffers.map(node => ({
        duration: node.buffer.duration,
        gain: node.inputNode?.gain.value ?? 0,
        stopped: node.stopCount ?? 0,
      })));
      assert.ok(donorGraphs.some(node => Math.abs(node.duration - expectedVocalDuration) < 0.03 && node.gain > 0.9 && node.stopped === 0),
        "the late vocal response installs the selected vocals donor graph");
      assert.ok(donorGraphs.some(node => Math.abs(node.duration - 12) < 0.01 && node.gain > 0.9 && node.stopped === 0),
        "the earlier drums graph remains active after vocals resolves");
      assert.ok(parallelDonorRequestOrder.includes("b-vocals") && parallelDonorRequestOrder.includes("c-drums"));
      const drumsResponseIndex = parallelDonorResponseOrder.indexOf("c-drums");
      const vocalsResponseIndex = parallelDonorResponseOrder.indexOf("b-vocals");
      assert.ok(drumsResponseIndex >= 0 && vocalsResponseIndex > drumsResponseIndex,
        `the second donor finishes before the first; response order=${JSON.stringify(parallelDonorResponseOrder)}`);
      assert.deepEqual(parallelSwapDeleteRequests, [],
        "independently successful swaps do not trigger a rollback request");

      const assertSelected = async (stemType, donorId) => {
        await deck.getByTestId(`open-live-swap-${stemType}`).click();
        const candidate = deck.getByTestId(`live-swap-candidate-${stemType}-${donorId}`);
        await candidate.waitFor();
        const selected = await candidate.getAttribute("aria-pressed");
        assert.equal(selected, "true",
          `${stemType} keeps the selected ${donorId} donor visible; trigger=${await deck.getByTestId(`open-live-swap-${stemType}`).innerText()}`);
      };
      await assertSelected("vocals", "b");
      await assertSelected("drums", "c");

      const savedChoices = session.swaps.map(swap => ({
        sessionTrackId: swap.sessionTrackId,
        stemType: swap.stemType,
        toTrackId: swap.toTrackId,
        toStemAssetId: swap.toStemAssetId,
      })).sort((left, right) => left.stemType.localeCompare(right.stemType));
      assert.deepEqual(savedChoices, [
        { sessionTrackId: "a", stemType: "drums", toTrackId: "c", toStemAssetId: "c-drums" },
        { sessionTrackId: "a", stemType: "vocals", toTrackId: "b", toStemAssetId: "b-vocals" },
      ]);

      await page.reload({ waitUntil: "domcontentloaded" });
      const reloadedDeck = page.locator('[data-role="current"]');
      await page.waitForFunction(() => {
        const audio = [...document.querySelectorAll('[data-role="current"] audio')];
        return audio.length === 4 && audio.every(element => element.readyState === 4);
      });
      const reloadedPlay = page.getByTestId("session-play");
      if (await reloadedPlay.getAttribute("aria-pressed") !== "true") {
        await reloadedPlay.click();
        await page.waitForFunction(() => document.querySelector('[data-testid="session-play"]')?.getAttribute("aria-pressed") === "true");
      }
      await page.waitForFunction(() => {
        const nodes = window.audioProbe.buffers;
        return nodes.some(node => Math.abs(node.buffer.duration - 8.2667) < 0.03) &&
          nodes.some(node => Math.abs(node.buffer.duration - 12) < 0.01);
      });
      await reloadedDeck.getByTestId("open-live-swap-vocals").click();
      assert.equal(await reloadedDeck.getByTestId("live-swap-candidate-vocals-b").getAttribute("aria-pressed"), "true",
        "the vocals choice remains visible after reopening the saved session");
      await reloadedDeck.getByTestId("open-live-swap-drums").click();
      assert.equal(await reloadedDeck.getByTestId("live-swap-candidate-drums-c").getAttribute("aria-pressed"), "true",
        "the drums choice remains visible after reopening the saved session");
      const reloadClock = await reloadedDeck.locator("audio").first().evaluate(audio => audio.currentTime);
      await page.waitForFunction(before => {
        const audio = document.querySelector('[data-role="current"] audio');
        return audio && !audio.paused && audio.currentTime > before + 0.15;
      }, reloadClock, { timeout: 3000 });
      const reloadedChoices = session.swaps.map(swap => ({
        sessionTrackId: swap.sessionTrackId,
        stemType: swap.stemType,
        toTrackId: swap.toTrackId,
        toStemAssetId: swap.toStemAssetId,
      })).sort((left, right) => left.stemType.localeCompare(right.stemType));
      assert.deepEqual(reloadedChoices, savedChoices,
        "both independently saved swaps survive reloading the session");

      const retainedVocalSwap = {
        id: "retained-vocals-b",
        sessionTrackId: "a",
        stemType: "vocals",
        toTrackId: "b",
        toStemAssetId: "b-vocals",
        atSeconds: 0,
        fromTrackId: "a",
        createdAt: new Date().toISOString(),
      };
      session.tracks = tracks;
      session.swaps = [retainedVocalSwap];
      session.currentSessionTrackId = "a";
      session.positionSeconds = 0;
      parallelSwapRequestOrder.splice(0);
      parallelSwapResponseOrder.splice(0);
      parallelDonorRequestOrder.splice(0);
      parallelDonorResponseOrder.splice(0);
      assetRequestTrace.splice(0);
      parallelSwapDeleteRequests.splice(0);
      donorRestoreRequests.splice(0);
      failedAssetRequests = 0;
      const failedVocalSave = gate();
      const successfulDrumSave = gate();
      const failedVocalDonor = gate();
      const successfulDrumDonor = gate();
      parallelSwapResponses = new Map([["vocals", failedVocalSave], ["drums", successfulDrumSave]]);
      parallelDonorResponses = new Map([
        ["c-vocals", failedVocalDonor],
        ["c-drums", successfulDrumDonor],
      ]);
      failAsset = null;

      const failureDeck = page.locator('[data-role="current"]');
      await page.goto(`http://localhost:80/waveyard/session/${sessionId}`);
      await page.waitForFunction(() => {
        const audio = [...document.querySelectorAll('[data-role="current"] audio')];
        return audio.length === 4 && audio.every(element => element.readyState === 4);
      });
      await page.getByTestId("session-play").click();
      await page.waitForFunction(() => document.querySelector('[data-testid="session-play"]')?.getAttribute("aria-pressed") === "true");
      await page.waitForFunction(() => window.audioProbe.buffers.some(node =>
        Math.abs(node.buffer.duration - 8.2667) < 0.03 &&
        node.inputNode?.gain.value > 0.9 && (node.stopCount ?? 0) === 0,
      ), null, { timeout: 8000 });

      const failedVocalSaveResponse = responseFor("vocals");
      await choose("vocals", "c");
      await Promise.all([failedVocalSave.started, failedVocalDonor.started]);
      const successfulDrumSaveResponse = responseFor("drums");
      await choose("drums", "c");
      await Promise.all([successfulDrumSave.started, successfulDrumDonor.started]);
      assert.deepEqual(parallelSwapRequestOrder, ["vocals", "drums"],
        "both stem choices are saved before either save response is released");
      assert.ok(parallelDonorRequestOrder.includes("c-vocals") && parallelDonorRequestOrder.includes("c-drums"),
        `both selected donor downloads are pending: ${JSON.stringify(parallelDonorRequestOrder)}`);
      assert.deepEqual(parallelDonorResponseOrder, [],
        "neither donor finishes before both stem choices have been made");

      const pendingClocks = await failureDeck.locator("audio").evaluateAll(audio => audio.map(element => element.currentTime));
      await page.waitForTimeout(350);
      const failurePendingPlayback = await failureDeck.locator("audio").evaluateAll((audio, before) => audio.map((element, index) => ({
        paused: element.paused,
        advanced: element.currentTime > (before[index] ?? 0) + 0.15,
      })), pendingClocks);
      assert.ok(failurePendingPlayback.every(item => !item.paused) && failurePendingPlayback.filter(item => item.advanced).length >= 3,
        `the retained mix keeps playing during both downloads: ${JSON.stringify(failurePendingPlayback)}`);

      successfulDrumSave.release();
      assert.ok((await successfulDrumSaveResponse)?.ok(), "the drums choice saves first");
      failedVocalSave.release();
      assert.ok((await failedVocalSaveResponse)?.ok(), "the vocals choice saves before its asset fails");
      assert.deepEqual(failedVocalSave.snapshot.swaps.map(swap => [swap.stemType, swap.toTrackId]), [["vocals", "c"]],
        "the late vocals response contains only its older channel snapshot");
      assert.deepEqual(successfulDrumSave.snapshot.swaps.map(swap => [swap.stemType, swap.toTrackId]), [
        ["vocals", "c"], ["drums", "c"],
      ], "the drums response includes both saved choices");

      const rollbackResponse = page.waitForResponse(response => {
        if (!response.url().endsWith("/swaps") || response.request().method() !== "POST") return false;
        const body = response.request().postDataJSON();
        return body.stemType === "vocals" && body.toTrackId === "b" && body.expectedSwapId === "swap-vocals";
      });
      failAsset = "c-vocals";
      failedVocalDonor.release();
      const failedDownload = await page.waitForResponse(response =>
        response.url().endsWith("/api/assets/c-vocals") && response.request().resourceType() === "fetch",
      );
      assert.equal(failedDownload.status(), 503, "the newly selected vocals asset fails after its save");
      await waitForSignal(failedVocalDonor.finished, "failed vocals donor response");
      assert.ok((await rollbackResponse).ok(), "the UI restores the last valid vocals donor");
      assert.ok(failedAssetRequests > 0, "the selected vocals donor was rejected by the asset route");
      assert.equal(donorRestoreRequests.length, 1);
      assert.equal(donorRestoreRequests[0].toTrackId, "b");
      assert.equal(donorRestoreRequests[0].expectedSwapId, "swap-vocals");
      assert.deepEqual(session.swaps.map(swap => [swap.stemType, swap.toTrackId]).sort(), [
        ["drums", "c"], ["vocals", "b"],
      ], "the failed channel returns to its prior donor without removing the drums choice");
      assert.ok(!parallelDonorResponseOrder.includes("c-drums"),
        "the independent drums request remains in flight during vocal recovery");
      assert.equal(await page.getByText("Retry live stems", { exact: true }).count(), 1,
        "the failed vocals choice remains available for retry");
      await page.waitForFunction(() => window.audioProbe.buffers.some(node =>
        Math.abs(node.buffer.duration - 8.2667) < 0.03 &&
        node.inputNode?.gain.value > 0.9 && (node.stopCount ?? 0) === 0,
      ), null, { timeout: 8000 });
      assert.ok((await failureDeck.locator("audio").evaluateAll(audio => audio.every(element => !element.paused))),
        "the retained vocals donor keeps playing while drums is still pending");

      failAsset = null;
      successfulDrumDonor.release();
      await waitForSignal(successfulDrumDonor.finished, "successful drums donor response");
      await page.waitForFunction(() => window.audioProbe.buffers.some(node =>
        Math.abs(node.buffer.duration - 12) < 0.01 &&
        node.inputNode?.gain.value > 0.9 && (node.stopCount ?? 0) === 0,
      ), null, { timeout: 8000 });
      parallelSwapResponses = null;
      parallelDonorResponses = null;
      await assertSelected("vocals", "b");
      await assertSelected("drums", "c");
      assert.deepEqual(session.swaps.map(swap => [swap.stemType, swap.toTrackId]).sort(), [
        ["drums", "c"], ["vocals", "b"],
      ], "visible selections match the audible retained and successful layers");

      await page.reload({ waitUntil: "domcontentloaded" });
      const reopenedDeck = page.locator('[data-role="current"]');
      await page.waitForFunction(() => {
        const audio = [...document.querySelectorAll('[data-role="current"] audio')];
        return audio.length === 4 && audio.every(element => element.readyState === 4);
      });
      const reopenedPlay = page.getByTestId("session-play");
      if (await reopenedPlay.getAttribute("aria-pressed") !== "true") {
        await reopenedPlay.click();
        await page.waitForFunction(() => document.querySelector('[data-testid="session-play"]')?.getAttribute("aria-pressed") === "true");
      }
      await page.waitForFunction(() => {
        const nodes = window.audioProbe.buffers;
        return nodes.some(node => Math.abs(node.buffer.duration - 8.2667) < 0.03 &&
          node.inputNode?.gain.value > 0.9 && (node.stopCount ?? 0) === 0) &&
          nodes.some(node => Math.abs(node.buffer.duration - 12) < 0.01 &&
            node.inputNode?.gain.value > 0.9 && (node.stopCount ?? 0) === 0);
      }, null, { timeout: 8000 });
      await reopenedDeck.getByTestId("open-live-swap-vocals").click();
      assert.equal(await reopenedDeck.getByTestId("live-swap-candidate-vocals-b").getAttribute("aria-pressed"), "true",
        "reopening preserves the last valid vocals donor");
      await reopenedDeck.getByTestId("open-live-swap-drums").click();
      assert.equal(await reopenedDeck.getByTestId("live-swap-candidate-drums-c").getAttribute("aria-pressed"), "true",
        "reopening preserves the successful drums donor");
      assert.deepEqual(session.swaps.map(swap => [swap.stemType, swap.toTrackId]).sort(), [
        ["drums", "c"], ["vocals", "b"],
      ], "the reopened session keeps both valid saved donor choices");
    console.log("PASS: parallel stem donors preserve the last valid failed-channel choice, the independent successful layer, playback, and saved state after reopen");
    } finally {
      for (const response of [...(parallelSwapResponses?.values() ?? []), ...(parallelDonorResponses?.values() ?? [])]) response.release();
      parallelSwapResponses = null;
      parallelDonorResponses = null;
    }
  } else if (sameStemSwapsOnly) {
    // Keep the active session entry stable while the deliberately held
    // responses exercise rapid repeated choices.
    tracks[0].track.durationSeconds = 90;
    for (const [index, type] of types.entries()) assets.set(`a-${type}`, wav(90, 130 + index * 40));
    const gate = ({ failAfterPersist = false, failBeforePersist = false } = {}) => {
      let release;
      let signalStarted;
      let signalFinished;
      return {
        promise: new Promise(resolve => { release = resolve; }),
        started: new Promise(resolve => { signalStarted = resolve; }),
        finished: new Promise(resolve => { signalFinished = resolve; }),
        release: () => release(),
        signalStarted: () => signalStarted(),
        signalFinished: () => signalFinished(),
        failAfterPersist,
        failBeforePersist,
        snapshot: null,
      };
    };
    const waitForReadyDeck = async () => {
      await page.waitForFunction(() => {
        const audio = [...document.querySelectorAll('[data-role="current"] audio')];
        return audio.length === 4 && audio.every(element => element.readyState === 4);
      });
    };
    const chooseDonor = async donorId => {
      const deck = page.locator('[data-role="current"]');
      await deck.getByTestId("open-live-swap-vocals").click();
      const candidate = deck.getByTestId(`live-swap-candidate-vocals-${donorId}`);
      await candidate.waitFor();
      await candidate.click();
    };
    const saveResponseFor = donorId => page.waitForResponse(response => {
      if (!response.url().endsWith("/swaps") || response.request().method() !== "POST") return false;
      return response.request().postDataJSON().toTrackId === donorId;
    });
    const releaseSave = async (donorId, expectedStatus = 200) => {
      const gateForSave = sameStemSaveResponses.get(donorId);
      const response = saveResponseFor(donorId);
      gateForSave.release();
      const saved = await response;
      assert.equal(saved.status(), expectedStatus, `the ${donorId} save returns the expected status`);
    };
    const assertLatestDonor = async () => {
      assert.equal(session.swaps.length, 1, `one current donor is saved for vocals: ${JSON.stringify(session.swaps)}`);
      assert.equal(session.swaps[0].toTrackId, "c", "the newest explicit donor remains saved");
      const deck = page.locator('[data-role="current"]');
      await deck.getByTestId("open-live-swap-vocals").click();
      assert.equal(await deck.getByTestId("live-swap-candidate-vocals-c").getAttribute("aria-pressed"), "true",
        "the newest donor remains selected in the picker");
      assert.equal(await deck.getByTestId("live-swap-candidate-vocals-b").getAttribute("aria-pressed"), "false",
        "the older donor is not shown as selected");
      try {
        await page.waitForFunction(() => window.audioProbe.buffers.some(node =>
          Math.abs(node.buffer.duration - 12) < 0.03 && node.inputNode?.gain.value > 0.9 && (node.stopCount ?? 0) === 0,
        ), null, { timeout: 8000 });
      } catch (error) {
        const evidence = await page.evaluate(() => ({
          buffers: window.audioProbe.buffers.map(node => ({
            duration: node.buffer.duration,
            gain: node.inputNode?.gain.value ?? 0,
            stopped: node.stopCount ?? 0,
          })),
          decoded: window.audioProbe.decodedAudio.map(entry => entry.duration),
          sourceUrls: window.audioProbe.sources.map(node => node.mediaElement?.currentSrc ?? ""),
          workletLoads: window.audioProbe.workletLoads.map(entry => entry.duration),
          mediaError: document.querySelector('[data-role="current"]')?.querySelector('[role="alert"]')?.textContent,
          pending: [...document.querySelectorAll('[data-testid^="live-swap-pending-"]')].map(node => node.textContent),
          status: [...document.querySelectorAll('[role="status"]')].map(node => node.textContent),
          current: document.querySelector('[data-role="current"]')?.textContent?.slice(0, 200),
        })).catch(() => null);
        throw new Error(`Newest donor did not become audible: ${error instanceof Error ? error.message : error}; ` +
          `assetRequests=${JSON.stringify(parallelDonorRequestOrder)}; assetResponses=${JSON.stringify(parallelDonorResponseOrder)}; ` +
          `saveResponses=${JSON.stringify(sameStemSaveResponseOrder)}; ${JSON.stringify(evidence)}`);
      }
      assert.ok(!await page.evaluate(() => window.audioProbe.buffers.some(node =>
        Math.abs(node.buffer.duration - 8.2667) < 0.03 && node.inputNode?.gain.value > 0.9 && (node.stopCount ?? 0) === 0,
      )), "the older donor never takes over the audible graph");
    };
    const verifyReopen = async () => {
      await page.reload({ waitUntil: "domcontentloaded" });
      await waitForReadyDeck();
      const play = page.getByTestId("session-play");
      if (await play.getAttribute("aria-pressed") !== "true") {
        await play.click();
        await page.waitForFunction(() => document.querySelector('[data-testid="session-play"]')?.getAttribute("aria-pressed") === "true");
      }
      await page.waitForFunction(() => window.audioProbe.buffers.some(node =>
        Math.abs(node.buffer.duration - 12) < 0.03 && node.inputNode?.gain.value > 0.9 && (node.stopCount ?? 0) === 0,
      ), null, { timeout: 8000 });
      assert.equal(session.swaps.length, 1);
      assert.equal(session.swaps[0].toTrackId, "c", "the reopened session restores the newest donor");
      const deck = page.locator('[data-role="current"]');
      await deck.getByTestId("open-live-swap-vocals").click();
      assert.equal(await deck.getByTestId("live-swap-candidate-vocals-c").getAttribute("aria-pressed"), "true");
    };
    const runOrderScenario = async (saveOrder, donorOrder) => {
      session.swaps = [];
      session.tracks = tracks;
      session.currentSessionTrackId = "a";
      session.positionSeconds = 0;
      sameStemSaveRequestOrder.splice(0);
      sameStemSaveResponseOrder.splice(0);
      parallelDonorRequestOrder.splice(0);
      parallelDonorResponseOrder.splice(0);
      const saveA = gate();
      const saveB = gate();
      const donorA = gate();
      const donorB = gate();
      sameStemSaveResponses = new Map([["b", saveA], ["c", saveB]]);
      parallelDonorResponses = new Map([["b-vocals", donorA], ["c-vocals", donorB]]);
      try {
        const upcomingPayloadResponse = page.waitForResponse(response =>
          new URL(response.url()).pathname === "/api/assets/b-vocals"
          && response.request().resourceType() === "fetch",
        );
        await page.goto(`http://localhost:80/waveyard/session/${sessionId}`);
        await waitForReadyDeck();
        const play = page.getByTestId("session-play");
        await play.click();
        await page.waitForFunction(() => document.querySelector('[data-testid="session-play"]')?.getAttribute("aria-pressed") === "true");
        const deck = page.locator('[data-role="current"]');
        const clocksBefore = await deck.locator("audio").evaluateAll(audio =>
          audio.map(element => element.currentTime),
        );
        await page.evaluate(() => { window.liveStemAssetFetchTrace.length = 0; });
        await chooseDonor("b");
        await Promise.all([
          waitForSignal(saveA.started, "first vocals save"),
          waitForSignal(donorA.started, "first vocals donor download"),
        ]);
        await chooseDonor("c");
        await Promise.all([
          waitForSignal(saveB.started, "newer vocals save"),
          waitForSignal(donorB.started, "newer vocals donor download"),
        ]);
        assert.deepEqual(sameStemSaveRequestOrder, ["b", "c"],
          "both same-stem saves are in flight in user-selection order");
        await page.waitForTimeout(500);
        const pendingPlayback = await deck.locator("audio").evaluateAll(
          (audio, previous) => audio.map((element, index) => ({
              paused: element.paused,
              currentTime: element.currentTime,
              advanced: element.currentTime > (previous[index] ?? 0) + 0.1,
              source: element.currentSrc,
            })),
          clocksBefore,
        );
        assert.ok(pendingPlayback.every(item => !item.paused) && pendingPlayback.filter(item => item.advanced).length >= 3,
          `recipient playback continues while saves/downloads are unresolved: ${JSON.stringify(pendingPlayback)}`);

        for (const donorId of saveOrder) await releaseSave(donorId);
        assert.deepEqual(sameStemSaveResponseOrder, saveOrder, "save responses complete in the requested order");
        for (const assetId of donorOrder) {
          const donorGate = assetId === "b-vocals" ? donorA : donorB;
          donorGate.release();
          await waitForSignal(donorGate.finished, `${assetId} donor response`);
        }
        const firstAResponse = parallelDonorResponseOrder.indexOf("b-vocals");
        const firstBResponse = parallelDonorResponseOrder.indexOf("c-vocals");
        assert.ok(firstAResponse >= 0 && firstBResponse >= 0,
          `both selected donor downloads resolve: ${JSON.stringify(parallelDonorResponseOrder)}`);
        assert.ok(
          donorOrder[0] === "b-vocals" ? firstAResponse < firstBResponse : firstBResponse < firstAResponse,
          `donor downloads complete in the requested order: ${JSON.stringify(parallelDonorResponseOrder)}`,
        );
        await assertLatestDonor();
        await page.waitForFunction(() => {
          const audio = document.querySelector(
            '[data-testid="session-deck-b"] audio[data-waveyard-asset-url$="/b-vocals"]',
          );
          return audio?.readyState === 4
            && audio.dataset.waveyardMediaSrc?.startsWith("blob:");
        }, undefined, { timeout: 8_000 });
        const upcomingTrackPlayback = await page.evaluate(async () => {
          const audio = document.querySelector(
            '[data-testid="session-deck-b"] audio[data-waveyard-asset-url$="/b-vocals"]',
          );
          if (!(audio instanceof HTMLAudioElement) || audio.readyState < HTMLMediaElement.HAVE_CURRENT_DATA) {
            return { ready: false, played: false, source: audio?.dataset.waveyardMediaSrc ?? null };
          }
          audio.currentTime = 0;
          const start = audio.currentTime;
          await audio.play();
          await new Promise(resolve => setTimeout(resolve, 180));
          const played = audio.currentTime > start + 0.03;
          audio.pause();
          return {
            ready: audio.readyState === HTMLMediaElement.HAVE_ENOUGH_DATA,
            played,
            paused: audio.paused,
            source: audio.dataset.waveyardMediaSrc ?? null,
          };
        });
        assert.deepEqual(upcomingTrackPlayback, {
          ready: true,
          played: true,
          paused: true,
          source: upcomingTrackPlayback.source,
        }, `the next-up track remains playable from the shared in-memory asset: ${JSON.stringify(upcomingTrackPlayback)}`);
        assert.ok(upcomingTrackPlayback.source?.startsWith("blob:"),
          `the next-up media element consumes the pool's in-memory bytes: ${upcomingTrackPlayback.source}`);
        const nextTrackAssetRequests = assetRequestTrace.filter(request => request.id === "b-vocals");
        assert.equal(nextTrackAssetRequests.length, 1,
          `the upcoming deck and live swap cause one total request for the next-up stem: ${JSON.stringify(nextTrackAssetRequests)}`);
        assert.equal(nextTrackAssetRequests[0].resourceType, "fetch",
          "the shared no-store fetch feeds both the media element and live-stem decoder");
        assert.equal(nextTrackAssetRequests[0].range, null,
          "the asset is transferred once in full instead of fetching separate media ranges");
        const sharedResponse = await upcomingPayloadResponse;
        assert.match(sharedResponse.headers()["cache-control"] ?? "", /no-store/i,
          "shared private audio remains non-persistent at the response boundary");
        const selectedDonorTransfers = await page.evaluate(() => window.liveStemAssetFetchTrace
          .filter(path => path === "/api/assets/b-vocals" || path === "/api/assets/c-vocals")
          .reduce((counts, path) => ({ ...counts, [path]: (counts[path] ?? 0) + 1 }), {}));
        assert.equal(selectedDonorTransfers["/api/assets/b-vocals"] ?? 0, 1,
          "the first selected donor is transferred once even when superseded during its warm-up");
        assert.equal(selectedDonorTransfers["/api/assets/c-vocals"] ?? 0, 1,
          "the final audible donor reuses its warm-up transfer");
        assert.equal(parallelDonorRequestOrder.filter(id => id === "b-vocals").length, 1,
          "the next deck and the live swap share the same private asset response");
        assert.equal(parallelDonorRequestOrder.filter(id => id === "c-vocals").length, 1,
          "the final audible donor uses one live-swap fetch");
        sameStemSaveResponses = null;
        parallelDonorResponses = null;
        await verifyReopen();
      } finally {
        for (const response of [...(sameStemSaveResponses?.values() ?? []), ...(parallelDonorResponses?.values() ?? [])]) {
          response.release();
        }
        sameStemSaveResponses = null;
        parallelDonorResponses = null;
      }
    };

    for (const [saveOrder, donorOrder] of [
      [["b", "c"], ["b-vocals", "c-vocals"]],
      [["b", "c"], ["c-vocals", "b-vocals"]],
      [["c", "b"], ["b-vocals", "c-vocals"]],
      [["c", "b"], ["c-vocals", "b-vocals"]],
    ]) {
      await runOrderScenario(saveOrder, donorOrder);
    }

    // An earlier request may fail after the newer choice has committed. The
    // late failure must not replace picker state or hide the successful save.
    session.swaps = [];
    session.currentSessionTrackId = "a";
    const olderFailure = gate({ failAfterPersist: true });
    sameStemSaveResponses = new Map([["b", olderFailure]]);
    await page.goto(`http://localhost:80/waveyard/session/${sessionId}`);
    await waitForReadyDeck();
    await page.getByTestId("session-play").click();
    await page.waitForFunction(() => document.querySelector('[data-testid="session-play"]')?.getAttribute("aria-pressed") === "true");
    await chooseDonor("b");
    await waitForSignal(olderFailure.started, "older save held after persistence");
    const newerSaveResponse = saveResponseFor("c");
    await chooseDonor("c");
    assert.ok((await newerSaveResponse).ok(), "the newer donor saves while the older response is pending");
    const oldFailureResponse = saveResponseFor("b");
    olderFailure.release();
    assert.equal((await oldFailureResponse).status(), 503, "the older save failure is delivered after the newer save");
    await waitForSignal(olderFailure.finished, "older failed response");
    await assertLatestDonor();
    sameStemSaveResponses = null;
    await verifyReopen();

    // A cancellation already requested for A may complete after B has been
    // saved. The API deletion is scoped to A's unique swap id and cannot erase B.
    session.swaps = [];
    session.currentSessionTrackId = "a";
    parallelSwapDeleteRequests.splice(0);
    const cancelledOlderSave = gate();
    sameStemSaveResponses = new Map([["b", cancelledOlderSave]]);
    await page.goto(`http://localhost:80/waveyard/session/${sessionId}`);
    await waitForReadyDeck();
    await page.getByTestId("session-play").click();
    await page.waitForFunction(() => document.querySelector('[data-testid="session-play"]')?.getAttribute("aria-pressed") === "true");
    await chooseDonor("b");
    await waitForSignal(cancelledOlderSave.started, "cancelled older save");
    const cancel = page.locator('[data-testid^="cancel-live-stem-swap-pending-"]').first();
    await cancel.waitFor();
    await cancel.click();
    const newestSave = saveResponseFor("c");
    await chooseDonor("c");
    assert.ok((await newestSave).ok(), "the newest donor saves after the older choice is cancelled");
    const olderPost = saveResponseFor("b");
    const staleDelete = page.waitForResponse(response =>
      new URL(response.url()).pathname.endsWith("/swaps") && response.request().method() === "DELETE",
    );
    cancelledOlderSave.release();
    assert.ok((await olderPost).ok(), "the cancelled older save response arrives late");
    assert.ok((await staleDelete).ok(), "the cancellation request completes without removing the newer swap");
    await waitForSignal(cancelledOlderSave.finished, "cancelled older response");
    assert.equal(session.swaps.length, 1);
    assert.equal(session.swaps[0].toTrackId, "c", "a stale cancellation cannot delete the latest persisted choice");
    await verifyReopen();
    console.log("PASS: same-stem donor A→B keeps B across all save/download response orders, older failure, stale cancellation, picker state, active audio, and session reopen");
  } else if (donorReplacementOnly) {
    // Longer fixtures keep this focused acceptance flow on one recipient.
    tracks[0].track.durationSeconds = 90;
    for (const [index, type] of types.entries()) assets.set(`a-${type}`, wav(90, 130 + index * 40));
    await page.goto(`http://localhost:80/waveyard/session/${sessionId}`);
    const deck = page.locator('[data-role="current"]');
    await page.waitForFunction(() => {
      const audio = [...document.querySelectorAll('[data-role="current"] audio')];
      return audio.length === 4 && audio.every(element => element.readyState === 4);
    });
    const choose = async (stemType, donorId) => {
      await deck.getByTestId(`open-live-swap-${stemType}`).click();
      const saved = page.waitForResponse(response => {
        if (!response.url().endsWith("/swaps") || response.request().method() !== "POST") return false;
        const body = response.request().postDataJSON();
        return body.toTrackId === donorId && body.stemType === stemType && !body.expectedSwapId;
      });
      await deck.getByTestId(`live-swap-candidate-${stemType}-${donorId}`).click();
      await saved;
    };
    const settled = async (stemType, donorId) => {
      for (let tries = 0; tries < 200; tries++) {
        if (session.swaps.find(s => s.stemType === stemType)?.toTrackId === donorId &&
          await page.getByTestId(`live-swap-pending-${stemType}`).count() === 0) return;
        await page.waitForTimeout(50);
      }
       const alerts = await page.locator('[role="status"], [role="alert"]').allInnerTexts();
       throw new Error(`Unsettled ${stemType}: ${JSON.stringify(session.swaps)}; restores=${JSON.stringify(donorRestoreRequests)}; deletes=${JSON.stringify(parallelSwapDeleteRequests)}; alerts=${JSON.stringify(alerts)}; ${await deck.innerText()}`);
    };
    await page.getByTestId("session-play").click();
    await choose("vocals", "c");
    await settled("vocals", "c");
    await choose("drums", "d");
    await settled("drums", "d");
    await page.waitForFunction(() => window.audioProbe.buffers.length === 2);
    await page.evaluate(() => {
      window.retainedVocal = window.audioProbe.buffers.find(node => Math.abs(node.buffer.duration - 12) < 0.01);
      window.retainedDrums = window.audioProbe.buffers.find(node => Math.abs(node.buffer.duration - 4) < 0.01);
    });
    const baseline = await page.evaluate(() => ({
      count: window.audioProbe.buffers.length,
      clock: document.querySelector('[data-role="current"] audio').currentTime,
    }));
    assert.equal(baseline.count, 2, "both retained donors must actually start");
    failAsset = "b-vocals";
    for (const failRestore of [false, true]) {
      failNextDonorRestore = failRestore;
      await choose("vocals", "b");
      if (failRestore) {
        const retry = page.getByRole("button", { name: "Retry saving previous vocals source", exact: true });
        await retry.waitFor();
        await page.getByText(/saved source could not be restored/).waitFor();
        assert.equal(session.swaps.find(s => s.stemType === "vocals").toTrackId, "b",
          "an unsaved recovery must not be presented as persisted");
        await retry.click();
      }
      await settled("vocals", "c");
      assert.equal(session.swaps.find(s => s.stemType === "vocals").toTrackId, "c");
      assert.equal(session.swaps.find(s => s.stemType === "vocals").toStemAssetId, "c-vocals");
      assert.equal(session.swaps.find(s => s.stemType === "drums").toTrackId, "d");
      const retained = await page.evaluate(() => ({
        count: window.audioProbe.buffers.length,
        vocalsStopped: window.retainedVocal.stopCount ?? 0,
        drumsStopped: window.retainedDrums.stopCount ?? 0,
        vocalGain: window.retainedVocal.inputNode.gain.value,
        drumGain: window.retainedDrums.inputNode.gain.value,
        clock: document.querySelector('[data-role="current"] audio').currentTime,
        playing: [...document.querySelectorAll('[data-role="current"] audio')].every(audio => !audio.paused),
      }));
      assert.equal(retained.count, baseline.count, "failed B and restored A must not create new audio sources");
      assert.equal(retained.vocalsStopped, 0, "A must never be stopped during recovery");
      assert.equal(retained.drumsStopped, 0, "the other donor must remain untouched");
      assert.ok(retained.vocalGain > 0.9 && retained.drumGain > 0.9, "both donors stay audible");
      assert.ok(retained.playing && retained.clock > baseline.clock, "recipient playback and clock continue");
    }
    assert.ok(donorRestoreRequests.every(body => body.expectedSwapId && body.toStemAssetId === "c-vocals"));
    await page.reload();
    await page.getByTestId("session-play").waitFor();
    if (await page.getByTestId("session-play").getAttribute("aria-pressed") !== "true") {
      await page.getByTestId("session-play").click();
    }
    await page.waitForFunction(() => window.audioProbe.buffers.length === 2 &&
      window.audioProbe.buffers.some(node => Math.abs(node.buffer.duration - 12) < 0.01));
    assert.equal(session.swaps.find(s => s.stemType === "vocals").toTrackId, "c", "A survives reopening");
    failAsset = null;
    const countBeforeRetry = await page.evaluate(() => window.audioProbe.buffers.length);
    await choose("vocals", "b");
    await settled("vocals", "b");
    await page.waitForFunction(before => window.audioProbe.buffers.length > before, countBeforeRetry);
    await page.waitForFunction(() => window.audioProbe.buffers.find(node => Math.abs(node.buffer.duration - 12) < 0.01)?.stopCount > 0);
    assert.equal(await page.evaluate(() => window.audioProbe.buffers.find(node => Math.abs(node.buffer.duration - 4) < 0.01)?.stopCount ?? 0), 0,
      "the successful B retry also leaves the other donor playing");
    assert.equal(session.swaps.find(s => s.stemType === "vocals").toTrackId, "b", "a real retry installs B");
    assert.equal(session.swaps.find(s => s.stemType === "drums").toTrackId, "d");
    console.log("PASS: failed donor B preserves audible and saved A, other donors and the recipient clock; recovery save retries, reload and a real B retry work");
  } else if (process.argv.includes("--cross-tab-switch-recovery-only")) {
    await verifyCrossTabStemSwitchRecovery();
  } else if (process.argv.includes("--switch-recovery-only")) {
    await verifyStemSwitchRecovery();
    await verifyCrossTabStemSwitchRecovery();
  } else if (automaticFadesOnly) {
    const toggleForFade = async () => {
      const button = page.getByTestId("session-play");
      const before = await button.getAttribute("aria-pressed");
      await button.click();
      await page.waitForFunction(value =>
        document.querySelector('[data-testid="session-play"]')?.getAttribute("aria-pressed") !== value,
      before);
    };
    const chooseFadeDonor = async (stemType, donorId) => {
      const role = await page.locator('[data-role="current"]').count() ? "current" : "next";
      const deck = page.locator(`[data-role="${role}"]`);
      await deck.getByTestId(`open-live-swap-${stemType}`).click();
      await deck.getByTestId(`live-swap-candidate-${stemType}-${donorId}`).click();
    };
    await (loudFadesOnly ? runLoudAutomaticFadeAcceptance : runAutomaticFadeAcceptance)({
      page, session, tracks, sourceOnlyTrack, assets, wav, toggle: toggleForFade, chooseLiveSource: chooseFadeDonor,
    });
  } else {
  await page.goto("http://localhost:80/waveyard");
  await page.evaluate(() => localStorage.clear());
  if (keyMatchingOnly) {
    session.tracks = ["a", "b"].map((id, position) => {
      const item = tracks.find(track => track.id === id);
      assert.ok(item, `the key-match fixture contains track ${id}`);
      return { ...item, position, stemMix: { ...item.stemMix }, transition: { ...item.transition } };
    });
    session.currentSessionTrackId = "a";
    session.positionSeconds = 0;
    session.swaps = [];
    await page.goto(`http://localhost:80/waveyard/session/${sessionId}`);
    const keyCurrent = page.locator('[data-role="current"]');
    await keyCurrent.getByText("Test a", { exact: true }).waitFor();
    await page.waitForFunction(() =>
      [...document.querySelectorAll('[data-role="current"] audio')].length === 4
        && [...document.querySelectorAll('[data-role="current"] audio')].every(audio => audio.readyState === 4),
    );
    const play = page.getByTestId("session-play");
    if (await play.getAttribute("aria-pressed") !== "true") {
      await play.click();
      await page.waitForFunction(() =>
        document.querySelector('[data-testid="session-play"]')?.getAttribute("aria-pressed") === "true",
      );
    }
    try {
      await page.waitForFunction(() =>
        (document.querySelector('[data-role="current"] audio')?.currentTime ?? 0) > 0.2,
        undefined,
        { timeout: 5000 },
      );
    } catch (error) {
      console.log("KEY_MATCH_PLAYBACK_PRECHECK", JSON.stringify(await page.evaluate(() => ({
        audio: [...document.querySelectorAll('[data-role="current"] audio')].map(audio => ({
          src: audio.currentSrc, time: audio.currentTime, paused: audio.paused,
          readyState: audio.readyState, duration: audio.duration, playbackRate: audio.playbackRate,
        })),
        contexts: window.audioProbe.contexts.map(context => context.state),
      }))));
      throw error;
    }
    const before = await page.evaluate(() =>
      [...document.querySelectorAll('[data-role="current"] audio')]
        .find(audio => audio.currentSrc.endsWith("/a-drums"))?.currentTime ?? 0,
    );
    await page.getByTestId("session-key-mode-match").click();
    await page.waitForFunction(() =>
      document.querySelector('[data-testid="session-key-mode-match"]')?.getAttribute("aria-pressed") === "true"
        && document.querySelector('[data-testid="session-key-match-status"]')?.textContent.includes("-3 semitones"),
    );
    await page.waitForFunction(() =>
      window.audioProbe.worklets.filter(node =>
        node.probeName === "waveyard-key-shift" && node.probeConnections.length > 0).length >= 4
        && window.audioProbe.keyShifts.filter(message => message.semitones === -3).length >= 4,
    );
    await page.waitForTimeout(300);
    const after = await page.evaluate(async () => {
      const audio = [...document.querySelectorAll('[data-role="current"] audio')]
        .find(element => element.currentSrc.endsWith("/a-drums"));
      const source = window.audioProbe.sources.find(node => node.mediaElement === audio);
      const analyser = source?.context.createAnalyser();
      if (!audio || !source || !analyser) return { playing: false, time: 0, rms: 0, incomingKey: null };
      analyser.fftSize = 2048;
      source.connect(analyser);
      const data = new Float32Array(analyser.fftSize);
      let rms = 0;
      for (let sample = 0; sample < 4; sample += 1) {
        await new Promise(resolve => setTimeout(resolve, 25));
        analyser.getFloatTimeDomainData(data);
        rms = Math.max(rms, Math.sqrt(data.reduce((sum, value) => sum + value * value, 0) / data.length));
      }
      return {
        playing: !audio.paused,
        time: audio.currentTime,
        rms,
        sourceFound: Boolean(source),
        audioContextState: source.context.state,
        incomingKey: document.querySelector(
          '[data-testid="session-key-matching"] .wy-key-match-keys div:nth-child(3) dd',
        )?.textContent,
      };
    });
    assert.ok(after.playing && after.time > before + 0.2,
      `key matching cannot pause or reset the audible lead: ${JSON.stringify({ before, ...after })}`);
    assert.equal(after.incomingKey, "A major",
      `the incoming key display reflects the actual transposition: ${JSON.stringify(after)}`);

    await page.getByTestId("session-transition").click();
    await keyCurrent.getByText("Test b", { exact: true }).waitFor({ timeout: 12_000 });
    assert.equal(await page.getByTestId("session-key-mode-match").getAttribute("aria-pressed"), "true");
    await page.waitForFunction(() =>
      [...document.querySelectorAll('[data-role="current"] audio')].every(audio => !audio.paused)
        && window.audioProbe.worklets.filter(node =>
          node.probeName === "waveyard-key-shift" && node.probeConnections.length > 0).length >= 4,
    );
    console.log("PASS: key-match worklets transpose the incoming deck without interrupting the lead and remain active across the deck transition");
    await browser.close();
    process.exit(0);
  }
  if (!pitchModesOnly) {
    failNextModelCheck = true;
    await page.reload();
    await page.getByText("Temporary model status outage.", { exact: true }).waitFor();
    await page.getByRole("button", { name: "Check stem engine" }).click();
    await page.getByTestId("stem-engine-status")
      .getByText("Four stem model files present · vocals / drums / bass / other", { exact: true })
      .waitFor();
    assert.equal(await page.getByText("Temporary model status outage.", { exact: true }).count(), 0,
      "a successful stem-engine check clears the earlier status failure");
    const emptyWorkspace = page.locator("#waveyard-live-mixer");
    await emptyWorkspace.locator(".wy-workspace-empty").waitFor();
    assert.equal((await emptyWorkspace.locator(".eyebrow").textContent())?.trim(), "Live mixer");
    assert.match(await emptyWorkspace.locator("p").innerText(), /Play a library track to start/);
    assert.equal(await emptyWorkspace.evaluate(element => getComputedStyle(element).paddingBottom), "24px",
      "an empty mixer should not reserve space for a fixed transport");
    await page.waitForFunction(() =>
      document.querySelector('[data-testid="stem-engine-status"]')?.textContent ===
        "Four stem model files present · vocals / drums / bass / other");
    assert.equal(await page.getByTestId("stem-engine-status").innerText(),
      "Four stem model files present · vocals / drums / bass / other",
      "model files must not be presented as proof that inference succeeded");
    assert.ok(await page.evaluate(() => window.modelStatusFetchModes.length > 0));
    assert.ok(await page.evaluate(() => window.modelStatusFetchModes.every(mode => mode === "no-store")),
      "model readiness checks must bypass cached 304 responses");
  }
  if (!pitchModesOnly) {
    libraryUploadRequests = 0;
    abortNextLibraryUpload = true;
    const uploadTrackIntoSession = page.waitForResponse(response =>
      response.url().endsWith(`/api/library/sessions/${sessionId}/tracks`) && response.request().method() === "POST",
    );
    await page.locator('input[type="file"][multiple]').setInputFiles([
      { name: "retry-network-failure.wav", mimeType: "audio/wav", buffer: wav(2, 140) },
      { name: "upload-test.wav", mimeType: "audio/wav", buffer: wav(2, 180) },
    ]);
    const uploadRecovery = page.getByTestId("failed-library-uploads");
    await uploadRecovery.waitFor({ timeout: 10000 });
    assert.match(await uploadRecovery.innerText(), /retry-network-failure\.wav/);
    assert.doesNotMatch(await uploadRecovery.innerText(), /upload-test\.wav/,
      "a successful file is not included in the retry list");
    assert.equal(libraryUploadRequests, 2, "the batch continues after the first file hits a network failure");
    await page.getByRole("button", { name: "Retry 1 failed upload" }).click();
    await uploadRecovery.waitFor({ state: "detached", timeout: 10000 });
    assert.equal(libraryUploadRequests, 3, "retry resends the failed file without selecting it again");
    const openMixerLink = page.getByRole("link", { name: "Open live mixer", exact: true });
    await openMixerLink.waitFor({ timeout: 15000 });
    assert.equal(await openMixerLink.getAttribute("href"), "#waveyard-live-mixer");
    await uploadTrackIntoSession;
    await openMixerLink.click();
    await page.waitForFunction(() => window.location.hash === "#waveyard-live-mixer");
    assert.equal(await page.locator("#waveyard-live-mixer").count(), 1,
      "the upload action must lead back to the persistent live mixer");
  }
  session.tracks = tracks;
  session.swaps = [];
  session.currentSessionTrackId = "a";
  session.positionSeconds = 0;
  exposeSeparatedSource = false;
  showSeparationProgress = true;
  await page.goto(`http://localhost:80/waveyard/session/${sessionId}`);
  try {
    await page.waitForFunction(() => [...document.querySelectorAll('[data-role="current"] audio')].length === 4 &&
      [...document.querySelectorAll('[data-role="current"] audio')].every(a => a.readyState >= 2));
  } catch (error) {
    console.log("PITCH_FIXTURE_AUDIO_STATE", JSON.stringify(await page.locator("audio").evaluateAll(elements =>
      elements.map(audio => ({
        src: audio.currentSrc,
        readyState: audio.readyState,
        networkState: audio.networkState,
        error: audio.error ? { code: audio.error.code, message: audio.error.message } : null,
        duration: audio.duration,
      })),
    )));
    throw error;
  }
  let current = page.locator('[data-role="current"]');
  await page.setViewportSize({ width: 390, height: 844 });
  const playbackSpeed = page.getByTestId("session-playback-speed");
  await playbackSpeed.waitFor();
  for (let step = 0; step < 10; step += 1) await playbackSpeed.press("ArrowRight");
  assert.equal(await page.getByTestId("session-speed-value").textContent(), "1.10×");
  assert.match(await playbackSpeed.getAttribute("aria-valuetext"), /132 BPM.*pitch follows speed/);
  const mediaSpeedEvidence = await page.locator("audio").evaluateAll((elements) =>
    elements.map((element) => {
      const audio = element;
      return {
        rate: audio.playbackRate,
        preservesPitch: audio.preservesPitch,
      };
    }),
  );
  assert.ok(mediaSpeedEvidence.length > 0, "session should load audio elements before changing speed");
  assert.ok(mediaSpeedEvidence.every((entry) => Math.abs(entry.rate - 1.1) < 0.001),
    `all loaded stems must share the selected speed: ${JSON.stringify(mediaSpeedEvidence)}`);
  assert.ok(mediaSpeedEvidence.every((entry) => entry.preservesPitch === false),
    "speed changes must not preserve pitch on only the original media layers");
  const speedLayout = await page.evaluate(() => ({
    viewport: innerWidth,
    documentWidth: document.documentElement.scrollWidth,
    controlWidth: document.querySelector('[data-testid="session-playback-speed"]')?.getBoundingClientRect().width ?? 0,
  }));
  assert.ok(speedLayout.documentWidth <= speedLayout.viewport,
    `session speed control must fit on mobile: ${JSON.stringify(speedLayout)}`);
  const resetSpeed = page.getByTestId("session-speed-reset");
  assert.equal(await resetSpeed.isEnabled(), true, "non-default playback speed can be restored with one tap");
  await resetSpeed.click();
  assert.equal(await page.getByTestId("session-speed-value").textContent(), "1.00×");
  assert.equal(await resetSpeed.isDisabled(), true, "reset is disabled at the default speed");
  await playbackSpeed.press("ArrowRight");
  assert.equal(await page.getByTestId("session-speed-value").textContent(), "1.01×");
  await resetSpeed.click();
  assert.equal(await page.getByTestId("session-speed-value").textContent(), "1.00×",
    "reset returns to the original tempo after any slider adjustment");
  assert.equal(await page.getByTestId("session-loop-4").isEnabled(), true,
    "a four-beat loop should be available when the analyzed grid covers it");
  assert.equal(await page.getByTestId("session-loop-8").isEnabled(), false,
    "a loop must not guess beyond the analyzed grid");
  await page.getByTestId("session-loop-4").click();
  assert.equal(await page.getByTestId("session-loop-4").getAttribute("aria-pressed"), "true");
  await page.getByTestId("session-loop-off").click();
  assert.equal(await page.getByTestId("session-loop-4").getAttribute("aria-pressed"), "false");
  const cueSeek = current.getByTestId("seek-deck-0");
  await cueSeek.fill("5");
  await page.getByTestId("session-set-cue").click();
  await cueSeek.fill("10");
  await page.getByTestId("session-return-cue").click();
  await page.waitForFunction(() => {
    const audio = document.querySelector('[data-role="current"] audio');
    return audio && Math.abs(audio.currentTime - 5) < 0.1;
  });
  const djLayout = await page.evaluate(() => ({
    viewport: innerWidth,
    documentWidth: document.documentElement.scrollWidth,
    controls: document.querySelector(".wy-dj-controls")?.getBoundingClientRect().width ?? 0,
  }));
  assert.ok(djLayout.documentWidth <= djLayout.viewport,
    `DJ loop and cue buttons must fit on mobile: ${JSON.stringify(djLayout)}`);
  console.log("PASS: analyzed beat loops refuse unsupported lengths, toggle off, and cue return seeks the active deck on mobile");
  await page.setViewportSize({ width: 1280, height: 800 });
  console.log("PASS: mobile session varispeed updates every media stem together, displays effective BPM, and returns to 1.00× without overflow");
  const firstPage = page;
  const toggle = async () => {
    const button = page.getByTestId("session-play");
    const before = await button.getAttribute("aria-pressed");
    await button.click();
    await page.waitForFunction((before) => document.querySelector('[data-testid="session-play"]').getAttribute("aria-pressed") !== before, before);
  };
  const chooseLiveSource = async (stemType, donorId) => {
    await current.getByTestId(`open-live-swap-${stemType}`).click();
    const picker = current.getByTestId(`live-swap-picker-${stemType}`);
    await picker.waitFor();
    const candidate = current.getByTestId(`live-swap-candidate-${stemType}-${donorId}`);
    if (await candidate.count() === 0) {
      throw new Error(`Missing ${stemType} donor ${donorId}; current deck: ${await current.innerText()}; picker: ${await picker.innerText()}`);
    }
    await candidate.click();
  };
  const measureLiveStemSwap = async (donorId, expectedRatio, delayMs = 0, viewport = "desktop") => {
    // Earlier scenarios can outlast the 20-second synthetic recipient and
    // correctly auto-advance the session. Reload the same recipient for each
    // timing sample so the measurement never silently targets the next song.
    session.currentSessionTrackId = "a";
    session.positionSeconds = 0;
    session.swaps = [];
    await page.goto(`http://localhost:80/waveyard/session/${sessionId}`);
    await page.waitForFunction(() => {
      const audio = [...document.querySelectorAll('[data-role="current"] audio')];
      return audio.length === 4 && audio.every(element =>
        element.readyState === 4 && new URL(element.src).pathname.includes("/a-"),
      );
    }, { timeout: 10_000 });
    if (await current.locator("audio").first().evaluate(audio => audio.paused)) await toggle();
    const pickerTrigger = viewport === "mobile" ? "quick-open-live-swap-vocals" : "open-live-swap-vocals";
    await page.evaluate(() => { window.liveStemAssetFetchTrace.length = 0; });
    await current.getByTestId(pickerTrigger).click();
    const candidate = current.getByTestId(`live-swap-candidate-vocals-${donorId}`);
    await candidate.waitFor();
    const donorAssetPath = `/api/assets/${donorId}-vocals`;
    if (viewport === "mobile" && donorId === "b") {
      await page.waitForFunction(path => window.liveStemAssetFetchTrace.includes(path), donorAssetPath);
      assert.equal(await page.evaluate(path =>
        window.liveStemAssetFetchTrace.filter(request => request === path).length,
      donorAssetPath), 1, "the second mobile swap choice is fetched before it is tapped");
    }
    const before = await page.evaluate(() => ({
      buffers: window.audioProbe.buffers.length,
      timings: window.liveStemTimings.length,
    }));
    timedAssetId = `${donorId}-vocals`;
    timedAssetDelayMs = delayMs;
    await candidate.evaluate(button => {
      window.liveStemSelectionStart = null;
      window.liveStemObservedAudibleAt = null;
      button.addEventListener("click", () => {
        window.liveStemSelectionStart = performance.now();
      }, { once: true });
    });
    await candidate.click();
    try {
      await page.waitForFunction(({ bufferCount }) => {
        const source = window.audioProbe.buffers.slice(bufferCount)
          .find(item => item.inputNode?.gain?.value > 0.03);
        if (!source) return false;
        window.liveStemObservedAudibleAt = performance.now();
        return true;
      }, { bufferCount: before.buffers }, { timeout: 15000 });
      await page.waitForFunction(timingCount => window.liveStemTimings.length > timingCount,
        before.timings, { timeout: 15000 });
    } catch (error) {
      const diagnostic = await page.evaluate(({ bufferCount, timingCount }) => ({
        newBufferSources: window.audioProbe.buffers.slice(bufferCount).map(source => ({
          started: source.startedOffset !== undefined,
          offset: source.startedOffset ?? null,
          gain: source.inputNode?.gain?.value ?? null,
          duration: source.buffer?.duration ?? null,
        })),
        mediaSources: window.audioProbe.sources.map(source => ({
          url: source.mediaElement.currentSrc,
          paused: source.mediaElement.paused,
          currentTime: source.mediaElement.currentTime,
          gain: source.inputNode?.gain?.value ?? null,
        })),
        audioContextState: window.audioProbe.buffers.at(-1)?.context?.state ?? null,
        liveStemAssetFetchTrace: window.liveStemAssetFetchTrace,
        liveStemTimingsAdded: window.liveStemTimings.length - timingCount,
        selectionStart: window.liveStemSelectionStart,
        sessionStatus: document.querySelector('[data-testid="session-status"]')?.textContent ?? null,
      }), { bufferCount: before.buffers, timingCount: before.timings });
      console.log("LIVE_STEM_SWAP_AUDIBILITY_DIAGNOSTIC", JSON.stringify(diagnostic));
      throw error;
    } finally {
      timedAssetId = null;
      timedAssetDelayMs = 0;
    }
    const measurement = await page.evaluate(({ timingIndex }) => {
      const timing = window.liveStemTimings[timingIndex];
      return {
        ...timing,
        observedSelectionToAudibleMs: window.liveStemObservedAudibleAt - window.liveStemSelectionStart,
      };
    }, { timingIndex: before.timings });
    if (viewport === "mobile" && donorId === "b") {
      assert.equal(await page.evaluate(path =>
        window.liveStemAssetFetchTrace.filter(request => request === path).length,
      donorAssetPath), 1, "choosing the prefetched mobile donor reuses its one compressed download");
    }
    assert.equal(measurement.tempoStretchRatio, expectedRatio,
      `the ${viewport} scenario must use the intended tempo mode: ${JSON.stringify(measurement)}`);
    for (const field of ["selectionToAudibleMs", "observedSelectionToAudibleMs", "downloadMs", "decodeMs", "tempoMatchMs"]) {
      assert.ok(Number.isFinite(measurement[field]) && measurement[field] >= 0,
        `${viewport} timing must report a finite ${field}: ${JSON.stringify(measurement)}`);
    }
    assert.ok(measurement.transferBytes > 0,
      `the measurement records the donor response size: ${JSON.stringify(measurement)}`);
    if (Math.abs(expectedRatio - 1) < 0.001) {
      assert.equal(measurement.tempoMatchMs, 0, "native-tempo swaps skip tempo matching");
    } else {
      assert.ok(measurement.tempoMatchMs > 0, "tempo-matched swaps record the matching stage");
    }
    measurement.dominantPreparationStage = Object.entries({
      download: measurement.downloadMs,
      decode: measurement.decodeMs,
      tempoMatch: measurement.tempoMatchMs,
    }).sort((left, right) => right[1] - left[1])[0][0];
    const restore = current.getByTestId("restore-live-swap-vocals");
    await restore.waitFor();
    await restore.click();
    await page.waitForFunction(trackId => {
      const source = window.audioProbe.sources.find(item => item.mediaElement.src.endsWith(`/${trackId}-vocals`));
      return source?.inputNode?.gain?.value > 0.9;
    }, session.currentSessionTrackId);
    return { viewport, networkDelayMs: delayMs, ...measurement };
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
  if (disableBroadcastChannel) {
    assert.ok(await Promise.all([firstPage, secondPage].map(targetPage =>
      targetPage.evaluate(() => typeof BroadcastChannel === "undefined"),
    )).then(results => results.every(Boolean)), "the speed-sync regression uses the storage fallback in both pages");
  }
  await secondPage.waitForFunction(() => [...document.querySelectorAll('[data-role="current"] audio')].length === 4 &&
    [...document.querySelectorAll('[data-role="current"] audio')].every(a => a.readyState === 4));
  await toggle();
  await secondPage.waitForFunction(() => document.querySelector('[data-testid="session-play"]')?.getAttribute("aria-pressed") === "true");
  assert.ok(await secondPage.evaluate(() => [...document.querySelectorAll('[data-role="current"] audio')].every(a => a.paused)),
    "the other tab mirrors playback without starting duplicate audio");
  if (!pitchModesOnly) {
    await firstPage.getByLabel("Seek current track", { exact: true }).press("Home");
    await secondPage.waitForFunction(() => document.querySelector('[aria-label="Seek current track"]')?.value === "0");
    assert.equal(await firstPage.getByTestId("session-play").getAttribute("aria-pressed"), "true",
      "remote seek does not pause the active deck");
  }

  await setSessionRateInPage(firstPage, 1.1);
  await Promise.all([
    waitForSessionRateInPage(firstPage, 1.1, 132),
    waitForSessionRateInPage(secondPage, 1.1, 132),
  ]);
  let speedOwnership = await Promise.all([
    firstPage.evaluate(() => ({
      playing: [...document.querySelectorAll('[data-role="current"] audio')].map(audio => !audio.paused),
      rates: [...document.querySelectorAll('[data-role="current"] audio')].map(audio => audio.playbackRate),
    })),
    secondPage.evaluate(() => ({
      playing: [...document.querySelectorAll('[data-role="current"] audio')].map(audio => !audio.paused),
      rates: [...document.querySelectorAll('[data-role="current"] audio')].map(audio => audio.playbackRate),
    })),
  ]);
  assert.ok(speedOwnership[0].playing.length === 4 && speedOwnership[0].playing.every(Boolean),
    "the active tab keeps all four original stems audible after its speed change");
  assert.ok(speedOwnership[1].playing.length === 4 && speedOwnership[1].playing.every(value => !value),
    "the mirror tab changes speed without starting a second audio engine");
  assert.ok([...speedOwnership[0].rates, ...speedOwnership[1].rates].every(rate => Math.abs(rate - 1.1) < 0.001),
    "both tabs apply the owner-tab speed to every original stem");

  await setSessionRateInPage(secondPage, 0.8);
  try {
    await Promise.all([
      waitForSessionRateInPage(firstPage, 0.8, 96),
      waitForSessionRateInPage(secondPage, 0.8, 96),
    ]);
  } catch (error) {
    const diagnostics = await Promise.all([firstPage, secondPage].map(page => page.evaluate(() => ({
      speed: document.querySelector('[data-testid="session-playback-speed"]')?.getAttribute("aria-valuetext"),
      rates: [...document.querySelectorAll('[data-role="current"] audio')].map(audio => audio.playbackRate),
      messages: window.audioProbe.transportMessages.slice(-12),
    }))));
    console.error("CROSS_TAB_SPEED_DIAGNOSTIC", JSON.stringify(diagnostics));
    throw error;
  }
  speedOwnership = await Promise.all([
    firstPage.evaluate(() => ({
      playing: [...document.querySelectorAll('[data-role="current"] audio')].map(audio => !audio.paused),
      rates: [...document.querySelectorAll('[data-role="current"] audio')].map(audio => audio.playbackRate),
    })),
    secondPage.evaluate(() => ({
      playing: [...document.querySelectorAll('[data-role="current"] audio')].map(audio => !audio.paused),
      rates: [...document.querySelectorAll('[data-role="current"] audio')].map(audio => audio.playbackRate),
    })),
  ]);
  assert.ok(speedOwnership[0].playing.every(Boolean) &&
    speedOwnership[1].playing.every(value => !value),
  "a mirror-tab speed command updates the audible owner without duplicating playback");
  assert.ok([...speedOwnership[0].rates, ...speedOwnership[1].rates].every(rate => Math.abs(rate - 0.8) < 0.001),
    "the requested 0.80× rate reaches every original stem in both tabs");
  if (disableBroadcastChannel) {
    const storageSpeedEvidence = await Promise.all([firstPage, secondPage].map(targetPage =>
      targetPage.evaluate(() => ({
        sent: window.audioProbe.storageTransportMessages
          .filter(message => message.transport?.action === "speed")
          .map(message => message.transport.playbackRate),
        received: window.audioProbe.storageTransportReceives
          .filter(message => message.transport?.action === "speed")
          .map(message => message.transport.playbackRate),
      })),
    ));
    assert.ok(storageSpeedEvidence[0].sent.some(rate => Math.abs(rate - 1.1) < 0.001)
      && storageSpeedEvidence[0].sent.some(rate => Math.abs(rate - 0.8) < 0.001)
      && storageSpeedEvidence[1].sent.some(rate => Math.abs(rate - 0.8) < 0.001),
    `speed commands from both pages must use the storage fallback: ${JSON.stringify(storageSpeedEvidence)}`);
    assert.ok(storageSpeedEvidence[0].received.some(rate => Math.abs(rate - 0.8) < 0.001)
      && storageSpeedEvidence[1].received.some(rate => Math.abs(rate - 1.1) < 0.001),
    `both pages must receive speed changes through storage events: ${JSON.stringify(storageSpeedEvidence)}`);
  }

  const ownerSpeedControl = await firstPage.evaluate(rate =>
    window.audioProbe.transportMessages
      .filter(message => message.transport?.action === "speed" &&
        Math.abs(message.transport.playbackRate - rate) < 0.001 &&
        message.transport.priority === "control")
      .at(-1) ?? null,
  0.8);
  assert.ok(ownerSpeedControl, "the audible owner republishes a mirror-requested speed control");
  const staleHeartbeatId = await firstPage.evaluate(({ control, useStorageFallback }) => {
    const stale = JSON.parse(JSON.stringify(control));
    stale.id = `stale-heartbeat-${crypto.randomUUID()}`;
    stale.transport = {
      ...stale.transport,
      action: "state",
      priority: "heartbeat",
      playbackRate: 1,
      updatedAt: stale.transport.updatedAt - 1,
    };
    if (useStorageFallback) {
      localStorage.setItem("waveyard:queue-change", JSON.stringify(stale));
    } else {
      const channel = new BroadcastChannel("waveyard:queue-sync");
      channel.postMessage(stale);
      channel.close();
    }
    return stale.id;
  }, { control: ownerSpeedControl, useStorageFallback: disableBroadcastChannel });
  if (disableBroadcastChannel) {
    await secondPage.waitForFunction(id =>
      window.audioProbe.storageTransportReceives.some(message => message.id === id),
    staleHeartbeatId);
  } else {
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  await Promise.all([
    waitForSessionRateInPage(firstPage, 0.8, 96),
    waitForSessionRateInPage(secondPage, 0.8, 96),
  ]);
  console.log("PASS: speed changes from either tab update both UIs while only the owner plays; stale heartbeat is ignored");

  if (crossTabSpeedOnly) {
  if (mobileBrowserEmulation) {
    await Promise.all([
      firstPage.setViewportSize({ width: 390, height: 844 }),
      secondPage.setViewportSize({ width: 390, height: 844 }),
    ]);
    for (const targetPage of [firstPage, secondPage]) {
      const layout = await targetPage.evaluate(() => ({
        viewport: innerWidth,
        documentWidth: document.documentElement.scrollWidth,
        speedVisible: (() => {
          const bounds = document.querySelector('[data-testid="session-playback-speed"]')?.getBoundingClientRect();
          return Boolean(bounds && bounds.left >= 0 && bounds.right <= innerWidth);
        })(),
        pitchStatus: document.querySelector('[data-testid="session-playback-speed"]')?.getAttribute("aria-valuetext"),
      }));
      assert.ok(layout.documentWidth <= layout.viewport && layout.speedVisible,
        `speed and pitch status remain reachable on a phone-sized viewport: ${JSON.stringify(layout)}`);
      assert.match(layout.pitchStatus ?? "", /pitch preserved|pitch follows speed|pitch mode unavailable/);
    }
    console.log("MOBILE_LAYOUT", JSON.stringify({ width: 390, height: 844, tabs: 2 }));
  }
  await page.getByText(/^Session order · /).click();
  await page.getByRole("button", { name: "Move Test b earlier", exact: true }).click();
  await page.waitForFunction(() =>
    document.querySelector('[data-testid="session-transition"]')?.getAttribute("title")?.includes("Test b"),
  );
  await page.getByTestId("session-transition").click();
  await page.getByRole("button", { name: "Finish", exact: true }).click();
  await Promise.all([
    page.locator('[data-role="current"]').getByRole("heading", { name: "Test b", exact: true }).waitFor(),
    secondPage.locator('[data-role="current"]').getByRole("heading", { name: "Test b", exact: true }).waitFor(),
  ]);
  await Promise.all([
    waitForSessionRateInPage(page, 0.8, 99),
    waitForSessionRateInPage(secondPage, 0.8, 99),
  ]);
  await page.getByRole("button", { name: "Previous track", exact: true }).click();
  await Promise.all([
    page.locator('[data-role="current"]').getByRole("heading", { name: "Test a", exact: true }).waitFor(),
    secondPage.locator('[data-role="current"]').getByRole("heading", { name: "Test a", exact: true }).waitFor(),
  ]);
  await Promise.all([
    waitForSessionRateInPage(page, 0.8, 96),
    waitForSessionRateInPage(secondPage, 0.8, 96),
  ]);
  await setSessionRateInPage(page, 1);
  await Promise.all([
    waitForSessionRateInPage(page, 1, 120),
    waitForSessionRateInPage(secondPage, 1, 120),
  ]);
  const donorBuffersBeforeSpeed = await page.evaluate(() => window.audioProbe.buffers.length);
  await current.getByTestId(mobileBrowserEmulation
    ? "quick-open-live-swap-vocals"
    : "open-live-swap-vocals").click();
  const speedDonor = current.getByTestId("live-swap-candidate-vocals-c");
  await speedDonor.waitFor();
  await speedDonor.click();
  await page.waitForFunction((baseline) => window.audioProbe.buffers.slice(baseline)
    .some(source => source.buffer && Math.abs(source.buffer.duration - 12) < 0.05), donorBuffersBeforeSpeed);
  await setSessionRateInPage(secondPage, 0.9);
  await Promise.all([
    waitForSessionRateInPage(page, 0.9, 108),
    waitForSessionRateInPage(secondPage, 0.9, 108),
    page.waitForFunction((baseline) => window.audioProbe.buffers.slice(baseline)
      .some(source => source.buffer && Math.abs(source.buffer.duration - 12) < 0.05
        && Math.abs(source.playbackRate.value - 0.9) < 0.001), donorBuffersBeforeSpeed),
  ]);
  const donorRateOwnership = await Promise.all([
    page.evaluate(() => ({
      playing: [...document.querySelectorAll('[data-role="current"] audio')].map(audio => !audio.paused),
      rates: [...document.querySelectorAll('[data-role="current"] audio')].map(audio => audio.playbackRate),
    })),
    secondPage.evaluate(() => ({
      playing: [...document.querySelectorAll('[data-role="current"] audio')].map(audio => !audio.paused),
      rates: [...document.querySelectorAll('[data-role="current"] audio')].map(audio => audio.playbackRate),
    })),
  ]);
  assert.ok(donorRateOwnership[0].playing.some(Boolean) &&
    donorRateOwnership[1].playing.every(value => !value),
  "speed changes reach the live donor without starting playback in the mirror tab");
  assert.ok([...donorRateOwnership[0].rates, ...donorRateOwnership[1].rates]
    .every(rate => Math.abs(rate - 0.9) < 0.001),
  "the live donor and original media stems share the same synchronized playback rate");
  const donorAlignmentAfterRemoteSpeed = await page.evaluate(baseline => {
    const donor = [...window.audioProbe.buffers.slice(baseline)].reverse()
      .find(source => source.buffer && !source.stopped);
    const media = document.querySelector('[data-role="current"] audio');
    if (!donor || !media || !Number.isFinite(donor.startedContextTime)) return null;
    const duration = donor.buffer.duration;
    const expected = ((donor.startedOffset
      + Math.max(0, donor.context.currentTime - donor.startedContextTime) * donor.playbackRate.value) % duration
      + duration) % duration;
    const actual = media.currentTime % duration;
    const direct = Math.abs(expected - actual);
    return {
      errorSeconds: Math.min(direct, duration - direct),
      donorRate: donor.playbackRate.value,
      recipientRate: media.playbackRate,
      recipientTime: media.currentTime,
      donorDuration: duration,
    };
  }, donorBuffersBeforeSpeed);
  assert.ok(donorAlignmentAfterRemoteSpeed && donorAlignmentAfterRemoteSpeed.errorSeconds < 0.3,
    `the active donor stays aligned after the other tab changes speed: ${JSON.stringify(donorAlignmentAfterRemoteSpeed)}`);
  await setSessionRateInPage(secondPage, 1);
  await Promise.all([
    waitForSessionRateInPage(page, 1, 120),
    waitForSessionRateInPage(secondPage, 1, 120),
    page.waitForFunction((baseline) => window.audioProbe.buffers.slice(baseline)
      .some(source => source.buffer && Math.abs(source.buffer.duration - 12) < 0.05
        && Math.abs(source.playbackRate.value - 1) < 0.001), donorBuffersBeforeSpeed),
  ]);
  await current.getByTestId("restore-live-swap-vocals").click();
  await page.waitForFunction(() => !document.querySelector('[data-testid="restore-live-swap-vocals"]'));
  console.log("PASS: mirror-tab speed updates original stems and live donors without duplicate audio");
  await browser.close();
  process.exit(0);
  } else {
    await setSessionRateInPage(secondPage, 1);
    await Promise.all([
      waitForSessionRateInPage(page, 1, 120),
      waitForSessionRateInPage(secondPage, 1, 120),
    ]);
  }
  if (pitchModesOnly) await secondPage.close();

  if (!pitchModesOnly) {
  const quickVocalsPad = current.getByTestId("quick-isolate-vocals");
  await quickVocalsPad.waitFor();
  await quickVocalsPad.click();
  await page.waitForFunction(() => {
    const gain = type => window.audioProbe.currentStemGain(type);
    return document.querySelector('[data-testid="quick-isolate-vocals"]')?.getAttribute("aria-pressed") === "true" &&
      gain("vocals") > 0.9 && ["drums", "bass", "other"].every(type => gain(type) < 0.01);
  });
  await current.getByTestId("quick-restore-mix").click();
  await page.waitForFunction(() => {
    const gain = type => window.audioProbe.currentStemGain(type);
    return document.querySelector('[data-testid="quick-isolate-vocals"]')?.getAttribute("aria-pressed") === "false" &&
      ["vocals", "drums", "bass", "other"].every(type => gain(type) > 0.9);
  });
  console.log("PASS: desktop stem pads isolate and restore the live audio mix");
  const desktopSwapEntry = current.getByTestId("quick-open-live-swap-vocals");
  await desktopSwapEntry.click();
  await current.getByTestId("live-swap-picker-vocals").waitFor();
  assert.equal(await desktopSwapEntry.getAttribute("aria-expanded"), "true");
  await current.getByRole("button", { name: "Close source picker", exact: true }).click();
  await page.waitForFunction(() => !document.querySelector('[data-testid="live-swap-picker-vocals"]'));
  assert.equal(await desktopSwapEntry.getAttribute("aria-expanded"), "false");
  console.log("PASS: desktop stem pad opens and closes its live source picker");

  await current.getByLabel("Isolate vocals", { exact: true }).click();
  await page.waitForFunction(() => {
    const get = type => window.audioProbe.currentStemGain(type);
    return get("vocals") > 0.9 && ["drums", "bass", "other"].every(type => get(type) < 0.01);
  });
  await current.getByLabel("Isolate vocals", { exact: true }).click();
  await page.waitForFunction(() => ["vocals", "drums", "bass", "other"].every(type =>
    window.audioProbe.currentStemGain(type) > 0.9));
  await current.getByLabel("Mute drums", { exact: true }).click();
  await page.waitForFunction(() => {
    const get = type => window.audioProbe.currentStemGain(type);
    return get("drums") < 0.01 && ["vocals", "bass", "other"].every(type => get(type) > 0.9);
  });
  await current.getByLabel("Restore all current stems", { exact: true }).click();
  await page.waitForFunction(() => ["vocals", "drums", "bass", "other"].every(type =>
    window.audioProbe.currentStemGain(type) > 0.9));

  const beatSnapSaved = page.waitForResponse(response => {
    const request = response.request();
    if (request.method() !== "PATCH" || !new URL(request.url()).pathname.endsWith("/tracks/a")) return false;
    try {
      return JSON.parse(request.postData() ?? "{}").transition?.performance?.snap === "beat";
    } catch {
      return false;
    }
  });
  await current.getByLabel("Snap stem changes").selectOption("beat");
  const beatSnapResponse = await beatSnapSaved;
  assert.ok(beatSnapResponse.ok(), `the beat-snap edit request succeeds (${beatSnapResponse.status()})`);
  assert.equal(session.tracks.find(item => item.id === "a").transition.performance.snap, "beat",
    "the per-track performance snap setting persists through the session edit route");
  const barSnapOptions = await current.locator('option[value="bar"]').evaluateAll(options =>
    options.map(option => ({ disabled: option.disabled, html: option.outerHTML, deck: option.closest("[data-role]")?.getAttribute("data-role") })));
  assert.ok(barSnapOptions.length > 0 && barSnapOptions.every(option => option.disabled && option.html.includes("Bar unavailable")),
    `bar snap is unavailable when the current analysis has no downbeat evidence: ${JSON.stringify(barSnapOptions)}`);
  const mixBeforeHold = structuredClone(session.tracks.find(item => item.id === "a").stemMix);
  await current.getByLabel("Hold to isolate vocals").focus();
  await page.keyboard.down("Space");
  await page.waitForFunction(() => {
    const gain = type => window.audioProbe.currentStemGain(type);
    return gain("vocals") > 0.9 && ["drums", "bass", "other"].every(type => gain(type) < 0.01);
  });
  await page.waitForTimeout(700);
  assert.deepEqual(session.tracks.find(item => item.id === "a").stemMix, mixBeforeHold,
    "momentary isolation never writes a temporary mix to the session");
  await page.keyboard.up("Space");
  await page.waitForFunction(() => ["vocals", "drums", "bass", "other"].every(type =>
    window.audioProbe.currentStemGain(type) > 0.9), null, { timeout: 3000 });

  await firstPage.bringToFront();
  if (await page.getByTestId("session-play").getAttribute("aria-pressed") !== "true") await toggle();
  // The deterministic fixture has a finite 20s beat grid. Earlier E2E steps
  // may consume it, so anchor this scheduling assertion at a known future beat.
  await firstPage.getByLabel("Seek current track", { exact: true }).press("Home");
  await firstPage.waitForFunction(() => document.querySelector('[aria-label="Seek current track"]')?.value === "0");
  await firstPage.waitForFunction(() => {
    const audio = document.querySelector('[data-role="current"] audio');
    return audio && !audio.paused && audio.currentTime < 1;
  });
  await current.getByLabel("Mute drums", { exact: true }).click();
  // The deterministic performanceTick unit test verifies the pre-boundary
  // wait. The wide synthetic grid gives the browser four seconds to apply the
  // actual audio-graph change without racing a sub-second boundary under load.
  await page.waitForFunction(() => {
    return window.audioProbe.currentStemGain("drums") < 0.01;
  }, null, { timeout: 6000 }).catch(async error => {
    const diagnostic = await page.evaluate(() => {
      const audio = document.querySelector('[data-role="current"] audio[data-waveyard-fixture-src$="/a-drums"]');
      return {
        playing: document.querySelector('[data-testid="session-play"]')?.getAttribute("aria-pressed"),
        mutePressed: document.querySelector('[aria-label="Mute drums"]')?.getAttribute("aria-pressed"),
        visibility: document.visibilityState,
        focused: document.hasFocus(),
        audio: audio ? { paused: audio.paused, readyState: audio.readyState, currentTime: audio.currentTime } : null,
        sources: window.audioProbe.sources
          .filter(source => source.mediaElement.src.endsWith("/a-drums"))
          .map(source => ({
            isCurrent: source.mediaElement === audio,
            paused: source.mediaElement.paused,
            gain: source.inputNode?.nextNode?.gain?.value,
          })),
        status: document.querySelector('[data-testid="session-status"]')?.textContent,
      };
    });
    console.log("LIVE_MUTE_DIAGNOSTIC", JSON.stringify(diagnostic));
    throw error;
  });
  await current.getByLabel("Restore all current stems").click();
  await page.waitForFunction(() => ["vocals", "drums", "bass", "other"].every(type =>
    window.audioProbe.currentStemGain(type) > 0.9));
  await toggle();

  if (await current.locator('audio[data-waveyard-fixture-src$="/a-vocals"]').evaluate(audio => audio.paused)) await toggle();
  const playbackBeforePreparingDonor = await current.locator('audio[data-waveyard-fixture-src$="/a-vocals"]').evaluate(audio => audio.currentTime);
  await current.getByTestId("open-live-swap-vocals").click();
  await current.getByTestId(`prepare-live-swap-vocals-${preparationDonorId}`).click();
  await current.getByTestId(`live-swap-preparing-vocals-${preparationDonorId}`).waitFor();
  assert.equal(preparationStartRequests, 1, "the live-swap picker starts separation for a library source in place");
  await page.waitForFunction(before => {
    const audio = document.querySelector('[data-role="current"] audio[data-waveyard-fixture-src$="/a-vocals"]');
    return audio instanceof HTMLAudioElement && !audio.paused && audio.currentTime > before + 0.2;
  }, playbackBeforePreparingDonor, { timeout: 5_000 });
  assert.equal(session.swaps.length, 0, "preparing a donor does not change the active live swap");
  const playbackBeforeRetry = await current.locator('audio[data-waveyard-fixture-src$="/a-vocals"]').evaluate(audio => audio.currentTime);
  await current.getByTestId(`prepare-live-swap-vocals-${retryDonorId}`).click();
  await current.getByTestId(`live-swap-preparing-vocals-${retryDonorId}`).waitFor();
  assert.equal(preparationRetryRequests, 1, "the live-swap picker retries failed source separation in place");
  await page.waitForFunction(before => {
    const audio = document.querySelector('[data-role="current"] audio[data-waveyard-fixture-src$="/a-vocals"]');
    return audio instanceof HTMLAudioElement && !audio.paused && audio.currentTime > before + 0.2;
  }, playbackBeforeRetry, { timeout: 5_000 });
  console.log("PASS: separation start and retry stay in the live-swap picker without interrupting the current mix");

  let slowDonorRequestStarted = false;
  let releaseSlowSwapSave;
  const slowSwapSaveGate = new Promise(resolve => { releaseSlowSwapSave = resolve; });
  let signalSlowSwapSaveStarted;
  const slowSwapSaveStarted = new Promise(resolve => { signalSlowSwapSaveStarted = resolve; });
  let releaseSlowDonor;
  const slowDonorGate = new Promise(resolve => { releaseSlowDonor = resolve; });
  let finishSlowDonorRoute;
  const slowDonorRouteFinished = new Promise(resolve => { finishSlowDonorRoute = resolve; });
  heldAssetId = "b-vocals";
  liveSwapRequestOrder.length = 0;
  heldAssetGate = slowDonorGate;
  pendingSwapSaveGate = slowSwapSaveGate;
  signalPendingSwapSaveStarted = signalSlowSwapSaveStarted;
  signalHeldAssetRequest = () => {
    slowDonorRequestStarted = true;
  };
  signalHeldAssetRouteFinished = finishSlowDonorRoute;
  await current.getByTestId("seek-deck-0").fill("0");
  if (await current.locator("audio").first().evaluate(audio => audio.paused)) await toggle();
  const playbackBeforeCancel = await current.locator('audio[data-waveyard-fixture-src$="/a-vocals"]').evaluate(audio => audio.currentTime);
  const buffersBeforeCancel = await page.evaluate(() => window.audioProbe.buffers.length);
  const slowSwapPicker = current.getByTestId("live-swap-picker-vocals");
  if (!(await slowSwapPicker.count())) await current.getByTestId("open-live-swap-vocals").click();
  await slowSwapPicker.waitFor();
  const donorBOption = current.getByTestId("live-swap-candidate-vocals-b");
  const donorCOption = current.getByTestId("live-swap-candidate-vocals-c");
  const donorBLabel = await donorBOption.innerText();
  const donorCLabel = await donorCOption.innerText();
  assert.match(donorBLabel, /BPM match[\s\S]*Key match/,
    `the swap picker shows compatible BPM/key cues: ${donorBLabel}`);
  assert.match(donorCLabel, /BPM match[\s\S]*Key differs/,
    `the picker distinguishes a key mismatch from a tempo match: ${donorCLabel}`);
  // Playback/seek activity may save session state too; assert that selecting
  // the donor starts both its save request and its audio preparation.
  liveSwapRequestOrder.length = 0;
  await donorBOption.click();
  const pendingSlowSwap = page.getByTestId("live-swap-pending-vocals");
  await pendingSlowSwap.waitFor();
  assert.match(await pendingSlowSwap.innerText(), /Saving vocals source/,
    "the cancel action must appear while the donor selection is still being saved");
  await waitForSignal(slowSwapSaveStarted, "the held live stem save request");
  const cancelSlowSwap = page.locator('[data-testid^="cancel-live-stem-swap-"]').first();
  assert.equal(await cancelSlowSwap.isDisabled(), false, "a pending save must remain cancellable");
  await cancelSlowSwap.click();
  await page.waitForFunction(() =>
    document.querySelector('[data-testid="live-swap-pending-vocals"]')?.textContent?.includes("Stopping vocals switch"),
  );
  assert.match(await pendingSlowSwap.innerText(), /Stopping vocals switch/,
    "the UI acknowledges cancellation while the save response is still held");
  assert.ok(liveSwapRequestOrder.includes("save"), "the donor choice should be saved");
  releaseSlowSwapSave();
  pendingSwapSaveGate = null;
  signalPendingSwapSaveStarted = null;
  await page.getByTestId("session-status").filter({ hasText: /vocals switch cancelled/i }).waitFor();
  await page.waitForFunction(before => {
    const audio = document.querySelector('[data-role="current"] audio[data-waveyard-fixture-src$="/a-vocals"]');
    return audio instanceof HTMLAudioElement && !audio.paused && audio.currentTime > before + 0.25;
  }, playbackBeforeCancel, { timeout: 5_000 });
  assert.ok(Math.abs(await page.evaluate(() =>
    window.audioProbe.sources.find(source => source.mediaElement.src.endsWith("/a-vocals"))?.inputNode?.gain.value ?? 0,
  ) - 1) < 0.01, "the original vocal layer remains audible while the donor is slow");
  const playbackAtCancel = await current.locator('audio[data-waveyard-fixture-src$="/a-vocals"]').evaluate(audio => audio.currentTime);
  await page.waitForFunction(before => {
    const audio = document.querySelector('[data-role="current"] audio[data-waveyard-fixture-src$="/a-vocals"]');
    return audio instanceof HTMLAudioElement && !audio.paused && audio.currentTime > before + 0.2;
  }, playbackAtCancel, { timeout: 5_000 });
  assert.equal(await current.getByTestId("restore-live-swap-vocals").count(), 0,
    "cancelling a pending donor leaves the original source selected");
  assert.equal(session.swaps.length, 0, "cancelling removes the pending persisted swap");
  assert.equal(await page.evaluate(() => window.audioProbe.buffers.length), buffersBeforeCancel,
    "a cancelled donor is never decoded into a playing layer");
  if (await current.locator("audio").first().evaluate(audio => !audio.paused)) await toggle();
  heldAssetId = null;
  heldAssetGate = null;
  pendingSwapSaveGate = null;
  signalPendingSwapSaveStarted = null;
  signalHeldAssetRequest = null;
  releaseSlowDonor();
  if (slowDonorRequestStarted) await waitForSignal(slowDonorRouteFinished, "the live stem donor response");
  signalHeldAssetRouteFinished = null;

  assert.equal(session.currentSessionTrackId, "a", "timing comparisons use the same recipient track");
  session.positionSeconds = 0;
  session.swaps = [];
  await page.goto(`http://localhost:80/waveyard/session/${sessionId}`);
  await page.waitForFunction(() => {
    const audio = [...document.querySelectorAll('[data-role="current"] audio')];
    return audio.length === 4 && audio.every(element =>
      element.readyState === 4 && new URL(element.src).pathname.includes("/a-"),
    );
  }, { timeout: 10_000 });
  current = page.locator('[data-role="current"]');
  if (await current.locator("audio").first().evaluate(audio => audio.paused)) await toggle();
  await page.evaluate(() => { window.liveStemAssetFetchTrace.length = 0; });
  const buffersBeforeWarm = await page.evaluate(() => window.audioProbe.buffers.length);
  const warmedDonorResponse = page.waitForResponse(response =>
    new URL(response.url()).pathname === "/api/assets/c-vocals" && response.ok(),
  );
  await current.getByTestId("open-live-swap-vocals").click();
  const warmedDonor = current.getByTestId("live-swap-candidate-vocals-c");
  await warmedDonor.waitFor();
  await warmedDonor.hover();
  await warmedDonorResponse;
  assert.equal(await page.evaluate(() =>
    window.liveStemAssetFetchTrace.filter(path => path === "/api/assets/c-vocals").length,
  ), 1, "focusing or deliberately hovering a donor starts one bounded warm request");
  assert.equal(await page.evaluate(() => window.audioProbe.buffers.length), buffersBeforeWarm,
    "warming a donor never makes it audible before the user chooses it");
  assert.ok(await current.locator('audio[data-waveyard-fixture-src$="/a-vocals"]').evaluate(audio => !audio.paused),
    "the current mix remains playing while the donor warms");
  const timingCountBeforeWarmSwap = await page.evaluate(() => window.liveStemTimings.length);
  await warmedDonor.click();
  await page.waitForFunction((baseline) => window.audioProbe.buffers.length > baseline, buffersBeforeWarm);
  await page.waitForFunction((baseline) => window.liveStemTimings.length > baseline, timingCountBeforeWarmSwap);
  assert.equal(await page.evaluate(() =>
    window.liveStemAssetFetchTrace.filter(path => path === "/api/assets/c-vocals").length,
  ), 1, "selecting the warmed donor reuses its in-flight or decoded buffer");
  if (crossTabSpeedOnly) {
    await browser.close();
    process.exit(0);
  }
  console.log("PASS: focusing or hovering warms one donor silently, then reuses it for the live swap");

  session.positionSeconds = 0;
  session.swaps = [];
  const desktopNativeTiming = await measureLiveStemSwap("c", 1, 0, "desktop");
  const desktopTempoTiming = await measureLiveStemSwap("b", 124 / 120, 0, "desktop");
  const slowNetworkInjectedDelayMs = 450;
  const desktopSlowNetworkTiming = await measureLiveStemSwap("d", 1, slowNetworkInjectedDelayMs, "desktop");
  assert.ok(desktopSlowNetworkTiming.downloadMs >= slowNetworkInjectedDelayMs,
    `the download measurement must include the deliberately delayed response: ${JSON.stringify({
      injectedDelayMs: slowNetworkInjectedDelayMs,
      measuredDownloadMs: desktopSlowNetworkTiming.downloadMs,
    })}`);
  console.log("LIVE_STEM_SWAP_TIMINGS", JSON.stringify({
    desktop: {
      nativeTempo: desktopNativeTiming,
      tempoMatched: desktopTempoTiming,
      deliberatelySlowNetwork: desktopSlowNetworkTiming,
      injectedNetworkDelayMs: slowNetworkInjectedDelayMs,
    },
  }));
  }

  if (pitchModesOnly) {
    const pitchFixtureOrder = engineName === "webkit" ? ["c", "b", "a"] : ["a", "b", "c"];
    session.tracks = pitchFixtureOrder.map((id, position) => {
      const item = pitchAcceptanceTrackSnapshot.find(track => track.id === id);
      assert.ok(item, `pitch acceptance includes donor/recipient track ${id}`);
      return {
        ...structuredClone(item),
        position,
        transition: { ...item.transition, crossfadeSeconds: 0 },
      };
    });
    session.currentSessionTrackId = "a";
    session.positionSeconds = 0;
    session.swaps = [];
    ignoreSessionStateWrites = true;
    for (const otherPage of context.pages()) {
      if (otherPage !== page) await otherPage.close();
    }
    await context.addInitScript(() => {
      localStorage.removeItem("waveyard:queue-change");
      localStorage.setItem("waveyard:auto-crossfade", "off");
    });
    await page.evaluate(() => {
      localStorage.setItem("waveyard:auto-crossfade", "off");
      localStorage.removeItem("waveyard:queue-change");
    });
    await page.goto(`http://localhost:80/waveyard/session/${sessionId}`);
    const pitchFixtureLoaded = await page.waitForFunction(() => {
      const audio = [...document.querySelectorAll('[data-role="current"] audio')];
      return audio.length === 4 && audio.every(element =>
      element.readyState === 4
        && (element.dataset.waveyardFixtureSrc ?? element.currentSrc).includes("/api/assets/a-"),
      );
    }, undefined, { timeout: 5_000 }).then(() => true, () => false);
    if (!pitchFixtureLoaded) {
      console.log("PITCH_FIXTURE_LOAD_DIAGNOSTIC", JSON.stringify(await page.evaluate(() => ({
        currentTitle: document.querySelector('[data-role="current"] h3')?.textContent,
        audio: [...document.querySelectorAll('[data-role="current"] audio')].map(element => ({
          fixtureSrc: element.dataset.waveyardFixtureSrc,
          src: element.src,
          currentSrc: element.currentSrc,
          readyState: element.readyState,
          paused: element.paused,
        })),
        pageUrl: location.href,
      }))));
    }
    assert.equal(pitchFixtureLoaded, true, "the mobile pitch fixture loads four ready source stems");
    await page.evaluate(() => localStorage.removeItem("waveyard:queue-change"));
    const pitchFixtureLoad = await page.evaluate(() => ({
      current: [...document.querySelectorAll('[data-role="current"] audio')].map(element =>
        element.dataset.waveyardFixtureSrc ?? element.currentSrc),
      playing: [...document.querySelectorAll('[data-role="current"] audio')].some(element => !element.paused),
    }));
    assert.equal(pitchFixtureLoad.current.length, 4);
    assert.ok(pitchFixtureLoad.current.every(src => src?.includes("/api/assets/a-")),
      `pitch acceptance starts on the intended original track: ${JSON.stringify(pitchFixtureLoad)}`);
    assert.equal(pitchFixtureLoad.playing, false,
      `pitch acceptance starts from a paused fixture: ${JSON.stringify(pitchFixtureLoad)}`);
    current = page.locator('[data-role="current"]');
  }
  const currentTrackIdForTempoTest = session.currentSessionTrackId ?? "a";
  const tempoCurrentTrack = tracks.find(item => item.id === currentTrackIdForTempoTest) ?? tracks[0];
  const tempoDonor = tracks.find(item => item.id !== tempoCurrentTrack.id && item.id === (tempoCurrentTrack.id === "b" ? "a" : "b")) ?? tracks[1];
  if (await current.locator("audio").first().evaluate(audio => !audio.paused)) await toggle();
  const seek = current.getByTestId("seek-deck-0");
  const initialSeekSeconds = Math.min(6, tempoCurrentTrack.track.durationSeconds * 0.5);
  const followSeekSeconds = Math.min(11, tempoCurrentTrack.track.durationSeconds * 0.3);
  await seek.fill("0");
  await chooseLiveSource("vocals", tempoDonor.id);
  const buffersBeforeTempoSwap = await page.evaluate(() => window.audioProbe.buffers.length);
  await page.waitForFunction(() =>
    document.querySelector('[data-testid="live-stem-tempo-vocals"]')?.textContent === "Tempo matched · pitch preserved",
  );
  await toggle();
  await page.waitForFunction(before => window.audioProbe.buffers.length > before, buffersBeforeTempoSwap);
  await page.waitForTimeout(250);
  const tempoMatchedDonorDuration = await page.evaluate(() => window.audioProbe.buffers.at(-1).buffer.duration);
  const expectedTempoMatchedDuration = tempoDonor.track.durationSeconds *
    (tempoDonor.analysis.bpm / tempoCurrentTrack.analysis.bpm);
  assert.ok(Math.abs(tempoMatchedDonorDuration - expectedTempoMatchedDuration) < 0.08,
    `the donor is pitch-preservingly matched to the recipient: ${tempoMatchedDonorDuration}`);
  assert.equal(await current.getByTestId("live-stem-tempo-vocals").innerText(),
    "Tempo matched · pitch preserved", "the UI confirms tempo sync only after preparation succeeds");
  await toggle();
  await seek.fill(String(initialSeekSeconds));
  await page.waitForTimeout(150);
  const paused = await current.locator("audio").evaluateAll(elements => elements.map(e => ({ time: e.currentTime, ready: e.readyState, duration: e.duration, paused: e.paused,
    seekable: Array.from({ length: e.seekable.length }, (_, i) => [e.seekable.start(i), e.seekable.end(i)]) })));
  assert.ok(paused.every(e => Math.abs(e.time - initialSeekSeconds) < 0.1),
    `recipient media must seek, not only the slider: target=${initialSeekSeconds} actual=${JSON.stringify(paused)}`);
  await toggle();
  const resumed = await page.evaluate(() => ({
    offset: window.audioProbe.buffers.at(-1).startedOffset,
    recipientTimeAtStart: window.audioProbe.buffers.at(-1).recipientTimeAtStart,
    duration: window.audioProbe.buffers.at(-1).buffer.duration,
    paused: document.querySelector('[data-role="current"] audio')?.paused,
  }));
  const resumedOffsetError = Math.abs(resumed.offset - ((resumed.recipientTimeAtStart ?? 0) % resumed.duration));
  assert.ok(Number.isFinite(resumed.recipientTimeAtStart) && resumedOffsetError < 0.15,
    `donor resumes from the recipient's live clock: ${JSON.stringify(resumed)}`);

  const pitchLockButton = current.getByTestId("session-pitch-lock");
  await page.setViewportSize({ width: 390, height: 844 });
  if (mobileBrowserEmulation && await pitchLockButton.count() === 0) {
    const unsupportedPitchState = await page.evaluate(() => ({
      sliderText: document.querySelector('[data-testid="session-playback-speed"]')?.getAttribute("aria-valuetext"),
      notice: [...document.querySelectorAll(".wy-session-speed small")].map(node => node.textContent?.trim()),
      pitchControlCount: document.querySelectorAll('[data-testid="session-pitch-lock"]').length,
    }));
    assert.match(unsupportedPitchState.sliderText ?? "", /pitch mode unavailable/);
    assert.ok(unsupportedPitchState.notice.some(text => text?.includes("pitch control unavailable in this browser")),
      `unsupported pitch lock must be clearly identified: ${JSON.stringify(unsupportedPitchState)}`);
    assert.equal(unsupportedPitchState.pitchControlCount, 0,
      "unsupported pitch lock is not presented as an enabled mode switch");
    console.log("UNSUPPORTED_PITCH_MODE", JSON.stringify({
      engine: engineName,
      browserVersion: browser.version(),
      details: unsupportedPitchState,
    }));
    if (pitchModesOnly) {
      await browser.close();
      process.exit(0);
    }
  }
  assert.equal(await pitchLockButton.isVisible(), true,
    "the pitch-lock control must remain reachable in the mobile session layout");
  const mobilePitchBounds = await pitchLockButton.boundingBox();
  assert.ok(mobilePitchBounds && mobilePitchBounds.x >= 0 && mobilePitchBounds.x + mobilePitchBounds.width <= 390,
    `the pitch-lock control must fit the mobile viewport: ${JSON.stringify(mobilePitchBounds)}`);
  const workletsBeforePitchLock = await page.evaluate(() => window.audioProbe.worklets.length);
  const speedSlider = current.getByTestId("session-playback-speed");
  const setPlaybackRate = async rate => {
    await speedSlider.evaluate((element, value) => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set;
      setter.call(element, String(value));
      element.dispatchEvent(new Event("input", { bubbles: true }));
      element.dispatchEvent(new Event("change", { bubbles: true }));
    }, rate);
    try {
      await page.waitForFunction(value =>
        document.querySelector('[data-testid="session-speed-value"]')?.textContent === `${Number(value).toFixed(2)}×`,
      rate, { timeout: 5000 });
    } catch (error) {
      console.error("PITCH_SPEED_CONTROL_STATE", JSON.stringify(await speedSlider.evaluate(element => ({
        value: element.value,
        min: element.min,
        max: element.max,
        disabled: element.disabled,
        output: document.querySelector('[data-testid="session-speed-value"]')?.textContent,
        ariaValueText: element.getAttribute("aria-valuetext"),
      }))));
      throw error;
    }
  };
  await setPlaybackRate(1.1);
  const pitchMetersCreated = await page.evaluate(trackId => {
    const originalMedia = [...document.querySelectorAll('[data-role="current"] audio')]
      .find(media => (media.dataset.waveyardFixtureSrc ?? media.currentSrc).endsWith(`/${trackId}-drums`));
    const original = window.audioProbe.sources.find(source => source.mediaElement === originalMedia);
    const donor = [...window.audioProbe.buffers].reverse().find(node =>
      node.context === original?.context && node.buffer
      && (node.stopCount ?? 0) === 0 && (node.inputNode?.gain?.value ?? 0) > 0.03);
    if (!original || !donor?.buffer) return false;
    const context = original.context;
    const originalAnalyser = context.createAnalyser();
    originalAnalyser.fftSize = 16_384;
    const donorAnalyser = context.createAnalyser();
    donorAnalyser.fftSize = 16_384;
    const outputAnalyser = context.createAnalyser();
    outputAnalyser.fftSize = 2_048;
    const originalInput = original.inputNode;
    original.connect(originalAnalyser);
    original.inputNode = originalInput;
    const donorInput = donor.inputNode;
    const deckIndex = originalMedia.closest('[data-testid="session-deck-b"]') ? 1 : 0;
    const master = window.audioProbe.masterGains.find(node =>
      node.context === context && node.probeDeckIndex === deckIndex);
    if (!master) return false;
    const masterNext = master.nextNode;
    master.connect(outputAnalyser);
    master.nextNode = masterNext;
    window.pitchMeters = {
      originalAnalyser, donorAnalyser, outputAnalyser, context,
      originalMedia, donorSource: null, deckIndex,
      donorDuration: donor.buffer.duration,
      donorChannelCount: donor.buffer.numberOfChannels,
      donorChannel: donorInput?.nextNode,
    };
    window.attachPitchDonorAnalyser = () => {
      const candidates = [...window.audioProbe.workletLoads].reverse()
        .map(load => load.node)
        .find(node => node.context === context && node.probeName === "waveyard-live-stem");
      if (!candidates) {
        return {
          attached: false,
          targetContext: context.state,
          worklets: window.audioProbe.worklets.map(node => ({
            name: node.probeName,
            context: node.context.state,
          })),
          loads: window.audioProbe.workletLoads.map(load => ({
            name: load.node?.probeName,
            context: load.context?.state,
            duration: load.duration,
            pitchPreserving: load.pitchPreserving,
          })),
          media: [...document.querySelectorAll("audio")].map(media => ({
            id: media.dataset.waveyardFixtureSrc ?? media.currentSrc,
            role: media.closest('[data-role="current"]') ? "current" : "next",
            deck: media.closest('[data-testid^="session-deck-"]')?.getAttribute("data-testid"),
            context: window.audioProbe.sources.find(source => source.mediaElement === media)?.context.state,
            time: media.currentTime,
            paused: media.paused,
          })),
          buffers: window.audioProbe.buffers.map(node => ({
            duration: node.buffer?.duration,
            context: node.context.state,
            stopped: node.stopCount ?? 0,
            startedOffset: node.startedOffset,
            recipientTime: node.recipientTimeAtStart,
            gain: node.inputNode?.gain?.value,
          })),
          restoredSwapVisible: Boolean(document.querySelector('[data-testid="restore-live-swap-vocals"]')),
        };
      }
      const worklet = candidates;
      if (window.pitchMeters.donorSource !== worklet) {
        worklet.connect(donorAnalyser);
        window.pitchMeters.donorSource = worklet;
      }
      return { attached: true, name: worklet.probeName, context: worklet.context.state };
    };
    window.readPitchMeters = () => {
      const estimate = analyser => {
        const data = new Float32Array(analyser.fftSize);
        analyser.getFloatTimeDomainData(data);
        const crossings = [];
        for (let index = 1; index < data.length; index += 1) {
          const previous = data[index - 1], current = data[index];
          if (previous <= 0 && current > 0) {
            crossings.push(index - 1 + (-previous / (current - previous)));
          }
        }
        if (crossings.length < 2) return 0;
        return context.sampleRate * (crossings.length - 1) / (crossings.at(-1) - crossings[0]);
      };
      return {
        originalHz: estimate(originalAnalyser),
        donorHz: estimate(donorAnalyser),
      };
    };
    window.startPitchOutputSampling = () => {
      window.pitchOutputSamples = [];
      const data = new Float32Array(outputAnalyser.fftSize);
      window.pitchOutputTimer = setInterval(() => {
        outputAnalyser.getFloatTimeDomainData(data);
        let sum = 0;
        for (const sample of data) sum += sample * sample;
        window.pitchOutputSamples.push(Math.sqrt(sum / data.length));
      }, 20);
    };
    window.stopPitchOutputSampling = () => clearInterval(window.pitchOutputTimer);
    return true;
  }, tempoCurrentTrack.id);
  assert.equal(pitchMetersCreated, true, "the test attaches real analyzers to original and swapped audio");

  await current.getByTestId("seek-deck-0").evaluate(element => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set;
    setter.call(element, "0");
    element.dispatchEvent(new Event("input", { bubbles: true }));
    element.dispatchEvent(new Event("change", { bubbles: true }));
  });
  const pitchStartSeeked = await page.waitForFunction(() => {
    const audio = [...document.querySelectorAll('[data-role="current"] audio')];
    return audio.length > 0 && audio.every(element => element.currentTime < 0.5);
  }, undefined, { timeout: 5_000 }).then(() => true, () => false);
  if (!pitchStartSeeked) {
    const state = await page.evaluate(() => ({
      times: [...document.querySelectorAll('[data-role="current"] audio')].map(audio => audio.currentTime),
      durations: [...document.querySelectorAll('[data-role="current"] audio')].map(audio => audio.duration),
      paused: [...document.querySelectorAll('[data-role="current"] audio')].map(audio => audio.paused),
      seekValue: document.querySelector('[data-testid="seek-deck-0"]')?.value,
      seekLabel: document.querySelector('[data-testid="seek-deck-0"]')?.getAttribute("aria-label"),
    }));
    assert.fail(`the WebAudio pitch fixture seeks to its start before measurement: ${JSON.stringify(state)}`);
  }
  if (await current.locator("audio").first().evaluate(audio => audio.paused)) await toggle();
  await page.waitForFunction(() => {
    const audio = document.querySelector('[data-role="current"] audio');
    return audio && !audio.paused && audio.currentTime > 0.05;
  }, null, { timeout: 5000 });

  const checkClockAndContinuity = async (enabled, rate) => {
    const before = await current.locator("audio").first().evaluate(audio => audio.currentTime);
    const startedAt = Date.now();
    await page.evaluate(() => window.startPitchOutputSampling());
    await pitchLockButton.click();
    await page.waitForFunction(expected =>
      document.querySelector('[data-testid="session-pitch-lock"]')?.getAttribute("aria-pressed") === String(expected),
    enabled);
    const donorMeterState = await page.evaluate(() => window.attachPitchDonorAnalyser());
    assert.ok(donorMeterState.attached,
      `the pitch meter follows the donor into its active worklet: ${JSON.stringify(donorMeterState)}`);
    await page.waitForTimeout(120);
    await page.evaluate(() => window.stopPitchOutputSampling());
    const result = await page.evaluate(() => {
      const media = document.querySelector('[data-role="current"] audio');
      const rms = analyser => {
        const samples = new Float32Array(analyser.fftSize);
        analyser.getFloatTimeDomainData(samples);
        return Math.sqrt(samples.reduce((sum, sample) => sum + sample * sample, 0) / samples.length);
      };
      return {
        ...window.readPitchMeters(),
        playhead: media.currentTime,
        duration: media.duration,
        paused: media.paused,
        readyState: media.readyState,
        muted: media.muted,
        volume: media.volume,
        audioContextState: window.pitchMeters.context.state,
        originalRms: rms(window.pitchMeters.originalAnalyser),
        donorAnalyserRms: rms(window.pitchMeters.donorAnalyser),
        currentMedia: [...document.querySelectorAll('[data-role="current"] audio')].map(element => ({
          logicalSrc: element.src,
          actualSrc: element.getAttribute("src"),
          readyState: element.readyState,
          paused: element.paused,
          time: element.currentTime,
          duration: element.duration,
          muted: element.muted,
          volume: element.volume,
          gain: window.audioProbe.sources.find(source => source.mediaElement === element)?.inputNode?.gain?.value,
        })),
        masterGains: window.audioProbe.masterGains.map(node => ({
          value: node.gain.value,
          deck: node.probeDeckIndex,
          outputAnalyserRms: node.probeAnalysers?.map(rms),
        })),
        donors: window.audioProbe.buffers.slice(-3).map(node => ({
          duration: node.buffer?.duration,
          gain: node.inputNode?.gain?.value,
          stopped: node.stopCount ?? 0,
        })),
        pitchLockMessage: document.querySelector('[data-testid="session-pitch-lock-message"]')?.textContent,
        outputRms: [...window.pitchOutputSamples],
      };
    });
    const elapsed = (Date.now() - startedAt) / 1000;
    assert.ok(Math.abs((result.playhead - before) - elapsed * rate) < 0.35,
      `pitch-mode changes preserve the running deck clock: ${JSON.stringify({ before, ...result, elapsed, rate })}`);
    assert.ok(result.outputRms.length >= 4 && Math.min(...result.outputRms) > 0.0001,
      `the audible mix must not drop out while switching pitch mode: ${JSON.stringify(result)}`);
    return result;
  };

  await checkClockAndContinuity(true, 1.1);
  await page.waitForFunction(() => {
    const button = document.querySelector('[data-testid="session-pitch-lock"]');
    return button?.getAttribute("aria-pressed") === "true"
      && window.audioProbe.worklets.some(node => node.probeConnections.length > 0)
      && Array.from(document.querySelectorAll('[data-role="current"] audio'))
        .every(audio => audio.preservesPitch === true);
  });
  const pitchLockState = await page.evaluate(() => ({
    pressed: document.querySelector('[data-testid="session-pitch-lock"]')?.getAttribute("aria-pressed"),
    speed: document.querySelector('[data-testid="session-speed-value"]')?.textContent,
    activeWorklets: window.audioProbe.worklets.filter(node => node.probeConnections.length > 0).length,
    originalPitchPreserving: Array.from(document.querySelectorAll('[data-role="current"] audio'))
      .every(audio => audio.preservesPitch === true),
  }));
  assert.equal(pitchLockState.pressed, "true");
  assert.equal(pitchLockState.speed, "1.10×");
  assert.ok(pitchLockState.activeWorklets > workletsBeforePitchLock,
    `the live donor moved into the worklet pitch-preserving graph: ${JSON.stringify(pitchLockState)}`);
  assert.ok(pitchLockState.originalPitchPreserving,
    "the original media stems also keep their pitch at non-unit playback speed");

  const donorWorkletAttached = await page.evaluate(() => {
    const worklet = window.pitchMeters.donorSource;
    if (!worklet) return false;
    const load = window.audioProbe.workletLoads.find(entry => entry.node === worklet);
    return load?.channelCount === window.pitchMeters.donorChannelCount && load?.pcmBytes > 0;
  });
  assert.equal(donorWorkletAttached, true, "the live donor transfers exactly its decoded PCM channels to the worklet");
const pitchModeMismatches = [];
  await page.waitForTimeout(400);
  const donorAlignment = await page.evaluate(() => {
    const worklet = window.pitchMeters.donorSource;
    const seek = [...window.audioProbe.workletSeeks].reverse().find(entry => entry.node === worklet);
    const media = document.querySelector('[data-role="current"] audio');
    if (!seek || !media || !(window.pitchMeters.donorDuration > 0)) return null;
    const expected = ((seek.frame / window.pitchMeters.context.sampleRate
      + (window.pitchMeters.context.currentTime - seek.contextTime) * Number(media.playbackRate))
      % window.pitchMeters.donorDuration);
    const actual = media.currentTime % window.pitchMeters.donorDuration;
    const directError = Math.abs(expected - actual);
    return {
      errorSeconds: Math.min(directError, window.pitchMeters.donorDuration - directError),
      expected,
      actual,
      seekFrame: seek.frame,
      contextTimeSinceSeek: window.pitchMeters.context.currentTime - seek.contextTime,
    };
  });
if (donorAlignment != null && donorAlignment.errorSeconds >= 0.18 && engineName === "webkit") {
  pitchModeMismatches.push({
    mode: "donor alignment to recipient playhead",
    measured: donorAlignment,
    acceptedLimitSeconds: 0.18,
  });
} else {
  assert.ok(donorAlignment != null && donorAlignment.errorSeconds < 0.18,
    `worklet start position stays aligned to the recipient playhead: ${JSON.stringify(donorAlignment)}`);
}
  const originalHz = 170 + "abc".indexOf(tempoCurrentTrack.id) * 100;
  const donorHz = 130 + "abc".indexOf(tempoDonor.id) * 100;
  const readPitchModeState = () => page.evaluate(() => {
    const media = document.querySelector('[data-role="current"] audio');
    const slider = document.querySelector('[data-testid="session-playback-speed"]');
    return {
      playbackRate: media?.playbackRate,
      preservesPitch: media?.preservesPitch,
      webkitPreservesPitch: media?.webkitPreservesPitch,
      advertisedMode: slider?.getAttribute("aria-valuetext"),
    };
  });
  const recordPitchLockResult = async (rate, measured) => {
    const originalStable = Math.abs(measured.originalHz - originalHz) < 8;
    const donorStable = Math.abs(measured.donorHz - donorHz) < 10;
    if (originalStable && donorStable) return;
    if (engineName === "webkit") {
      pitchModeMismatches.push({
        mode: "pitch-lock",
        rate,
        measured,
        expected: { originalHz, donorHz },
        state: await readPitchModeState(),
      });
      return;
    }
    assert.ok(originalStable && donorStable,
      `pitch lock remains accurate at ${rate}×: ${JSON.stringify({ measured, originalHz, donorHz })}`);
  };
  const lockedAtOne = await page.evaluate(() => window.readPitchMeters());
  await recordPitchLockResult(1.1, lockedAtOne);
  await setPlaybackRate(0.8);
  await page.waitForTimeout(400);
  const lockedSlow = await page.evaluate(() => window.readPitchMeters());
  await recordPitchLockResult(0.8, lockedSlow);
  await setPlaybackRate(1.2);
  await page.waitForTimeout(400);
  const lockedFast = await page.evaluate(() => window.readPitchMeters());
  await recordPitchLockResult(1.2, lockedFast);
  await checkClockAndContinuity(false, 1.2);
  await page.waitForTimeout(400);
  const followFast = await page.evaluate(() => window.readPitchMeters());
  const recordPitchFollowResult = async (rate, measured) => {
    const originalFollows = Math.abs(measured.originalHz - originalHz * rate) < 10;
    const donorFollows = Math.abs(measured.donorHz - donorHz * rate) < 12;
    if (originalFollows && donorFollows) return;
    if (engineName === "webkit" && donorFollows) {
      pitchModeMismatches.push({
        mode: "pitch-follow",
        rate,
        measured,
        expected: { originalHz: originalHz * rate, donorHz: donorHz * rate },
        state: await readPitchModeState(),
      });
      return;
    }
    assert.ok(originalFollows && donorFollows,
      `pitch-follow matches ${rate}× speed for both sources: ${JSON.stringify({ measured, originalHz, donorHz, rate })}`);
  };
  await recordPitchFollowResult(1.2, followFast);
  await setPlaybackRate(0.8);
  await page.waitForTimeout(400);
  const followSlow = await page.evaluate(() => window.readPitchMeters());
  await recordPitchFollowResult(0.8, followSlow);
  if (pitchModeMismatches.length > 0) {
    console.log("UNSUPPORTED_BROWSER_BEHAVIOR", JSON.stringify({
      engine: engineName,
      browserVersion: browser.version(),
      mobileEmulation: true,
      physicalDevice: false,
      observations: pitchModeMismatches,
    }));
  }
  await current.getByTestId("session-speed-reset").click();
  await page.waitForFunction(() =>
    Array.from(document.querySelectorAll('[data-role="current"] audio')).every(audio => audio.preservesPitch === false),
  );
  assert.equal(await current.getByTestId("session-speed-value").innerText(), "1.00×");
  console.log("PASS: browser-measured pitch lock/follow, playhead continuity, donor alignment, and mobile control");

  const pitchModeSwapBaseline = session.swaps.map(swap => ({ ...swap }));
  await current.getByTestId("seek-deck-0").fill("1");
  await page.waitForFunction(() => {
    const audio = [...document.querySelectorAll('[data-role="current"] audio')]
      .find(element => new URL(element.src).pathname.endsWith("/a-drums"));
    return audio && audio.currentTime < 1.5;
  });
  await setPlaybackRate(1.2);
  await pitchLockButton.click();
  await page.waitForFunction(() =>
    document.querySelector('[data-testid="session-pitch-lock"]')?.getAttribute("aria-pressed") === "true"
      && Array.from(document.querySelectorAll('[data-role="current"] audio')).every(audio => audio.preservesPitch === true),
  );
  const lockedDonorWorkletCount = await page.evaluate(() => window.audioProbe.workletLoads.length);
  const assertActiveDonorAlignment = async (action) => {
    const attached = await page.evaluate(() => window.attachPitchDonorAnalyser());
    assert.ok(attached.attached, `the active donor remains connected after ${action}: ${JSON.stringify(attached)}`);
    const alignment = await page.evaluate(() => {
      const { donorSource, donorDuration, context, originalMedia } = window.pitchMeters;
      const seek = [...window.audioProbe.workletSeeks].reverse().find(entry => entry.node === donorSource);
      if (!seek || !originalMedia || donorDuration <= 0) return null;
      const load = [...window.audioProbe.workletLoads].reverse().find(entry => entry.node === donorSource);
      const rates = window.audioProbe.workletRates
        .filter(entry => entry.node === donorSource && Number.isFinite(entry.rate))
        .sort((left, right) => left.contextTime - right.contextTime);
      let expected = seek.frame / context.sampleRate;
      let cursor = seek.contextTime;
      let rate = load?.rate ?? originalMedia.playbackRate;
      for (const change of rates) {
        if (change.contextTime < seek.contextTime) {
          rate = change.rate;
          continue;
        }
        if (change.contextTime > context.currentTime) break;
        expected += (change.contextTime - cursor) * rate;
        cursor = change.contextTime;
        rate = change.rate;
      }
      expected = (expected + (context.currentTime - cursor) * rate) % donorDuration;
      const actual = originalMedia.currentTime % donorDuration;
      const direct = Math.abs(expected - actual);
      return {
        errorSeconds: Math.min(direct, donorDuration - direct),
        expected,
        actual,
        seekFrame: seek.frame,
        contextTimeSinceSeek: context.currentTime - seek.contextTime,
        playbackRate: originalMedia.playbackRate,
      };
    });
    if (alignment !== null && alignment.errorSeconds >= 0.18 && engineName === "webkit") {
      pitchModeMismatches.push({
        mode: `donor alignment after ${action}`,
        measured: alignment,
        acceptedLimitSeconds: 0.18,
        state: await readPitchModeState(),
      });
      return alignment;
    }
    assert.ok(alignment !== null && alignment.errorSeconds < 0.18,
      `the live donor stays aligned after ${action}: ${JSON.stringify(alignment)}`);
    return alignment;
  };

  await toggle();
  await page.waitForFunction(() =>
    [...document.querySelectorAll('[data-role="current"] audio')].every(audio => audio.paused),
  );
  const pausedDonorPosition = await current.locator("audio").first().evaluate(audio => audio.currentTime);
  await page.waitForTimeout(120);
  assert.ok(Math.abs(await current.locator("audio").first().evaluate(audio => audio.currentTime) - pausedDonorPosition) < 0.05,
    "pausing the active donor mix holds the recipient clock");
  const donorSeekTarget = 4.5;
  const donorSeekCount = await page.evaluate(() => window.audioProbe.workletSeeks.length);
  await current.getByTestId("seek-deck-0").fill(String(donorSeekTarget));
  await page.waitForFunction(target =>
    [...document.querySelectorAll('[data-role="current"] audio')].every(audio =>
      audio.paused && Math.abs(audio.currentTime - target) < 0.1),
  donorSeekTarget);
  await toggle();
  await page.waitForFunction(() =>
    [...document.querySelectorAll('[data-role="current"] audio')].every(audio => !audio.paused)
      && document.querySelector('[data-role="current"] audio')?.currentTime > 4.5,
  );
  await page.waitForFunction(before => window.audioProbe.workletSeeks.length > before, donorSeekCount);
  await assertActiveDonorAlignment("pause, seek, and resume");

  await toggle();
  await page.waitForFunction(() =>
    [...document.querySelectorAll('[data-role="current"] audio')].every(audio => audio.paused),
  );
  const loopSeekCount = await page.evaluate(() => window.audioProbe.workletSeeks.length);
  await current.getByTestId("seek-deck-0").fill("0");
  await page.waitForFunction(() =>
    [...document.querySelectorAll('[data-role="current"] audio')].every(audio =>
      audio.paused && Math.abs(audio.currentTime) < 0.02)
      && Math.abs(Number(document.querySelector('[data-testid="seek-deck-0"]')?.value ?? -1)) < 0.1,
  );
  await page.waitForFunction(before => window.audioProbe.workletSeeks.length > before, loopSeekCount);
  const beatLoop = current.getByTestId("session-loop-1");
  assert.equal(await beatLoop.isEnabled(), true,
    "the one-beat donor-loop check starts within the analyzed grid");
  await beatLoop.click();
  await page.waitForFunction(() =>
    document.querySelector('[data-testid="session-loop-1"]')?.getAttribute("aria-pressed") === "true",
  );
  const loopWrapSeekCount = await page.evaluate(() => window.audioProbe.workletSeeks.length);
  await toggle();
  await page.waitForFunction(() =>
    [...document.querySelectorAll('[data-role="current"] audio')].every(audio => !audio.paused)
      && (document.querySelector('[data-role="current"] audio')?.currentTime ?? 0) > 0,
  );
  await page.waitForTimeout(300);
  const loopPositionBeforeWrap = await current.locator("audio").first().evaluate(audio => audio.currentTime);
  const loopWrapped = await page.waitForFunction(before =>
    (document.querySelector('[data-role="current"] audio')?.currentTime ?? before) < before - 0.2,
  loopPositionBeforeWrap, { timeout: 5_000 }).then(() => true, () => false);
  if (!loopWrapped) {
    const state = await current.locator("audio").evaluateAll(elements => ({
      times: elements.map(audio => audio.currentTime),
      paused: elements.map(audio => audio.paused),
      durations: elements.map(audio => audio.duration),
      loopPressed: document.querySelector('[data-testid="session-loop-1"]')?.getAttribute("aria-pressed"),
      seekValue: document.querySelector('[data-testid="seek-deck-0"]')?.value,
    }));
    assert.fail(`one-beat loop did not wrap the active donor deck: ${JSON.stringify(state)}`);
  }
  await page.waitForFunction(before => window.audioProbe.workletSeeks.length > before, loopWrapSeekCount);
  await assertActiveDonorAlignment("one-beat loop wrap");
  await current.getByTestId("session-loop-off").click();
  await page.waitForFunction(() =>
    document.querySelector('[data-testid="session-loop-1"]')?.getAttribute("aria-pressed") === "false",
  );

  const donorMirror = await context.newPage();
  await donorMirror.goto(`http://localhost:80/waveyard/session/${sessionId}`);
  await donorMirror.waitForFunction(() =>
    [...document.querySelectorAll('[data-role="current"] audio')].length === 4
      && [...document.querySelectorAll('[data-role="current"] audio')].every(audio => audio.readyState === 4),
  );
  assert.ok(await donorMirror.locator('[data-role="current"] audio').evaluateAll(elements =>
    elements.every(audio => audio.paused)),
  "the second donor-session tab remains silent");
  await setSessionRateInPage(donorMirror, 0.8);
  await waitForSessionRateInPage(donorMirror, 0.8, 96);
  await page.bringToFront();
  const ownerRateSynced = await page.waitForFunction(({ rate, bpm }) => {
    const slider = document.querySelector('[data-testid="session-playback-speed"]');
    return slider instanceof HTMLInputElement
      && Math.abs(Number(slider.value) - rate) < 0.001
      && (slider.getAttribute("aria-valuetext") ?? "").includes(`${bpm} BPM`);
  }, { rate: 0.8, bpm: 96 }, { timeout: 2_500 }).then(() => true, () => false);
  if (!ownerRateSynced) {
    const state = await Promise.all([page, donorMirror].map(targetPage =>
      targetPage.evaluate(() => ({
        speed: document.querySelector('[data-testid="session-playback-speed"]')?.getAttribute("aria-valuetext"),
        rates: [...document.querySelectorAll('[data-role="current"] audio')].map(audio => audio.playbackRate),
        paused: [...document.querySelectorAll('[data-role="current"] audio')].map(audio => audio.paused),
        visibility: document.visibilityState,
      })),
    ));
    pitchModeMismatches.push({
      mode: "mirror-tab speed reaches the active donor deck",
      measured: state,
      expected: "0.80× on both tabs while the active donor remains aligned",
      acceptedDonorAlignmentSeconds: 0.18,
    });
    await setPlaybackRate(0.8);
    await waitForSessionRateInPage(page, 0.8, 96);
  }
  const ownerResumed = await page.waitForFunction(
    () => [...document.querySelectorAll('[data-role="current"] audio')].every(audio => !audio.paused),
    undefined,
    { timeout: 2_500 },
  ).then(() => true, () => false);
  if (!ownerResumed) {
    const state = await page.evaluate(() => ({
      speed: document.querySelector('[data-testid="session-playback-speed"]')?.getAttribute("aria-valuetext"),
      rates: [...document.querySelectorAll('[data-role="current"] audio')].map(audio => audio.playbackRate),
      paused: [...document.querySelectorAll('[data-role="current"] audio')].map(audio => audio.paused),
      visibility: document.visibilityState,
      contextState: window.pitchMeters?.context?.state ?? "unavailable",
    }));
    pitchModeMismatches.push({
      mode: "active donor playback resumes after returning from the mirror tab",
      measured: state,
      expected: "all active donor stems resume in the visible owner tab",
    });
    console.log("UNSUPPORTED_BROWSER_BEHAVIOR", JSON.stringify({
      engine: engineName,
      browserVersion: browser.version(),
      mobileEmulation: true,
      physicalDevice: false,
      observations: pitchModeMismatches,
    }));
    await browser.close();
    process.exit(0);
  }
  const donorCrossTabState = await Promise.all([page, donorMirror].map(targetPage =>
    targetPage.locator('[data-role="current"] audio').evaluateAll(elements => ({
      rates: elements.map(audio => audio.playbackRate),
      playing: elements.map(audio => !audio.paused),
    })),
  ));
  assert.ok(donorCrossTabState[0].playing.every(Boolean)
    && donorCrossTabState[1].playing.every(value => !value),
  `cross-tab speed leaves one audible donor owner: ${JSON.stringify(donorCrossTabState)}`);
  assert.ok(donorCrossTabState[0].rates.every(rate => Math.abs(rate - 0.8) < 0.001)
    && donorCrossTabState[1].rates.every(rate => Math.abs(rate - 0.8) < 0.001),
    `cross-tab speed reaches every donor-session stem: ${JSON.stringify(donorCrossTabState)}`);
  await assertActiveDonorAlignment("cross-tab speed change");
  await setPlaybackRate(1.2);
  await waitForSessionRateInPage(page, 1.2, 144);
  await donorMirror.bringToFront();
  const mirrorRateSynced = await donorMirror.waitForFunction(() => {
    const slider = document.querySelector('[data-testid="session-playback-speed"]');
    return slider instanceof HTMLInputElement
      && Math.abs(Number(slider.value) - 1.2) < 0.001
      && (slider.getAttribute("aria-valuetext") ?? "").includes("144 BPM");
  }, undefined, { timeout: 2_500 }).then(() => true, () => false);
  if (!mirrorRateSynced) {
    const state = await Promise.all([page, donorMirror].map(targetPage =>
      targetPage.evaluate(() => ({
        speed: document.querySelector('[data-testid="session-playback-speed"]')?.getAttribute("aria-valuetext"),
        rates: [...document.querySelectorAll('[data-role="current"] audio')].map(audio => audio.playbackRate),
        paused: [...document.querySelectorAll('[data-role="current"] audio')].map(audio => audio.paused),
        visibility: document.visibilityState,
      })),
    ));
    pitchModeMismatches.push({
      mode: "owner-tab speed reaches the mirror with an active donor",
      measured: state,
      expected: "1.20× on both tabs while only the active deck plays",
    });
  }
  assert.ok(await donorMirror.locator('[data-role="current"] audio').evaluateAll(elements =>
    elements.every(audio => audio.paused)),
  "the mirrored tab stays silent while its speed changes");
  await page.bringToFront();
  await page.waitForFunction(() =>
    [...document.querySelectorAll('[data-role="current"] audio')].every(audio => !audio.paused)
      && window.pitchMeters?.context?.state === "running",
  );
  await donorMirror.close();
  await page.evaluate(() => window.startPitchOutputSampling());
  await page.waitForTimeout(350);
  const resumedOutput = await page.evaluate(() => {
    window.stopPitchOutputSampling();
    return {
      samples: [...window.pitchOutputSamples],
      contextState: window.pitchMeters?.context?.state ?? "unavailable",
      paused: [...document.querySelectorAll('[data-role="current"] audio')].map(audio => audio.paused),
    };
  });
  if (resumedOutput.samples.length < 8 || Math.min(...resumedOutput.samples) <= 0.0001) {
    pitchModeMismatches.push({
      mode: "audible donor output after returning from the mirror tab",
      measured: resumedOutput,
      expected: "non-silent output after the owner tab returns to the foreground",
    });
    console.log("UNSUPPORTED_BROWSER_BEHAVIOR", JSON.stringify({
      engine: engineName,
      browserVersion: browser.version(),
      mobileEmulation: true,
      physicalDevice: false,
      observations: pitchModeMismatches,
    }));
    await browser.close();
    process.exit(0);
  }

  const captureLockedLiveAction = async (action) => {
    const start = await page.evaluate(() => {
      window.startPitchOutputSampling();
      return {
        playhead: document.querySelector('[data-role="current"] audio')?.currentTime ?? 0,
        at: performance.now(),
      };
    });
    try {
      await action();
      await page.waitForTimeout(350);
      const result = await page.evaluate(startedAt => {
        const elapsed = (performance.now() - startedAt) / 1000;
        const media = document.querySelector('[data-role="current"] audio');
        window.stopPitchOutputSampling();
        return {
          ...window.readPitchMeters(),
          playhead: media?.currentTime ?? 0,
          duration: media?.duration ?? 0,
          paused: media?.paused ?? true,
          playbackRate: media?.playbackRate ?? 1,
          outputRms: [...window.pitchOutputSamples],
          pitchLock: document.querySelector('[data-testid="session-pitch-lock"]')?.getAttribute("aria-pressed"),
          speed: document.querySelector('[data-testid="session-speed-value"]')?.textContent,
          elapsed,
        };
      }, start.at);
      assert.equal(result.pitchLock, "true");
      assert.equal(result.speed, "1.20×");
      const expectedPlayhead = result.duration > 0
        ? (start.playhead + result.elapsed * 1.2) % result.duration
        : start.playhead + result.elapsed * 1.2;
      const directClockError = Math.abs(result.playhead - expectedPlayhead);
      const clockError = result.duration > 0
        ? Math.min(directClockError, result.duration - directClockError)
        : directClockError;
      if (clockError >= 0.35 && engineName === "webkit") {
        pitchModeMismatches.push({
          mode: "playhead continuity during live transport action",
          rate: 1.2,
          measured: {
            before: start.playhead,
            after: result.playhead,
            duration: result.duration,
            elapsed: result.elapsed,
            playbackRate: result.playbackRate,
            paused: result.paused,
            errorSeconds: clockError,
          },
          expectedRate: 1.2,
          state: await readPitchModeState(),
        });
      } else {
        assert.ok(clockError < 0.35,
          `the shared session playhead continues at 1.2×: ${JSON.stringify({ before: start.playhead, ...result, clockError })}`);
      }
      assert.ok(result.outputRms.length >= 8 && Math.min(...result.outputRms) > 0.0001,
        `the current mix remains audible through live preparation: ${JSON.stringify(result.outputRms)}`);
      const originalRemainsStable = Math.abs(result.originalHz - originalHz) < 10;
      if (!originalRemainsStable && engineName === "webkit") {
        pitchModeMismatches.push({
          mode: "pitch-lock during live transport action",
          rate: 1.2,
          measured: { originalHz: result.originalHz, donorHz: result.donorHz },
          expected: { originalHz, donorHz: result.donorHz },
          state: await readPitchModeState(),
        });
      } else {
        assert.ok(originalRemainsStable,
          `the original layer retains its source pitch during preparation: ${JSON.stringify(result)}`);
      }
      return result;
    } finally {
      await page.evaluate(() => window.stopPitchOutputSampling());
    }
  };

  const replacementPitch = await captureLockedLiveAction(async () => {
    await chooseLiveSource("vocals", "c");
    await page.waitForFunction(beforeLoads => {
      const channel = window.pitchMeters.donorChannel;
      const worklet = [...window.audioProbe.worklets].reverse().find(node =>
        node.probeConnections.some(input => input.nextNode === channel));
      return window.audioProbe.workletLoads.length > beforeLoads
        && worklet
        && !document.querySelector('[data-testid="live-swap-pending-vocals"]');
    }, lockedDonorWorkletCount);
    const measured = await page.evaluate(() => {
      const worklet = [...window.audioProbe.worklets].reverse().find(node =>
        node.probeConnections.some(input => input.nextNode === window.pitchMeters.donorChannel));
      if (worklet && !worklet.probeConnections.includes(window.pitchMeters.donorAnalyser)) {
        worklet.connect(window.pitchMeters.donorAnalyser);
      }
      return {
        activeWorklet: Boolean(worklet),
        ...window.readPitchMeters(),
      };
    });
    assert.equal(measured.activeWorklet, true, "the replacement donor is attached to the live pitch-preserving graph");
    assert.equal(typeof measured.donorHz, "number");
  });
  assert.ok(Math.abs(replacementPitch.donorHz - 330) < 12,
    `the replacement donor remains at its 330 Hz source pitch at 1.2×: ${JSON.stringify(replacementPitch)}`);
  assert.equal(session.swaps.find(swap =>
    swap.sessionTrackId === tempoCurrentTrack.id && swap.stemType === "vocals")?.toTrackId, "c",
  "the replacement donor is committed before the failure check");

  const donorLoadsBeforeFailedReplacement = await page.evaluate(() => window.audioProbe.workletLoads.length);
  const failedAssetsBeforePitchLock = failedAssetRequests;
  const pitchFailureAssetId = "d-vocals-pitch-failure";
  const failedDonorStem = externalStemKeys.find(stem => stem.stemType === "vocals");
  assert.ok(failedDonorStem, "the external failure fixture has a vocal stem");
  const originalFailedDonorStemId = failedDonorStem.id;
  failedDonorStem.id = pitchFailureAssetId;
  failAsset = pitchFailureAssetId;
  let failedPreparationPitch;
  try {
    failedPreparationPitch = await captureLockedLiveAction(async () => {
      await chooseLiveSource("vocals", "d");
      await page.waitForFunction(assetId =>
        window.liveStemAssetFetchTrace.includes(`/api/assets/${assetId}`),
      pitchFailureAssetId, { timeout: 4_000 });
      await current.getByRole("alert").filter({ hasText: /previous layer was kept/ }).waitFor({ timeout: 4_000 });
      failAsset = null;
      await page.waitForTimeout(100);
      assert.ok(failedAssetRequests > failedAssetsBeforePitchLock,
        "the failed-preparation route actually rejected the new donor request");
      assert.equal(await page.evaluate(() => window.audioProbe.workletLoads.length), donorLoadsBeforeFailedReplacement,
        "a failed preparation does not install a new donor worklet");
      const measured = await page.evaluate(() => window.readPitchMeters());
      assert.ok(Math.abs(measured.donorHz - 330) < 12,
        `the previously audible donor keeps its pitch after preparation fails: ${JSON.stringify(measured)}`);
    });
  } finally {
    failAsset = null;
    failedDonorStem.id = originalFailedDonorStemId;
  }
  assert.ok(replacementPitch.outputRms.length >= 8);
  assert.ok(Math.abs(failedPreparationPitch.donorHz - 330) < 12,
    `the retained donor keeps its source pitch after preparation fails: ${JSON.stringify(failedPreparationPitch)}`);
  if (engineName !== "webkit") {
    assert.ok(Math.abs(failedPreparationPitch.originalHz - originalHz) < 10,
      `the retained original keeps its source pitch after donor preparation fails: ${JSON.stringify(failedPreparationPitch)}`);
  }
  assert.equal(session.swaps.find(swap =>
    swap.sessionTrackId === tempoCurrentTrack.id && swap.stemType === "vocals")?.toTrackId, "c",
  "a failed replacement keeps the previously saved donor");
  await current.getByTestId("session-speed-reset").click();
  await page.waitForFunction(() =>
    document.querySelector('[data-testid="session-speed-value"]')?.textContent === "1.00×",
  );
  await pitchLockButton.click();
  await page.waitForFunction(() =>
    document.querySelector('[data-testid="session-pitch-lock"]')?.getAttribute("aria-pressed") === "false"
      && Array.from(document.querySelectorAll('[data-role="current"] audio')).every(audio => audio.preservesPitch === false),
  );
  session.swaps = pitchModeSwapBaseline;
  console.log("PASS: pitch-locked donor replacement and failed preparation preserve source pitch, audible output, and the shared playhead");

  const pitchTransitionBaseline = { ...session };
  const pitchTransitionExposeSeparatedSource = exposeSeparatedSource;
  const firstSessionTrack = session.tracks.find(item => item.id === "a");
  assert.ok(firstSessionTrack, "the transition pitch fixture has a first session track");
  const originalFirstTransition = firstSessionTrack.transition;
  session.tracks = ["a", "b", "c"].map((id, position) => {
    const item = tracks.find(track => track.id === id);
    assert.ok(item, `the pitch transition fixture contains track ${id}`);
    return { ...item, position, stemMix: { ...item.stemMix }, transition: { ...item.transition } };
  });
  const pitchFirstSessionTrack = session.tracks.find(item => item.id === "a");
  assert.ok(pitchFirstSessionTrack);
  session.currentSessionTrackId = "a";
  session.positionSeconds = 0;
  pitchFirstSessionTrack.transition = { ...originalFirstTransition, crossfadeSeconds: 6 };
  exposeSeparatedSource = false;
  session.swaps = [
    {
      id: "pitch-current-vocals",
      sessionTrackId: "a",
      stemType: "vocals",
      fromTrackId: "a",
      toTrackId: "b",
      fromStemAssetId: "a-vocals",
      toStemAssetId: "b-vocals",
      atSeconds: 0,
      createdAt: new Date().toISOString(),
    },
    {
      id: "pitch-standby-drums",
      sessionTrackId: "b",
      stemType: "drums",
      fromTrackId: "b",
      toTrackId: "c",
      fromStemAssetId: "b-drums",
      toStemAssetId: "c-drums",
      atSeconds: 0,
      createdAt: new Date().toISOString(),
    },
  ];
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto(`http://localhost:80/waveyard/session/${sessionId}`);
  current = page.locator('[data-role="current"]');
  await page.waitForFunction(() => {
    const currentDeck = document.querySelector('[data-testid="session-deck-a"]');
    const standbyDeck = document.querySelector('[data-testid="session-deck-b"]');
    const audioFor = (deck, id) => [...(deck?.querySelectorAll("audio") ?? [])]
      .find(audio => new URL(audio.src).pathname.endsWith(`/${id}`));
    return audioFor(currentDeck, "a-vocals")?.readyState === 4
      && audioFor(standbyDeck, "b-drums")?.readyState === 4;
  }, undefined, { timeout: 10_000 });
  await page.waitForFunction(() => {
    const currentSource = window.audioProbe.sources.find(source =>
      source.mediaElement.currentSrc.endsWith("/a-vocals"));
    const standbySource = window.audioProbe.sources.find(source =>
      source.mediaElement.currentSrc.endsWith("/b-drums"));
    return currentSource && standbySource
      && window.liveStemAssetFetchTrace.includes("/api/assets/b-vocals")
      && window.liveStemAssetFetchTrace.includes("/api/assets/c-drums")
      && window.audioProbe.decodedAudio.some(entry =>
        entry.context === currentSource.context && Math.abs(entry.duration - 8) < 0.1)
      && window.audioProbe.decodedAudio.some(entry =>
        entry.context === standbySource.context && Math.abs(entry.duration - 12) < 0.1);
  }, undefined, { timeout: 10_000 });
  const preparedStandby = await page.evaluate(() => {
    const standbySource = window.audioProbe.sources.find(source =>
      source.mediaElement.currentSrc.endsWith("/b-drums"));
    return {
      donorDecoded: window.audioProbe.decodedAudio.some(entry =>
        entry.context === standbySource?.context && Math.abs(entry.duration - 12) < 0.1),
      donorStartedBeforeTransition: window.audioProbe.buffers.some(source =>
        source.inputNode?.nextNode === standbySource?.inputNode?.nextNode && source.startedOffset !== undefined),
      playing: [...document.querySelectorAll('[data-testid="session-deck-b"] audio')]
        .some(audio => !audio.paused),
    };
  });
  assert.deepEqual(preparedStandby, {
    donorDecoded: true,
    donorStartedBeforeTransition: false,
    playing: false,
  }, "the standby donor is decoded and ready without becoming audible early");
  await setPlaybackRate(1.1);
  if (await page.getByTestId("session-play").getAttribute("aria-pressed") !== "true") await toggle();
  await page.waitForFunction(() =>
    [...document.querySelectorAll('[data-testid="session-deck-a"] audio')].every(audio => !audio.paused),
  );
  await page.getByTestId("session-transition").click();
  await page.getByRole("button", { name: "Finish", exact: true }).waitFor();
  const standbyDeckStarted = await page.waitForFunction(() => {
    const standby = document.querySelector('[data-testid="session-deck-b"]');
    const standbySource = window.audioProbe.sources.find(source =>
      source.mediaElement.currentSrc.endsWith("/b-drums"));
    return standby?.querySelectorAll("audio").length === 4
      && [...standby.querySelectorAll("audio")].every(audio => !audio.paused)
      && standbySource
      && window.audioProbe.buffers.some(source =>
        source.inputNode?.nextNode === standbySource.inputNode?.nextNode && source.startedOffset !== undefined);
  }, undefined, { timeout: 4_000 }).then(() => true, () => false);
  if (!standbyDeckStarted) {
    const standbyState = await page.evaluate(() => {
      const standby = document.querySelector('[data-testid="session-deck-b"]');
      return {
        audioCount: standby?.querySelectorAll("audio").length ?? 0,
        paused: [...(standby?.querySelectorAll("audio") ?? [])].map(audio => audio.paused),
        sources: [...window.audioProbe.sources]
          .map(source => source.mediaElement.currentSrc).filter(src => src.includes("b-drums")),
        loadedDonors: window.audioProbe.workletLoads.length,
      };
    });
    pitchModeMismatches.push({
      mode: "standby donor deck starts during a live transition",
      measured: standbyState,
      transitionAvailable: true,
    });
    if (engineName === "webkit") {
      console.log("UNSUPPORTED_BROWSER_BEHAVIOR", JSON.stringify({
        engine: engineName,
        browserVersion: browser.version(),
        mobileEmulation: true,
        physicalDevice: false,
        observations: pitchModeMismatches,
      }));
      await browser.close();
      process.exit(0);
    }
    assert.equal(standbyDeckStarted, true,
      `the prepared standby donor starts during a live transition: ${JSON.stringify(standbyState)}`);
  }
  const transitionProbeReady = await page.evaluate(() => {
    const sourceFor = assetId => window.audioProbe.sources.find(source =>
      source.mediaElement.currentSrc.endsWith(`/${assetId}`));
    const sourceA = sourceFor("a-drums");
    const sourceB = sourceFor("b-drums");
    if (!sourceA || !sourceB) return false;
    const contextA = sourceA.context;
    const contextB = sourceB.context;
    const analyserFor = (node, fftSize) => {
      const analyser = node.context.createAnalyser();
      analyser.fftSize = fftSize;
      node.connect(analyser);
      return analyser;
    };
    const masterA = window.audioProbe.masterGains.find(gain => gain.probeDeckIndex === 0);
    const masterB = window.audioProbe.masterGains.find(gain => gain.probeDeckIndex === 1);
    if (!masterA || !masterB) return false;
    const probe = {
      contextA,
      contextB,
      channelA: sourceFor("a-vocals").inputNode.nextNode,
      channelB: sourceB.inputNode.nextNode,
      originalA: analyserFor(sourceA, 16_384),
      originalB: analyserFor(sourceB, 16_384),
      outputA: analyserFor(masterA, 2_048),
      outputB: analyserFor(masterB, 2_048),
      outputRms: [],
    };
    window.transitionPitchProbe = probe;
    window.startTransitionOutputSampling = () => {
      probe.outputRms = [];
      const left = new Float32Array(probe.outputA.fftSize);
      const right = new Float32Array(probe.outputB.fftSize);
      window.transitionOutputTimer = setInterval(() => {
        probe.outputA.getFloatTimeDomainData(left);
        probe.outputB.getFloatTimeDomainData(right);
        const rms = data => Math.sqrt(data.reduce((sum, sample) => sum + sample * sample, 0) / data.length);
        probe.outputRms.push(Math.hypot(rms(left), rms(right)));
      }, 20);
    };
    window.stopTransitionOutputSampling = () => clearInterval(window.transitionOutputTimer);
    return true;
  });
  assert.equal(transitionProbeReady, true, "both decks expose real source and output audio graphs during the mix");
  const deckClocksBeforePitchToggle = await page.evaluate(() => {
    const deckClock = deck => document.querySelector(`[data-testid="session-deck-${deck}"] audio`)?.currentTime ?? null;
    return { a: deckClock("a"), b: deckClock("b") };
  });
  const pitchTransitionStartedAt = Date.now();
  await page.evaluate(() => window.startTransitionOutputSampling());
  await page.locator('[data-role="current"] [data-testid="session-pitch-lock"]').click();
  await page.waitForFunction(() =>
    document.querySelector('[data-role="current"] [data-testid="session-pitch-lock"]')
      ?.getAttribute("aria-pressed") === "true",
  );
const transitionDonorWorkletsReady = await page.waitForFunction(() => {
    const probe = window.transitionPitchProbe;
    return window.audioProbe.worklets.some(node =>
      node.probeConnections.some(input => input.nextNode === probe.channelA))
      && window.audioProbe.worklets.some(node =>
        node.probeConnections.some(input => input.nextNode === probe.channelB))
      && [...document.querySelectorAll('[data-testid="session-deck-a"] audio, [data-testid="session-deck-b"] audio')]
        .every(audio => audio.preservesPitch === true);
}, undefined, { timeout: 4_000 }).then(() => true, () => false);
if (!transitionDonorWorkletsReady && engineName === "webkit") {
  const fallbackTransitionState = await page.evaluate(() => {
    const probe = window.transitionPitchProbe;
    const deck = name => [...document.querySelectorAll(`[data-testid="session-deck-${name}"] audio`)];
    const audios = [...deck("a"), ...deck("b")];
    return {
      pressed: document.querySelector('[data-role="current"] [data-testid="session-pitch-lock"]')
        ?.getAttribute("aria-pressed"),
      speed: document.querySelector('[data-role="current"] [data-testid="session-speed-value"]')?.textContent,
      pitchFlags: audios.map(audio => audio.preservesPitch),
      playbackRates: audios.map(audio => audio.playbackRate),
      playing: ["a", "b"].map(name => deck(name).length === 4 && deck(name).every(audio => !audio.paused)),
      outputRms: [...probe.outputRms],
      matchingWorklets: ["a", "b"].map(key => window.audioProbe.worklets.some(node =>
        node.probeConnections.some(input => input.nextNode === probe[`channel${key.toUpperCase()}`]))),
    };
  });
  pitchModeMismatches.push({
    mode: "live donor processing during dual-deck pitch transition",
    measured: fallbackTransitionState,
    browserVersion: browser.version(),
  });
  assert.equal(fallbackTransitionState.pressed, "true");
  assert.equal(fallbackTransitionState.speed, "1.10×");
  assert.equal(fallbackTransitionState.pitchFlags.length, 8);
  assert.ok(fallbackTransitionState.pitchFlags.every(Boolean));
  assert.ok(fallbackTransitionState.playbackRates.every(rate => Math.abs(rate - 1.1) < 0.001));
  await page.evaluate(() => window.stopTransitionOutputSampling());
  if (engineName === "webkit") {
    console.log("UNSUPPORTED_BROWSER_BEHAVIOR", JSON.stringify({
      engine: engineName,
      browserVersion: browser.version(),
      mobileEmulation: true,
      physicalDevice: false,
      observations: pitchModeMismatches,
    }));
    await browser.close();
    process.exit(0);
  }
} else {
  assert.equal(transitionDonorWorkletsReady, true,
    "both decks install their pitch-preserving donors during a live transition");
  await page.waitForTimeout(450);
  const transitionPitchState = await page.evaluate(() => {
    const probe = window.transitionPitchProbe;
    const activeWorkletFor = channel => [...window.audioProbe.worklets].reverse().find(node =>
      node.probeConnections.some(input => input.nextNode === channel));
    const workletA = activeWorkletFor(probe.channelA);
    const workletB = activeWorkletFor(probe.channelB);
    if (!workletA || !workletB) return null;
    const frequency = analyser => {
      const data = new Float32Array(analyser.fftSize);
      analyser.getFloatTimeDomainData(data);
      const crossings = [];
      for (let index = 1; index < data.length; index += 1) {
        const previous = data[index - 1], current = data[index];
        if (previous <= 0 && current > 0) crossings.push(index - 1 + (-previous / (current - previous)));
      }
      return crossings.length < 2
        ? 0
        : analyser.context.sampleRate * (crossings.length - 1) / (crossings.at(-1) - crossings[0]);
    };
    const alignment = (worklet, recipientAsset, duration) => {
      const seek = [...window.audioProbe.workletSeeks].reverse().find(entry => entry.node === worklet);
      const media = [...document.querySelectorAll("audio")].find(audio =>
        audio.currentSrc.endsWith(`/${recipientAsset}`));
      if (!seek || !media || duration <= 0) return null;
      const expected = (seek.frame / worklet.context.sampleRate
        + (worklet.context.currentTime - seek.contextTime) * media.playbackRate) % duration;
      const actual = media.currentTime % duration;
      const direct = Math.abs(expected - actual);
      return Math.min(direct, duration - direct);
    };
    const durationFor = worklet => [...window.audioProbe.workletLoads].reverse()
      .find(entry => entry.node === worklet)?.duration ?? 0;
    return {
      pressed: document.querySelector('[data-role="current"] [data-testid="session-pitch-lock"]')
        ?.getAttribute("aria-pressed"),
      speed: document.querySelector('[data-role="current"] [data-testid="session-speed-value"]')?.textContent,
      nativePitchFlags: [...document.querySelectorAll(
        '[data-testid="session-deck-a"] audio, [data-testid="session-deck-b"] audio',
      )].map(audio => audio.preservesPitch),
      playbackRates: [...document.querySelectorAll(
        '[data-testid="session-deck-a"] audio, [data-testid="session-deck-b"] audio',
      )].map(audio => audio.playbackRate),
      sourceHzA: frequency(probe.originalA),
      sourceHzB: frequency(probe.originalB),
      alignmentA: alignment(workletA, "a-vocals", durationFor(workletA)),
      alignmentB: alignment(workletB, "b-drums", durationFor(workletB)),
      clocks: {
        a: document.querySelector('[data-testid="session-deck-a"] audio')?.currentTime ?? null,
        b: document.querySelector('[data-testid="session-deck-b"] audio')?.currentTime ?? null,
      },
      outputRms: [...probe.outputRms],
      decksPlaying: ["a", "b"].map(deck => [...document.querySelectorAll(
        `[data-testid="session-deck-${deck}"] audio`,
      )].every(audio => !audio.paused)),
      worklets: window.audioProbe.workletLoads.map(entry => ({
        deck: entry.node === workletA ? "a" : entry.node === workletB ? "b" : "other",
        duration: entry.duration,
        channelCount: entry.channelCount,
        pitchPreserving: entry.pitchPreserving,
        inputHz: entry.inputHz,
      })),
    };
  });
  await page.evaluate(() => window.stopTransitionOutputSampling());
  const transitionPitchElapsed = (Date.now() - pitchTransitionStartedAt) / 1000;
  assert.equal(transitionPitchState.pressed, "true", "pitch mode stays enabled through the live fade");
  assert.equal(transitionPitchState.speed, "1.10×", "the selected speed survives the pitch-mode change");
  assert.equal(transitionPitchState.nativePitchFlags.length, 8);
  assert.ok(transitionPitchState.nativePitchFlags.every(Boolean),
    `both decks keep native pitch preservation enabled: ${JSON.stringify(transitionPitchState.nativePitchFlags)}`);
  assert.ok(transitionPitchState.playbackRates.every(rate => Math.abs(rate - 1.1) < 0.001),
    `both decks keep the selected varispeed: ${JSON.stringify(transitionPitchState.playbackRates)}`);
  const originalDecksRetainPitch = Math.abs(transitionPitchState.sourceHzA - 170) < 8
    && Math.abs(transitionPitchState.sourceHzB - 270) < 8;
  if (!originalDecksRetainPitch && engineName === "webkit") {
    pitchModeMismatches.push({
      mode: "pitch-lock across a live deck transition",
      rate: 1.1,
      measured: { originalDeckAHz: transitionPitchState.sourceHzA, originalDeckBHz: transitionPitchState.sourceHzB },
      expected: { originalDeckAHz: 170, originalDeckBHz: 270 },
      state: await readPitchModeState(),
    });
  } else {
    assert.ok(originalDecksRetainPitch,
      `both original decks retain source-frequency behavior: ${JSON.stringify(transitionPitchState)}`);
  }
  const donorPcmEvidence = transitionPitchState.worklets.filter(worklet =>
    worklet.deck === "a" || worklet.deck === "b");
  assert.equal(donorPcmEvidence.length, 2, "each deck loads its own live donor into a pitch-preserving worklet");
  assert.ok(donorPcmEvidence.every(worklet => worklet.pitchPreserving),
    `pitch-preserving processing is enabled for both donors: ${JSON.stringify(donorPcmEvidence)}`);
  assert.ok(Math.abs(donorPcmEvidence.find(worklet => worklet.deck === "a").inputHz - 230) < 4
    && Math.abs(donorPcmEvidence.find(worklet => worklet.deck === "b").inputHz - 370) < 4,
  `both donor inputs retain their selected source frequencies: ${JSON.stringify(donorPcmEvidence)}`);
  assert.ok(transitionPitchState.alignmentA !== null && transitionPitchState.alignmentA < 0.18
    && transitionPitchState.alignmentB !== null && transitionPitchState.alignmentB < 0.18,
  `both prepared donors remain aligned to their own deck clocks: ${JSON.stringify({
    a: transitionPitchState.alignmentA,
    b: transitionPitchState.alignmentB,
  })}`);
  assert.ok(Math.abs((transitionPitchState.clocks.a - deckClocksBeforePitchToggle.a)
      - transitionPitchElapsed * 1.1) < 0.4
    && Math.abs((transitionPitchState.clocks.b - deckClocksBeforePitchToggle.b)
      - transitionPitchElapsed * 1.1) < 0.4,
  `pitch toggle leaves both running deck clocks continuous: ${JSON.stringify({
    before: deckClocksBeforePitchToggle,
    after: transitionPitchState.clocks,
    elapsed: transitionPitchElapsed,
  })}`);
  assert.ok(transitionPitchState.outputRms.length >= 8
    && transitionPitchState.outputRms.every(rms => rms > 0.0001),
  `combined deck output remains audible during pitch migration: ${JSON.stringify(transitionPitchState.outputRms)}`);
  assert.deepEqual(transitionPitchState.decksPlaying, [true, true],
    "both decks keep playing while the mix is in progress");
}
  await page.getByRole("button", { name: "Finish", exact: true }).click();
  await page.waitForFunction(() =>
    document.querySelector('[data-role="current"] h3')?.textContent === "Test b"
      && document.querySelector('[data-testid="session-play"]')?.getAttribute("aria-pressed") === "true",
  );
  await page.waitForFunction(() =>
    [...document.querySelectorAll('[data-testid="session-deck-a"] audio, [data-testid="session-deck-b"] audio')]
      .length === 8
      && [...document.querySelectorAll('[data-testid="session-deck-a"] audio, [data-testid="session-deck-b"] audio')]
        .every(audio => audio.preservesPitch === true),
  );
  assert.equal(await page.locator('[data-role="current"] [data-testid="session-pitch-lock"]').getAttribute("aria-pressed"),
    "true", "pitch mode remains selected after the incoming deck becomes current");
  assert.equal(await page.locator('[data-role="current"] [data-testid="session-speed-value"]').innerText(),
    "1.10×", "the incoming deck keeps the selected speed after transition completion");
  assert.ok(await page.locator('[data-role="current"] audio').evaluateAll(elements =>
    elements.every(audio => !audio.paused)),
  "the incoming deck continues audible playback after the transition is completed");
  assert.ok(await page.evaluate(() => {
    const audio = document.querySelector('[data-role="current"] audio');
    const currentContext = window.audioProbe.sources.find(source => source.mediaElement === audio)?.context;
    return currentContext && window.audioProbe.worklets.some(node =>
      node.context === currentContext && node.probeConnections.length > 0);
  }),
  "the incoming track's prepared donor stays in its pitch-preserving live graph");
  console.log("PASS: pitch mode, donor clocks, source frequencies, and audible output stay aligned across a live deck transition");
  Object.assign(session, pitchTransitionBaseline);
  exposeSeparatedSource = pitchTransitionExposeSeparatedSource;
  if (pitchModesOnly) {
    if (pitchModeMismatches.length > 0) {
      console.log("UNSUPPORTED_BROWSER_BEHAVIOR", JSON.stringify({
        engine: engineName,
        browserVersion: browser.version(),
        mobileEmulation: true,
        physicalDevice: false,
        observations: pitchModeMismatches,
      }));
    }
    await browser.close();
    process.exit(0);
  }
  await page.goto(`http://localhost:80/waveyard/session/${sessionId}`);
  current = page.locator('[data-role="current"]');
  await current.getByText("Test a", { exact: true }).waitFor();
  await page.waitForFunction(() => {
    const audio = [...document.querySelectorAll('[data-role="current"] audio')];
    return audio.length === 4 && audio.every(element => element.readyState === 4);
  });
  if (await current.locator("audio").first().evaluate(audio => audio.paused)) await toggle();

  await current.getByTestId("restore-live-swap-vocals").click();
  await page.waitForTimeout(400);
  const originalGain = await page.evaluate((trackId) =>
    window.audioProbe.sources.find(s => s.mediaElement.src.endsWith(`/${trackId}-vocals`)).inputNode.gain.value,
  tempoCurrentTrack.id);
  assert.equal(originalGain, 1);
  const beforeDonorRoundTrip = await page.evaluate(() => {
    window.liveStemAssetFetchTrace.length = 0;
    return window.audioProbe.buffers.length;
  });
  await chooseLiveSource("vocals", "c");
  await page.waitForFunction(before => window.audioProbe.buffers.length > before, beforeDonorRoundTrip);
  await page.evaluate(() => {
    window.firstRecentDonorBuffer = window.audioProbe.buffers.at(-1).buffer;
    window.firstRecentDonorFetchCount = window.liveStemAssetFetchTrace
      .filter(path => path === "/api/assets/c-vocals").length;
  });
  const beforeIntermediateDonor = await page.evaluate(() => window.audioProbe.buffers.length);
  await chooseLiveSource("vocals", "b");
  await page.waitForFunction(before => window.audioProbe.buffers.length > before, beforeIntermediateDonor);
  const beforeReturnToDonor = await page.evaluate(() => window.audioProbe.buffers.length);
  await chooseLiveSource("vocals", "c");
  await page.waitForFunction(before => window.audioProbe.buffers.length > before, beforeReturnToDonor);
  const donorRoundTrip = await page.evaluate(() => ({
    reusedBuffer: window.audioProbe.buffers.at(-1).buffer === window.firstRecentDonorBuffer,
    donorFetchCount: window.liveStemAssetFetchTrace.filter(path => path === "/api/assets/c-vocals").length,
    firstSelectionFetchCount: window.firstRecentDonorFetchCount,
  }));
  assert.equal(donorRoundTrip.reusedBuffer, true, "returning to donor C reuses the prepared AudioBuffer");
  assert.equal(donorRoundTrip.donorFetchCount, donorRoundTrip.firstSelectionFetchCount,
    "returning to donor C does not download it again");
  const wasPlayingBeforeFourSwaps = await current.locator("audio").first().evaluate(audio => !audio.paused);
  if (wasPlayingBeforeFourSwaps) await toggle();
  for (const type of types) {
    const donorId = session.currentSessionTrackId === "b" ? "a" : "b";
    await chooseLiveSource(type, donorId);
    await page.waitForFunction((stemType) => {
      const trigger = document.querySelector(`[data-testid="open-live-swap-${stemType}"]`);
      return trigger instanceof HTMLButtonElement && !trigger.disabled;
    }, type);
  }
  await page.waitForTimeout(300);
  await seek.fill(String(followSeekSeconds));
  await toggle();
  const donorResume = await page.evaluate(() => ({
    sources: window.audioProbe.buffers.slice(-4).map(b => ({
      offset: b.startedOffset, recipientTimeAtStart: b.recipientTimeAtStart,
      duration: b.buffer.duration,
    })),
  }));
  const loopOffsetError = (offset, recipientTime, duration) => {
    const actual = ((offset % duration) + duration) % duration;
    const expected = ((recipientTime % duration) + duration) % duration;
    const difference = Math.abs(actual - expected);
    return Math.min(difference, duration - difference);
  };
  assert.ok(donorResume.sources.every(source =>
    Number.isFinite(source.recipientTimeAtStart) && loopOffsetError(source.offset, source.recipientTimeAtStart, source.duration) < 0.15),
    `all four donors must follow original clock modulo duration: ${JSON.stringify(donorResume)}`);
  const buffersBeforeExternalSwap = await page.evaluate(() => window.audioProbe.buffers.length);
  liveSwapRequestOrder.length = 0;
  await page.evaluate(() => { window.liveAssetFetchTrace.length = 0; });
  let releaseExternalDonorSave;
  externalDonorSaveGate = new Promise(resolve => { releaseExternalDonorSave = resolve; });
  const externalSaveStarted = new Promise(resolve => { signalExternalDonorSave = resolve; });
  const externalWarmStarted = new Promise(resolve => { signalExternalDonorWarm = resolve; });
  await current.getByTestId("open-live-swap-vocals").click();
  const unknownAnalysisDonor = current.getByTestId("live-swap-candidate-vocals-d");
  assert.match(await unknownAnalysisDonor.getAttribute("aria-label"), /BPM unknown; Key unknown/,
    "the picker labels absent donor analysis instead of implying compatibility");
  await unknownAnalysisDonor.click();
  try {
    await waitForSignal(externalSaveStarted, "the external donor save request");
    await waitForSignal(externalWarmStarted, "the external library donor audio preload");
    assert.ok(liveSwapRequestOrder.includes("donor-preload:d-vocals"),
      "a library donor begins preloading before the save response completes");
    assert.equal(liveSwapRequestOrder.includes("save-complete:d"), false,
      "the save response is still held while the donor audio warms");
  } finally {
    externalDonorSaveGate = null;
    releaseExternalDonorSave();
    signalExternalDonorSave = undefined;
    signalExternalDonorWarm = undefined;
  }
  await page.waitForFunction(({ beforeCount, minTime }) => window.audioProbe.buffers.length > beforeCount &&
    [...document.querySelectorAll('[data-role="current"] audio')].every(a => a.currentTime > minTime),
  { beforeCount: buffersBeforeExternalSwap, minTime: Math.max(0, followSeekSeconds - 0.5) });
  const activePageDonorFetchCount = await page.evaluate(() => window.liveAssetFetchTrace.length);
  assert.equal(activePageDonorFetchCount, 1,
    `the active tab reuses its warm donor rather than downloading it again after save: ${JSON.stringify(liveSwapRequestOrder)}`);
  assert.equal(session.swaps.find(s => s.stemType === "vocals").toTrackId, "d", "library donor is saved without being added to the session queue");
  const externalResume = await page.evaluate(() => ({
    offset: window.audioProbe.buffers.at(-1).startedOffset,
    recipientTimeAtStart: window.audioProbe.buffers.at(-1).recipientTimeAtStart,
  }));
  const externalOffsetError = loopOffsetError(externalResume.offset, externalResume.recipientTimeAtStart, 4);
  assert.ok(Number.isFinite(externalResume.recipientTimeAtStart) && externalOffsetError < 0.15,
    `external library donor follows recipient clock: ${JSON.stringify(externalResume)}`);
  assert.equal(await current.getByTestId("live-stem-tempo-vocals").innerText(),
    "Tempo unavailable · native tempo", "missing BPM is shown honestly instead of implying tempo sync");
  // Several preceding checks intentionally play real browser audio and can
  // outlast the short synthetic queue. Rebase this failure assertion on a
  // fresh recipient so the retry control is not racing an automatic advance.
  session.currentSessionTrackId = "a";
  session.positionSeconds = 0;
  session.swaps = [];
  await page.goto(`http://localhost:80/waveyard/session/${sessionId}`);
  await page.waitForFunction(() => {
    const audio = [...document.querySelectorAll('[data-role="current"] audio')];
    return audio.length === 4 && audio.every(element =>
      element.readyState === 4 && new URL(element.src).pathname.includes("/a-"),
    );
  }, { timeout: 10_000 });
  current = page.locator('[data-role="current"]');
  if (await current.locator("audio").first().evaluate(audio => audio.paused)) await toggle();
  const failedDonorId = session.currentSessionTrackId === "c" ? "a" : "c";
  failAsset = `${failedDonorId}-bass`;
  await chooseLiveSource("bass", failedDonorId);
  await current.getByRole("alert").filter({ hasText: /previous layer was kept/ }).waitFor({ timeout: 10_000 });
  failAsset = null;
  await current.getByText("Retry live stems", { exact: true }).click();
  await page.waitForFunction(() => !document.querySelector('[data-role="current"] [role="alert"]'));
  if (await current.locator("audio").first().evaluate(audio => !audio.paused)) await toggle();
  for (let steps = 0; steps < session.tracks.length && session.currentSessionTrackId !== "a"; steps += 1) {
    const index = session.tracks.findIndex(item => item.id === session.currentSessionTrackId);
    const previousItem = session.tracks[(index - 1 + session.tracks.length) % session.tracks.length];
    await page.getByRole("button", { name: "Previous track", exact: true }).click();
    await current.getByText(previousItem.track.title, { exact: true }).waitFor();
  }
  assert.equal(session.currentSessionTrackId, "a", "the cross-tab transition check starts from the first session entry");
  await secondPage.goto(`http://localhost:80/waveyard/session/${sessionId}`);
  await secondPage.waitForFunction(() =>
    document.querySelector('[data-role="current"] h3')?.textContent?.trim() === "Test a");
  await secondPage.waitForFunction(() => {
    const audio = [...document.querySelectorAll('[data-role="current"] audio')];
    return audio.length === 4 && audio.every(element => element.paused);
  });
  await page.getByTestId("session-transition").click();
  const transitionMode = page.getByLabel("Mode");
  assert.deepEqual(
    await transitionMode.locator("option").evaluateAll(options => options.map(option => option.value)),
    ["manual", "beat", "bar"],
    "the transition selector must not offer the stored-only meeting-point mode",
  );
  await page.getByRole("button", { name: "Finish", exact: true }).click();
  await secondPage.waitForFunction(() => document.querySelector('[data-role="current"]')?.textContent.includes("Test c"));
  assert.ok(await secondPage.evaluate(() => [...document.querySelectorAll('[data-role="current"] audio')].every(a => a.paused)),
    "a track change mirrors to the other tab without starting duplicate audio");
  const primaryPlayControl = page.getByTestId("session-play");
  if (await primaryPlayControl.getAttribute("aria-pressed") !== "false") {
    await primaryPlayControl.click();
  }
  await page.waitForFunction(() => document.querySelector('[data-testid="session-play"]')?.getAttribute("aria-pressed") === "false");
  await secondPage.waitForFunction(() => document.querySelector('[data-testid="session-play"]')?.getAttribute("aria-pressed") === "false");
  await primaryPlayControl.click();
  await page.waitForFunction(() => document.querySelector('[data-testid="session-play"]')?.getAttribute("aria-pressed") === "true");
  // The hidden tab's requestAnimationFrame polling is suspended in Chromium.
  // Bring it forward after the cross-tab message arrives before asserting its
  // rendered control state; this tests transport sync rather than RAF throttling.
  await secondPage.bringToFront();
  try {
    await secondPage.waitForFunction(() => document.querySelector('[data-testid="session-play"]')?.getAttribute("aria-pressed") === "true");
  } catch (error) {
    const mirrorState = await secondPage.evaluate(() => ({
      pressed: document.querySelector('[data-testid="session-play"]')?.getAttribute("aria-pressed"),
      currentTrack: document.querySelector('[data-role="current"]')?.textContent?.trim(),
      audio: [...document.querySelectorAll('[data-role="current"] audio')].map(element => ({
        paused: element.paused,
        currentTime: element.currentTime,
      })),
      bodyText: document.body.innerText.slice(-1200),
    }));
    console.error("CROSS_TAB_MIRROR_STATE", JSON.stringify(mirrorState));
    throw error;
  }
  await secondPage.getByTestId("session-play").click();
  await page.bringToFront();
  await page.waitForFunction(() => document.querySelector('[data-testid="session-play"]')?.getAttribute("aria-pressed") === "false");
  await page.waitForFunction(() => [...document.querySelectorAll('[data-role="current"] audio')].every(element => element.paused));
  assert.ok(await page.evaluate(() => [...document.querySelectorAll('[data-role="current"] audio')].every(a => a.paused)),
    "a pause command in the mirror tab pauses the active tab");
  await secondPage.close();

  // Keep the long deadline's reload/wait independent of the mirror fixture.
  await verifyStemSwitchRecovery();
  await verifyCrossTabStemSwitchRecovery();

  // Auto-crossfade must start from the configured end window, preserve the
  // equal-power incoming level, and advance without a manual Mix/Finish click.
  session.tracks = tracks;
  session.swaps = [];
  session.currentSessionTrackId = "a";
  session.positionSeconds = 0;
  exposeSeparatedSource = false;
  showSeparationProgress = false;
  await page.goto(`http://localhost:80/waveyard/session/${sessionId}`);
  await page.waitForFunction(() => [...document.querySelectorAll('[data-role="current"] audio')].length === 4 &&
    [...document.querySelectorAll('[data-role="current"] audio')].every(a => a.readyState === 4));
  current = page.locator('[data-role="current"]');
  const autoCrossfade = page.getByTestId("session-auto-crossfade");
  await autoCrossfade.check();
  await toggle();
  await current.getByTestId("seek-deck-0").fill("18");
  const finishAutoFade = page.getByRole("button", { name: "Finish", exact: true });
  await finishAutoFade.waitFor({ timeout: 5000 });
  await page.waitForFunction(
    () => window.audioProbe.masterGains.some(node => node.gain.value > 0.55 && node.gain.value < 0.85),
    null,
    { timeout: 5000 },
  );
  const midFadeMasterGains = await page.evaluate(() => window.audioProbe.masterGains.map(node => node.gain.value));
  const incomingMasterGain = midFadeMasterGains.find(gain => gain > 0.55 && gain < 0.85);
  assert.ok(incomingMasterGain !== undefined,
    `the incoming deck should be at its equal-power mid-fade level: ${JSON.stringify(midFadeMasterGains)}`);
  await finishAutoFade.waitFor({ state: "detached", timeout: 5000 });
  await page.waitForFunction(() => document.querySelector('[data-role="current"]')?.textContent.includes("Test b"));
  await autoCrossfade.uncheck();
  console.log("PASS: auto-crossfade reaches its equal-power fade and advances to the next separated track.");

  // A source-only deck can start separation from the mixer and keep playing.
  session.tracks = [sourceOnlyTrack];
  session.swaps = [];
  session.currentSessionTrackId = "a";
  session.positionSeconds = 0;
  exposeSeparatedSource = false;
  showSeparationProgress = false;
  unstartedCurrentSessionTrack = true;
  currentSessionSeparationRequests = 0;
  await page.goto(`http://localhost:80/waveyard/session/${sessionId}`);
  await page.waitForFunction(() => {
    const audio = document.querySelector('[data-role="current"] audio');
    return audio?.src.endsWith("/a-source") && audio.readyState >= 2;
  });
  current = page.locator('[data-role="current"]');
  await toggle();
  await current.getByTestId("seek-deck-0").fill("2");
  await page.waitForTimeout(150);
  const currentSeparationButton = page.getByTestId("button-start-session-separation-a");
  await currentSeparationButton.waitFor();
  const playbackBeforeCurrentSeparation = await current.locator('audio[data-waveyard-fixture-src$="/a-source"]').evaluate(audio => audio.currentTime);
  await currentSeparationButton.click();
  assert.equal(currentSessionSeparationRequests, 1, "the currently playing source can start separation in the mixer");
  await page.waitForFunction(before => {
    const audio = document.querySelector('[data-role="current"] audio[data-waveyard-fixture-src$="/a-source"]');
    return audio instanceof HTMLAudioElement && !audio.paused && audio.currentTime > before + 0.2;
  }, playbackBeforeCurrentSeparation, { timeout: 5_000 });
  await page.getByTestId("session-separation-progress-a").waitFor();
  await currentSeparationButton.waitFor({ state: "detached" });
  await toggle();
  await page.reload();
  await page.waitForFunction(() => {
    const audio = document.querySelector('[data-role="current"] audio');
    return audio?.src.endsWith("/a-source") && audio.readyState >= 2;
  });
  current = page.locator('[data-role="current"]');
  if (await current.locator('audio[data-waveyard-fixture-src$="/a-source"]').evaluate(audio => audio.paused)) await toggle();
  await current.getByTestId("seek-deck-0").fill("2");
  await page.getByTestId("session-separation-progress-a")
    .filter({ hasText: /2\/4/ })
    .waitFor({ timeout: 5_000 });
  exposeSeparatedSource = true;
  showSeparationProgress = false;
  unstartedCurrentSessionTrack = false;
  const switchButton = page.getByTestId("button-switch-stems-a");
  await switchButton.waitFor({ timeout: 15000 });

  failAsset = "a-bass";
  await switchButton.click();
  const handoffFailureStatus = page.getByTestId("session-status").filter({ hasText: /original track .*playing/i });
  await handoffFailureStatus.waitFor();
  assert.match(await handoffFailureStatus.textContent(), /original track (?:keeps|is still) playing/i);
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
  assert.ok(Math.abs(await page.evaluate(() => window.audioProbe.currentMasterGain()) - 0.63) < 0.01,
    "the live master gain matches its control before returning");
  await current.getByLabel("Snap stem changes", { exact: true }).selectOption("off");
  const vocalsLevel = current.getByLabel("vocals level, current deck", { exact: true });
  await vocalsLevel.evaluate(element => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set;
    setter.call(element, "0.37");
    element.dispatchEvent(new Event("input", { bubbles: true }));
    element.dispatchEvent(new Event("change", { bubbles: true }));
  });
  assert.equal(await vocalsLevel.inputValue(), "0.37", "the distinctive vocals level is set before returning");
  const drumsLevel = current.getByLabel("drums level, current deck", { exact: true });
  await drumsLevel.evaluate(element => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set;
    setter.call(element, "0.61");
    element.dispatchEvent(new Event("input", { bubbles: true }));
    element.dispatchEvent(new Event("change", { bubbles: true }));
  });
  assert.equal(await drumsLevel.inputValue(), "0.61", "the distinctive drums level is set before muting");
  await current.getByLabel("Mute drums", { exact: true }).click();
  await page.waitForFunction(() => {
    const gain = type => window.audioProbe.currentStemGain(type);
    return Math.abs(gain("vocals") - 0.37) < 0.01 && gain("drums") < 0.01;
  });
  assert.equal(await current.getByLabel("Mute drums", { exact: true }).getAttribute("aria-pressed"), "true",
    "drums are muted before returning to the full track");
  const beforeReturn = await current.locator("audio").evaluateAll(elements => Math.max(...elements.map(element => element.currentTime)));
  const returnStartedAt = Date.now();
  let notifyHeldRequest;
  const heldRequest = new Promise(resolve => { notifyHeldRequest = resolve; });
  let releaseHeldRequest;
  heldAssetGate = new Promise(resolve => { releaseHeldRequest = resolve; });
  heldAssetId = "a-source";
  signalHeldAssetRequest = notifyHeldRequest;
  await page.getByTestId("button-return-full-track-a").click();
  await waitForSignal(heldRequest, "the original-track source request during return-to-track");
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
  assert.ok(Math.abs(await page.evaluate(() => window.audioProbe.currentMasterGain()) - 0.63) < 0.01,
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
  assert.ok(Math.abs(await page.evaluate(() => window.audioProbe.currentMasterGain()) - 0.63) < 0.01,
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

  const beforeStemsSwitch = await current.locator("audio").evaluate(element => element.currentTime);
  const stemsSwitchStartedAt = Date.now();
  await page.getByTestId("button-switch-stems-a").click();
  await page.waitForFunction(() => {
    const audio = [...document.querySelectorAll('[data-role="current"] audio')];
    return audio.length === 4 && audio.every(element => !element.paused && element.src.includes("/a-"));
  });
  const afterStemsSwitch = await current.locator("audio").evaluateAll(elements => elements.map(element => element.currentTime));
  const expectedStemsPosition = beforeStemsSwitch + (Date.now() - stemsSwitchStartedAt) / 1000;
  assert.ok(afterStemsSwitch.every(time => Math.abs(time - expectedStemsPosition) < 0.5),
    `switching back to stems preserves the live playhead; expected ${expectedStemsPosition}, received ${afterStemsSwitch}`);
  assert.equal(await current.getByLabel("vocals level, current deck", { exact: true }).inputValue(), "0.37",
    "switching back to stems restores the vocals fader");
  assert.equal(await current.getByLabel("drums level, current deck", { exact: true }).inputValue(), "0",
    "the muted drums fader remains at zero after switching back to stems");
  assert.equal(await current.getByLabel("Mute drums", { exact: true }).getAttribute("aria-pressed"), "true",
    "switching back to stems restores the muted drums state");
  assert.ok(Math.abs(await page.evaluate(() => window.audioProbe.currentMasterGain()) - 0.63) < 0.01,
    "switching back to stems preserves the master gain");
  await page.waitForFunction(() => {
    const gain = type => window.audioProbe.currentStemGain(type);
    return Math.abs(gain("vocals") - 0.37) < 0.01 && gain("drums") < 0.01 &&
      gain("bass") > 0.9 && gain("other") > 0.9;
  });
  assert.equal(session.tracks.find(item => item.id === "a").stemMix.vocals, 0.37,
    "the distinctive vocals level remains saved on the session track");
  assert.equal(session.tracks.find(item => item.id === "a").stemMix.drums, 0,
    "the muted drums level remains saved on the session track");
  for (let attempt = 0; attempt < 40 && session.tracks.find(item => item.id === "a")?.transition.performance?.recall?.drums !== 0.61; attempt += 1) {
    await page.waitForTimeout(50);
  }
  assert.equal(session.tracks.find(item => item.id === "a").transition.performance.recall.drums, 0.61,
    "the muted drums fader's prior level is saved for recall");

  await page.reload({ waitUntil: "domcontentloaded" });
  current = page.locator('[data-role="current"]');
  await page.waitForFunction(() => {
    const audio = [...document.querySelectorAll('[data-role="current"] audio')];
    return audio.length === 4 && audio.every(element => element.readyState === 4);
  });
  if (await page.getByTestId("session-play").getAttribute("aria-pressed") !== "true") {
    await page.getByTestId("session-play").click();
    await page.waitForFunction(() => document.querySelector('[data-testid="session-play"]')?.getAttribute("aria-pressed") === "true");
  }
  const reloadedVocalsLevel = current.getByLabel("vocals level, current deck", { exact: true });
  const reloadedDrumsLevel = current.getByLabel("drums level, current deck", { exact: true });
  try {
    await page.waitForFunction(() => {
      const gain = type => window.audioProbe.currentStemGain(type);
      return Math.abs(gain("vocals") - 0.37) < 0.01 && gain("drums") < 0.01;
    });
  } catch (error) {
    const snapshot = await page.evaluate(() => {
      const deck = document.querySelector('[data-role="current"]');
      return {
        controls: [...(deck?.querySelectorAll('input[type="range"]') ?? [])]
          .map(input => ({ label: input.getAttribute("aria-label"), value: input.value })),
        audio: [...(deck?.querySelectorAll("audio") ?? [])]
          .map(element => ({ src: element.src, paused: element.paused, readyState: element.readyState, currentTime: element.currentTime })),
        gains: window.audioProbe.sources.map(source => ({
          src: source.mediaElement.src,
          inCurrentDeck: source.mediaElement.closest('[data-role="current"]') !== null,
          nextNode: source.inputNode?.nextNode?.constructor?.name ?? null,
          gain: source.inputNode?.nextNode?.gain?.value ?? null,
        })),
        contexts: window.audioProbe.contexts.map(context => context.state),
      };
    });
    throw new Error(
      `Reloaded UI/audio state did not restore the saved stem gains: ${JSON.stringify({
        snapshot,
        savedMix: session.tracks.find(item => item.id === "a")?.stemMix,
      })}`,
      { cause: error },
    );
  }
  assert.equal(await reloadedVocalsLevel.inputValue(), "0.37",
    "reopening the session restores the distinctive vocals fader");
  assert.equal(await reloadedDrumsLevel.inputValue(), "0",
    "reopening the session restores the muted drums fader");
  assert.equal(await current.getByLabel("Mute drums", { exact: true }).getAttribute("aria-pressed"), "true",
    "reopening the session restores the drums mute state");
  assert.equal(session.tracks.find(item => item.id === "a").stemMix.vocals, 0.37,
    "the reopened session retains the saved vocals level");
  assert.equal(session.tracks.find(item => item.id === "a").stemMix.drums, 0,
    "the reopened session retains the saved drums mute");

  await current.getByLabel("Mute drums", { exact: true }).click();
  await page.waitForFunction(() => {
    const gain = window.audioProbe.currentStemGain("drums");
    return Math.abs(gain - 0.61) < 0.01;
  });
  assert.equal(await reloadedDrumsLevel.inputValue(), "0.61",
    "unmuting after reopening recalls the prior drums fader level");
  assert.equal(await current.getByLabel("Mute drums", { exact: true }).getAttribute("aria-pressed"), "false",
    "the drums mute control clears after restoring its saved level");
  for (let attempt = 0; attempt < 40 && session.tracks.find(item => item.id === "a")?.stemMix.drums !== 0.61; attempt += 1) {
    await page.waitForTimeout(50);
  }
  assert.equal(session.tracks.find(item => item.id === "a").stemMix.drums, 0.61,
    "unmuting saves the recalled drums level back to the session track");

  const beforeFailedReturn = await current.locator("audio").evaluateAll(elements => Math.max(...elements.map(element => element.currentTime)));
  failedAssetRequests = 0;
  failAsset = "a-source";
  await page.getByTestId("button-return-full-track-a").click();
  let sourceFailureText;
  try {
    const failureHandle = await page.waitForFunction(() => {
      const messages = [...document.querySelectorAll('[role="alert"], [data-testid="session-status"]')]
        .map(element => element.textContent ?? "");
      return messages.find(message => /full track .*playing/i.test(message)) ?? false;
    }, null, { timeout: 10_000 });
    sourceFailureText = await failureHandle.jsonValue();
  } catch (error) {
    console.log("SOURCE_HANDOFF_FAILURE_DIAGNOSTICS", JSON.stringify({
      failedAssetRequests,
      visibleText: await page.locator("body").innerText(),
    }));
    throw error;
  }
  assert.ok(failedAssetRequests > 0, "the failed source handoff must reach the simulated asset failure");
  assert.match(sourceFailureText, /full track could not (?:load|be prepared)/i,
    "the source failure message identifies the original track");
  assert.match(sourceFailureText, /current stem mix (?:is still|keeps) playing/i,
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
  assert.ok(afterFailedReturn.playing,
    `all original stems continue playing after the source fails: ${JSON.stringify(afterFailedReturn)}`);
  assert.ok(afterFailedReturn.position > beforeFailedReturn, "the current stem mix advances while the source is unavailable");
  const failedSourceMaster = await page.evaluate(() => ({
    currentDeck: document.querySelector('[data-role="current"]')?.getAttribute("data-testid"),
    control: document.querySelector('[aria-label="Master volume"]')?.value,
    gain: window.audioProbe.currentMasterGain(),
    deckGains: window.audioProbe.masterGains.map(master => ({
      deck: master.probeDeckIndex,
      gain: master.gain.value,
    })),
  }));
  assert.ok(Math.abs(failedSourceMaster.gain - 0.63) < 0.01,
    `a failed source load leaves the current deck master level unchanged: ${JSON.stringify(failedSourceMaster)}`);
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
  assert.ok(Math.abs(await page.evaluate(() => window.audioProbe.currentMasterGain()) - 0.63) < 0.01,
    "successful retry also preserves the master level");
  const retryGains = await page.evaluate(() => window.audioProbe.sources.map(source => ({
    url: source.mediaElement.src, gain: source.inputNode?.nextNode?.gain?.value,
  })));
  assert.ok(retryGains.filter(source => source.url.endsWith("/a-source")).at(-1)?.gain > 0.9,
    "the retried original source is audible");
  assert.ok(types.every(type => retryGains.filter(source => source.url.endsWith(`/a-${type}`)).at(-1)?.gain < 0.01),
    "the stem layers are silent after the retry completes");

  const missingStudioTrack = {
    ...tracks[2], id: "session-missing", position: 2,
    track: { ...tracks[2].track, id: "missing", title: "Unavailable session track" },
    sourceAssetId: null, stems: [], playback: { kind: "source", assetIds: ["a-source"] }, stemMix: {},
  };
  const liveMixTracks = tracks.slice(0, 2).map((item, index) => ({
    ...item,
    position: index,
    sourceAssetId: index === 0 ? "a-source" : "b-source",
    stemMix: index === 0
      ? { vocals: 0.42, drums: 0.78, bass: 1, other: 1 }
      : { vocals: 1, drums: 1, bass: 0.31, other: 1 },
  }));
  session.tracks = [...liveMixTracks, missingStudioTrack];
  session.currentSessionTrackId = "a";
  session.positionSeconds = 0;
  session.swaps = [];
  exposeSeparatedSource = false;
  await page.goto(`http://localhost:80/waveyard/session/${sessionId}`);
  await page.waitForFunction(() => [...document.querySelectorAll('[data-role="current"] audio')].length === 4 &&
    [...document.querySelectorAll('[data-role="current"] audio')].every(a => a.readyState === 4));
  assert.equal(await page.getByLabel("vocals level, current deck").inputValue(), "0.42",
    "the live session loads its saved stem mix before handoff");
  const sourceAssetsBeforeHandoff = assetSnapshot();
  assert.equal((await page.getByTestId("studio-track-selection-count").innerText()).trim(), "2 selected of 2 selectable tracks",
    "only entries with audio layers are selected for Studio by default");
  assert.equal(await page.getByRole("checkbox", { name: /Unavailable session track/ }).isDisabled(), true,
    "a session entry without stems cannot be selected for Studio");
  assert.equal(await page.getByTestId("studio-unready-note").isVisible(), true,
    "the picker explains where to prepare entries that are not ready");
  await page.getByRole("button", { name: "Current only" }).click();
  assert.equal((await page.getByTestId("studio-track-selection-count").innerText()).trim(), "1 selected of 2 selectable tracks");
  assert.equal(await page.getByRole("checkbox", { name: /session entry 1/ }).isChecked(), true,
    "Current only keeps the playing session entry");
  assert.equal(await page.getByRole("checkbox", { name: /session entry 2/ }).isChecked(), false);
  await page.getByRole("button", { name: "Clear selection" }).click();
  assert.equal((await page.getByTestId("studio-track-selection-count").innerText()).trim(), "0 selected of 2 selectable tracks");
  assert.equal(await page.getByTestId("session-handoff").isDisabled(), true,
    "an empty selection cannot be submitted");
  await page.getByRole("button", { name: "Select all ready" }).click();
  assert.equal((await page.getByTestId("studio-track-selection-count").innerText()).trim(), "2 selected of 2 selectable tracks");
  assert.equal(await page.getByRole("checkbox", { name: /Unavailable session track/ }).isChecked(), false,
    "unready session entries are excluded from the Studio request");
  await page.getByRole("checkbox", { name: /session entry 2/ }).uncheck();
  assert.equal((await page.getByTestId("studio-track-selection-count").innerText()).trim(), "1 selected of 2 selectable tracks");
  assert.equal(await page.getByRole("checkbox", { name: /session entry 1/ }).isChecked(), true);
  assert.equal(await page.getByRole("checkbox", { name: /session entry 2/ }).isChecked(), false,
    "a ready track can be excluded without excluding the selected track");
  studioHandoffRequests = 0;
  lastStudioHandoffSelection = [];
  holdStudioHandoff = true;
  let notifyStudioHandoffStarted;
  const studioHandoffStarted = new Promise(resolve => { notifyStudioHandoffStarted = resolve; });
  signalStudioHandoffStarted = notifyStudioHandoffStarted;
  await page.getByTestId("session-handoff").evaluate(button => { button.click(); button.click(); });
  await waitForSignal(studioHandoffStarted, "the session-to-Studio handoff request");
  assert.equal(studioHandoffRequests, 1, "a rapid double click submits only one Studio handoff");
  assert.equal(await page.getByTestId("session-handoff").isDisabled(), true,
    "the handoff button stays disabled while Studio is creating the arrangement");
  assert.match(await page.getByTestId("session-handoff").innerText(), /Creating Studio arrangement/);
  await page.waitForTimeout(100);
  assert.equal(studioHandoffRequests, 1, "the in-flight guard prevents duplicate projects");
  releaseStudioHandoff?.();
  releaseStudioHandoff = null;
  holdStudioHandoff = false;
  signalStudioHandoffStarted = null;
  const studioLink = page.getByRole("link", { name: "Open in Studio" });
  await studioLink.waitFor();
  assert.deepEqual(lastStudioHandoffSelection, ["a"],
    "the handoff request contains only the one explicitly selected session track");
  assert.equal(studioRemixData.tracks.length, 4,
    "the derived Studio arrangement contains lanes only for the selected song");
  const handoffResult = await page.getByTestId("session-status").textContent();
  assert.match(handoffResult, /Sent to Studio as a derived arrangement/);
  assert.match(await studioLink.locator("xpath=..").textContent(), /4 remix tracks/);
  assert.doesNotMatch(await studioLink.locator("xpath=..").textContent(), /Unavailable session track/,
    "an unchecked entry is not sent to Studio or reported as a refusal");
  assert.equal(await studioLink.getAttribute("href"),
    `/waveyard/projects/${studioProjectId}?view=studio`,
    "the handoff link opens the derived project directly in Studio");
  projectLoadAttempts = 0;
  failFirstProjectLoad = true;
  await studioLink.click();
  await page.getByRole("heading", { name: "Mixer console" }).waitFor();
  assert.ok(projectLoadAttempts >= 2, "Studio retries opening the project after a transient server failure");
  await page.waitForFunction(() => document.querySelectorAll(".timeline-track").length === 4);
  assert.equal(await page.getByTestId("waveyard-mode-studio").getAttribute("aria-selected"), "true",
    "the derived project opens in the Studio presentation");
  assert.equal(await page.locator(".timeline-track").count(), 4,
    "only the selected separated song contributes editable arrangement lanes");
  assert.equal(await page.locator(".timeline-track .clip").count(), 4,
    "every selected song lane has a timeline clip");
  const clipOffsets = await page.locator(".timeline-track .clip").evaluateAll(elements =>
    elements.map(element => Number.parseFloat(element.style.left)),
  );
  assert.ok(clipOffsets.every(offset => offset === 0), "no timeline placement is created for the unselected song");
  const delayedPreviewAssetId = studioRemixData.tracks[0].stemAssetId;
  let releaseArrangementAsset;
  let signalArrangementAssetRequest;
  let signalArrangementAssetResponse;
  const arrangementAssetRequest = new Promise(resolve => { signalArrangementAssetRequest = resolve; });
  const arrangementAssetResponse = new Promise(resolve => { signalArrangementAssetResponse = resolve; });
  heldAssetId = delayedPreviewAssetId;
  heldAssetGate = new Promise(resolve => { releaseArrangementAsset = resolve; });
  signalHeldAssetRequest = signalArrangementAssetRequest;
  signalHeldAssetRouteFinished = signalArrangementAssetResponse;
  const startedSourceCount = await page.evaluate(() =>
    window.audioProbe.buffers.filter(source => source.startedOffset !== undefined).length,
  );
  await page.getByRole("button", { name: "Preview arrangement", exact: true }).click();
  const cancelPreviewButton = page.getByRole("button", { name: "Cancel arrangement preview", exact: true });
  await cancelPreviewButton.waitFor();
  assert.equal(await cancelPreviewButton.getAttribute("aria-busy"), "true",
    "the arrangement transport exposes its pending audio-load state");
  await waitForSignal(arrangementAssetRequest, "the Studio arrangement preview audio request");
  await cancelPreviewButton.click();
  await page.getByRole("button", { name: "Preview arrangement", exact: true }).waitFor();
  releaseArrangementAsset();
  heldAssetId = null;
  heldAssetGate = null;
  signalHeldAssetRequest = null;
  await waitForSignal(arrangementAssetResponse, "the cancelled Studio arrangement audio response");
  signalHeldAssetRouteFinished = null;
  await page.waitForTimeout(100);
  assert.equal(
    await page.evaluate(() => window.audioProbe.buffers.filter(source => source.startedOffset !== undefined).length),
    startedSourceCount,
    "a late decoded asset response cannot start audio after the user cancels the arrangement preview",
  );
  await page.getByRole("button", { name: "Preview arrangement", exact: true }).click();
  const pausePreviewButton = page.getByRole("button", { name: "Pause arrangement", exact: true });
  await pausePreviewButton.waitFor();
  await page.waitForFunction((previousCount) =>
    window.audioProbe.buffers.filter(source => source.startedOffset !== undefined).length > previousCount,
  startedSourceCount);
  await pausePreviewButton.click();
  await page.getByRole("button", { name: "Preview arrangement", exact: true }).waitFor();
  console.log("PASS: Studio preview cancellation prevents a late audio response from restarting playback; a fresh preview plays.");
  await page.getByRole("tab", { name: "Analyze" }).click();
  await page.locator('[data-testid="source-section-map-a-source"] .source-section-marker').click();
  await page.getByTestId("source-section-inspection-section-a-1").waitFor();
  assert.equal(await page.getByRole("tab", { name: "Analyze" }).getAttribute("aria-selected"), "true",
    "selecting a source section keeps its analysis actions available instead of switching tabs");
  const analyzeEventsButton = page.getByRole("button", { name: "Analyze events" });
  await analyzeEventsButton.click();
  await page.getByText("Could not confirm the request. Refresh the source status before trying again.", { exact: true }).waitFor();
  assert.equal(await analyzeEventsButton.isDisabled(), false,
    "a dropped event-analysis request releases the busy state for recovery");
  await analyzeEventsButton.click();
  await page.getByText("Event analysis queued.", { exact: true }).waitFor();
  await page.getByRole("button", { name: "Event analysis queued" }).waitFor();
  assert.equal(sourceEventRequests, 2, "event analysis can be retried after a dropped network request");
  const findPlacementButton = page.getByRole("button", { name: "Find where this fits" });
  await findPlacementButton.click();
  await page.getByText("Could not reach the server for placement recommendations. Check your connection and try again.", { exact: true }).waitFor();
  assert.equal(await findPlacementButton.isDisabled(), false,
    "a dropped placement request releases the busy state for recovery");
  await findPlacementButton.click();
  await page.getByText("Placement recommendations updated.", { exact: true }).waitFor();
  assert.equal(meetingPointRequests, 2, "placement recommendations can be retried after a dropped request");
  const addSectionButton = page.getByRole("button", { name: "Add to Arrangement" });
  await addSectionButton.click();
  await page.getByText("Could not confirm this arrangement change. Refresh Studio before trying again.", { exact: true }).waitFor();
  assert.equal(await addSectionButton.isDisabled(), false,
    "a dropped arrangement request releases its busy state without leaving Analyze");
  await addSectionButton.click();
  await page.getByText("Section added to the arrangement.", { exact: true }).waitFor();
  assert.equal(sectionArrangementRequests, 2, "section insertion can be retried after the failed request");
  await page.getByRole("tab", { name: "Edit" }).click();
  const reloadedVocalsVolume = await verifyStudioSaveReload();

  const studioSaveHeld = new Promise(resolve => { signalHeldStudioRemixPut = resolve; });
  holdNextStudioRemixPut = true;
  studioRemixPutCount = 0;
  const firstStudioSaveResponse = page.waitForResponse(response =>
    response.url().endsWith(`/api/remixes/${studioRemixId}`) && response.request().method() === "PUT",
  );
  await reloadedVocalsVolume.fill("0.62");
  await waitForSignal(studioSaveHeld, "the first held Studio arrangement save");
  await reloadedVocalsVolume.fill("0.79");
  await page.waitForTimeout(850);
  const savesWhileFirstIsHeld = studioRemixPutCount;
  const queuedStudioSaveResponse = savesWhileFirstIsHeld === 1
    ? page.waitForResponse(response =>
      response.url().endsWith(`/api/remixes/${studioRemixId}`) && response.request().method() === "PUT",
    )
    : null;
  releaseHeldStudioRemixPut?.();
  await firstStudioSaveResponse;
  if (queuedStudioSaveResponse) await queuedStudioSaveResponse;
  await page.locator(".save-state.saved").waitFor();
  assert.equal(savesWhileFirstIsHeld, 1,
    "Studio serializes saves rather than writing a newer arrangement before an older save finishes");
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.getByRole("heading", { name: "Mixer console" }).waitFor();
  assert.equal(
    await page.getByLabel("Test a original.wav — Vocals arrangement volume").inputValue(),
    "0.79",
    "a slow earlier save cannot overwrite a newer Studio edit after reopening",
  );
  const conflictVolume = page.getByLabel("Test a original.wav — Vocals arrangement volume");
  studioRemixData.remix.version += 1;
  studioRemixData.tracks[0].volume = 0.43;
  const staleStudioSave = page.waitForResponse(response =>
    response.url().endsWith(`/api/remixes/${studioRemixId}`) && response.request().method() === "PUT",
  );
  await conflictVolume.fill("0.68");
  assert.equal((await staleStudioSave).status(), 409,
    "a separate Studio writer makes the old browser's arrangement version stale");
  await page.getByText(/Another Studio tab saved newer changes first/).waitFor();
  assert.equal(await conflictVolume.inputValue(), "0.68",
    "a stale-save conflict leaves the unsaved edit visible in Studio");
  await page.getByRole("button", { name: "Load latest and keep my draft" }).click();
  await page.getByRole("button", { name: "Restore draft and replace latest" }).waitFor();
  assert.equal(await conflictVolume.inputValue(), "0.43",
    "loading the authoritative arrangement does not silently apply the stale draft");
  await page.getByRole("button", { name: "Restore draft and replace latest" }).click();
  await page.locator(".save-state.saved").waitFor();
  assert.equal(studioRemixData.tracks[0].volume, 0.68,
    "explicitly restoring the preserved draft saves it against the latest version");
  const undoTestVolume = page.getByLabel("Test a original.wav — Vocals arrangement volume");
  const undoSaveResponse = page.waitForResponse(response =>
    response.url().endsWith(`/api/remixes/${studioRemixId}`) && response.request().method() === "PUT",
  );
  await undoTestVolume.fill("0.91");
  await page.getByRole("button", { name: "Undo", exact: true }).click();
  assert.equal(await undoTestVolume.inputValue(), "0.68",
    "undo restores the current canonical draft after an explicit conflict recovery");
  assert.ok((await undoSaveResponse).ok(), "undo persists the restored arrangement");
  assert.equal(studioRemixData.tracks[0].volume, 0.68,
    "the undo save stores the restored value, not the transient edit");
  await page.waitForTimeout(850);
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.getByRole("heading", { name: "Mixer console" }).waitFor();
  assert.equal(
    await page.getByLabel("Test a original.wav — Vocals arrangement volume").inputValue(),
    "0.68",
    "a pending autosave cannot reapply the edit after undo to the restored draft",
  );
  const exitTestVolume = page.getByLabel("Test a original.wav — Vocals arrangement volume");
  const exitSaveResponse = page.waitForResponse(response =>
    response.url().endsWith(`/api/remixes/${studioRemixId}`) && response.request().method() === "PUT",
  );
  await exitTestVolume.fill("0.84");
  await page.goBack();
  await page.waitForURL(url => url.pathname === `/waveyard/session/${sessionId}`);
  assert.ok((await exitSaveResponse).ok(), "leaving Studio flushes an edit still inside the autosave delay");
  await page.goForward();
  await page.waitForURL(url =>
    url.pathname === `/waveyard/projects/${studioProjectId}` && url.searchParams.get("view") === "studio",
  );
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.getByRole("heading", { name: "Mixer console" }).waitFor();
  assert.equal(
    await page.getByLabel("Test a original.wav — Vocals arrangement volume").inputValue(),
    "0.84",
    "a just-edited Studio value survives navigating away and back",
  );

  assert.deepEqual(assetSnapshot(), sourceAssetsBeforeHandoff,
    "creating and editing the derived arrangement leaves original audio assets unchanged");

  studioHasRemix = false;
  automaticRemixAttempts = 0;
  await page.goto(`http://localhost:80/waveyard/projects/${studioProjectId}?view=studio`);
  const buildArrangementButton = page.getByRole("button", { name: "Build automatic arrangement", exact: true });
  await buildArrangementButton.waitFor();
  await buildArrangementButton.click();
  await page.getByText(/automatic arrangement request could not reach the server/i).waitFor();
  assert.equal(await buildArrangementButton.isEnabled(), true,
    "a network failure re-enables the automatic arrangement action");
  await buildArrangementButton.click();
  await page.getByRole("heading", { name: "Mixer console" }).waitFor();
  await page.getByText(/starting point is ready to play/i).waitFor();
  assert.equal(automaticRemixAttempts, 2,
    "a failed automatic arrangement can be retried and the returned arrangement opens");
  studioHasRemix = true;
  console.log("PASS: Studio arrangement creation recovers from a network failure and opens on retry.");

  await page.goto(`http://localhost:80/waveyard/session/${sessionId}`);
  await page.waitForFunction(() => document.querySelector('[data-testid="session-handoff"]'));
  failStudioHandoff = true;
  await page.getByTestId("session-handoff").click();
  await page.getByTestId("session-status").filter({ hasText: "Studio is temporarily unavailable" }).waitFor();
  assert.equal(await page.getByRole("link", { name: "Open in Studio" }).count(), 0,
    "a failed handoff does not show a misleading project link");
  failStudioHandoff = false;

  await page.goto(`http://localhost:80/waveyard/projects/${studioProjectId}?view=studio`);
  await page.getByRole("heading", { name: "Mixer console" }).waitFor();
  let signalSecondStudioProjectRequest;
  const secondStudioProjectRequested = new Promise(resolve => {
    signalSecondStudioProjectRequest = resolve;
  });
  let releaseSecondStudioProjectResponse;
  secondStudioProjectLoadGate = new Promise(resolve => {
    releaseSecondStudioProjectResponse = resolve;
  });
  secondStudioProjectLoadSignal = signalSecondStudioProjectRequest;
  holdSecondStudioProjectLoad = true;
  const secondStudioProjectUrl = `/waveyard/projects/${secondStudioProjectId}?view=studio`;
  const secondProjectNavigation = page.waitForURL(url => url.pathname === `/waveyard/projects/${secondStudioProjectId}`);
  await page.evaluate(url => {
    window.history.pushState({}, "", url);
    window.dispatchEvent(new PopStateEvent("popstate"));
  }, secondStudioProjectUrl);
  await secondProjectNavigation;
  await waitForSignal(secondStudioProjectRequested, "the second Studio project request");
  await page.getByText("Opening private studio…", { exact: true }).waitFor();
  assert.equal(await page.getByRole("heading", { name: "Session · Live layer regression" }).count(), 0,
    "the prior arrangement is hidden while another project loads");
  holdSecondStudioProjectLoad = false;
  releaseSecondStudioProjectResponse?.();
  secondStudioProjectLoadGate = null;
  secondStudioProjectLoadSignal = null;
  await page.getByRole("heading", { name: "Second derived arrangement" }).waitFor();
  await page.waitForFunction(() => document.activeElement?.id === "studio-editor", null, { timeout: 10_000 });
  console.log("PASS: switching Studio projects resets stale arrangement state and focuses the newly opened editor");

  await page.setViewportSize({ width: 390, height: 844 });
  const studioMobileLayout = await page.evaluate(() => {
    const chain = [];
    for (let element = document.querySelector(".studio"), depth = 0; element && depth < 8; element = element.parentElement, depth += 1) {
      const style = getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      chain.push({
        tag: element.tagName.toLowerCase(),
        className: typeof element.className === "string" ? element.className : null,
        width: Math.round(rect.width),
        right: Math.round(rect.right),
        scrollWidth: element.scrollWidth,
        clientWidth: element.clientWidth,
        minWidth: style.minWidth,
        maxWidth: style.maxWidth,
        display: style.display,
        gridTemplateColumns: style.gridTemplateColumns,
        flexWrap: style.flexWrap,
        overflowX: style.overflowX,
      });
    }
    const offenders = [...document.querySelectorAll("body *")]
      .filter(element => {
        const rect = element.getBoundingClientRect();
        return rect.width > 0 && rect.right > innerWidth + 1 && !element.closest(".timeline-scroll");
      })
      .map(element => {
        const rect = element.getBoundingClientRect();
        return {
          tag: element.tagName.toLowerCase(),
          id: element.id || null,
          className: typeof element.className === "string" ? element.className : null,
          right: Math.round(rect.right),
          width: Math.round(rect.width),
          text: element.textContent?.trim().slice(0, 60) || null,
        };
      })
      .slice(0, 12);
    const transport = document.querySelector(".transport-panel");
    const transportStyle = transport ? getComputedStyle(transport) : null;
    const transportDetails = transport ? {
      width: Math.round(transport.getBoundingClientRect().width),
      scrollWidth: transport.scrollWidth,
      clientWidth: transport.clientWidth,
      gridTemplateColumns: transportStyle.gridTemplateColumns,
      children: [...transport.children].map(element => {
        const style = getComputedStyle(element);
        const rect = element.getBoundingClientRect();
        return {
          tag: element.tagName.toLowerCase(),
          className: typeof element.className === "string" ? element.className : null,
          text: element.textContent?.trim().slice(0, 70) || null,
          width: Math.round(rect.width),
          left: Math.round(rect.left),
          right: Math.round(rect.right),
          minWidth: style.minWidth,
          whiteSpace: style.whiteSpace,
          overflowWrap: style.overflowWrap,
          gridColumn: style.gridColumn,
        };
      }),
    } : null;
    return {
      viewport: innerWidth,
      documentWidth: document.documentElement.scrollWidth,
      chain,
      offenders,
      transportDetails,
    };
  });
  assert.ok(studioMobileLayout.documentWidth <= studioMobileLayout.viewport,
    `Studio must not overflow on mobile: ${JSON.stringify(studioMobileLayout)}`);
  session.tracks = tracks;
  session.swaps = [];
  session.currentSessionTrackId = "a";
  session.positionSeconds = 0;
  await page.goto(`http://localhost:80/waveyard/session/${sessionId}`);
  await page.waitForFunction(() => document.querySelector('[data-testid="session-handoff"]'));
  const vocalsIsolationPad = page.getByTestId("quick-isolate-vocals");
  await vocalsIsolationPad.waitFor();
  await vocalsIsolationPad.click();
  await page.waitForFunction(
    () => document.querySelector('[data-testid="quick-isolate-vocals"]')?.getAttribute("aria-pressed") === "true",
  );
  await page.getByTestId("quick-restore-mix").click();
  await page.waitForFunction(
    () => document.querySelector('[data-testid="quick-isolate-vocals"]')?.getAttribute("aria-pressed") === "false",
  );
  console.log("PASS: mobile stem pads isolate one layer and restore the full mix with a central control");
  const mobileSwapEntry = page.getByTestId("quick-open-live-swap-vocals");
  await mobileSwapEntry.click();
  await page.getByTestId("live-swap-picker-vocals").waitFor();
  assert.equal(await mobileSwapEntry.getAttribute("aria-expanded"), "true");
  const mobilePickerLayout = await page.evaluate(() => ({
    viewport: innerWidth,
    documentWidth: document.documentElement.scrollWidth,
  }));
  assert.ok(mobilePickerLayout.documentWidth <= mobilePickerLayout.viewport,
    `live source picker must fit on mobile: ${JSON.stringify(mobilePickerLayout)}`);
  await page.getByRole("button", { name: "Close source picker", exact: true }).click();
  await page.waitForFunction(() => !document.querySelector('[data-testid="live-swap-picker-vocals"]'));
  assert.equal(await mobileSwapEntry.getAttribute("aria-expanded"), "false");
  const mobileTempoTiming = await measureLiveStemSwap("b", 124 / 120, 0, "mobile");
  console.log("LIVE_STEM_SWAP_TIMINGS", JSON.stringify({ mobile: { tempoMatched: mobileTempoTiming } }));
  console.log("PASS: mobile stem pad opens a fitting live source picker and closes cleanly");
  const sessionMobileLayout = await page.evaluate(() => ({
    viewport: innerWidth,
    documentWidth: document.documentElement.scrollWidth,
  }));
  assert.ok(sessionMobileLayout.documentWidth <= sessionMobileLayout.viewport,
    `session must not overflow on mobile: ${JSON.stringify(sessionMobileLayout)}`);
  console.log("PASS: live stem swaps are cancellable without interrupting playback; source recovery and the session-to-Studio handoff remain usable");
  }
} finally { await browser.close(); }
