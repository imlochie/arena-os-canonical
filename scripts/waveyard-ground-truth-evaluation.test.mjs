import assert from "node:assert/strict";
import test from "node:test";
import {
  buildEvaluationReport,
  evaluateTrack,
  validateGroundTruth,
} from "./waveyard-ground-truth-evaluation.mjs";

const hashes = {
  "another-one-bites-the-dust": "a".repeat(64),
  september: "b".repeat(64),
};

function recording(id, title, durationSeconds, adjudicated) {
  const resolved = {
    sectionSegments: [
      {
        startMs: 0,
        endMs: Math.round(durationSeconds * 1000),
        label: "unknown",
        certainty: "ambiguous",
      },
    ],
    vocalPhrases: [{ startMs: 500, endMs: 1500, certainty: "ambiguous" }],
    bedPairJudgments: [],
    disagreements: [],
    resolutionMethod:
      "Independent labels were compared and unresolved intervals retained as ambiguous.",
    ...adjudicated,
  };
  const independentReview = (reviewerId) => ({
    reviewerId,
    reviewedAt: "2026-11-12T11:00:00.000Z",
    sectionSegments: structuredClone(resolved.sectionSegments),
    vocalPhrases: structuredClone(resolved.vocalPhrases),
    bedPairJudgments: structuredClone(resolved.bedPairJudgments),
  });
  return {
    id,
    title,
    durationSeconds,
    sourceSha256: hashes[id],
    sourceFileName: `${id}.test-audio`,
    license: {
      licenseName: "Test fixture only",
      sourceUrl: "https://example.invalid/test-audio",
      rightsBasis: "synthetic unit-test data; not a real-song license claim",
    },
    independentReviews: [
      independentReview("reviewer-1"),
      independentReview("reviewer-2"),
    ],
    adjudicated: resolved,
  };
}

function dataset({ queen = {}, september = {} } = {}) {
  return {
    schemaVersion: 1,
    studyId: "waveyard-queen-earth-wind-fire-full-track-v1",
    status: "adjudicated",
    createdAt: "2026-11-12T12:00:00.000Z",
    annotationProtocol: {
      reviewMode: "independent-blind-then-adjudicated",
      reviewerCount: 2,
      intervalIoUThreshold: 0.5,
      minimumSectionCoverageFraction: 0.95,
    },
    recordings: [
      recording(
        "another-one-bites-the-dust",
        "Another One Bites the Dust",
        222.67,
        queen,
      ),
      recording("september", "September", 215.14, september),
    ],
  };
}

const queen = {
  sectionSegments: [
    { startMs: 0, endMs: 5000, label: "verse", certainty: "confident" },
    { startMs: 5000, endMs: 10000, label: "unknown", certainty: "ambiguous" },
    { startMs: 10000, endMs: 222670, label: "unknown", certainty: "ambiguous" },
  ],
  vocalPhrases: [
    { startMs: 500, endMs: 1500, certainty: "confident" },
    { startMs: 2500, endMs: 3500, certainty: "ambiguous" },
  ],
  bedPairJudgments: [
    {
      vocalSourceSha256: hashes["another-one-bites-the-dust"],
      bedSourceSha256: hashes.september,
      vocal: { startMs: 0, endMs: 5000 },
      bed: { startMs: 10000, endMs: 15000 },
      verdict: "useful",
    },
    {
      vocalSourceSha256: hashes["another-one-bites-the-dust"],
      bedSourceSha256: hashes.september,
      vocal: { startMs: 0, endMs: 5000 },
      bed: { startMs: 20000, endMs: 25000 },
      verdict: "not-useful",
    },
  ],
};

const validPredictions = {
  schemaVersion: 1,
  producer: "Waveyard production mashup route",
  producerRevision: "c".repeat(40),
  capturedAt: "2026-11-12T12:00:00.000Z",
  recordings: {
    "another-one-bites-the-dust": {
      sourceSha256: hashes["another-one-bites-the-dust"],
      vocalPhrases: [
        { startMs: 520, endMs: 1520 },
        { startMs: 2500, endMs: 3500 },
      ],
      sections: [
        { startMs: 0, endMs: 5000, label: "verse" },
        { startMs: 5000, endMs: 10000, label: "bridge" },
      ],
      donorWindows: [
        {
          vocalSourceSha256: hashes["another-one-bites-the-dust"],
          startMs: 0,
          endMs: 5000,
          rankedBedCandidates: [
            {
              bedSourceSha256: hashes.september,
              startMs: 10000,
              endMs: 15000,
              rank: 1,
            },
            {
              bedSourceSha256: hashes.september,
              startMs: 20000,
              endMs: 25000,
              rank: 2,
            },
          ],
        },
      ],
    },
    september: {
      sourceSha256: hashes.september,
      vocalPhrases: [],
      sections: [],
      donorWindows: [],
    },
  },
};

test("independent ground truth computes boundary, label, coverage, and adjudicated ranking metrics", () => {
  const data = dataset({ queen, september: {} });
  const result = buildEvaluationReport(data, validPredictions);
  assert.equal(result.status, "complete");
  const metrics = result.tracks[0].vocalPassageDetection;
  assert.equal(metrics.truePositives, 1);
  assert.equal(metrics.falsePositives, 0);
  assert.equal(metrics.falseNegatives, 0);
  assert.equal(metrics.ambiguousExcludedPredictionCount, 1);
  assert.equal(result.tracks[0].excludedAmbiguousVocalPhrases, 1);
  assert.equal(metrics.boundaryErrorMs.meanAbsoluteStartMs, 20);
  assert.equal(result.tracks[0].sectionClassification.evaluated, 1);
  assert.equal(result.tracks[0].sectionClassification.accuracy, 1);
  assert.equal(result.tracks[0].coverage.annotatedSectionSeconds, 222.67);
  assert.equal(result.tracks[0].bedCandidateRanking.top1Accuracy, 1);
  assert.equal(result.tracks[0].bedCandidateRanking.recallAtK, 1);
});

test("maximum-overlap matching handles repeated intervals without double-counting a reference", () => {
  const data = recording(
    "another-one-bites-the-dust",
    "Another One Bites the Dust",
    222.67,
    {
      sectionSegments: [],
      vocalPhrases: [
        { startMs: 0, endMs: 7000, certainty: "confident" },
        { startMs: 0, endMs: 10000, certainty: "confident" },
      ],
      bedPairJudgments: [],
    },
  );
  const result = evaluateTrack(data, {
    vocalPhrases: [
      { startMs: 0, endMs: 10000 },
      { startMs: 0, endMs: 7000 },
    ],
    sections: [],
    donorWindows: [],
  });
  assert.equal(result.vocalPassageDetection.truePositives, 2);
  assert.equal(result.vocalPassageDetection.falsePositives, 0);
  assert.equal(result.vocalPassageDetection.falseNegatives, 0);
});

test("ambiguous labels are excluded from classification and ambiguous pair judgments are never negatives", () => {
  const result = evaluateTrack(
    recording(
      "another-one-bites-the-dust",
      "Another One Bites the Dust",
      222.67,
      {
        sectionSegments: [
          { startMs: 0, endMs: 5000, label: "unknown", certainty: "ambiguous" },
        ],
        vocalPhrases: [],
        bedPairJudgments: [
          {
            vocalSourceSha256: hashes["another-one-bites-the-dust"],
            bedSourceSha256: hashes.september,
            vocal: { startMs: 0, endMs: 5000 },
            bed: { startMs: 10000, endMs: 15000 },
            verdict: "ambiguous",
          },
        ],
      },
    ),
    {
      vocalPhrases: [],
      sections: [{ startMs: 0, endMs: 5000, label: "chorus" }],
      donorWindows: [
        {
          vocalSourceId: "another-one-bites-the-dust",
          startMs: 0,
          endMs: 5000,
          rankedBedCandidates: [
            { bedSourceId: "september", startMs: 10000, endMs: 15000, rank: 1 },
          ],
        },
      ],
    },
  );
  assert.equal(result.sectionClassification.evaluated, 0);
  assert.equal(result.sectionClassification.accuracy, null);
  assert.equal(result.bedCandidateRanking.judgedWindows, 0);
  assert.equal(result.bedCandidateRanking.unjudgedWindows, 1);
  assert.equal(result.bedCandidateRanking.top1Accuracy, null);
});

test("unjudged rankings do not become negative labels and absent annotation remains explicitly pending", () => {
  const result = evaluateTrack(
    recording(
      "another-one-bites-the-dust",
      "Another One Bites the Dust",
      222.67,
      {
        sectionSegments: [],
        vocalPhrases: [],
        bedPairJudgments: [],
      },
    ),
    {
      vocalPhrases: [],
      sections: [],
      donorWindows: [
        {
          vocalSourceId: "another-one-bites-the-dust",
          startMs: 0,
          endMs: 5000,
          rankedBedCandidates: [
            { bedSourceId: "september", startMs: 10000, endMs: 15000, rank: 1 },
          ],
        },
      ],
    },
  );
  assert.equal(result.bedCandidateRanking.top1Accuracy, null);
  const pending = buildEvaluationReport(
    {
      schemaVersion: 1,
      studyId: "waveyard-queen-earth-wind-fire-full-track-v1",
      recordings: [
        {
          id: "another-one-bites-the-dust",
          title: "Another One Bites the Dust",
          durationSeconds: 222.67,
          sourceSha256: null,
          adjudicated: null,
        },
        {
          id: "september",
          title: "September",
          durationSeconds: 215.14,
          sourceSha256: null,
          adjudicated: null,
        },
      ],
    },
    { recordings: {} },
  );
  assert.equal(pending.status, "blocked");
  assert.equal(pending.tracks[0].status, "pending");
  assert.equal(pending.tracks[0].metrics, null);
  assert.ok(
    pending.validation.issues.some((issue) =>
      issue.includes("source SHA-256 missing"),
    ),
  );
});

test("low-coverage labels and missing rights block full-track metrics", () => {
  const incomplete = dataset({ queen, september: {} });
  incomplete.recordings[0].license = {
    licenseName: null,
    sourceUrl: null,
    rightsBasis: null,
  };
  incomplete.recordings[0].adjudicated.sectionSegments = [
    { startMs: 0, endMs: 10000, label: "unknown", certainty: "ambiguous" },
  ];
  const result = buildEvaluationReport(incomplete, validPredictions);
  assert.equal(result.status, "blocked");
  assert.equal(result.tracks[0].status, "blocked-ground-truth");
  assert.equal(result.tracks[0].metrics, null);
  assert.ok(result.validation.issues.some((issue) => issue.includes("95%")));
  assert.ok(
    result.validation.issues.some((issue) => issue.includes("rights basis")),
  );
});

test("prediction metrics require a capture timestamp and exact producer revision", () => {
  const predictions = structuredClone(validPredictions);
  predictions.producerRevision = null;
  const result = buildEvaluationReport(
    dataset({ queen, september: {} }),
    predictions,
  );
  assert.equal(result.status, "blocked");
  assert.equal(result.tracks[0].status, "blocked-prediction-provenance");
  assert.equal(result.tracks[0].metrics, null);
});

test("predictions are blocked when their source checksum differs from the annotation recording", () => {
  const predictions = structuredClone(validPredictions);
  predictions.recordings["another-one-bites-the-dust"].sourceSha256 =
    "c".repeat(64);
  predictions.recordings[
    "another-one-bites-the-dust"
  ].donorWindows[0].vocalSourceSha256 = "c".repeat(64);
  const result = buildEvaluationReport(
    dataset({ queen, september: {} }),
    predictions,
  );
  assert.equal(result.status, "blocked");
  assert.equal(result.tracks[0].status, "blocked-source-identity-mismatch");
  assert.equal(result.tracks[0].metrics, null);
});

test("dataset rejects bed intervals assigned to the wrong source timeline", () => {
  const data = dataset({
    queen: {
      ...queen,
      bedPairJudgments: [
        {
          ...queen.bedPairJudgments[0],
          bed: { startMs: 215140, endMs: 216000 },
        },
      ],
    },
  });
  assert.throws(() => validateGroundTruth(data), /outside its recording/);
});
