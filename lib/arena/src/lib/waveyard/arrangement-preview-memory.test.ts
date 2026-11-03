import assert from "node:assert/strict";
import test from "node:test";
import {
  ARRANGEMENT_PREVIEW_MEMORY_LIMIT_BYTES,
  arrangementPreviewBufferBytes,
  estimateArrangementPreviewMemory,
  releaseInactiveArrangementPreviewBuffers,
  type ArrangementPreviewAssetMetadata,
} from "./arrangement-preview-memory";

function asset(
  id: string,
  durationSeconds: number,
  fileSizeBytes = 1_000_000,
): ArrangementPreviewAssetMetadata {
  return { id, durationSeconds, sampleRate: 44_100, channels: 2, fileSizeBytes };
}

test("long stereo previews reserve decoder headroom and are rejected before decode", () => {
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

test("many audible long stems exceed the bounded preview budget", () => {
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
