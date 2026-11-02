import assert from "node:assert/strict";
import test from "node:test";

import { libraryConversionIdempotencyKey } from "./idempotency";

const request = {
  ownerId: "owner",
  originalTrackId: "track",
  sourceAssetId: "source",
  checksumSha256: "A".repeat(64),
  format: "mp3" as const,
  bitrate: 192,
};

test("conversion retries keep the same durable job identity", () => {
  assert.equal(libraryConversionIdempotencyKey(request), libraryConversionIdempotencyKey({
    ...request,
    checksumSha256: request.checksumSha256.toLowerCase(),
  }));
});

test("conversion identity separates owners, formats, and lossy bitrates", () => {
  const key = libraryConversionIdempotencyKey(request);
  assert.notEqual(key, libraryConversionIdempotencyKey({ ...request, ownerId: "other-owner" }));
  assert.notEqual(key, libraryConversionIdempotencyKey({ ...request, format: "aac" }));
  assert.notEqual(key, libraryConversionIdempotencyKey({ ...request, bitrate: 320 }));
});

test("lossless jobs ignore a bitrate that does not affect output", () => {
  const lossless = { ...request, format: "flac" as const };
  assert.equal(
    libraryConversionIdempotencyKey(lossless),
    libraryConversionIdempotencyKey({ ...lossless, bitrate: 320 }),
  );
});
