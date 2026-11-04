export type ArrangementPreviewAssetMetadata = {
  id: string;
  durationSeconds: number;
  sampleRate: number;
  channels: number;
  fileSizeBytes?: number;
  codec?: string;
};

export const ARRANGEMENT_PREVIEW_MEMORY_LIMIT_BYTES = 128 * 1024 * 1024;
export const ARRANGEMENT_PREVIEW_STREAM_WINDOW_MS = 15_000;
export const ARRANGEMENT_PREVIEW_MAX_STREAM_ASSET_BYTES = 64 * 1024 * 1024;
export const ARRANGEMENT_PREVIEW_STREAM_OVERHEAD_BYTES = 1 * 1024 * 1024;

export const ARRANGEMENT_PREVIEW_DECODE_HEADROOM_FACTOR = 3.5;
const FLOAT32_BYTES_PER_SAMPLE = Float32Array.BYTES_PER_ELEMENT;

export type ArrangementPreviewMemoryEstimate =
  | {
      ok: true;
      decodedBytes: number;
      estimatedPeakBytes: number;
    }
  | {
      ok: false;
      reason: "missing-metadata";
      assetId: string;
    }
  | {
      ok: false;
      reason: "asset-too-large";
      assetId: string;
      fileSizeBytes: number;
    };

export type ArrangementPreviewSegmentMemoryRequest = {
  assetId: string;
  durationMs: number;
  /** Bytes fetched for this PCM segment; only the largest is live during decode. */
  encodedBytes: number;
};

/**
 * decodeAudioData creates float32 PCM at the AudioContext's sample rate.
 * Chromium's measured renderer peak for a long encoded preview exceeded 3x
 * the retained PCM size, so reserve 3.5x plus the largest encoded file fetched
 * while retained PCM buffers are live.
 */
export function estimateArrangementPreviewMemory(
  assetIds: readonly string[],
  assets: readonly ArrangementPreviewAssetMetadata[],
  outputSampleRate: number,
): ArrangementPreviewMemoryEstimate {
  const byId = new Map(assets.map((asset) => [asset.id, asset]));
  const uniqueIds = [...new Set(assetIds)];
  if (!Number.isFinite(outputSampleRate) || outputSampleRate <= 0) {
    return { ok: false, reason: "missing-metadata", assetId: uniqueIds[0] ?? "unknown" };
  }

  let decodedBytes = 0;
  let largestEncodedFileBytes = 0;
  for (const assetId of uniqueIds) {
    const asset = byId.get(assetId);
    if (
      !asset ||
      !Number.isFinite(asset.durationSeconds) ||
      asset.durationSeconds <= 0 ||
      !Number.isInteger(asset.channels) ||
      asset.channels < 1
    ) {
      return { ok: false, reason: "missing-metadata", assetId };
    }
    const assetDecodedBytes = Math.ceil(
      asset.durationSeconds * outputSampleRate * asset.channels * FLOAT32_BYTES_PER_SAMPLE,
    );
    if (!Number.isFinite(assetDecodedBytes)) {
      return { ok: false, reason: "missing-metadata", assetId };
    }
    decodedBytes += assetDecodedBytes;
    largestEncodedFileBytes = Math.max(
      largestEncodedFileBytes,
      Number.isFinite(asset.fileSizeBytes) && asset.fileSizeBytes! > 0
        ? asset.fileSizeBytes!
        : 0,
    );
  }
  if (!Number.isFinite(decodedBytes)) {
    return { ok: false, reason: "missing-metadata", assetId: uniqueIds[0] ?? "unknown" };
  }

  return {
    ok: true,
    decodedBytes,
    estimatedPeakBytes: Math.ceil(decodedBytes * ARRANGEMENT_PREVIEW_DECODE_HEADROOM_FACTOR)
      + largestEncodedFileBytes,
  };
}

/**
 * Estimate bounded PCM preview windows plus buffers already retained for
 * scheduled windows. WAV ranges are decoded directly into AudioBuffers, so
 * the decoder headroom still covers browser-side copies and resampling.
 */
export function estimateArrangementPreviewSegmentMemory(
  segments: readonly ArrangementPreviewSegmentMemoryRequest[],
  assets: readonly ArrangementPreviewAssetMetadata[],
  outputSampleRate: number,
  retainedDecodedBytes = 0,
): ArrangementPreviewMemoryEstimate {
  const byId = new Map(assets.map((asset) => [asset.id, asset]));
  if (
    !Number.isFinite(outputSampleRate) ||
    outputSampleRate <= 0 ||
    !Number.isFinite(retainedDecodedBytes) ||
    retainedDecodedBytes < 0
  ) {
    return { ok: false, reason: "missing-metadata", assetId: segments[0]?.assetId ?? "unknown" };
  }

  let decodedBytes = retainedDecodedBytes;
  let largestEncodedFileBytes = 0;
  for (const segment of segments) {
    const asset = byId.get(segment.assetId);
    if (
      !asset ||
      !Number.isFinite(asset.sampleRate) ||
      asset.sampleRate <= 0 ||
      !Number.isFinite(asset.durationSeconds) ||
      asset.durationSeconds <= 0 ||
      !Number.isInteger(asset.channels) ||
      asset.channels < 1 ||
      !Number.isFinite(segment.durationMs) ||
      segment.durationMs <= 0 ||
      !Number.isFinite(segment.encodedBytes) ||
      segment.encodedBytes < 0
    ) {
      return { ok: false, reason: "missing-metadata", assetId: segment.assetId };
    }
    decodedBytes += Math.ceil(
      segment.durationMs / 1_000 *
      Math.max(outputSampleRate, asset.sampleRate) *
      asset.channels *
      FLOAT32_BYTES_PER_SAMPLE,
    );
    largestEncodedFileBytes = Math.max(largestEncodedFileBytes, segment.encodedBytes);
  }
  if (!Number.isFinite(decodedBytes)) {
    return { ok: false, reason: "missing-metadata", assetId: segments[0]?.assetId ?? "unknown" };
  }
  return {
    ok: true,
    decodedBytes,
    estimatedPeakBytes: Math.ceil(decodedBytes * ARRANGEMENT_PREVIEW_DECODE_HEADROOM_FACTOR)
      + largestEncodedFileBytes,
  };
}

/**
 * Media elements decode encoded files incrementally instead of materializing
 * full-duration AudioBuffers. Budget a conservative playback window per
 * stream, its encoded window, and per-element overhead; cap the source file
 * size before assigning it to a media element.
 */
export function estimateArrangementPreviewStreamingMemory(
  streamAssetIds: readonly string[],
  assets: readonly ArrangementPreviewAssetMetadata[],
  outputSampleRate: number,
): ArrangementPreviewMemoryEstimate {
  const byId = new Map(assets.map((asset) => [asset.id, asset]));
  if (!Number.isFinite(outputSampleRate) || outputSampleRate <= 0) {
    return { ok: false, reason: "missing-metadata", assetId: streamAssetIds[0] ?? "unknown" };
  }

  let decodedWindowBytes = 0;
  let encodedBytes = 0;
  for (const assetId of streamAssetIds) {
    const asset = byId.get(assetId);
    if (
      !asset ||
      !Number.isFinite(asset.sampleRate) ||
      asset.sampleRate <= 0 ||
      !Number.isFinite(asset.durationSeconds) ||
      asset.durationSeconds <= 0 ||
      !Number.isInteger(asset.channels) ||
      asset.channels < 1 ||
      !Number.isSafeInteger(asset.fileSizeBytes) ||
      asset.fileSizeBytes! <= 0
    ) {
      return { ok: false, reason: "missing-metadata", assetId };
    }
    if (asset.fileSizeBytes! > ARRANGEMENT_PREVIEW_MAX_STREAM_ASSET_BYTES) {
      return {
        ok: false,
        reason: "asset-too-large",
        assetId,
        fileSizeBytes: asset.fileSizeBytes!,
      };
    }
    const windowMs = Math.min(ARRANGEMENT_PREVIEW_STREAM_WINDOW_MS, asset.durationSeconds * 1_000);
    decodedWindowBytes += Math.ceil(
      windowMs / 1_000 *
      Math.max(outputSampleRate, asset.sampleRate) *
      asset.channels *
      FLOAT32_BYTES_PER_SAMPLE,
    );
    encodedBytes += asset.fileSizeBytes!;
  }
  if (!Number.isFinite(decodedWindowBytes) || !Number.isFinite(encodedBytes)) {
    return { ok: false, reason: "missing-metadata", assetId: streamAssetIds[0] ?? "unknown" };
  }

  const estimatedPeakBytes = Math.ceil(decodedWindowBytes * ARRANGEMENT_PREVIEW_DECODE_HEADROOM_FACTOR)
    + encodedBytes
    + streamAssetIds.length * ARRANGEMENT_PREVIEW_STREAM_OVERHEAD_BYTES;
  return {
    ok: true,
    decodedBytes: decodedWindowBytes,
    estimatedPeakBytes,
  };
}

export function arrangementPreviewBufferBytes(
  buffers: ReadonlyMap<string, Pick<AudioBuffer, "length" | "numberOfChannels">>,
) {
  let bytes = 0;
  for (const buffer of buffers.values()) {
    bytes += buffer.length * buffer.numberOfChannels * FLOAT32_BYTES_PER_SAMPLE;
  }
  return bytes;
}

/** Drop buffers whose asset IDs do not belong to the next arrangement. */
export function releaseInactiveArrangementPreviewBuffers<
  TBuffer extends Pick<AudioBuffer, "length" | "numberOfChannels">,
>(
  buffers: Map<string, TBuffer>,
  activeAssetIds: ReadonlySet<string>,
) {
  let releasedBytes = 0;
  for (const [assetId, buffer] of buffers) {
    if (activeAssetIds.has(assetId)) continue;
    releasedBytes += buffer.length * buffer.numberOfChannels * FLOAT32_BYTES_PER_SAMPLE;
    buffers.delete(assetId);
  }
  return releasedBytes;
}

export function formatArrangementPreviewMiB(bytes: number) {
  return Math.max(1, Math.ceil(bytes / (1024 * 1024)));
}
