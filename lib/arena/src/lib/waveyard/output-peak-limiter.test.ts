import assert from "node:assert/strict";
import { test } from "node:test";
import { OutputPeakLimiter } from "./output-peak-limiter";

for (const sampleRate of [44_100, 48_000]) {
  test(`linked limiter bounds correlated/uncorrelated overlap and transients at ${sampleRate} Hz`, () => {
    for (const master of [0.25, 0.63, 1]) for (const correlated of [true, false]) {
      const limiter = new OutputPeakLimiter(sampleRate);
      const length = sampleRate;
      let peak = 0, rawPeak = 0;
      for (let start = 0; start < length; start += 128) {
        const count = Math.min(128, length - start);
        const left = new Float32Array(count), right = new Float32Array(count);
        for (let i = 0; i < count; i++) {
          const frame = start + i;
          const phase = frame / sampleRate * 2 * Math.PI;
          const a = 0.98 * Math.sin(phase * 220);
          const b = 0.98 * Math.sin(phase * (correlated ? 220 : 317));
          const donor = 0.98 * Math.sin(phase * (correlated ? 220 : 431));
          left[i] = master * (a + b + donor);
          if (frame % 10001 === 0) left[i] = 8 * master;
          right[i] = left[i] * 0.25;
          rawPeak = Math.max(rawPeak, Math.abs(left[i]));
        }
        const out = [new Float32Array(count), new Float32Array(count)];
        limiter.process([left, right], out);
        for (let i = 0; i < count; i++) {
          peak = Math.max(peak, Math.abs(out[0][i]));
          assert.ok(Math.abs(out[1][i] - out[0][i] * 0.25) < 1e-6, "stereo balance stays linked");
        }
      }
      assert.ok(rawPeak > 0.98, "fixture actually overloads");
      assert.ok(peak <= 0.980001, `master=${master}, correlated=${correlated}, peak=${peak}`);
    }
  });
  test(`below-ceiling PCM is unchanged apart from fixed lookahead at ${sampleRate} Hz`, () => {
    const limiter = new OutputPeakLimiter(sampleRate);
    const input = Float32Array.from({ length: 2048 }, (_, i) => 0.3 * Math.sin(i * 0.1));
    const output = [new Float32Array(input.length), new Float32Array(input.length)];
    limiter.process([input, input], output);
    for (let i = 0; i < input.length; i++)
      assert.equal(output[0][i], i < limiter.delayFrames ? 0 : input[i - limiter.delayFrames]);
  });
}
