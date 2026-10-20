import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const [baselineLog, candidateLog, outputPath] = process.argv.slice(2);
assert.ok(baselineLog && candidateLog && outputPath, "Usage: node scripts/compare-waveyard-ownership-benchmark.mjs BASELINE_LOG CANDIDATE_LOG OUTPUT_JSON");

const marker = "{\"kind\":\"distinct-source-canonical-worker\"";
async function readRuns(file) {
  const text = await readFile(file, "utf8");
  const runs = [];
  for (const line of text.split(/\r?\n/)) {
    const start = line.indexOf(marker);
    if (start < 0) continue;
    runs.push(JSON.parse(line.slice(start).trim()));
  }
  return runs;
}

const baseline = await readRuns(baselineLog);
const candidate = await readRuns(candidateLog);
const expectedSources = [4, 16, 32];
const expectedRepeats = [1, 2, 3];
const keys = expectedSources.flatMap(sources => expectedRepeats.map(repeat => `${sources}:${repeat}`));

function indexRuns(runs, implementation) {
  assert.equal(runs.length, keys.length, `${implementation}: expected ${keys.length} measurements, got ${runs.length}`);
  const indexed = new Map();
  for (const run of runs) {
    assert.equal(run.implementation, implementation, `${implementation}: unexpected implementation label`);
    const key = `${run.sources}:${run.repeat}`;
    assert.ok(keys.includes(key), `${implementation}: unexpected profile ${key}`);
    assert.ok(!indexed.has(key), `${implementation}: duplicate profile ${key}`);
    assert.equal(run.frames, 441000, `${implementation} ${key}: wrong frame count`);
    assert.equal(run.latestEditError, 0, `${implementation} ${key}: edit mismatch`);
    assert.ok(Number.isFinite(run.sampledWholeBrowserPeakPssBytes) && run.sampledWholeBrowserPeakPssBytes > 0, `${implementation} ${key}: missing peak PSS`);
    assert.ok(Number.isFinite(run.retainedPssBytes) && run.retainedPssBytes > 0, `${implementation} ${key}: missing retained PSS`);
    assert.ok(Number.isFinite(run.gcRetainedPssBytes) && run.gcRetainedPssBytes > 0, `${implementation} ${key}: missing post-GC PSS`);
    assert.ok(Number.isFinite(run.peakAccountedSourcePcmOverlapBytes) && run.peakAccountedSourcePcmOverlapBytes > 0, `${implementation} ${key}: missing source-ownership overlap instrumentation`);
    const expectedBytes = run.sources * 441000 * 2 * 4;
    assert.equal(run.diagnostics.sourceBytes, expectedBytes, `${implementation} ${key}: source-byte accounting mismatch`);
    if (implementation === "baseline") {
      assert.equal(run.diagnostics.decodedBytes, expectedBytes, `${implementation} ${key}: decoded fallback was not retained`);
    } else {
      assert.equal(run.diagnostics.decodedBytes, 0, `${implementation} ${key}: decoded PCM was not released`);
      assert.ok(Number.isFinite(run.diagnostics.encodedRecoveryBytes) && run.diagnostics.encodedRecoveryBytes > 0, `${implementation} ${key}: encoded recovery cache missing`);
      assert.ok(run.diagnostics.encodedRecoveryBytes <= 128 * 1024 * 1024, `${implementation} ${key}: recovery cache exceeds 128 MiB`);
    }
    indexed.set(key, run);
  }
  for (const key of keys) assert.ok(indexed.has(key), `${implementation}: missing profile ${key}`);
  return indexed;
}

const baselineByKey = indexRuns(baseline, "baseline");
const candidateByKey = indexRuns(candidate, "encoded-recovery");

function median(values) {
  const ordered = [...values].sort((a, b) => a - b);
  const middle = Math.floor(ordered.length / 2);
  return ordered.length % 2 ? ordered[middle] : (ordered[middle - 1] + ordered[middle]) / 2;
}

function metricSummary(runs) {
  const metrics = [
    "sampledWholeBrowserPeakPssBytes",
    "peakAccountedSourcePcmOverlapBytes",
    "peakDecodedSourceBytes",
    "peakWorkerSourceBytes",
    "retainedPssBytes",
    "gcRetainedPssBytes",
    "readyMs",
    "replayMs",
    "editMs",
    "maximumGapMs",
  ];
  return Object.fromEntries(metrics.map(metric => [metric, median(runs.map(run => run[metric]))]));
}

const comparisons = [];
for (const sources of expectedSources) {
  const baselineRows = expectedRepeats.map(repeat => baselineByKey.get(`${sources}:${repeat}`));
  const candidateRows = expectedRepeats.map(repeat => candidateByKey.get(`${sources}:${repeat}`));
  for (let index = 0; index < expectedRepeats.length; index++) {
    const before = baselineRows[index];
    const after = candidateRows[index];
    assert.equal(after.pcmSha256, before.pcmSha256, `${sources} sources, repeat ${index + 1}: cold stereo PCM hash differs`);
    assert.equal(after.editedPcmSha256, before.editedPcmSha256, `${sources} sources, repeat ${index + 1}: edited stereo PCM hash differs`);
    assert.ok(after.peakAccountedSourcePcmOverlapBytes < before.peakAccountedSourcePcmOverlapBytes, `${sources} sources, repeat ${index + 1}: source-transfer overlap did not fall`);
    assert.ok(after.peakDecodedSourceBytes <= 441000 * 2 * 4, `${sources} sources, repeat ${index + 1}: candidate retained more than one synthetic source AudioBuffer during transfer`);
    assert.equal(after.pcmSha256, baselineRows[0].pcmSha256, `${sources} baseline cold hash varied across repeats`);
    assert.equal(after.pcmSha256, candidateRows[0].pcmSha256, `${sources} candidate cold hash varied across repeats`);
    assert.equal(after.editedPcmSha256, baselineRows[0].editedPcmSha256, `${sources} baseline edited hash varied across repeats`);
    assert.equal(after.editedPcmSha256, candidateRows[0].editedPcmSha256, `${sources} candidate edited hash varied across repeats`);
  }
  const baselineMetrics = metricSummary(baselineRows);
  const candidateMetrics = metricSummary(candidateRows);
  const encodedCacheBytes = candidateRows.map(run => run.diagnostics.encodedRecoveryBytes);
  comparisons.push({
    sources,
    repeats: expectedRepeats.length,
    coldPcmSha256: baselineRows[0].pcmSha256,
    editedPcmSha256: baselineRows[0].editedPcmSha256,
    baselineMedian: baselineMetrics,
    candidateMedian: candidateMetrics,
    candidateEncodedRecoveryBytes: {
      median: median(encodedCacheBytes),
      maximum: Math.max(...encodedCacheBytes),
      configuredBound: 128 * 1024 * 1024,
    },
    medianDelta: Object.fromEntries(Object.keys(baselineMetrics).map(metric => [metric, candidateMetrics[metric] - baselineMetrics[metric]])),
    candidateAllPeakSamplesAtOrBelow512MiB: candidateRows.every(run => run.sampledWholeBrowserPeakPssBytes <= 512 * 1024 * 1024),
    rawRuns: { baseline: baselineRows, candidate: candidateRows },
  });
}

const summary = {
  schemaVersion: 1,
  baselineCommit: process.env.BENCHMARK_BASELINE_SHA ?? "a8e015592e81fcd0916e5a0f97baf3f8721ec091",
  candidateCommit: process.env.BENCHMARK_CANDIDATE_SHA ?? null,
  runtime: {
    node: process.version,
    chromium: process.env.CHROMIUM_VERSION ?? null,
    runner: process.env.RUNNER_NAME ?? null,
    os: process.env.RUNNER_OS ?? null,
  },
  correctness: { matchedColdAndEditedStereoPcmHashes: true, matchedProfiles: keys.length },
  memoryTarget: "512 MiB sampled browser-tree peak PSS; diagnostic threshold, not a release gate",
  comparisons,
};

await mkdir(path.dirname(outputPath), { recursive: true });
await writeFile(outputPath, `${JSON.stringify(summary, null, 2)}\n`);
console.log(JSON.stringify({
  kind: "waveyard-ownership-comparison",
  baselineCommit: summary.baselineCommit,
  candidateCommit: summary.candidateCommit,
  matchedProfiles: keys.length,
  bySources: comparisons.map(({ sources, baselineMedian, candidateMedian, medianDelta, candidateAllPeakSamplesAtOrBelow512MiB }) => ({
    sources, baselineMedian, candidateMedian, medianDelta, candidateAllPeakSamplesAtOrBelow512MiB,
  })),
}));
