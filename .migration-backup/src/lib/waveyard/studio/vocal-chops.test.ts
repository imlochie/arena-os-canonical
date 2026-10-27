/**
 * Vocal chop engine tests — detection, extraction, and chipmunk rendering.
 * Signals are synthetic (sine bursts with known pitches, deterministic LCG
 * noise), so every assertion is arithmetic, not taste.
 */

import assert from "node:assert/strict";
import test from "node:test";

import {
  assignChopToNewNotes,
  chopNoteId,
  detectVocalChops,
  extractChopSample,
  parseChopNoteId,
  renderChopPattern,
  scanVocalStemForChops,
  type ChopSample,
  type PcmBuffer,
} from "./vocal-chops";
import { decodeWav16, encodeWav16 } from "../mixer/synth";

const RATE = 44_100;

function silence(ms: number): Float32Array {
  return new Float32Array(Math.round((ms / 1000) * RATE));
}

function sineBurst(ms: number, hz: number, amplitude = 0.8, rate = RATE): Float32Array {
  const length = Math.round((ms / 1000) * rate);
  const out = new Float32Array(length);
  for (let i = 0; i < length; i += 1) out[i] = amplitude * Math.sin((2 * Math.PI * hz * i) / rate);
  return out;
}

/** Deterministic noise (fixed LCG) so rejection tests are reproducible. */
function noiseBurst(ms: number, amplitude = 0.8, seed = 42): Float32Array {
  const length = Math.round((ms / 1000) * RATE);
  const out = new Float32Array(length);
  let state = seed >>> 0;
  for (let i = 0; i < length; i += 1) {
    state = (state * 1_664_525 + 1_013_904_223) >>> 0;
    out[i] = amplitude * ((state / 0x1_0000_0000) * 2 - 1);
  }
  return out;
}

function concat(...parts: Float32Array[]): Float32Array {
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const out = new Float32Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

function monoBuffer(samples: Float32Array, sampleRate = RATE): PcmBuffer {
  return { samples, channels: 1, sampleRate };
}

/** RMS of a stereo-interleaved render over a time window. */
function windowRms(buffer: Float32Array, fromMs: number, toMs: number, sampleRate = RATE): number {
  const from = Math.floor((fromMs / 1000) * sampleRate) * 2;
  const to = Math.min(buffer.length, Math.floor((toMs / 1000) * sampleRate) * 2);
  if (to <= from) return 0;
  let sum = 0;
  for (let i = from; i < to; i += 1) sum += buffer[i] * buffer[i];
  return Math.sqrt(sum / (to - from));
}

function buildStem(): Float32Array {
  return concat(
    silence(300),                        // 0.3s  — lead-in
    sineBurst(400, 220, 0.8),            // 0.3–0.7s  A3 (midi 57)
    silence(300),                        // 0.7–1.0s
    sineBurst(300, 440, 0.7),            // 1.0–1.3s  A4 (midi 69)
    silence(300),                        // 1.3–1.6s
    sineBurst(250, 523.25, 0.6),         // 1.6–1.85s C5 (midi 72)
    silence(300),                        // 1.85–2.15s
    noiseBurst(300, 0.8),                // 2.15–2.45s unvoiced noise
    silence(300),                        // tail
  );
}

test("detection finds the three sung notes with the right roots and timing", () => {
  const chops = detectVocalChops(monoBuffer(buildStem()));
  assert.ok(chops.length >= 3, `expected at least 3 chops, got ${chops.length}`);

  const expected: Array<{ midi: number; startMs: number; durationMs: number }> = [
    { midi: 57, startMs: 300, durationMs: 400 },
    { midi: 69, startMs: 1000, durationMs: 300 },
    { midi: 72, startMs: 1600, durationMs: 250 },
  ];
  for (const want of expected) {
    const center = want.startMs + want.durationMs / 2;
    const match = chops.find(
      (chop) => chop.startMs < center && chop.startMs + chop.durationMs > center,
    );
    assert.ok(match !== undefined, `no chop covering ${center}ms`);
    assert.equal(match.rootMidi, want.midi);
    assert.ok(Math.abs(match.cents) <= 30, `cents ${match.cents} for midi ${want.midi}`);
    assert.ok(match.startMs >= want.startMs - 60 && match.startMs <= want.startMs + 25, `startMs ${match.startMs}`);
    assert.ok(match.durationMs >= want.durationMs - 10 && match.durationMs <= want.durationMs + 90, `durationMs ${match.durationMs}`);
  }
});

test("unvoiced noise is rejected — no chop in the noise window", () => {
  const chops = detectVocalChops(monoBuffer(buildStem()));
  const noiseCenter = 2150 + 150;
  const inNoise = chops.filter((chop) => chop.startMs < noiseCenter && chop.startMs + chop.durationMs > 2300);
  assert.equal(inNoise.length, 0, `noise window produced chops: ${JSON.stringify(inNoise)}`);
});

test("a clean note outranks the same note buried in noise", () => {
  const stem = concat(silence(200), sineBurst(300, 440, 0.8), silence(300), (() => {
    const clean = sineBurst(300, 440, 0.8);
    const noise = noiseBurst(300, 0.5, 7);
    const mixed = new Float32Array(clean.length);
    for (let i = 0; i < clean.length; i += 1) mixed[i] = clean[i] + noise[i];
    return mixed;
  })(), silence(200));
  const chops = detectVocalChops(monoBuffer(stem));
  assert.equal(chops.length, 2);
  // The clean burst is first (200–500ms), the noisy one second (800–1100ms).
  const cleanScore = chops.find((chop) => chop.startMs < 600)?.score ?? 0;
  const noisyScore = chops.find((chop) => chop.startMs > 600)?.score ?? 1;
  assert.ok(cleanScore > noisyScore, `clean ${cleanScore} should outrank noisy ${noisyScore}`);
});

test("continuous vocals with no silence gaps still yield chops (split at dips)", () => {
  // 3s of continuous vowel-like tone: 200 Hz with vibrato, harmonics, and
  // word-rate amplitude modulation that never reaches silence. Phase is
  // ACCUMULATED — sin(2π·f(t)·t) would sweep far wider than f(t) because its
  // instantaneous frequency is f + f'·t.
  const seconds = 3;
  const pcm = new Float32Array(seconds * RATE);
  let phase = 0;
  let harmonicPhase = 0;
  for (let i = 0; i < pcm.length; i += 1) {
    const t = i / RATE;
    const f0 = 200 + 8 * Math.sin(2 * Math.PI * 0.8 * t);
    phase += (2 * Math.PI * f0) / RATE;
    harmonicPhase += (4 * Math.PI * f0) / RATE;
    const envelope = 0.35 + 0.65 * Math.abs(Math.sin(2 * Math.PI * 1.7 * t));
    pcm[i] = envelope * 0.7 * (Math.sin(phase) + 0.4 * Math.sin(harmonicPhase));
  }
  const chops = detectVocalChops(monoBuffer(pcm));
  assert.ok(chops.length >= 3, `continuous vocals should split into chops, got ${chops.length}`);
  for (const chop of chops) {
    assert.ok(chop.durationMs <= 1500, "no chop may exceed maxDurationMs");
    assert.ok([54, 55, 56].includes(chop.rootMidi), `root ${chop.rootMidi} should track the 200 Hz (±vibrato) tone — 200 Hz is midi 55.4`);
  }
});

test("silence and too-short input produce no chops", () => {
  assert.deepEqual(detectVocalChops(monoBuffer(silence(2000))), []);
  assert.deepEqual(detectVocalChops(monoBuffer(new Float32Array(500))), []);
});

test("extraction normalises the peak and fades the edges", () => {
  const stem = buildStem();
  const buffer = monoBuffer(stem);
  const detection = detectVocalChops(buffer).find((chop) => chop.rootMidi === 69);
  assert.ok(detection !== undefined);
  const { sample } = extractChopSample(buffer, detection);
  assert.ok(sample.length > 0);
  let peak = 0;
  for (const value of sample) peak = Math.max(peak, Math.abs(value));
  assert.ok(peak > 0.9 && peak <= 0.951, `peak ${peak} should normalise to 0.95`);
  assert.ok(Math.abs(sample[0]) < 0.02, "leading edge must be faded in");
  assert.ok(Math.abs(sample[sample.length - 1]) < 0.02, "trailing edge must be faded out");
  // length ≈ detection + 2 × 10ms pad
  const expected = Math.round(((detection.durationMs + 20) / 1000) * RATE);
  assert.ok(Math.abs(sample.length - expected) <= 100, `${sample.length} vs ${expected}`);
});

function chopFromSine(hz: number, ms: number, rootMidi: number, sampleRate = RATE): ChopSample {
  // The sample is generated AT its declared rate (a 22.05 kHz chop is a
  // genuinely 22.05 kHz signal, not a 44.1 kHz signal mislabelled).
  return { sample: sineBurst(ms, hz, 0.8, sampleRate), sampleRate, rootMidi };
}

test("chipmunk render: +1 octave plays the chop at double pitch in half the time", () => {
  const chop = chopFromSine(220, 400, 57); // A3, 400ms
  const out = renderChopPattern(
    [{ startMs: 0, durationMs: 1000, midi: 69, velocity: 127, chopIndex: 0 }],
    [chop],
    RATE,
    1,
  );
  assert.equal(out.length, 2 * RATE, "stereo interleaved, 1 second");
  // Natural (pitched) length is 200ms — the drawn 1000ms cannot stretch it.
  assert.ok(windowRms(out, 20, 150) > 0.1, "sound during the pitched chop");
  assert.ok(windowRms(out, 260, 500) < 1e-3, "silent after the chop ends");
});

test("a drawn length shorter than the chop cuts it (with fade, no click bomb)", () => {
  const chop = chopFromSine(220, 400, 57);
  const out = renderChopPattern(
    [{ startMs: 0, durationMs: 100, midi: 57, velocity: 127, chopIndex: 0 }],
    [chop],
    RATE,
    1,
  );
  assert.ok(windowRms(out, 0, 90) > 0.1, "sound within the drawn 100ms");
  assert.ok(windowRms(out, 130, 400) < 1e-3, "cut after the drawn end");
});

test("velocity scales the render linearly", () => {
  const chop = chopFromSine(220, 400, 57);
  const render = (velocity: number) =>
    windowRms(
      renderChopPattern([{ startMs: 0, durationMs: 1000, midi: 57, velocity, chopIndex: 0 }], [chop], RATE, 0.5),
      0,
      300,
    );
  const loud = render(127);
  const soft = render(64);
  const ratio = loud / soft;
  assert.ok(ratio > 1.7 && ratio < 2.2, `velocity ratio ${ratio} should be ~127/64`);
});

test("stacked chops never clip past full scale", () => {
  const chop = chopFromSine(220, 400, 57);
  const events = Array.from({ length: 8 }, (_, index) => ({
    startMs: index,
    durationMs: 400,
    midi: 57 + (index % 12),
    velocity: 127,
    chopIndex: 0,
  }));
  const out = renderChopPattern(events, [chop], RATE, 0.5);
  for (const value of out) assert.ok(value >= -1.0001 && value <= 1.0001, `sample ${value} clipped`);
});

test("chop sample rate is compensated — 22.05 kHz chop stays 400ms at 44.1 kHz out", () => {
  const chop = chopFromSine(220, 400, 57, 22_050);
  const out = renderChopPattern(
    [{ startMs: 0, durationMs: 1000, midi: 57, velocity: 127, chopIndex: 0 }],
    [chop],
    RATE,
    1,
  );
  assert.ok(windowRms(out, 100, 350) > 0.1, "sound across the natural 400ms");
  assert.ok(windowRms(out, 430, 700) < 1e-3, "silent after 400ms");
});

test("chop note ids round-trip and reject foreign ids", () => {
  const chopId = "00000000-0000-0000-0000-000000000001";
  const id = chopNoteId(chopId, "n3");
  assert.equal(parseChopNoteId(id), chopId);
  assert.equal(parseChopNoteId("fresh-note-1"), null);
  assert.equal(parseChopNoteId(`${chopId}:`), null);
  assert.equal(parseChopNoteId("not-a-uuid:n3"), null);
});

test("assignChopToNewNotes stamps only unstamped ids, in order", () => {
  const chopId = "00000000-0000-0000-0000-000000000002";
  const other = "00000000-0000-0000-0000-000000000003";
  const notes = [
    { id: chopNoteId(other, "kept") },
    { id: "drawn-1" },
    { id: chopNoteId(chopId, "also-kept") },
    { id: "drawn-2" },
  ];
  const stamped = assignChopToNewNotes(notes, chopId);
  assert.equal(stamped[0].id, notes[0].id, "already-stamped notes are untouched");
  assert.equal(stamped[2].id, notes[2].id, "already-stamped notes are untouched");
  assert.equal(parseChopNoteId(stamped[1].id), chopId);
  assert.equal(parseChopNoteId(stamped[3].id), chopId);
  assert.notEqual(stamped[1].id, stamped[3].id);
});

test("scan survives a full WAV encode → decode round trip (the API's exact path)", () => {
  const mono = buildStem();
  const stereo = new Float32Array(mono.length * 2);
  for (let i = 0; i < mono.length; i += 1) {
    stereo[i * 2] = mono[i];
    stereo[i * 2 + 1] = mono[i];
  }
  const wav = encodeWav16(stereo, RATE);
  const decoded = decodeWav16(wav);
  assert.ok(decoded !== null);
  assert.equal(decoded.channels, 2);
  assert.equal(decoded.sampleRate, RATE);

  const extracted = scanVocalStemForChops({
    samples: decoded.samples,
    channels: decoded.channels,
    sampleRate: decoded.sampleRate,
  });
  assert.ok(extracted.length >= 3, `expected ≥3 chops through the WAV path, got ${extracted.length}`);
  const midis = new Set(extracted.map((chop) => chop.detection.rootMidi));
  assert.ok(midis.has(57) && midis.has(69) && midis.has(72), `roots ${[...midis]}`);
  for (const chop of extracted) {
    let peak = 0;
    for (const value of chop.sample) peak = Math.max(peak, Math.abs(value));
    assert.ok(peak > 0.9 && peak <= 0.951, "stored chops are normalised");
  }
});
