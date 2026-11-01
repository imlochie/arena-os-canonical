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

export async function verifyAlignedFades(browser) {
  const audio = wav(12);
  for (const mode of ["beat", "bar"]) {
    for (const missing of [false, true]) {
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
          transition: { mode, crossfadeSeconds: 2, keepStems: [] },
          analysis: { bpm: 120, musicalKey: null, beatGridMs: missing && index === 1 ? null : grid },
        }));
        const session = { id: sessionId, name: "Aligned fades", currentSessionTrackId: tracks[0].id, positionSeconds: 0, tracks, swaps: [] };
        await context.addInitScript(({ sessionId }) => {
          localStorage.setItem("waveyard.listening.sessionId", sessionId);
          localStorage.setItem("waveyard:auto-crossfade", "on");
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
        }, { sessionId });
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
            if (route.request().method() === "PUT") Object.assign(session, route.request().postDataJSON());
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
        const cue = mode === "beat" ? 9.75 : 8.25;
        for (let traversal = 0; traversal < 2; traversal++) {
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
        if (missing) {
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
          await page.getByText(`Automatic ${mode}-aligned fade`, { exact: false }).waitFor();
        }
        await page.waitForFunction(() => document.querySelector(".wy-now b")?.textContent === "Aligned fixture 1");
        const live = await page.locator('.sess-deck[data-role="current"] audio').evaluate((audio) => ({ playing: !audio.paused, position: audio.currentTime }));
        assert.equal(live.playing, true, `${mode}: the next song is actually playing`);
        if (!missing) assert.ok(live.position < 3, `${mode}: fade completes before outgoing audio ends`);
        else await page.getByTestId("session-status").filter({ hasText: "Track finished — the next deck took over." }).waitFor();
        console.log(`PASS: ${mode} automatic fade${traversal ? " on replay" : ""}, ${missing ? "missing grid cuts at end with one status" : `verified ${cue}s cue without seeking`}`);
        }
      } finally {
        await context.close();
      }
    }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const browser = await chromium.launch({ executablePath: "/repl/tools/bin/chromium", args: ["--no-sandbox", "--autoplay-policy=no-user-gesture-required"] });
  try { await verifyAlignedFades(browser); } finally { await browser.close(); }
}
