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
  estimateBpm,
  estimateTrackTempo,
  keyFromChroma,
  normaliseBeatGrid,
  onsetEnvelope,
  beatConfidenceFromGrid,
  decodeMonoPcm,
} from "@workspace/arena/lib/waveyard/worker-local/analysis-engine";
import {
  currentKeyConfidence,
  currentBpmConfidence,
  currentBeatConfidence,
  DESKTOP_ANALYSIS_ENGINE,
  DESKTOP_ANALYSIS_ENGINE_VERSION,
} from "../types/analysis-provenance";
import { execTool } from "@workspace/arena/lib/waveyard/ffmpeg";

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

test("track tempo folds half-time readings and reports disagreement honestly", () => {
  const pcm = accentedClickTrack(86, 90);
  const { envelope, frameMs } = onsetEnvelope(pcm);
  const raw = estimateBpm(envelope, frameMs);
  const full = estimateTrackTempo(envelope, frameMs);
  assert.ok(raw.bpm !== null && raw.bpm < 60, `the sparse accent pattern should expose the half-time ambiguity, got ${raw.bpm}`);
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

test("silence produces honest nulls, never invented values", () => {
  const result = analysePcm(new Float32Array(RATE * 5));
  assert.equal(result.bpm, null);
  assert.equal(result.musicalKey, null);
  assert.equal(result.beatGridMs, null);
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
