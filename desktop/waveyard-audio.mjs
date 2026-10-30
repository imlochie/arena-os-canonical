import assert from "node:assert/strict";
import { open } from "node:fs/promises";
import path from "node:path";

const PCM_WAV_HEADER_BYTES = 44;
const COPY_CHUNK_BYTES = 1024 * 1024;

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
