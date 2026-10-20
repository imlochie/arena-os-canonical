import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const [baselineLog, prototype2Log, prototype3Log, outputPath] = process.argv.slice(2);
assert.ok(baselineLog && prototype2Log && prototype3Log && outputPath,
  "Usage: node scripts/compare-waveyard-three-way-benchmark.mjs BASELINE_LOG PROTOTYPE2_LOG PROTOTYPE3_LOG OUTPUT_JSON");

const marker = "{\"kind\":\"distinct-source-canonical-worker\"";
async function readRuns(file) {
  const text = await readFile(file, "utf8");
  const runs = [];
  for (const line of text.split(/\r?\n/)) {
    const start = line.indexOf(marker);
    if (start >= 0) runs.push(JSON.parse(line.slice(start).trim()));
  }
  return runs;
}

const expectedSources = [4, 16, 32];
const expectedRepeats = [1, 2, 3];
const keys = expectedSources.flatMap(sources => expectedRepeats.map(repeat => `${sources}:${repeat}`));
const variantLogs = [
  ["baseline", baselineLog],
  ["prototype2", prototype2Log],
  ["prototype3", prototype3Log],
];

function indexRuns(runs, implementation) {
  assert.equal(runs.length, keys.length, `${implementation}: expected ${keys.length} measurements, got ${runs.length}`);
  const indexed = new Map();
  for (const run of runs) {
    assert.equal(run.implementation, implementation, `${implementation}: unexpected implementation label`);
    const key = `${run.sources}:${run.repeat}`;
    assert.ok(keys.includes(key), `${implementation}: unexpected profile ${key}`);
    assert.ok(!indexed.has(key), `${implementation}: duplicate profile ${key}`);
    assert.equal(run.frames, 441000, `${implementation} ${key}: wrong frame count`);
    assert.equal(run.latestEditError, 0, `${implementation} ${key}: master-only edit output mismatch`);
    assert.ok(run.replaySame, `${implementation} ${key}: unchanged replay lost finished-buffer identity`);
    assert.ok(Number.isFinite(run.sampledWholeBrowserPeakPssBytes), `${implementation} ${key}: sampled peak PSS is missing`);
    assert.ok(Number.isFinite(run.retainedPssBytes), `${implementation} ${key}: natural retained PSS is missing`);
    assert.ok(run.maximumGapMs < 300, `${implementation} ${key}: main-thread gap ${run.maximumGapMs}ms exceeded 300ms`);

    const expectedBytes = run.sources * 441000 * 2 * 4;
    assert.equal(run.coldFetches, run.sources, `${implementation} ${key}: cold source fetch count mismatch`);
    assert.equal(run.replayFetches, 0, `${implementation} ${key}: unchanged replay fetched a source`);
    assert.equal(run.replayDecodeCalls, 0, `${implementation} ${key}: unchanged replay decoded a source`);
    assert.equal(run.masterEditFetches, 0, `${implementation} ${key}: master-only edit fetched a source`);
    assert.equal(run.masterEditDecodeCalls, 0, `${implementation} ${key}: master-only edit decoded a source`);
    assert.ok(run.masterMixCacheHit, `${implementation} ${key}: master-only edit missed the pre-master mix cache`);
    assert.ok(run.masterRetainedMixBytes > 0, `${implementation} ${key}: pre-master mix was not retained`);
    assert.equal(run.masterWorkerSourceBytes, expectedBytes, `${implementation} ${key}: source data was not warm for an immediate master edit`);
    assert.equal(run.trackEditFetches, 0, `${implementation} ${key}: track edit fetched a source instead of using local recovery`);
    assert.ok(!run.trackEditMixCacheHit, `${implementation} ${key}: changed track incorrectly reused a stale pre-master mix`);
    assert.equal(run.trackEditDecodeCalls, 0, `${implementation} ${key}: immediate track edit decoded a source despite warm Worker ownership`);
    assert.equal(run.trackEditWorkerSourceBytes, expectedBytes, `${implementation} ${key}: immediate track edit did not preserve warm Worker sources`);
    assert.equal(run.postIdleMasterEditFetches, 0, `${implementation} ${key}: post-idle master edit fetched a source`);
    assert.equal(run.postIdleMasterEditDecodeCalls, 0, `${implementation} ${key}: post-idle master edit rehydrated a source`);
    assert.ok(run.postIdleMasterMixCacheHit, `${implementation} ${key}: post-idle master edit missed the retained mix`);
    assert.equal(run.postIdleTrackEditFetches, 0, `${implementation} ${key}: post-idle track edit fetched a source instead of using local recovery`);
    assert.ok(!run.postIdleTrackMixCacheHit, `${implementation} ${key}: post-idle track edit incorrectly reused a stale mix`);
    assert.equal(run.peakWorkerSourceBytes, expectedBytes, `${implementation} ${key}: peak Worker PCM accounting mismatch`);
    assert.equal(run.diagnostics.finishedBytes, run.outputPlanarBytes, `${implementation} ${key}: finished-buffer accounting mismatch`);

    if (implementation === "baseline") {
      assert.equal(run.diagnostics.sourceBytes, expectedBytes, `${implementation} ${key}: baseline Worker source bytes mismatch`);
      assert.equal(run.diagnostics.decodedBytes, expectedBytes, `${implementation} ${key}: decoded source owner mismatch`);
      assert.equal(run.masterDecodedBytes, expectedBytes, `${implementation} ${key}: baseline immediate master edit lost its decoded owner`);
      assert.equal(run.idleWorkerSourceBytes, expectedBytes, `${implementation} ${key}: baseline idle source bytes mismatch`);
      assert.equal(run.postIdleMasterWorkerSourceBytes, expectedBytes, `${implementation} ${key}: baseline post-idle master source bytes mismatch`);
      assert.equal(run.postIdleTrackEditDecodeCalls, 0, `${implementation} ${key}: baseline unexpectedly re-decoded a source`);
    } else if (implementation === "prototype2") {
      assert.equal(run.diagnostics.sourceBytes, expectedBytes, `${implementation} ${key}: Prototype 2 Worker source bytes mismatch`);
      assert.equal(run.diagnostics.decodedBytes, 0, `${implementation} ${key}: decoded PCM was not released`);
      assert.equal(run.masterDecodedBytes, 0, `${implementation} ${key}: Prototype 2 immediate master edit retained decoded PCM`);
      assert.ok(run.diagnostics.encodedRecoveryBytes > 0, `${implementation} ${key}: encoded local recovery is missing`);
      assert.ok(run.diagnostics.encodedRecoveryBytes <= 128 * 1024 * 1024, `${implementation} ${key}: encoded recovery exceeded its bound`);
      assert.equal(run.idleWorkerSourceBytes, expectedBytes, `${implementation} ${key}: Prototype 2 idle source bytes mismatch`);
      assert.equal(run.postIdleMasterWorkerSourceBytes, expectedBytes, `${implementation} ${key}: Prototype 2 post-idle master source bytes mismatch`);
      assert.equal(run.postIdleTrackEditDecodeCalls, 0, `${implementation} ${key}: resident sources were unnecessarily reconstructed`);
    } else {
      assert.equal(run.diagnostics.sourceBytes, 0, `${implementation} ${key}: Worker retained source PCM after render`);
      assert.equal(run.diagnostics.workerSourcesEvicted, true, `${implementation} ${key}: source eviction was not acknowledged`);
      assert.equal(run.diagnostics.evictedSourceBytes, expectedBytes, `${implementation} ${key}: evicted source-byte count mismatch`);
      assert.equal(run.idleWorkerSourceBytes, 0, `${implementation} ${key}: idle Worker eviction left source PCM resident`);
      assert.equal(run.idleWorkerSourcesEvicted, true, `${implementation} ${key}: idle eviction acknowledgement missing`);
      assert.equal(run.postIdleMasterWorkerSourceBytes, 0, `${implementation} ${key}: post-idle master edit rehydrated sources`);
      assert.equal(run.diagnostics.decodedBytes, 0, `${implementation} ${key}: main-thread decoded PCM was not released`);
      assert.equal(run.masterDecodedBytes, 0, `${implementation} ${key}: Prototype 3 immediate master edit retained decoded PCM`);
      assert.ok(run.diagnostics.encodedRecoveryBytes > 0, `${implementation} ${key}: encoded local recovery is missing`);
      assert.ok(run.diagnostics.encodedRecoveryBytes <= 128 * 1024 * 1024, `${implementation} ${key}: encoded recovery exceeded its bound`);
      assert.equal(run.postIdleTrackEditDecodeCalls, run.sources, `${implementation} ${key}: post-idle track edit did not reconstruct the exact required local source set`);
    }
    for (const field of ["pcmSha256", "editedPcmSha256", "trackEditedPcmSha256", "postIdleMasterPcmSha256", "postIdleTrackPcmSha256"]) {
      assert.match(run[field], /^[a-f0-9]{64}$/, `${implementation} ${key}: missing ${field}`);
    }
    indexed.set(key, run);
  }
  for (const key of keys) assert.ok(indexed.has(key), `${implementation}: missing profile ${key}`);
  return indexed;
}

const runsByVariant = Object.fromEntries(await Promise.all(variantLogs.map(async ([label, file]) =>
  [label, indexRuns(await readRuns(file), label)])));

function median(values) {
  const ordered = [...values].sort((a, b) => a - b);
  const middle = Math.floor(ordered.length / 2);
  return ordered.length % 2 ? ordered[middle] : (ordered[middle - 1] + ordered[middle]) / 2;
}

const metrics = {
  sampledWholeBrowserPeakPssBytes: run => run.sampledWholeBrowserPeakPssBytes,
  retainedPssBytes: run => run.retainedPssBytes,
  gcRetainedPssBytes: run => run.gcRetainedPssBytes,
  peakAccountedSourcePcmOverlapBytes: run => run.peakAccountedSourcePcmOverlapBytes,
  peakDecodedSourceBytes: run => run.peakDecodedSourceBytes,
  peakWorkerSourceBytes: run => run.peakWorkerSourceBytes,
  workerRetainedSourceBytes: run => run.diagnostics.sourceBytes,
  masterEditWorkerSourceBytes: run => run.masterWorkerSourceBytes,
  immediateTrackEditWorkerSourceBytes: run => run.trackEditWorkerSourceBytes,
  firstIdleWorkerSourceBytes: run => run.idleWorkerSourceBytes,
  postIdleMasterWorkerSourceBytes: run => run.postIdleMasterWorkerSourceBytes,
  postIdleTrackWorkerSourceBytes: run => run.postIdleTrackWorkerSourceBytes,
  evictedSourceBytes: run => run.diagnostics.evictedSourceBytes ?? 0,
  mainThreadDecodedSourceBytes: run => run.diagnostics.decodedBytes,
  encodedRecoveryBytes: run => run.diagnostics.encodedRecoveryBytes,
  retainedPreMasterMixBytes: run => run.diagnostics.retainedMixBytes,
  finishedBufferBytes: run => run.diagnostics.finishedBytes,
  readyMs: run => run.readyMs,
  replayMs: run => run.replayMs,
  masterEditMs: run => run.editMs,
  trackEditMs: run => run.trackEditMs,
  idleEvictionWaitMs: run => run.firstIdleWaitMs,
  postIdleMasterEditMs: run => run.postIdleMasterEditMs,
  postIdleTrackEditMs: run => run.postIdleTrackEditMs,
  finalIdleEvictionWaitMs: run => run.finalIdleWaitMs,
  maximumGapMs: run => run.maximumGapMs,
  coldDecodeCalls: run => run.coldDecodeCalls,
  coldDecodeMs: run => run.coldDecodeMs,
  masterEditDecodeCalls: run => run.masterEditDecodeCalls,
  masterEditDecodeMs: run => run.masterEditDecodeMs,
  trackEditDecodeCalls: run => run.trackEditDecodeCalls,
  trackEditDecodeMs: run => run.trackEditDecodeMs,
  postIdleTrackEditDecodeCalls: run => run.postIdleTrackEditDecodeCalls,
  postIdleTrackEditDecodeMs: run => run.postIdleTrackEditDecodeMs,
  coldFetches: run => run.coldFetches,
  replayFetches: run => run.replayFetches,
  masterEditFetches: run => run.masterEditFetches,
  trackEditFetches: run => run.trackEditFetches,
  postIdleMasterEditFetches: run => run.postIdleMasterEditFetches,
  postIdleTrackEditFetches: run => run.postIdleTrackEditFetches,
};

function summarize(indexed, sources) {
  const rows = expectedRepeats.map(repeat => indexed.get(`${sources}:${repeat}`));
  return Object.fromEntries(Object.entries(metrics).map(([name, value]) => [name, median(rows.map(value))]));
}

const comparisons = [];
for (const sources of expectedSources) {
  const variantRows = Object.fromEntries(variantLogs.map(([label]) =>
    [label, expectedRepeats.map(repeat => runsByVariant[label].get(`${sources}:${repeat}`))]));
  for (let index = 0; index < expectedRepeats.length; index++) {
    const rows = Object.fromEntries(variantLogs.map(([label]) => [label, variantRows[label][index]]));
    for (const field of ["pcmSha256", "editedPcmSha256", "trackEditedPcmSha256", "postIdleMasterPcmSha256", "postIdleTrackPcmSha256"]) {
      assert.equal(rows.prototype2[field], rows.baseline[field], `${sources} sources, repeat ${index + 1}: Prototype 2 ${field} differs from baseline`);
      assert.equal(rows.prototype3[field], rows.baseline[field], `${sources} sources, repeat ${index + 1}: Prototype 3 ${field} differs from baseline`);
    }
  }
  const byVariant = Object.fromEntries(variantLogs.map(([label]) => [label, summarize(runsByVariant[label], sources)]));
  const deltas = {
    prototype2VsBaseline: Object.fromEntries(Object.keys(metrics).map(key => [key, byVariant.prototype2[key] - byVariant.baseline[key]])),
    prototype3VsBaseline: Object.fromEntries(Object.keys(metrics).map(key => [key, byVariant.prototype3[key] - byVariant.baseline[key]])),
    prototype3VsPrototype2: Object.fromEntries(Object.keys(metrics).map(key => [key, byVariant.prototype3[key] - byVariant.prototype2[key]])),
  };
  comparisons.push({
    sources, repeats: expectedRepeats.length,
    pcmSha256: variantRows.baseline[0].pcmSha256,
    masterEditedPcmSha256: variantRows.baseline[0].editedPcmSha256,
    trackEditedPcmSha256: variantRows.baseline[0].trackEditedPcmSha256,
    postIdleMasterPcmSha256: variantRows.baseline[0].postIdleMasterPcmSha256,
    postIdleTrackPcmSha256: variantRows.baseline[0].postIdleTrackPcmSha256,
    medianByVariant: byVariant,
    medianDelta: deltas,
    rawRuns: variantRows,
    prototype3AllPeakSamplesAtOrBelow512MiB: variantRows.prototype3.every(run => run.sampledWholeBrowserPeakPssBytes <= 512 * 1024 * 1024),
  });
}

const summary = {
  schemaVersion: 1,
  baselineCommit: process.env.BENCHMARK_BASELINE_SHA ?? null,
  prototype2Commit: process.env.BENCHMARK_PROTOTYPE2_SHA ?? null,
  prototype3Commit: process.env.BENCHMARK_PROTOTYPE3_SHA ?? null,
  runtime: { node: process.version, chromium: process.env.CHROMIUM_VERSION ?? null, runner: process.env.RUNNER_NAME ?? null, os: process.env.RUNNER_OS ?? null },
  correctness: {
    matchedProfiles: keys.length,
    matchedColdMasterEditedAndTrackEditedStereoPcmHashes: true,
    unchangedReplayPreservedFinishedBufferIdentity: true,
    masterOnlyEditsReusedPreMasterMixWithoutFetchOrDecode: true,
    trackEditsUsedLocalRecoveryWithoutNetworkFetch: true,
    mainThreadGapGateMs: 250,
    comparisonCeilingMs: 300,
  },
  memoryTarget: "512 MiB sampled browser-tree peak PSS; diagnostic threshold, not a release gate",
  pssSampling: "Whole browser process tree sampled every 50 ms; retained PSS is measured separately from the sampled peak.",
  comparisons,
};

await mkdir(path.dirname(outputPath), { recursive: true });
await writeFile(outputPath, `${JSON.stringify(summary, null, 2)}\n`);
console.log(JSON.stringify({
  kind: "waveyard-three-way-ownership-comparison",
  baselineCommit: summary.baselineCommit,
  prototype2Commit: summary.prototype2Commit,
  prototype3Commit: summary.prototype3Commit,
  matchedProfiles: keys.length,
  bySources: comparisons.map(({ sources, medianByVariant, medianDelta, prototype3AllPeakSamplesAtOrBelow512MiB }) =>
    ({ sources, medianByVariant, medianDelta, prototype3AllPeakSamplesAtOrBelow512MiB })),
}));
