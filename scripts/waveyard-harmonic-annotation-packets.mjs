#!/usr/bin/env node
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { resolve } from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";

const ROOTS = new Set([
  "C",
  "C#",
  "D",
  "D#",
  "E",
  "F",
  "F#",
  "G",
  "G#",
  "A",
  "A#",
  "B",
]);
const QUALITIES = new Set([
  "major",
  "minor",
  "dominant7",
  "minor7",
  "major7",
  "diminished",
  "augmented",
  "unknown",
]);

function validateTemplate(template) {
  if (
    !template ||
    !Array.isArray(template.recordings) ||
    template.recordings.length === 0
  )
    throw new Error("Template must contain at least one recording");
  const hashes = new Set();
  for (const recording of template.recordings) {
    if (
      !recording.id ||
      !/^[a-f0-9]{64}$/i.test(recording.sourceSha256 ?? "") ||
      !Number.isFinite(recording.durationMs)
    )
      throw new Error(
        `Recording metadata is incomplete: ${recording.id ?? "unknown"}`,
      );
    if (hashes.has(recording.sourceSha256))
      throw new Error(`Duplicate source hash: ${recording.sourceSha256}`);
    hashes.add(recording.sourceSha256);
  }
}

export function createReviewPackets(template) {
  validateTemplate(template);
  const packets = [1, 2].map((reviewerNumber) => ({
    schemaVersion: 1,
    studyId: template.studyId,
    packetId: `${template.studyId}-reviewer-${reviewerNumber}`,
    reviewerSlot: reviewerNumber,
    reviewerId: null,
    rightsBasis: null,
    blind: true,
    predictionsIncluded: false,
    instructions:
      "Annotate each exact recording independently. Do not consult analyzer predictions or another review. Enter reviewerId and rightsBasis; complete every timeline and change point. Set complete=true and lockedAt only after review is finished. Return this JSON file unchanged after locking.",
    recordings: template.recordings.map((recording, index) => ({
      recordingKey: `recording-${String(index + 1).padStart(2, "0")}`,
      sourceSha256: recording.sourceSha256,
      durationMs: recording.durationMs,
      complete: false,
      coverageMs: 0,
      lockedAt: null,
      intervals: [],
      changePoints: [],
    })),
  }));
  return packets;
}

function validatePacket(packet, template, expectedSlot) {
  const expectedPacketId = `${template.studyId}-reviewer-${expectedSlot}`;
  if (
    packet?.schemaVersion !== 1 ||
    packet.studyId !== template.studyId ||
    packet.packetId !== expectedPacketId ||
    packet.reviewerSlot !== expectedSlot ||
    packet.blind !== true ||
    packet.predictionsIncluded !== false
  )
    throw new Error("Review packet identity or blinding metadata is invalid");
  if (typeof packet.reviewerId !== "string" || packet.reviewerId.trim() === "")
    throw new Error("Reviewer ID is required");
  if (
    typeof packet.rightsBasis !== "string" ||
    packet.rightsBasis.trim() === ""
  )
    throw new Error("Reviewer rights basis is required");
  if (
    !Array.isArray(packet.recordings) ||
    packet.recordings.length !== template.recordings.length
  )
    throw new Error(
      "Review packet must include every pinned recording exactly once",
    );
  const byHash = new Map(
    template.recordings.map((recording) => [recording.sourceSha256, recording]),
  );
  const seen = new Set();
  const minimumCoverage =
    template.annotationProtocol?.minimumCoverageFraction ?? 0.95;
  for (const review of packet.recordings) {
    const recording = byHash.get(review.sourceSha256);
    if (!recording || seen.has(review.sourceSha256))
      throw new Error("Review packet has an unknown or duplicate source hash");
    seen.add(review.sourceSha256);
    if (
      review.complete !== true ||
      !Number.isFinite(Date.parse(review.lockedAt ?? ""))
    )
      throw new Error(
        `Review for ${review.recordingKey ?? review.sourceSha256} must be complete and locked`,
      );
    if (
      !Array.isArray(review.intervals) ||
      review.intervals.length === 0 ||
      !Array.isArray(review.changePoints)
    )
      throw new Error(
        `Review for ${review.recordingKey ?? review.sourceSha256} is missing labels`,
      );
    let previousEnd = 0;
    for (const interval of review.intervals) {
      if (
        !Number.isFinite(interval.startMs) ||
        !Number.isFinite(interval.endMs) ||
        interval.startMs < previousEnd ||
        interval.endMs <= interval.startMs ||
        interval.endMs > recording.durationMs
      )
        throw new Error(
          `Review for ${review.recordingKey ?? review.sourceSha256} has invalid interval bounds`,
        );
      if (
        !QUALITIES.has(interval.quality) ||
        (interval.quality === "unknown") !== (interval.root === null) ||
        (interval.root !== null && !ROOTS.has(interval.root))
      )
        throw new Error(
          `Review for ${review.recordingKey ?? review.sourceSha256} has an invalid chord label`,
        );
      previousEnd = interval.endMs;
    }
    const measuredCoverageMs = review.intervals.reduce(
      (total, interval) => total + interval.endMs - interval.startMs,
      0,
    );
    if (
      !Number.isFinite(review.coverageMs) ||
      Math.abs(review.coverageMs - measuredCoverageMs) > 1
    )
      throw new Error(
        `Review for ${review.recordingKey ?? review.sourceSha256} coverage does not match its intervals`,
      );
    if (measuredCoverageMs < recording.durationMs * minimumCoverage)
      throw new Error(
        `Review for ${review.recordingKey ?? review.sourceSha256} does not meet coverage policy`,
      );
    for (const point of review.changePoints) {
      if (
        !Number.isFinite(point.timeMs) ||
        point.timeMs < 0 ||
        point.timeMs > recording.durationMs
      )
        throw new Error(
          `Review for ${review.recordingKey ?? review.sourceSha256} has an invalid change point`,
        );
    }
  }
}

export function mergeReviewPackets(template, packets) {
  validateTemplate(template);
  if (!Array.isArray(packets) || packets.length !== 2)
    throw new Error("Exactly two independent review packets are required");
  for (let index = 0; index < packets.length; index += 1) validatePacket(packets[index], template, index + 1);
  if (packets[0].reviewerId === packets[1].reviewerId)
    throw new Error("Reviewers must have distinct IDs");
  const sourceByHash = new Map(
    template.recordings.map((recording) => [recording.sourceSha256, recording]),
  );
  const annotationByHash = new Map(
    (template.annotations ?? []).map((annotation) => [
      annotation.sourceSha256,
      annotation,
    ]),
  );
  const merged = structuredClone(template);
  for (const annotation of merged.annotations ?? []) {
    const original = annotationByHash.get(annotation.sourceSha256);
    if (
      original?.reviewers?.some(
        (reviewer) =>
          reviewer?.complete ||
          reviewer?.lockedAt ||
          reviewer?.intervals?.length,
      ) ||
      original?.adjudicated
    )
      throw new Error("Refusing to overwrite existing reviews or adjudication");
  }
  const disagreementQueue = [];
  merged.annotations = template.recordings.map((recording) => {
    const existing = annotationByHash.get(recording.sourceSha256);
    if (!existing)
      throw new Error(`Template annotation slot missing for ${recording.id}`);
    const reviews = packets.map((packet) => {
      const review = packet.recordings.find((entry) => entry.sourceSha256 === recording.sourceSha256);
      if (!review) throw new Error(`Reviewer ${packet.reviewerId} omitted ${recording.id}`);
      return { reviewerId: packet.reviewerId, rightsBasis: packet.rightsBasis, lockedAt: review.lockedAt,
        complete: true, coverageMs: review.intervals.reduce((total, interval) => total + interval.endMs - interval.startMs, 0),
        intervals: review.intervals, changePoints: review.changePoints };
    });
    const boundaries = [...new Set(reviews.flatMap((review) => review.intervals.flatMap((interval) => [interval.startMs, interval.endMs])))].sort((a, b) => a - b);
    for (let index = 1; index < boundaries.length; index += 1) {
      const startMs = boundaries[index - 1]; const endMs = boundaries[index]; const midpoint = (startMs + endMs) / 2;
      const labels = reviews.map((review) => review.intervals.find((interval) => interval.startMs <= midpoint && midpoint < interval.endMs) ?? null)
        .map((interval) => interval ? (interval.root === null ? "unknown" : `${interval.root}:${interval.quality}`) : "unlabeled");
      if (labels[0] !== labels[1]) {
        const previous = disagreementQueue.at(-1);
        if (previous?.recordingId === recording.id && previous.endMs === startMs && previous.reviewerLabels[0] === labels[0] && previous.reviewerLabels[1] === labels[1]) previous.endMs = endMs;
        else disagreementQueue.push({ recordingId: recording.id, sourceSha256: recording.sourceSha256, startMs, endMs, reviewerLabels: labels, status: "requires-human-adjudication" });
      }
    }
    return {
      ...existing,
      reviewers: reviews,
      adjudicated: null,
    };
  });
  merged.reviewMerge = { status: "awaiting-human-adjudication", reviewerIds: packets.map((packet) => packet.reviewerId),
    identityVerification: "reviewer IDs are self-reported and must be independently verified by the study owner",
    disagreementCount: disagreementQueue.length, disagreementQueue };
  return merged;
}

async function writeNewFile(path, contents) {
  const target = resolve(path);
  try {
    await access(target);
    throw new Error(`Refusing to overwrite existing file: ${target}`);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  await mkdir(resolve(target, ".."), { recursive: true });
  await writeFile(target, `${JSON.stringify(contents, null, 2)}\n`, {
    flag: "wx",
  });
}

async function main() {
  const [command, ...args] = process.argv.slice(2);
  if (command === "prepare") {
    const [templatePath, outputDir] = args;
    if (!templatePath || !outputDir)
      throw new Error(
        "Usage: node scripts/waveyard-harmonic-annotation-packets.mjs prepare TEMPLATE OUTPUT_DIR",
      );
    const template = JSON.parse(await readFile(resolve(templatePath), "utf8"));
    const packets = createReviewPackets(template);
    for (const packet of packets)
      await writeNewFile(resolve(outputDir, `${packet.packetId}.json`), packet);
    console.log(
      JSON.stringify(
        {
          status: "review-packets-created",
          files: packets.map((packet) =>
            resolve(outputDir, `${packet.packetId}.json`),
          ),
        },
        null,
        2,
      ),
    );
    return;
  }
  if (command === "merge") {
    const [templatePath, reviewerOnePath, reviewerTwoPath, outputPath] = args;
    if (!templatePath || !reviewerOnePath || !reviewerTwoPath || !outputPath)
      throw new Error(
        "Usage: node scripts/waveyard-harmonic-annotation-packets.mjs merge TEMPLATE REVIEWER_1 REVIEWER_2 OUTPUT",
      );
    const [template, firstText, secondText] = await Promise.all([
      readFile(resolve(templatePath), "utf8"), readFile(resolve(reviewerOnePath), "utf8"), readFile(resolve(reviewerTwoPath), "utf8"),
    ]);
    const result = mergeReviewPackets(JSON.parse(template), [JSON.parse(firstText), JSON.parse(secondText)]);
    result.reviewMerge.submissions = [
      { packetId: `${result.studyId}-reviewer-1`, fileName: resolve(reviewerOnePath).split(/[\\/]/).at(-1), sha256: createHash("sha256").update(firstText).digest("hex") },
      { packetId: `${result.studyId}-reviewer-2`, fileName: resolve(reviewerTwoPath).split(/[\\/]/).at(-1), sha256: createHash("sha256").update(secondText).digest("hex") },
    ];
    await writeNewFile(outputPath, result);
    console.log(
      JSON.stringify(
        {
          status: "locked-reviews-merged-awaiting-adjudication",
          output: resolve(outputPath),
        },
        null,
        2,
      ),
    );
    return;
  }
  throw new Error(
    "Usage: node scripts/waveyard-harmonic-annotation-packets.mjs <prepare|merge> ...",
  );
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
)
  await main();
