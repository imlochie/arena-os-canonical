export type Pcm16WavHeader = {
  channels: number;
  sampleRate: number;
  blockAlign: number;
  dataOffsetBytes: number;
  dataBytes: number;
  fileSizeBytes: number;
};

export type Pcm16WavSegmentRange = {
  byteStart: number;
  byteEnd: number;
  frameCount: number;
  sourceOffsetMs: number;
  durationMs: number;
};

export function parseHttpContentRange(value: string | null): { start: number; end: number; total: number } | null {
  const match = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(value ?? "");
  if (!match) return null;
  const [start, end, total] = match.slice(1).map(Number);
  if (![start, end, total].every(Number.isSafeInteger) || start < 0 || end < start || total <= end) return null;
  return { start, end, total };
}

function fourCc(view: DataView, offset: number) {
  return String.fromCharCode(
    view.getUint8(offset),
    view.getUint8(offset + 1),
    view.getUint8(offset + 2),
    view.getUint8(offset + 3),
  );
}

/** Parse the standard PCM16 WAV headers written for Waveyard stem assets. */
export function parsePcm16WavHeader(
  bytes: ArrayBuffer,
  fileSizeBytes: number,
): Pcm16WavHeader | null {
  if (bytes.byteLength < 44 || !Number.isSafeInteger(fileSizeBytes) || fileSizeBytes < 44) return null;
  const view = new DataView(bytes);
  if (fourCc(view, 0) !== "RIFF" || fourCc(view, 8) !== "WAVE") return null;

  let format: { channels: number; sampleRate: number; blockAlign: number; bitsPerSample: number } | null = null;
  let dataOffsetBytes: number | null = null;
  let dataBytes: number | null = null;
  for (let offset = 12; offset + 8 <= bytes.byteLength;) {
    const chunk = fourCc(view, offset);
    const chunkBytes = view.getUint32(offset + 4, true);
    const contentOffset = offset + 8;
    if (chunk === "fmt ") {
      if (chunkBytes < 16 || contentOffset + 16 > bytes.byteLength) return null;
      format = {
        channels: view.getUint16(contentOffset + 2, true),
        sampleRate: view.getUint32(contentOffset + 4, true),
        blockAlign: view.getUint16(contentOffset + 12, true),
        bitsPerSample: view.getUint16(contentOffset + 14, true),
      };
    } else if (chunk === "data") {
      dataOffsetBytes = contentOffset;
      dataBytes = chunkBytes;
      break;
    }

    const next = contentOffset + chunkBytes + (chunkBytes & 1);
    if (!Number.isSafeInteger(next) || next <= offset || next > bytes.byteLength) return null;
    offset = next;
  }

  if (
    !format ||
    ![1, 2].includes(format.channels) ||
    !Number.isInteger(format.sampleRate) ||
    format.sampleRate < 8_000 ||
    format.sampleRate > 96_000 ||
    format.bitsPerSample !== 16 ||
    format.blockAlign !== format.channels * 2 ||
    dataOffsetBytes === null ||
    dataBytes === null ||
    dataOffsetBytes + dataBytes > fileSizeBytes
  ) return null;

  return {
    channels: format.channels,
    sampleRate: format.sampleRate,
    blockAlign: format.blockAlign,
    dataOffsetBytes,
    dataBytes,
    fileSizeBytes,
  };
}

/** Convert a source-time interval to an exact byte range inside the WAV data. */
export function pcm16WavSegmentRange(
  header: Pcm16WavHeader,
  sourceOffsetMs: number,
  durationMs: number,
): Pcm16WavSegmentRange | null {
  if (
    !Number.isFinite(sourceOffsetMs) ||
    !Number.isFinite(durationMs) ||
    sourceOffsetMs < 0 ||
    durationMs <= 0
  ) return null;
  const totalFrames = Math.floor(header.dataBytes / header.blockAlign);
  const startFrame = Math.floor(sourceOffsetMs * header.sampleRate / 1_000);
  if (startFrame < 0 || startFrame >= totalFrames) return null;
  const requestedFrames = Math.max(1, Math.ceil(durationMs * header.sampleRate / 1_000));
  const frameCount = Math.min(requestedFrames, totalFrames - startFrame);
  const byteStart = header.dataOffsetBytes + startFrame * header.blockAlign;
  const byteEnd = byteStart + frameCount * header.blockAlign - 1;
  if (byteEnd >= header.fileSizeBytes) return null;
  return {
    byteStart,
    byteEnd,
    frameCount,
    sourceOffsetMs: startFrame * 1_000 / header.sampleRate,
    durationMs: frameCount * 1_000 / header.sampleRate,
  };
}
