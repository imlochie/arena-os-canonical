/**
 * STFT/ISTFT correctness — the transforms must round-trip (torch.stft →
 * torch.istft reconstructs the input under NOLA) and produce exactly the
 * reference shapes: T = floor(L/hop)+1 frames, dim_f slicing, [ch·2][F][T]
 * layout, inverse length (T−1)·hop.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { frameCount, hannPeriodic, hannSymmetric, mdxIfft, mdxStft, type StftConfig } from "./stft";

// Kim_Vocal_2 geometry (verified: UVR model_data.json family + MDX Colab).
const KIM: StftConfig = { nFft: 7680, hop: 1024, dimF: 3072 };

function signal(n: number, seed = 12345): Float32Array {
  const x = new Float32Array(n);
  let s = seed;
  for (let i = 0; i < n; i += 1) {
    s ^= s << 13; s ^= s >>> 17; s ^= s << 5;
    x[i] = ((s >>> 0) / 0xffffffff) * 2 - 1;
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

test("windows: periodic hann differs from symmetric hann at the last tap (the reference uses periodic for STFT, symmetric for demix weighting)", () => {
  const n = 16;
  const p = hannPeriodic(n);
  const s = hannSymmetric(n);
  assert.ok(Math.abs(p[0]) < 1e-12);
  assert.ok(Math.abs(s[0]) < 1e-12);
  assert.ok(Math.abs(s[n - 1]) < 1e-12, "symmetric hann ends at zero");
  assert.ok(p[n - 1] > 0, "periodic hann does NOT end at zero");
  assert.ok(Math.abs(p[Math.floor(n / 2)] - 1) < 1e-12, "periodic hann peaks at 1 mid-window");
});

test("frame count matches torch.stft center=True: T = floor(L/hop) + 1", () => {
  assert.equal(frameCount(261120, 1024), 256, "a full Kim chunk is exactly dim_t = 256 frames");
  assert.equal(frameCount(1, 1024), 1);
  assert.equal(frameCount(1024, 1024), 2);
});

// Band-limited noise: energy only in bins below `cutoffBins`, so the dim_f
// slice keeps ALL of it (the property the demix round-trip relies on).
function bandLimitedNoise(n: number, cutoffBins: number, nFft: number, seed = 424242): Float32Array {
  const x = new Float32Array(n);
  let s = seed;
  const rand = () => { s ^= s << 13; s ^= s >>> 17; s ^= s << 5; return (s >>> 0) / 0xffffffff; };
  const partials = 64;
  for (let p = 0; p < partials; p += 1) {
    const bin = Math.floor((p + 0.5) * (cutoffBins / partials)); // strictly below cutoff
    const amp = rand();
    const phase = rand() * 2 * Math.PI;
    for (let i = 0; i < n; i += 1) x[i] += amp * Math.sin((2 * Math.PI * bin * i) / nFft + phase);
  }
  return x;
}

test("stft→istft round-trips a full Kim chunk at full spectrum (NOLA synthesis)", () => {
  const chunk = 261120; // hop·(dim_t−1) — the model's exact chunk size
  const full: StftConfig = { nFft: KIM.nFft, hop: KIM.hop, dimF: KIM.nFft / 2 + 1 };
  const left = signal(chunk);
  const right = signal(chunk, 999);
  const stft = mdxStft([left, right], full);
  assert.equal(stft.frames, 256);
  assert.equal(stft.data.length, 4 * full.dimF * 256, "layout is [ch·2][dim_f][T]");

  const back = mdxIfft(stft.data, 2, full, stft.frames);
  assert.equal(back[0].length, chunk, "inverse length is (T−1)·hop");
  assert.equal(back[1].length, chunk);
  assert.ok(snrDb(back[0], left) > 100, `left SNR ${snrDb(back[0], left).toFixed(1)} dB`);
  assert.ok(snrDb(back[1], right) > 100, `right SNR ${snrDb(back[1], right).toFixed(1)} dB`);
});

test("with the model's dim_f slice, band-limited content round-trips at high SNR (the demix property)", () => {
  const chunk = 261120;
  // Kim: dim_f 3072 of 3841 bins — content below bin 3072 must survive the
  // slice; the reference zero-pads the rest on inverse (stft.py).
  const mono = bandLimitedNoise(chunk, 3000, KIM.nFft);
  const stft = mdxStft([mono], KIM);
  const back = mdxIfft(stft.data, 1, KIM, stft.frames);
  // Measured over the interior, mirroring the reference demix which TRIMS
  // n_fft/2 samples from each end (mdx_separator.py: tar_waves_[:, :, trim:-trim])
  // — the padded edges have a small window-square-sum by construction, and
  // the reference discards exactly those samples.
  const trim = KIM.nFft / 2;
  const interior = (x: Float32Array) => x.subarray(trim, chunk - trim);
  assert.ok(snrDb(interior(back[0]), interior(mono)) > 100, `band-limited SNR ${snrDb(interior(back[0]), interior(mono)).toFixed(1)} dB`);
});

test("round-trip holds for the smaller MDX geometries too (6144, 5120)", () => {
  for (const nFft of [6144, 5120]) {
    const cfg: StftConfig = { nFft, hop: 1024, dimF: nFft / 2 + 1 };
    const chunk = cfg.hop * 255;
    const mono = signal(chunk);
    const stft = mdxStft([mono], cfg);
    const back = mdxIfft(stft.data, 1, cfg, stft.frames);
    assert.ok(snrDb(back[0], mono) > 100, `n_fft ${nFft}: SNR ${snrDb(back[0], mono).toFixed(1)} dB`);
  }
});

test("the [ch·2][F][T] row order is ch0.re, ch0.im, ch1.re, ch1.im", () => {
  // A pure DC-ish constant on the left channel only: bin 0 (real) of ch0
  // rows must carry energy; ch1 rows must be ~zero.
  const left = new Float32Array(4096).fill(0.5);
  const right = new Float32Array(4096);
  const stft = mdxStft([left, right], { nFft: 4096, hop: 1024, dimF: 2049 });
  const T = stft.frames;
  const row = (r: number, f: number, t: number) => stft.data[r * 2049 * T + f * T + t];
  assert.ok(Math.abs(row(0, 0, 0)) > 100, "ch0 real bin 0 carries the DC energy");
  assert.ok(Math.abs(row(1, 0, 0)) < 1e-6, "ch0 imag bin 0 ~ 0 for a real constant");
  assert.ok(Math.abs(row(2, 0, 0)) < 1e-6, "ch1 real bin 0 ~ 0 (silent channel)");
  assert.ok(Math.abs(row(3, 0, 0)) < 1e-6, "ch1 imag bin 0 ~ 0");
});

test("frequency slicing: an above-dim_f tone does not reach the model view (interior frames exact; edge frames leak by center-padding, as in the reference)", () => {
  // n_fft 4096 → 2049 bins; dim_f 1024. An exact-bin tone at 1800 (above the
  // cutoff) vanishes from INTERIOR frames to float dust. The zero-padded edge
  // frames legitimately leak broadband energy (the rect edge of the padding —
  // identical to torch.stft center=True), and the demix trim strips those
  // samples, so the leak never reaches the output.
  const chunk = 1024 * 8;
  const tone = new Float32Array(chunk);
  for (let i = 0; i < chunk; i += 1) tone[i] = Math.sin((2 * Math.PI * 1800 * i) / 4096);
  const stft = mdxStft([tone], { nFft: 4096, hop: 1024, dimF: 1024 });
  const T = stft.frames;
  for (const t of [3, 4, 5]) {
    let energy = 0;
    for (let r = 0; r < 2; r += 1) {
      for (let f = 0; f < 1024; f += 1) {
        const v = stft.data[r * 1024 * T + f * T + t];
        energy += v * v;
      }
    }
    assert.ok(energy < 1e-6, `interior frame ${t}: above-cutoff energy ${energy.toExponential(2)} (expected float dust)`);
  }
});
