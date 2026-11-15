import assert from "node:assert/strict";
import test from "node:test";
import {
  createReviewPackets,
  mergeReviewPackets,
} from "./waveyard-harmonic-annotation-packets.mjs";

const sourceSha256 = "a".repeat(64);

function template() {
  return {
    schemaVersion: 1,
    studyId: "test-study",
    annotationProtocol: { minimumCoverageFraction: 0.95 },
    recordings: [
      {
        id: "known-song",
        title: "A known song",
        partition: "held-out",
        durationMs: 1000,
        sourceSha256,
      },
    ],
    annotations: [
      {
        recordingId: "known-song",
        sourceSha256,
        reviewers: [
          {
            reviewerId: null,
            lockedAt: null,
            complete: false,
            coverageMs: 0,
            intervals: [],
            changePoints: [],
          },
          {
            reviewerId: null,
            lockedAt: null,
            complete: false,
            coverageMs: 0,
            intervals: [],
            changePoints: [],
          },
        ],
        adjudicated: null,
      },
    ],
  };
}

function lockedPackets() {
  const packets = createReviewPackets(template());
  return packets.map((packet, index) => ({
    ...packet,
    reviewerId: `reviewer-${index + 1}`,
    rightsBasis: "Owner-authorized local annotation",
    recordings: packet.recordings.map((recording) => ({
      ...recording,
      complete: true,
      coverageMs: 1000,
      lockedAt: "2026-11-15T00:00:00.000Z",
      intervals: [
        {
          startMs: 0,
          endMs: 1000,
          root: "C",
          quality: "major",
          certainty: "confident",
        },
      ],
      changePoints: [],
    })),
  }));
}

test("prepared packets contain exact source IDs but omit titles, partitions and predictions", () => {
  const packets = createReviewPackets(template());
  assert.equal(packets.length, 2);
  for (const packet of packets) {
    assert.equal(packet.blind, true);
    assert.equal(packet.predictionsIncluded, false);
    assert.equal(packet.recordings[0].sourceSha256, sourceSha256);
    assert.equal(packet.recordings[0].durationMs, 1000);
    assert.equal("title" in packet.recordings[0], false);
    assert.equal("partition" in packet.recordings[0], false);
    assert.deepEqual(packet.recordings[0].intervals, []);
  }
});

test("two locked independent packets merge by verified hash and remain awaiting adjudication", () => {
  const merged = mergeReviewPackets(template(), lockedPackets());
  assert.deepEqual(
    merged.annotations[0].reviewers.map((reviewer) => reviewer.reviewerId),
    ["reviewer-1", "reviewer-2"],
  );
  assert.equal(merged.annotations[0].adjudicated, null);
  assert.equal(
    merged.annotations[0].reviewers[0].rightsBasis,
    "Owner-authorized local annotation",
  );
});

test("merge rejects duplicate reviewers, incomplete locks, insufficient coverage and altered hashes", () => {
  const packets = lockedPackets();
  assert.throws(
    () =>
      mergeReviewPackets(template(), [
        packets[0],
        { ...packets[1], reviewerId: packets[0].reviewerId },
      ]),
    /distinct IDs/,
  );
  assert.throws(
    () =>
      mergeReviewPackets(template(), [
        packets[0],
        {
          ...packets[1],
          recordings: [{ ...packets[1].recordings[0], lockedAt: null }],
        },
      ]),
    /complete and locked/,
  );
  assert.throws(
    () =>
      mergeReviewPackets(template(), [
        packets[0],
        {
          ...packets[1],
          recordings: [
            {
              ...packets[1].recordings[0],
              coverageMs: 900,
              intervals: [
                {
                  startMs: 0,
                  endMs: 900,
                  root: "C",
                  quality: "major",
                  certainty: "confident",
                },
              ],
            },
          ],
        },
      ]),
    /coverage policy/,
  );
  assert.throws(
    () =>
      mergeReviewPackets(template(), [
        packets[0],
        {
          ...packets[1],
          recordings: [{ ...packets[1].recordings[0], coverageMs: 900 }],
        },
      ]),
    /coverage does not match its intervals/,
  );
  assert.throws(
    () =>
      mergeReviewPackets(template(), [
        packets[0],
        {
          ...packets[1],
          recordings: [
            { ...packets[1].recordings[0], sourceSha256: "b".repeat(64) },
          ],
        },
      ]),
    /unknown or duplicate source hash/,
  );
});

test("merge refuses to overwrite existing independent review evidence", () => {
  const existing = template();
  existing.annotations[0].reviewers[0] = {
    reviewerId: "old",
    lockedAt: "2026-11-14T00:00:00.000Z",
    complete: true,
    coverageMs: 1000,
    intervals: [{ startMs: 0, endMs: 1000, root: "C", quality: "major" }],
    changePoints: [],
  };
  assert.throws(
    () => mergeReviewPackets(existing, lockedPackets()),
    /Refusing to overwrite/,
  );
});
