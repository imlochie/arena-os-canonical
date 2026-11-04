import assert from "node:assert/strict";
import test from "node:test";
import { makeRf64Wave, makeToneWave, measureTone, parseFormat } from "./windows-capture-acceptance.mjs";

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

test("device-loss recovery output is a valid RF64 WAV with the captured PCM intact", () => {
  const tone = makeToneWave(440);
  const pcm = tone.subarray(44);
  const formatChunk = Buffer.alloc(16);
  formatChunk.writeUInt16LE(1, 0);
  formatChunk.writeUInt16LE(1, 2);
  formatChunk.writeUInt32LE(48_000, 4);
  formatChunk.writeUInt32LE(96_000, 8);
  formatChunk.writeUInt16LE(2, 12);
  formatChunk.writeUInt16LE(16, 14);
  const wave = makeRf64Wave(formatChunk, pcm, 2);

  assert.equal(wave.toString("ascii", 0, 4), "RF64");
  assert.equal(wave.toString("ascii", 8, 12), "WAVE");
  assert.equal(wave.readBigUInt64LE(28), BigInt(pcm.length));
  const dataOffset = wave.indexOf("data", 48, "ascii");
  assert.ok(dataOffset > 0);
  assert.deepEqual(wave.subarray(dataOffset + 8), pcm);
});
