/**
 * Mixed-radix FFT for the MDX separation engine (docs/waveyard-vision.md V1).
 *
 * MDX-Net STFT sizes are NOT powers of two (Kim-family n_fft = 7680 =
 * 2^9·3·5; others 6144 = 2^11·3, 5120 = 2^10·5, 8192, 4096…), so a
 * radix-2-only FFT cannot serve them. This is a recursive Cooley–Tukey
 * decomposition over the SMALLEST prime factor at each level (radices
 * 2/3/5 cover every MDX n_fft); prime sizes fall back to a naive DFT
 * (correct, slow — never hit by real models).
 *
 * Correctness is proven against a naive DFT in fft.test.ts across
 * composite sizes (including 7680 itself) — this file is math, not vibes.
 */

export type ComplexArray = { re: Float64Array; im: Float64Array };

/** Naive O(n²) DFT — the reference the fast path is tested against. */
export function naiveDft(input: ComplexArray): ComplexArray {
  const n = input.re.length;
  const out: ComplexArray = { re: new Float64Array(n), im: new Float64Array(n) };
  for (let k = 0; k < n; k += 1) {
    let sumRe = 0;
    let sumIm = 0;
    for (let t = 0; t < n; t += 1) {
      const angle = (-2 * Math.PI * k * t) / n;
      const cos = Math.cos(angle);
      const sin = Math.sin(angle);
      sumRe += input.re[t] * cos - input.im[t] * sin;
      sumIm += input.re[t] * sin + input.im[t] * cos;
    }
    out.re[k] = sumRe;
    out.im[k] = sumIm;
  }
  return out;
}

function smallestPrimeFactor(n: number): number {
  if (n % 2 === 0) return 2;
  for (let f = 3; f * f <= n; f += 2) {
    if (n % f === 0) return f;
  }
  return n; // prime
}

/** In-place recursive mixed-radix Cooley–Tukey FFT on strided data.
 *  Transform length n, first element at `off`, consecutive elements
 *  `stride` apart. */
function fftStrided(re: Float64Array, im: Float64Array, n: number, off: number, stride: number): void {
  if (n <= 1) return;
  const f = smallestPrimeFactor(n);
  const m = n / f;

  if (f === n) {
    // Prime length: naive DFT into scratch, copy back (never hit by MDX sizes).
    const srcRe = new Float64Array(n);
    const srcIm = new Float64Array(n);
    for (let t = 0; t < n; t += 1) {
      srcRe[t] = re[off + t * stride];
      srcIm[t] = im[off + t * stride];
    }
    for (let k = 0; k < n; k += 1) {
      let sumRe = 0;
      let sumIm = 0;
      for (let t = 0; t < n; t += 1) {
        const angle = (-2 * Math.PI * k * t) / n;
        sumRe += srcRe[t] * Math.cos(angle) - srcIm[t] * Math.sin(angle);
        sumIm += srcRe[t] * Math.sin(angle) + srcIm[t] * Math.cos(angle);
      }
      re[off + k * stride] = sumRe;
      im[off + k * stride] = sumIm;
    }
    return;
  }

  // Decimation in time: the f subsequences x_r[k] = x[r·stride + k·(f·stride)]
  // each of length m. Recurse first.
  for (let r = 0; r < f; r += 1) {
    fftStrided(re, im, m, off + r * stride, stride * f);
  }

  // Combine: X[q·m + k] = Σ_{r=0}^{f-1} W_n^{r·k} · W_f^{q·r} · Y_r[k]
  // where Y_r is the DFT of subsequence r, already in place at
  // (off + r·stride, stride·f).
  const subRe = new Float64Array(f * m);
  const subIm = new Float64Array(f * m);
  for (let r = 0; r < f; r += 1) {
    for (let k = 0; k < m; k += 1) {
      subRe[r * m + k] = re[off + r * stride + k * f * stride];
      subIm[r * m + k] = im[off + r * stride + k * f * stride];
    }
  }
  for (let q = 0; q < f; q += 1) {
    for (let k = 0; k < m; k += 1) {
      let accRe = 0;
      let accIm = 0;
      for (let r = 0; r < f; r += 1) {
        // w = W_n^{r·k} · W_f^{q·r} = e^{-2πi(rk/n + qr/f)}
        const angle = -2 * Math.PI * (r * k) / n - 2 * Math.PI * (q * r) / f;
        const cos = Math.cos(angle);
        const sin = Math.sin(angle);
        const yrRe = subRe[r * m + k];
        const yrIm = subIm[r * m + k];
        accRe += yrRe * cos - yrIm * sin;
        accIm += yrRe * sin + yrIm * cos;
      }
      re[off + (q * m + k) * stride] = accRe;
      im[off + (q * m + k) * stride] = accIm;
    }
  }
}

/** Forward FFT of a contiguous complex array (in place). */
export function fftInPlace(re: Float64Array, im: Float64Array): void {
  fftStrided(re, im, re.length, 0, 1);
}

/** Inverse FFT via the conjugate identity: ifft(x) = conj(fft(conj(x)))/n
 *  (exact, not approximate). */
export function ifftInPlace(re: Float64Array, im: Float64Array): void {
  const n = re.length;
  for (let i = 0; i < n; i += 1) im[i] = -im[i];
  fftStrided(re, im, n, 0, 1);
  const inv = 1 / n;
  for (let i = 0; i < n; i += 1) {
    re[i] *= inv;
    im[i] *= -inv;
  }
}

/** Real-input FFT of a windowed frame → rfft spectrum (n/2+1 bins).
 *  Returns freshly allocated arrays. */
export function rfftFrame(frame: Float64Array, nFft: number): ComplexArray {
  const re = new Float64Array(nFft);
  const im = new Float64Array(nFft);
  re.set(frame.subarray(0, Math.min(frame.length, nFft)));
  fftInPlace(re, im);
  const bins = nFft / 2 + 1;
  return { re: re.slice(0, bins), im: im.slice(0, bins) };
}
