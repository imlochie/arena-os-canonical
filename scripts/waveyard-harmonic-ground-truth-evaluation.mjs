#!/usr/bin/env node
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";

const keyOf = (interval) => interval?.root && interval.quality !== "unknown" ? `${interval.root}:${interval.quality}` : null;
const QUALITIES = new Set(["major", "minor", "dominant7", "minor7", "major7", "diminished", "augmented", "unknown"]);

function intervalAt(intervals, timestampMs) {
  return intervals.find((interval) => interval.startMs <= timestampMs && timestampMs < interval.endMs) ?? null;
}

function metricsForCounts(counts) {
  const labels = new Set(Object.keys(counts));
  const perClass = [];
  for (const label of labels) {
    const value = counts[label] ?? { tp: 0, fp: 0, fn: 0 };
    if (value.tp + value.fp + value.fn === 0) continue;
    const precision = value.tp + value.fp ? value.tp / (value.tp + value.fp) : 0;
    const recall = value.tp + value.fn ? value.tp / (value.tp + value.fn) : 0;
    perClass.push({ chord: label, precision, recall, f1: precision + recall ? 2 * precision * recall / (precision + recall) : 0 });
  }
  const sum = (key) => perClass.reduce((total, row) => total + row[key], 0) / (perClass.length || 1);
  const totalTp = perClass.reduce((total, row) => total + counts[row.chord].tp, 0);
  const totalFp = perClass.reduce((total, row) => total + counts[row.chord].fp, 0);
  const totalFn = perClass.reduce((total, row) => total + counts[row.chord].fn, 0);
  return { precision: totalTp + totalFp ? totalTp / (totalTp + totalFp) : null,
    recall: totalTp + totalFn ? totalTp / (totalTp + totalFn) : null,
    macroF1: perClass.length ? sum("f1") : null, perChord: perClass };
}

function unionDuration(intervals) {
  const sorted = [...intervals].sort((a, b) => a.startMs - b.startMs);
  let end = 0; let total = 0;
  for (const interval of sorted) {
    const startMs = Math.max(end, interval.startMs);
    if (interval.endMs > startMs) total += interval.endMs - startMs;
    end = Math.max(end, interval.endMs);
  }
  return total;
}

function validateAdjudicated(reference, durationMs) {
  const issues = [];
  if (!Array.isArray(reference?.intervals) || reference.intervals.length === 0) return ["adjudicated intervals missing"];
  let previousEnd = 0;
  for (const [index, interval] of reference.intervals.entries()) {
    if (!Number.isFinite(interval.startMs) || !Number.isFinite(interval.endMs) || interval.startMs < 0
      || interval.endMs <= interval.startMs || interval.endMs > durationMs) issues.push(`invalid interval at index ${index}`);
    if (interval.startMs < previousEnd) issues.push(`overlapping or unsorted interval at index ${index}`);
    if (!QUALITIES.has(interval.quality) || (interval.quality === "unknown") !== (interval.root === null))
      issues.push(`invalid root/quality label at index ${index}`);
    previousEnd = Math.max(previousEnd, interval.endMs);
  }
  for (const [index, point] of (reference.changePoints ?? []).entries())
    if (!Number.isFinite(point.timeMs) || point.timeMs < 0 || point.timeMs > durationMs) issues.push(`invalid change point at index ${index}`);
  return issues;
}

export function scoreSong(reference, prediction, durationMs, boundaryToleranceMs = 2000) {
  const intervals = reference.intervals ?? [];
  const predicted = prediction.events ?? [];
  const stepMs = 100;
  const counts = {};
  let labeledBins = 0; let abstainedBins = 0; let rootCorrect = 0; let rootEvaluated = 0;
  let qualityCorrect = 0; let qualityEvaluated = 0; let namedPredictions = 0; let unsupportedPredictions = 0;
  for (let timestampMs = stepMs / 2; timestampMs < durationMs; timestampMs += stepMs) {
    const truth = intervalAt(intervals, timestampMs);
    const event = intervalAt(predicted, timestampMs);
    const truthKnown = truth && truth.root !== null && truth.quality !== "unknown" && (truth.certainty ?? "confident") === "confident";
    const predictionKey = keyOf(event);
    if (predictionKey) namedPredictions += 1;
    if (!truth || !truthKnown) {
      if (predictionKey) unsupportedPredictions += 1;
      continue;
    }
    labeledBins += 1;
    const truthKey = keyOf(truth);
    const predictionQuality = event?.quality !== "unknown" ? event?.quality : null;
    counts[truthKey] ??= { tp: 0, fp: 0, fn: 0 };
    if (!predictionKey) {
      abstainedBins += 1;
      counts[truthKey].fn += 1;
      continue;
    }
    const predictionRoot = event.root;
    rootEvaluated += 1;
    if (predictionRoot === truth.root) { rootCorrect += 1; qualityEvaluated += 1; if (predictionQuality === truth.quality) qualityCorrect += 1; }
    if (predictionKey === truthKey) counts[truthKey].tp += 1;
    else {
      counts[truthKey].fn += 1;
      counts[predictionKey] ??= { tp: 0, fp: 0, fn: 0 };
      counts[predictionKey].fp += 1;
    }
  }
  const chord = metricsForCounts(counts);
  const refChanges = (reference.changePoints ?? []).filter((point) => (point.certainty ?? "confident") === "confident").map((point) => point.timeMs);
  const predChanges = [];
  for (let index = 1; index < predicted.length; index += 1) {
    if (keyOf(predicted[index - 1]) !== keyOf(predicted[index])) predChanges.push(predicted[index].startMs);
  }
  const matches = [];
  const used = new Set();
  for (const ref of refChanges) {
    let best = -1; let delta = Infinity;
    for (let index = 0; index < predChanges.length; index += 1) {
      if (used.has(index)) continue;
      const candidate = Math.abs(predChanges[index] - ref);
      if (candidate < delta && candidate <= boundaryToleranceMs) { best = index; delta = candidate; }
    }
    if (best >= 0) { used.add(best); matches.push(predChanges[best] - ref); }
  }
  return {
    referenceCoverageFraction: durationMs ? unionDuration(intervals) / durationMs : 0,
    labeledDurationMs: labeledBins * stepMs,
    chord: labeledBins ? chord : null,
    rootAccuracy: rootEvaluated ? rootCorrect / rootEvaluated : null,
    chordQualityAccuracyGivenCorrectRoot: qualityEvaluated ? qualityCorrect / qualityEvaluated : null,
    abstentionRateOnLabeledBins: labeledBins ? abstainedBins / labeledBins : null,
    unsupportedPredictionRate: namedPredictions ? unsupportedPredictions / namedPredictions : null,
    namedPredictionBins: namedPredictions,
    unsupportedPredictionBins: unsupportedPredictions,
    chordChangeTiming: { referenceChanges: refChanges.length, predictedChanges: predChanges.length,
      matchedChanges: matches.length, precision: predChanges.length ? matches.length / predChanges.length : null,
      recall: refChanges.length ? matches.length / refChanges.length : null,
      meanAbsoluteErrorMs: matches.length ? matches.reduce((sum, delta) => sum + Math.abs(delta), 0) / matches.length : null,
      meanSignedErrorMs: matches.length ? matches.reduce((sum, delta) => sum + delta, 0) / matches.length : null },
  };
}

function random(seed) {
  let state = seed >>> 0;
  return () => { state ^= state << 13; state ^= state >>> 17; state ^= state << 5; return (state >>> 0) / 0x1_0000_0000; };
}

export function bootstrapSongMacroF1(songScores, iterations = 2000, seed = 42) {
  const values = songScores.map((score) => score.metrics?.chord?.macroF1).filter(Number.isFinite);
  if (values.length < 2) return { songCount: values.length, iterations: 0, lower95: null, upper95: null };
  const sample = random(seed); const means = [];
  for (let iteration = 0; iteration < iterations; iteration += 1) {
    let total = 0;
    for (let index = 0; index < values.length; index += 1) total += values[Math.floor(sample() * values.length)];
    means.push(total / values.length);
  }
  means.sort((a, b) => a - b);
  return { songCount: values.length, iterations, lower95: means[Math.floor(iterations * 0.025)], upper95: means[Math.min(iterations - 1, Math.floor(iterations * 0.975))] };
}

export function evaluateStudy(template, predictions) {
  const predictionByTrack = new Map((predictions.measurements ?? []).filter((measurement) => measurement.sourceDomain === "original-source")
    .map((measurement) => [measurement.trackId, measurement]));
  const annotationByTrack = new Map((template.annotations ?? []).map((annotation) => [annotation.recordingId, annotation]));
  const recordings = [];
  const blockers = [];
  for (const recording of template.recordings ?? []) {
    const annotation = annotationByTrack.get(recording.id);
    const prediction = predictionByTrack.get(recording.id);
    const reasons = [];
    if (!prediction) reasons.push("verified original-source prediction missing");
    if (prediction && prediction.assetSha256 !== recording.sourceSha256) reasons.push("prediction SHA-256 does not match template source");
    if (!annotation || annotation.sourceSha256 !== recording.sourceSha256) reasons.push("annotation source SHA-256 missing or mismatched");
    if (!annotation?.reviewers || annotation.reviewers.length < 2 || !annotation.reviewers.every((reviewer) => reviewer.complete && reviewer.reviewerId && reviewer.lockedAt))
      reasons.push("two complete, independently locked reviews required");
    if (!annotation?.adjudicated || annotation.adjudicated.status !== "adjudicated") reasons.push("adjudicated chord intervals required");
    if (annotation?.adjudicated?.status === "adjudicated") reasons.push(...validateAdjudicated(annotation.adjudicated, recording.durationMs));
    const metrics = prediction && annotation?.adjudicated?.status === "adjudicated"
      ? scoreSong(annotation.adjudicated, prediction.candidate, recording.durationMs, template.annotationProtocol?.boundaryToleranceMs ?? 2000)
      : null;
    if (metrics && metrics.referenceCoverageFraction < (template.annotationProtocol?.minimumCoverageFraction ?? 0.95))
      reasons.push("adjudicated reference coverage below minimum");
    if (reasons.length) blockers.push({ recordingId: recording.id, reasons });
    recordings.push({ recordingId: recording.id, partition: recording.partition, sourceSha256: recording.sourceSha256,
      runtimeMs: prediction?.candidate?.runtimeMs ?? null, additionalPeakRssBytes: prediction?.candidate?.additionalPeakRssBytes ?? null,
      metrics: reasons.length ? null : metrics, blockedReasons: reasons });
  }
  const ready = recordings.filter((recording) => recording.metrics);
  const byPartition = {};
  for (const partition of ["development", "held-out"]) {
    const songs = ready.filter((recording) => recording.partition === partition);
    const mean = (select) => { const values = songs.map(select).filter(Number.isFinite); return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null; };
    byPartition[partition] = { songs: songs.length,
      macroF1: mean((song) => song.metrics.chord?.macroF1),
      precision: mean((song) => song.metrics.chord?.precision),
      recall: mean((song) => song.metrics.chord?.recall),
      rootAccuracy: mean((song) => song.metrics.rootAccuracy),
      chordQualityAccuracyGivenCorrectRoot: mean((song) => song.metrics.chordQualityAccuracyGivenCorrectRoot),
      abstentionRate: mean((song) => song.metrics.abstentionRateOnLabeledBins),
      unsupportedPredictionRate: mean((song) => song.metrics.unsupportedPredictionRate),
      chordChangeTiming: {
        precision: mean((song) => song.metrics.chordChangeTiming.precision),
        recall: mean((song) => song.metrics.chordChangeTiming.recall),
        meanAbsoluteErrorMs: mean((song) => song.metrics.chordChangeTiming.meanAbsoluteErrorMs),
      },
      songBootstrap95: bootstrapSongMacroF1(songs) };
  }
  return { schemaVersion: 1, status: blockers.length ? "blocked-reference-annotations-incomplete" : "scored",
    metrics: blockers.length ? null : { perSong: recordings, byPartition, heldOutMacroF1SongBootstrap95: byPartition["held-out"].songBootstrap95 },
    blockers, sourcePredictionEvidence: predictions.status, statisticalUnit: "song", heldOutTuning: false };
}

async function main() {
  const [templatePath, predictionsPath, outputPath] = process.argv.slice(2);
  if (!templatePath || !predictionsPath || !outputPath) throw new Error("Usage: node scripts/waveyard-harmonic-ground-truth-evaluation.mjs TEMPLATE PREDICTIONS OUTPUT");
  const template = JSON.parse(await readFile(resolve(templatePath), "utf8"));
  const predictions = JSON.parse(await readFile(resolve(predictionsPath), "utf8"));
  const report = evaluateStudy(template, predictions);
  await writeFile(resolve(outputPath), `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify({ status: report.status, blockerCount: report.blockers.length, output: outputPath,
    heldOutMacroF1: report.metrics?.heldOutMacroF1SongBootstrap95 ?? null }, null, 2));
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) await main();
