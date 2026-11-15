import assert from "node:assert/strict";
import { test } from "node:test";
import { OutputPeakLimiter } from "./output-peak-limiter";
import { truePeakDb } from "./mixer/meters";

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

  test(`4× reconstructed true peak stays below ceiling for high-frequency stereo fixtures at ${sampleRate} Hz`, () => {
    const frames = Math.floor(sampleRate * 0.12);
    const frequency = sampleRate * 0.375;
    const fixtures = [
      {
        name: "high-frequency, phase-offset tones",
        sample: (frame: number, channel: number) =>
          0.97 * Math.sin((2 * Math.PI * frequency * frame) / sampleRate + 0.3 + channel * 0.83),
      },
      {
        name: "stereo tones offset by a quarter-cycle",
        sample: (frame: number, channel: number) =>
          0.98 * Math.sin((2 * Math.PI * sampleRate * 0.375 * frame) / sampleRate +
            0.3 + channel * (Math.PI / 2)),
      },
      {
        name: "short, phase-offset transient bursts",
        sample: (frame: number, channel: number) => {
          const local = (frame - 800 - channel * 3) % 19;
          return frame >= 800 + channel * 3 && local >= 0 && local < 4
            ? (local < 2 ? 0.94 : -0.94)
            : 0;
        },
      },
    ];

    for (const fixture of fixtures) {
      const limiter = new OutputPeakLimiter(sampleRate);
      const measuredInput = new Float32Array(frames * 2);
      const measuredOutput = new Float32Array(frames * 2);
      let inputSamplePeak = 0;
      let outputSamplePeak = 0;
      for (let start = 0; start < frames; start += 128) {
        const count = Math.min(128, frames - start);
        const left = new Float32Array(count);
        const right = new Float32Array(count);
        for (let i = 0; i < count; i += 1) {
          const frame = start + i;
          left[i] = fixture.sample(frame, 0);
          right[i] = fixture.sample(frame, 1);
          measuredInput[frame * 2] = left[i];
          measuredInput[frame * 2 + 1] = right[i];
          inputSamplePeak = Math.max(inputSamplePeak, Math.abs(left[i]), Math.abs(right[i]));
        }
        const output = [new Float32Array(count), new Float32Array(count)];
        limiter.process([left, right], output);
        for (let i = 0; i < count; i += 1) {
          const frame = start + i;
          measuredOutput[frame * 2] = output[0][i];
          measuredOutput[frame * 2 + 1] = output[1][i];
          outputSamplePeak = Math.max(outputSamplePeak, Math.abs(output[0][i]), Math.abs(output[1][i]));
        }
      }

      const inputTruePeak = 10 ** (truePeakDb(measuredInput, sampleRate) / 20);
      const outputTruePeak = 10 ** (truePeakDb(measuredOutput, sampleRate) / 20);
      assert.ok(inputSamplePeak <= 0.970001, `${fixture.name}: input sample peak ${inputSamplePeak}`);
      assert.ok(inputTruePeak > 0.98, `${fixture.name}: fixture must exceed the true-peak ceiling, got ${inputTruePeak}`);
      if (fixture.name.includes("transient"))
        assert.ok(inputTruePeak > 1, `${fixture.name}: fixture must exceed full scale, got ${inputTruePeak}`);
      assert.ok(outputSamplePeak <= 0.980001, `${fixture.name}: output sample peak ${outputSamplePeak}`);
      assert.ok(outputTruePeak <= 0.981, `${fixture.name}: reconstructed output peak ${outputTruePeak}`);
    }
  });

  test(`below-threshold high-frequency stereo remains transparent at ${sampleRate} Hz`, () => {
    const limiter = new OutputPeakLimiter(sampleRate);
    const frames = 2048;
    const input = [new Float32Array(frames), new Float32Array(frames)];
    for (let frame = 0; frame < frames; frame += 1) {
      input[0][frame] = 0.8 * Math.sin((2 * Math.PI * sampleRate * 0.375 * frame) / sampleRate);
      input[1][frame] = 0.7 * Math.sin((2 * Math.PI * sampleRate * 0.375 * frame) / sampleRate + 0.6);
    }
    const output = [new Float32Array(frames), new Float32Array(frames)];
    limiter.process(input, output);
    for (let frame = 0; frame < frames; frame += 1) {
      for (let channel = 0; channel < 2; channel += 1) {
        const expected = frame < limiter.delayFrames ? 0 : input[channel][frame - limiter.delayFrames];
        assert.equal(output[channel][frame], expected);
      }
    }
  });
}
