// Isolated real-browser audio-graph regression. Session persistence is mocked;
// generated WAV bytes are decoded and played by the real application engine.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { runAutomaticFadeAcceptance } from "./waveyard-auto-fades.mjs";
const timingOnly = process.argv.includes("--live-stem-timing-only");
if (process.argv.includes("--live-stem-timing-matrix")) {
  const { spawnSync } = await import("node:child_process");
  for (const engine of ["chromium", "webkit", "firefox"]) {
    console.log(`LIVE_STEM_TIMING_ENGINE ${engine}`);
    const result = spawnSync(process.execPath, [process.argv[1], "--live-stem-timing-only", `--engine=${engine}`], {
      stdio: "inherit",
      env: process.env,
    });
    if (result.error) throw result.error;
    if (result.status !== 0) process.exit(result.status ?? 1);
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
const automaticFadesOnly = process.argv.includes("--automatic-fades-only");
const donorReplacementOnly = process.argv.includes("--donor-replacement-only");
const parallelStemSwapsOnly = process.argv.includes("--parallel-stem-swaps-only");
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
function waitForSignal(signal, label, timeoutMs = 15_000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Timed out waiting for ${label} after ${timeoutMs}ms.`)), timeoutMs);
    Promise.resolve(signal).then(
      value => { clearTimeout(timer); resolve(value); },
      error => { clearTimeout(timer); reject(error); },
    );
  });
}
function wav(seconds, frequency) {
  const n = 22050 * seconds, data = Buffer.alloc(44 + n * 2);
  data.write("RIFF"); data.writeUInt32LE(data.length - 8, 4); data.write("WAVEfmt ", 8);
  data.writeUInt32LE(16, 16); data.writeUInt16LE(1, 20); data.writeUInt16LE(1, 22);
  data.writeUInt32LE(22050, 24); data.writeUInt32LE(44100, 28);
  data.writeUInt16LE(2, 32); data.writeUInt16LE(16, 34); data.write("data", 36);
  data.writeUInt32LE(n * 2, 40);
  for (let i = 0; i < n; i++) data.writeInt16LE(Math.round(2000 * Math.sin(i * frequency * Math.PI * 2 / 22050)), 44 + i * 2);
  return data;
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
let unstartedCurrentSessionTrack = false;
let currentSessionSeparationRequests = 0;
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
const studioProjectId = "00000000-0000-4000-8000-000000000008";
const studioRemixId = "00000000-0000-4000-8000-000000000009";
const secondStudioProjectId = "00000000-0000-4000-8000-000000000010";
let failStudioHandoff = false;
let holdStudioHandoff = false;
let releaseStudioHandoff = null;
let signalStudioHandoffStarted = null;
let studioHandoffRequests = 0;
let lastStudioHandoffSelection = [];
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
  browser = await browserType.launch(engineName === "chromium"
    ? { executablePath: process.env.CHROMIUM_PATH || "/repl/tools/bin/chromium",
      args: ["--no-sandbox", "--autoplay-policy=no-user-gesture-required"] }
    : { headless: true });
} catch (error) {
  if (timingOnly && engineName !== "chromium") {
    console.log(`SKIP: ${engineName} timing coverage is unavailable here: ${error instanceof Error ? error.message.split("\n")[0] : String(error)}`);
    process.exit(0);
  }
  throw error;
}
try {
  const context = await browser.newContext({ serviceWorkers: "block" });
  let page = await context.newPage();
  page.on("pageerror", error => console.log("PAGE_ERROR", error.stack));
  await context.addInitScript(({ fixtureSessionId, probeAutoFades }) => {
    window.audioProbe = { sources: [], buffers: [], masterGains: [], outputAnalyzers: [] };
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
        this.probeFirstGain = true;
      }
      createGain() {
        const node = super.createGain(), connect = node.connect.bind(node);
        node.connect = (target, ...args) => {
          node.nextNode = target;
          if (node.waveyardProbeMaster && target instanceof AnalyserNode &&
              !window.audioProbe.outputAnalyzers.some(entry => entry.analyser === target)) {
            window.audioProbe.outputAnalyzers.push({ analyser: target });
          }
          return connect(target, ...args);
        };
        if (this.probeFirstGain) {
          window.audioProbe.masterGains.push(node);
          this.probeFirstGain = false;
          node.waveyardProbeMaster = probeAutoFades;
        }
        return node;
      }
      createMediaElementSource(media) {
        const node = super.createMediaElementSource(media), connect = node.connect.bind(node);
        node.connect = (target, ...args) => { node.inputNode = target; return connect(target, ...args); };
        window.audioProbe.sources.push(node); return node;
      }
      createBufferSource() {
        const node = super.createBufferSource(), start = node.start.bind(node), stop = node.stop.bind(node), connect = node.connect.bind(node);
        node.connect = (target, ...args) => { node.inputNode = target; return connect(target, ...args); };
        node.start = (when, offset, ...args) => {
          node.startedOffset = offset;
          node.recipientTimeAtStart = document.querySelector('[data-role="current"] audio')?.currentTime ?? null;
          return start(when, offset, ...args);
        };
        node.stop = (...args) => { node.stopCount = (node.stopCount ?? 0) + 1; return stop(...args); };
        window.audioProbe.buffers.push(node); return node;
      }
    };
  }, { fixtureSessionId: sessionId, probeAutoFades: automaticFadesOnly });
  let failAsset = null;
  let failedAssetRequests = 0;
  const liveSwapRequestOrder = [];
  let externalDonorSaveGate = null;
  let signalExternalDonorSave;
  let signalExternalDonorWarm;
  await context.route("**/api/assets/*", async route => {
    const id = new URL(route.request().url()).pathname.split("/").at(-1);
    if (id === timedAssetId && timedAssetDelayMs > 0) {
      await new Promise(resolve => setTimeout(resolve, timedAssetDelayMs));
    }
    if (id === "b-vocals" && heldAssetId === "b-vocals") liveSwapRequestOrder.push("donor-preload");
    if (id === "d-vocals") {
      liveSwapRequestOrder.push("donor-preload:d-vocals");
      signalExternalDonorWarm?.();
    }
    const parallelDonor = parallelDonorResponses?.get(id);
    if (parallelDonor) {
      parallelDonorRequestOrder.push(id);
      parallelDonor.signalStarted();
      await parallelDonor.promise;
      parallelDonorResponseOrder.push(id);
    }
    const isHeldAssetRequest = id === heldAssetId && heldAssetGate !== null;
    if (isHeldAssetRequest) {
      signalHeldAssetRequest?.();
      await heldAssetGate;
    }
    if (id === failAsset) {
      failedAssetRequests += 1;
      return route.fulfill({ status: 503, headers: { "Cache-Control": "no-store" }, body: "Test failure" });
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
    if (!isHeldAssetRequest) return route.fulfill(response);
    try {
      await route.fulfill(response);
    } catch {
      // The application may abort this deliberately held request when the user cancels.
    } finally {
      signalHeldAssetRouteFinished?.();
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
        tracks: session.tracks.map(item => item.id === "a" ? tracks[0] : item),
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
      session.swaps.push({ ...body, id: donorReplacementOnly ? `swap-${++donorSwapSequence}` : `swap-${body.stemType}`,
        toStemAssetId: body.toStemAssetId ?? `${body.toTrackId}-${body.stemType}`,
        fromTrackId: "a", createdAt: new Date().toISOString(),
        donorTrack: body.toTrackId === "d" ? { id: "d", title: "Test D", stems: externalStemKeys } : undefined });
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
      const item = tracks.find(t => t.track.id === body.trackId);
      session.tracks.push({ ...item, id: `session-${session.tracks.length + 1}`, position: body.position });
    } else if (url.pathname.endsWith("/tracks") && request.method() === "PATCH") {
      const from = session.tracks.findIndex(item => item.id === body.sessionTrackId);
      const to = Math.max(0, Math.min(session.tracks.length - 1, Number(body.position)));
      if (from >= 0) {
        const [item] = session.tracks.splice(from, 1);
        session.tracks.splice(to, 0, item);
        session.tracks.forEach((track, index) => { track.position = index; });
      }
    } else if (request.method() === "DELETE") {
      parallelSwapDeleteRequests.push(url.searchParams.get("swapId"));
      if (pendingSwapDeleteGate) await pendingSwapDeleteGate;
      session.swaps = session.swaps.filter(s => s.id !== url.searchParams.get("swapId"));
    } else if (url.pathname.endsWith("/state") && body) Object.assign(session, body);
    else if (request.method() === "PATCH" && body) {
      const targetId = url.pathname.split("/").at(-1);
      const sessionTrack = session.tracks.find(item => item.id === targetId);
      if (sessionTrack) Object.assign(sessionTrack, body);
      else Object.assign(tracks.find(t => t.id === targetId), body);
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
      const { tracks: inputTracks, automation: inputAutomation, ...remixInput } = input;
      if (holdNextStudioRemixPut) {
        holdNextStudioRemixPut = false;
        signalHeldStudioRemixPut?.();
        await new Promise(resolve => { releaseHeldStudioRemixPut = resolve; });
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
    for (const scenario of ["cancel", "timeout"]) {
      session.currentSessionTrackId = "a";
      session.positionSeconds = 0;
      session.swaps = [];
      await page.goto(`http://localhost:80/waveyard/session/${sessionId}`);
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
        await page.getByTestId("session-status")
          .filter({ hasText: scenario === "cancel" ? /vocals switch cancelled/i : /stem switch timed out after 15 seconds/i })
          .waitFor({ timeout: 20_000 });
        const afterStop = await deck.locator("audio").evaluateAll(elements => elements.map(audio => ({
          time: audio.currentTime, paused: audio.paused,
        })));
        assert.ok(afterStop.every(audio => !audio.paused && (scenario !== "timeout" || audio.time > 14)),
          `${scenario} leaves every original channel playing: ${JSON.stringify(afterStop)}`);
        assert.ok(Math.max(...afterStop.map(audio => audio.time)) - Math.min(...afterStop.map(audio => audio.time)) < 0.2,
          `${scenario} keeps original channels aligned`);
        await page.waitForFunction(before => {
          const audio = document.querySelector('[data-role="current"] audio[src$="/a-vocals"]');
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

  if (timingOnly) {
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
    await results.waitFor({ timeout: 30_000 });
    const report = JSON.parse(await results.getAttribute("data-report"));
    assert.equal(report.observations.length, 6, "the harness records both modes for each paired trial");
    assert.ok(report.observations.some(item => item.mode === "nativeTempo"),
      "the device report includes native-tempo swaps");
    assert.ok(report.observations.some(item => item.mode === "tempoMatched"),
      "the device report includes tempo-matched swaps");
    assert.equal(report.environment.deviceClass, "Phone",
      "each result records the selected device class");
    assert.ok(report.environment.browser && report.environment.operatingSystem && report.environment.userAgent,
      "each result records browser, operating system, and user-agent details");
    assert.ok(Number.isFinite(report.comparison.tempoMatchedMinusNativeMedianMs),
      "the report compares paired timing medians without imposing a latency threshold");
    console.log("LIVE_STEM_DEVICE_BENCHMARK_SMOKE", JSON.stringify({
      simulatedViewport: "390x844",
      observationCount: report.observations.length,
      deviceClass: report.environment.deviceClass,
      browser: report.environment.browser,
      operatingSystem: report.environment.operatingSystem,
      comparisonMs: report.comparison.tempoMatchedMinusNativeMedianMs,
    }));
    console.log("PASS: device benchmark collects comparative native and tempo-matched measurements and environment metadata");
  } else if (process.argv.includes("--studio-persistence-only")) {
    tracks[0].stemMix = { vocals: 0.42 };
    const originalAssets = assetSnapshot();
    await page.goto(`http://localhost:80/waveyard/session/${sessionId}`);
    await page.getByRole("button", { name: "Clear selection" }).click();
    assert.equal(await page.getByTestId("session-handoff").isDisabled(), true,
      "an empty Studio selection cannot be submitted");
    assert.equal(studioHandoffRequests, 0, "an empty selection does not create a Studio project");
    await page.getByRole("button", { name: "Current only" }).click();
    assert.equal((await page.getByTestId("studio-track-selection-count").innerText()).trim(), "1 selected of 3 selectable tracks");
    await page.getByTestId("session-handoff").click();
    const studioLink = page.getByRole("link", { name: "Open in Studio" });
    await studioLink.waitFor();
    assert.deepEqual(lastStudioHandoffSelection, ["a"], "the UI sends only the explicitly selected session entry");
    assert.equal(studioRemixData.tracks.length, 4, "the Studio arrangement contains only the selected track's lanes");
    await studioLink.click();
    await page.getByRole("heading", { name: "Mixer console" }).waitFor();
    await page.waitForFunction(() => document.querySelectorAll(".timeline-track").length === 4);
    assert.equal(await page.locator(".timeline-track").count(), 4, "Studio opens with the selected track and no unselected tracks");
    await verifyStudioSaveReload();
    assert.deepEqual(assetSnapshot(), originalAssets, "handoff and editing preserve original audio");
    console.log("PASS: Studio handoff includes only selected tracks, blocks an empty selection, and preserves edits and original audio");
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
      console.log("PASS: two stem choices save concurrently, out-of-order donor and session responses preserve both live graphs, playback advances, and both swaps survive reload");
    } finally {
      for (const response of [...(parallelSwapResponses?.values() ?? []), ...(parallelDonorResponses?.values() ?? [])]) response.release();
      parallelSwapResponses = null;
      parallelDonorResponses = null;
    }
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
      throw new Error(`Unsettled ${stemType}: ${JSON.stringify(session.swaps)}; ${await deck.innerText()}`);
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
  } else if (process.argv.includes("--switch-recovery-only")) {
    await verifyStemSwitchRecovery();
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
    await runAutomaticFadeAcceptance({
      page, session, tracks, sourceOnlyTrack, toggle: toggleForFade, chooseLiveSource: chooseFadeDonor,
    });
  } else {
  await page.goto("http://localhost:80/waveyard");
  await page.evaluate(() => localStorage.clear());
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
  assert.equal(await page.locator("#waveyard-live-mixer").count(), 1, "the upload action must lead back to the persistent live mixer");
  session.tracks = tracks;
  session.swaps = [];
  session.currentSessionTrackId = "a";
  session.positionSeconds = 0;
  exposeSeparatedSource = false;
  showSeparationProgress = true;
  await page.goto(`http://localhost:80/waveyard/session/${sessionId}`);
  await page.waitForFunction(() => [...document.querySelectorAll('[data-role="current"] audio')].length === 4 &&
    [...document.querySelectorAll('[data-role="current"] audio')].every(a => a.readyState === 4));
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
  for (let step = 0; step < 10; step += 1) await playbackSpeed.press("ArrowLeft");
  assert.equal(await page.getByTestId("session-speed-value").textContent(), "1.00×");
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
    await current.getByTestId(pickerTrigger).click();
    const candidate = current.getByTestId(`live-swap-candidate-vocals-${donorId}`);
    await candidate.waitFor();
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
  await secondPage.waitForFunction(() => [...document.querySelectorAll('[data-role="current"] audio')].length === 4 &&
    [...document.querySelectorAll('[data-role="current"] audio')].every(a => a.readyState === 4));
  await toggle();
  await secondPage.waitForFunction(() => document.querySelector('[data-testid="session-play"]')?.getAttribute("aria-pressed") === "true");
  assert.ok(await secondPage.evaluate(() => [...document.querySelectorAll('[data-role="current"] audio')].every(a => a.paused)),
    "the other tab mirrors playback without starting duplicate audio");
  await firstPage.getByLabel("Seek current track", { exact: true }).press("Home");
  await secondPage.waitForFunction(() => document.querySelector('[aria-label="Seek current track"]')?.value === "0");
  assert.equal(await firstPage.getByTestId("session-play").getAttribute("aria-pressed"), "true", "remote seek does not pause the active deck");
  await toggle();

  const quickVocalsPad = current.getByTestId("quick-isolate-vocals");
  await quickVocalsPad.waitFor();
  await quickVocalsPad.click();
  await page.waitForFunction(() => {
    const gain = type => window.audioProbe.sources.find(item => item.mediaElement.src.endsWith(`/a-${type}`))?.inputNode?.nextNode?.gain?.value;
    return document.querySelector('[data-testid="quick-isolate-vocals"]')?.getAttribute("aria-pressed") === "true" &&
      gain("vocals") > 0.9 && ["drums", "bass", "other"].every(type => gain(type) < 0.01);
  });
  await current.getByTestId("quick-restore-mix").click();
  await page.waitForFunction(() => {
    const gain = type => window.audioProbe.sources.find(item => item.mediaElement.src.endsWith(`/a-${type}`))?.inputNode?.nextNode?.gain?.value;
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
    const get = type => window.audioProbe.sources.find(item => item.mediaElement.src.endsWith(`/a-${type}`))?.inputNode?.nextNode?.gain?.value;
    return get("vocals") > 0.9 && ["drums", "bass", "other"].every(type => get(type) < 0.01);
  });
  await current.getByLabel("Isolate vocals", { exact: true }).click();
  await page.waitForFunction(() => ["vocals", "drums", "bass", "other"].every(type => {
    const source = window.audioProbe.sources.find(item => item.mediaElement.src.endsWith(`/a-${type}`));
    return source?.inputNode?.nextNode?.gain?.value > 0.9;
  }));
  await current.getByLabel("Mute drums", { exact: true }).click();
  await page.waitForFunction(() => {
    const get = type => window.audioProbe.sources.find(item => item.mediaElement.src.endsWith(`/a-${type}`))?.inputNode?.nextNode?.gain?.value;
    return get("drums") < 0.01 && ["vocals", "bass", "other"].every(type => get(type) > 0.9);
  });
  await current.getByLabel("Restore all current stems", { exact: true }).click();
  await page.waitForFunction(() => ["vocals", "drums", "bass", "other"].every(type => {
    const source = window.audioProbe.sources.find(item => item.mediaElement.src.endsWith(`/a-${type}`));
    return source?.inputNode?.nextNode?.gain?.value > 0.9;
  }));

  await current.getByLabel("Snap stem changes").selectOption("beat");
  await page.waitForTimeout(800);
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
    const gain = type => window.audioProbe.sources.find(item => item.mediaElement.src.endsWith(`/a-${type}`))?.inputNode?.nextNode?.gain?.value;
    return gain("vocals") > 0.9 && ["drums", "bass", "other"].every(type => gain(type) < 0.01);
  });
  await page.waitForTimeout(700);
  assert.deepEqual(session.tracks.find(item => item.id === "a").stemMix, mixBeforeHold,
    "momentary isolation never writes a temporary mix to the session");
  await page.keyboard.up("Space");
  await page.waitForFunction(() => ["vocals", "drums", "bass", "other"].every(type => {
    const source = window.audioProbe.sources.find(item => item.mediaElement.src.endsWith(`/a-${type}`));
    return source?.inputNode?.nextNode?.gain?.value > 0.9;
  }), null, { timeout: 3000 });

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
    const source = window.audioProbe.sources.find(item => item.mediaElement.src.endsWith("/a-drums"));
    return source?.inputNode?.nextNode?.gain?.value < 0.01;
  }, null, { timeout: 6000 }).catch(async error => {
    const diagnostic = await page.evaluate(() => {
      const audio = document.querySelector('[data-role="current"] audio[src$="/a-drums"]');
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
  await page.waitForFunction(() => ["vocals", "drums", "bass", "other"].every(type => {
    const source = window.audioProbe.sources.find(item => item.mediaElement.src.endsWith(`/a-${type}`));
    return source?.inputNode?.nextNode?.gain?.value > 0.9;
  }));
  await toggle();

  if (await current.locator('audio[src$="/a-vocals"]').evaluate(audio => audio.paused)) await toggle();
  const playbackBeforePreparingDonor = await current.locator('audio[src$="/a-vocals"]').evaluate(audio => audio.currentTime);
  await current.getByTestId("open-live-swap-vocals").click();
  await current.getByTestId(`prepare-live-swap-vocals-${preparationDonorId}`).click();
  await current.getByTestId(`live-swap-preparing-vocals-${preparationDonorId}`).waitFor();
  assert.equal(preparationStartRequests, 1, "the live-swap picker starts separation for a library source in place");
  await page.waitForFunction(before => {
    const audio = document.querySelector('[data-role="current"] audio[src$="/a-vocals"]');
    return audio instanceof HTMLAudioElement && !audio.paused && audio.currentTime > before + 0.2;
  }, playbackBeforePreparingDonor, { timeout: 5_000 });
  assert.equal(session.swaps.length, 0, "preparing a donor does not change the active live swap");
  const playbackBeforeRetry = await current.locator('audio[src$="/a-vocals"]').evaluate(audio => audio.currentTime);
  await current.getByTestId(`prepare-live-swap-vocals-${retryDonorId}`).click();
  await current.getByTestId(`live-swap-preparing-vocals-${retryDonorId}`).waitFor();
  assert.equal(preparationRetryRequests, 1, "the live-swap picker retries failed source separation in place");
  await page.waitForFunction(before => {
    const audio = document.querySelector('[data-role="current"] audio[src$="/a-vocals"]');
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
  const playbackBeforeCancel = await current.locator('audio[src$="/a-vocals"]').evaluate(audio => audio.currentTime);
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
    const audio = document.querySelector('[data-role="current"] audio[src$="/a-vocals"]');
    return audio instanceof HTMLAudioElement && !audio.paused && audio.currentTime > before + 0.25;
  }, playbackBeforeCancel, { timeout: 5_000 });
  assert.ok(Math.abs(await page.evaluate(() =>
    window.audioProbe.sources.find(source => source.mediaElement.src.endsWith("/a-vocals"))?.inputNode?.gain.value ?? 0,
  ) - 1) < 0.01, "the original vocal layer remains audible while the donor is slow");
  const playbackAtCancel = await current.locator('audio[src$="/a-vocals"]').evaluate(audio => audio.currentTime);
  await page.waitForFunction(before => {
    const audio = document.querySelector('[data-role="current"] audio[src$="/a-vocals"]');
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
  assert.ok(await current.locator('audio[src$="/a-vocals"]').evaluate(audio => !audio.paused),
    "the current mix remains playing while the donor warms");
  const timingCountBeforeWarmSwap = await page.evaluate(() => window.liveStemTimings.length);
  await warmedDonor.click();
  await page.waitForFunction((baseline) => window.audioProbe.buffers.length > baseline, buffersBeforeWarm);
  await page.waitForFunction((baseline) => window.liveStemTimings.length > baseline, timingCountBeforeWarmSwap);
  assert.equal(await page.evaluate(() =>
    window.liveStemAssetFetchTrace.filter(path => path === "/api/assets/c-vocals").length,
  ), 1, "selecting the warmed donor reuses its in-flight or decoded buffer");
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
  await current.getByTestId("open-live-swap-vocals").click();
  const unknownAnalysisDonor = current.getByTestId("live-swap-candidate-vocals-d");
  assert.match(await unknownAnalysisDonor.getAttribute("aria-label"), /BPM unknown; Key unknown/,
    "the picker labels absent donor analysis instead of implying compatibility");
  liveSwapRequestOrder.length = 0;
  await page.evaluate(() => { window.liveAssetFetchTrace.length = 0; });
  let releaseExternalDonorSave;
  externalDonorSaveGate = new Promise(resolve => { releaseExternalDonorSave = resolve; });
  const externalSaveStarted = new Promise(resolve => { signalExternalDonorSave = resolve; });
  const externalWarmStarted = new Promise(resolve => { signalExternalDonorWarm = resolve; });
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
  await secondPage.waitForFunction(() => document.querySelector('[data-testid="session-play"]')?.getAttribute("aria-pressed") === "true");
  await secondPage.getByTestId("session-play").click();
  await page.waitForFunction(() => document.querySelector('[data-testid="session-play"]')?.getAttribute("aria-pressed") === "false");
  await page.waitForFunction(() => [...document.querySelectorAll('[data-role="current"] audio')].every(element => element.paused));
  assert.ok(await page.evaluate(() => [...document.querySelectorAll('[data-role="current"] audio')].every(a => a.paused)),
    "a pause command in the mirror tab pauses the active tab");
  await secondPage.close();

  // Keep the long deadline's reload/wait independent of the mirror fixture.
  await verifyStemSwitchRecovery();

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
  const playbackBeforeCurrentSeparation = await current.locator('audio[src$="/a-source"]').evaluate(audio => audio.currentTime);
  await currentSeparationButton.click();
  assert.equal(currentSessionSeparationRequests, 1, "the currently playing source can start separation in the mixer");
  await page.waitForFunction(before => {
    const audio = document.querySelector('[data-role="current"] audio[src$="/a-source"]');
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
  if (await current.locator('audio[src$="/a-source"]').evaluate(audio => audio.paused)) await toggle();
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
  assert.ok(Math.abs(await page.evaluate(() => window.audioProbe.masterGains.at(-1)?.gain.value) - 0.63) < 0.01,
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
  await current.getByLabel("Mute drums", { exact: true }).click();
  await page.waitForFunction(() => {
    const gain = type => window.audioProbe.sources
      .filter(source => source.mediaElement.src.endsWith(`/a-${type}`))
      .at(-1)?.inputNode?.nextNode?.gain?.value;
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
  assert.ok(Math.abs(await page.evaluate(() => window.audioProbe.masterGains.at(-1)?.gain.value) - 0.63) < 0.01,
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
  assert.ok(Math.abs(await page.evaluate(() => window.audioProbe.masterGains.at(-1)?.gain.value) - 0.63) < 0.01,
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
  assert.equal(await current.getByLabel("Mute drums", { exact: true }).getAttribute("aria-pressed"), "true",
    "switching back to stems restores the muted drums state");
  assert.ok(Math.abs(await page.evaluate(() => window.audioProbe.masterGains.at(-1)?.gain.value) - 0.63) < 0.01,
    "switching back to stems preserves the master gain");
  await page.waitForFunction(() => {
    const gain = type => window.audioProbe.sources
      .filter(source => source.mediaElement.src.endsWith(`/a-${type}`))
      .at(-1)?.inputNode?.nextNode?.gain?.value;
    return Math.abs(gain("vocals") - 0.37) < 0.01 && gain("drums") < 0.01 &&
      gain("bass") > 0.9 && gain("other") > 0.9;
  });
  assert.equal(session.tracks.find(item => item.id === "a").stemMix.vocals, 0.37,
    "the distinctive vocals level remains saved on the session track");
  assert.equal(session.tracks.find(item => item.id === "a").stemMix.drums, 0,
    "the muted drums level remains saved on the session track");
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
  assert.ok(Math.abs(await page.evaluate(() => window.audioProbe.masterGains.at(-1)?.gain.value) - 0.63) < 0.01,
    "a failed source load leaves the master level unchanged");
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
  assert.ok(Math.abs(await page.evaluate(() => window.audioProbe.masterGains.at(-1)?.gain.value) - 0.63) < 0.01,
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
  const undoTestVolume = page.getByLabel("Test a original.wav — Vocals arrangement volume");
  const undoSaveResponse = page.waitForResponse(response =>
    response.url().endsWith(`/api/remixes/${studioRemixId}`) && response.request().method() === "PUT",
  );
  await undoTestVolume.fill("0.91");
  await page.getByRole("button", { name: "Undo", exact: true }).click();
  assert.ok((await undoSaveResponse).ok(), "undo persists the restored arrangement");
  await page.waitForTimeout(850);
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.getByRole("heading", { name: "Mixer console" }).waitFor();
  assert.equal(
    await page.getByLabel("Test a original.wav — Vocals arrangement volume").inputValue(),
    "0.79",
    "a pending autosave cannot reapply the edit after undo",
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
