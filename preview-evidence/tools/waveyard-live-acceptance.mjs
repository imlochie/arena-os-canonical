#!/usr/bin/env node
/**
 * Waveyard live-session product-preview acceptance.
 *
 * Drives the REAL built Next.js app (/waveyard/session/<id>) in real headless
 * Chromium, with the same Web Audio analyser instrumentation the repo's own
 * live-stem test uses, so level changes are measured from the audio graph
 * rather than read back from the UI.
 *
 * Fixture note: stems are controlled sine tones inserted by
 * tools/seed-waveyard-live.mjs. This proves routing/mix behaviour, NOT
 * separation quality or musical output.
 */
import { chromium } from "/home/user/preview-13638fe/node_modules/playwright-core/index.mjs";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";

const BASE = process.env.PREVIEW_BASE_URL ?? "http://127.0.0.1:3000";
const root = process.cwd();
const fixture = JSON.parse(readFileSync(path.join(root, ".data/acceptance/product-preview/waveyard-fixture.json"), "utf8"));
const runDir = path.join(root, ".data/acceptance/product-preview/runs", new Date().toISOString().replace(/[:.]/g, "-"));
mkdirSync(runDir, { recursive: true });

const log = [];
const note = (step, detail) => { log.push({ at: new Date().toISOString(), step, detail }); console.log(`[${step}]`, typeof detail === "string" ? detail : JSON.stringify(detail).slice(0, 400)); };
const results = { kind: "waveyard-live-session", fixtureKind: fixture.kind, sessionId: fixture.sessionId, steps: [], consoleErrors: [], pageErrors: [], requestFailures: [], httpErrors: [], screenshots: [], browser: null, limitations: [] };

const browser = await chromium.launch({
  executablePath: "/tmp/chromium", headless: true, timeout: 20000,
  args: ["--no-sandbox", "--disable-dev-shm-usage", "--autoplay-policy=no-user-gesture-required", "--mute-audio"],
  env: { PATH: process.env.PATH, HOME: process.env.HOME, TMPDIR: "/tmp", LD_LIBRARY_PATH: "/tmp/al2023/lib" },
});
results.browser = browser.version();
const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
const page = await context.newPage();
page.on("console", msg => { if (msg.type() === "error") results.consoleErrors.push(msg.text().slice(0, 500)); });
page.on("pageerror", error => results.pageErrors.push(error.message.slice(0, 500)));
page.on("requestfailed", request => results.requestFailures.push({ url: request.url().replace(BASE, ""), failure: request.failure()?.errorText }));
page.on("response", response => { if (response.status() >= 400) results.httpErrors.push({ status: response.status(), url: response.url().replace(BASE, ""), method: response.request().method() }); });

await page.addInitScript(() => {
  const Native = window.AudioContext;
  window.__laneContexts = [];
  window.AudioContext = class extends Native {
    constructor(...args) {
      super(...args);
      const stems = [];
      let source = null;
      const nativeSource = this.createMediaElementSource.bind(this);
      const nativeAnalyser = this.createAnalyser.bind(this);
      this.createMediaElementSource = element => { source = element; return nativeSource(element); };
      this.createAnalyser = () => { const node = nativeAnalyser(); if (source) { stems.push({ node, element: source }); source = null; } return node; };
      window.__laneContexts.push({ context: this, stems });
    }
  };
});

const observe = () => page.evaluate(({ assets, categories, frequencies }) => {
  const contexts = window.__laneContexts ?? [];
  const out = {};
  for (const { context, stems } of contexts) {
    if (context.state !== "running") continue;
    for (const { node, element } of stems) {
      const src = element.getAttribute("src") ?? "";
      const song = assets.findIndex(list => list.some(id => src === `/api/assets/${id}`));
      if (song < 0) continue;
      const index = assets[song].findIndex(id => src === `/api/assets/${id}`);
      const pcm = new Float32Array(node.fftSize);
      node.getFloatTimeDomainData(pcm);
      const amplitude = hz => {
        let re = 0, im = 0;
        for (let i = 0; i < pcm.length; i++) { const phase = (2 * Math.PI * hz * i) / context.sampleRate; re += pcm[i] * Math.cos(phase); im += pcm[i] * Math.sin(phase); }
        return (2 * Math.hypot(re, im)) / pcm.length;
      };
      out[categories[index]] = { song, amplitudeAt: [amplitude(frequencies[0][index]), amplitude(frequencies[1][index])] };
    }
  }
  return out;
}, { assets: fixture.assets, categories: fixture.categories, frequencies: fixture.frequencies });

// Audible donor song is decided by the energy at each song's carrier for that
// lane, never by the media element's src (the clock element keeps its original
// source while a prepared donor enters the same lane as an AudioBuffer).
const audibleSong = entry => {
  const [a, b] = entry.amplitudeAt;
  if (Math.max(a, b) < 0.01) return null;
  return a >= b ? 0 : 1;
};
const allSongs = obs => Object.fromEntries(Object.entries(obs).map(([key, value]) => [key, audibleSong(value)]));
const waitFor = async (predicate, { timeout = 8000, interval = 100 } = {}) => {
  const started = Date.now();
  let last;
  while (Date.now() - started < timeout) {
    last = await predicate();
    if (last) return last;
    await page.waitForTimeout(interval);
  }
  return false;
};
const assertAudioSong = async (expected, label, { timeout = 20000 } = {}) => {
  const started = Date.now();
  const ok = await waitFor(async () => {
    const obs = await observe();
    const songs = allSongs(obs);
    const matches = fixture.categories.every(category => songs[category] === expected[category]);
    const donorEnergy = fixture.categories.every(category => {
      const entry = obs[category];
      if (!entry) return false;
      const donor = audibleSong(entry);
      if (donor === null) return false;
      const mine = entry.amplitudeAt[donor];
      const other = entry.amplitudeAt[1 - donor];
      return mine > 0.02 && other < mine * 0.15;
    });
    return matches && donorEnergy ? obs : false;
  }, { timeout });
  results.steps.push({ step: label, expected, observation: ok || await observe(), audible: Boolean(ok), ms: Date.now() - started });
  note(label, ok ? "audible layout matches" : "audible layout DID NOT match within timeout");
  return ok;
};
const sessionState = async () => {
  const response = await context.request.get(`${BASE}/api/library/sessions/${fixture.sessionId}`);
  const body = await response.json();
  return { status: response.status(), currentSessionTrackId: body?.session?.currentSessionTrackId ?? null, positionSeconds: body?.session?.positionSeconds ?? null, swaps: (body?.session?.swaps ?? []).map(s => ({ stemType: s.stemType, toStemAssetId: s.toStemAssetId, atSeconds: s.atSeconds })) };
};
const shot = async name => {
  const file = path.join(runDir, `${name}.png`);
  await page.screenshot({ path: file, fullPage: false });
  results.screenshots.push(file);
  return file;
};

try {
  await page.goto(`${BASE}${fixture.sessionUrl}`, { waitUntil: "domcontentloaded" });
  await page.getByTestId("session-stage").waitFor({ timeout: 20000 });
  await shot("01-session-loaded");
  note("page", await page.title());

  const initial = fixture.categories.map(() => 0);
  results.steps.push({ step: "canonical mix visible", lanes: await page.getByRole("group", { name: /^Source for / }).count() });

  await page.getByTestId("session-play").click();
  await page.waitForTimeout(1500);
  await shot("02-playing");
  const baseline = await assertAudioSong(Object.fromEntries(fixture.categories.map(c => [c, 0])), "baseline canonical mix (A sources) audible");
  if (!baseline) throw new Error("baseline audio did not reach expected lanes");

  // Switch each stem category to the other song, then back, twice.
  for (let repeat = 0; repeat < 2; repeat++) {
    for (const category of fixture.categories) {
      for (const song of [1, 0]) {
        const expected = Object.fromEntries(fixture.categories.map(c => [c, 0]));
        expected[category] = song;
        const group = page.getByRole("group", { name: `Source for ${category}`, exact: true });
        await group.getByRole("button").nth(song).click();
        await assertAudioSong(expected, `source switch ${category} → song ${song} (repeat ${repeat + 1})`);
      }
    }
  }
  await shot("03-after-switches");

  // Rapid input: alternate quickly, no settling between clicks; last click wins.
  const rapid = page.getByRole("group", { name: "Source for bass", exact: true }).getByRole("button");
  for (const song of [1, 0, 1, 0, 1]) await rapid.nth(song).click({ delay: 5 });
  const rapidExpected = Object.fromEntries(fixture.categories.map(c => [c, 0]));
  rapidExpected.bass = 1;
  const rapidOk = await assertAudioSong(rapidExpected, "rapid source switching settles on the last selected source");
  results.steps.push({ step: "rapid input", ok: Boolean(rapidOk) });
  await rapid.nth(0).click();
  await assertAudioSong(Object.fromEntries(fixture.categories.map(c => [c, 0])), "restore bass to canonical A source");

  // Hold to isolate: press and hold vocals, confirm other lanes go silent.
  const hold = page.getByRole("button", { name: "Hold to isolate vocals", exact: true });
  const box = await hold.boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  const isolated = await waitFor(async () => {
    const obs = await observe();
    const vocals = obs.vocals;
    const others = fixture.categories.filter(c => c !== "vocals").map(c => obs[c]);
    if (!vocals || others.some(o => !o)) return false;
    const vocalsLevel = Math.max(...vocals.amplitudeAt);
    const othersQuiet = others.every(o => o.amplitudeAt.every(v => v < Math.max(0.002, vocalsLevel * 0.05)));
    return vocalsLevel > 0.02 && othersQuiet ? obs : false;
  }, { timeout: 8000 });
  results.steps.push({ step: "hold to isolate vocals (audio only)", isolatedAudibly: Boolean(isolated), observation: isolated || await observe() });
  await shot("04-hold-isolate");
  await page.mouse.move(2, 2);
  await page.mouse.up();
  await assertAudioSong(Object.fromEntries(fixture.categories.map(c => [c, 0])), "release restores the canonical mix");
  await page.waitForTimeout(800);

  // Persistence: the app's own save status, then reload and re-measure.
  const saveStatus = page.getByLabel("Stem selection save status");
  await saveStatus.filter({ hasText: "saved" }).waitFor({ timeout: 15000 }).catch(() => {});
  results.steps.push({ step: "stem selection save status", text: await saveStatus.textContent().catch(() => null) });
  const bVocals = await page.getByRole("group", { name: "Source for vocals", exact: true }).getByRole("button").nth(1);
  await bVocals.click();
  await assertAudioSong({ vocals: 1, drums: 0, bass: 0, instruments: 0 }, "post-hold switch to B recorded and audible");
  await saveStatus.filter({ hasText: "saved" }).waitFor({ timeout: 15000 }).catch(() => {});
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.getByTestId("session-stage").waitFor({ timeout: 20000 });
  await page.getByTestId("session-play").click();
  await page.waitForTimeout(1200);
  const afterReload = await assertAudioSong({ vocals: 1, drums: 0, bass: 0, instruments: 0 }, "reload reopens the saved selection and plays it", { timeout: 30000 });
  await shot("05-after-reload");

  // Failed save + retry: fail the swaps POST at the network boundary only.
  let failSaves = true;
  const swapsRoute = url => url.pathname.startsWith("/api/library/sessions/") && url.pathname.endsWith("/swaps");
  await page.route(swapsRoute, async route => {
    if (failSaves && route.request().method() === "POST") return route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ error: "Injected acceptance failure at the save boundary" }) });
    return route.continue();
  });
  await page.getByRole("group", { name: "Source for drums", exact: true }).getByRole("button").nth(1).click();
  const beforeFailedSave = await sessionState();
  const statusTimeline = [];
  const errorShown = await waitFor(async () => {
    const text = (await page.getByLabel("Stem selection save status").textContent()) ?? "";
    statusTimeline.push({ at: new Date().toISOString(), text: text.trim() });
    return text.includes("error");
  }, { timeout: 30000, interval: 1000 });
  const afterFailedSave = await sessionState();
  const surfaced = await page.getByRole("alert").allTextContents();
  results.steps.push({ step: "failed save surfaces an error", errorShown: Boolean(errorShown), statusTimeline: statusTimeline.filter((entry, index) => index === 0 || entry.text !== statusTimeline[index - 1].text).slice(0, 12), alerts: surfaced.map(t => t.slice(0, 200)), dbUnchangedByFailedSave: JSON.stringify(beforeFailedSave.swaps) === JSON.stringify(afterFailedSave.swaps) });
  await shot("06-save-failure");
  const stillAudible = await assertAudioSong({ vocals: 1, drums: 1, bass: 0, instruments: 0 }, "failed save keeps the audible B selection in this page");
  failSaves = false;
  const retry = page.getByRole("button", { name: "Retry saving stem selections", exact: true });
  if (await retry.count()) await retry.click();
  const recovered = await waitFor(async () => (await page.getByLabel("Stem selection save status").textContent())?.includes("saved"), { timeout: 15000 });
  results.steps.push({ step: "retry after failed save recovers", recovered: Boolean(recovered), audibleUnchanged: Boolean(stillAudible) });
  await page.unroute(swapsRoute);

  // Failed preparation: make the donor object unavailable, then select it.
  // Donor preparation failure: the OTHER song's instrument stem has not been
  // fetched in this page yet (only song 1 vocals + song 0 lanes were played).
  const donorInstruments = fixture.assets[1][fixture.categories.indexOf("instruments")];
  const beforePrep = await sessionState();
  let failDonor = true;
  const donorRoute = url => url.pathname === `/api/assets/${donorInstruments}`;
  await page.route(donorRoute, route => failDonor ? route.fulfill({ status: 404, contentType: "application/json", body: "{\"error\":\"injected donor unavailability\"}" }) : route.continue());
  await page.getByRole("group", { name: "Source for instruments", exact: true }).getByRole("button").nth(1).click();
  const prepFailed = await waitFor(async () => {
    const texts = await page.locator("[role=status]").allTextContents();
    return texts.some(text => /fail|unavailable|404|not found|retain/i.test(text)) ? texts : false;
  }, { timeout: 15000 });
  const afterFailedPrep = await observe();
  const afterPrep = await sessionState();
  results.steps.push({
    step: "failed donor preparation is surfaced, working mix retained",
    statusTexts: (prepFailed || await page.locator("[role=status]").allTextContents()).map(t => t.slice(0, 240)).filter(Boolean).slice(0, 12),
    audibleInstruments: audibleSong(afterFailedPrep.instruments ?? { amplitudeAt: [0, 0] }),
    dbUnchanged: JSON.stringify(beforePrep.swaps) === JSON.stringify(afterPrep.swaps),
  });
  await shot("07-failed-preparation");
  failDonor = false;
  await page.unroute(donorRoute);
} catch (error) {
  results.failure = error instanceof Error ? error.message : String(error);
  results.stepAtFailure = log.at(-1);
  try { await shot("99-failure"); } catch {}
} finally {
  results.finalSessionState = await sessionState().catch(() => null);
  results.log = log;
  results.limitations = [
    "Controlled PCM sine stems inserted by acceptance scaffolding: not separation, not inference, not musical-quality evidence.",
    "Bar snapping was not exercised: the fixture has no measured beat/downbeat data, so the UI must (and does) state bar snapping is unavailable.",
    "Real-time audio is measured from analyser taps inside the page's real AudioContext; this is graph-level audibility, not a human listening test.",
  ];
  const file = path.join(runDir, "waveyard-live-results.json");
  writeFileSync(file, JSON.stringify(results, null, 2));
  console.log(JSON.stringify({ evidence: file, failure: results.failure ?? null, steps: results.steps.length, consoleErrors: results.consoleErrors.length, pageErrors: results.pageErrors.length }));
  await browser.close();
}
