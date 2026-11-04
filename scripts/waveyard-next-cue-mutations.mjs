// Real-media browser coverage for changing the upcoming session track around an automatic cue.
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

const scenarios = [
  { name: "target-replace-before-beat", mode: "beat", action: "replace", timing: "before", incomingGridStart: 620, delayNewAudio: true },
  { name: "target-replace-after-bar", mode: "bar", action: "replace", timing: "after", incomingGridStart: 1150, delayNewAudio: true, holdClock: true },
  { name: "target-remove-before-beat", mode: "beat", action: "remove", timing: "before" },
  { name: "target-remove-after-bar", mode: "bar", action: "remove", timing: "after", holdClock: true },
  { name: "target-replace-missing-grid", mode: "beat", action: "replace", timing: "before", incomingGridStart: null },
  { name: "target-replace-after-missed-cue", mode: "bar", action: "replace", timing: "missed", incomingGridStart: 900, holdClock: true },
];

function makeTrack(id, title, grid, mode) {
  return {
    id,
    position: 0,
    queueItemId: null,
    track: { id: `${id}-track`, title, artist: "Synthetic", durationSeconds: 12 },
    sourceAssetId: `${id}-source`,
    stems: [],
    playback: { assetIds: [`${id}-source`], kind: "source" },
    playbackPreference: "source",
    stemMix: {},
    transition: { mode, crossfadeSeconds: 2, keepStems: [] },
    analysis: { bpm: 120, musicalKey: null, beatGridMs: grid },
  };
}

export async function verifyNextSongCueChanges(browser, scenarioName) {
  const audio = wav(12);
  const selected = scenarios.filter((scenario) => !scenarioName || scenario.name === scenarioName);
  assert.ok(selected.length > 0, `a next-song cue scenario must match ${scenarioName ?? "the full suite"}`);

  for (const scenario of selected) {
    const context = await browser.newContext();
    try {
      const sessionId = "550e8400-e29b-41d4-a716-446655440017";
      const currentGrid = Array.from({ length: 24 }, (_, index) => 250 + index * 500);
      const oldGrid = Array.from({ length: 24 }, (_, index) => 250 + index * 500);
      const replacementGrid = scenario.incomingGridStart === null
        ? null
        : Array.from({ length: 24 }, (_, index) => scenario.incomingGridStart + index * 500);
      const current = makeTrack("cue-current", "Cue current", currentGrid, scenario.mode);
      const oldNext = makeTrack("cue-old-next", "Cue old next", oldGrid, scenario.mode);
      const replacement = makeTrack("cue-replacement", "Cue replacement", replacementGrid, scenario.mode);
      const tracks = scenario.action === "remove" ? [current, oldNext] : [current, oldNext, replacement];
      tracks.forEach((track, index) => { track.position = index; });
      const session = {
        id: sessionId,
        name: "Cue change regression",
        currentSessionTrackId: current.id,
        positionSeconds: 0,
        tracks,
        swaps: [],
      };

      let releaseDelayedAudio = () => {};
      let signalDelayedRequest = () => {};
      const delayedRequest = new Promise((resolve) => { signalDelayedRequest = resolve; });
      const delayedAudioGate = new Promise((resolve) => { releaseDelayedAudio = resolve; });
      let delayedAudioReleased = false;
      let releaseMutation = () => {};
      let signalMutationRequest = () => {};
      const mutationRequested = new Promise((resolve) => { signalMutationRequest = resolve; });
      const mutationGate = new Promise((resolve) => { releaseMutation = resolve; });
      let mutationReleased = false;
      const cueSeconds = scenario.mode === "beat" ? 9.75 : 8.25;

      await context.addInitScript(({ sessionId }) => {
        localStorage.setItem("waveyard.listening.sessionId", sessionId);
        localStorage.setItem("waveyard:auto-crossfade", "on");
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
        const fetchOriginal = window.fetch.bind(window);
        window.fetch = (input, init) => init?.keepalive && String(input).includes(sessionId)
          ? Promise.resolve(new Response('{"ok":true}', { status: 200 }))
          : fetchOriginal(input, init);
        window.fadeStarts = [];
        window.currentSeekEvents = [];
        window.currentSeekWrites = [];
        const currentTimeDescriptor = Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, "currentTime");
        Object.defineProperty(HTMLMediaElement.prototype, "currentTime", {
          configurable: true,
          get() { return currentTimeDescriptor.get.call(this); },
          set(value) {
            if (this.src.includes("cue-current-source")) {
              window.currentSeekWrites.push({
                value,
                previous: currentTimeDescriptor.get.call(this),
                stack: new Error().stack,
              });
            }
            return currentTimeDescriptor.set.call(this, value);
          },
        });
        document.addEventListener("play", (event) => {
          const target = event.target;
          if (!(target instanceof HTMLAudioElement) || !target.closest('.sess-deck[data-role="next"]')) return;
          const outgoing = document.querySelector('.sess-deck[data-role="current"] audio');
          window.fadeStarts.push({
            outgoing: outgoing?.currentTime ?? null,
            incoming: target.currentTime,
            sourceId: new URL(target.currentSrc || target.src).pathname.split("/").at(-1),
          });
        }, true);
        window.standbyPlayingStarts = [];
        document.addEventListener("playing", (event) => {
          const target = event.target;
          if (!(target instanceof HTMLAudioElement)) return;
          window.standbyPlayingStarts.push(new URL(target.currentSrc || target.src).pathname.split("/").at(-1));
        }, true);
      }, { sessionId });

      await context.route("**/api/**", async (route) => {
        const request = route.request();
        const url = new URL(request.url());
        const path = url.pathname;
        if (path.startsWith("/api/assets/")) {
          const assetId = path.split("/").at(-1);
          const delayedAsset = (scenario.delayNewAudio && assetId === replacement.sourceAssetId)
            || (scenario.delayOldAudio && assetId === oldNext.sourceAssetId);
          if (delayedAsset && !delayedAudioReleased) {
            signalDelayedRequest();
            await delayedAudioGate;
            delayedAudioReleased = true;
          }
          const range = /^bytes=(\d+)-(\d*)$/.exec(request.headers().range ?? "");
          const start = range ? Number(range[1]) : 0;
          const end = range?.[2] ? Math.min(Number(range[2]), audio.length - 1) : audio.length - 1;
          try {
            return await route.fulfill({
            status: range ? 206 : 200,
            contentType: "audio/wav",
            body: audio.subarray(start, end + 1),
            headers: {
              "Cache-Control": "no-store",
              "Accept-Ranges": "bytes",
              "Content-Length": String(end - start + 1),
              ...(range ? { "Content-Range": `bytes ${start}-${end}/${audio.length}` } : {}),
            },
            });
          } catch {
            return;
          }
        }

        let body = {};
        const sessionPath = `/api/library/sessions/${sessionId}`;
        if (path === `${sessionPath}/tracks` && request.method() === "PATCH") {
          const patch = request.postDataJSON();
          if (scenario.timing === "after" && !mutationReleased) {
            signalMutationRequest();
            await mutationGate;
            mutationReleased = true;
          }
          const fromIndex = session.tracks.findIndex((track) => track.id === patch.sessionTrackId);
          if (fromIndex >= 0) {
            const [track] = session.tracks.splice(fromIndex, 1);
            session.tracks.splice(Math.min(patch.position, session.tracks.length), 0, track);
            session.tracks.forEach((item, index) => { item.position = index; });
          }
          body = { session };
        } else if (path === `${sessionPath}/tracks` && request.method() === "DELETE") {
          if (scenario.timing === "after" && !mutationReleased) {
            signalMutationRequest();
            await mutationGate;
            mutationReleased = true;
          }
          const itemId = url.searchParams.get("sessionTrackId");
          session.tracks = session.tracks.filter((track) => track.id !== itemId);
          session.tracks.forEach((item, index) => { item.position = index; });
          body = { session };
        } else if (path.startsWith(sessionPath)) {
          if (["PUT", "PATCH"].includes(request.method())) {
            const patch = request.postDataJSON();
            const item = session.tracks.find((track) => path.endsWith(`/tracks/${track.id}`));
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
      await page.waitForFunction((delayedOldAudio) => {
        const currentAudio = document.querySelector('.sess-deck[data-role="current"] audio');
        const nextAudio = document.querySelector('.sess-deck[data-role="next"] audio');
        return currentAudio?.readyState >= 2 && (delayedOldAudio || nextAudio?.readyState >= 2);
      }, Boolean(scenario.delayOldAudio));
      if (scenario.delayOldAudio) await delayedRequest;
      await page.getByLabel("Seek current track", { exact: true }).fill("6");
      await page.evaluate(() => {
        const current = document.querySelector('.sess-deck[data-role="current"] audio');
        if (current) current.addEventListener("seeking", () => { window.currentSeekEvents.push(current.currentTime); });
        window.currentSeekEvents = [];
      });
      await page.getByTestId("session-play").click();
      await page.waitForFunction(() => {
        const current = document.querySelector('.sess-deck[data-role="current"] audio');
        return current && !current.paused && current.currentTime > 6.1;
      });
      await page.evaluate(() => { window.currentSeekEvents = []; window.currentSeekWrites = []; });
      if (scenario.holdClock) {
        await page.evaluate(() => {
          window.holdFadeClock = true;
          Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "hidden" });
          document.dispatchEvent(new Event("visibilitychange"));
        });
      }

      const mutationTime = scenario.timing === "before"
        ? cueSeconds - 0.45
        : scenario.timing === "after" ? cueSeconds - 0.2
        : scenario.timing === "missed" ? cueSeconds + 0.5 : null;
      if (mutationTime !== null) {
        await page.waitForFunction((time) => {
          return document.querySelector('.sess-deck[data-role="current"] audio')?.currentTime >= time;
        }, mutationTime, { polling: 25 });
      } else if (scenario.timing === "pending") {
        await page.waitForFunction((sourceId) => window.fadeStarts.some((start) => start.sourceId === sourceId),
          oldNext.sourceAssetId, { polling: 25 });
      }

      const changeTarget = async () => {
        await page.getByText(`Session order · ${tracks.length}`, { exact: true }).click();
        if (scenario.action === "replace") {
          const orderResponse = page.waitForResponse((response) =>
            response.request().method() === "PATCH"
            && new URL(response.url()).pathname.endsWith("/tracks"));
          const click = page.getByRole("button", { name: "Move Cue replacement earlier", exact: true }).click();
          if (scenario.timing === "after") {
            await mutationRequested;
            await page.waitForFunction((time) => {
              return document.querySelector('.sess-deck[data-role="current"] audio')?.currentTime >= time;
            }, cueSeconds + 0.1, { polling: 10 });
            releaseMutation();
          }
          await click;
          await orderResponse;
          assert.equal(session.tracks[1]?.id, replacement.id, `${scenario.name}: fixture accepted the replacement reorder`);
          await page.waitForFunction(() => {
            const firstUpcoming = document.querySelectorAll(".sess-queue-list > li")[1];
            return firstUpcoming?.textContent?.includes("Cue replacement");
          });
        } else {
          const removalResponse = page.waitForResponse((response) =>
            response.request().method() === "DELETE"
            && new URL(response.url()).pathname.endsWith("/tracks"));
          const click = page.getByRole("button", { name: "Remove Cue old next", exact: true }).click();
          if (scenario.timing === "after") {
            await mutationRequested;
            await page.waitForFunction((time) => {
              return document.querySelector('.sess-deck[data-role="current"] audio')?.currentTime >= time;
            }, cueSeconds + 0.1, { polling: 10 });
            releaseMutation();
          }
          await click;
          await removalResponse;
          assert.equal(session.tracks.length, 1, `${scenario.name}: fixture accepted the removal`);
          await page.waitForFunction(() => document.querySelectorAll(".sess-queue-list > li").length === 1);
        }
      };
      if (scenario.timing !== "missed") await changeTarget();

      if (scenario.delayNewAudio) {
        await delayedRequest;
        const pendingLoad = await page.evaluate(() => ({
          nextReadyState: document.querySelector('.sess-deck[data-role="next"] audio')?.readyState ?? -1,
          currentPlaying: !document.querySelector('.sess-deck[data-role="current"] audio')?.paused,
          starts: window.fadeStarts,
        }));
        assert.ok(pendingLoad.nextReadyState < 2, `${scenario.name}: the incoming source is still waiting on its delayed media response`);
        assert.equal(pendingLoad.currentPlaying, true, `${scenario.name}: delayed incoming media does not pause the current song`);
        assert.ok(pendingLoad.starts.every((start) => start.sourceId !== oldNext.sourceAssetId),
          `${scenario.name}: the replaced standby source never starts`);
        if (scenario.timing === "before") {
          await page.waitForFunction((time) => {
            return document.querySelector('.sess-deck[data-role="current"] audio')?.currentTime >= time;
          }, cueSeconds + 0.1, { polling: 25 });
        }
        releaseDelayedAudio();
      }
      if (scenario.delayOldAudio && !delayedAudioReleased) {
        releaseDelayedAudio();
        delayedAudioReleased = true;
      }

      if (scenario.holdClock) {
        if (scenario.timing === "missed") {
          // First let the real media clock cross the cue while the UI callback is held,
          // then deliver the late callback before changing the queued target.
          await page.evaluate(() => {
            Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "visible" });
            document.dispatchEvent(new Event("visibilitychange"));
            window.releaseFadeClock();
          });
          await page.getByTestId("session-status")
            .filter({ hasText: "verified automatic fade cue was missed" }).waitFor();
          await changeTarget();
        } else {
          await page.evaluate(() => {
            Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "visible" });
            document.dispatchEvent(new Event("visibilitychange"));
            window.releaseFadeClock();
          });
        }
      }

      if (scenario.action === "replace" && scenario.incomingGridStart !== null && scenario.timing !== "missed") {
        try {
          await page.waitForFunction((sourceId) => window.fadeStarts.some((start) => start.sourceId === sourceId),
            replacement.sourceAssetId, { timeout: 2500 });
        } catch {
          const state = await page.evaluate(() => ({
            now: document.querySelector('.sess-deck[data-role="current"] audio')?.currentTime,
            current: document.querySelector(".wy-now b")?.textContent,
            status: document.querySelector('[data-testid="session-status"]')?.textContent,
            phase: document.querySelector(".wy-workspace .eyebrow")?.textContent,
            fadeStarts: window.fadeStarts,
            audibleStarts: window.standbyPlayingStarts,
            nextSrc: document.querySelector('.sess-deck[data-role="next"] audio')?.src,
            nextReady: document.querySelector('.sess-deck[data-role="next"] audio')?.readyState,
          }));
          throw new Error(`${scenario.name}: latest source never started: ${JSON.stringify(state)}`);
        }
        const start = await page.evaluate((sourceId) => window.fadeStarts.findLast((entry) => entry.sourceId === sourceId), replacement.sourceAssetId);
        const expectedOffset = scenario.incomingGridStart / 1000;
        assert.equal(start.sourceId, replacement.sourceAssetId, `${scenario.name}: only the latest standby source starts`);
        assert.ok(start.outgoing >= cueSeconds && start.outgoing < cueSeconds + 0.45,
          `${scenario.name}: the fade uses the verified ${cueSeconds}s outgoing cue, got ${start.outgoing}`);
        assert.ok(Math.abs(start.incoming - expectedOffset) < 0.18,
          `${scenario.name}: incoming audio uses the latest song's ${expectedOffset}s grid offset, got ${start.incoming}`);
        assert.ok(!(await page.evaluate((sourceId) => window.standbyPlayingStarts.includes(sourceId), oldNext.sourceAssetId)),
          `${scenario.name}: the replaced standby never becomes audibly playable`);
        const currentWrites = await page.evaluate(() => window.currentSeekWrites);
        assert.ok(currentWrites.every((write) => Math.abs(write.value - write.previous) <= 0.015),
          `${scenario.name}: current audio has no time jump; writes=${JSON.stringify(currentWrites)}`);
      } else {
        if (scenario.timing === "missed") {
          await page.getByTestId("session-status")
            .filter({ hasText: "verified automatic fade cue was missed" }).waitFor();
        } else if (scenario.action === "replace") {
          await page.getByTestId("session-status")
            .filter({ hasText: "Automatic fade skipped; the next track will start at the end." }).waitFor();
          assert.match(await page.getByTestId("session-status").innerText(), /Beat grids are not available/);
        }
        await page.waitForFunction((time) => {
          const current = document.querySelector('.sess-deck[data-role="current"] audio');
          return current && !current.paused && current.currentTime >= time;
        }, cueSeconds + 0.55, { polling: 25 });
        assert.deepEqual(await page.evaluate(() => window.fadeStarts), [], `${scenario.name}: removed, missing-grid, or missed target never starts`);
        const currentWrites = await page.evaluate(() => window.currentSeekWrites);
        assert.ok(currentWrites.every((write) => Math.abs(write.value - write.previous) <= 0.015),
          `${scenario.name}: current audio has no time jump; writes=${JSON.stringify(currentWrites)}`);
      }
      console.log(`PASS: ${scenario.name} keeps the live current song and standby target aligned`);
    } finally {
      await context.close();
    }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const browser = await chromium.launch({
    executablePath: "/repl/tools/bin/chromium",
    args: ["--no-sandbox", "--autoplay-policy=no-user-gesture-required"],
  });
  try {
    await verifyNextSongCueChanges(browser, process.argv.find((arg) => arg.startsWith("--scenario="))?.slice("--scenario=".length));
  } finally {
    await browser.close();
  }
}
