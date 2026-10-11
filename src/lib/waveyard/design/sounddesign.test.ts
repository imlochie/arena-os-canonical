/**
 * Sound design tests — every kind must render real, distinct, non-silent
 * audio through the actual engine; transforms are verified at sample
 * level; renders are deterministic; parameter validation is honest.
 */

import test from "node:test";
import assert from "node:assert/strict";

import {
  SOUND_DESIGN_KINDS,
  buildRecipe,
  isSoundDesignKind,
  normaliseSoundDesignParams,
  renderRecipe,
  reverseBuffer,
  stutterBuffer,
  type SoundDesignKind,
} from "./sounddesign";
import { decodeWav16 } from "../mixer/synth";
import { measureAudio } from "../mixer/meters";

const KINDS: SoundDesignKind[] = [...SOUND_DESIGN_KINDS];

test("all 11 kinds are registered and recognised", () => {
  assert.equal(KINDS.length, 11);
  for (const kind of KINDS) assert.ok(isSoundDesignKind(kind));
  assert.equal(isSoundDesignKind("neural-sfx"), false);
  assert.equal(isSoundDesignKind(42), false);
});

test("every kind renders non-silent WAV with the right duration", () => {
  for (const kind of KINDS) {
    const { wav, durationSeconds } = renderRecipe({ kind, lengthSeconds: 2, baseMidi: 45, level: 0.7 });
    const decoded = decodeWav16(new Uint8Array(wav));
    assert.notEqual(decoded, null, `${kind} must decode`);
    const measurements = measureAudio(decoded!.samples, decoded!.sampleRate);
    assert.ok(measurements.peakDb > -40, `${kind} must be audible (peak ${measurements.peakDb} dB)`);
    assert.ok(decoded!.frames > 0);
    assert.equal(wav.length, 44 + decoded!.frames * 2 * 2);
    assert.equal(durationSeconds, 2);
  }
});

test("renders are deterministic — same recipe, identical bytes", () => {
  const first = renderRecipe({ kind: "riser", lengthSeconds: 3, baseMidi: 50, level: 0.6 });
  const second = renderRecipe({ kind: "riser", lengthSeconds: 3, baseMidi: 50, level: 0.6 });
  assert.deepEqual(Buffer.from(first.wav), Buffer.from(second.wav));
});

test("kinds are audibly distinct (different RMS energies)", () => {
  const energies = new Map<string, number>();
  for (const kind of KINDS) {
    const { wav } = renderRecipe({ kind, lengthSeconds: 2, baseMidi: 45, level: 0.7 });
    const decoded = decodeWav16(new Uint8Array(wav))!;
    const measurements = measureAudio(decoded.samples, decoded.sampleRate);
    energies.set(kind, measurements.rmsDb);
  }
  const values = [...energies.values()];
  const spread = Math.max(...values) - Math.min(...values);
  assert.ok(spread > 1, `kinds must differ measurably (spread ${spread.toFixed(2)} dB)`);
});

test("reverse transform is a true sample-level reverse", () => {
  const pcm = new Float32Array([0.1, 0.1, 0.2, 0.2, 0.3, 0.3, 0.4, 0.4]);
  const reversed = reverseBuffer(pcm);
  const expected = new Float32Array([0.4, 0.4, 0.3, 0.3, 0.2, 0.2, 0.1, 0.1]);
  assert.deepEqual([...reversed], [...expected]);
});

test("stutter transform produces hard zero gate segments", () => {
  const pcm = new Float32Array(44100 * 2); // 1 s stereo
  pcm.fill(0.5);
  const chopped = stutterBuffer(pcm, 12);
  let zeros = 0;
  for (let i = 0; i < chopped.length; i += 1) if (chopped[i] === 0) zeros += 1;
  assert.ok(zeros > chopped.length * 0.4, `gate must zero ~half the samples (got ${zeros}/${chopped.length})`);
  assert.ok(zeros < chopped.length * 0.6, "gate must keep ~half the samples");
});

test("the recipe records full provenance for persistence", () => {
  const recipe = buildRecipe("impact", { lengthSeconds: 1.5, baseMidi: 33, level: 0.8 });
  assert.equal(recipe.format, "waveyard-sound-design-v1");
  assert.equal(recipe.kind, "impact");
  assert.equal(recipe.instrument, "sub-bass");
  assert.ok(recipe.events.length > 0);
  assert.ok(recipe.chain.some((stage) => stage.processor === "softclip"));
  const json = JSON.parse(JSON.stringify(recipe));
  assert.equal(json.params.baseMidi, 33);
});

test("parameter validation clamps into the real ranges and rejects garbage", () => {
  const clamped = normaliseSoundDesignParams({ lengthSeconds: 999, baseMidi: -5, level: 42 });
  assert.deepEqual(clamped, { lengthSeconds: 16, baseMidi: 24, level: 1 });
  const defaults = normaliseSoundDesignParams(undefined);
  assert.deepEqual(defaults, { lengthSeconds: 4, baseMidi: 45, level: 0.7 });
  assert.equal(normaliseSoundDesignParams({ lengthSeconds: "abc" }), null);
  assert.equal(normaliseSoundDesignParams({ baseMidi: Number.NaN }), null);
});
