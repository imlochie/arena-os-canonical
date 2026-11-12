import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";

export const GROUND_TRUTH_SCHEMA_VERSION = 1;
const INTERVAL_IOU_THRESHOLD = 0.5;
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
  "outro",
  "instrumental",
  "unknown",
]);
const BED_VERDICTS = new Set(["useful", "not-useful", "ambiguous"]);
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

export function validateGroundTruth(dataset) {
  assert.equal(
    dataset?.schemaVersion,
    GROUND_TRUTH_SCHEMA_VERSION,
    "Unsupported ground-truth schema version.",
  );
  assert.equal(
    dataset?.studyId,
    "waveyard-queen-earth-wind-fire-full-track-v1",
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
    dataset.annotationProtocol?.intervalIoUThreshold !== INTERVAL_IOU_THRESHOLD
  )
    issues.push(
      `annotation interval IoU threshold must be ${INTERVAL_IOU_THRESHOLD}`,
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
      Array.isArray(adjudicated.vocalPhrases),
      `${expected.id}: vocalPhrases must be an array.`,
    );
    assert.ok(
      Array.isArray(adjudicated.bedPairJudgments),
      `${expected.id}: bedPairJudgments must be an array.`,
    );
    if (
      !adjudicated.sectionSegments.length ||
      !adjudicated.vocalPhrases.length
    ) {
      issues.push(
        `${expected.id}: adjudicated section and vocal annotations must contain reviewed intervals`,
      );
    }
    for (const [index, section] of adjudicated.sectionSegments.entries()) {
      interval(
        section,
        `${expected.id} section ${index}`,
        expected.durationSeconds * 1000,
      );
      assert.ok(
        SECTION_LABELS.has(section.label),
        `${expected.id} section ${index}: unsupported or fabricated section label.`,
      );
      assert.ok(
        ["confident", "ambiguous"].includes(section.certainty),
        `${expected.id} section ${index}: certainty must be explicit.`,
      );
      if (section.label === "unknown")
        assert.equal(section.certainty, "ambiguous");
    }
    for (const [index, phrase] of adjudicated.vocalPhrases.entries()) {
      interval(
        phrase,
        `${expected.id} vocal phrase ${index}`,
        expected.durationSeconds * 1000,
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
        vocalTrack.durationSeconds * 1000,
      );
      interval(
        judgment.bed,
        `${expected.id} bed judgment ${index} bed`,
        bedTrack.durationSeconds * 1000,
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
          !Array.isArray(review.vocalPhrases) ||
          !Array.isArray(review.bedPairJudgments)
        ) {
          issues.push(
            `${expected.id}: each independent reviewer must submit all three annotation sets`,
          );
          continue;
        }
        if (!review.sectionSegments.length || !review.vocalPhrases.length) {
          issues.push(
            `${expected.id}: each independent reviewer must annotate sections and vocal phrases`,
          );
        }
        for (const [index, section] of review.sectionSegments.entries()) {
          interval(
            section,
            `${expected.id} reviewer section ${index}`,
            expected.durationSeconds * 1000,
          );
          assert.ok(
            SECTION_LABELS.has(section.label),
            `${expected.id} reviewer section ${index}: unsupported label.`,
          );
          assert.ok(
            ["confident", "ambiguous"].includes(section.certainty),
            `${expected.id} reviewer section ${index}: certainty must be explicit.`,
          );
          if (section.label === "unknown")
            assert.equal(section.certainty, "ambiguous");
        }
        for (const [index, phrase] of review.vocalPhrases.entries()) {
          interval(
            phrase,
            `${expected.id} reviewer vocal phrase ${index}`,
            expected.durationSeconds * 1000,
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
            vocalTrack.durationSeconds * 1000,
          );
          interval(
            judgment.bed,
            `${expected.id} reviewer bed judgment ${index} bed`,
            bedTrack.durationSeconds * 1000,
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

function maximumOverlapMatches(predictions, references, threshold) {
  const edges = predictions.map((prediction) =>
    references
      .map((reference, index) => ({
        index,
        overlap: intersectionOverUnion(prediction, reference),
      }))
      .filter((edge) => edge.overlap >= threshold)
      .sort(
        (left, right) =>
          right.overlap - left.overlap || left.index - right.index,
      ),
  );
  const referenceToPrediction = new Map();
  function augment(predictionIndex, visited) {
    for (const edge of edges[predictionIndex]) {
      if (visited.has(edge.index)) continue;
      visited.add(edge.index);
      const previous = referenceToPrediction.get(edge.index);
      if (previous === undefined || augment(previous, visited)) {
        referenceToPrediction.set(edge.index, predictionIndex);
        return true;
      }
    }
    return false;
  }
  for (let index = 0; index < predictions.length; index += 1)
    augment(index, new Set());
  return [...referenceToPrediction.entries()].map(
    ([referenceIndex, predictionIndex]) => ({
      prediction: predictions[predictionIndex],
      reference: references[referenceIndex],
      overlap: intersectionOverUnion(
        predictions[predictionIndex],
        references[referenceIndex],
      ),
    }),
  );
}

function safeRatio(numerator, denominator) {
  return denominator ? numerator / denominator : null;
}

function detectionMetrics(
  predictions,
  references,
  threshold,
  ambiguousReferences = [],
) {
  const matches = maximumOverlapMatches(predictions, references, threshold);
  const ambiguousPredictionIndexes = predictions
    .map((prediction, index) => ({ prediction, index }))
    .filter(
      ({ prediction }) =>
        !matches.some((match) => match.prediction === prediction) &&
        ambiguousReferences.some(
          (reference) =>
            intersectionOverUnion(prediction, reference) >= threshold,
        ),
    )
    .map(({ index }) => index);
  const ignoredPredictionIndexes = new Set(ambiguousPredictionIndexes);
  const unmatchedPredictionIndexes = predictions
    .map((_, index) => index)
    .filter(
      (index) =>
        !matches.some((match) => match.prediction === predictions[index]) &&
        !ignoredPredictionIndexes.has(index),
    );
  const falsePositives = unmatchedPredictionIndexes.length;
  const precision = safeRatio(matches.length, matches.length + falsePositives);
  const recall = safeRatio(matches.length, references.length);
  return {
    truePositives: matches.length,
    falsePositives,
    falseNegatives: references.length - matches.length,
    precision,
    recall,
    f1:
      precision === null || recall === null || precision + recall === 0
        ? null
        : (2 * precision * recall) / (precision + recall),
    ambiguousExcludedPredictionCount: ambiguousPredictionIndexes.length,
    boundaryErrorMs: matches.length
      ? {
          meanAbsoluteStartMs:
            matches.reduce(
              (sum, match) =>
                sum +
                Math.abs(match.prediction.startMs - match.reference.startMs),
              0,
            ) / matches.length,
          medianAbsoluteStartMs: median(
            matches.map((match) =>
              Math.abs(match.prediction.startMs - match.reference.startMs),
            ),
          ),
          meanAbsoluteEndMs:
            matches.reduce(
              (sum, match) =>
                sum + Math.abs(match.prediction.endMs - match.reference.endMs),
              0,
            ) / matches.length,
          medianAbsoluteEndMs: median(
            matches.map((match) =>
              Math.abs(match.prediction.endMs - match.reference.endMs),
            ),
          ),
        }
      : null,
    unmatchedPredictionIndexes,
    unmatchedReferenceIndexes: references
      .map((_, index) => index)
      .filter(
        (index) =>
          !matches.some((match) => match.reference === references[index]),
      ),
  };
}

function median(values) {
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2
    ? sorted[middle]
    : (sorted[middle - 1] + sorted[middle]) / 2;
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

function sectionClassification(predictions, references, threshold) {
  const eligible = references.filter(
    (reference) =>
      reference.certainty === "confident" && reference.label !== "unknown",
  );
  const matches = maximumOverlapMatches(predictions, eligible, threshold);
  const correct = matches.filter(
    (match) => match.prediction.label === match.reference.label,
  ).length;
  return {
    evaluated: matches.length,
    correct,
    accuracy: safeRatio(correct, matches.length),
    unmatchedConfidentReferences: eligible.length - matches.length,
    note: "Ambiguous/unknown references are excluded; this measures labels only, not musical compatibility.",
  };
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
  if (predictions?.schemaVersion !== 1)
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
    for (const key of ["vocalPhrases", "sections", "donorWindows"]) {
      if (!Array.isArray(recording[key]))
        issues.push(`${expected.id}: prediction ${key} must be an array`);
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
        expected.durationSeconds * 1000,
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
        interval(
          {
            startMs: candidate.startMs ?? candidate.bedStartMs,
            endMs: candidate.endMs ?? candidate.bedEndMs,
          },
          `${expected.id} bed candidate ${candidateIndex}`,
          bedTrack.durationSeconds * 1000,
        );
      }
    }
  }
  return { complete: issues.length === 0, issues };
}

export function evaluateTrack(recording, predictions, options = {}) {
  const iouThreshold = options.iouThreshold ?? 0.5;
  const topK = options.topK ?? 5;
  const adjudicated = recording.adjudicated;
  if (!adjudicated)
    return { status: "pending-independent-annotation", metrics: null };
  const predictedVocalPhrases = predictions.vocalPhrases ?? [];
  const predictedSections = predictions.sections ?? [];
  const vocalReferences = adjudicated.vocalPhrases ?? [];
  const sections = adjudicated.sectionSegments ?? [];
  const confidentlyLabeled = sections.filter(
    (section) =>
      section.label !== "unknown" && section.certainty === "confident",
  );
  const confidentVocalPhrases = vocalReferences.filter(
    (phrase) => phrase.certainty === "confident",
  );
  const confidentSectionBoundaries = sections.filter(
    (section) => section.certainty === "confident",
  );
  return {
    status: "evaluated",
    sourceIdentity: {
      sourceSha256: recording.sourceSha256,
      durationSeconds: recording.durationSeconds,
    },
    vocalPassageDetection: detectionMetrics(
      predictedVocalPhrases,
      confidentVocalPhrases,
      iouThreshold,
      vocalReferences.filter((phrase) => phrase.certainty === "ambiguous"),
    ),
    excludedAmbiguousVocalPhrases:
      vocalReferences.length - confidentVocalPhrases.length,
    sectionBoundaryDetection: detectionMetrics(
      predictedSections,
      confidentSectionBoundaries,
      iouThreshold,
      sections.filter((section) => section.certainty === "ambiguous"),
    ),
    excludedAmbiguousSectionBoundaries:
      sections.length - confidentSectionBoundaries.length,
    sectionClassification: sectionClassification(
      predictedSections,
      confidentlyLabeled,
      iouThreshold,
    ),
    bedCandidateRanking: candidateRanking(
      predictions.donorWindows ?? [],
      adjudicated.bedPairJudgments ?? [],
      topK,
      iouThreshold,
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
    schemaVersion: 1,
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
      intervalIoU: options.iouThreshold ?? 0.5,
      recallAtK: options.topK ?? 5,
    },
    tracks,
    interpretation:
      "Section detection/classification and candidate rankings are separate measurements. Neither establishes harmonic compatibility or perceived mashup quality. Null metrics mean evidence is missing, not zero performance.",
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
