import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { open, stat } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

const PCM_WAV_HEADER_BYTES = 44;
const COPY_CHUNK_BYTES = 1024 * 1024;
const execFileAsync = promisify(execFile);

export async function probeAudioFile(filePath, ffprobePath) {
  assert(path.isAbsolute(filePath), "The source audio path must be absolute.");
  assert(path.isAbsolute(ffprobePath), "The bundled FFprobe path must be absolute.");
  const { stdout } = await execFileAsync(ffprobePath, [
    "-v", "error",
    "-show_entries", "format=format_name,duration:stream=codec_name,codec_type,channels,sample_rate,bits_per_sample",
    "-of", "json",
    filePath,
  ], { timeout: 60_000, windowsHide: true, maxBuffer: 1024 * 1024 });
  const metadata = JSON.parse(stdout);
  const audio = metadata.streams?.find((stream) => stream.codec_type === "audio");
  const durationSeconds = Number(metadata.format?.duration);
  assert(audio, "The selected file does not contain an audio stream.");
  assert(Number.isFinite(durationSeconds) && durationSeconds > 1, "The selected audio duration could not be read.");
  return {
    format: String(metadata.format?.format_name ?? "unknown"),
    codec: String(audio.codec_name ?? "unknown"),
    channels: Number.isFinite(Number(audio.channels)) ? Number(audio.channels) : null,
    sampleRateHz: Number.isFinite(Number(audio.sample_rate)) ? Number(audio.sample_rate) : null,
    bitsPerSample: Number.isFinite(Number(audio.bits_per_sample)) ? Number(audio.bits_per_sample) : null,
    durationSeconds: Number(durationSeconds.toFixed(2)),
  };
}

function pcmWavHeader({ dataBytes, sampleRateHz, channels, bitsPerSample }) {
  const header = Buffer.alloc(PCM_WAV_HEADER_BYTES);
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

export async function writePcmWavExcerpt(sourcePath, targetPath, sourceInfo, {
  startSeconds = 0,
  maxSeconds = 0,
} = {}) {
  assert(Number.isInteger(startSeconds) && startSeconds >= 0, "Start time must be a non-negative whole number of seconds.");
  assert(
    Number.isInteger(maxSeconds) && (maxSeconds === 0 || (maxSeconds >= 2 && maxSeconds <= 20)),
    "Maximum duration must be 0 (full remaining file) or 2–20 seconds.",
  );
  assert.equal(sourceInfo.formatCode, 1, "Only uncompressed PCM audio can be excerpted.");
  assert.equal(sourceInfo.channels, 2, "The Waveyard measurement requires stereo audio.");
  assert.equal(sourceInfo.bitsPerSample, 16, "The Waveyard measurement requires 16-bit PCM audio.");
  assert(Number.isInteger(sourceInfo.sampleRateHz) && sourceInfo.sampleRateHz > 0, "The WAV sample rate is invalid.");
  assert(
    path.resolve(sourcePath) !== path.resolve(targetPath),
    "The excerpt must not overwrite the original audio file.",
  );

  const bytesPerFrame = sourceInfo.channels * (sourceInfo.bitsPerSample / 8);
  assert.equal(sourceInfo.dataBytes % bytesPerFrame, 0, "The WAV data size is not frame-aligned.");
  const totalFrames = sourceInfo.dataBytes / bytesPerFrame;
  const startFrame = startSeconds * sourceInfo.sampleRateHz;
  const availableFrames = totalFrames - startFrame;
  assert(
    availableFrames > sourceInfo.sampleRateHz,
    "The selected start time must leave more than one second of audio.",
  );
  const frames = maxSeconds === 0
    ? availableFrames
    : Math.min(availableFrames, maxSeconds * sourceInfo.sampleRateHz);
  const dataBytes = frames * bytesPerFrame;
  const sourceDataOffset = sourceInfo.dataOffset + startFrame * bytesPerFrame;

  const source = await open(sourcePath, "r");
  let target;
  try {
    target = await open(targetPath, "w");
    const header = pcmWavHeader({
      dataBytes,
      sampleRateHz: sourceInfo.sampleRateHz,
      channels: sourceInfo.channels,
      bitsPerSample: sourceInfo.bitsPerSample,
    });
    await target.write(header, 0, header.length, 0);

    let copiedBytes = 0;
    while (copiedBytes < dataBytes) {
      const bytesToCopy = Math.min(COPY_CHUNK_BYTES, dataBytes - copiedBytes);
      const buffer = Buffer.allocUnsafe(bytesToCopy);
      let chunkRead = 0;
      while (chunkRead < bytesToCopy) {
        const { bytesRead } = await source.read(
          buffer,
          chunkRead,
          bytesToCopy - chunkRead,
          sourceDataOffset + copiedBytes + chunkRead,
        );
        assert(bytesRead > 0, "The source WAV ended before its declared audio data.");
        chunkRead += bytesRead;
      }

      let chunkWritten = 0;
      while (chunkWritten < chunkRead) {
        const { bytesWritten } = await target.write(
          buffer,
          chunkWritten,
          chunkRead - chunkWritten,
          PCM_WAV_HEADER_BYTES + copiedBytes + chunkWritten,
        );
        assert(bytesWritten > 0, "Could not write the complete audio excerpt.");
        chunkWritten += bytesWritten;
      }
      copiedBytes += chunkWritten;
    }
    await target.truncate(PCM_WAV_HEADER_BYTES + dataBytes);

    return {
      startSeconds,
      durationSeconds: Number((frames / sourceInfo.sampleRateHz).toFixed(2)),
      frames,
      dataBytes,
      sizeBytes: PCM_WAV_HEADER_BYTES + dataBytes,
    };
  } finally {
    await source.close();
    await target?.close();
  }
}

export async function writeCompressedAudioExcerpt(sourcePath, targetPath, {
  ffmpegPath,
  ffprobePath,
  startSeconds = 0,
  maxSeconds = 0,
} = {}) {
  assert(Number.isInteger(startSeconds) && startSeconds >= 0, "Start time must be a non-negative whole number of seconds.");
  assert(
    Number.isInteger(maxSeconds) && (maxSeconds === 0 || (maxSeconds >= 2 && maxSeconds <= 20)),
    "Maximum duration must be 0 (full remaining file) or 2–20 seconds.",
  );
  assert(path.resolve(sourcePath) !== path.resolve(targetPath), "The excerpt must not overwrite the original audio file.");
  assert(path.isAbsolute(ffmpegPath), "The bundled FFmpeg path must be absolute.");
  assert(path.isAbsolute(ffprobePath), "The bundled FFprobe path must be absolute.");

  const args = ["-hide_banner", "-loglevel", "error"];
  if (startSeconds > 0) args.push("-ss", String(startSeconds));
  args.push("-i", sourcePath, "-map", "0:a:0", "-c:a", "copy", "-vn", "-sn", "-dn");
  if (maxSeconds > 0) args.push("-t", String(maxSeconds));
  args.push("-y", targetPath);
  await execFileAsync(ffmpegPath, args, { timeout: 120_000, windowsHide: true, maxBuffer: 1024 * 1024 });

  const output = await stat(targetPath);
  assert(output.size > 0, "FFmpeg did not create a usable audio excerpt.");
  const metadata = await probeAudioFile(targetPath, ffprobePath);
  assert(metadata.durationSeconds > 1, "The compressed excerpt contains less than one second of audio.");
  if (maxSeconds > 0) {
    assert(
      metadata.durationSeconds <= maxSeconds + 2,
      "The compressed excerpt is longer than the requested measurement window.",
    );
  }
  return {
    startSeconds,
    durationSeconds: metadata.durationSeconds,
    sizeBytes: output.size,
    format: metadata.format,
    codec: metadata.codec,
  };
}
