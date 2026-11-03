import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";

// Actual StudioCore with native browser media/Web Audio, not a replacement UI
// or mocked clock. Route fixtures never touch the user's library or database.
export async function verifyViewAudio({ page, base, makePcmWav, output }) {
  const projectId = "00000000-0000-4000-8000-000000000202";
  const remixId = "view-audio-remix";
  const durationSeconds = 90;
  const levels = [0.37, 0.63];
  const stems = ["vocals", "drums"].map((stemType, index) => ({
    id: `view-audio-${stemType}`, sourceAssetId: "view-audio-source", stemType,
    durationSeconds, sampleRate: 16000, channels: 1, codec: "pcm_s16le", format: "wav",
    fileSizeBytes: 44 + durationSeconds * 32000, checksumSha256: `fixture-${index}`,
    model: "fixture", modelVersion: "1",
  }));
  const tones = stems.map((_, i) => makePcmWav(220 + i * 220, 0.15, durationSeconds));
  let arrangement = false;
  await page.route("**/api/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    const json = (body) => route.fulfill({ contentType: "application/json", body: JSON.stringify(body) });
    const stemIndex = stems.findIndex((stem) => path === `/api/assets/${stem.id}`);
    if (stemIndex >= 0) return route.fulfill({ contentType: "audio/wav",
      headers: { "Cache-Control": "no-store" }, body: tones[stemIndex] });
    if (path.endsWith("/waveform")) return json({ peaks: [], durationSeconds });
    if (path === `/api/waveyard/projects/${projectId}`) return json({
      project: { title: "View audio continuity", licenseCode: "private", visibility: "private", publicationStatus: "draft" },
      role: "owner", build: null, sources: [], studioSources: [{
        id: "view-audio-source", originalFilename: "View continuity.wav", durationSeconds, linkedFromLibrary: true,
      }], stems, waveforms: [], waveformJobs: [], jobs: [],
    });
    if (path === `/api/waveyard/projects/${projectId}/remixes`) return json({ remixes: arrangement ? [{ id: remixId }] : [] });
    if (path === `/api/remixes/${remixId}`) return json({
      remix: { id: remixId, projectId, name: "View continuity", masterVolume: 0.72, masterInserts: "[]",
        loopStartMs: 0, loopEndMs: null, tempoBpm: 120, timeSignatureNumerator: 4,
        timeSignatureDenominator: 4, gridDivision: "beat", snapEnabled: true, targetKey: null, version: 1 },
      tracks: stems.map((stem, index) => ({
        id: `view-track-${index}`, remixSessionId: remixId, stemAssetId: stem.id,
        name: stem.stemType, sortOrder: index, volume: levels[index], pan: 0,
        muted: false, solo: false, inserts: [], clips: [{
          id: `view-clip-${index}`, remixTrackId: `view-track-${index}`, stemAssetId: stem.id,
          timelineStartMs: 0, sourceOffsetMs: 0, durationMs: durationSeconds * 1000,
          gain: 1, playbackRate: 1, fadeInMs: 0, fadeOutMs: 0,
        }],
      })), automation: [], stems,
    });
    if (path.endsWith("/publication")) return json({ publication: { visibility: "private", publicationStatus: "draft", tags: [] }, exports: [], exportJobs: [] });
    if (path.endsWith("/arena-handoff")) return json({ linked: false });
    if (path.endsWith("/versions")) return json({ versions: [] });
    return json({ tracks: [], sessions: [], events: [] });
  });
  await page.addInitScript(() => {
    // Bounded to this two-stem fixture. Observe native calls without changing
    // scheduling or sending a second signal to the speakers.
    const sources = [];
    const edges = new Map();
    const outputs = [];
    const contexts = [];
    const samples = [];
    let starts = 0;
    let monitoring = false;
    const connect = AudioNode.prototype.connect;
    AudioNode.prototype.connect = function (destination, ...args) {
      const result = connect.call(this, destination, ...args);
      if (destination instanceof AudioNode) {
        if (!edges.has(this)) edges.set(this, new Set());
        edges.get(this).add(destination);
        if (destination === this.context.destination) {
          let output = outputs.find((item) => item.node === this);
          if (!output) {
            const analyser = this.context.createAnalyser();
            analyser.fftSize = 2048;
            output = { node: this, analyser, data: new Float32Array(analyser.fftSize) };
            outputs.push(output);
          }
          // applyInserts may disconnect/reconnect the same master node.
          connect.call(this, output.analyser); // No second destination path.
        }
      }
      return result;
    };
    const disconnect = AudioNode.prototype.disconnect;
    AudioNode.prototype.disconnect = function (...args) {
      const result = disconnect.apply(this, args);
      if (!args.length) edges.delete(this);
      else if (args[0] instanceof AudioNode) edges.get(this)?.delete(args[0]);
      return result;
    };
    const NativeContext = window.AudioContext;
    window.AudioContext = new Proxy(NativeContext, {
      construct(target, args) {
        const context = new target(...args);
        contexts.push(context);
        const media = context.createMediaElementSource.bind(context);
        context.createMediaElementSource = (element) => {
          const node = media(element);
          sources.push({ node, element });
          element.addEventListener("play", () => starts++);
          return node;
        };
        const buffer = context.createBufferSource.bind(context);
        context.createBufferSource = () => {
          const node = buffer();
          const entry = { node, active: false };
          sources.push(entry);
          const start = node.start.bind(node);
          const stop = node.stop.bind(node);
          node.start = (...args) => { start(...args); entry.active = true; starts++; };
          node.stop = (...args) => { stop(...args); entry.active = false; };
          node.addEventListener("ended", () => { entry.active = false; });
          return node;
        };
        return context;
      },
    });
    const paths = (node, visited = new Set()) => {
      if (visited.has(node)) return [];
      if (node === node.context.destination) return [[]];
      const nextVisited = new Set(visited).add(node);
      return [...(edges.get(node) ?? [])].flatMap((next) =>
        paths(next, nextVisited).map((path) => [
          ...(node instanceof GainNode ? [node.gain.value] : []), ...path,
        ]));
    };
    const snapshot = () => ({
      at: performance.now(),
      clocks: contexts.map((context) => context.currentTime),
      states: contexts.map((context) => context.state),
      starts,
      playingMedia: [...document.querySelectorAll("audio")].filter((element) => !element.paused && !element.ended).length,
      sources: sources.flatMap((entry, id) => {
        const active = entry.element ? !entry.element.paused && !entry.element.ended : entry.active;
        return active ? [{ id, paths: paths(entry.node), mediaTime: entry.element?.currentTime ?? null }] : [];
      }),
      // Check every output path, not context creation order (both transports
      // may own contexts, but only one engine is allowed to emit a signal).
      outputs: outputs.map(({ node, analyser, data }) => {
        analyser.getFloatTimeDomainData(data);
        return { connected: paths(node).length > 0,
          rms: Math.sqrt(data.reduce((sum, value) => sum + value * value, 0) / data.length) };
      }),
    });
    setInterval(() => {
      if (monitoring && samples.length < 2000) samples.push(snapshot());
    }, 40);
    window.__viewAudio = {
      snapshot,
      begin() { samples.length = 0; monitoring = true; },
      end() { monitoring = false; return samples; },
    };
  });
  const evidence = [];
  for (const kind of ["stems", "arrangement"]) {
    arrangement = kind === "arrangement";
    await page.goto(`${base}/waveyard/projects/${projectId}?view=studio`);
    const modes = page.getByRole("tablist", { name: "Waveyard presentation mode" });
    const studioTabs = page.getByRole("tablist", { name: "Studio focus" });
    await studioTabs.waitFor();
    if (!arrangement) {
      // Non-default values make a reset to unity observable.
      const volumes = page.getByRole("slider", { name: /fader$/i });
      assert.equal(await volumes.count(), 2, "Both stem faders must be available");
      for (let index = 0; index < 2; index++) {
        const slider = volumes.nth(index);
        await slider.fill(String(levels[index]));
      }
    } else {
      await page.getByTestId("arrangement-preview").waitFor();
    }
    const play = page.getByTestId(arrangement ? "arrangement-preview" : "play-all");
    await play.focus();
    await page.keyboard.press("Enter");
    await page.waitForFunction(() => {
      const state = window.__viewAudio.snapshot();
      return state.sources.length === 2 && state.outputs.some((output) => output.connected && output.rms > 0.005);
    }, null, { timeout: 8000 }).catch(async (error) => {
      console.error(JSON.stringify(await page.evaluate(() => ({
        probe: window.__viewAudio.snapshot(),
        media: [...document.querySelectorAll("audio")].map((element) => ({
          src: element.src, paused: element.paused, time: element.currentTime, error: element.error?.message,
        })),
        errors: [...document.querySelectorAll('[role="alert"], .error')].map((element) => element.textContent),
      })), null, 2));
      throw error;
    });
    // A running context and one populated analyser frame do not prove that
    // the browser's audio device has started its clock. Establish advancing
    // playback before measuring view changes, rather than timing device warmup.
    const warmup = await page.evaluate(() => window.__viewAudio.snapshot());
    await page.waitForFunction((before) => {
      const state = window.__viewAudio.snapshot();
      return state.clocks.some((clock, index) => clock > before.clocks[index] + 0.6) &&
        state.sources.every((source) => source.mediaTime === null || source.mediaTime > 0.6);
    }, warmup, { timeout: 8000 });
    const baseline = await page.evaluate(() => {
      window.__viewAudio.begin();
      return window.__viewAudio.snapshot();
    });
    const signature = (sample) => sample.sources.map(({ id, paths }) => ({ id, paths }));
    assert.equal(baseline.sources.length, 2);
    assert.equal(baseline.playingMedia, arrangement ? 0 : 2,
      "Only the selected transport may play media");
    for (let index = 0; index < 2; index++) {
      assert(baseline.sources[index].paths.some((path) => path.some((gain) => Math.abs(gain - levels[index]) < 0.001)),
        `${kind}: native stem gain must match the non-default control`);
    }
    const checkpoints = [];
    const switchView = async (tabs, from, key, to) => {
      await tabs.getByRole("tab", { name: from, exact: true }).focus();
      await page.keyboard.press(key);
      const target = tabs.getByRole("tab", { name: to, exact: true });
      assert.equal(await target.getAttribute("aria-selected"), "true", `${to} must activate from the keyboard`);
      await page.waitForTimeout(350);
      checkpoints.push({ view: to, ...await page.evaluate(() => window.__viewAudio.snapshot()) });
    };
    await switchView(modes, "Studio", "ArrowLeft", "Play");
    await switchView(modes, "Play", "End", "Visual");
    await switchView(modes, "Visual", "ArrowLeft", "Studio");
    await switchView(studioTabs, "Edit", "ArrowRight", "Analyze");
    await switchView(studioTabs, "Analyze", "End", "Showcase");
    await switchView(studioTabs, "Showcase", "Home", "Edit");
    // Repeat through the reverse presentation path to catch remount resets.
    await switchView(modes, "Studio", "End", "Visual");
    await switchView(modes, "Visual", "Home", "Play");
    await switchView(modes, "Play", "ArrowRight", "Studio");
    const displayedLevels = await page.getByRole("slider", { name: /fader$/i }).evaluateAll((elements) =>
      elements.map((element) => Number(element.value)));
    assert.deepEqual(displayedLevels, levels, "Returning to Edit must preserve both displayed stem faders");
    const samples = await page.evaluate(() => window.__viewAudio.end());
    await writeFile(new URL(`view-audio-${kind}.json`, output),
      JSON.stringify({ baseline, checkpoints, samples, displayedLevels }, null, 2));
    assert(samples.length > 20, "Continuity requires observations during, not only after, switches");
    const audible = (sample) => sample.outputs.filter((item) => item.connected && item.rms > 0.005);
    assert.equal(audible(baseline).length, 1, "Exactly one output engine must be audible at baseline");
    let previous = baseline;
    for (const sample of [...samples, ...checkpoints].sort((a, b) => a.at - b.at)) {
      assert.deepEqual(signature(sample), signature(baseline), `${kind}: no source restart, lost connection, duplicate engine, or gain reset`);
      assert.equal(sample.starts, baseline.starts, `${kind}: switching must not start another source`);
      assert.equal(sample.playingMedia, baseline.playingMedia, `${kind}: no duplicate or stopped media engine`);
      assert.deepEqual(sample.states, baseline.states, `${kind}: audio context must not suspend`);
      assert.equal(audible(sample).length, 1, `${kind}: output must stay audible through each switch`);
      const activeContext = baseline.clocks.findIndex((_, index) => baseline.states[index] === "running");
      const elapsed = (sample.at - baseline.at) / 1000;
      assert(Math.abs(sample.clocks[activeContext] - baseline.clocks[activeContext] - elapsed) < 0.2,
        `${kind}: native audio clock must continue at wall-clock rate (audio=${sample.clocks[activeContext] - baseline.clocks[activeContext]}, wall=${elapsed})`);
      for (let i = 0; i < sample.sources.length; i++) {
        if (sample.sources[i].mediaTime !== null) {
          assert(sample.sources[i].mediaTime >= previous.sources[i].mediaTime,
            "Stem media clock must never rewind");
          assert(Math.abs(sample.sources[i].mediaTime - baseline.sources[i].mediaTime - elapsed) < 0.25,
            "Stem media must advance without a pause or seek");
        }
      }
      previous = sample;
    }
    assert(checkpoints.at(-1).clocks.some((clock, index) => clock > baseline.clocks[index] + 2),
      "Audio clock must measurably advance across the keyboard sequence");
    evidence.push({ kind, baseline, checkpoints, displayedLevels, sampleCount: samples.length, samples });
    await play.focus();
    await page.keyboard.press("Enter");
    console.log(`PASS: ${kind} audio clock, native levels, uninterrupted output and single engine across keyboard view switches (${samples.length} observations).`);
  }
  await writeFile(new URL("view-audio.json", output), JSON.stringify({
    evidenceKind: "browser-audio-acceptance", browser: page.context().browser().version(),
    note: "Synthetic tones in native Chromium audio; not Windows or hardware audibility evidence.",
    evidence,
  }, null, 2));
}
