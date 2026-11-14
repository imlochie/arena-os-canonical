/**
 * arena-js-dsp engine tests — real DSP over synthetic PCM:
 * BPM detection at exact tempi, beat-grid spacing, key detection for pure
 * tones/chords, and honest nulls for silence.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  analysePcm,
  chromaFromPcm,
  estimateBeatGrid,
  estimateDownbeatGrid,
  estimateBpm,
  estimateTrackTempo,
  tempoCandidates,
  keyFromChroma,
  normaliseBeatGrid,
  onsetEnvelope,
  beatConfidenceFromGrid,
  decodeMonoPcm,
  detectBassAttacks,
  detectDrumTransients,
  detectHarmonyTimeline,
  detectVocalActivityIntervals,
  detectVocalPitchFrames,
} from "@workspace/arena/lib/waveyard/worker-local/analysis-engine";
import {
  currentKeyConfidence,
  currentBpmConfidence,
  currentBeatConfidence,
  DESKTOP_ANALYSIS_ENGINE,
  DESKTOP_ANALYSIS_ENGINE_VERSION,
} from "../types/analysis-provenance";
import { execTool } from "@workspace/arena/lib/waveyard/ffmpeg";
import { HARMONY_TEMPLATE_MIN_MARGIN } from "../types/harmony-analysis";

const RATE = 22_050;

function sine(frequency: number, seconds: number, amplitude = 0.5): Float32Array {
  const samples = new Float32Array(Math.round(seconds * RATE));
  for (let i = 0; i < samples.length; i += 1) samples[i] = amplitude * Math.sin((2 * Math.PI * frequency * i) / RATE);
  return samples;
}

/** Click track: short bursts at a given BPM. */
function clickTrack(bpm: number, seconds: number): Float32Array {
  const samples = new Float32Array(Math.round(seconds * RATE));
  const period = (60 / bpm) * RATE;
  for (let i = 0; i < samples.length; i += 1) {
    const phase = i % period;
    if (phase < RATE * 0.01) {
      samples[i] = 0.9 * Math.sin((2 * Math.PI * 1000 * i) / RATE) * (1 - phase / (RATE * 0.01));
    }
  }
  return samples;
}

function accentedClickTrack(bpm: number, seconds: number): Float32Array {
  const samples = new Float32Array(Math.round(seconds * RATE));
  const period = (60 / bpm) * RATE;
  for (let i = 0; i < samples.length; i += 1) {
    const phase = i % period;
    const accent = Math.floor(i / period) % 2 === 0 ? 0.9 : 0.25;
    if (phase < RATE * 0.01) {
      samples[i] = accent * Math.sin((2 * Math.PI * 1000 * i) / RATE) * (1 - phase / (RATE * 0.01));
    }
  }
  return samples;
}

function downbeatFixture(phase: number, beatCount = 33): { envelope: Float32Array; grid: number[] } {
  const frameMs = 10;
  const grid = Array.from({ length: beatCount }, (_, index) => index * 500);
  const envelope = new Float32Array(Math.ceil(grid.at(-1)! / frameMs) + 16);
  for (let index = 0; index < beatCount; index += 1) {
    const center = Math.round(grid[index]! / frameMs);
    const level = index % 4 === phase ? 1 : 0.1;
    envelope[center] = level;
    envelope[center - 1] = level * 0.5;
    envelope[center + 1] = level * 0.5;
  }
  return { envelope, grid };
}

function graduallyDriftingClickTrack(seconds: number): { samples: Float32Array; beatsMs: number[] } {
  const samples = new Float32Array(Math.round(seconds * RATE));
  const beatsMs: number[] = [];
  let timeSeconds = 0;
  const clickLength = Math.round(RATE * 0.01);
  while (timeSeconds < seconds - 0.02) {
    beatsMs.push(Math.round(timeSeconds * 1000));
    const start = Math.round(timeSeconds * RATE);
    for (let index = 0; index < clickLength && start + index < samples.length; index += 1) {
      samples[start + index] = 0.9 * Math.sin((2 * Math.PI * 1000 * (start + index)) / RATE) * (1 - index / clickLength);
    }
    const drift = timeSeconds / seconds;
    timeSeconds += 0.48 + 0.04 * drift;
  }
  return { samples, beatsMs };
}

test("estimateBpm detects an exact 120 BPM click track", () => {
  const pcm = clickTrack(120, 10);
  const { envelope, frameMs } = onsetEnvelope(pcm);
  const { bpm, confidence } = estimateBpm(envelope, frameMs);
  assert.notEqual(bpm, null);
  if (bpm !== null) assert.ok(Math.abs(bpm - 120) < 2.5, `bpm ${bpm} should be near 120`);
  assert.notEqual(confidence, null);
});

test("estimateBpm detects 90 BPM and folds harmonics correctly", () => {
  const pcm = clickTrack(90, 12);
  const { envelope, frameMs } = onsetEnvelope(pcm);
  const { bpm } = estimateBpm(envelope, frameMs);
  if (bpm !== null) {
    const candidates = [bpm, bpm * 2, bpm / 2, bpm * 3, bpm / 3];
    assert.ok(candidates.some((candidate) => Math.abs(candidate - 90) < 2.5), `bpm ${bpm} should relate to 90`);
  }
});

test("estimateBeatGrid returns evenly spaced beats near the true tempo", () => {
  const pcm = clickTrack(140, 10);
  const { envelope, frameMs } = onsetEnvelope(pcm);
  const { bpm } = estimateBpm(envelope, frameMs);
  assert.notEqual(bpm, null);
  const grid = estimateBeatGrid(envelope, frameMs, bpm!);
  assert.notEqual(grid.beatGridMs, null);
  const beats = grid.beatGridMs!;
  assert.ok(beats.length > 10, `expected many beats, got ${beats.length}`);
  const expected = 60_000 / 140;
  for (let i = 1; i < beats.length; i += 1) {
    const interval = beats[i] - beats[i - 1];
    assert.ok(Math.abs(interval - expected) < expected * 0.25, `interval ${interval} vs expected ${expected}`);
  }
});

test("downbeat analysis finds repeated 4/4 accents without assuming beat zero is bar one", () => {
  const { envelope, grid } = downbeatFixture(3);
  const result = estimateDownbeatGrid(envelope, 10, grid, 0.9);
  assert.deepEqual(result.downbeatGridMs, [1500, 3500, 5500, 7500, 9500, 11500, 13500, 15500]);
  assert.ok((result.downbeatConfidence ?? 0) >= 0.65);

  const openingAccent = downbeatFixture(0);
  const atZero = estimateDownbeatGrid(openingAccent.envelope, 10, openingAccent.grid, 0.9);
  assert.deepEqual(atZero.downbeatGridMs, [0, 2000, 4000, 6000, 8000, 10000, 12000, 14000],
    "the emitted grid stops at the last complete evidence window instead of extrapolating the tail");
});

test("downbeat analysis refuses a pickup/irregular opening instead of backfilling an invented bar phase", () => {
  const { envelope, grid } = downbeatFixture(0);
  for (let index = 0; index < 4; index += 1) {
    const center = Math.round(grid[index]! / 10);
    envelope[center] = index === 1 ? 1 : 0.1;
    envelope[center - 1] = envelope[center] * 0.5;
    envelope[center + 1] = envelope[center] * 0.5;
  }
  const result = estimateDownbeatGrid(envelope, 10, grid, 0.9);
  assert.equal(result.downbeatGridMs, null);
  assert.ok((result.downbeatConfidence ?? 1) < 0.65);
});

test("downbeat analysis rejects a confident phase change instead of flattening two arrangements into one bar grid", () => {
  const { envelope, grid } = downbeatFixture(0, 49);
  for (let index = 20; index < grid.length; index += 1) {
    const center = Math.round(grid[index]! / 10);
    const level = index % 4 === 2 ? 1 : 0.1;
    envelope[center] = level;
    envelope[center - 1] = level * 0.5;
    envelope[center + 1] = level * 0.5;
  }
  const result = estimateDownbeatGrid(envelope, 10, grid, 0.9);
  assert.equal(result.downbeatGridMs, null);
});

test("downbeat analysis leaves uniform pulses and weak beat grids unavailable", () => {
  const { envelope, grid } = downbeatFixture(0);
  for (const beat of grid) {
    const center = Math.round(beat / 10);
    envelope[center] = 0.5;
    envelope[center - 1] = 0.25;
    envelope[center + 1] = 0.25;
  }
  assert.equal(estimateDownbeatGrid(envelope, 10, grid, 0.9).downbeatGridMs, null);
  assert.equal(estimateDownbeatGrid(envelope, 10, grid, 0.49).downbeatGridMs, null);

  const tripleMeter = new Float32Array(envelope.length);
  for (let index = 0; index < grid.length; index += 1) {
    const center = Math.round(grid[index]! / 10);
    const level = index % 3 === 0 ? 1 : 0.1;
    tripleMeter[center] = level;
    tripleMeter[center - 1] = level * 0.5;
    tripleMeter[center + 1] = level * 0.5;
  }
  assert.equal(estimateDownbeatGrid(tripleMeter, 10, grid, 0.9).downbeatGridMs, null);
});

test("beat grid follows gradual tempo drift instead of forcing one constant period", () => {
  const { samples, beatsMs: expectedBeats } = graduallyDriftingClickTrack(36);
  const { envelope, frameMs } = onsetEnvelope(samples);
  const grid = estimateBeatGrid(envelope, frameMs, 120);
  assert.ok(grid.beatGridMs !== null);
  const tracked = grid.beatGridMs!;
  const count = Math.min(tracked.length, expectedBeats.length);
  assert.ok(count > 50, `enough tracked beats: ${count}`);
  let trackedError = 0;
  let fixedError = 0;
  for (let index = 0; index < count; index += 1) {
    trackedError += Math.abs(tracked[index]! - expectedBeats[index]!);
    fixedError += Math.abs(index * 500 - expectedBeats[index]!);
  }
  const trackedMeanError = trackedError / count;
  const fixedMeanError = fixedError / count;
  assert.ok(trackedMeanError < 30, `tracked mean timing error ${trackedMeanError.toFixed(1)}ms`);
  assert.ok(trackedMeanError < fixedMeanError * 0.5,
    `tracked error ${trackedMeanError.toFixed(1)}ms should beat fixed-grid error ${fixedMeanError.toFixed(1)}ms`);
});

test("spectral onset flux recovers quieter intervening beats and reports tempo changes honestly", () => {
  const pcm = accentedClickTrack(86, 90);
  const { envelope, frameMs } = onsetEnvelope(pcm);
  const raw = estimateBpm(envelope, frameMs);
  const full = estimateTrackTempo(envelope, frameMs);
  assert.ok(raw.bpm !== null && Math.abs(raw.bpm - 86) < 3, `the quiet beats should remain visible between accents, got ${raw.bpm}`);
  assert.ok(full.bpm !== null && Math.abs(full.bpm - 86) < 3, `track tempo ${full.bpm} should stay near the audible pulse`);
  assert.ok((full.confidence ?? 0) > 0.5, "a stable repeated pulse should retain useful confidence");

  const mixed = clickTrack(86, 90);
  for (let index = Math.round(30 * RATE); index < mixed.length; index += Math.round(30 * RATE)) {
    const end = Math.min(mixed.length, index + Math.round(30 * RATE));
    const slower = clickTrack(104, (end - index) / RATE);
    mixed.set(slower, index);
    index = end - Math.round(30 * RATE);
  }
  const mixedEnvelope = onsetEnvelope(mixed);
  const mixedEstimate = estimateTrackTempo(mixedEnvelope.envelope, mixedEnvelope.frameMs);
  assert.ok(mixedEstimate.bpm !== null);
  assert.ok((mixedEstimate.confidence ?? 1) < (full.confidence ?? 0), "tempo changes must lower global confidence");
});

test("spectral onset flux detects repeated timbre changes at nearly constant signal level", () => {
  const bpm = 120;
  const seconds = 8;
  const samples = new Float32Array(Math.round(seconds * RATE));
  const beatSamples = Math.round((60 / bpm) * RATE);
  let phase = 0;
  for (let index = 0; index < samples.length; index += 1) {
    const frequency = Math.floor(index / beatSamples) % 2 === 0 ? 220 : 880;
    phase += (2 * Math.PI * frequency) / RATE;
    samples[index] = 0.4 * Math.sin(phase);
  }

  const { envelope, frameMs } = onsetEnvelope(samples);
  const peakNearMs = (timeMs: number) => {
    const center = Math.round(timeMs / frameMs);
    let peak = 0;
    for (let frame = Math.max(0, center - 3); frame <= Math.min(envelope.length - 1, center + 3); frame += 1) {
      peak = Math.max(peak, envelope[frame] ?? 0);
    }
    return peak;
  };
  const beatPeaks = Array.from({ length: 15 }, (_, index) => peakNearMs((index + 1) * (60_000 / bpm)));
  const offbeatPeaks = Array.from({ length: 15 }, (_, index) => peakNearMs((index + 1.5) * (60_000 / bpm)));
  const mean = (values: number[]) => values.reduce((sum, value) => sum + value, 0) / values.length;
  assert.ok(mean(beatPeaks) > mean(offbeatPeaks) * 2, "spectral changes at pulse times should stand out without RMS attacks");
});

test("silence produces honest nulls, never invented values", () => {
  const result = analysePcm(new Float32Array(RATE * 5));
  assert.equal(result.bpm, null);
  assert.equal(result.musicalKey, null);
  assert.equal(result.beatGridMs, null);
  assert.equal(result.downbeatGridMs, null);
  assert.equal(result.downbeatConfidence, null);
});

test("key detection identifies a pure C major triad as C major-ish", () => {
  // C4 (261.63), E4 (329.63), G4 (392) — chroma should peak C/E/G.
  const length = RATE * 4;
  const pcm = new Float32Array(length);
  for (const frequency of [261.63, 329.63, 392.0]) {
    const tone = sine(frequency, 4, 0.33);
    for (let i = 0; i < length; i += 1) pcm[i] += tone[i];
  }
  const chroma = chromaFromPcm(pcm);
  assert.equal(chroma[0] > chroma[1], true, "C should dominate C#");
  assert.equal(chroma[0] > chroma[11], true, "C should dominate B");
  const { key, confidence } = keyFromChroma(chroma);
  assert.notEqual(key, null);
  assert.ok(key === "C major" || key === "A minor" || key!.startsWith("C") || key!.startsWith("E") || key!.startsWith("G"), `plausible key ${key}`);
  assert.notEqual(confidence, null);
});

test("harmonic-salience chroma recognizes a bass-register I–IV–V progression", () => {
  const chords = [
    [65.406, 82.407, 97.999], // C2–E2–G2
    [87.307, 110, 130.813], // F2–A2–C3
    [97.999, 123.471, 146.832], // G2–B2–D3
    [65.406, 82.407, 97.999],
  ];
  const samples = new Float32Array(RATE * 12);
  for (let index = 0; index < samples.length; index += 1) {
    const chord = chords[Math.min(chords.length - 1, Math.floor(index / (RATE * 3)))];
    samples[index] = chord.reduce(
      (sum, frequency) => sum + 0.2 * Math.sin((2 * Math.PI * frequency * index) / RATE),
      0,
    );
  }
  const result = keyFromChroma(chromaFromPcm(samples));
  assert.equal(result.key, "C major");
  assert.ok((result.confidence ?? 0) >= 0.5, "the repeated diatonic progression should support a confident key");
});

test("local drum analysis executes onset detection without inventing drum classes", () => {
  const pcm = new Float32Array(RATE * 3);
  for (const time of [0.25, 0.75, 1.25, 2.25]) {
    const start = Math.round(time * RATE);
    for (let index = start; index < Math.min(start + 600, pcm.length); index += 1) {
      const offset = index - start;
      pcm[index] += 0.8 * Math.exp(-offset / 90) * Math.sin((2 * Math.PI * 90 * offset) / RATE);
    }
  }
  const events = detectDrumTransients(pcm);
  assert.ok(events.length >= 3, `expected detected transients, got ${events.length}`);
  for (const event of events) {
    assert.equal(event.rhythmicClass, null, "spectral transients do not prove kick/snare/hat identity");
    assert.ok(event.timestampMs >= 0 && event.timestampMs < 3000);
    assert.ok(event.confidence >= 0 && event.confidence <= 1);
  }
});

test("bass attack analysis measures only low-band changes and leaves silence or high clicks unclassified", () => {
  const renderBursts = (frequencyHz: number) => {
    const pcm = new Float32Array(RATE * 4);
    for (const time of [0.25, 0.75, 1.25, 1.75, 2.25, 2.75, 3.25]) {
      const start = Math.round(time * RATE);
      for (let index = start; index < Math.min(start + 2_000, pcm.length); index += 1) {
        const offset = index - start;
        pcm[index] = 0.7 * Math.exp(-offset / 500) * Math.sin((2 * Math.PI * frequencyHz * offset) / RATE);
      }
    }
    return pcm;
  };

  const bassAttacks = detectBassAttacks(renderBursts(65));
  assert.ok(bassAttacks.length >= 5, `expected low-band attacks, got ${bassAttacks.length}`);
  assert.ok(bassAttacks.every((event) => event.confidence >= 0 && event.confidence <= 1));
  assert.equal(detectBassAttacks(renderBursts(5_000)).length, 0, "high-only clicks must not be called bass attacks");
  assert.equal(detectBassAttacks(new Float32Array(RATE * 4)).length, 0, "silence must not create bass attacks");
});

test("local harmony analysis returns timed chord evidence and unknowns for silence", () => {
  const pcm = new Float32Array(RATE * 4);
  const chords = [[261.63, 329.63, 392], [349.23, 440, 523.25]];
  for (let index = 0; index < pcm.length; index += 1) {
    const chord = chords[Math.floor(index / (RATE * 2))]!;
    pcm[index] = chord.reduce((sum, frequency) => sum + 0.3 * Math.sin((2 * Math.PI * frequency * index) / RATE), 0);
  }
  const events = detectHarmonyTimeline(pcm, 2);
  assert.equal(events.length, 2);
  assert.ok(events.every((event) => event.root && event.quality !== "unknown"), JSON.stringify(events));
  assert.ok(events.every((event) => event.confidence >= HARMONY_TEMPLATE_MIN_MARGIN),
    "the persisted confidence value is the accepted template margin, not a calibrated 0–1 probability");
  assert.deepEqual(detectHarmonyTimeline(new Float32Array(RATE * 2), 2).map((event) => event.quality), ["unknown"]);
});

test("local vocal analysis tracks voiced pitch and leaves silence unvoiced", () => {
  const pcm = new Float32Array(RATE * 2);
  for (let index = 0; index < RATE; index += 1) pcm[index] = 0.4 * Math.sin((2 * Math.PI * 220 * index) / RATE);
  const frames = detectVocalPitchFrames(pcm);
  const voiced = frames.filter((frame) => frame.voiced);
  const unvoiced = frames.filter((frame) => !frame.voiced);
  assert.ok(voiced.length > 10);
  assert.ok(voiced.every((frame) => Math.abs((frame.frequencyHz ?? 0) - 220) < 8));
  assert.ok(unvoiced.length > 10);
  assert.ok(unvoiced.every((frame) => frame.frequencyHz === null && frame.midiFloat === null));
});

test("vocal pitch resolves fractional periods across the singing range", () => {
  for (const frequency of [73.42, 146.83, 233.08, 349.23, 587.33, 987.77]) {
    const frames = detectVocalPitchFrames(sine(frequency, 0.5));
    const voiced = frames.filter(frame => frame.voiced);
    assert.ok(voiced.length >= frames.length * 0.9, `missing periodic voice at ${frequency} Hz`);
    for (const frame of voiced) {
      const cents = Math.abs(1200 * Math.log2(frame.frequencyHz! / frequency));
      assert.ok(cents < 15, `${frequency} Hz measured as ${frame.frequencyHz}: ${cents} cents`);
    }
  }
});

test("vocal activity finds unpitched passages independently of pitch tracking", () => {
  const pcm = new Float32Array(RATE * 4);
  let state = 0x12345678;
  for (let index = 0; index < pcm.length; index += 1) {
    state = (1664525 * state + 1013904223) >>> 0;
    const noise = (state / 0x1_0000_0000) * 2 - 1;
    const seconds = index / RATE;
    const active = (seconds >= 0.5 && seconds < 1.5) || (seconds >= 2 && seconds < 3.25);
    pcm[index] = noise * (active ? 0.05 : 0.0003);
  }
  const intervals = detectVocalActivityIntervals(pcm);
  assert.equal(intervals.length, 2, JSON.stringify(intervals));
  assert.ok(Math.abs(intervals[0]!.startMs - 500) <= 30);
  assert.ok(Math.abs(intervals[0]!.endMs - 1_500) <= 40);
  assert.ok(Math.abs(intervals[1]!.startMs - 2_000) <= 30);
  assert.ok(Math.abs(intervals[1]!.endMs - 3_250) <= 40);
  assert.ok(intervals.every((interval) => interval.confidence >= 0 && interval.confidence <= 1));
  assert.equal(detectVocalPitchFrames(pcm).filter((frame) => frame.voiced).length, 0,
    "the fixture must remain unpitched so pitch tracking cannot explain the activity result");
});

test("key confidence separates clear tonal evidence from ambiguous chords", () => {
  const uniform = keyFromChroma(Array(12).fill(1));
  assert.deepEqual(uniform, { key: null, confidence: null }, "equal chroma has no tonic evidence");

  const triad = keyFromChroma([1, 0, 0, 0, 1, 0, 0, 1, 0, 0, 0, 0]);
  assert.notEqual(triad.key, null);
  assert.ok((triad.confidence ?? 1) < 0.5, "one major chord is too ambiguous to claim a confident song key");

  const cMajorScale = keyFromChroma([2, 0.3, 1, 0.2, 2, 1, 0.2, 2, 0.3, 1, 0.2, 0.8]);
  assert.equal(cMajorScale.key, "C major");
  assert.ok((cMajorScale.confidence ?? 0) >= 0.5, "a broader diatonic pitch profile supports the key more strongly");
});

test("key confidence collapses when the chroma carries almost no pitch-class evidence", () => {
  // Real broadband material measured chroma variation 0.03-0.09 while material
  // with a known key measured 0.79-0.92. Profile correlation is scale-free, so
  // before this gate a nearly uniform chroma still matched *some* key and
  // reported high confidence: the least key-like track in the corpus reported
  // the equal-highest confidence of 0.77, and the planner was told to trust it.
  const nearlyUniform = Array.from({ length: 12 }, (_, index) => 1 + 0.02 * Math.sin(index * 1.7));
  const weak = keyFromChroma(nearlyUniform);
  assert.notEqual(weak.confidence, null);
  assert.ok((weak.confidence ?? 1) < 0.1,
    `a near-uniform chroma must not report confidence, got ${weak.confidence}`);

  // The same near-uniform shape with a real, if faint, tonic emphasis still
  // must not be presented as trustworthy.
  const faint = [1.06, 0.99, 1.0, 0.98, 1.02, 0.99, 0.97, 1.01, 0.98, 1.0, 0.99, 0.99];
  assert.ok((keyFromChroma(faint).confidence ?? 1) < 0.35,
    "faint evidence must stay well below the 0.5 mixing threshold");
});

test("key confidence stays high for clear tonal evidence after the evidence gate", () => {
  // The gate must not penalise material the analyser can actually hear. These
  // are the shapes that measured 0.85+ variation.
  const cMajorScale = keyFromChroma([2, 0.3, 1, 0.2, 2, 1, 0.2, 2, 0.3, 1, 0.2, 0.8]);
  assert.equal(cMajorScale.key, "C major");
  assert.ok((cMajorScale.confidence ?? 0) >= 0.5, "a broad diatonic profile must still be trusted");
});

test("a broadband, non-tonal signal does not produce a trusted key", () => {
  // Deterministic pseudo-noise: broadband energy with no pitch structure. This
  // is the failure mode that made every real recording in the CC0 corpus look
  // like C major/minor with usable confidence.
  let seed = 12345;
  const noise = new Float32Array(RATE * 6);
  for (let index = 0; index < noise.length; index += 1) {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    noise[index] = (seed / 0x7fffffff) * 2 - 1;
  }
  const { confidence } = keyFromChroma(chromaFromPcm(noise));
  assert.ok((confidence ?? 1) < 0.5,
    `broadband noise must not yield a trusted key, got confidence ${confidence}`);
});

test("legacy key confidence is not trusted under the revised key-analysis version", () => {
  const current = {
    analysisEngine: DESKTOP_ANALYSIS_ENGINE,
    analysisEngineVersion: DESKTOP_ANALYSIS_ENGINE_VERSION,
  };
  assert.equal(currentKeyConfidence({
    ...current,
    keyConfidence: 0.73,
  }), 0.73);
  assert.equal(currentKeyConfidence({
    ...current,
    analysisEngineVersion: "1.0.0",
    keyConfidence: 0.98,
  }), null);
  assert.equal(currentBpmConfidence({ ...current, analysisEngineVersion: "1.1.0", bpmConfidence: 0.95 }), null);
  assert.equal(currentBeatConfidence({ ...current, analysisEngineVersion: "1.1.0", beatConfidence: 0.95 }), null);
});

test("normaliseBeatGrid rejects unordered and out-of-range grids", () => {
  assert.deepEqual(normaliseBeatGrid([0, 500, 400], 10), null);
  assert.deepEqual(normaliseBeatGrid([0, -5, 1000], 10), null);
  assert.deepEqual(normaliseBeatGrid([0, 500, 1500], 1), null); // beyond duration
  assert.deepEqual(normaliseBeatGrid([0, 500, 1000], 2), [0, 500, 1000]);
  assert.deepEqual(normaliseBeatGrid("nope" as unknown, 2), null);
});

test("beat confidence uses measured audio alignment, not generated-grid regularity", () => {
  const regular: number[] = Array.from({ length: 40 }, (_, i) => i * 500);
  const weakAlignment = beatConfidenceFromGrid(0.8, regular, 0.05);
  const strongAlignment = beatConfidenceFromGrid(0.8, regular, 0.9);
  assert.ok(weakAlignment !== null && weakAlignment < 0.5, "a perfectly spaced generated grid cannot mask weak audio evidence");
  assert.ok(strongAlignment !== null && strongAlignment > weakAlignment);
  assert.equal(beatConfidenceFromGrid(0.8, regular, null), null, "missing alignment evidence stays unknown");
});

test("decodeMonoPcm decodes real audio through bundled ffmpeg (or PATH)", async () => {
  const dir = await mkdtemp(join(tmpdir(), "arena-dsp-test-"));
  try {
    const wavPath = join(dir, "tone.wav");
    // generate 1s 440 Hz tone via ffmpeg lavfi
    await execTool("ffmpeg", ["-v", "error", "-f", "lavfi", "-i", "sine=frequency=440:duration=1", "-ar", "44100", "-y", wavPath]);
    const pcm = await decodeMonoPcm(wavPath);
    assert.ok(pcm.length > RATE * 0.9, `expected ~1s of PCM, got ${pcm.length}`);
    const chroma = chromaFromPcm(pcm);
    assert.ok(chroma[9] > chroma[0], "A (index 9) should dominate C for a 440 Hz tone");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("tempo candidates expose the octave ambiguity of a hats-heavy part", () => {
  // Measured on this analyser: 72 BPM with 8th-note hats reports 143.555 BPM at
  // confidence 1.0, because the strongest autocorrelation peak is the
  // subdivision. The reading is not wrong so much as incomplete, and the
  // octave it lost has to be recoverable or the planner stretches the vocal for
  // a tempo the music never had.
  const { bpm, bpmCandidates, bpmConfidence } = analysePcm(clickTrack(72, 30));
  assert.notEqual(bpm, null);
  assert.ok((bpmConfidence ?? 0) > 0.9, "the misreading is reported with high confidence");
  assert.notEqual(bpmCandidates, null);
  const candidates = bpmCandidates!;
  assert.equal(candidates[0], bpm, "the reported tempo stays first for existing consumers");
  const hasTrueOctave = candidates.some((candidate) => Math.abs(candidate - 72) < 2);
  assert.ok(hasTrueOctave, `72 BPM should be recoverable from ${candidates.join(", ")}`);
  for (const candidate of candidates) {
    assert.ok(candidate >= 40 && candidate <= 300, `candidate ${candidate} is outside the usable range`);
  }
});

test("tempo candidates reject degenerate readings", () => {
  assert.equal(tempoCandidates(null), null);
  assert.equal(tempoCandidates(0), null);
  assert.equal(tempoCandidates(Number.NaN), null);
  assert.deepEqual(tempoCandidates(120), [120, 60, 240, 30].filter((value) => value >= 40 && value <= 300));
});
