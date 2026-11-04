import assert from "node:assert/strict";
import test from "node:test";
import {
  ARRANGEMENT_PREVIEW_MEMORY_LIMIT_BYTES,
  arrangementPreviewBufferBytes,
  estimateArrangementPreviewMemory,
  estimateArrangementPreviewSegmentMemory,
  releaseInactiveArrangementPreviewBuffers,
  type ArrangementPreviewAssetMetadata,
} from "./arrangement-preview-memory";
import {
  parseHttpContentRange,
  parsePcm16WavHeader,
  pcm16WavSegmentRange,
} from "./arrangement-preview-segments";

function asset(
  id: string,
  durationSeconds: number,
  fileSizeBytes = 1_000_000,
): ArrangementPreviewAssetMetadata {
  return { id, durationSeconds, sampleRate: 44_100, channels: 2, fileSizeBytes };
}

test("full-file estimates flag long stereo sources for bounded-window preview", () => {
  const estimate = estimateArrangementPreviewMemory(
    ["long"],
    [asset("long", 300)],
    48_000,
  );

  assert.equal(estimate.ok, true);
  if (!estimate.ok) return;
  assert.ok(estimate.decodedBytes > 100_000_000);
  assert.ok(estimate.estimatedPeakBytes > ARRANGEMENT_PREVIEW_MEMORY_LIMIT_BYTES);
});

test("a 90-second encoded stereo preview stays within budget at 44.1 and 48 kHz", () => {
  for (const outputSampleRate of [44_100, 48_000]) {
    const estimate = estimateArrangementPreviewMemory(
      ["long-mp3"],
      [asset("long-mp3", 90, 1_800_000)],
      outputSampleRate,
    );

    assert.equal(estimate.ok, true);
    if (!estimate.ok) continue;
    assert.ok(estimate.decodedBytes > 30_000_000);
    assert.ok(estimate.estimatedPeakBytes < ARRANGEMENT_PREVIEW_MEMORY_LIMIT_BYTES);
  }
});

test("a four-minute encoded stereo preview is rejected before decode at 44.1 and 48 kHz", () => {
  for (const outputSampleRate of [44_100, 48_000]) {
    const estimate = estimateArrangementPreviewMemory(
      ["oversized-mp3"],
      [asset("oversized-mp3", 240, 4_000_000)],
      outputSampleRate,
    );

    assert.equal(estimate.ok, true);
    if (!estimate.ok) continue;
    assert.ok(estimate.decodedBytes > 80_000_000);
    assert.ok(estimate.estimatedPeakBytes > ARRANGEMENT_PREVIEW_MEMORY_LIMIT_BYTES);
  }
});

test("many audible long stems exceed the whole-file decode budget", () => {
  const ids = ["vocals", "bass", "drums", "melody"];
  const estimate = estimateArrangementPreviewMemory(
    ids,
    ids.map((id) => asset(id, 70)),
    48_000,
  );

  assert.equal(estimate.ok, true);
  if (!estimate.ok) return;
  assert.ok(estimate.estimatedPeakBytes > ARRANGEMENT_PREVIEW_MEMORY_LIMIT_BYTES);
});

test("muted tracks can be omitted from the budget and a shorter active set fits", () => {
  const allAssets = ["vocals", "bass", "drums", "melody"].map((id) => asset(id, 70));
  const estimate = estimateArrangementPreviewMemory(["vocals"], allAssets, 48_000);

  assert.equal(estimate.ok, true);
  if (!estimate.ok) return;
  assert.ok(estimate.estimatedPeakBytes < ARRANGEMENT_PREVIEW_MEMORY_LIMIT_BYTES);
});

test("switching arrangements releases inactive buffers but keeps shared donors", () => {
  const buffers = new Map([
    ["old-only", { length: 100, numberOfChannels: 2 }],
    ["shared", { length: 250, numberOfChannels: 2 }],
  ]);

  const released = releaseInactiveArrangementPreviewBuffers(
    buffers,
    new Set(["shared", "new-only"]),
  );

  assert.equal(released, 100 * 2 * Float32Array.BYTES_PER_ELEMENT);
  assert.deepEqual([...buffers.keys()], ["shared"]);
  assert.equal(arrangementPreviewBufferBytes(buffers), 250 * 2 * Float32Array.BYTES_PER_ELEMENT);
});

test("missing asset metadata fails closed instead of guessing a small decode", () => {
  assert.deepEqual(
    estimateArrangementPreviewMemory(["unknown"], [], 48_000),
    { ok: false, reason: "missing-metadata", assetId: "unknown" },
  );
});

function pcm16WavHeader(sampleRate = 44_100, channels = 2, frames = sampleRate * 60) {
  const dataBytes = frames * channels * 2;
  const bytes = new ArrayBuffer(44);
  const view = new DataView(bytes);
  const write = (offset: number, value: string) => {
    for (let index = 0; index < value.length; index += 1) view.setUint8(offset + index, value.charCodeAt(index));
  };
  write(0, "RIFF");
  view.setUint32(4, 36 + dataBytes, true);
  write(8, "WAVE");
  write(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, channels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * channels * 2, true);
  view.setUint16(32, channels * 2, true);
  view.setUint16(34, 16, true);
  write(36, "data");
  view.setUint32(40, dataBytes, true);
  return { bytes, fileSizeBytes: 44 + dataBytes, dataBytes };
}

test("PCM16 WAV ranges retain exact source timing and clamp at EOF", () => {
  const fixture = pcm16WavHeader(44_100, 2, 44_100 * 20);
  const header = parsePcm16WavHeader(fixture.bytes, fixture.fileSizeBytes);
  assert.ok(header);
  const range = pcm16WavSegmentRange(header, 7_250, 5_000);
  assert.ok(range);
  assert.equal(range.sourceOffsetMs, 7_250);
  assert.equal(range.durationMs, 5_000);
  assert.equal(range.byteStart, 44 + Math.floor(7.25 * 44_100) * 4);
  assert.equal(range.byteEnd - range.byteStart + 1, range.frameCount * 4);

  const final = pcm16WavSegmentRange(header, 19_500, 5_000);
  assert.ok(final);
  assert.equal(final.durationMs, 500);
  assert.equal(final.byteEnd, fixture.fileSizeBytes - 1);
  assert.equal(fixture.dataBytes, header.dataBytes);
});

test("PCM range parsing rejects unsupported WAVs and out-of-file segments", () => {
  const fixture = pcm16WavHeader(44_100, 1, 44_100);
  const unsupported = fixture.bytes.slice(0);
  new DataView(unsupported).setUint16(34, 24, true);
  assert.equal(parsePcm16WavHeader(unsupported, fixture.fileSizeBytes), null);

  const header = parsePcm16WavHeader(fixture.bytes, fixture.fileSizeBytes);
  assert.ok(header);
  assert.equal(pcm16WavSegmentRange(header, 1_000, 10), null);
  assert.equal(parsePcm16WavHeader(fixture.bytes, 43), null);
  assert.deepEqual(parseHttpContentRange("bytes 44-403/4096"), { start: 44, end: 403, total: 4096 });
  assert.equal(parseHttpContentRange("bytes 0-43/*"), null);
  assert.equal(parseHttpContentRange("bytes 0-4096/4096"), null);
});

test("preview segment budget includes retained windows and encoded range headroom", () => {
  const assets = ["v", "b", "d", "m"].map((id) => ({
    id,
    durationSeconds: 300,
    sampleRate: 48_000,
    channels: 2,
    fileSizeBytes: 300 * 48_000 * 2 * 2 + 44,
  }));
  const segments = assets.map((asset) => ({
    assetId: asset.id,
    durationMs: 4_000,
    encodedBytes: 4_000 * 48_000 / 1_000 * 2 * 2,
  }));
  const estimate = estimateArrangementPreviewSegmentMemory(segments, assets, 48_000, 24 * 1024 * 1024);
  assert.equal(estimate.ok, true);
  if (estimate.ok) {
    assert.equal(estimate.decodedBytes, 24 * 1024 * 1024 + 4 * 4_000 * 48_000 / 1_000 * 2 * 4);
    assert.ok(estimate.estimatedPeakBytes > estimate.decodedBytes);
    assert.ok(estimate.estimatedPeakBytes < ARRANGEMENT_PREVIEW_MEMORY_LIMIT_BYTES);
  }
  assert.deepEqual(
    estimateArrangementPreviewSegmentMemory(
      [{ assetId: "missing", durationMs: 4_000, encodedBytes: 1_000 }],
      assets,
      48_000,
    ),
    { ok: false, reason: "missing-metadata", assetId: "missing" },
  );
});
