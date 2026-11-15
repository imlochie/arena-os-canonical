import assert from "node:assert/strict";
import test from "node:test";
import { scoreVocalChordToneFit } from "../studio/mashup";
import type { HarmonyEvent } from "../types/harmony-analysis";
import { ANALYSIS_PCM_RATE } from "./analysis-engine";
import { analyzeHarmonicCandidate } from "./harmonic-candidate";

const RATE = ANALYSIS_PCM_RATE;
function addNote(pcm: Float32Array, start: number, end: number, midi: number, amplitude = 0.22, detuneCents = 0, harmonics = true): void {
  const frequency = 440 * 2 ** ((midi - 69) / 12) * 2 ** (detuneCents / 1200);
  const first = Math.floor(start * RATE); const last = Math.min(pcm.length, Math.floor(end * RATE));
  for (let i = first; i < last; i += 1) {
    const t = i / RATE;
    let value = Math.sin(2 * Math.PI * frequency * t);
    if (harmonics) for (let k = 2; k <= 7; k += 1) value += Math.sin(2 * Math.PI * frequency * k * t) * (0.45 / k);
    pcm[i] += amplitude * value;
  }
}
function notes(duration: number, midi: number[], cents = 0): Float32Array {
  const pcm = new Float32Array(Math.ceil(duration * RATE));
  for (const note of midi) addNote(pcm, 0.04, duration - 0.04, note, 0.2, cents);
  return pcm;
}
function named(event: HarmonyEvent | undefined): string | null {
  return event && event.root && event.quality !== "unknown" ? `${event.root}:${event.quality}` : null;
}

test("single pitched note and its upper partials do not become a chord", () => {
  const result = analyzeHarmonicCandidate(notes(2, [48])); // C3 with a rich overtone series.
  assert.ok(result.events.length >= 2);
  assert.ok(result.events.every((event) => event.quality === "unknown"), JSON.stringify(result.events));
});

test("polyphonic triads and inversions retain the chord pitch classes", () => {
  const cMajor = analyzeHarmonicCandidate(notes(2, [48, 52, 55]));
  const inversion = analyzeHarmonicCandidate(notes(2, [43, 48, 52]));
  assert.equal(named(cMajor.events[0]), "C:major");
  assert.equal(named(inversion.events[0]), "C:major");
});

test("arpeggio note order is pooled inside its passage without inventing evidence in silence", () => {
  const pcm = new Float32Array(3 * RATE);
  for (let cycle = 0; cycle < 2; cycle += 1) {
    const start = cycle * 1.15;
    addNote(pcm, start, start + 0.29, 48);
    addNote(pcm, start + 0.29, start + 0.58, 52);
    addNote(pcm, start + 0.58, start + 0.87, 55);
  }
  const result = analyzeHarmonicCandidate(pcm);
  assert.equal(named(result.events[0]), "C:major");
  assert.equal(named(result.events[2]), null);
});

test("low-register evidence below C2 is retained while ambiguous chord identity abstains", () => {
  const result = analyzeHarmonicCandidate(notes(2, [24, 28, 31]));
  assert.equal(result.diagnostics.bassFundamentalHzRange[0] < 35, true);
  assert.ok(result.frames.some((frame) => frame.bassPitchClasses[0]! > 0));
  assert.equal(named(result.events[0]), null);
  assert.ok(result.hypotheses[0]!.candidates[0]!.margin < 0.04);
});

test("stable detuning is estimated cautiously and ambiguous tuning remains unavailable", () => {
  const detuned = analyzeHarmonicCandidate(notes(3, [48, 52, 55], 18));
  const ambiguous = analyzeHarmonicCandidate(notes(0.8, [48], 18));
  assert.ok(detuned.tuning.cents === null || Math.abs(detuned.tuning.cents - 18) < 8, JSON.stringify(detuned.tuning));
  assert.equal(ambiguous.tuning.cents, null);
});

test("weak, near-silent and silent material abstains", () => {
  const silence = analyzeHarmonicCandidate(new Float32Array(RATE * 2));
  const weak = new Float32Array(RATE * 2);
  addNote(weak, 0.1, 1.9, 48, 0.00002);
  const nearSilence = new Float32Array(RATE * 2).fill(1e-11);
  for (const result of [silence, analyzeHarmonicCandidate(weak), analyzeHarmonicCandidate(nearSilence)])
    assert.ok(result.events.every((event) => event.quality === "unknown"));
});

test("broadband attacks are down-weighted and cannot carry a chord through silence", () => {
  const pcm = new Float32Array(RATE * 3);
  let seed = 7;
  for (let i = Math.floor(0.1 * RATE); i < Math.floor(0.13 * RATE); i += 1) {
    seed = (seed * 16807) % 2147483647;
    pcm[i] = ((seed / 2147483647) * 2 - 1) * 0.9;
  }
  const result = analyzeHarmonicCandidate(pcm);
  assert.ok(result.diagnostics.transientFrameCount > 0);
  assert.ok(result.events.every((event) => event.quality === "unknown"));
});

test("adjacent chord changes remain distinct rather than being smoothed away", () => {
  const pcm = new Float32Array(RATE * 2);
  for (const note of [48, 52, 55]) addNote(pcm, 0.02, 0.96, note);
  for (const note of [53, 57, 60]) addNote(pcm, 1.04, 1.98, note);
  const result = analyzeHarmonicCandidate(pcm);
  assert.equal(named(result.events[0]), "C:major");
  assert.equal(named(result.events[1]), "F:major");
});

test("candidate events feed the existing passage scorer without changing its trust boundary", () => {
  const candidate = analyzeHarmonicCandidate(notes(2, [48, 52, 55])).events;
  const wrong: HarmonyEvent[] = candidate.map((event) => ({ ...event, root: "F#", quality: "major" }));
  const vocalFrames = Array.from({ length: 12 }, (_, index) => ({ timestampMs: index * 100,
    frequencyHz: 261.63, midiFloat: 60, nearestMidiNote: 60, confidence: 0.9, voiced: true }));
  const fit = (bedChords: HarmonyEvent[]) => scoreVocalChordToneFit({ vocalFrames, bedChords,
    donorStartMs: 0, donorEndMs: 1_200, bedStartMs: 0, bedEndMs: 2_000, stretchRatio: 1, pitchShiftSemitones: 0 });
  assert.ok(fit(candidate)?.similarity! > fit(wrong)?.similarity!);
  assert.equal(fit(candidate)?.matchedFrames, 12);
});

