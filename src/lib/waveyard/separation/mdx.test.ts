/**
 * MDX demix engine tests — the chunked overlap-add pipeline is proven with
 * an INJECTED identity inference (no model weights): if the model returns
 * its input spectrum unchanged, the pipeline must reconstruct the input
 * (below dim_f, above bin 3 — the two places the reference deliberately
 * removes content). Chunk geometry, progress, normalization, secondary-stem
 * arithmetic, and edge cases are all direct assertions.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { chunkGeometry, demixMdx, findMdxModel, normalizePeak, type MdxInfer } from "./mdx";
import { mdxIfft, mdxStft } from "./stft";

const KIM = findMdxModel("kim_vocal_2")!;

/** Identity inference: returns the input spectrum unchanged (a perfect
 *  "model" — lets us verify the surrounding math in isolation). */
const identityInfer: MdxInfer = async (spek) => spek;

function bandLimitedNoise(n: number, cutoffBins: number, nFft: number, seed = 777): Float32Array {
  const x = new Float32Array(n);
  let s = seed;
  const rand = () => { s ^= s << 13; s ^= s >>> 17; s ^= s << 5; return (s >>> 0) / 0xffffffff; };
  for (let p = 0; p < 48; p += 1) {
    const bin = 20 + Math.floor(rand() * (cutoffBins - 40)); // strictly interior partials
    const amp = rand();
    const phase = rand() * 2 * Math.PI;
    for (let i = 0; i < n; i += 1) x[i] += amp * Math.sin((2 * Math.PI * bin * i) / nFft + phase);
  }
  return x;
}

function snrDb(a: Float32Array, b: Float32Array): number {
  let err = 0;
  let ref = 0;
  for (let i = 0; i < a.length; i += 1) {
    const d = a[i] - b[i];
    err += d * d;
    ref += b[i] * b[i];
  }
  return 10 * Math.log10(ref / Math.max(err, 1e-30));
}

test("registry: Kim Vocal 2 carries the verified geometry and checksum", () => {
  assert.equal(KIM.params.nFft, 7680);
  assert.equal(KIM.params.dimF, 3072);
  assert.equal(KIM.params.dimT, 256);
  assert.equal(KIM.params.hop, 1024);
  assert.match(KIM.sha256, /^[0-9a-f]{64}$/);
  assert.equal(KIM.primaryStem, "vocals");
  assert.equal(KIM.secondaryStem, "instrumental");
  assert.ok(findMdxModel("Kim_Vocal_2.onnx") === KIM, "lookup works by filename too");
});

test("chunk geometry matches the reference formulas (Kim)", () => {
  const g = chunkGeometry(KIM.params);
  assert.equal(g.chunk, 1024 * 255, "chunk = hop·(dim_t−1)");
  assert.equal(g.trim, 3840, "trim = n_fft/2");
  assert.equal(g.gen, 1024 * 255 - 7680, "gen = chunk − 2·trim");
  assert.equal(g.step, Math.floor(0.75 * g.chunk), "step = (1−overlap)·chunk");
  // A full chunk is exactly dim_t STFT frames (why the ONNX path works).
  assert.equal(Math.floor(g.chunk / 1024) + 1, 256);
});

test("identity inference reconstructs the mix: primary ≈ input (below dim_f, above bin 3), secondary ≈ (1−compensate)·input", async () => {
  const n = 261120 * 2; // two full chunks
  const left = bandLimitedNoise(n, 2800, 7680);
  const right = bandLimitedNoise(n, 2800, 7680, 4242);

  const stems = await demixMdx([left, right], KIM, identityInfer);

  assert.equal(stems.sampleCount, n);
  assert.equal(stems.primary[0].length, n);
  // Interior only: the pipeline trims n_fft/2 at each end (and our input is
  // band-limited below dim_f, avoiding the reference's deliberate dim_f cut).
  const trim = 3840;
  const interior = (x: Float32Array) => x.subarray(trim, n - trim);
  const snrL = snrDb(interior(stems.primary[0]), interior(left));
  const snrR = snrDb(interior(stems.primary[1]), interior(right));
  assert.ok(snrL > 60, `primary left SNR ${snrL.toFixed(1)} dB (identity model must reconstruct)`);
  assert.ok(snrR > 60, `primary right SNR ${snrR.toFixed(1)} dB`);

  // Secondary = mix − primary·compensate, with primary ≈ mix:
  // ≈ (1 − compensate)·mix. Assert the exact arithmetic instead of an SNR:
  for (const i of [trim + 1000, Math.floor(n / 2), n - trim - 1000]) {
    const expectedL = left[i] - stems.primary[0][i] * KIM.params.compensate;
    assert.ok(Math.abs(stems.secondary[0][i] - expectedL) < 1e-5, `secondary arithmetic at ${i}`);
  }
  // And at compensate = 1, stems sum back to the mix exactly (the property
  // the player's stem mixing relies on) — verified via a spec clone.
  const unitComp = { ...KIM, params: { ...KIM.params, compensate: 1 } };
  const sum = await demixMdx([left, right], unitComp, identityInfer);
  for (const i of [trim + 1000, Math.floor(n / 2), n - trim - 1000]) {
    assert.ok(Math.abs(sum.primary[0][i] + sum.secondary[0][i] - left[i]) < 1e-5, `stems sum to the mix at ${i}`);
  }
});

test("a NON-identity model flows through: 6 dB-attenuated inference yields an attenuated primary", async () => {
  const n = 261120;
  const left = bandLimitedNoise(n, 2800, 7680, 31337);
  const right = bandLimitedNoise(n, 2800, 7680, 9911);
  const halfInfer: MdxInfer = async (spek) => {
    const out = Float32Array.from(spek, (v) => v * 0.5);
    return out;
  };
  const stems = await demixMdx([left, right], { ...KIM, params: { ...KIM.params, compensate: 1 } }, halfInfer);
  const trim = 3840;
  const interior = (x: Float32Array) => x.subarray(trim, n - trim);
  const snrL = snrDb(interior(stems.primary[0]), interior(Float32Array.from(left, (v) => v * 0.5)));
  assert.ok(snrL > 60, `attenuated primary SNR ${snrL.toFixed(1)} dB`);
  // compensate 1: primary + secondary = mix even for a non-identity model.
  for (const i of [trim + 1000, Math.floor(n / 2)]) {
    assert.ok(Math.abs(stems.primary[0][i] + stems.secondary[0][i] - left[i]) < 1e-4, `sum property at ${i}`);
  }
});

test("normalization mirrors spec_utils.normalize: loud input scaled to 0.9 with the gain reported; quiet input untouched", () => {
  const loud = [Float32Array.from([1.5, -2.0, 0.75, -0.1])];
  const { channels, gain } = normalizePeak(loud);
  assert.ok(Math.abs(gain - 0.45) < 1e-6, `gain 0.9/2.0, got ${gain}`);
  let max = 0;
  for (const v of channels[0]) max = Math.max(max, Math.abs(v));
  assert.ok(Math.abs(max - 0.9) < 1e-6, `scaled to 0.9, got ${max}`);
  const quiet = [Float32Array.from([0.3, -0.2])];
  const q = normalizePeak(quiet);
  assert.ok(q.channels[0] === quiet[0], "quiet input passes through untouched");
  assert.equal(q.gain, 1, "quiet input has unit gain — restored 1:1 (unlike the reference's material-dependent * peak)");
  assert.throws(() => normalizePeak([Float32Array.from([0, 0])]), /silence/);
  assert.throws(() => normalizePeak([Float32Array.from([1, NaN])]), /non-finite/);
  assert.throws(() => normalizePeak([Float32Array.from([1, Infinity])]), /non-finite/);
});

test("loud mixes return at ORIGINAL scale: normalization is fully inverted", async () => {
  // This is the regression test for the 0.9× bug: an identity model must
  // reconstruct a loud input at unity, not at 0.9× (20 dB SNR signature).
  const n = 261120;
  const left = bandLimitedNoise(n, 2800, 7680, 5); // peak >> 0.9
  const right = bandLimitedNoise(n, 2800, 7680, 6);
  const { gain } = normalizePeak([left, right]);
  assert.ok(gain < 1, "input is loud enough to trigger attenuation");
  const stems = await demixMdx([left, right], KIM, identityInfer);
  const trim = 3840;
  const interior = (x: Float32Array) => x.subarray(trim, n - trim);
  const snrL = snrDb(interior(stems.primary[0]), interior(left));
  assert.ok(snrL > 60, `loud mix restored to original scale, got ${snrL.toFixed(1)} dB`);
  // And the stems sum back to the ORIGINAL mix at compensate = 1.
  const unitComp = { ...KIM, params: { ...KIM.params, compensate: 1 } };
  const sum = await demixMdx([left, right], unitComp, identityInfer);
  for (const i of [trim + 1000, Math.floor(n / 2), n - trim - 1000]) {
    assert.ok(Math.abs(sum.primary[0][i] + sum.secondary[0][i] - left[i]) < 1e-4, `original-scale sum at ${i}`);
  }
});

test("overlap=0 uses no window (reference semantics): chunks concatenate without hann weighting", async () => {
  // With overlap 0 the reference adds tar_waves unweighted (divider += 1),
  // so chunk boundaries are NOT zeroed by a window — reconstruction holds
  // right up to the boundaries themselves.
  const n = 261120 * 2;
  const left = bandLimitedNoise(n, 2800, 7680, 88);
  const right = bandLimitedNoise(n, 2800, 7680, 89);
  const noOverlap = { ...KIM, params: { ...KIM.params, overlap: 0 } };
  const stems = await demixMdx([left, right], noOverlap, identityInfer);
  const trim = 3840;
  const interior = (x: Float32Array) => x.subarray(trim, n - trim);
  assert.ok(snrDb(interior(stems.primary[0]), interior(left)) > 60, "overlap=0 primary reconstructs (no window zeroing)");
});

test("progress reports are monotonic and reach the stated total", async () => {
  const n = 261120 * 3 + 12345; // non-multiple length exercises the pad path
  const left = bandLimitedNoise(n, 2800, 7680);
  const right = bandLimitedNoise(n, 2800, 7680, 5150);
  const seen: Array<[number, number]> = [];
  await demixMdx([left, right], KIM, identityInfer, (done, total) => seen.push([done, total]));
  assert.ok(seen.length >= 3, "multiple chunks reported");
  for (let i = 0; i < seen.length; i += 1) {
    assert.ok(seen[i][0] === i + 1, "done increments by one");
    assert.ok(seen[i][1] >= seen[i][0], "never exceeds total");
  }
  const [lastDone, lastTotal] = seen[seen.length - 1];
  assert.equal(lastDone, lastTotal, "finishes at the total");
});

test("short inputs (shorter than one chunk) still separate honestly", async () => {
  const n = 20000; // well under one chunk — exercises heavy padding
  const left = bandLimitedNoise(n, 2800, 7680, 6161);
  const right = bandLimitedNoise(n, 2800, 7680, 6262);
  const stems = await demixMdx([left, right], KIM, identityInfer);
  assert.equal(stems.sampleCount, n);
  // Interior reconstruction still holds (trim both ends).
  const trim = 3840;
  const interior = (x: Float32Array) => x.subarray(trim, n - trim);
  assert.ok(snrDb(interior(stems.primary[0]), interior(left)) > 60, "short-input primary reconstructs");
});

test("the first three frequency bins never reach the model", async () => {
  // Instrument the infer seam: if any of bins 0–2 is nonzero, fail.
  const probeInfer: MdxInfer = async (spek, cfg, frames) => {
    for (let r = 0; r < 4; r += 1) {
      for (let f = 0; f < 3; f += 1) {
        for (let t = 0; t < frames; t += 1) {
          assert.ok(spek[r * cfg.dimF * frames + f * frames + t] === 0, `bin ${f} row ${r} must be zeroed`);
        }
      }
    }
    return spek;
  };
  const left = bandLimitedNoise(261120, 2800, 7680, 1717);
  const right = bandLimitedNoise(261120, 2800, 7680, 1818);
  await demixMdx([left, right], KIM, probeInfer);
});
