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
    const bytes = Buffer.alloc(5 * bits / 8);
    const write = bits === 32 ? bytes.writeFloatLE.bind(bytes) : bytes.writeDoubleLE.bind(bytes);
    write(0.25, 0);
    write(1.2, bits / 8);
    write(NaN, 2 * bits / 8);
    write(Infinity, 3 * bits / 8);
    write(-Infinity, 4 * bits / 8);
    monitor.write(bytes, 0);
    assert.equal(monitor.snapshot(0).peak, 1);
    assert.equal(monitor.snapshot(0).clippedSamples, 1);
    assert.equal(monitor.snapshot(0).invalidSamples, 3);
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

test("randomized high-resolution chunks keep less than one frame and do not retain or mutate input", () => {
  for (const rate of [48_000, 96_000, 192_000]) {
    for (const channels of [1, 2, 8]) {
      for (const [tag, bits] of [[1, 8], [1, 16], [1, 24], [1, 32], [3, 32], [3, 64]]) {
        const waveFormat = format(tag, bits, channels);
        waveFormat.writeUInt32LE(rate, 4);
        // Include non-sample padding in each frame; it must not count as audio.
        const align = channels * bits / 8 + 3;
        waveFormat.writeUInt16LE(align, 12);
        const frame = Buffer.alloc(align, 0xff);
        for (let channel = 0; channel < channels; channel++) {
          const offset = channel * bits / 8;
          const value = channel % 3 === 0 ? 1 : channel % 3 === 1 ? 0.25 : NaN;
          if (tag === 3) {
            if (bits === 32) frame.writeFloatLE(value, offset);
            else frame.writeDoubleLE(value, offset);
          } else if (bits === 8) frame[offset] = channel % 2 ? 128 : 255;
          else frame.writeIntLE(channel % 2 ? 0 : 2 ** (bits - 1) - 1, offset, bits / 8);
        }
        const bytes = Buffer.concat(Array.from({ length: 301 }, () => frame));
        const original = Buffer.from(bytes);
        const reference = new PcmSignalMonitor(waveFormat);
        reference.write(bytes, 100);
        const streamed = new PcmSignalMonitor(waveFormat);
        let seed = 123;
        for (let offset = 0; offset < bytes.length;) {
          seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
          const end = Math.min(bytes.length, offset + 1 + seed % 257);
          streamed.write(bytes.subarray(offset, end), 100);
          const tail = (streamed as unknown as { tail: Buffer }).tail;
          assert.equal(tail.length, end % align);
          assert.ok(tail.length < align);
          if (tail.length) {
            const overlapping = tail.buffer === bytes.buffer && tail.byteOffset < bytes.byteOffset + bytes.length
              && bytes.byteOffset < tail.byteOffset + tail.length;
            assert.equal(overlapping, false, "a partial frame is copied, not a view of incoming PCM");
          }
          offset = end;
        }
        assert.deepEqual(streamed.snapshot(100), reference.snapshot(100), `${rate}/${channels}/${tag}/${bits}`);
        assert.deepEqual(bytes, original, "all PCM and frame padding remains byte-for-byte unchanged");
        assert.equal(streamed.snapshot(100).capturedSeconds, 301 / rate);
        assert.equal(streamed.snapshot(4000).state, "waiting");
        assert.equal(streamed.snapshot(4000).signalSeen, true);
      }
    }
  }
});
