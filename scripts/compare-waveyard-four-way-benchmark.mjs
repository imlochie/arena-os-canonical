import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const [baselineLog, prototype2Log, prototype3Log, prototype4Log, outputPath] = process.argv.slice(2);
assert.ok(baselineLog && prototype2Log && prototype3Log && prototype4Log && outputPath,
  "Usage: node scripts/compare-waveyard-four-way-benchmark.mjs BASELINE_LOG PROTOTYPE2_LOG PROTOTYPE3_LOG PROTOTYPE4_LOG OUTPUT_JSON");

const expectedSources = [4, 16, 32];
const expectedRepeats = [1, 2, 3];
const keys = expectedSources.flatMap(sources => expectedRepeats.map(repeat => `${sources}:${repeat}`));
const variantLogs = [
  ["baseline", baselineLog],
  ["prototype2", prototype2Log],
  ["prototype3", prototype3Log],
  ["prototype4", prototype4Log],
];
const hashFields = ["pcmSha256", "editedPcmSha256", "trackEditedPcmSha256", "postIdleMasterPcmSha256", "postIdleTrackPcmSha256"];
const marker = "{\"kind\":\"distinct-source-canonical-worker\"";

async function readTagged(file, kind) {
  const text = await readFile(file, "utf8"), found = [];
  const tag = `{"kind":"${kind}"`;
  for (const line of text.split(/\r?\n/)) {
    const start = line.indexOf(tag);
    if (start >= 0) found.push(JSON.parse(line.slice(start).trim()));
  }
  return found;
}
async function readRuns(file) {
  const text = await readFile(file, "utf8"), runs = [];
  for (const line of text.split(/\r?\n/)) {
    const start = line.indexOf(marker);
    if (start >= 0) runs.push(JSON.parse(line.slice(start).trim()));
  }
  return runs;
}
function median(values) {
  const ordered = [...values].sort((a, b) => a - b);
  const middle = Math.floor(ordered.length / 2);
  return ordered.length % 2 ? ordered[middle] : (ordered[middle - 1] + ordered[middle]) / 2;
}
function indexRuns(runs, implementation) {
  assert.equal(runs.length, keys.length, `${implementation}: expected ${keys.length} measurement cells, got ${runs.length}`);
  const indexed = new Map();
  for (const run of runs) {
    const key = `${run.sources}:${run.repeat}`;
    assert.equal(run.implementation, implementation, `${implementation}: unexpected implementation label`);
    assert.ok(keys.includes(key), `${implementation}: unexpected profile ${key}`);
    assert.ok(!indexed.has(key), `${implementation}: duplicate profile ${key}`);
    assert.equal(run.frames, 441000, `${implementation} ${key}: wrong frame count`);
    assert.equal(run.latestEditError, 0, `${implementation} ${key}: edited output mismatch`);
    assert.ok(run.replaySame, `${implementation} ${key}: unchanged replay lost finished-buffer identity`);
    assert.ok(Number.isFinite(run.sampledWholeBrowserPeakPssBytes), `${implementation} ${key}: sampled peak PSS missing`);
    assert.ok(Number.isFinite(run.retainedPssBytes), `${implementation} ${key}: retained PSS missing`);
    assert.ok(Number.isFinite(run.fixedRuntimeFloorPssBytes), `${implementation} ${key}: fixed runtime floor missing`);
    assert.ok(run.maximumGapMs < 250, `${implementation} ${key}: existing 250 ms UI-gap gate exceeded`);
    assert.ok(run.maximumGapMs < 300, `${implementation} ${key}: 300 ms comparison ceiling exceeded`);

    const expectedBytes = run.sources * 441000 * 2 * 4;
    const oneSourceBytes = 441000 * 2 * 4;
    assert.equal(run.coldFetches, run.sources, `${implementation} ${key}: cold source fetch count mismatch`);
    assert.equal(run.replayFetches, 0, `${implementation} ${key}: replay fetched a source`);
    assert.equal(run.replayDecodeCalls, 0, `${implementation} ${key}: replay decoded a source`);
    assert.equal(run.masterEditFetches, 0, `${implementation} ${key}: master edit fetched a source`);
    assert.equal(run.masterEditDecodeCalls, 0, `${implementation} ${key}: master edit decoded a source`);
    assert.ok(run.masterMixCacheHit, `${implementation} ${key}: master edit missed the pre-master mix cache`);
    assert.ok(run.masterRetainedMixBytes > 0, `${implementation} ${key}: pre-master mix was not retained`);
    assert.equal(run.trackEditFetches, 0, `${implementation} ${key}: track edit did not use local source owners`);
    assert.ok(!run.trackEditMixCacheHit, `${implementation} ${key}: changed track reused a stale mix`);
    assert.equal(run.postIdleMasterEditFetches, 0, `${implementation} ${key}: post-idle master edit fetched a source`);
    assert.equal(run.postIdleMasterEditDecodeCalls, 0, `${implementation} ${key}: post-idle master edit rehydrated a source`);
    assert.ok(run.postIdleMasterMixCacheHit, `${implementation} ${key}: post-idle master edit missed the mix cache`);
    assert.equal(run.postIdleTrackEditFetches, 0, `${implementation} ${key}: post-idle track edit fetched a source`);
    assert.ok(!run.postIdleTrackMixCacheHit, `${implementation} ${key}: post-idle changed track reused a stale mix`);
    assert.equal(run.diagnostics.finishedBytes, run.outputPlanarBytes, `${implementation} ${key}: finished-buffer accounting mismatch`);
    assert.ok(run.diagnostics.retainedMixBytes > 0, `${implementation} ${key}: pre-master cache missing`);
    assert.ok(Number.isFinite(run.peakAccountedSourcePcmOverlapBytes), `${implementation} ${key}: source PCM overlap missing`);
    assert.ok(Number.isFinite(run.peakWorkerSourceBytes), `${implementation} ${key}: Worker source high-water mark missing`);
    assert.equal(run.postIdleTrackEditDecodeCalls,
      ["prototype3", "prototype4"].includes(implementation) ? run.sources : 0,
      `${implementation} ${key}: post-idle local source reconstruction count mismatch`);

    if (implementation === "baseline") {
      assert.equal(run.diagnostics.sourceBytes, expectedBytes, `${implementation} ${key}: Worker source bytes mismatch`);
      assert.equal(run.diagnostics.decodedBytes, expectedBytes, `${implementation} ${key}: decoded source owner mismatch`);
      assert.equal(run.masterWorkerSourceBytes, expectedBytes, `${implementation} ${key}: immediate master edit source owner mismatch`);
      assert.equal(run.masterDecodedBytes, expectedBytes, `${implementation} ${key}: master edit decoded owner mismatch`);
      assert.equal(run.trackEditDecodeCalls, 0, `${implementation} ${key}: warm track edit unexpectedly decoded`);
      assert.equal(run.trackEditWorkerSourceBytes, expectedBytes, `${implementation} ${key}: warm track edit lost Worker sources`);
      assert.equal(run.idleWorkerSourceBytes, expectedBytes, `${implementation} ${key}: baseline idle source bytes mismatch`);
      assert.equal(run.postIdleMasterWorkerSourceBytes, expectedBytes, `${implementation} ${key}: post-idle master source mismatch`);
      assert.equal(run.peakWorkerSourceBytes, expectedBytes, `${implementation} ${key}: Worker peak accounting mismatch`);
    } else if (implementation === "prototype2") {
      assert.equal(run.diagnostics.sourceBytes, expectedBytes, `${implementation} ${key}: Worker source bytes mismatch`);
      assert.equal(run.diagnostics.decodedBytes, 0, `${implementation} ${key}: main decoded PCM was not released`);
      assert.equal(run.masterWorkerSourceBytes, expectedBytes, `${implementation} ${key}: immediate master edit source owner mismatch`);
      assert.equal(run.masterDecodedBytes, 0, `${implementation} ${key}: decoded PCM persisted after transfer`);
      assert.ok(run.diagnostics.encodedRecoveryBytes > 0, `${implementation} ${key}: encoded local recovery missing`);
      assert.ok(run.diagnostics.encodedRecoveryBytes <= 128 * 1024 * 1024, `${implementation} ${key}: recovery budget exceeded`);
      assert.equal(run.trackEditDecodeCalls, 0, `${implementation} ${key}: warm track edit unexpectedly decoded`);
      assert.equal(run.trackEditWorkerSourceBytes, expectedBytes, `${implementation} ${key}: warm Worker sources missing`);
      assert.equal(run.idleWorkerSourceBytes, expectedBytes, `${implementation} ${key}: idle source bytes mismatch`);
      assert.equal(run.postIdleMasterWorkerSourceBytes, expectedBytes, `${implementation} ${key}: post-idle master source mismatch`);
      assert.equal(run.peakWorkerSourceBytes, expectedBytes, `${implementation} ${key}: Worker peak accounting mismatch`);
    } else if (implementation === "prototype3") {
      assert.equal(run.diagnostics.sourceBytes, 0, `${implementation} ${key}: idle Worker sources were not evicted`);
      assert.equal(run.diagnostics.workerSourcesEvicted, true, `${implementation} ${key}: Worker eviction was not acknowledged`);
      assert.equal(run.diagnostics.evictedSourceBytes, expectedBytes, `${implementation} ${key}: idle released-byte accounting mismatch`);
      assert.equal(run.coldWorkerSourceBytes, expectedBytes, `${implementation} ${key}: sources were not warm immediately after render`);
      assert.equal(run.masterWorkerSourceBytes, expectedBytes, `${implementation} ${key}: immediate master edit source mismatch`);
      assert.equal(run.masterDecodedBytes, 0, `${implementation} ${key}: decoded PCM persisted after transfer`);
      assert.equal(run.trackEditDecodeCalls, 0, `${implementation} ${key}: warm track edit unexpectedly decoded`);
      assert.equal(run.trackEditWorkerSourceBytes, expectedBytes, `${implementation} ${key}: warm Worker sources missing`);
      assert.equal(run.idleWorkerSourceBytes, 0, `${implementation} ${key}: idle Worker sources remain`);
      assert.equal(run.postIdleMasterWorkerSourceBytes, 0, `${implementation} ${key}: post-idle master rehydrated sources`);
      assert.equal(run.peakWorkerSourceBytes, expectedBytes, `${implementation} ${key}: Worker peak accounting mismatch`);
      assert.ok(run.diagnostics.encodedRecoveryBytes > 0, `${implementation} ${key}: encoded local recovery missing`);
      assert.ok(run.diagnostics.encodedRecoveryBytes <= 128 * 1024 * 1024, `${implementation} ${key}: recovery budget exceeded`);
    } else {
      assert.equal(run.coldWorkerSourceBytes, 0, `${implementation} ${key}: Worker source PCM survived the cold render`);
      assert.equal(run.coldEvictedSourceBytes, expectedBytes, `${implementation} ${key}: immediate release-byte accounting mismatch`);
      assert.equal(run.diagnostics.sourceBytes, 0, `${implementation} ${key}: Worker retained source PCM`);
      assert.equal(run.diagnostics.workerSourcesEvicted, true, `${implementation} ${key}: immediate source release not acknowledged`);
      assert.equal(run.diagnostics.evictedSourceBytes, expectedBytes, `${implementation} ${key}: released-byte accounting mismatch`);
      assert.equal(run.masterWorkerSourceBytes, 0, `${implementation} ${key}: master-cache hit rehydrated sources`);
      assert.equal(run.masterDecodedBytes, 0, `${implementation} ${key}: master-cache hit decoded sources`);
      assert.equal(run.trackEditDecodeCalls, run.sources, `${implementation} ${key}: changed track did not rebuild locally`);
      assert.equal(run.trackEditWorkerSourceBytes, 0, `${implementation} ${key}: Worker retained sources after track edit`);
      assert.equal(run.idleWorkerSourceBytes, 0, `${implementation} ${key}: idle source bytes remain`);
      assert.equal(run.postIdleMasterWorkerSourceBytes, 0, `${implementation} ${key}: post-idle master cache hit rehydrated sources`);
      assert.equal(run.peakWorkerSourceBytes, oneSourceBytes, `${implementation} ${key}: per-track Worker peak is not bounded to one distinct source`);
      assert.ok(run.peakAccountedSourcePcmOverlapBytes <= 2 * oneSourceBytes, `${implementation} ${key}: accounted source PCM overlap exceeded one source on each owner`);
      assert.equal(run.workerSourceBytesAfterTrack.length, run.sources, `${implementation} ${key}: missing per-track release observations`);
      assert.ok(run.workerSourceBytesAfterTrack.every(track => track.sourceBytes === 0), `${implementation} ${key}: source survived its last track consumer`);
      assert.ok(run.diagnostics.encodedRecoveryBytes > 0, `${implementation} ${key}: encoded local recovery missing`);
      assert.ok(run.diagnostics.encodedRecoveryBytes <= 128 * 1024 * 1024, `${implementation} ${key}: recovery budget exceeded`);
    }
    for (const field of hashFields) assert.match(run[field], /^[a-f0-9]{64}$/, `${implementation} ${key}: missing ${field}`);
    indexed.set(key, run);
  }
  for (const key of keys) assert.ok(indexed.has(key), `${implementation}: missing profile ${key}`);
  return indexed;
}

const runsByVariant = Object.fromEntries(await Promise.all(variantLogs.map(async ([label, file]) =>
  [label, indexRuns(await readRuns(file), label)])));
const recoveryByVariant = {};
for (const [label, file] of variantLogs) {
  const workerError = await readTagged(file, "controlled-worker-error-recovery");
  const warmCancel = await readTagged(file, "warm-cancel-local-recovery");
  assert.equal(workerError.length, 1, `${label}: controlled Worker-error recovery evidence missing or duplicated`);
  assert.equal(warmCancel.length, 1, `${label}: warm-cancel recovery evidence missing or duplicated`);
  assert.equal(workerError[0].implementation, label);
  assert.equal(workerError[0].fetches, 1, `${label}: unexpected retry fetch`);
  assert.equal(workerError[0].outageFetches, 0, `${label}: recovery fetched during source endpoint outage`);
  assert.ok(workerError[0].outputError < 1e-7, `${label}: Worker-error recovery output changed`);
  assert.ok(Number.isFinite(workerError[0].recoveryMs), `${label}: Worker-error recovery latency missing`);
  assert.equal(warmCancel[0].implementation, label);
  assert.equal(warmCancel[0].cancelled, "AbortError", `${label}: cancellation was not acknowledged`);
  assert.equal(warmCancel[0].latestError, 0, `${label}: warm-cancel recovery output changed`);
  assert.equal(warmCancel[0].afterEditFetches, 1, `${label}: warm-cancel retry performed a network fetch`);
  assert.ok(Number.isFinite(warmCancel[0].recoveryMs), `${label}: warm-cancel recovery latency missing`);
  recoveryByVariant[label] = {
    controlledWorkerError: workerError[0],
    warmCancellation: warmCancel[0],
  };
}

const metrics = {
  fixedRuntimeFloorPssBytes: run => run.fixedRuntimeFloorPssBytes,
  sampledWholeBrowserPeakPssBytes: run => run.sampledWholeBrowserPeakPssBytes,
  peakPssAboveRuntimeFloorBytes: run => run.sampledWholeBrowserPeakPssBytes - run.fixedRuntimeFloorPssBytes,
  retainedPssBytes: run => run.retainedPssBytes,
  retainedPssAboveRuntimeFloorBytes: run => run.retainedPssBytes - run.fixedRuntimeFloorPssBytes,
  gcRetainedPssBytes: run => run.gcRetainedPssBytes,
  peakAccountedSourcePcmOverlapBytes: run => run.peakAccountedSourcePcmOverlapBytes,
  peakDecodedSourceBytes: run => run.peakDecodedSourceBytes,
  peakWorkerSourceBytes: run => run.peakWorkerSourceBytes,
  coldWorkerSourceBytes: run => run.coldWorkerSourceBytes,
  coldEvictedSourceBytes: run => run.coldEvictedSourceBytes,
  workerRetainedSourceBytes: run => run.diagnostics.sourceBytes,
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
  return Object.fromEntries(Object.entries(metrics).map(([name, value]) =>
    [name, median(rows.map(value))]));
}

const comparisons = [];
for (const sources of expectedSources) {
  const variantRows = Object.fromEntries(variantLogs.map(([label]) =>
    [label, expectedRepeats.map(repeat => runsByVariant[label].get(`${sources}:${repeat}`))]));
  for (let index = 0; index < expectedRepeats.length; index++) {
    const rows = Object.fromEntries(variantLogs.map(([label]) => [label, variantRows[label][index]]));
    for (const field of hashFields) {
      for (const label of ["prototype2", "prototype3", "prototype4"]) {
        assert.equal(rows[label][field], rows.baseline[field], `${sources} sources, repeat ${index + 1}: ${label} ${field} differs from baseline`);
      }
    }
  }
  const byVariant = Object.fromEntries(variantLogs.map(([label]) => [label, summarize(runsByVariant[label], sources)]));
  const deltas = {};
  for (const label of ["prototype2", "prototype3", "prototype4"]) {
    deltas[`${label}VsBaseline`] = Object.fromEntries(Object.keys(metrics).map(key => [key, byVariant[label][key] - byVariant.baseline[key]]));
  }
  deltas.prototype3VsPrototype2 = Object.fromEntries(Object.keys(metrics).map(key => [key, byVariant.prototype3[key] - byVariant.prototype2[key]]));
  deltas.prototype4VsPrototype2 = Object.fromEntries(Object.keys(metrics).map(key => [key, byVariant.prototype4[key] - byVariant.prototype2[key]]));
  deltas.prototype4VsPrototype3 = Object.fromEntries(Object.keys(metrics).map(key => [key, byVariant.prototype4[key] - byVariant.prototype3[key]]));
  comparisons.push({
    sources, repeats: expectedRepeats.length,
    pcmSha256: variantRows.baseline[0].pcmSha256,
    masterEditedPcmSha256: variantRows.baseline[0].editedPcmSha256,
    trackEditedPcmSha256: variantRows.baseline[0].trackEditedPcmSha256,
    postIdleMasterPcmSha256: variantRows.baseline[0].postIdleMasterPcmSha256,
    postIdleTrackPcmSha256: variantRows.baseline[0].postIdleTrackPcmSha256,
    medianByVariant: byVariant, medianDelta: deltas, rawRuns: variantRows,
    p3AllPeakSamplesAtOrBelow512MiB: variantRows.prototype3.every(run => run.sampledWholeBrowserPeakPssBytes <= 512 * 1024 * 1024),
    p4AllPeakSamplesAtOrBelow512MiB: variantRows.prototype4.every(run => run.sampledWholeBrowserPeakPssBytes <= 512 * 1024 * 1024),
  });
}

const summary = {
  schemaVersion: 1,
  baselineCommit: process.env.BENCHMARK_BASELINE_SHA ?? null,
  prototype2Commit: process.env.BENCHMARK_PROTOTYPE2_SHA ?? null,
  prototype3Commit: process.env.BENCHMARK_PROTOTYPE3_SHA ?? null,
  prototype4Commit: process.env.BENCHMARK_PROTOTYPE4_SHA ?? null,
  runtime: { node: process.version, chromium: process.env.CHROMIUM_VERSION ?? null, runner: process.env.RUNNER_NAME ?? null, os: process.env.RUNNER_OS ?? null },
  correctness: {
    matchedProfilesPerVariant: keys.length,
    totalMatchedVariantRuns: keys.length * variantLogs.length,
    matchedColdMasterEditedAndTrackEditedStereoPcmHashes: true,
    unchangedReplayPreservedFinishedBufferIdentity: true,
    masterOnlyEditsReusedPreMasterMixWithoutFetchOrDecode: true,
    trackEditsUsedLocalRecoveryWithoutNetworkFetch: true,
    workerErrorAndWarmCancellationRecoveredLocally: true,
    mainThreadGapGateMs: 250,
    comparisonCeilingMs: 300,
  },
  recoveryByVariant: recoveryByVariant,
  memoryTarget: "512 MiB sampled browser-tree peak PSS; diagnostic threshold, not a release gate",
  fixedRuntimeFloor: "Median of five 50 ms PSS samples after loading the benchmark fixture page and before creating AudioContext, Worker, or source PCM; process-tree scope, not compiled Next hydration.",
  pssSampling: "Whole browser process tree sampled every 50 ms; retained PSS is measured after the existing 250 ms idle interval; post-GC result is diagnostic only.",
  allocationHypothesis: "P4 stages each audible track's source PCM, mixes it in the Worker, and releases sources after their last track consumer. Encoded recovery and the complete pre-master cache remain authoritative owners.",
  sourceCountGrowthByVariant: Object.fromEntries(variantLogs.map(([label]) => {
    const byCount = Object.fromEntries(comparisons.map(row => [row.sources, row.medianByVariant[label]]));
    return [label, {
      peakAboveRuntimeFloor4To16Bytes: byCount[16].peakPssAboveRuntimeFloorBytes - byCount[4].peakPssAboveRuntimeFloorBytes,
      peakAboveRuntimeFloor4To32Bytes: byCount[32].peakPssAboveRuntimeFloorBytes - byCount[4].peakPssAboveRuntimeFloorBytes,
      retainedAboveRuntimeFloor4To16Bytes: byCount[16].retainedPssAboveRuntimeFloorBytes - byCount[4].retainedPssAboveRuntimeFloorBytes,
      retainedAboveRuntimeFloor4To32Bytes: byCount[32].retainedPssAboveRuntimeFloorBytes - byCount[4].retainedPssAboveRuntimeFloorBytes,
    }];
  })),
  comparisons,
};
await mkdir(path.dirname(outputPath), { recursive: true });
await writeFile(outputPath, `${JSON.stringify(summary, null, 2)}\n`);
console.log(JSON.stringify({
  kind: "waveyard-four-way-ownership-comparison",
  baselineCommit: summary.baselineCommit,
  prototype2Commit: summary.prototype2Commit,
  prototype3Commit: summary.prototype3Commit,
  prototype4Commit: summary.prototype4Commit,
  matchedProfilesPerVariant: keys.length,
  totalMatchedVariantRuns: keys.length * variantLogs.length,
  bySources: comparisons.map(({ sources, medianByVariant, medianDelta, p3AllPeakSamplesAtOrBelow512MiB, p4AllPeakSamplesAtOrBelow512MiB }) =>
    ({ sources, medianByVariant, medianDelta, p3AllPeakSamplesAtOrBelow512MiB, p4AllPeakSamplesAtOrBelow512MiB })),
}));
