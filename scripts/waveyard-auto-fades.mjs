import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";

const STEMS = ["vocals", "drums", "bass", "other"];
const MIX = { vocals: 0.31, drums: 0.53, bass: 0.76, other: 0.94 };
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

// The narrow analysers are attached to each deck's existing master node. They
// sample the real rendered WebAudio PCM; 2048 samples at 22.05 kHz span 92.9ms.
// A 40ms cadence therefore overlaps windows and smooths tone phase without
// adding graph instrumentation beyond the two deck-output taps.
export async function runAutomaticFadeAcceptance({ page, session, tracks, sourceOnlyTrack, toggle, chooseLiveSource }) {
  const setPlaying = async wanted => {
    const button = page.getByTestId("session-play");
    const before = await button.getAttribute("aria-pressed");
    if (before !== String(wanted)) await toggle();
  };
  const report = {
    format: "waveyard-auto-fades/v1",
    fixture: "original synthetic WAV bytes served by fully mocked fixture API; real browser WebAudio",
    thresholds: {
      pcmWindowSamples: 2048,
      sampleCadenceMs: 40,
      fadeEnvelopeGainAbsoluteTolerance: 0.14,
      modeledCombinedRmsRelativeTolerance: 0.28,
      noUnexpectedSilenceFloorRelativeToLouderSteadyDeck: 0.20,
      noUnexpectedClippingPeak: 0.35,
      rationale: "Different-frequency fixture tones are energy-combined in quadrature; 2048-sample overlapping windows tolerate phase/window variation. Per-deck steady PCM is measured, so source and four-stem baselines are not assumed equal.",
    },
    scenarios: [],
  };
  const artifacts = "generated-artifacts/waveyard-auto-fades";
  await mkdir(artifacts, { recursive: true });

  const waitReady = async expected => page.waitForFunction(({ expected }) => {
    const current = document.querySelector('[data-role="current"]');
    const next = document.querySelector('[data-role="next"]');
    const ready = role => [...(role?.querySelectorAll("audio") ?? [])].every(a => a.readyState >= 2);
    return current?.textContent?.includes(expected.current) && ready(current) &&
      (expected.next === null || (next?.textContent?.includes(expected.next) && ready(next)));
  }, { expected }, { timeout: 15_000 });

  async function installSamples(name) {
    await page.evaluate(sampleName => {
      window.audioProbe.autoFadeSamples = [];
      window.audioProbe.autoFadeSampler = setInterval(() => {
        const rows = window.audioProbe.outputAnalyzers.map(({ analyser }, deck) => {
          const pcm = new Float32Array(analyser.fftSize);
          analyser.getFloatTimeDomainData(pcm);
          let sum = 0, peak = 0;
          for (const x of pcm) { sum += x * x; peak = Math.max(peak, Math.abs(x)); }
          const master = window.audioProbe.masterGains[deck];
          return { deck, rms: Math.sqrt(sum / pcm.length), peak, master: master?.gain.value ?? null };
        });
        window.audioProbe.autoFadeSamples.push({ t: performance.now(), rows });
      }, 40);
      window.audioProbe.autoFadeScenario = sampleName;
    }, name);
  }
  const stopSamples = () => page.evaluate(() => {
    clearInterval(window.audioProbe.autoFadeSampler);
    return window.audioProbe.autoFadeSamples;
  });
  const decks = () => page.evaluate(() => window.audioProbe.outputAnalyzers.map((_, i) => i));
  const readSamples = async () => page.evaluate(() => window.audioProbe.autoFadeSamples);
  function stats(samples, deck, startT, endT) {
    const rows = samples.filter(s => s.t >= startT && s.t <= endT).map(s => s.rows.find(r => r.deck === deck)).filter(Boolean);
    assert.ok(rows.length >= 3, `at least three PCM windows for deck ${deck} in ${startT}-${endT}: got ${rows.length}`);
    return {
      windows: rows.length,
      rms: rows.reduce((n, r) => n + r.rms, 0) / rows.length,
      peak: Math.max(...rows.map(r => r.peak)),
      master: rows.reduce((n, r) => n + (r.master ?? 0), 0) / rows.length,
    };
  }
  function assertFadeSamples(name, samples, fromDeck, toDeck, fadeStart, fadeEnd, outgoingBase, incomingBase, incomingSteady) {
    const fade = samples.filter(s => s.t >= fadeStart && s.t <= fadeEnd);
    assert.ok(fade.length >= 18, `${name}: sampled full fade with >=18 output windows; got ${fade.length}`);
    let worstModelError = 0, worstModelRow = null, floorRatio = Infinity, maxPeak = 0, envelopeError = 0, worstEnvelopeRow = null;
    for (const sample of fade) {
      const from = sample.rows.find(r => r.deck === fromDeck);
      const to = sample.rows.find(r => r.deck === toDeck);
      assert.ok(from && to, `${name}: both deck output analysers remain available`);
      const elapsed = (sample.t - fadeStart) / 1000;
      const x = Math.max(0, Math.min(1, elapsed / 2));
      const expectedFrom = 0.63 * Math.cos(x * Math.PI / 2);
      const expectedTo = 0.63 * Math.sin(x * Math.PI / 2);
      const rowError = Math.max(Math.abs(from.master - expectedFrom), Math.abs(to.master - expectedTo));
      if (rowError > envelopeError) { envelopeError = rowError; worstEnvelopeRow = { sample, expectedFrom, expectedTo }; }
      // Steady deck baselines were measured at master 0.63, so scale their
      // measured PCM by the relative (current/steady) envelope, not raw gain.
      const model = Math.sqrt(
        (outgoingBase.rms * expectedFrom / 0.63) ** 2 +
        (incomingBase.rms * expectedTo / 0.63) ** 2,
      );
      const actual = Math.sqrt(from.rms ** 2 + to.rms ** 2);
      const modelError = Math.abs(actual - model) / Math.max(model, 1e-6);
      if (modelError > worstModelError) { worstModelError = modelError; worstModelRow = { sample, actual, model, outgoingBase, incomingBase, expectedFrom, expectedTo }; }
      floorRatio = Math.min(floorRatio, actual / Math.max(outgoingBase.rms, incomingBase.rms));
      maxPeak = Math.max(maxPeak, from.peak, to.peak);
    }
    assert.ok(envelopeError <= report.thresholds.fadeEnvelopeGainAbsoluteTolerance,
      `${name}: equal-power deck master envelope error ${envelopeError.toFixed(3)} exceeds tolerance (worst=${JSON.stringify(worstEnvelopeRow)})`);
    assert.ok(worstModelError <= report.thresholds.modeledCombinedRmsRelativeTolerance,
      `${name}: measured combined deck PCM differs from measured-baseline equal-power model by ${(worstModelError * 100).toFixed(1)}% (worst=${JSON.stringify(worstModelRow)})`);
    assert.ok(floorRatio >= report.thresholds.noUnexpectedSilenceFloorRelativeToLouderSteadyDeck,
      `${name}: combined PCM fell to ${floorRatio.toFixed(3)} of louder steady deck`);
    assert.ok(maxPeak < report.thresholds.noUnexpectedClippingPeak,
      `${name}: deck PCM peak ${maxPeak.toFixed(3)} exceeds synthetic fixture clipping threshold`);
    assert.ok(incomingSteady.rms > 0.005, `${name}: incoming deck has audible steady PCM after handoff`);
    return { envelopeError, worstModelError, floorRatio, maxPeak };
  }
  async function swapAndVerify(deck, stem, label) {
    const before = await page.evaluate(stemType => window.audioProbe.buffers.filter(b =>
      b.buffer && b.inputNode && b.inputNode.gain?.value > 0,
    ).length, stem);
    await chooseLiveSource(stem, "c");
    await page.waitForFunction(({ before }) => window.audioProbe.buffers.filter(b => b.buffer && b.inputNode).length > before,
      { before }, { timeout: 7000 }).catch(() => {});
    await page.waitForFunction(() => {
      const donor = window.audioProbe.buffers.findLast(b => b.inputNode?.gain?.value > 0.05);
      return Boolean(donor);
    }, null, { timeout: 7000 }).catch(() => {});
    const state = await page.evaluate(() => {
      const donor = [...window.audioProbe.buffers].reverse().find(b => b.inputNode?.gain?.value > 0.05);
      return { sources: window.audioProbe.buffers.length, donorGain: donor?.inputNode?.gain?.value ?? 0 };
    });
    assert.ok(state.donorGain > 0.05, `${label}: donor buffer should be audible after real swap: ${JSON.stringify(state)}`);
    return state;
  }

  for (const mode of ["source-to-stems", "stems-to-stems"]) {
    const from = mode === "source-to-stems" ? sourceOnlyTrack : tracks[0];
    const outgoing = { ...from, analysis: { ...from.analysis, bpm: 128, beatGridMs: null },
      transition: { mode: "manual", crossfadeSeconds: 2, keepStems: [] },
      stemMix: { ...MIX } };
    const incoming = { ...tracks[1], analysis: { ...tracks[1].analysis, bpm: 128, beatGridMs: null },
      transition: { mode: "manual", crossfadeSeconds: 2, keepStems: [] },
      stemMix: { ...MIX } };
    const donor = { ...tracks[2], analysis: { ...tracks[2].analysis, bpm: 128, beatGridMs: null },
      stemMix: { ...MIX } };
    session.tracks = [outgoing, incoming, donor];
    session.swaps = [];
    session.currentSessionTrackId = "a";
    session.positionSeconds = 0;
    if (mode === "source-to-stems") {
      // Live swap controls intentionally exist only on the current deck. Make
      // b current briefly, perform the real UI swap, then restore a as current;
      // the saved per-session-track swap is loaded onto queued b for its fade.
      session.currentSessionTrackId = "b";
      await page.goto(`http://localhost:80/waveyard/session/${session.id}`);
      await waitReady({ current: "Test b", next: "Test c" });
      await setPlaying(true);
      await chooseLiveSource("vocals", "c");
      await page.waitForFunction(() => [...window.audioProbe.buffers].some(b => b.inputNode?.gain?.value > 0.05),
        null, { timeout: 8000 });
      assert.ok(session.swaps.some(s => s.sessionTrackId === "b" && s.stemType === "vocals" && s.toTrackId === "c"),
        "pre-fade queued-b swap is genuinely saved from its current-deck UI");
      await setPlaying(false);
      session.currentSessionTrackId = "a";
    }
    await page.goto(`http://localhost:80/waveyard/session/${session.id}`);
    await waitReady({ current: "Test a", next: "Test b" });
    let current = page.locator('[data-role="current"]');
    await page.getByLabel("Master volume").fill("0.63");
    const deckIds = await page.locator('[data-role="current"]').getAttribute("data-testid");
    const fromDeck = deckIds === "session-deck-a" ? 0 : 1;
    const toDeck = 1 - fromDeck;
    const auto = page.getByTestId("session-auto-crossfade");
    await auto.check();
    await setPlaying(true);
    if (mode === "stems-to-stems") {
      // The outgoing live donor remains part of the audible outgoing deck for
      // the fade; source-only decks have no live-stem controls.
      await swapAndVerify(current, "vocals", `${mode} outgoing pre-fade swap`);
    }
    await installSamples(mode);
    await current.getByTestId("seek-deck-0").fill("17.5");
    await page.getByRole("button", { name: "Finish", exact: true }).waitFor({ timeout: 8000 });
    const configuredFaders = await page.evaluate(({ toDeck }) => {
      const fader = asset => {
        const source = window.audioProbe.sources.find(s => new URL(s.mediaElement.src).pathname.endsWith(`/${asset}`));
        const input = source?.inputNode;
        return input?.nextNode?.gain?.value ?? input?.gain?.value ?? null;
      };
      return Object.fromEntries(["vocals", "drums", "bass", "other"].map(stem =>
        [stem, fader(`b-${stem}`)]));
    }, { toDeck });
    for (const [stem, value] of Object.entries(MIX)) {
      assert.ok(Math.abs(configuredFaders[stem] - value) < 0.03,
        `${mode}: persisted unequal incoming ${stem} fader reaches audio graph (${configuredFaders[stem]} vs ${value})`);
    }
    const fadeStart = await page.evaluate(({ fromDeck, toDeck }) => {
      const rows = window.audioProbe.autoFadeSamples;
      const first = rows.find(s => {
        const from = s.rows.find(r => r.deck === fromDeck)?.master ?? 0;
        const to = s.rows.find(r => r.deck === toDeck)?.master ?? 0;
        // Before transition the standby master can remain at the session
        // master value while silent. Detect the outgoing departure from .63
        // and the incoming reset below .2, then compensate one sampler tick.
        return from > 0.4 && from < 0.6299 && to < 0.2;
      });
      return first ? first.t - 40 : performance.now();
    }, { fromDeck, toDeck });
    const fadeEnd = fadeStart + 2000;
    // Never use Finish/Mix as a transition command: wait for real completion,
    // then verify automatic role handoff and new current-title state.
    await page.waitForFunction(() => !document.querySelector('[data-testid="Finish"]') &&
      document.querySelector('[data-role="current"]')?.textContent.includes("Test b"), null, { timeout: 12_000 })
      .catch(async () => page.waitForFunction(() => document.querySelector('[data-role="current"]')?.textContent.includes("Test b"),
        null, { timeout: 12_000 }));
    const sampleCountAtHandoff = await page.evaluate(() => window.audioProbe.autoFadeSamples.length);
    await page.waitForFunction(({ before, toDeck }) => {
      const current = document.querySelector('[data-role="current"] audio');
      const stableWindows = window.audioProbe.autoFadeSamples.slice(before).filter(s => {
        const row = s.rows.find(r => r.deck === toDeck);
        return current && !current.paused && current.currentTime > 0 && row?.master > 0.60 && row.rms > 0.005;
      });
      return stableWindows.length >= 6;
    }, { before: sampleCountAtHandoff, toDeck }, { timeout: 3000 });
    const samples = await stopSamples();
    const handoff = await page.evaluate(() => ({
      current: document.querySelector('[data-role="current"]')?.textContent ?? "",
      gains: window.audioProbe.masterGains.map(g => g.gain.value),
    }));
    assert.match(handoff.current, /Test b/, `${mode}: automatic fade hands off to queued b without manual Finish`);
    const finishTime = samples.at(-1)?.t ?? fadeEnd;
    const outgoingBase = stats(samples, fromDeck, fadeStart - 500, fadeStart - 100);
    const steadyRows = samples.slice(sampleCountAtHandoff)
      .map(s => s.rows.find(r => r.deck === toDeck))
      .filter(r => r && r.master > 0.60 && r.rms > 0.005);
    assert.ok(steadyRows.length >= 6, `${mode}: at least six measured incoming steady PCM windows`);
    const incomingSteady = {
      windows: steadyRows.length,
      rms: steadyRows.reduce((n, r) => n + r.rms, 0) / steadyRows.length,
      peak: Math.max(...steadyRows.map(r => r.peak)),
      master: steadyRows.reduce((n, r) => n + r.master, 0) / steadyRows.length,
    };
    const incomingBase = incomingSteady;
    const fadeMetrics = assertFadeSamples(mode, samples, fromDeck, toDeck, fadeStart, fadeEnd,
      outgoingBase, incomingBase, incomingSteady);
    let afterSwap;
    if (mode === "source-to-stems") {
      afterSwap = await swapAndVerify(page.locator('[data-role="current"]'), "bass", `${mode} post-handoff swap`);
    } else {
      // The old active donor was audibly measured through outgoing fade; now
      // make a fresh swap on b, proving new-current swap controls survived role change.
      afterSwap = await swapAndVerify(page.locator('[data-role="current"]'), "drums", `${mode} post-handoff swap`);
    }
    await page.screenshot({ path: `${artifacts}/${mode}.png`, fullPage: true });
    report.scenarios.push({
      mode, outgoing: "Test a", incoming: "Test b", bpm: 128, beatGrid: null, master: 0.63,
      persistedUnequalStemMix: MIX, fade: fadeMetrics,
      steadyPcm: { outgoing: outgoingBase, incoming: incomingSteady },
      postHandoff: handoff, postHandoffSwap: afterSwap,
      preFadeSwap: mode === "stems-to-stems" ? "outgoing a vocals -> donor c" : "queued incoming b vocals -> donor c",
      limitations: mode === "source-to-stems"
        ? "source-only outgoing a has no live-swap controls; pre-fade donor swap exercised on queued incoming b instead."
        : "outgoing donor remains live during fade; browser PCM is sampled per deck output, combined energy modeled in quadrature.",
    });
    await page.getByTestId("session-play").click().catch(() => {});
  }
  await writeFile(`${artifacts}/report.json`, `${JSON.stringify(report, null, 2)}\n`);
  console.log(`AUTO_FADE_REPORT ${JSON.stringify(report)}`);
  return report;
}
