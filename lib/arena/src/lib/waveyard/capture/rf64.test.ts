import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";

import { createRf64Header, recoverRf64Partial, Rf64Recorder } from "./rf64";

const execFileAsync = promisify(execFile);

function stereoPcm16Format() {
  const formatChunk = Buffer.alloc(40);
  formatChunk.writeUInt16LE(0xfffe, 0); // WAVE_FORMAT_EXTENSIBLE
  formatChunk.writeUInt16LE(2, 2);
  formatChunk.writeUInt32LE(48_000, 4);
  formatChunk.writeUInt32LE(192_000, 8);
  formatChunk.writeUInt16LE(4, 12);
  formatChunk.writeUInt16LE(16, 14);
  formatChunk.writeUInt16LE(22, 16);
  formatChunk.writeUInt16LE(16, 18); // valid bits per sample
  formatChunk.writeUInt32LE(3, 20); // front-left + front-right
  Buffer.from("0100000000001000800000aa00389b71", "hex").copy(formatChunk, 24);
  return formatChunk;
}

function assertFinalizedRf64(bytes: Buffer, dataOffset: number, blockAlign: number) {
  assert.equal(bytes.toString("ascii", 0, 4), "RF64");
  assert.equal(bytes.readUInt32LE(4), 0xffff_ffff);
  assert.equal(bytes.toString("ascii", 8, 12), "WAVE");
  assert.equal(bytes.toString("ascii", 12, 16), "ds64");
  assert.equal(bytes.readBigUInt64LE(20), BigInt(bytes.length - 8));
  assert.equal(bytes.readBigUInt64LE(28), BigInt(bytes.length - dataOffset));
  assert.equal(bytes.readBigUInt64LE(36), BigInt((bytes.length - dataOffset) / blockAlign));
  assert.equal(bytes.toString("ascii", dataOffset - 8, dataOffset - 4), "data");
  assert.equal(bytes.readUInt32LE(dataOffset - 4), 0xffff_ffff);
}

test("RF64 recorder preserves the exact mix format and finalizes whole PCM frames", async () => {
  const directory = await mkdtemp(join(tmpdir(), "waveyard-rf64-"));
  try {
    const format = stereoPcm16Format();
    const header = createRf64Header({ formatChunk: format });
    const partialPath = join(directory, "take.partial.wav");
    const finalPath = join(directory, "take.wav");
    const samples = Buffer.from([1, 2, 3, 4, 5, 6, 7, 8, 9]);
    const recorder = await Rf64Recorder.create({ partialPath, finalPath, format: { formatChunk: format } });

    assert.equal(recorder.format.sampleRate, 48_000);
    assert.equal(recorder.format.channels, 2);
    assert.equal(recorder.format.bitsPerSample, 16);
    assert.equal(recorder.format.blockAlign, 4);
    await recorder.writePcm(samples.subarray(0, 3));
    await recorder.writePcm(samples.subarray(3));
    const result = await recorder.finalize();
    const output = await readFile(finalPath);

    assert.equal(result.dataBytes, 8);
    assert.equal(result.sampleFrames, 2);
    assert.equal(result.discardedTailBytes, 1);
    assert.equal(result.fileBytes, header.dataOffset + 8);
    assert.deepEqual(output.subarray(header.dataOffset), samples.subarray(0, 8));
    assert.deepEqual(output.subarray(56, 96), format, "WAVEFORMATEXTENSIBLE bytes are preserved verbatim");
    assertFinalizedRf64(output, header.dataOffset, 4);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("interrupted RF64 recovery truncates incomplete frames and never overwrites prior takes", async () => {
  const directory = await mkdtemp(join(tmpdir(), "waveyard-rf64-recovery-"));
  try {
    const header = createRf64Header({ formatChunk: stereoPcm16Format() });
    const partialPath = join(directory, "take.partial.wav");
    const priorRecovery = join(directory, "take.recovered.wav");
    await writeFile(priorRecovery, "keep this prior take");
    await writeFile(partialPath, Buffer.concat([header.bytes, Buffer.from([10, 11, 12, 13, 14, 15, 16, 17, 18, 19])]));

    const recovered = await recoverRf64Partial(partialPath);
    const output = await readFile(recovered.path);

    assert.equal(recovered.dataBytes, 8);
    assert.equal(recovered.sampleFrames, 2);
    assert.equal(recovered.discardedTailBytes, 2);
    assert.equal(recovered.path, join(directory, "take.recovered-2.wav"));
    assert.equal(await readFile(priorRecovery, "utf8"), "keep this prior take");
    assert.deepEqual(output.subarray(header.dataOffset), Buffer.from([10, 11, 12, 13, 14, 15, 16, 17]));
    assertFinalizedRf64(output, header.dataOffset, 4);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("RF64 recovery promotes a finalized file left under its partial name", async () => {
  const directory = await mkdtemp(join(tmpdir(), "waveyard-rf64-finalized-"));
  try {
    const format = stereoPcm16Format();
    const header = createRf64Header({ formatChunk: format });
    const partialPath = join(directory, "take.partial.wav");
    const finalPath = join(directory, "take.wav");
    const recorder = await Rf64Recorder.create({ partialPath, finalPath, format: { formatChunk: format } });
    await recorder.writePcm(Buffer.from([1, 2, 3, 4]));
    await recorder.finalize();
    await writeFile(partialPath, await readFile(finalPath));

    const recovered = await recoverRf64Partial(partialPath);
    const output = await readFile(recovered.path);
    assert.equal(recovered.dataBytes, 4);
    assert.equal(recovered.discardedTailBytes, 0);
    assertFinalizedRf64(output, header.dataOffset, 4);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("RF64 finalization never overwrites an existing output path", async () => {
  const directory = await mkdtemp(join(tmpdir(), "waveyard-rf64-no-overwrite-"));
  try {
    const format = stereoPcm16Format();
    const partialPath = join(directory, "take.partial.wav");
    const finalPath = join(directory, "take.wav");
    await writeFile(finalPath, "existing user file");
    const recorder = await Rf64Recorder.create({ partialPath, finalPath, format: { formatChunk: format } });
    await recorder.writePcm(Buffer.from([1, 2, 3, 4]));

    await assert.rejects(recorder.finalize(), { code: "EEXIST" });
    assert.equal(await readFile(finalPath, "utf8"), "existing user file");

    const recovered = await recoverRf64Partial(partialPath);
    assert.equal(recovered.path, join(directory, "take.recovered.wav"));
    assert.equal(recovered.dataBytes, 4);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("FFprobe recognizes finalized RF64 as the captured PCM format", async (context) => {
  try {
    await execFileAsync("ffprobe", ["-version"], { timeout: 3_000 });
  } catch {
    context.skip("FFprobe is not installed in this test environment.");
    return;
  }

  const directory = await mkdtemp(join(tmpdir(), "waveyard-rf64-probe-"));
  try {
    const format = stereoPcm16Format();
    const header = createRf64Header({ formatChunk: format });
    const partialPath = join(directory, "take.partial.wav");
    const finalPath = join(directory, "take.wav");
    const recorder = await Rf64Recorder.create({ partialPath, finalPath, format: { formatChunk: format } });
    const frames = Buffer.alloc(1024 * recorder.format.blockAlign);
    await recorder.writePcm(frames);
    await recorder.finalize();

    const { stdout } = await execFileAsync("ffprobe", [
      "-v", "error",
      "-show_entries", "format=format_name,duration:stream=codec_name,sample_rate,channels",
      "-of", "json",
      finalPath,
    ], { timeout: 10_000 });
    const report = JSON.parse(stdout) as {
      streams?: Array<{ codec_name?: string; sample_rate?: string; channels?: number }>;
      format?: { format_name?: string; duration?: string };
    };

    assert.equal(report.format?.format_name, "wav");
    assert.equal(report.streams?.[0]?.codec_name, "pcm_s16le");
    assert.equal(report.streams?.[0]?.sample_rate, "48000");
    assert.equal(report.streams?.[0]?.channels, 2);
    assert.ok(Math.abs(Number(report.format?.duration) - 1024 / 48_000) < 0.001);
    assert.equal((await readFile(finalPath)).length, header.dataOffset + frames.length);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
