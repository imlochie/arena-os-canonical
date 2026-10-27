/**
 * MDX STFT/ISTFT — a faithful TypeScript port of the reference pipeline
 * (audio_separator/separator/uvr_lib_v5/stft.py, read from the real source
 * on 2026-10-09), which itself mirrors torch.stft/torch.istft:
 *
 *   - PERIODIC Hann window (torch.hann_window(periodic=True)):
 *     w[i] = 0.5·(1 − cos(2π·i/n_fft))  — NOT the symmetric np.hanning.
 *   - center=True: the signal is padded n_fft/2 on both sides; frame t
 *     starts at t·hop; frame count = floor(L / hop) + 1.
 *   - The model input layout is [batch, channels·2, dim_f, T]: for each
 *     channel the rfft bins are stacked (real, imag) as two rows of the
 *     second axis, channels merged into that axis — for stereo that is
 *     [L.re, L.im, R.re, R.im] (stft.py: permute + reshape).
 *   - The frequency axis is SLICED to dim_f for the model and ZERO-PADDED
 *     back to n_fft/2+1 for the inverse (stft.py: __call__ / inverse).
 *   - Synthesis is windowed overlap-add divided by the summed squared
 *     window (NOLA), matching torch.istft; the output length of a
 *     T-frame inverse is (T−1)·hop with the center padding stripped.
 */

import { fftInPlace, ifftInPlace } from "./fft";

/** Periodic Hann window of length n (torch.hann_window(periodic=True)). */
export function hannPeriodic(n: number): Float64Array {
  const w = new Float64Array(n);
  for (let i = 0; i < n; i += 1) w[i] = 0.5 * (1 - Math.cos((2 * Math.PI * i) / n));
  return w;
}

/** Symmetric Hann window (numpy.hanning) — used for the DEMIX chunk
 *  overlap-add weighting in mdx.ts, kept here beside its periodic twin so
 *  the two are never confused. */
export function hannSymmetric(n: number): Float64Array {
  const w = new Float64Array(n);
  for (let i = 0; i < n; i += 1) w[i] = 0.5 * (1 - Math.cos((2 * Math.PI * i) / (n - 1)));
  return w;
}

export interface StftConfig {
  nFft: number;
  hop: number;
  /** Model frequency dimension (spectrogram is sliced to this). */
  dimF: number;
}

/** Frame count for a signal of L samples under center=True (torch.stft). */
export function frameCount(L: number, hop: number): number {
  return Math.floor(L / hop) + 1;
}

/**
 * STFT of a mono or stereo (planar) chunk → MDX model layout.
 *
 * Input:  channels[] planar sample arrays, each of length `samples`.
 * Output: { data: Float32Array laid out [channels.length * 2][dimF][T],
 *           frames: T } where row order is ch0.re, ch0.im, ch1.re, ch1.im…
 * (exactly stft.py's permute([0,3,1,2]) + channel-merge reshape).
 */
export function mdxStft(
  channels: Float32Array[],
  cfg: StftConfig,
): { data: Float32Array; frames: number } {
  const nBins = cfg.nFft / 2 + 1;
  if (cfg.dimF > nBins) throw new Error(`dim_f ${cfg.dimF} exceeds the spectrum (${nBins} bins)`);
  const L = channels[0].length;
  const frames = frameCount(L, cfg.hop);
  const rows = channels.length * 2;
  const data = new Float32Array(rows * cfg.dimF * frames);
  const window = hannPeriodic(cfg.nFft);
  const half = cfg.nFft / 2;

  for (let c = 0; c < channels.length; c += 1) {
    const x = channels[c];
    for (let t = 0; t < frames; t += 1) {
      const re = new Float64Array(cfg.nFft);
      const im = new Float64Array(cfg.nFft);
      const start = t * cfg.hop - half; // center=True: frame t centers on t·hop
      for (let i = 0; i < cfg.nFft; i += 1) {
        const idx = start + i;
        re[i] = idx >= 0 && idx < L ? x[idx] * window[i] : 0;
      }
      fftInPlace(re, im);
      const reRow = (c * 2) * cfg.dimF * frames;
      const imRow = (c * 2 + 1) * cfg.dimF * frames;
      for (let f = 0; f < cfg.dimF; f += 1) {
        data[reRow + f * frames + t] = re[f];
        data[imRow + f * frames + t] = im[f];
      }
    }
  }
  return { data, frames };
}

/**
 * Inverse: MDX model-layout spectrogram → planar channels, each of length
 * (T−1)·hop (torch.istft semantics with center=True). Frequency rows beyond
 * the input dim are treated as ZERO, exactly like stft.py's
 * pad_frequency_dimension.
 */
export function mdxIfft(
  data: Float32Array,
  channelsOut: number,
  cfg: StftConfig,
  frames: number,
): Float32Array[] {
  const nBins = cfg.nFft / 2 + 1;
  const window = hannPeriodic(cfg.nFft);
  const outLen = (frames - 1) * cfg.hop;
  const out: Float32Array[] = [];
  const winSum = new Float64Array(outLen + cfg.nFft); // covers padding overhang
  const half = cfg.nFft / 2;

  for (let c = 0; c < channelsOut; c += 1) {
    const acc = new Float64Array(outLen + cfg.nFft);
    for (let t = 0; t < frames; t += 1) {
      const re = new Float64Array(cfg.nFft);
      const im = new Float64Array(cfg.nFft);
      const reRow = (c * 2) * cfg.dimF * frames;
      const imRow = (c * 2 + 1) * cfg.dimF * frames;
      for (let f = 0; f < nBins; f += 1) {
        const vRe = f < cfg.dimF ? data[reRow + f * frames + t] : 0;
        const vIm = f < cfg.dimF ? data[imRow + f * frames + t] : 0;
        re[f] = vRe;
        im[f] = vIm;
        if (f > 0 && f < cfg.nFft / 2) {
          re[cfg.nFft - f] = vRe;
          im[cfg.nFft - f] = -vIm; // conjugate symmetry
        }
      }
      ifftInPlace(re, im);
      const start = t * cfg.hop; // in the PADDED (center) domain
      for (let i = 0; i < cfg.nFft; i += 1) {
        acc[start + i] += re[i] * window[i]; // synthesis window (torch.istft)
        if (c === 0) winSum[start + i] += window[i] * window[i];
      }
    }
    const chan = new Float32Array(outLen);
    for (let i = 0; i < outLen; i += 1) {
      const pos = i + half; // strip the n_fft/2 center padding
      const denom = winSum[pos];
      chan[i] = denom > 1e-12 ? acc[pos] / denom : 0;
    }
    out.push(chan);
  }
  return out;
}
