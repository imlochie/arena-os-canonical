// UI contract regression only: generated PCM and mocked session persistence.
// This does not establish real-song matching accuracy or database durability.
import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";

const measured = value => ({ status: "measured", value, method: "synthetic UI fixture", confidence: 0.95 });
const unavailable = () => ({ status: "unavailable", reason: "Not measured by this fixture." });
const rhythm = Array.from({ length: 32 }, (_, index) => index % 8 === 0 ? 1 : 0);
const chroma = Array.from({ length: 48 }, (_, index) => index % 12 === 0 ? 1 : 0);
const grid = Array.from({ length: 49 }, (_, index) => index * 500);

function fixtureAnalysis(checksum) {
  const windows = Array.from({ length: 11 }, (_, index) => ({
    startBeatIndex: index * 4,
    endBeatIndex: index * 4 + 8,
    rhythm: measured(rhythm),
    chroma: measured(chroma),
    beatPhase: measured({ subdivisionProfile: [1, 0, 0, 0], beatPeriodMs: 500 }),
  }));
  return {
    bpm: 120, bpmConfidence: 0.95, beatConfidence: 0.95,
    musicalKey: "C major", keyConfidence: 0.95, beatGridMs: grid,
    downbeatGridMs: null, downbeatConfidence: null,
    vocalActivityStartsMs: null, voicedPhraseStartsMs: null,
    sections: [{
      id: `section-${checksum[0]}`, sectionIndex: 0, startMs: 0, endMs: 24_000,
      startBeatIndex: 0, endBeatIndex: 48, startBar: 0, endBar: 12,
      label: "section", labelConfidence: 0, structuralConfidence: 0.95,
      analysisEngine: "synthetic-ui-fixture", analysisEngineVersion: "1",
      sourceChecksumSha256: checksum,
      passageFingerprint: {
        schemaVersion: 3, engine: "waveyard-passage-fingerprint", engineVersion: "2.2.0",
        sourceChecksumSha256: checksum, startBeatIndex: 0, endBeatIndex: 48,
        rhythm: measured([...rhythm, ...rhythm]), chroma: measured(chroma),
        beatPhase: measured({ subdivisionProfile: [1, 0, 0, 0], beatPeriodMs: 500 }),
        energy: measured({ rmsDb: -12 }), downbeatConfidence: unavailable(),
        vocalActivity: unavailable(), instrumentalDensity: unavailable(),
        stemActivity: unavailable(), rollingWindows: measured(windows),
      },
    }],
  };
}

export async function runEntryAuditionAcceptance({ page, session, tracks, assets, wav }) {
  session.tracks = tracks.slice(0, 2);
  session.currentSessionTrackId = "a";
  session.positionSeconds = 0;
  session.swaps = [];
  for (const [index, track] of session.tracks.entries()) {
    track.track.durationSeconds = 24;
    track.analysis = fixtureAnalysis((index === 0 ? "a" : "b").repeat(64));
    for (const stem of track.stems) {
      stem.durationSeconds = 24;
      assets.set(stem.id, wav(24, 130 + index * 100));
    }
  }
  await page.addInitScript(() => {
    const NativeAudio = window.Audio;
    window.entryAuditionElements = [];
    window.Audio = class extends NativeAudio {
      constructor(...args) {
        super(...args);
        window.entryAuditionElements.push(this);
      }
    };
  });
  const openCompare = async () => {
    const deck = page.locator('[data-role="current"]');
    await deck.getByTestId("open-live-swap-vocals").click();
    await deck.getByTestId("compare-vocal-entries-b").click();
    await deck.getByTestId("vocal-entry-alternatives").waitFor();
    return deck;
  };
  const route = `http://localhost:80/waveyard/session/${session.id}`;
  await page.goto(route);
  await page.waitForFunction(() => document.querySelectorAll('[data-role="current"] audio').length === 4);
  let deck = await openCompare();
  const alternatives = deck.locator('[data-testid^="vocal-entry-candidate-"]');
  assert.ok(await alternatives.count() >= 2, "multiple distinct windows are visible");
  assert.match(await alternatives.first().innerText(), /Rhythm similarity 100%/);
  assert.match(await alternatives.first().innerText(), /measurement 95%/);
  assert.match(await alternatives.first().innerText(), /Harmony similarity 100%/);
  assert.match(await alternatives.first().innerText(), /Duration fit 100%/);
  assert.equal(session.swaps.length, 0, "comparison does not save a donor");
  await deck.getByTestId("vocal-entry-candidate-1").click();
  await page.waitForFunction(() => !document.querySelector('[data-testid="button-preview-entry-candidate"]')?.disabled);
  await deck.getByTestId("button-preview-entry-candidate").click();
  await page.waitForFunction(() => window.entryAuditionElements.some(audio => !audio.paused && audio.currentTime >= 4));
  assert.equal(session.swaps.length, 0, "audition does not save a donor");
  await deck.getByTestId("button-stop-entry-preview").click();
  assert.equal(await page.evaluate(() => window.entryAuditionElements.every(audio => audio.paused)), true);
  await deck.getByTestId("button-preview-entry-candidate").click();
  await deck.getByRole("button", { name: "Close source picker", exact: true }).click();
  await page.waitForFunction(() => window.entryAuditionElements.every(audio => audio.paused));
  assert.equal(session.swaps.length, 0, "closing an audition leaves the saved session untouched");

  deck = await openCompare();
  await deck.getByTestId("vocal-entry-candidate-1").click();
  await deck.getByTestId("button-apply-entry-candidate").click();
  await page.waitForFunction(() => document.querySelector('[data-testid="open-live-swap-vocals"]')?.textContent.includes("Donor vocal selected"));
  assert.equal(session.swaps.at(-1)?.donorEntryOffsetMs, 4_000);
  assert.equal(session.swaps.at(-1)?.toTrackId, "b");
  await page.reload();
  deck = page.locator('[data-role="current"]');
  await deck.getByTestId("open-live-swap-vocals").click();
  await deck.getByTestId("vocal-entry-timing").waitFor();
  assert.match(await deck.getByTestId("vocal-entry-timing").innerText(), /Manual · 0:04/);
  await deck.getByTestId("vocal-entry-time-slider").evaluate(input => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(input, "6000");
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new Event("change", { bubbles: true }));
  });
  await deck.getByTestId("button-apply-vocal-entry").click();
  await page.waitForFunction(() => document.querySelector('[data-testid="vocal-entry-timing"]')?.textContent.includes("Manual · 0:06"));
  assert.equal(session.swaps.at(-1)?.donorEntryOffsetMs, 6_000, "existing manual override remains usable");

  await deck.getByTestId("compare-vocal-entries-b").click();
  await page.getByLabel("Seek current track").evaluate(input => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(input, "8");
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new Event("change", { bubbles: true }));
  });
  await page.waitForFunction(() => document.querySelector('[data-testid="button-apply-entry-candidate"]')?.disabled);
  assert.equal(session.swaps.at(-1)?.donorEntryOffsetMs, 6_000, "a stale candidate cannot replace the saved offset");

  session.tracks[0].analysis.sections = null;
  session.tracks[1].analysis.sections = null;
  session.positionSeconds = 0;
  await page.reload();
  deck = await openCompare();
  assert.match(await deck.getByTestId("vocal-entry-alternatives").innerText(), /No source-verified rhythm\/harmony window/);
  await deck.getByTestId("button-apply-automatic-entry").click();
  await page.waitForFunction(() => !document.querySelector('[data-testid="vocal-entry-alternatives"]'));
  assert.equal(session.swaps.at(-1)?.donorEntryOffsetMs, null, "missing evidence preserves the existing automatic fallback");

  await page.setViewportSize({ width: 390, height: 844 });
  deck = await openCompare();
  await deck.getByTestId("vocal-entry-alternatives").scrollIntoViewIfNeeded();
  const layout = await page.evaluate(() => ({ width: innerWidth, scroll: document.documentElement.scrollWidth }));
  assert.ok(layout.scroll <= layout.width, `mobile comparison fits viewport: ${JSON.stringify(layout)}`);
  mkdirSync("generated-artifacts/waveyard-entry-audition", { recursive: true });
  await page.screenshot({ path: "generated-artifacts/waveyard-entry-audition/mobile.jpg", fullPage: false });
  await deck.getByRole("button", { name: "Close source picker", exact: true }).click();
  console.log("PASS: entry alternatives expose evidence, audition without saving, stop on close, apply/reopen exact offsets, retain manual/automatic fallback, refuse stale windows, and fit mobile. Persistence is mocked; musical quality is not measured.");
}
