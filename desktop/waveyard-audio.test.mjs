import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { measurePcmWavSignal, writePcmWavExcerpt } from "./waveyard-audio.mjs";

function makePcmWavHeader({ dataBytes, sampleRateHz = 4, channels = 2, bitsPerSample = 16 }) {
  const header = Buffer.alloc(44);
  header.write("RIFF", 0, "ascii");
  header.writeUInt32LE(36 + dataBytes, 4);
  header.write("WAVE", 8, "ascii");
  header.write("fmt ", 12, "ascii");
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(sampleRateHz, 24);
  const bytesPerFrame = channels * (bitsPerSample / 8);
  header.writeUInt32LE(sampleRateHz * bytesPerFrame, 28);
  header.writeUInt16LE(bytesPerFrame, 32);
  header.writeUInt16LE(bitsPerSample, 34);
  header.write("data", 36, "ascii");
  header.writeUInt32LE(dataBytes, 40);
  return header;
}

test("writes a bounded PCM WAV excerpt from the selected offset", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "arena-waveyard-audio-"));
  try {
    const sourcePath = path.join(root, "source.wav");
    const targetPath = path.join(root, "excerpt.wav");
    const sourcePcm = Buffer.alloc(16 * 4);
    for (let index = 0; index < sourcePcm.length; index += 1) sourcePcm[index] = index;
    await writeFile(sourcePath, Buffer.concat([
      makePcmWavHeader({ dataBytes: sourcePcm.length }),
      sourcePcm,
    ]));

    const result = await writePcmWavExcerpt(sourcePath, targetPath, {
      formatCode: 1,
      channels: 2,
      sampleRateHz: 4,
      bitsPerSample: 16,
      dataOffset: 44,
      dataBytes: sourcePcm.length,
    }, { startSeconds: 1, maxSeconds: 2 });

    const excerpt = await readFile(targetPath);
    assert.equal(result.startSeconds, 1);
    assert.equal(result.durationSeconds, 2);
    assert.equal(result.dataBytes, 2 * 4 * 4);
    assert.equal(excerpt.toString("ascii", 0, 4), "RIFF");
    assert.equal(excerpt.toString("ascii", 8, 12), "WAVE");
    assert.equal(excerpt.readUInt16LE(22), 2);
    assert.equal(excerpt.readUInt32LE(24), 4);
    assert.equal(excerpt.readUInt32LE(40), result.dataBytes);
    assert.deepEqual(excerpt.subarray(44), sourcePcm.subarray(4 * 4, 4 * 4 + result.dataBytes));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("rejects an excerpt that starts with only one second of audio left", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "arena-waveyard-audio-"));
  try {
    const sourcePath = path.join(root, "source.wav");
    const sourcePcm = Buffer.alloc(16 * 4);
    await writeFile(sourcePath, Buffer.concat([
      makePcmWavHeader({ dataBytes: sourcePcm.length }),
      sourcePcm,
    ]));
    await assert.rejects(
      writePcmWavExcerpt(sourcePath, path.join(root, "excerpt.wav"), {
        formatCode: 1,
        channels: 2,
        sampleRateHz: 4,
        bitsPerSample: 16,
        dataOffset: 44,
        dataBytes: sourcePcm.length,
      }, { startSeconds: 3, maxSeconds: 2 }),
      /leave more than one second/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("measures PCM signal per stem and identifies silent WAV output", () => {
  const samples = Buffer.alloc(8);
  samples.writeInt16LE(16_384, 0);
  samples.writeInt16LE(-16_384, 2);
  const wavHeader = makePcmWavHeader({ dataBytes: samples.length });
  const active = measurePcmWavSignal(Buffer.concat([wavHeader, samples]));
  assert.equal(active.channels, 2);
  assert.equal(active.sampleRateHz, 4);
  assert.equal(active.sampleCount, 4);
  assert.equal(active.durationSeconds, 0.5);
  assert.ok(Math.abs(active.rms - Math.sqrt(0.125)) < 1e-7);
  assert.equal(active.peakAbsolute, 0.5);
  assert.equal(active.pcmFingerprint.length, 64);
  assert.equal(
    active.pcmFingerprint,
    measurePcmWavSignal(Buffer.concat([wavHeader, samples])).pcmFingerprint,
  );

  const silent = measurePcmWavSignal(Buffer.concat([
    makePcmWavHeader({ dataBytes: 8 }),
    Buffer.alloc(8),
  ]));
  assert.equal(silent.rms, 0);
  assert.equal(silent.peakAbsolute, 0);
  assert.notEqual(active.pcmFingerprint, silent.pcmFingerprint);
});
