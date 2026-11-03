import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { existsSync } from "node:fs";

const require = createRequire(new URL("../artifacts/api-server/package.json", import.meta.url));
const { chromium } = require("playwright-core");
const executablePath = process.env.CHROMIUM_PATH
  ?? (existsSync("/repl/tools/bin/chromium") ? "/repl/tools/bin/chromium" : undefined);
const browser = await chromium.launch({
  ...(executablePath ? { executablePath } : {}),
  args: ["--no-sandbox", "--autoplay-policy=no-user-gesture-required"],
});

const tracks = ["a", "b", "c"].map((id, index) => ({
  id: `separation-sync-${id}`,
  title: `Sync track ${id.toUpperCase()}`,
  artist: "Cross-tab fixture",
  album: "",
  durationSeconds: 120,
  playCount: 0,
  rating: 0,
  labels: [],
  lastPlayedAt: null,
  addedAt: new Date().toISOString(),
  sourceAssetId: `source-${id}`,
  stemAvailability: { status: "not-started", reason: "Stem separation has not started." },
  studioProjectId: `00000000-0000-4000-8000-00000000000${index + 1}`,
}));
const jobs = new Map();
const requestsByTrack = new Map();
const createdJobsByTrack = new Map();
let nextJob = 0;

try {
  const context = await browser.newContext({ serviceWorkers: "block" });
  await context.route("**/api/**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.pathname === "/api/library/tracks" && request.method() === "GET") {
      return route.fulfill({ json: { tracks } });
    }
    if (url.pathname.startsWith("/api/library/tracks/") && url.pathname.endsWith("/separation") && request.method() === "POST") {
      const trackId = url.pathname.split("/").at(-2);
      const track = tracks.find((candidate) => candidate.id === trackId);
      if (!track) return route.fulfill({ status: 404, json: { error: "Track not found." } });
      requestsByTrack.set(trackId, (requestsByTrack.get(trackId) ?? 0) + 1);
      let job = jobs.get(trackId);
      const newlyQueued = !job;
      if (!job) {
        job = { id: `separation-job-${++nextJob}` };
        jobs.set(trackId, job);
        createdJobsByTrack.set(trackId, (createdJobsByTrack.get(trackId) ?? 0) + 1);
      }
      track.stemAvailability = {
        status: "processing",
        stage: "queued",
        reason: "Stem separation is running — playback uses the full source until it completes.",
        cancelJobId: job.id,
      };
      return route.fulfill({
        status: newlyQueued ? 202 : 200,
        json: { state: newlyQueued ? "queued" : "processing", jobId: job.id, stemCount: null, error: null },
      });
    }
    const defaults = new Map([
      ["/api/library/queue", { queue: [] }],
      ["/api/library/playlists", { playlists: [] }],
      ["/api/library/collections", { collections: [] }],
      ["/api/library/playback-state", { playbackState: { currentTrackId: null, positionSeconds: 0 } }],
      ["/api/library/conversions", { conversions: [], jobs: [] }],
      ["/api/library/conversions/jobs", { jobs: [] }],
      ["/api/waveyard/separation/models", { models: [] }],
    ]);
    const body = defaults.get(url.pathname);
    if (body) return route.fulfill({ json: body });
    return route.fallback();
  });

  const activePage = await context.newPage();
  const currentMirror = await context.newPage();
  const staleMirror = await context.newPage();
  const pageErrors = [];
  for (const page of [activePage, currentMirror, staleMirror]) {
    page.on("pageerror", (error) => pageErrors.push(error.message));
    page.on("console", (message) => {
      if (message.type() === "error") pageErrors.push(message.text());
    });
  }
  await staleMirror.addInitScript(() => {
    const addEventListener = BroadcastChannel.prototype.addEventListener;
    BroadcastChannel.prototype.addEventListener = function (type, listener, options) {
      if (this.name === "waveyard:queue-sync" && type === "message") return;
      return addEventListener.call(this, type, listener, options);
    };
  });
  await Promise.all([activePage, currentMirror, staleMirror].map((page) => page.goto("http://localhost:80/waveyard")));
  const startButton = (page, id) => page.getByTestId(`button-start-separation-separation-sync-${id}`);
  const stopButton = (page, id) => page.getByTestId(`button-cancel-separation-separation-sync-${id}`);

  try {
    for (const page of [activePage, currentMirror, staleMirror]) {
      await startButton(page, "a").waitFor({ state: "visible", timeout: 8_000 });
      await startButton(page, "b").waitFor({ state: "visible", timeout: 8_000 });
      await startButton(page, "c").waitFor({ state: "visible", timeout: 8_000 });
    }
  } catch (error) {
    const state = await activePage.evaluate(() => ({
      title: document.title,
      text: document.body.innerText.slice(0, 1200),
      rows: [...document.querySelectorAll("[data-testid]")].map((element) => element.getAttribute("data-testid"))
        .filter((id) => id?.includes("separation") || id?.includes("track")),
    }));
    console.error("SEPARATION_TAB_SYNC_SETUP", JSON.stringify({ state, pageErrors }));
    throw error;
  }

  await startButton(activePage, "a").click();
  await stopButton(currentMirror, "a").waitFor({ state: "visible" });
  await startButton(currentMirror, "a").waitFor({ state: "detached" });
  assert.equal(createdJobsByTrack.get("separation-sync-a"), 1, "one cross-tab start creates one separation job");

  await startButton(activePage, "b").click();
  await stopButton(currentMirror, "b").waitFor({ state: "visible" });
  await startButton(currentMirror, "b").waitFor({ state: "detached" });
  assert.equal(createdJobsByTrack.get("separation-sync-b"), 1, "the live tab shows the shared job state");
  assert.equal(await startButton(staleMirror, "b").isVisible(), true, "a tab that missed notification still has stale UI until it reconciles");

  await startButton(staleMirror, "b").click();
  await stopButton(staleMirror, "b").waitFor({ state: "visible" });
  await startButton(staleMirror, "b").waitFor({ state: "detached" });
  assert.equal(requestsByTrack.get("separation-sync-b"), 2, "the stale click resolves against the authoritative start endpoint");
  assert.equal(createdJobsByTrack.get("separation-sync-b"), 1, "the stale click reuses the active job instead of queuing duplicate work");

  await startButton(activePage, "c").click();
  assert.equal(await startButton(staleMirror, "c").isVisible(), true, "the notification-suspended tab has not yet claimed a current state");
  await staleMirror.evaluate(() => window.dispatchEvent(new Event("focus")));
  await stopButton(staleMirror, "c").waitFor({ state: "visible" });
  await startButton(staleMirror, "c").waitFor({ state: "detached" });
  assert.equal(createdJobsByTrack.get("separation-sync-c"), 1, "focus recovery reads the latest library status");
  assert.deepEqual(pageErrors, [], `the library pages stay free of runtime errors: ${pageErrors.join("; ")}`);

  console.log("PASS: separation start updates a live library tab, stale clicks reuse the active job, and focus recovery refreshes missed status");
  await context.close();
} finally {
  await browser.close();
}
