import { createHash } from "node:crypto";

import { CONVERSION_FORMATS, type ConversionFormat } from "./engine";

export function libraryConversionIdempotencyKey(input: {
  ownerId: string;
  originalTrackId: string;
  sourceAssetId: string;
  checksumSha256: string;
  format: ConversionFormat;
  bitrate: number;
}) {
  return createHash("sha256").update(JSON.stringify([
    input.ownerId,
    input.originalTrackId,
    input.sourceAssetId,
    input.checksumSha256.toLowerCase(),
    input.format,
    CONVERSION_FORMATS[input.format].lossy ? input.bitrate : null,
  ])).digest("hex");
}
