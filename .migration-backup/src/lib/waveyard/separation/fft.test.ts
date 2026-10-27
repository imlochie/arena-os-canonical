/**
 * FFT correctness — the fast path is proven against a naive DFT, on sizes
 * that cover every real MDX n_fft factorization (docs/waveyard-vision.md:
 * "verified from the real files, not from memory").
 */

import assert from "node:assert/strict";
import test from "node:test";

import { fftInPlace, ifftInPlace, naiveDft } from "./fft";

function randomSignal(n: number): { re: Float64Array; im: Float64Array } {
  const re = new Float64Array(n);
  const im = new Float64Array(n);
  let seed = 0x2f6e2b1;
  const rand = () => {
    // xorshift — deterministic test noise
    seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5;
    return ((seed >>> 0) / 0xffffffff) * 2 - 1;
  };
  for (let i = 0; i < n; i += 1) {
    re[i] = rand();
    im[i] = rand();
  }
  return { re, im };
}

function assertClose(a: Float64Array, b: Float64Array, tol: number, label: string) {
  assert.equal(a.length, b.length, `${label}: lengths`);
  let maxErr = 0;
  for (let i = 0; i < a.length; i += 1) maxErr = Math.max(maxErr, Math.abs(a[i] - b[i]));
  assert.ok(maxErr < tol, `${label}: max error ${maxErr.toExponential(3)} >= ${tol}`);
}

test("mixed-radix FFT matches the naive DFT across every MDX factorization shape", () => {
  // 2^k (8192, 4096), 2^k·3 (6144), 2^k·5 (5120), 2^9·3·5 (7680 — Kim family),
  // plus small odd composites (15, 45) and a prime (7 → naive fallback).
  for (const n of [7, 8, 12, 15, 30, 45, 240, 512, 640, 1536]) {
    const signal = randomSignal(n);
    const expected = naiveDft(signal);
    const re = Float64Array.from(signal.re);
    const im = Float64Array.from(signal.im);
    fftInPlace(re, im);
    const tol = 1e-9 * n * 4;
    assertClose(re, expected.re, tol, `fft(${n}).re`);
    assertClose(im, expected.im, tol, `fft(${n}).im`);
  }
});

test("the real MDX sizes are exact against the naive DFT (7680, 6144, 5120)", () => {
  for (const n of [5120, 6144, 7680]) {
    const signal = randomSignal(n);
    const expected = naiveDft(signal);
    const re = Float64Array.from(signal.re);
    const im = Float64Array.from(signal.im);
    fftInPlace(re, im);
    // Naive summation accumulates its own error; tolerance reflects that.
    const tol = 1e-8 * n;
    assertClose(re, expected.re, tol, `fft(${n}).re`);
    assertClose(im, expected.im, tol, `fft(${n}).im`);
  }
});

test("ifft inverts fft exactly (round-trip to machine precision)", () => {
  for (const n of [15, 240, 7680]) {
    const signal = randomSignal(n);
    const re = Float64Array.from(signal.re);
    const im = Float64Array.from(signal.im);
    fftInPlace(re, im);
    ifftInPlace(re, im);
    assertClose(re, signal.re, 1e-10, `ifft(fft(${n})).re`);
    assertClose(im, signal.im, 1e-10, `ifft(fft(${n})).im`);
  }
});
