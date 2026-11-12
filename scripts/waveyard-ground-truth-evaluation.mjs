import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";

export const GROUND_TRUTH_SCHEMA_VERSION = 2;
const CANDIDATE_WINDOW_IOU_THRESHOLD = 0.5;
const SECTION_BOUNDARY_TOLERANCE_MS = 2_000;
const SOURCE_DURATION_METADATA_TOLERANCE_MS = 50;
const SECTION_COVERAGE_FRACTION = 0.95;
const REQUIRED_REVIEWER_COUNT = 2;
export const EXPECTED_RECORDINGS = [
  {
    id: "another-one-bites-the-dust",
    title: "Another One Bites the Dust",
    durationSeconds: 222.67,
  },
  { id: "september", title: "September", durationSeconds: 215.14 },
];
const SECTION_LABELS = new Set([
  "intro",
  "verse",
  "pre-chorus",
  "chorus",
  "bridge",
  "breakdown",
  "outro",
  "instrumental",
  "unknown",
]);
const BED_VERDICTS = new Set(["useful", "not-useful", "ambiguous"]);
const STRUCTURAL_EVENT_KINDS = new Set([
  "transition",
  "repetition",
  "arrangement-change",
]);
const sha256Pattern = /^[a-f0-9]{64}$/i;

function interval(value, label, maxDurationMs) {
  assert.ok(
    value &&
      Number.isSafeInteger(value.startMs) &&
      Number.isSafeInteger(value.endMs),
    `${label} needs integer millisecond bounds.`,
  );
  assert.ok(
    value.startMs >= 0 &&
      value.endMs > value.startMs &&
      value.endMs <= maxDurationMs,
    `${label} is outside its recording.`,
  );
}

function sectionBoundary(value, label, maxDurationMs) {
  assert.ok(
    value && Number.isSafeInteger(value.timeMs),
    `${label} needs an integer millisecond timestamp.`,
  );
  assert.ok(
    value.timeMs > 0 && value.timeMs < maxDurationMs,
    `${label} must be an internal boundary inside its recording.`,
  );
  assert.ok(
    ["confident", "ambiguous"].includes(value.certainty),
    `${label}: certainty must be explicit.`,
  );
}

function structuralEvent(value, label, maxDurationMs) {
  assert.ok(
    value && Number.isSafeInteger(value.timeMs),
    `${label} needs an integer millisecond timestamp.`,
  );
  assert.ok(
    value.timeMs > 0 && value.timeMs < maxDurationMs,
    `${label} must be inside its recording.`,
  );
  assert.ok(
    STRUCTURAL_EVENT_KINDS.has(value.kind),
    `${label} needs a supported structural event kind.`,
  );
  assert.ok(
    typeof value.description === "string" && value.description.trim(),
    `${label} needs a short listener-observed description.`,
  );
  assert.ok(
    ["confident", "ambiguous"].includes(value.certainty),
    `${label}: certainty must be explicit.`,
  );
}

export function validateGroundTruth(dataset) {
  assert.equal(
    dataset?.schemaVersion,
    GROUND_TRUTH_SCHEMA_VERSION,
    "Unsupported ground-truth schema version.",
  );
  assert.equal(
    dataset?.studyId,
    "waveyard-queen-earth-wind-fire-full-track-v2",
  );
  assert.ok(Array.isArray(dataset.recordings), "recordings must be an array.");
  const issues = [];
  const trackForSourceHash = (sourceSha256) => {
    const recording = dataset.recordings.find(
      (entry) => entry.sourceSha256 === sourceSha256,
    );
    return EXPECTED_RECORDINGS.find((entry) => entry.id === recording?.id);
  };
  if (
    new Set(
      dataset.recordings
        .map((entry) => entry.sourceSha256)
        .filter((value) => sha256Pattern.test(value ?? "")),
    ).size !== 2
  ) {
    issues.push(
      "both distinct source files must have unique SHA-256 identities",
    );
  }
  if (dataset.recordings.length !== EXPECTED_RECORDINGS.length)
    issues.push(
      `exactly ${EXPECTED_RECORDINGS.length} study recordings are required`,
    );
  if (
    dataset.annotationProtocol?.reviewMode !==
      "independent-blind-then-adjudicated" ||
    dataset.annotationProtocol?.reviewerCount !== REQUIRED_REVIEWER_COUNT
  )
    issues.push(
      "the dataset must declare two independent blind reviewers before adjudication",
    );
  if (
    dataset.annotationProtocol?.candidateWindowIoUThreshold !==
    CANDIDATE_WINDOW_IOU_THRESHOLD
  )
    issues.push(
      `candidate-window IoU threshold must be ${CANDIDATE_WINDOW_IOU_THRESHOLD}`,
    );
  if (
    dataset.annotationProtocol?.sectionBoundaryToleranceMs !==
    SECTION_BOUNDARY_TOLERANCE_MS
  )
    issues.push(
      `structural boundary tolerance must be ${SECTION_BOUNDARY_TOLERANCE_MS} ms`,
    );
  if (
    dataset.annotationProtocol?.minimumSectionCoverageFraction !==
    SECTION_COVERAGE_FRACTION
  )
    issues.push(
      `minimum section coverage must be ${SECTION_COVERAGE_FRACTION}`,
    );
  if (dataset.status !== "adjudicated")
    issues.push(
      "dataset status must be adjudicated after both blind reviews are locked",
    );
  if (!dataset.createdAt || Number.isNaN(Date.parse(dataset.createdAt)))
    issues.push("dataset creation/adjudication timestamp missing or invalid");
  for (const expected of EXPECTED_RECORDINGS) {
    const recording = dataset.recordings.find(
      (entry) => entry.id === expected.id,
    );
    if (!recording) {
      issues.push(`${expected.id}: recording entry missing`);
      continue;
    }
    assert.equal(
      recording.title,
      expected.title,
      `${expected.id}: recording title mismatch.`,
    );
    assert.ok(
      Math.abs(recording.durationSeconds - expected.durationSeconds) <= 0.05,
      `${expected.id}: duration mismatch.`,
    );
    if (!recording.sourceFileName)
      issues.push(`${expected.id}: exact source filename missing`);
    if (!sha256Pattern.test(recording.sourceSha256 ?? ""))
      issues.push(`${expected.id}: exact source SHA-256 missing`);
    if (
      !recording.license?.licenseName ||
      !recording.license?.sourceUrl ||
      !recording.license?.rightsBasis
    ) {
      issues.push(
        `${expected.id}: source attribution and documented rights basis missing`,
      );
    }
    if (recording.adjudicated === null || recording.adjudicated === undefined) {
      issues.push(`${expected.id}: independent adjudication missing`);
      continue;
    }
    const adjudicated = recording.adjudicated;
    assert.ok(
      Array.isArray(adjudicated.sectionSegments),
      `${expected.id}: sectionSegments must be an array.`,
    );
    assert.ok(
      Array.isArray(adjudicated.sectionBoundaries),
      `${expected.id}: sectionBoundaries must be an array.`,
    );
    assert.ok(
      Array.isArray(adjudicated.structuralEvents),
      `${expected.id}: structuralEvents must be an array.`,
    );
    assert.ok(
      Array.isArray(adjudicated.vocalPhraseIntervals),
      `${expected.id}: vocalPhraseIntervals must be an array.`,
    );
    assert.equal(
      adjudicated.structuralEventReviewComplete,
      true,
      `${expected.id}: adjudicated structural-event review must be marked complete.`,
    );
    assert.equal(
      adjudicated.vocalPhraseReviewComplete,
      true,
      `${expected.id}: adjudicated vocal-phrase review must be marked complete.`,
    );
    assert.ok(
      adjudicated.vocalPhraseIntervals.length > 0,
      `${expected.id}: at least one vocal phrase must be annotated for this vocal recording.`,
    );
    assert.ok(
      Array.isArray(adjudicated.bedPairJudgments),
      `${expected.id}: bedPairJudgments must be an array.`,
    );
    if (
      !adjudicated.sectionSegments.length ||
      !adjudicated.sectionBoundaries.length
    ) {
      issues.push(
        `${expected.id}: adjudicated section segments and structural boundaries must be reviewed`,
      );
    }
    for (const [index, section] of adjudicated.sectionSegments.entries()) {
      interval(
        section,
        `${expected.id} section ${index}`,
        expected.durationSeconds * 1000 + SOURCE_DURATION_METADATA_TOLERANCE_MS,
      );
      assert.ok(
        SECTION_LABELS.has(section.label),
        `${expected.id} section ${index}: unsupported or fabricated section label.`,
      );
      assert.ok(
        ["confident", "ambiguous"].includes(section.labelCertainty),
        `${expected.id} section ${index}: labelCertainty must be explicit.`,
      );
      if (section.label === "unknown")
        assert.equal(section.labelCertainty, "ambiguous");
    }
    for (const [index, boundary] of adjudicated.sectionBoundaries.entries()) {
      sectionBoundary(
        boundary,
        `${expected.id} section boundary ${index}`,
        expected.durationSeconds * 1000 + SOURCE_DURATION_METADATA_TOLERANCE_MS,
      );
    }
    for (const [index, event] of adjudicated.structuralEvents.entries()) {
      structuralEvent(
        event,
        `${expected.id} structural event ${index}`,
        expected.durationSeconds * 1000 + SOURCE_DURATION_METADATA_TOLERANCE_MS,
      );
    }
    for (const [index, phrase] of adjudicated.vocalPhraseIntervals.entries()) {
      interval(
        phrase,
        `${expected.id} vocal phrase ${index}`,
        expected.durationSeconds * 1000 + SOURCE_DURATION_METADATA_TOLERANCE_MS,
      );
      assert.ok(
        ["confident", "ambiguous"].includes(phrase.certainty),
        `${expected.id} vocal phrase ${index}: certainty must be explicit.`,
      );
    }
    if (
      coveredDurationMs(adjudicated.sectionSegments) <
      expected.durationSeconds * SECTION_COVERAGE_FRACTION * 1000
    ) {
      issues.push(
        `${expected.id}: adjudicated section review must cover at least 95% of the source; mark uncertain spans unknown rather than omitting them`,
      );
    }
    for (const [index, judgment] of adjudicated.bedPairJudgments.entries()) {
      const vocalTrack = trackForSourceHash(judgment.vocalSourceSha256);
      const bedTrack = trackForSourceHash(judgment.bedSourceSha256);
      if (!vocalTrack || !bedTrack || vocalTrack.id === bedTrack.id) {
        issues.push(
          `${expected.id} bed judgment ${index}: exact SHA-256 identities must name both different study recordings`,
        );
        continue;
      }
      interval(
        judgment.vocal,
        `${expected.id} bed judgment ${index} vocal`,
        vocalTrack.durationSeconds * 1000 +
          SOURCE_DURATION_METADATA_TOLERANCE_MS,
      );
      interval(
        judgment.bed,
        `${expected.id} bed judgment ${index} bed`,
        bedTrack.durationSeconds * 1000 + SOURCE_DURATION_METADATA_TOLERANCE_MS,
      );
      assert.ok(
        BED_VERDICTS.has(judgment.verdict),
        `${expected.id} bed judgment ${index}: unsupported verdict.`,
      );
    }
    const reviews = recording.independentReviews;
    if (
      !Array.isArray(reviews) ||
      reviews.length < 2 ||
      new Set(reviews.map((review) => review.reviewerId)).size < 2
    ) {
      issues.push(`${expected.id}: two distinct independent reviews missing`);
    } else {
      for (const review of reviews) {
        if (
          !review.reviewerId ||
          !review.reviewedAt ||
          Number.isNaN(Date.parse(review.reviewedAt)) ||
          !Array.isArray(review.sectionSegments) ||
          !Array.isArray(review.sectionBoundaries) ||
          !Array.isArray(review.structuralEvents) ||
          !Array.isArray(review.vocalPhraseIntervals) ||
          review.structuralEventReviewComplete !== true ||
          review.vocalPhraseReviewComplete !== true ||
          !Array.isArray(review.bedPairJudgments)
        ) {
          issues.push(
            `${expected.id}: each reviewer must submit section segments, structural events, vocal phrase intervals, explicit completion flags, and bed-pair judgments`,
          );
          continue;
        }
        if (
          !review.sectionSegments.length ||
          !review.sectionBoundaries.length ||
          !review.vocalPhraseIntervals.length
        ) {
          issues.push(
            `${expected.id}: each reviewer must annotate section segments, structural boundaries, and vocal phrases`,
          );
        }
        for (const [index, section] of review.sectionSegments.entries()) {
          interval(
            section,
            `${expected.id} reviewer section ${index}`,
            expected.durationSeconds * 1000 +
              SOURCE_DURATION_METADATA_TOLERANCE_MS,
          );
          assert.ok(
            SECTION_LABELS.has(section.label),
            `${expected.id} reviewer section ${index}: unsupported label.`,
          );
          assert.ok(
            ["confident", "ambiguous"].includes(section.labelCertainty),
            `${expected.id} reviewer section ${index}: labelCertainty must be explicit.`,
          );
          if (section.label === "unknown")
            assert.equal(section.labelCertainty, "ambiguous");
        }
        for (const [index, boundary] of review.sectionBoundaries.entries()) {
          sectionBoundary(
            boundary,
            `${expected.id} reviewer section boundary ${index}`,
            expected.durationSeconds * 1000 +
              SOURCE_DURATION_METADATA_TOLERANCE_MS,
          );
        }
        for (const [index, event] of review.structuralEvents.entries()) {
          structuralEvent(
            event,
            `${expected.id} reviewer structural event ${index}`,
            expected.durationSeconds * 1000 +
              SOURCE_DURATION_METADATA_TOLERANCE_MS,
          );
        }
        for (const [index, phrase] of review.vocalPhraseIntervals.entries()) {
          interval(
            phrase,
            `${expected.id} reviewer vocal phrase ${index}`,
            expected.durationSeconds * 1000 +
              SOURCE_DURATION_METADATA_TOLERANCE_MS,
          );
          assert.ok(
            ["confident", "ambiguous"].includes(phrase.certainty),
            `${expected.id} reviewer vocal phrase ${index}: certainty must be explicit.`,
          );
        }
        if (
          coveredDurationMs(review.sectionSegments) <
          expected.durationSeconds * SECTION_COVERAGE_FRACTION * 1000
        ) {
          issues.push(
            `${expected.id}: independent review ${review.reviewerId} must cover at least 95% of the source sections`,
          );
        }
        for (const [index, judgment] of review.bedPairJudgments.entries()) {
          const vocalTrack = trackForSourceHash(judgment.vocalSourceSha256);
          const bedTrack = trackForSourceHash(judgment.bedSourceSha256);
          if (!vocalTrack || !bedTrack || vocalTrack.id === bedTrack.id) {
            issues.push(
              `${expected.id} reviewer bed judgment ${index}: exact SHA-256 identities must name both different study recordings`,
            );
            continue;
          }
          interval(
            judgment.vocal,
            `${expected.id} reviewer bed judgment ${index} vocal`,
            vocalTrack.durationSeconds * 1000 +
              SOURCE_DURATION_METADATA_TOLERANCE_MS,
          );
          interval(
            judgment.bed,
            `${expected.id} reviewer bed judgment ${index} bed`,
            bedTrack.durationSeconds * 1000 +
              SOURCE_DURATION_METADATA_TOLERANCE_MS,
          );
          assert.ok(
            BED_VERDICTS.has(judgment.verdict),
            `${expected.id} reviewer bed judgment ${index}: unsupported verdict.`,
          );
        }
      }
    }
    if (
      !Array.isArray(adjudicated.disagreements) ||
      !adjudicated.resolutionMethod
    ) {
      issues.push(`${expected.id}: disagreement and resolution record missing`);
    }
  }
  return { complete: issues.length === 0, issues };
}

function intersectionOverUnion(left, right) {
  const intersection = Math.max(
    0,
    Math.min(left.endMs, right.endMs) - Math.max(left.startMs, right.startMs),
  );
  const union =
    Math.max(left.endMs, right.endMs) - Math.min(left.startMs, right.startMs);
  return union > 0 ? intersection / union : 0;
}

function safeRatio(numerator, denominator) {
  return denominator ? numerator / denominator : null;
}

function median(values) {
  if (!values.length) return null;
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2
    ? sorted[middle]
    : (sorted[middle - 1] + sorted[middle]) / 2;
}

function maximumBoundaryMatches(predictedTimes, referenceTimes, toleranceMs) {
  const predictions = predictedTimes
    .map((timeMs, index) => ({ timeMs, index }))
    .sort((left, right) => left.timeMs - right.timeMs);
  const references = referenceTimes
    .map((reference, index) => ({ ...reference, index }))
    .sort((left, right) => left.timeMs - right.timeMs);
  const memo = new Map();

  function solve(predictionIndex, referenceIndex) {
    if (
      predictionIndex >= predictions.length ||
      referenceIndex >= references.length
    ) {
      return { pairs: [], totalAbsoluteErrorMs: 0 };
    }
    const key = `${predictionIndex}:${referenceIndex}`;
    if (memo.has(key)) return memo.get(key);

    const options = [
      solve(predictionIndex + 1, referenceIndex),
      solve(predictionIndex, referenceIndex + 1),
    ];
    const prediction = predictions[predictionIndex];
    const reference = references[referenceIndex];
    const absoluteErrorMs = Math.abs(prediction.timeMs - reference.timeMs);
    if (absoluteErrorMs <= toleranceMs) {
      const matched = solve(predictionIndex + 1, referenceIndex + 1);
      options.push({
        pairs: [
          {
            predictionIndex: prediction.index,
            referenceIndex: reference.index,
            predictedMs: prediction.timeMs,
            referenceMs: reference.timeMs,
            signedErrorMs: prediction.timeMs - reference.timeMs,
          },
          ...matched.pairs,
        ],
        totalAbsoluteErrorMs: absoluteErrorMs + matched.totalAbsoluteErrorMs,
      });
    }
    options.sort(
      (left, right) =>
        right.pairs.length - left.pairs.length ||
        left.totalAbsoluteErrorMs - right.totalAbsoluteErrorMs,
    );
    memo.set(key, options[0]);
    return options[0];
  }

  return solve(0, 0).pairs;
}

function structuralBoundaryMetrics(
  predictedTimes,
  confidentReferences,
  ambiguousReferences,
  toleranceMs,
) {
  const matches = maximumBoundaryMatches(
    predictedTimes,
    confidentReferences,
    toleranceMs,
  );
  const matchedPredictionIndexes = new Set(
    matches.map((match) => match.predictionIndex),
  );
  const ambiguousExcludedPredictionIndexes = predictedTimes
    .map((_, index) => index)
    .filter(
      (index) =>
        !matchedPredictionIndexes.has(index) &&
        ambiguousReferences.some(
          (reference) =>
            Math.abs(predictedTimes[index] - reference.timeMs) <= toleranceMs,
        ),
    );
  const ignoredPredictionIndexes = new Set(ambiguousExcludedPredictionIndexes);
  const falsePositiveIndexes = predictedTimes
    .map((_, index) => index)
    .filter(
      (index) =>
        !matchedPredictionIndexes.has(index) &&
        !ignoredPredictionIndexes.has(index),
    );
  const falsePositives = falsePositiveIndexes.length;
  const precision = safeRatio(matches.length, matches.length + falsePositives);
  const recall = safeRatio(matches.length, confidentReferences.length);
  const absoluteErrorsMs = matches.map((match) =>
    Math.abs(match.signedErrorMs),
  );

  return {
    toleranceMs,
    predictedBoundaryCount: predictedTimes.length,
    confidentReferenceBoundaryCount: confidentReferences.length,
    truePositives: matches.length,
    falsePositives,
    falseNegatives: confidentReferences.length - matches.length,
    precision,
    recall,
    f1:
      precision === null || recall === null || precision + recall === 0
        ? null
        : (2 * precision * recall) / (precision + recall),
    ambiguousExcludedPredictionCount: ambiguousExcludedPredictionIndexes.length,
    timingErrorMs: matches.length
      ? {
          meanAbsoluteMs:
            absoluteErrorsMs.reduce((sum, value) => sum + value, 0) /
            matches.length,
          medianAbsoluteMs: median(absoluteErrorsMs),
          meanSignedMs:
            matches.reduce((sum, match) => sum + match.signedErrorMs, 0) /
            matches.length,
        }
      : null,
    matches,
    falsePositiveIndexes,
    unmatchedReferenceIndexes: confidentReferences
      .map((_, index) => index)
      .filter(
        (index) => !matches.some((match) => match.referenceIndex === index),
      ),
  };
}

function coveredDurationMs(intervals) {
  const sorted = [...intervals].sort(
    (left, right) => left.startMs - right.startMs,
  );
  let total = 0;
  let start = null;
  let end = null;
  for (const current of sorted) {
    if (start === null) {
      start = current.startMs;
      end = current.endMs;
    } else if (current.startMs <= end) {
      end = Math.max(end, current.endMs);
    } else {
      total += end - start;
      start = current.startMs;
      end = current.endMs;
    }
  }
  return total + (start === null ? 0 : end - start);
}

function candidateRanking(
  predictedWindows,
  judgments,
  topK,
  intervalThreshold,
) {
  const rows = [];
  const unjudgedWindowDetails = [];
  for (const window of predictedWindows) {
    const donorInterval = {
      startMs: window.startMs ?? window.donorStartMs,
      endMs: window.endMs ?? window.donorEndMs,
    };
    const matchingJudgments = judgments.filter(
      (judgment) =>
        judgment.vocalSourceSha256 === window.vocalSourceSha256 &&
        intersectionOverUnion(donorInterval, judgment.vocal) >=
          intervalThreshold,
    );
    const ranked = [...(window.rankedBedCandidates ?? [])].sort(
      (left, right) => left.rank - right.rank,
    );
    const usedJudgmentIndexes = new Set();
    const judgedCandidates = ranked.slice(0, topK).map((candidate) => {
      const bedInterval = {
        startMs: candidate.startMs ?? candidate.bedStartMs,
        endMs: candidate.endMs ?? candidate.bedEndMs,
      };
      const judgmentIndex = matchingJudgments.findIndex(
        (judgment, index) =>
          !usedJudgmentIndexes.has(index) &&
          judgment.bedSourceSha256 === candidate.bedSourceSha256 &&
          intersectionOverUnion(bedInterval, judgment.bed) >= intervalThreshold,
      );
      if (judgmentIndex >= 0) usedJudgmentIndexes.add(judgmentIndex);
      return {
        candidate,
        judgment: judgmentIndex >= 0 ? matchingJudgments[judgmentIndex] : null,
      };
    });
    const useful = matchingJudgments.filter(
      (judgment) => judgment.verdict === "useful",
    );
    const hasUnresolvedCandidate = judgedCandidates.some(
      (entry) => !entry.judgment || entry.judgment.verdict === "ambiguous",
    );
    if (!useful.length || hasUnresolvedCandidate) {
      unjudgedWindowDetails.push({
        vocalSourceSha256: window.vocalSourceSha256,
        startMs: donorInterval.startMs,
        endMs: donorInterval.endMs,
        reason: !useful.length
          ? "no adjudicated useful bed window for this donor passage"
          : "at least one ranked bed candidate is unjudged or ambiguous",
      });
      continue;
    }
    const retrievedUseful = judgedCandidates.filter(
      (entry) => entry.judgment.verdict === "useful",
    ).length;
    const top1 = judgedCandidates[0];
    rows.push({
      donorWindow: {
        vocalSourceSha256: window.vocalSourceSha256,
        ...donorInterval,
      },
      top1Correct: top1?.judgment.verdict === "useful",
      recallAtK: retrievedUseful / useful.length,
      usefulJudgments: useful.length,
      usefulRetrieved: retrievedUseful,
      firstUsefulRank:
        judgedCandidates.find((entry) => entry.judgment.verdict === "useful")
          ?.candidate.rank ?? null,
      rankedBedCandidates: judgedCandidates.map(({ candidate, judgment }) => ({
        rank: candidate.rank,
        bedSourceSha256: candidate.bedSourceSha256,
        bedStartMs: candidate.bedStartMs ?? candidate.startMs,
        bedEndMs: candidate.bedEndMs ?? candidate.endMs,
        relativeScore: candidate.relativeScore ?? null,
        verdict: judgment.verdict,
      })),
    });
  }
  const firstUsefulRanks = rows
    .map((row) => row.firstUsefulRank)
    .filter((rank) => rank !== null);
  return {
    judgedWindows: rows.length,
    unjudgedWindows: unjudgedWindowDetails.length,
    unjudgedWindowDetails,
    top1Accuracy: rows.length
      ? rows.filter((row) => row.top1Correct).length / rows.length
      : null,
    meanReciprocalRank: rows.length
      ? firstUsefulRanks.reduce((sum, rank) => sum + 1 / rank, 0) / rows.length
      : null,
    recallAtK: rows.length
      ? rows.reduce((sum, row) => sum + row.recallAtK, 0) / rows.length
      : null,
    k: topK,
    rows,
    evaluationUniverse:
      "adjudicated bed windows only; not every possible timestamp in the source track",
    note: "Unjudged or ambiguous ranked candidates are excluded from scored windows, never treated as negative. Analyzer scores are not relevance labels.",
  };
}

export function validatePredictionProvenance(predictions) {
  const issues = [];
  if (predictions?.schemaVersion !== 2)
    issues.push("prediction schema version missing or unsupported");
  if (predictions?.producer !== "Waveyard production mashup route")
    issues.push(
      "prediction producer must identify the production mashup route",
    );
  if (!/^[a-f0-9]{40}$/i.test(predictions?.producerRevision ?? ""))
    issues.push("exact 40-character producer revision missing");
  if (
    !predictions?.capturedAt ||
    Number.isNaN(Date.parse(predictions.capturedAt))
  )
    issues.push("prediction capture timestamp missing or invalid");
  const knownSourceHashes = new Set(
    EXPECTED_RECORDINGS.map(
      (expected) => predictions?.recordings?.[expected.id]?.sourceSha256,
    ).filter((value) => sha256Pattern.test(value ?? "")),
  );
  for (const expected of EXPECTED_RECORDINGS) {
    const recording = predictions?.recordings?.[expected.id];
    if (!recording) {
      issues.push(`${expected.id}: production prediction entry missing`);
      continue;
    }
    if (!sha256Pattern.test(recording.sourceSha256 ?? ""))
      issues.push(`${expected.id}: prediction source SHA-256 missing`);
    const expectedDurationMs = expected.durationSeconds * 1000;
    if (!Number.isSafeInteger(recording.sourceDurationMs)) {
      issues.push(`${expected.id}: source duration metadata is missing`);
    } else if (
      Math.abs(recording.sourceDurationMs - expectedDurationMs) >
      SOURCE_DURATION_METADATA_TOLERANCE_MS
    ) {
      issues.push(
        `${expected.id}: source duration differs from the pinned duration by more than ${SOURCE_DURATION_METADATA_TOLERANCE_MS} ms`,
      );
    }
    const sourceDurationMs = Number.isSafeInteger(recording.sourceDurationMs)
      ? recording.sourceDurationMs
      : expectedDurationMs;
    const maxEventTimeMs =
      sourceDurationMs + SOURCE_DURATION_METADATA_TOLERANCE_MS;
    for (const key of [
      "pitchContinuityRuns",
      "sectionBoundaries",
      "sections",
      "donorWindows",
    ]) {
      if (!Array.isArray(recording[key]))
        issues.push(`${expected.id}: prediction ${key} must be an array`);
    }
    for (const [runIndex, run] of (
      recording.pitchContinuityRuns ?? []
    ).entries()) {
      interval(
        run,
        `${expected.id} pitch-continuity run ${runIndex}`,
        maxEventTimeMs,
      );
    }
    const predictedSectionBoundaries = recording.sectionBoundaries ?? [];
    const predictedSections = recording.sections ?? [];
    for (const [
      boundaryIndex,
      timeMs,
    ] of predictedSectionBoundaries.entries()) {
      sectionBoundary(
        { timeMs, certainty: "confident" },
        `${expected.id} predicted section boundary ${boundaryIndex}`,
        sourceDurationMs,
      );
      if (
        boundaryIndex > 0 &&
        timeMs <= predictedSectionBoundaries[boundaryIndex - 1]
      ) {
        issues.push(
          `${expected.id}: structural boundary timestamps must be strictly increasing`,
        );
      }
      if (timeMs !== predictedSections[boundaryIndex + 1]?.startMs) {
        issues.push(
          `${expected.id}: structural boundary ${boundaryIndex} must equal the next section start`,
        );
      }
    }
    if (
      predictedSectionBoundaries.length !==
      Math.max(0, predictedSections.length - 1)
    ) {
      issues.push(
        `${expected.id}: each structural section transition must have exactly one boundary timestamp`,
      );
    }
    for (const [sectionIndex, section] of predictedSections.entries()) {
      const maximumEndMs =
        sourceDurationMs + SOURCE_DURATION_METADATA_TOLERANCE_MS;
      if (
        !Number.isSafeInteger(section.startMs) ||
        section.startMs >=
          sourceDurationMs + SOURCE_DURATION_METADATA_TOLERANCE_MS
      ) {
        issues.push(
          `${expected.id} structural section ${sectionIndex}: start must be within the source duration`,
        );
      }
      interval(
        section,
        `${expected.id} structural section ${sectionIndex}`,
        maximumEndMs,
      );
    }
    for (const [windowIndex, window] of (
      recording.donorWindows ?? []
    ).entries()) {
      if (window.vocalSourceSha256 !== recording.sourceSha256) {
        issues.push(
          `${expected.id} donor window ${windowIndex}: vocal source SHA-256 mismatch`,
        );
      }
      if (!Array.isArray(window.rankedBedCandidates)) {
        issues.push(
          `${expected.id} donor window ${windowIndex}: complete ranked candidate list missing`,
        );
        continue;
      }
      interval(
        {
          startMs: window.startMs ?? window.donorStartMs,
          endMs: window.endMs ?? window.donorEndMs,
        },
        `${expected.id} donor window ${windowIndex}`,
        maxEventTimeMs,
      );
      for (const [
        candidateIndex,
        candidate,
      ] of window.rankedBedCandidates.entries()) {
        if (candidate.rank !== candidateIndex + 1)
          issues.push(
            `${expected.id} donor window ${windowIndex}: ranks must be consecutive and start at 1`,
          );
        const bedTrack = EXPECTED_RECORDINGS.find(
          (track) =>
            track.id !== expected.id &&
            predictions?.recordings?.[track.id]?.sourceSha256 ===
              candidate.bedSourceSha256,
        );
        if (!knownSourceHashes.has(candidate.bedSourceSha256) || !bedTrack) {
          issues.push(
            `${expected.id} donor window ${windowIndex} candidate ${candidateIndex}: bed source SHA-256 must identify the other study recording`,
          );
          continue;
        }
        const bedSourceDurationMs =
          predictions.recordings[bedTrack.id].sourceDurationMs;
        if (!Number.isSafeInteger(bedSourceDurationMs)) {
          issues.push(
            `${expected.id} donor window ${windowIndex} candidate ${candidateIndex}: analyzed bed duration missing`,
          );
          continue;
        }
        interval(
          {
            startMs: candidate.startMs ?? candidate.bedStartMs,
            endMs: candidate.endMs ?? candidate.bedEndMs,
          },
          `${expected.id} bed candidate ${candidateIndex}`,
          bedSourceDurationMs + SOURCE_DURATION_METADATA_TOLERANCE_MS,
        );
      }
    }
  }
  return { complete: issues.length === 0, issues };
}

export function evaluateTrack(recording, predictions, options = {}) {
  const candidateIouThreshold =
    options.candidateIntervalIoU ?? CANDIDATE_WINDOW_IOU_THRESHOLD;
  const boundaryToleranceMs =
    options.sectionBoundaryToleranceMs ?? SECTION_BOUNDARY_TOLERANCE_MS;
  const topK = options.topK ?? 5;
  const adjudicated = recording.adjudicated;
  if (!adjudicated)
    return { status: "pending-independent-annotation", metrics: null };
  const sections = adjudicated.sectionSegments ?? [];
  const confidentlyLabeled = sections.filter(
    (section) =>
      section.label !== "unknown" && section.labelCertainty === "confident",
  );
  const confidentSectionBoundaries = (
    adjudicated.sectionBoundaries ?? []
  ).filter((boundary) => boundary.certainty === "confident");
  const ambiguousSectionBoundaries = (
    adjudicated.sectionBoundaries ?? []
  ).filter((boundary) => boundary.certainty === "ambiguous");
  const predictedSectionBoundaries = predictions.sectionBoundaries ?? [];
  const pitchContinuityRuns = predictions.pitchContinuityRuns ?? [];
  const structuralBoundaryDetection = structuralBoundaryMetrics(
    predictedSectionBoundaries,
    confidentSectionBoundaries,
    ambiguousSectionBoundaries,
    boundaryToleranceMs,
  );
  return {
    status: "evaluated",
    sourceIdentity: {
      sourceSha256: recording.sourceSha256,
      durationSeconds: recording.durationSeconds,
    },
    structuralBoundaryDetection,
    semanticSectionClassification: {
      status: "unavailable",
      accuracy: null,
      evaluated: 0,
      reason:
        "The production section engine emits structural windows and repetition labels, not semantic verse, chorus, bridge, or breakdown predictions.",
    },
    lyricPhraseTiming: {
      status: "unavailable",
      metrics: null,
      pitchContinuityRunCount: pitchContinuityRuns.length,
      humanReferencePhraseCount: (adjudicated.vocalPhraseIntervals ?? [])
        .length,
      reason:
        "Pitch-continuity runs are not lyric-phrase boundaries; the current pipeline does not produce word- or lyric-phrase timing predictions.",
    },
    humanAnnotationReference: {
      sectionSegmentCount: sections.length,
      structuralEventCount: (adjudicated.structuralEvents ?? []).length,
      structuralEventCounts: Object.fromEntries(
        [...STRUCTURAL_EVENT_KINDS].map((kind) => [
          kind,
          (adjudicated.structuralEvents ?? []).filter(
            (event) => event.kind === kind,
          ).length,
        ]),
      ),
      vocalPhraseIntervalCount: (adjudicated.vocalPhraseIntervals ?? []).length,
      note: "Human annotations are retained as reference data. They are not model metrics unless the production pipeline emits corresponding predictions.",
    },
    excludedAmbiguousSectionBoundaries: ambiguousSectionBoundaries.length,
    bedCandidateRanking: candidateRanking(
      predictions.donorWindows ?? [],
      adjudicated.bedPairJudgments ?? [],
      topK,
      candidateIouThreshold,
    ),
    coverage: {
      annotatedSectionSeconds: coveredDurationMs(sections) / 1000,
      recordingSeconds: recording.durationSeconds,
      fraction:
        coveredDurationMs(sections) / (recording.durationSeconds * 1000),
      confidentlyLabeledSectionSeconds:
        coveredDurationMs(confidentlyLabeled) / 1000,
    },
  };
}

export function buildEvaluationReport(dataset, predictions, options = {}) {
  const validation = validateGroundTruth(dataset);
  const predictionValidation = validatePredictionProvenance(predictions);
  const tracks = EXPECTED_RECORDINGS.map((expected) => {
    const recording = dataset.recordings.find(
      (entry) => entry.id === expected.id,
    );
    const trackPredictions = predictions.recordings?.[expected.id];
    if (!recording || !trackPredictions)
      return { id: expected.id, status: "pending", metrics: null };
    if (!validation.complete)
      return { id: expected.id, status: "blocked-ground-truth", metrics: null };
    if (!predictionValidation.complete)
      return {
        id: expected.id,
        status: "blocked-prediction-provenance",
        metrics: null,
      };
    if (
      !sha256Pattern.test(recording.sourceSha256 ?? "") ||
      trackPredictions.sourceSha256 !== recording.sourceSha256
    ) {
      return {
        id: expected.id,
        status: "blocked-source-identity-mismatch",
        metrics: null,
      };
    }
    return {
      id: expected.id,
      ...evaluateTrack(recording, trackPredictions, options),
    };
  });
  return {
    schemaVersion: 2,
    studyId: dataset.studyId,
    sourceManifest: EXPECTED_RECORDINGS.map((expected) => {
      const recording = dataset.recordings.find(
        (entry) => entry.id === expected.id,
      );
      return {
        id: expected.id,
        title: expected.title,
        expectedDurationSeconds: expected.durationSeconds,
        sourceFileName: recording?.sourceFileName ?? null,
        durationSeconds: recording?.durationSeconds ?? null,
        sourceSha256: recording?.sourceSha256 ?? null,
        rightsEvidencePresent: Boolean(
          recording?.license?.licenseName &&
          recording.license?.sourceUrl &&
          recording.license?.rightsBasis,
        ),
      };
    }),
    producerCapture: {
      producer: predictions?.producer ?? null,
      producerRevision: predictions?.producerRevision ?? null,
      capturedAt: predictions?.capturedAt ?? null,
    },
    status:
      validation.complete &&
      predictionValidation.complete &&
      tracks.every(
        (track) =>
          track.status === "evaluated" &&
          track.bedCandidateRanking?.unjudgedWindows === 0,
      ) &&
      tracks.some(
        (track) => (track.bedCandidateRanking?.judgedWindows ?? 0) > 0,
      )
        ? "complete"
        : "blocked",
    validation,
    predictionValidation,
    thresholds: {
      candidateWindowIoU:
        options.candidateIntervalIoU ?? CANDIDATE_WINDOW_IOU_THRESHOLD,
      sectionBoundaryToleranceMs:
        options.sectionBoundaryToleranceMs ?? SECTION_BOUNDARY_TOLERANCE_MS,
      recallAtK: options.topK ?? 5,
    },
    tracks,
    interpretation:
      "Structural boundary detection and semantic section classification are separate: semantic classification is unavailable until the producer emits semantic labels. Pitch-continuity runs are not lyric phrases and are not scored as such. Candidate rankings do not establish harmonic compatibility or perceived mashup quality. Null metrics mean evidence is missing, not zero performance.",
  };
}

async function main() {
  const [datasetPath, predictionsPath, outputPath] = process.argv.slice(2);
  assert.ok(
    datasetPath && predictionsPath && outputPath,
    "Usage: node scripts/waveyard-ground-truth-evaluation.mjs <dataset.json> <predictions.json> <report.json>",
  );
  const dataset = JSON.parse(await readFile(resolve(datasetPath), "utf8"));
  const predictions = JSON.parse(
    await readFile(resolve(predictionsPath), "utf8"),
  );
  const report = buildEvaluationReport(dataset, predictions);
  const resolvedOutputPath = resolve(outputPath);
  await mkdir(dirname(resolvedOutputPath), { recursive: true });
  await writeFile(resolvedOutputPath, `${JSON.stringify(report, null, 2)}\n`);
  console.log(
    `Evaluation report written (${report.status}): ${resolve(outputPath)}`,
  );
  if (report.status !== "complete") {
    const pendingEvidence = [
      ...report.validation.issues,
      ...report.predictionValidation.issues,
      ...report.tracks.flatMap((track) =>
        (track.bedCandidateRanking?.unjudgedWindowDetails ?? []).map(
          (window) =>
            `${track.id}: donor window ${window.startMs}-${window.endMs} ms is unjudged (${window.reason})`,
        ),
      ),
    ];
    console.log(
      `Pending evidence: ${pendingEvidence.join("; ") || "full-metric coverage criteria were not met"}`,
    );
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
)
  await main();
