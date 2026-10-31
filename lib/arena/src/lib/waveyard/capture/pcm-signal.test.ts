import assert from "node:assert/strict";
import { test } from "node:test";
import { PcmSignalMonitor, isCaptureSignal } from "./pcm-signal";

function format(tag = 1, bits = 16, channels = 2): Buffer {
  const bytes = Buffer.alloc(16);
  bytes.writeUInt16LE(tag, 0);
  bytes.writeUInt16LE(channels, 2);
  bytes.writeUInt32LE(48_000, 4);
  bytes.writeUInt16LE(channels * bits / 8, 12);
  bytes.writeUInt16LE(bits, 14);
  return bytes;
}

test("no packets, actual silence, sound and stopped packet delivery remain distinct", () => {
  const monitor = new PcmSignalMonitor(format());
  assert.equal(monitor.snapshot(0).state, "waiting");
  monitor.write(Buffer.alloc(48_000 * 4), 100);
  assert.deepEqual(monitor.snapshot(100), {
    state: "silent", peak: 0, capturedSeconds: 1, signalSeen: false, clippedSamples: 0, invalidSamples: 0,
  });
  const sound = Buffer.alloc(4);
  sound.writeInt16LE(16_384);
  const original = Buffer.from(sound);
  monitor.write(sound.subarray(0, 1), 200);
  monitor.write(sound.subarray(1), 200);
  assert.deepEqual(sound, original, "monitoring never mutates source PCM");
  assert.equal(monitor.snapshot(200).peak, 0.5);
  assert.equal(monitor.snapshot(200).state, "active");
  assert.equal(monitor.snapshot(4000).state, "waiting");
  assert.equal(monitor.snapshot(4000).signalSeen, true);
  assert.equal(monitor.snapshot(4000).capturedSeconds, 1 + 1 / 48_000);
  monitor.write(Buffer.alloc(4), 4100);
  assert.equal(monitor.snapshot(4100).state, "silent");
});

test("unsigned PCM silence and 24/32-bit integer PCM are interpreted correctly", () => {
  const unsigned = new PcmSignalMonitor(format(1, 8, 1));
  unsigned.write(Buffer.from([128, 128]), 0);
  assert.equal(unsigned.snapshot(0).state, "silent");
  for (const bits of [24, 32]) {
    const monitor = new PcmSignalMonitor(format(1, bits, 1));
    const bytes = Buffer.alloc(bits / 8);
    bytes.writeIntLE(-(2 ** (bits - 1)), 0, bits / 8);
    monitor.write(bytes, 0);
    assert.equal(monitor.snapshot(0).peak, 1);
    assert.equal(monitor.snapshot(0).clippedSamples, 1);
  }
});

test("IEEE float, extensible formats, clipping and non-finite values are handled honestly", () => {
  for (const bits of [32, 64]) {
    const monitor = new PcmSignalMonitor(format(3, bits, 1));
    const bytes = Buffer.alloc(3 * bits / 8);
    const write = bits === 32 ? bytes.writeFloatLE.bind(bytes) : bytes.writeDoubleLE.bind(bytes);
    write(0.25, 0);
    write(1.2, bits / 8);
    write(NaN, 2 * bits / 8);
    monitor.write(bytes, 0);
    assert.equal(monitor.snapshot(0).peak, 1);
    assert.equal(monitor.snapshot(0).clippedSamples, 1);
    assert.equal(monitor.snapshot(0).invalidSamples, 1);
  }
  const extensible = Buffer.alloc(40);
  format(0xfffe, 32, 1).copy(extensible);
  extensible.writeUInt16LE(22, 16);
  Buffer.from("0300000000001000800000aa00389b71", "hex").copy(extensible, 24);
  const monitor = new PcmSignalMonitor(extensible);
  const pcm = Buffer.alloc(4);
  pcm.writeFloatLE(0.25);
  monitor.write(pcm, 0);
  assert.equal(monitor.snapshot(0).peak, 0.25);
  extensible[39] = 0;
  assert.equal(new PcmSignalMonitor(extensible).snapshot().state, "unsupported");
  assert.equal(new PcmSignalMonitor(format(6)).snapshot().state, "unsupported");
});

test("malformed preserved signal metadata cannot masquerade as verified evidence", () => {
  const signal = new PcmSignalMonitor(format()).snapshot();
  assert.equal(isCaptureSignal(signal), true);
  for (const invalid of [null, {}, { ...signal, peak: NaN }, { ...signal, peak: 2 },
    { ...signal, clippedSamples: -1 }, { ...signal, state: "verified" }, { ...signal, signalSeen: "yes" }]) {
    assert.equal(isCaptureSignal(invalid), false);
  }
});
