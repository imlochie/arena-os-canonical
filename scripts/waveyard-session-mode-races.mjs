import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";

// Run via arena-smoke.mjs --session-mode-races-only. The shared runner supplies
// its synthetic WAV generator, browser settings, and error collection.
export async function verifySessionModeRaces({ page, context, base, makePcmWav, output }) {
  const prefix = "arena-mode-race-";
  const tone = makePcmWav(440, 0.08, 120);
  const reports = [];
  let sessions;
  let pending = null;
  const stateWrites = [];
  const apiErrors = [];
  const deferred = () => {
    let resolve;
    const promise = new Promise(done => { resolve = done; });
    return { promise, resolve };
  };
  async function waitForGate(gate, label) {
    let timer;
    try {
      await Promise.race([
        gate.promise,
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error(`Timed out waiting for ${label}`)), 15_000);
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  }
  const item = (id, position) => ({
    id: `${prefix}${id}`, position, queueItemId: null,
    track: { id: `${prefix}track-${id}`, title: `Race song ${id}`, artist: "Synthetic fixture", durationSeconds: 120 },
    sourceAssetId: `${prefix}${id}-source`,
    stems: ["vocals", "drums", "bass", "other"].map(stemType => ({
      id: `${prefix}${id}-${stemType}`, stemType, engine: "smoke-test", durationSeconds: 120,
    })),
    playback: { kind: "stems", assetIds: ["vocals", "drums", "bass", "other"].map(stem => `${prefix}${id}-${stem}`) },
    playbackPreference: null,
    stemMix: { vocals: 1, drums: 1, bass: 1, other: 1 },
    transition: { mode: "manual", crossfadeSeconds: 15, keepStems: [] },
    analysis: { bpm: 120, musicalKey: "C major", beatGridMs: [0, 500, 1000, 1500] },
  });
  const makeSession = (suffix, tracks) => ({
    id: `${prefix}${suffix}`, name: `Mode race ${suffix}`, tracks,
    currentSessionTrackId: tracks[0].id, positionSeconds: 0, swaps: [],
    createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z",
  });

  // Keep fixture lifecycle saves inside Playwright routing, including pagehide.
  // Otherwise Chromium's keepalive requests can escape routes to the real API.
  await context.addInitScript((prefix) => {
    const nativeFetch = window.fetch.bind(window);
    window.fetch = (input, init) => {
      const url = typeof input === "string" ? input : input.url;
      if (url?.includes(`/api/library/sessions/${prefix}`) && init?.keepalive) {
        return nativeFetch(input, { ...init, keepalive: false });
      }
      return nativeFetch(input, init);
    };
  }, prefix);

  await page.route("**/api/**", async route => {
    const url = new URL(route.request().url());
    const method = route.request().method();
    const json = body => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(body) });
    try {
      if (url.pathname.startsWith(`/api/assets/${prefix}`)) {
        if (url.pathname.endsWith("/waveform")) return json({ peaks: [], durationSeconds: 120 });
        const range = route.request().headers().range?.match(/^bytes=(\d+)-(\d*)$/);
        const start = range ? Number(range[1]) : 0;
        const end = range?.[2] ? Math.min(Number(range[2]), tone.length - 1) : tone.length - 1;
        const body = tone.subarray(start, end + 1);
        return route.fulfill({
          status: range ? 206 : 200, contentType: "audio/wav", body,
          headers: {
            "Cache-Control": "no-store", "Accept-Ranges": "bytes", "Content-Length": String(body.length),
            ...(range ? { "Content-Range": `bytes ${start}-${end}/${tone.length}` } : {}),
          },
        });
      }
      if (url.pathname === "/api/library/tracks") return json({ tracks: [] });
      if (url.pathname === "/api/library/sessions" && method === "GET") {
        return json({ sessions: Object.values(sessions).map(session => ({ ...session, trackCount: session.tracks.length })) });
      }
      const match = url.pathname.match(/^\/api\/library\/sessions\/([^/]+)(.*)$/);
      if (!match || !match[1].startsWith(prefix)) return route.fallback();
      const session = sessions[match[1]];
      assert(session, `Unexpected fixture session: ${match[1]}`);
      const suffix = match[2];
      if (!suffix && method === "GET") return json({ session });
      if (suffix === "/state" && method === "PUT") {
        const state = route.request().postDataJSON();
        stateWrites.push({ sessionId: session.id, ...state });
        Object.assign(session, state);
        return json({ saved: true });
      }
      if (suffix === "/tracks" && method === "DELETE") {
        const id = url.searchParams.get("sessionTrackId");
        session.tracks = session.tracks.filter(track => track.id !== id);
        return json({ session });
      }
      if (suffix.startsWith("/tracks/") && method === "PATCH") {
        const track = session.tracks.find(track => track.id === suffix.split("/").at(-1));
        assert(track, "PATCH must target an existing fixture entry");
        const body = route.request().postDataJSON();
        if (body.transition) track.transition = body.transition;
        if (body.stemMix) track.stemMix = body.stemMix;
        if (!body.playbackPreference) return json({ session });
        assert(pending, "An unexpected preference PATCH escaped the test gate");
        assert.equal(track.id, `${prefix}b`);
        assert.deepEqual(body, { playbackPreference: "source" });
        track.playbackPreference = body.playbackPreference;
        track.playback = { kind: "source", assetIds: [track.sourceAssetId] };
        // Persist now, but retain the entire old response (including its old
        // play pointer and queue) until the user has made a newer change.
        const snapshot = structuredClone(session);
        const gate = pending;
        gate.snapshot = snapshot;
        gate.started.resolve();
        await gate.release.promise;
        await json({ session: snapshot });
        gate.responded.resolve();
        return;
      }
      throw new Error(`Unexpected fixture request: ${method} ${url.pathname}`);
    } catch (error) {
      apiErrors.push(error.message);
      await route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ error: error.message }) });
    }
  });

  const current = id => page.locator(".sess-queue-item.current .sess-queue-jump").filter({ hasText: `Race song ${id}` });
  const queueJump = id => page.locator(".sess-queue-jump").filter({ hasText: `Race song ${id}` });
  async function openOrder() {
    const drawer = page.locator("details").filter({ has: page.locator(".sess-queue-list") });
    if (!await drawer.getAttribute("open").then(value => value !== null)) await drawer.locator("summary").click();
  }
  async function advancing(assetIds) {
    await page.waitForFunction(ids => ids.every(id => {
      const audio = document.querySelector(`audio[src$="/${id}"]`);
      return audio instanceof HTMLAudioElement && !audio.paused && audio.currentTime > 0.25;
    }), assetIds);
  }
  async function markAudio(assetIds) {
    await advancing(assetIds);
    await page.evaluate(ids => {
      window.__modeRaceAudio = ids.map(id => {
        const audio = document.querySelector(`audio[src$="/${id}"]`);
        const probe = { id, audio, time: audio.currentTime, interruptions: 0 };
        for (const event of ["pause", "emptied", "loadstart"]) {
          audio.addEventListener(event, () => { probe.interruptions++; });
        }
        return probe;
      });
    }, assetIds);
  }
  async function unchangedAudio() {
    await page.waitForFunction(() => window.__modeRaceAudio.every(probe =>
      document.querySelector(`audio[src$="/${probe.id}"]`) === probe.audio
      && !probe.audio.paused && probe.audio.currentTime > probe.time + 0.25));
    assert.deepEqual(await page.evaluate(() => window.__modeRaceAudio.map(probe => probe.interruptions)),
      await page.evaluate(() => window.__modeRaceAudio.map(() => 0)),
      "A delayed acknowledgement must retain audible elements without pause/load events");
  }
  async function releaseSave() {
    const response = page.waitForResponse(response =>
      response.request().method() === "PATCH" && response.url().endsWith(`/tracks/${prefix}b`));
    pending.release.resolve();
    await waitForGate(pending.responded, "delayed PATCH response");
    await response;
  }
  async function nextLoad(a) {
    // Reload reads the persisted preference through GET, rather than relying on
    // the old server snapshot or only checking a dropdown / test-side object.
    await page.getByTestId("session-play").click();
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.getByTestId("listening-workspace").waitFor();
    await openOrder();
    if (await current("b").count() === 0) await queueJump("b").click();
    await current("b").waitFor();
    await page.getByTestId("session-play").click();
    await advancing([`${prefix}b-source`]);
    assert.equal(await page.locator(`audio[src$="/${prefix}b-vocals"]`).count(), 0,
      "The next appropriate load must use the saved full track, not stale stems");
    assert.equal(a.tracks.find(track => track.id === `${prefix}b`).playbackPreference, "source");
  }

  try {
    for (const race of ["start", "transition", "remove", "navigate"]) {
      console.log(`Mode-save race: ${race}`);
      const a = makeSession("first", [item("a", 0), item("b", 1), item("c", 2)]);
      const other = makeSession("other", [item("d", 0), item("e", 1)]);
      sessions = { [a.id]: a, [other.id]: other };
      stateWrites.length = 0;
      pending = { started: deferred(), release: deferred(), responded: deferred() };
      await page.goto(`${base}/waveyard/session/${a.id}`, { waitUntil: "domcontentloaded" });
      await page.getByTestId("listening-workspace").waitFor();
      await openOrder();
      await current("a").waitFor();
      await page.getByTestId("session-play").click();
      await advancing(a.tracks[0].playback.assetIds);
      const chooser = page.getByTestId(`session-playback-mode-${prefix}b`);
      await chooser.selectOption("source");
      await waitForGate(pending.started, "preference PATCH to reach the response gate");
      assert.equal(await chooser.getAttribute("aria-busy"), "true");
      assert.equal(pending.snapshot.currentSessionTrackId, `${prefix}a`);

      if (race === "start") {
        await queueJump("b").click();
        await current("b").waitFor();
        await markAudio(item("b", 1).playback.assetIds);
        const writesBefore = stateWrites.length;
        await releaseSave();
        await page.getByTestId("session-status").filter({ hasText: "for its next load; current playback is unchanged" }).waitFor();
        await unchangedAudio();
        assert.equal(await current("b").count(), 1);
        assert.equal(a.currentSessionTrackId, `${prefix}b`, "Old response must not reset the newer saved play pointer");
        assert(stateWrites.slice(writesBefore).every(write => write.currentSessionTrackId === `${prefix}b`));
        assert.equal(await page.locator(`audio[src$="/${prefix}b-source"]`).count(), 0);
        await nextLoad(a);
      } else if (race === "transition") {
        await page.getByTestId("session-transition").click();
        await page.getByRole("button", { name: "Finish", exact: true }).waitFor();
        await markAudio([...item("a", 0).playback.assetIds, ...item("b", 1).playback.assetIds]);
        await releaseSave();
        await page.getByTestId("session-status").filter({ hasText: "for its next load; current playback is unchanged" }).waitFor();
        await unchangedAudio();
        assert.equal(await page.getByRole("button", { name: "Finish", exact: true }).count(), 1,
          "Save acknowledgement must not finish/cancel a newer transition");
        assert.equal(await current("a").count(), 1);
        await page.getByRole("button", { name: "Finish", exact: true }).click();
        await current("b").waitFor();
        await advancing(item("b", 1).playback.assetIds);
        await nextLoad(a);
      } else if (race === "remove") {
        await page.getByRole("button", { name: "Remove Race song b", exact: true }).click();
        await chooser.waitFor({ state: "detached" });
        // A newer pointer as well as a shorter queue must survive the stale
        // response, whose snapshot still includes b and points to a.
        await queueJump("c").click();
        await current("c").waitFor();
        await markAudio(item("c", 2).playback.assetIds);
        await releaseSave();
        await unchangedAudio();
        assert.equal(await queueJump("b").count(), 0, "The removed entry must not be resurrected");
        assert.equal(await page.locator(".sess-queue-item").count(), 2);
        assert.equal(await current("c").count(), 1);
        assert.equal(a.currentSessionTrackId, `${prefix}c`);
        await page.reload({ waitUntil: "domcontentloaded" });
        await openOrder();
        await current("c").waitFor();
        assert.equal(await queueJump("b").count(), 0, "Removal must also survive a fresh load");
      } else {
        // Client-side links keep the same ListeningHost mounted so the pending
        // callback really runs against the OTHER session, not a dead document.
        await page.getByRole("link", { name: "All sessions", exact: true }).click();
        await page.locator(`a[href="/waveyard/session/${other.id}"]`).click();
        await page.getByTestId("listening-workspace").filter({ hasText: other.name }).waitFor();
        await openOrder();
        await current("d").waitFor();
        if (await page.getByTestId("session-play").getAttribute("aria-label") === "Play") {
          await page.getByTestId("session-play").click();
        }
        await markAudio(item("d", 0).playback.assetIds);
        await releaseSave();
        await unchangedAudio();
        assert.equal(await current("d").count(), 1);
        assert.equal(await queueJump("b").count(), 0, "The old queue must not overwrite another session");
        assert.equal(await page.locator(".sess-queue-item").count(), 2);
        assert.equal(await page.getByTestId("session-status").filter({ hasText: "Full track saved" }).count(), 0);
        await page.getByRole("link", { name: "All sessions", exact: true }).click();
        await page.locator(`a[href="/waveyard/session/${a.id}"]`).click();
        await page.getByTestId("listening-workspace").filter({ hasText: a.name }).waitFor();
        await openOrder();
        assert.equal(await page.getByTestId(`session-playback-mode-${prefix}b`).inputValue(), "source");
        await queueJump("b").click();
        await current("b").waitFor();
        if (await page.getByTestId("session-play").getAttribute("aria-label") === "Play") {
          await page.getByTestId("session-play").click();
        }
        await advancing([`${prefix}b-source`]);
      }
      assert.deepEqual(apiErrors, [], "Fixture requests must all complete successfully");
      reports.push(race === "remove"
        ? "remove: delayed mode-save snapshot cannot resurrect the removed entry or reset newer playback, including after reload."
        : `${race}: delayed mode-save snapshot cannot replace newer playback/session state; saved preference respected on next applicable load.`);
      // End each race before resetting the fixture, without disabling routes.
      if (await page.getByTestId("session-play").getAttribute("aria-label") === "Pause") {
        await page.getByTestId("session-play").click();
      }
    }
    await page.screenshot({ path: new URL("session-mode-races.jpg", output).pathname });
    await writeFile(new URL("session-mode-races.json", output), JSON.stringify({ passed: true, reports }, null, 2));
    console.log(reports.join("\n"));
  } catch (error) {
    await page.screenshot({ path: new URL("session-mode-races-failure.jpg", output).pathname });
    console.error("Mode race fixture errors:", apiErrors);
    console.error("Audio state:", await page.locator("audio").evaluateAll(elements => elements.map(audio => ({
      src: audio.getAttribute("src"), paused: audio.paused, time: audio.currentTime, ready: audio.readyState,
    }))));
    console.error((await page.locator("body").innerText()).slice(-6000));
    throw error;
  } finally {
    // Release an outstanding route even after an assertion fails.
    pending?.release.resolve();
    // Keep mocks installed through page teardown (pagehide saves included).
  }
}
