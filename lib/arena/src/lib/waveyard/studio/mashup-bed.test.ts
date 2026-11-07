import test from "node:test";
import assert from "node:assert/strict";

import {
  INSTRUMENTAL_BED_STEM_TYPES,
  InstrumentalBedError,
  MASHUP_BED_HEADROOM_GAIN,
  MASHUP_BED_PEAK_CEILING,
  sumInstrumentalStems,
  type InstrumentalBedStem,
} from "./mashup-bed";

const RATE = 44_100;
const SECONDS = 1;
const FRAMES = RATE * SECONDS;

function toneStem(
  stemType: string,
  frequency: number,
  amplitude = 0.3,
  overrides: Partial<InstrumentalBedStem> = {},
): InstrumentalBedStem {
  const samples = new Float32Array(FRAMES * 2);
  for (let frame = 0; frame < FRAMES; frame += 1) {
    const value = Math.sin((2 * Math.PI * frequency * frame) / RATE) * amplitude;
    samples[frame * 2] = value;
    samples[frame * 2 + 1] = value;
  }
  return {
    stemType,
    sourceAssetId: "source-bed",
    separationJobId: "job-bed",
    startMs: 0,
    sampleRate: RATE,
    channels: 2,
    frames: FRAMES,
    samples,
    ...overrides,
  };
}

/** Goertzel-ish energy at a frequency, measured on the left channel. */
function energyAt(pcm: Float32Array, frequency: number, sampleRate = RATE): number {
  let real = 0;
  let imaginary = 0;
  const frames = Math.floor(pcm.length / 2);
  for (let frame = 0; frame < frames; frame += 1) {
    const sample = pcm[frame * 2]!;
    const phase = (2 * Math.PI * frequency * frame) / sampleRate;
    real += sample * Math.cos(phase);
    imaginary += sample * Math.sin(phase);
  }
  return Math.hypot(real, imaginary) / frames;
}

function errorFor(fn: () => unknown): InstrumentalBedError {
  try {
    fn();
  } catch (error) {
    assert.ok(error instanceof InstrumentalBedError, `expected InstrumentalBedError, got ${String(error)}`);
    return error;
  }
  throw new Error("expected the helper to throw");
}

test("selects non-vocal stems, excludes vocals, and preserves the bed tones", () => {
  const bed = sumInstrumentalStems([
    toneStem("vocals", 880),
    toneStem("drums", 110),
    toneStem("bass", 220),
    toneStem("other", 330),
  ]);

  assert.deepEqual(bed.includedStemTypes, ["drums", "bass", "other"]);
  assert.deepEqual(bed.excludedStemTypes, ["vocals"]);
  assert.equal(bed.sampleRate, RATE);
  assert.equal(bed.channels, 2);
  assert.equal(bed.frames, FRAMES);
  assert.equal(bed.pcm.length, FRAMES * 2);

  const drums = energyAt(bed.pcm, 110);
  const bass = energyAt(bed.pcm, 220);
  const other = energyAt(bed.pcm, 330);
  const vocal = energyAt(bed.pcm, 880);

  assert.ok(drums > 0.01, `drums energy ${drums}`);
  assert.ok(bass > 0.01, `bass energy ${bass}`);
  assert.ok(other > 0.01, `other energy ${other}`);
  assert.ok(vocal < 1e-6, `vocal energy ${vocal} should be zero after exclusion`);
});

test("includes deep six-stem instruments and still excludes vocals", () => {
  const bed = sumInstrumentalStems([
    toneStem("vocals", 880),
    toneStem("drums", 110),
    toneStem("bass", 220),
    toneStem("guitar", 330),
    toneStem("piano", 440),
    toneStem("other", 550),
  ]);

  assert.deepEqual(bed.includedStemTypes, ["drums", "bass", "guitar", "piano", "other"]);
  assert.deepEqual(bed.excludedStemTypes, ["vocals"]);
  assert.ok(energyAt(bed.pcm, 330) > 0.01);
  assert.ok(energyAt(bed.pcm, 440) > 0.01);
  assert.ok(energyAt(bed.pcm, 880) < 1e-6);
});

test("refuses to combine stems from different separation runs", () => {
  const error = errorFor(() =>
    sumInstrumentalStems([
      toneStem("drums", 110, 0.3, { separationJobId: "job-a" }),
      toneStem("bass", 220, 0.3, { separationJobId: "job-b" }),
    ]),
  );
  assert.equal(error.code, "provenance-mismatch");
});

test("refuses to combine stems from different source tracks", () => {
  const error = errorFor(() =>
    sumInstrumentalStems([
      toneStem("drums", 110, 0.3, { sourceAssetId: "source-a" }),
      toneStem("bass", 220, 0.3, { sourceAssetId: "source-b" }),
    ]),
  );
  assert.equal(error.code, "provenance-mismatch");
});

test("refuses exact-alignment mismatches instead of silently summing", () => {
  const base = toneStem("drums", 110);
  const cases: Array<[string, Partial<InstrumentalBedStem>]> = [
    ["sample rate", { sampleRate: 48_000 }],
    ["channel layout", { channels: 1 }],
    ["sample count", { frames: FRAMES - 1 }],
    ["start offset", { startMs: 128 }],
  ];
  for (const [label, override] of cases) {
    const error = errorFor(() =>
      sumInstrumentalStems([base, toneStem("bass", 220, 0.3, override)]),
    );
    assert.equal(error.code, "alignment-mismatch", `${label} must be rejected`);
  }
});

test("applies headroom and scales down a hot sum instead of clipping", () => {
  const bed = sumInstrumentalStems([
    toneStem("drums", 220, 1),
    toneStem("bass", 220, 1),
    toneStem("other", 220, 1),
  ]);

  assert.ok(bed.appliedGain < MASHUP_BED_HEADROOM_GAIN, "a hot sum must be scaled below the nominal headroom gain");
  assert.ok(bed.peak <= MASHUP_BED_PEAK_CEILING + 1e-9, `peak ${bed.peak} must stay under the ceiling`);
  for (const sample of bed.pcm) {
    assert.ok(Math.abs(sample) <= 1, "the synthesized bed must never exceed full scale");
  }
});

test("rejects a run with no instrumental stems", () => {
  const error = errorFor(() => sumInstrumentalStems([toneStem("vocals", 880)]));
  assert.equal(error.code, "no-instrumental-stems");
});

test("rejects an empty stem set", () => {
  const error = errorFor(() => sumInstrumentalStems([]));
  assert.equal(error.code, "no-stems");
});

test("the supported bed stem types are explicit and non-vocal", () => {
  assert.ok(INSTRUMENTAL_BED_STEM_TYPES.includes("drums"));
  assert.ok(INSTRUMENTAL_BED_STEM_TYPES.includes("bass"));
  assert.ok(INSTRUMENTAL_BED_STEM_TYPES.includes("other"));
  assert.ok(!INSTRUMENTAL_BED_STEM_TYPES.includes("vocals"));
  assert.ok(!INSTRUMENTAL_BED_STEM_TYPES.includes("instrumental"));
});
