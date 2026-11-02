export type ArrangementPreviewAssetMetadata = {
  id: string;
  durationSeconds: number;
  sampleRate: number;
  channels: number;
  fileSizeBytes?: number;
};

export const ARRANGEMENT_PREVIEW_MEMORY_LIMIT_BYTES = 128 * 1024 * 1024;

const DECODE_HEADROOM_FACTOR = 1.25;
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
    };

/**
 * decodeAudioData creates float32 PCM at the AudioContext's sample rate.
 * Reserve extra room for decoder working memory and the largest encoded file
 * that is fetched while the retained PCM buffers are live.
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
      !Number.isFinite(asset.channels) ||
      asset.channels <= 0
    ) {
      return { ok: false, reason: "missing-metadata", assetId };
    }
    decodedBytes += Math.ceil(
      asset.durationSeconds * outputSampleRate * asset.channels * FLOAT32_BYTES_PER_SAMPLE,
    );
    largestEncodedFileBytes = Math.max(
      largestEncodedFileBytes,
      Number.isFinite(asset.fileSizeBytes) && asset.fileSizeBytes! > 0
        ? asset.fileSizeBytes!
        : 0,
    );
  }

  return {
    ok: true,
    decodedBytes,
    estimatedPeakBytes: Math.ceil(decodedBytes * DECODE_HEADROOM_FACTOR) + largestEncodedFileBytes,
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
