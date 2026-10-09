/**
 * MDX-Net separation engine — a faithful TypeScript port of the reference
 * demix (audio_separator …/architectures/mdx_separator.py, read from the
 * real source 2026-10-09), parameterized per model and fully testable via
 * an injected inference function (no model weights needed for the math).
 *
 * Pipeline (mirrors the reference exactly):
 *   1. Peak-normalize (peak > 0.9 → scale to 0.9; remember peak).
 *   2. Pad [zeros(trim) | mix | zeros(pad)], trim = n_fft/2,
 *      pad = gen_size + trim − (L mod gen_size),
 *      chunk = hop·(dim_t−1), gen = chunk − 2·trim,
 *      step = (1 − overlap)·chunk.
 *   3. Per chunk (zero-padded to full chunk): STFT → zero frequency bins
 *      0–2 → model → ISTFT → multiply by a SYMMETRIC hann window, add into
 *      result/divider accumulators.
 *   4. result/divider, strip trim at both ends, truncate to L.
 *   5. primary = result·(1/gain); secondary = mix_original − primary·compensate.
 *
 * Documented deviations from the reference (verified against
 * mdx_separator.py main, 2026-10-09, lines read verbatim):
 *   - Scale: the reference computes `peak = |mix|.max(); mix = normalize(mix,
 *     0.9); source = demix(mix) * peak`, so a loud mix (peak>0.9) yields a
 *     primary at 0.9× the original scale while its secondary
 *     `(-primary*compensate) + mix.T` uses the NORMALIZED mix — two stems at
 *     different, material-dependent scales. We instead track the applied
 *     normalization gain and invert it, so BOTH stems return in the
 *     original scale and sum back to the source at compensate=1 (the
 *     property the player's stem mixing relies on). Flagged for the
 *     owner-machine parity check against UVR output.
 *   - Tail-chunk window: np.hanning(chunk_size_actual) recomputed on the
 *     actual (possibly shorter) length — implemented identically here.
 */

import { hannSymmetric, mdxIfft, mdxStft, type StftConfig } from "./stft";

export interface MdxModelParams {
  /** FFT size (Kim family 7680; kuielab 6144; Karaoke 2 5120). */
  nFft: number;
  /** Model frequency dimension (spectrum sliced to this). */
  dimF: number;
  /** Model time dimension: 2^mdx_dim_t_set (frames per chunk). */
  dimT: number;
  /** STFT hop (reference default 1024). */
  hop: number;
  /** Secondary-stem inversion gain (per-model, from UVR model_data). */
  compensate: number;
  /** Chunk overlap fraction (reference default 0.25). */
  overlap: number;
}

export interface MdxModelSpec {
  id: string;
  /** ONNX filename as seeded on disk. */
  file: string;
  /** sha256 of the exact file (checksum-verified seeding). */
  sha256: string;
  sizeBytes: number;
  /** Primary stem the model predicts; secondary is mix − primary·compensate. */
  primaryStem: string;
  secondaryStem: string;
  params: MdxModelParams;
  /** Where the file is fetched from on first use (checksum-verified). */
  sourceUrl: string;
  /** Redistribution status — decides bundled vs seeded (vision doc §V1). */
  license: string;
}

/**
 * The model registry. Parameters are verified facts (UVR model_data.json
 * family table + the MDX Colab geometry list + audio-separator defaults),
 * NOT memory: Kim Vocal 2 → n_fft 7680, dim_f 3072, dim_t 2^8, primary
 * Vocals. The compensate value is the community-cited 1.021 for this
 * model — at load time the engine prefers parameters embedded in the ONNX
 * file's metadata when present (see engine.ts), and the first owner-machine
 * run records which source authored the parameters.
 */
export const MDX_MODELS: MdxModelSpec[] = [
  {
    id: "kim_vocal_2",
    file: "Kim_Vocal_2.onnx",
    sha256: "ce74ef3b6a6024ce44211a07be9cf8bc6d87728cc852a68ab34eb8e58cde9c8b",
    sizeBytes: 66_800_000,
    primaryStem: "vocals",
    secondaryStem: "instrumental",
    params: { nFft: 7680, dimF: 3072, dimT: 256, hop: 1024, compensate: 1.021, overlap: 0.25 },
    sourceUrl: "https://huggingface.co/Politrees/UVR_resources/resolve/main/models/MDXNet/Kim_Vocal_2.onnx",
    license: "verify-before-bundling (UVR/MDX-Net community model; seed fallback if redistribution is unclear)",
  },
];

export function findMdxModel(idOrFile: string): MdxModelSpec | undefined {
  return MDX_MODELS.find((m) => m.id === idOrFile || m.file === idOrFile);
}

/** The inference seam: one batch, [rows=ch·2][dim_f][dim_t] in, same out.
 *  Production = the ONNX session (engine.ts); tests inject a fake. */
export type MdxInfer = (spek: Float32Array, cfg: StftConfig, frames: number) => Promise<Float32Array>;

export type ProgressFn = (done: number, total: number) => void;

export interface SeparatedStems {
  /** Planar stereo [-1, 1], original (pre-normalization) scale. */
  primary: Float32Array[];
  secondary: Float32Array[];
  sampleCount: number;
  modelId: string;
  /** Which parameters actually ran (registry spec or ONNX-embedded). */
  paramSource: "registry" | "model-metadata";
}

/** Peak normalization exactly as spec_utils.normalize (attenuate above
 *  maxPeak; the reference's amplification threshold defaults to 0 and never
 *  triggers). Returns the GAIN APPLIED (1.0 when untouched) so the caller
 *  can restore the original scale exactly — see header for why we invert it
 *  instead of following the reference's `* peak`. */
export function normalizePeak(
  channels: Float32Array[],
  maxPeak = 0.9,
): { channels: Float32Array[]; gain: number } {
  let peak = 0;
  for (const ch of channels) {
    for (let i = 0; i < ch.length; i += 1) {
      const v = ch[i];
      if (!Number.isFinite(v)) throw new Error("audio contains non-finite samples — refusing to separate");
      const a = Math.abs(v);
      if (a > peak) peak = a;
    }
  }
  if (peak === 0) throw new Error("audio is digital silence — nothing to separate");
  if (peak > maxPeak) {
    const gain = maxPeak / peak;
    return {
      channels: channels.map((ch) => Float32Array.from(ch, (v) => v * gain)),
      gain,
    };
  }
  return { channels, gain: 1 };
}

/** Chunk geometry for a model (the reference's initialize_model_settings). */
export function chunkGeometry(p: MdxModelParams): { chunk: number; trim: number; gen: number; step: number } {
  const trim = p.nFft / 2;
  const chunk = p.hop * (p.dimT - 1);
  const gen = chunk - 2 * trim;
  const step = Math.floor((1 - p.overlap) * chunk);
  return { chunk, trim, gen, step };
}

/**
 * Separate a stereo mix into primary + secondary stems.
 * `mix` is planar stereo at 44.1 kHz (the reference's fixed sample rate).
 */
export async function demixMdx(
  mix: Float32Array[],
  spec: MdxModelSpec,
  infer: MdxInfer,
  onProgress?: ProgressFn,
): Promise<SeparatedStems> {
  const p = spec.params;
  const cfg: StftConfig = { nFft: p.nFft, hop: p.hop, dimF: p.dimF };
  const { chunk, trim, gen, step } = chunkGeometry(p);
  if (gen <= 0) throw new Error(`model ${spec.id}: non-positive gen size (n_fft ${p.nFft} vs chunk ${chunk})`);

  const { channels: norm, gain } = normalizePeak(mix);
  const L = norm[0].length;
  const left = norm[0];
  const right = norm[1];

  // Reference demix(): pad = gen + trim − (L mod gen)
  const pad = gen + trim - (L % gen);
  const paddedLen = L + trim + pad;
  const pLeft = new Float32Array(paddedLen);
  const pRight = new Float32Array(paddedLen);
  pLeft.set(left, trim);
  pRight.set(right, trim);

  const resultL = new Float64Array(paddedLen);
  const resultR = new Float64Array(paddedLen);
  const divider = new Float64Array(paddedLen);
  // Reference: window applied only when overlap != 0, recomputed on the
  // ACTUAL chunk length (np.hanning(chunk_size_actual)) — a shorter tail
  // chunk gets a shorter window, not a truncation of the full one.
  const useWindow = p.overlap !== 0;
  const windowFull = useWindow ? hannSymmetric(chunk) : null;

  // Reference: total_chunks = (len + step − 1) // step, loop range(0, len, step).
  const total = Math.ceil(paddedLen / step);
  let done = 0;

  for (let start = 0; start < paddedLen; start += step) {
    const end = Math.min(start + chunk, paddedLen);
    const actual = end - start;

    // Zero-pad the tail chunk to full chunk length (reference behavior) so
    // the model always sees dim_t frames.
    const cL = new Float32Array(chunk);
    const cR = new Float32Array(chunk);
    cL.set(pLeft.subarray(start, end));
    cR.set(pRight.subarray(start, end));

    const stft = mdxStft([cL, cR], cfg);
    // Zero the first three frequency bins (reference: spek[:, :, :3, :] *= 0).
    const rows = 4;
    for (let r = 0; r < rows; r += 1) {
      const base = r * p.dimF * stft.frames;
      for (let f = 0; f < 3 && f < p.dimF; f += 1) {
        for (let t = 0; t < stft.frames; t += 1) stft.data[base + f * stft.frames + t] = 0;
      }
    }

    const pred = await infer(stft.data, cfg, stft.frames);
    const out = mdxIfft(pred, 2, cfg, stft.frames);

    // Weighted overlap-add (reference demix()): windowed when overlapping,
    // plain accumulation when overlap == 0 (divider += 1, no window).
    if (useWindow) {
      const w = actual === chunk ? windowFull! : hannSymmetric(actual);
      for (let i = 0; i < actual; i += 1) {
        const wi = w[i];
        resultL[start + i] += out[0][i] * wi;
        resultR[start + i] += out[1][i] * wi;
        divider[start + i] += wi;
      }
    } else {
      for (let i = 0; i < actual; i += 1) {
        resultL[start + i] += out[0][i];
        resultR[start + i] += out[1][i];
        divider[start + i] += 1;
      }
    }
    done += 1;
    onProgress?.(done, total);
  }

  const restore = 1 / gain;
  const primaryL = new Float32Array(L);
  const primaryR = new Float32Array(L);
  const secondaryL = new Float32Array(L);
  const secondaryR = new Float32Array(L);
  const comp = p.compensate;
  for (let i = 0; i < L; i += 1) {
    const pos = i + trim;
    const d = divider[pos];
    const vL = (d > 0 ? resultL[pos] / d : 0) * restore;
    const vR = (d > 0 ? resultR[pos] / d : 0) * restore;
    primaryL[i] = vL;
    primaryR[i] = vR;
    // Both stems in ORIGINAL scale (documented deviation — see header):
    // stems sum back to the mix at compensate = 1, whatever the loudness.
    secondaryL[i] = mix[0][i] - vL * comp;
    secondaryR[i] = mix[1][i] - vR * comp;
  }

  return {
    primary: [primaryL, primaryR],
    secondary: [secondaryL, secondaryR],
    sampleCount: L,
    modelId: spec.id,
    paramSource: "registry",
  };
}
