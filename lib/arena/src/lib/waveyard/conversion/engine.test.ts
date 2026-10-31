import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { checksumFile, probeAudio } from "../audio";
import { execTool } from "../ffmpeg";
import { conversionCapabilities, convertLocalAudio } from "./engine";

test("converts and fully verifies a local audio file without changing its original", async (context) => {
  let capabilities;
  try {
    capabilities = await conversionCapabilities();
  } catch {
    context.skip("FFmpeg is not installed in this test environment.");
    return;
  }
  if (!capabilities.some((format) => format.id === "flac" && format.available)) {
    context.skip("The FLAC encoder is not available in this test environment.");
    return;
  }

  const directory = await mkdtemp(join(tmpdir(), "waveyard-conversion-test-"));
  try {
    const source = join(directory, "original.wav");
    const output = join(directory, "converted.flac");
    await execTool("ffmpeg", [
      "-v", "error",
      "-nostdin",
      "-f", "lavfi",
      "-i", "sine=frequency=440:duration=1",
      "-c:a", "pcm_s16le",
      "-metadata", "title=Local conversion test",
      source,
    ]);
    const originalChecksum = await checksumFile(source);
    const verified = await convertLocalAudio(source, output, { format: "flac", bitrate: 192 });
    const originalAfter = await checksumFile(source);
    const convertedMetadata = await probeAudio(output);

    assert.equal(originalAfter, originalChecksum, "the user's original must remain byte-identical");
    assert.equal(verified.codec, "flac");
    assert.equal(verified.durationSeconds, convertedMetadata.durationSeconds);
    assert.equal(verified.checksumSha256, await checksumFile(output));
    assert.equal(verified.warnings.length, 0);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("ALAC is advertised and verified as a lossless M4A conversion when FFmpeg provides it", async (context) => {
  let capabilities;
  try {
    capabilities = await conversionCapabilities();
  } catch {
    context.skip("FFmpeg is not installed in this test environment.");
    return;
  }
  if (!capabilities.some((format) => format.id === "alac" && format.available)) {
    context.skip("The ALAC encoder is not available in this test environment.");
    return;
  }

  const directory = await mkdtemp(join(tmpdir(), "waveyard-alac-test-"));
  try {
    const source = join(directory, "original.wav");
    const output = join(directory, "converted.m4a");
    const sourcePcm = join(directory, "source.pcm");
    const convertedPcm = join(directory, "converted.pcm");
    await execTool("ffmpeg", [
      "-v", "error",
      "-nostdin",
      "-f", "lavfi",
      "-i", "sine=frequency=440:duration=1",
      "-c:a", "pcm_s16le",
      "-metadata", "title=Local ALAC conversion test",
      source,
    ]);

    const originalChecksum = await checksumFile(source);
    const converted = await convertLocalAudio(source, output, { format: "alac", bitrate: 192 });
    const encodedMetadata = await probeAudio(output);

    assert.equal(await checksumFile(source), originalChecksum, "the user's original must remain byte-identical");
    assert.equal(converted.codec, "alac");
    assert.equal(encodedMetadata.codec, "alac");
    assert.equal(encodedMetadata.container, "mov,mp4,m4a,3gp,3g2,mj2");
    assert.equal(converted.sampleRate, encodedMetadata.sampleRate);
    assert.equal(converted.channels, encodedMetadata.channels);
    assert.equal(converted.checksumSha256, await checksumFile(output));
    assert.deepEqual(converted.warnings, []);

    for (const [input, rawOutput] of [[source, sourcePcm], [output, convertedPcm]]) {
      await execTool("ffmpeg", [
        "-v", "error",
        "-nostdin",
        "-i", input,
        "-map", "0:a:0",
        "-c:a", "pcm_s16le",
        "-f", "s16le",
        rawOutput,
      ]);
    }
    assert.equal(
      await checksumFile(convertedPcm),
      await checksumFile(sourcePcm),
      "decoding ALAC must reproduce every source PCM sample",
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
