import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { checksumFile, probeAudio } from "../audio";
import { execTool } from "../ffmpeg";
import { conversionCapabilities, convertLocalAudio } from "./engine";

async function embeddedPictureStreams(path: string) {
  const { stdout } = await execTool("ffprobe", [
    "-v", "error",
    "-show_entries", "stream=codec_name:stream_disposition=attached_pic",
    "-of", "json",
    path,
  ]);
  const report = JSON.parse(stdout) as {
    streams?: Array<{ codec_name?: string; disposition?: { attached_pic?: number } }>;
  };
  return (report.streams ?? []).filter(
    (stream) => stream.disposition?.attached_pic === 1,
  );
}

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
    const reportedProgress: number[] = [];
    const verified = await convertLocalAudio(source, output, { format: "flac", bitrate: 192 }, undefined, (percent) => reportedProgress.push(percent));
    const originalAfter = await checksumFile(source);
    const convertedMetadata = await probeAudio(output);

    assert.ok(reportedProgress.length > 0, "FFmpeg progress should be reported while converting");
    assert.deepEqual(reportedProgress, [...reportedProgress].sort((a, b) => a - b));
    assert.equal(originalAfter, originalChecksum, "the user's original must remain byte-identical");
    assert.equal(verified.codec, "flac");
    assert.equal(verified.durationSeconds, convertedMetadata.durationSeconds);
    assert.equal(verified.checksumSha256, await checksumFile(output));
    assert.equal(verified.warnings.length, 0);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("preserves multiple PNG and JPEG cover images and track tags when the destination supports them", async (context) => {
  let capabilities;
  try {
    capabilities = await conversionCapabilities();
  } catch {
    context.skip("FFmpeg is not installed in this test environment.");
    return;
  }
  if (!capabilities.some((format) => format.id === "mp3" && format.available)) {
    context.skip("The MP3 encoder is not available to create the tagged source fixture.");
    return;
  }
  const artworkFormats = capabilities.filter(
    (format) =>
      ["mp3", "aac", "flac", "alac"].includes(format.id) && format.available,
  );
  if (artworkFormats.length === 0) {
    context.skip("No artwork-capable output encoder is available in this test environment.");
    return;
  }

  const directory = await mkdtemp(join(tmpdir(), "waveyard-conversion-artwork-test-"));
  try {
    const images = [
      { role: "Front cover", extension: "png", codec: "png", color: "red", imageOptions: [] as string[] },
      { role: "Back cover", extension: "jpg", codec: "mjpeg", color: "blue", imageOptions: ["-q:v", "2"] },
    ];
    const coverPaths: string[] = [];
    for (const image of images) {
      const cover = join(directory, `${image.role.toLowerCase().replaceAll(" ", "-")}.${image.extension}`);
      await execTool("ffmpeg", [
        "-v", "error",
        "-nostdin",
        "-f", "lavfi",
        "-i", `color=c=${image.color}:s=32x32:d=0.1`,
        "-frames:v", "1",
        ...image.imageOptions,
        cover,
      ]);
      coverPaths.push(cover);
    }

    const source = join(directory, "tagged-source.mp3");
    await execTool("ffmpeg", [
      "-v", "error",
      "-nostdin",
      "-f", "lavfi",
      "-i", "sine=frequency=440:duration=1",
      "-i", coverPaths[0]!,
      "-i", coverPaths[1]!,
      "-map", "0:a:0",
      "-map", "1:v:0",
      "-map", "2:v:0",
      "-c:a", "libmp3lame",
      "-b:a", "192k",
      "-c:v", "copy",
      "-disposition:v:0", "attached_pic",
      "-disposition:v:1", "attached_pic",
      "-metadata:s:v:0", "title=Front cover",
      "-metadata:s:v:1", "title=Back cover",
      "-id3v2_version", "3",
      "-metadata", "title=Artwork conversion fixture",
      "-metadata", "artist=Fixture Artist",
      "-metadata", "album=Fixture Album",
      source,
    ]);

    const sourcePictures = await embeddedPictureStreams(source);
    const expectedCodecs = images.map((image) => image.codec).sort();
    assert.deepEqual(sourcePictures.map((picture) => picture.codec_name).sort(), expectedCodecs);

    for (const { id: format } of artworkFormats) {
      const output = join(
        directory,
        `converted-${format}.${format === "aac" || format === "alac" ? "m4a" : format}`,
      );
      const converted = await convertLocalAudio(source, output, {
        format: format as "mp3" | "aac" | "flac" | "alac",
        bitrate: 192,
      });
      const metadata = await probeAudio(output);
      const pictures = await embeddedPictureStreams(output);

      assert.deepEqual(metadata.tags, {
        title: "Artwork conversion fixture",
        artist: "Fixture Artist",
        album: "Fixture Album",
      }, `${format} conversion should preserve track tags`);
      assert.deepEqual(
        pictures.map((picture) => picture.codec_name).sort(),
        expectedCodecs,
        `${format} conversion should retain both embedded covers`,
      );
      assert.ok(
        !converted.warnings.some((warning) => /cover artwork/i.test(warning)),
        `${format} supports artwork and should not warn that it was dropped`,
      );
    }

    if (capabilities.some((item) => item.id === "wav" && item.available)) {
      const output = join(directory, "converted.wav");
      const converted = await convertLocalAudio(source, output, { format: "wav", bitrate: 192 });
      assert.equal((await embeddedPictureStreams(output)).length, 0);
      assert.ok(
        converted.warnings.some((warning) =>
          /source includes 2 embedded cover images.*WAV.*all embedded artwork will be omitted from the converted file/i.test(warning),
        ),
        "WAV conversion should clearly report that both embedded cover images will be omitted",
      );
    }
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
