import assert from "node:assert/strict";
import test from "node:test";
import { makeToneWave, measureTone, parseFormat } from "./windows-capture-acceptance.mjs";

test("isolation acceptance detects both tone frequencies and rejects silence as proof", () => {
  const tone = makeToneWave(440);
  const other = makeToneWave(997);
  const fmt = { tag: 1, channels: 1, sampleRate: 48000, blockAlign: 2, bitsPerSample: 16 };
  const target = measureTone(tone.subarray(44), fmt, 440);
  const excluded = measureTone(tone.subarray(44), fmt, 997);
  assert.ok(target.toneAmplitude > 0.5);
  assert.ok(excluded.toneAmplitude < target.toneAmplitude / 30);
  assert.ok(measureTone(other.subarray(44), fmt, 997).toneAmplitude > 0.5);
  const mixed = Buffer.alloc(tone.length - 44);
  for (let offset = 0; offset < mixed.length; offset += 2)
    mixed.writeInt16LE(Math.round((tone.readInt16LE(offset + 44) + other.readInt16LE(offset + 44)) / 2), offset);
  assert.ok(measureTone(mixed, fmt, 440).toneAmplitude > 0.2);
  assert.ok(measureTone(mixed, fmt, 997).toneAmplitude > 0.2);
  assert.equal(measureTone(Buffer.alloc(mixed.length), fmt).toneAmplitude, 0);
  assert.throws(() => parseFormat({ mode: "system-loopback" }, "process-loopback"), /invalid process-loopback/);
});
