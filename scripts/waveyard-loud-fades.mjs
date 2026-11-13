import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";

const STEMS = ["vocals", "drums", "bass", "other"];
const MIX = { vocals: 0.94, drums: 0.53, bass: 0.76, other: 0.84 };

/** Original controlled PCM, real UI swaps and automatic transitions, one summed output tap. */
export async function runLoudAutomaticFadeAcceptance({ page, session, tracks, sourceOnlyTrack, assets, wav, chooseLiveSource }) {
  const report = {
    format: "waveyard-loud-fades/v1",
    evidence: "Chromium WebAudio analyser sample peaks, synthetic PCM and mocked persistence; reconstructed true peak is measured separately by the 4x windowed-sinc limiter tests; neither is Windows audio-driver acceptance",
    fixtures: {
      correlated: "Same-polarity held PCM: source 0.98, reconstructed stem track 0.98 including its donor component; individually safe decks expose pure overlap overload independent of media start phase.",
      uncorrelated: "Distinct-frequency 0.98-peak sine on each native stem and live donor; deliberate multi-stem overload stress.",
    },
    thresholds: {
      ceiling: 0.98,
      outputTolerance: 0.0001,
      minimumFadeWindows: 15,
      cadenceMs: 20,
    },
    reconstructedPeakValidation: {
      evidence: "Separate limiter unit tests, not browser analyser data",
      method: "4x polyphase windowed-sinc, 24 taps per phase",
      ceiling: 0.98,
      tolerance: 0.001,
    },
    scenarios: [],
  };
  const folder = "generated-artifacts/waveyard-loud-fades";
  await mkdir(folder, { recursive: true });
  for (const correlated of [true, false]) for (const master of [0.1, 0.63, 1]) {
    for (const mode of ["source-to-stems", "stems-to-stems"]) {
      for (const [index, id] of ["a", "b", "c"].entries()) {
        assets.set(`${id}-source`, wav(id === "a" ? 20 : 8, correlated ? 220 : 151 + index * 130, 0.98, correlated, 2));
        for (const [stemIndex, stem] of STEMS.entries())
          assets.set(`${id}-${stem}`, wav(id === "a" ? 20 : 12,
            correlated ? 220 : 151 + index * 130 + stemIndex * 67,
            correlated ? 0.245 : 0.98, correlated, 2));
      }
      const makeTrack = (track) => ({ ...track,
        analysis: { ...track.analysis, bpm: 128, beatGridMs: null },
        transition: { mode: "manual", crossfadeSeconds: 2, keepStems: [] }, stemMix: { ...MIX } });
      session.tracks = [makeTrack(mode === "source-to-stems" ? sourceOnlyTrack : tracks[0]),
        makeTrack(tracks[1]), makeTrack(tracks[2])];
      session.swaps = [];
      session.currentSessionTrackId = mode === "source-to-stems" ? "b" : "a";
      session.positionSeconds = 0;
      const open = async () => {
        await page.goto(`http://localhost:80/waveyard/session/${session.id}`);
        await page.waitForFunction(() => {
          const audio = [...document.querySelectorAll('[data-role="current"] audio')];
          return audio.length > 0 && audio.every(a => a.readyState >= 2);
        });
        await page.getByLabel("Master volume", { exact: true }).fill(String(master));
        await page.getByTestId("session-play").click();
        await page.waitForFunction(() => document.querySelector('[data-testid="session-play"]')?.getAttribute("aria-pressed") === "true");
      };
      // The donor is genuinely selected through the current deck UI, then saved
      // onto the incoming track for source-to-stems, not inserted by a probe.
      await open();
      await chooseLiveSource("vocals", "c");
      await page.waitForFunction(() => window.audioProbe.buffers.some(b => b.buffer && !b.stopCount && b.inputNode?.gain.value > 0.05));
      const recipient = session.currentSessionTrackId;
      assert.ok(session.swaps.some(s => s.sessionTrackId === recipient && s.toTrackId === "c"), "donor choice persisted");
      if (mode === "source-to-stems") {
        await page.getByTestId("session-play").click();
        session.currentSessionTrackId = "a";
        await open();
      }
      await page.getByTestId("session-peak-protection").waitFor();
      await page.getByTestId("session-auto-crossfade").check();
      await page.evaluate(() => {
        if (window.audioProbe.combinedInputs.length !== 1 || window.audioProbe.combinedOutputs.length !== 1)
          throw new Error("Both decks must feed one protected session bus.");
        window.loudSamples = [];
        window.loudPlayStart = window.audioProbe.playStarts.length;
        window.loudTimer = setInterval(() => {
          const read = analyser => {
            const data = new Float32Array(analyser.fftSize);
            analyser.getFloatTimeDomainData(data);
            return { peak: data.reduce((m, x) => Math.max(m, Math.abs(x)), 0),
              rms: Math.sqrt(data.reduce((sum, x) => sum + x * x, 0) / data.length) };
          };
          const fading = [...document.querySelectorAll("button")].some(b => b.textContent.trim() === "Finish");
          window.loudSamples.push({ fading, raw: read(window.audioProbe.combinedInputs[0]),
            output: read(window.audioProbe.combinedOutputs[0]),
            donorActive: window.audioProbe.buffers.some(b => b.buffer && !b.stopCount &&
              b.inputNode?.gain.value > 0.05 && b.inputNode?.nextNode?.gain.value > 0.01),
            decks: window.audioProbe.outputAnalyzers.map(({ analyser }) => read(analyser)),
            gains: window.audioProbe.masterGains.map(g => g.gain.value) });
        }, 20);
      });
      await page.locator('[data-role="current"]').getByTestId("seek-deck-0").fill("17.5");
      await page.getByRole("button", { name: "Finish", exact: true }).waitFor({ timeout: 8000 });
      await page.waitForFunction(() => document.querySelector('[data-role="current"] h3')?.textContent?.trim() === "Test b",
        null, { timeout: 12_000 });
      await page.waitForTimeout(250);
      const evidence = await page.evaluate(() => {
        clearInterval(window.loudTimer);
        return { samples: window.loudSamples,
          donorStarted: window.audioProbe.buffers.some(b => b.buffer && Number.isFinite(b.startedAt)),
          contexts: new Set(window.audioProbe.masterGains.map(g => g.context)).size,
          starts: window.audioProbe.playStarts.slice(window.loudPlayStart) };
      });
      const fade = evidence.samples.filter(s => s.fading);
      assert.ok(fade.length >= report.thresholds.minimumFadeWindows, `fade windows: ${fade.length}`);
      assert.ok(fade.filter(s => s.donorActive).length >= 10, "real donor remains connected through the fade");
      assert.ok(fade.some(s => s.decks.length === 2 && s.decks.every(d => d.peak > 0.01)),
        "both physical decks are audible during intentional equal-power overlap");
      assert.equal(evidence.contexts, 1, "physical decks share one AudioContext");
      assert.equal(evidence.starts.find(s => s.deck === 1)?.master, 0,
        "incoming playback starts at zero, not a stale full master before the fade");
      const rawPeak = Math.max(...fade.map(s => s.raw.peak));
      const outputPeak = Math.max(...evidence.samples.map(s => s.output.peak));
      const deckPeaks = [0, 1].map(index => Math.max(...fade.map(s => s.decks[index]?.peak ?? 0)));
      const floorRms = Math.min(...fade.map(s => s.output.rms));
      assert.ok(outputPeak <= 0.9801, `combined output clips: ${outputPeak}`);
      assert.ok(floorRms > 0.005, `mix remains audible: ${floorRms}`);
      if (master === 1) assert.ok(rawPeak > 1.02, `fixture must expose real combined overload, got ${rawPeak}`);
      if (correlated) assert.ok(deckPeaks.every(peak => peak <= 0.981),
        `safe individual decks can still overload when summed: ${JSON.stringify(deckPeaks)}`);
      // A quiet master does not engage protection; tolerate analyser-window
      // phase and the fixed 5 ms lookahead, not a different loudness curve.
      if (master === 0.1) {
        assert.ok(rawPeak < 0.98);
        const rawRms = fade.reduce((sum, s) => sum + s.raw.rms, 0);
        const outRms = fade.reduce((sum, s) => sum + s.output.rms, 0);
        assert.ok(Math.abs(outRms / rawRms - 1) < 0.08, "quiet output stays transparent");
      }
      for (const track of session.tracks) for (const stem of STEMS)
        assert.equal(track.stemMix[stem], MIX[stem], "protection never edits stored balances");
      const sliders = page.locator('[data-role="current"]');
      for (const stem of STEMS)
        assert.equal(Number(await sliders.getByLabel(`${stem} level, current deck`, { exact: true }).inputValue()), MIX[stem]);
      const row = { correlated, master, mode, rawPeak, outputPeak, deckPeaks, floorRms,
        windows: fade.length, sampleRate: await page.evaluate(() => window.audioProbe.combinedOutputs[0].context.sampleRate),
        overloadWindows: fade.filter(s => s.raw.peak > 1).length };
      report.scenarios.push(row);
      console.log(`LOUD_FADE ${JSON.stringify(row)}`);
    }
  }
  await writeFile(`${folder}/report.json`, `${JSON.stringify(report, null, 2)}\n`);
  await page.screenshot({ path: `${folder}/protected-mix.png`, fullPage: true });
  console.log("PASS: loud correlated and uncorrelated automatic mixes stay within the combined output ceiling; saved faders are unchanged");
  return report;
}
