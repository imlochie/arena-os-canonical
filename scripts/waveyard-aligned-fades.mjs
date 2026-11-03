// Isolated real-media regression, also called by the queue continuity fixture.
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
const require = createRequire(new URL("../artifacts/api-server/package.json", import.meta.url));
const { chromium } = require("playwright-core");

function wav(seconds) {
  const samples = 22050 * seconds;
  const bytes = Buffer.alloc(44 + samples * 2);
  bytes.write("RIFF"); bytes.writeUInt32LE(bytes.length - 8, 4); bytes.write("WAVEfmt ", 8);
  bytes.writeUInt32LE(16, 16); bytes.writeUInt16LE(1, 20); bytes.writeUInt16LE(1, 22);
  bytes.writeUInt32LE(22050, 24); bytes.writeUInt32LE(44100, 28); bytes.writeUInt16LE(2, 32);
  bytes.writeUInt16LE(16, 34); bytes.write("data", 36); bytes.writeUInt32LE(samples * 2, 40);
  for (let i = 0; i < samples; i++) bytes.writeInt16LE(Math.round(1200 * Math.sin(2 * Math.PI * 220 * i / 22050)), 44 + i * 2);
  return bytes;
}

export async function verifyAlignedFades(browser, { liveSettingsOnly = false, scenarioName } = {}) {
  const audio = wav(12);
  const scenarios = [
    ...["beat", "bar"].flatMap((mode) => [false, true].map((missing) => ({ name: `${mode}, missing=${missing}`, mode, missing, replay: true }))),
    { name: "length saved before cue", mode: "beat", edit: "length-before", cue: 8.75 },
    { name: "mode saved before cue", mode: "beat", edit: "mode-before", cue: 8.25 },
    { name: "auto enabled before cue", mode: "bar", edit: "enable-before", initiallyOff: true, cue: 8.25 },
    { name: "length changed after new cue", mode: "beat", edit: "length-after", skip: true },
    { name: "mode changed after new cue", mode: "beat", edit: "mode-after", skip: true },
    { name: "auto disabled across cue then enabled", mode: "beat", edit: "enable-after", skip: true },
    { name: "auto stays disabled across cue", mode: "bar", edit: "disable", disabled: true, skip: true },
    { name: "backgrounded clock arrives late", mode: "beat", edit: "late-clock", skip: true },
    { name: "missing-grid settings do not rearm warnings", mode: "beat", missing: true, length: 4, edit: "warning-edits", skip: true },
  ];
  const selected = scenarios.filter((scenario) => (!liveSettingsOnly || !scenario.replay)
    && (!scenarioName || scenario.name === scenarioName || scenario.edit === scenarioName));
  assert.ok(selected.length > 0, "at least one aligned-fade scenario must be selected");
  for (const scenario of selected) {
      const { mode, missing = false } = scenario;
      const context = await browser.newContext();
      try {
        const sessionId = "550e8400-e29b-41d4-a716-446655440016";
        const grid = Array.from({ length: 24 }, (_, index) => 250 + index * 500);
        const tracks = [0, 1].map((index) => ({
          id: `aligned-${index}`, position: index, queueItemId: null,
          track: { id: `aligned-track-${index}`, title: `Aligned fixture ${index}`, artist: "Synthetic", durationSeconds: 12 },
          sourceAssetId: `aligned-source-${index}`, stems: [],
          playback: { assetIds: [`aligned-source-${index}`], kind: "source" },
          playbackPreference: "source", stemMix: {},
          transition: { mode, crossfadeSeconds: scenario.length ?? 2, keepStems: [] },
          analysis: { bpm: 120, musicalKey: null, beatGridMs: missing && index === 1 ? null : grid },
        }));
        const session = { id: sessionId, name: "Aligned fades", currentSessionTrackId: tracks[0].id, positionSeconds: 0, tracks, swaps: [] };
        await context.addInitScript(({ sessionId, initiallyOff }) => {
          localStorage.setItem("waveyard.listening.sessionId", sessionId);
          localStorage.setItem("waveyard:auto-crossfade", initiallyOff ? "off" : "on");
          // Simulate a backgrounded UI clock while native media keeps playing.
          const raf = window.requestAnimationFrame.bind(window);
          const cancel = window.cancelAnimationFrame.bind(window);
          const held = new Map();
          window.requestAnimationFrame = (callback) => {
            const id = raf((now) => {
              if (window.holdFadeClock) held.set(id, callback);
              else callback(now);
            });
            return id;
          };
          window.cancelAnimationFrame = (id) => { held.delete(id); cancel(id); };
          window.releaseFadeClock = () => {
            window.holdFadeClock = false;
            for (const callback of held.values()) raf(callback);
            held.clear();
          };
          // Keep pagehide saves for this fake session away from the real API.
          const fetchOriginal = window.fetch.bind(window);
          window.fetch = (input, init) => init?.keepalive && String(input).includes(sessionId)
            ? Promise.resolve(new Response('{"ok":true}', { status: 200 }))
            : fetchOriginal(input, init);
          window.fadeStarts = [];
          document.addEventListener("play", (event) => {
            const target = event.target;
            if (!(target instanceof HTMLAudioElement) || !target.closest('.sess-deck[data-role="next"]')) return;
            const outgoing = document.querySelector('.sess-deck[data-role="current"] audio');
            window.fadeStarts.push({ outgoing: outgoing?.currentTime, incoming: target.currentTime });
          }, true);
        }, { sessionId, initiallyOff: scenario.initiallyOff });
        await context.route("**/api/**", async (route) => {
          const path = new URL(route.request().url()).pathname;
          if (path.startsWith("/api/assets/")) {
            const range = /^bytes=(\d+)-(\d*)$/.exec(route.request().headers().range ?? "");
            const start = range ? Number(range[1]) : 0;
            const end = range?.[2] ? Math.min(Number(range[2]), audio.length - 1) : audio.length - 1;
            return route.fulfill({ status: range ? 206 : 200, contentType: "audio/wav", body: audio.subarray(start, end + 1),
              headers: { "Cache-Control": "no-store", "Accept-Ranges": "bytes", "Content-Length": String(end - start + 1),
                ...(range ? { "Content-Range": `bytes ${start}-${end}/${audio.length}` } : {}) } });
          }
          let body = {};
          if (path.startsWith(`/api/library/sessions/${sessionId}`)) {
            if (["PUT", "PATCH"].includes(route.request().method())) {
              const patch = route.request().postDataJSON();
              const item = tracks.find((track) => path.endsWith(`/tracks/${track.id}`));
              Object.assign(item ?? session, patch);
            }
            body = { session };
          } else if (path === "/api/library/tracks") body = { tracks: [] };
          else if (path === "/api/library/playlists") body = { playlists: [] };
          else if (path === "/api/library/queue") body = { queue: [] };
          else if (path === "/api/library/sessions") body = { sessions: [] };
          return route.fulfill({ json: body });
        });
        const page = await context.newPage();
        await page.goto("http://localhost:80/waveyard");
        await page.getByTestId("session-play").waitFor();
        await page.waitForFunction(() => [...document.querySelectorAll(".sess-deck audio")].length === 2
          && [...document.querySelectorAll(".sess-deck audio")].every((audio) => audio.readyState >= 2));
        const cue = scenario.cue ?? (mode === "beat" ? 9.75 : 8.25);
        for (let traversal = 0; traversal < (scenario.replay ? 2 : 1); traversal++) {
        if (traversal > 0) {
          await page.getByTestId("session-play").click();
          await page.getByRole("button", { name: "Previous track", exact: true }).click();
          await page.waitForFunction(() => document.querySelector(".wy-now b")?.textContent === "Aligned fixture 0");
          await page.waitForFunction(() => document.querySelector('.sess-deck[data-role="current"] audio')?.readyState >= 2);
          await page.evaluate(() => { window.fadeStarts = []; });
        }
        // Leave genuine playback time before the cue to catch forward seeking.
        await page.getByLabel("Seek current track", { exact: true }).fill("6");
        await page.getByTestId("session-play").click();
        await page.waitForFunction(() => {
          const audio = document.querySelector('.sess-deck[data-role="current"] audio');
          return audio && !audio.paused && audio.currentTime > 7;
        });
        assert.deepEqual(await page.evaluate(() => window.fadeStarts), [], `${mode}: no early incoming playback or cue jump`);
        const waitPosition = (position) => page.waitForFunction((target) =>
          document.querySelector('.sess-deck[data-role="current"] audio')?.currentTime >= target, position, { polling: 50 });
        const saveEdit = async (selector, value, expected) => {
          const saved = page.waitForResponse((response) => {
            const request = response.request();
            return request.method() === "PATCH"
              && new URL(request.url()).pathname.endsWith(`/tracks/${tracks[0].id}`)
              && Object.entries(expected).every(([key, value]) => request.postDataJSON().transition?.[key] === value);
          });
          if (selector === "#sess-mode") await page.locator(selector).selectOption(value);
          else await page.locator(selector).fill(value);
          assert.equal((await saved).ok(), true, "live transition settings were acknowledged before checking the cue");
        };
        if (scenario.edit === "length-before") await saveEdit("#sess-fade", "3", { crossfadeSeconds: 3 });
        if (scenario.edit === "mode-before") await saveEdit("#sess-mode", "bar", { mode: "bar" });
        if (scenario.edit === "enable-before") await page.getByTestId("session-auto-crossfade").check();
        if (scenario.edit === "length-after" || scenario.edit === "mode-after") {
          await waitPosition(8.8);
          if (scenario.edit === "length-after") await saveEdit("#sess-fade", "4", { crossfadeSeconds: 4 });
          else await saveEdit("#sess-mode", "bar", { mode: "bar" });
        }
        if (["enable-after", "disable"].includes(scenario.edit)) {
          await page.getByTestId("session-auto-crossfade").uncheck();
          if (scenario.edit === "enable-after") {
            await waitPosition(10.5);
            await page.getByTestId("session-auto-crossfade").check();
          }
        }
        if (scenario.edit === "late-clock") {
          await page.evaluate(() => {
            window.holdFadeClock = true;
            Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "hidden" });
            document.dispatchEvent(new Event("visibilitychange"));
          });
          await waitPosition(10.5);
          assert.deepEqual(await page.evaluate(() => window.fadeStarts), [], "native audio advances while UI callbacks are held");
          await page.evaluate(() => {
            Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "visible" });
            document.dispatchEvent(new Event("visibilitychange"));
            window.releaseFadeClock();
          });
        }
        if (scenario.edit === "warning-edits") {
          await page.getByTestId("session-status").filter({ hasText: "Automatic fade skipped" }).waitFor();
          await saveEdit("#sess-fade", "0.5", { crossfadeSeconds: 0.5 });
          await saveEdit("#sess-mode", "bar", { mode: "bar" });
          await page.getByTestId("session-auto-crossfade").uncheck();
          await page.getByTestId("session-auto-crossfade").check();
          // A near-position seek clears status without a genuine rewind. A new warning
          // after the changed fallback would interrupt that cleared status.
          const position = await page.locator('.sess-deck[data-role="current"] audio').evaluate((audio) => audio.currentTime);
          await page.getByLabel("Seek current track", { exact: true }).fill(String(Math.round(position * 2) / 2));
          await waitPosition(11.7);
          assert.equal(await page.getByTestId("session-status").count(), 0, "settings edits do not reissue a consumed missing-grid warning");
          assert.deepEqual(await page.evaluate(() => window.fadeStarts), []);
        } else if (scenario.skip) {
          if (!scenario.disabled) await page.getByTestId("session-status").filter({ hasText: "verified automatic fade cue was missed" }).waitFor();
          await waitPosition(11.3);
          assert.deepEqual(await page.evaluate(() => window.fadeStarts), [], `${scenario.name}: no off-beat incoming playback`);
        } else if (missing) {
          await page.getByTestId("session-status").filter({ hasText: "Automatic fade skipped; the next track will start at the end." }).waitFor();
          const status = await page.getByTestId("session-status").innerText();
          assert.match(status, /Beat grids are not available/);
          await page.evaluate(() => {
            window.statusChanges = 0;
            new MutationObserver(() => { window.statusChanges++; }).observe(document.querySelector('[data-testid="session-status"]'), { childList: true, characterData: true, subtree: true });
          });
          await page.waitForFunction(() => document.querySelector('.sess-deck[data-role="current"] audio')?.currentTime > 11);
          assert.equal(await page.evaluate(() => window.statusChanges), 0, `${mode}: missing-grid status is not repeated`);
          assert.deepEqual(await page.evaluate(() => window.fadeStarts), [], `${mode}: missing grid does not start a guessed fade`);
        } else {
          await page.waitForFunction(() => window.fadeStarts.length === 1);
          const [start] = await page.evaluate(() => window.fadeStarts);
          assert.ok(start.outgoing >= cue && start.outgoing < cue + 0.4, `${mode}: starts on verified ${cue}s cue, got ${start.outgoing}`);
          assert.ok(Math.abs(start.incoming - 0.25) < 0.15, `${mode}: incoming starts at its verified beat`);
          const selectedMode = scenario.edit === "mode-before" ? "bar" : mode;
          await page.getByText(`Automatic ${selectedMode}-aligned fade`, { exact: false }).waitFor();
        }
        await page.waitForFunction(() => document.querySelector(".wy-now b")?.textContent === "Aligned fixture 1");
        const live = await page.locator('.sess-deck[data-role="current"] audio').evaluate((audio) => ({ playing: !audio.paused, position: audio.currentTime }));
        assert.equal(live.playing, true, `${mode}: the next song is actually playing`);
        if (!missing && !scenario.skip) assert.ok(live.position < (scenario.edit === "length-before" ? 4 : 3), `${mode}: fade completes before outgoing audio ends`);
        else await page.getByTestId("session-status").filter({ hasText: "Track finished — the next deck took over." }).waitFor();
        console.log(`PASS: ${scenario.name}${traversal ? " on replay" : ""}, ${missing || scenario.skip ? "cuts at end without a guessed fade" : `verified ${cue}s cue without seeking`}`);
        }
      } finally {
        await context.close();
      }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const browser = await chromium.launch({ executablePath: "/repl/tools/bin/chromium", args: ["--no-sandbox", "--autoplay-policy=no-user-gesture-required"] });
  try {
    await verifyAlignedFades(browser, {
      liveSettingsOnly: process.argv.includes("--live-settings-only"),
      scenarioName: process.argv.find((arg) => arg.startsWith("--scenario="))?.slice("--scenario=".length),
    });
  } finally { await browser.close(); }
}
