import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const [baselineLog, prototype2Log, prototype3Log, prototype4Log, prototype5Log, outputPath] = process.argv.slice(2);
assert.ok(baselineLog && prototype2Log && prototype3Log && prototype4Log && prototype5Log && outputPath,
  "Usage: node scripts/compare-waveyard-five-way-benchmark.mjs BASELINE P2 P3 P4 P5 OUTPUT_JSON");

const expectedSources = [4, 16, 32], expectedRepeats = [1, 2, 3];
const keys = expectedSources.flatMap(sources => expectedRepeats.map(repeat => `${sources}:${repeat}`));
const variantLogs = [
  ["baseline", baselineLog], ["prototype2", prototype2Log], ["prototype3", prototype3Log],
  ["prototype4", prototype4Log], ["prototype5", prototype5Log],
];
const hashFields = [
  "pcmSha256", "editedPcmSha256", "trackEditedPcmSha256",
  "repeatedHotTrackEditedPcmSha256", "coldTrackEditedPcmSha256",
  "postIdleMasterPcmSha256", "postIdleTrackPcmSha256",
];
const componentStages = [
  "initial", "replay", "masterEdit", "hotTrackEdit", "repeatedHotTrackEdit",
  "coldTrackEdit", "postIdleMasterEdit", "postIdleTrackEdit",
];
const componentFields = [
  "assetFetchMs", "responseBodyMs", "recoveryArrayBufferMs", "decodeMs", "decodeCalls",
  "sourceChannelCopyMs", "sourceTransferPostMs", "workerTrackAckMs",
  "workerRenderResultMs", "workerFinishAckMs",
  "encodedRecoveryLookupMs", "encodedRecoveryLookupCount",
  "decodedOwnerLookupMs", "decodedOwnerLookupCount",
  "workerSourceCacheLookupMs", "workerSourceCacheLookupCount", "workerSourceCacheHits",
];
const logMarker = "{\"kind\":\"distinct-source-canonical-worker\"";

async function readRuns(file) {
  const text = await readFile(file, "utf8"), runs = [];
  for (const line of text.split(/\r?\n/)) {
    const start = line.indexOf(logMarker);
    if (start >= 0) runs.push(JSON.parse(line.slice(start).trim()));
  }
  return runs;
}
async function readTagged(file, kind) {
  const text = await readFile(file, "utf8"), found = [], tag = `{"kind":"${kind}"`;
  for (const line of text.split(/\r?\n/)) {
    const start = line.indexOf(tag);
    if (start >= 0) found.push(JSON.parse(line.slice(start).trim()));
  }
  return found;
}
function median(values) {
  const ordered = [...values].sort((a, b) => a - b), middle = Math.floor(ordered.length / 2);
  return ordered.length % 2 ? ordered[middle] : (ordered[middle - 1] + ordered[middle]) / 2;
}
function indexRuns(runs, label) {
  assert.equal(runs.length, keys.length, `${label}: expected ${keys.length} measurement cells, got ${runs.length}`);
  const indexed = new Map();
  for (const run of runs) {
    const key = `${run.sources}:${run.repeat}`;
    assert.equal(run.implementation, label, `${label}: unexpected implementation label`);
    assert.ok(keys.includes(key), `${label}: unexpected profile ${key}`);
    assert.ok(!indexed.has(key), `${label}: duplicate profile ${key}`);
    assert.equal(run.frames, 441000, `${label} ${key}: wrong frame count`);
    assert.equal(run.latestEditError, 0, `${label} ${key}: master output mismatch`);
    assert.ok(run.replaySame, `${label} ${key}: replay lost finished-buffer identity`);
    assert.ok(Number.isFinite(run.sampledWholeBrowserPeakPssBytes), `${label} ${key}: peak PSS missing`);
    assert.ok(Number.isFinite(run.retainedPssBytes), `${label} ${key}: retained PSS missing`);
    assert.ok(Number.isFinite(run.fixedRuntimeFloorPssBytes), `${label} ${key}: runtime floor missing`);
    assert.ok(run.maximumGapMs < 250, `${label} ${key}: existing 250 ms UI-gap gate exceeded`);
    assert.ok(run.maximumGapMs < 300, `${label} ${key}: 300 ms comparison ceiling exceeded`);
    for (const field of hashFields) assert.match(run[field], /^[a-f0-9]{64}$/, `${label} ${key}: missing ${field}`);
    for (const stage of componentStages) {
      assert.ok(run.stageBreakdown?.[stage], `${label} ${key}: ${stage} component measurements missing`);
      for (const field of componentFields) {
        assert.ok(Number.isFinite(run.stageBreakdown[stage][field]), `${label} ${key}: ${stage}.${field} missing`);
      }
    }

    const expectedBytes = run.sources * 441000 * 2 * 4;
    const oneSourceBytes = 441000 * 2 * 4;
    const expectedActiveCount = Math.min(4, Math.max(1, run.sources - 1));
    const expectedActiveIdentities = Array.from({ length: expectedActiveCount }, (_, index) => `synthetic-tone:${220 + index * 17}Hz`);
    assert.deepEqual(run.activeSourceIdentities, expectedActiveIdentities, `${label} ${key}: active source identity fixture changed`);
    assert.equal(run.selectedTrackIds.length, expectedActiveCount, `${label} ${key}: selected track count changed`);
    assert.equal(run.hotSourceIdentity, expectedActiveIdentities[0], `${label} ${key}: hot source identity changed`);
    assert.equal(run.coldSourceIdentity, `synthetic-tone:${220 + expectedActiveCount * 17}Hz`, `${label} ${key}: cold source identity changed`);
    assert.equal(run.coldFetches, run.sources, `${label} ${key}: cold fetch count mismatch`);
    assert.equal(run.replayFetches, 0, `${label} ${key}: replay fetched`);
    assert.equal(run.replayDecodeCalls, 0, `${label} ${key}: replay decoded`);
    assert.equal(run.masterEditFetches, 0, `${label} ${key}: master edit fetched`);
    assert.equal(run.masterEditDecodeCalls, 0, `${label} ${key}: master edit decoded`);
    assert.ok(run.masterMixCacheHit, `${label} ${key}: master edit missed pre-master cache`);
    assert.equal(run.trackEditFetches, 0, `${label} ${key}: hot edit fetched`);
    assert.equal(run.repeatedHotTrackEditFetches, 0, `${label} ${key}: repeated hot edit fetched`);
    assert.equal(run.coldTrackEditFetches, 0, `${label} ${key}: cold edit fetched`);
    assert.equal(run.postIdleMasterEditFetches, 0, `${label} ${key}: post-idle master edit fetched`);
    assert.equal(run.postIdleTrackEditFetches, 0, `${label} ${key}: post-idle track edit fetched`);
    assert.ok(!run.trackEditMixCacheHit, `${label} ${key}: hot edit reused stale mix`);
    assert.ok(!run.coldTrackEditMixCacheHit, `${label} ${key}: cold edit reused stale mix`);
    assert.ok(run.diagnostics.retainedMixBytes > 0, `${label} ${key}: pre-master cache missing`);
    assert.equal(run.diagnostics.finishedBytes, run.outputPlanarBytes, `${label} ${key}: output buffer accounting mismatch`);
    assert.ok(Number.isFinite(run.peakAccountedSourcePcmOverlapBytes), `${label} ${key}: PCM overlap measurement missing`);

    if (label === "baseline") {
      assert.equal(run.diagnostics.sourceBytes, expectedBytes);
      assert.equal(run.diagnostics.decodedBytes, expectedBytes);
      assert.equal(run.trackEditDecodeCalls, 0);
      assert.equal(run.trackEditWorkerSourceBytes, expectedBytes);
      assert.equal(run.coldTrackEditDecodeCalls, 0);
      assert.equal(run.peakWorkerSourceBytes, expectedBytes);
      assert.equal(run.postIdleTrackEditDecodeCalls, 0);
    } else if (label === "prototype2") {
      assert.equal(run.diagnostics.sourceBytes, expectedBytes);
      assert.equal(run.diagnostics.decodedBytes, 0);
      assert.equal(run.trackEditDecodeCalls, 0);
      assert.equal(run.trackEditWorkerSourceBytes, expectedBytes);
      assert.equal(run.coldTrackEditDecodeCalls, 0);
      assert.equal(run.peakWorkerSourceBytes, expectedBytes);
      assert.equal(run.postIdleTrackEditDecodeCalls, 0);
    } else if (label === "prototype3") {
      assert.equal(run.coldWorkerSourceBytes, expectedBytes);
      assert.equal(run.diagnostics.sourceBytes, 0);
      assert.equal(run.diagnostics.workerSourcesEvicted, true);
      assert.equal(run.masterWorkerSourceBytes, expectedBytes);
      assert.equal(run.trackEditDecodeCalls, 0);
      assert.equal(run.trackEditWorkerSourceBytes, expectedBytes);
      assert.equal(run.coldTrackEditDecodeCalls, 0);
      assert.equal(run.idleWorkerSourceBytes, 0);
      assert.equal(run.postIdleTrackEditDecodeCalls, run.sources);
      assert.equal(run.peakWorkerSourceBytes, expectedBytes);
    } else if (label === "prototype4") {
      assert.equal(run.coldWorkerSourceBytes, 0);
      assert.equal(run.coldEvictedSourceBytes, expectedBytes);
      assert.equal(run.diagnostics.sourceBytes, 0);
      assert.equal(run.diagnostics.workerSourcesEvicted, true);
      assert.equal(run.trackEditDecodeCalls, run.sources);
      assert.equal(run.trackEditWorkerSourceBytes, 0);
      assert.equal(run.coldTrackEditDecodeCalls, run.sources);
      assert.equal(run.postIdleTrackEditDecodeCalls, run.sources);
      assert.equal(run.peakWorkerSourceBytes, oneSourceBytes);
      assert.ok(run.peakAccountedSourcePcmOverlapBytes <= 2 * oneSourceBytes);
      assert.ok(run.diagnostics.encodedRecoveryBytes > 0);
    } else {
      const expectedWarmSources = Math.min(4, Math.max(1, run.sources - 1));
      const expectedWarmBytes = expectedWarmSources * oneSourceBytes;
      assert.equal(run.warmSourceBytes, expectedWarmBytes, `${label} ${key}: selected working set differs`);
      assert.ok(run.warmSourceBytes <= 16 * 1024 * 1024, `${label} ${key}: retained PCM exceeds warm byte budget`);
      assert.equal(run.coldWorkerSourceBytes, expectedWarmBytes);
      assert.equal(run.coldEvictedSourceBytes, expectedBytes - expectedWarmBytes);
      assert.equal(run.trackEditDecodeCalls, run.sources - expectedWarmSources);
      assert.equal(run.repeatedHotTrackEditDecodeCalls, run.sources - expectedWarmSources);
      assert.equal(run.coldTrackEditDecodeCalls, run.sources - expectedWarmSources);
      assert.equal(run.trackEditWorkerSourceBytes, expectedWarmBytes);
      assert.equal(run.coldTrackEditWorkerSourceBytes, expectedWarmBytes);
      assert.equal(run.warmSourceBytesAfterHotEdit, expectedWarmBytes);
      assert.equal(run.warmSourceBytesAfterRepeatedHotEdit, expectedWarmBytes);
      assert.equal(run.warmSourceBytesAfterColdEdit, expectedWarmBytes);
      assert.ok(run.peakWorkerSourceBytes <= expectedWarmBytes + oneSourceBytes);
      assert.ok(run.peakAccountedSourcePcmOverlapBytes <= expectedWarmBytes + 2 * oneSourceBytes);
      assert.equal(run.diagnostics.sourceBytes, 0);
      assert.equal(run.diagnostics.warmSourceBytes, 0);
      assert.equal(run.diagnostics.workerSourcesEvicted, true);
      assert.equal(run.postIdleTrackEditDecodeCalls, run.sources);
      assert.equal(run.postIdleTrackWorkerSourceBytes, expectedWarmBytes);
      assert.ok(run.diagnostics.encodedRecoveryBytes > 0);
      assert.ok(run.diagnostics.encodedRecoveryBytes <= 128 * 1024 * 1024);
    }
    for (const field of ["pcmSha256", "editedPcmSha256", "trackEditedPcmSha256",
      "repeatedHotTrackEditedPcmSha256", "coldTrackEditedPcmSha256",
      "postIdleMasterPcmSha256", "postIdleTrackPcmSha256"]) assert.ok(run[field]);
    indexed.set(key, run);
  }
  for (const key of keys) assert.ok(indexed.has(key), `${label}: missing profile ${key}`);
  return indexed;
}

const runsByVariant = Object.fromEntries(await Promise.all(variantLogs.map(async ([label, file]) =>
  [label, indexRuns(await readRuns(file), label)])));
const recoveryByVariant = {};
for (const [label, file] of variantLogs) {
  const workerError = await readTagged(file, "controlled-worker-error-recovery");
  const warmCancel = await readTagged(file, "warm-cancel-local-recovery");
  assert.equal(workerError.length, 1, `${label}: Worker-error recovery evidence missing/duplicated`);
  assert.equal(warmCancel.length, 1, `${label}: cancellation recovery evidence missing/duplicated`);
  assert.equal(workerError[0].implementation, label);
  assert.equal(workerError[0].fetches, 1);
  assert.equal(workerError[0].outageFetches, 0);
  assert.ok(workerError[0].outputError < 1e-7);
  assert.equal(warmCancel[0].implementation, label);
  assert.equal(warmCancel[0].cancelled, "AbortError");
  assert.equal(warmCancel[0].latestError, 0);
  assert.equal(warmCancel[0].afterEditFetches, 1);
  recoveryByVariant[label] = { controlledWorkerError: workerError[0], warmCancellation: warmCancel[0] };
}

const comparisons = [];
for (const sources of expectedSources) {
  const variantRows = Object.fromEntries(variantLogs.map(([label]) =>
    [label, expectedRepeats.map(repeat => runsByVariant[label].get(`${sources}:${repeat}`))]));
  for (let repeatIndex = 0; repeatIndex < expectedRepeats.length; repeatIndex++) {
    const rows = Object.fromEntries(variantLogs.map(([label]) => [label, variantRows[label][repeatIndex]]));
    for (const field of hashFields) {
      for (const [label] of variantLogs.slice(1)) {
        assert.equal(rows[label][field], rows.baseline[field],
          `${sources} sources repeat ${repeatIndex + 1}: ${label} ${field} differs from baseline`);
      }
    }
  }
  const medianByVariant = {};
  const medianStageBreakdownByVariant = {};
  for (const [label] of variantLogs) {
    const rows = variantRows[label];
    const metric = name => median(rows.map(run => name(run)));
    medianByVariant[label] = {
      peakPssBytes: metric(run => run.sampledWholeBrowserPeakPssBytes),
      peakAboveRuntimeFloorBytes: metric(run => run.sampledWholeBrowserPeakPssBytes - run.fixedRuntimeFloorPssBytes),
      retainedPssBytes: metric(run => run.retainedPssBytes),
      retainedAboveRuntimeFloorBytes: metric(run => run.retainedPssBytes - run.fixedRuntimeFloorPssBytes),
      gcRetainedPssBytes: metric(run => run.gcRetainedPssBytes),
      hotTrackEditMs: metric(run => run.trackEditMs),
      repeatedHotTrackEditMs: metric(run => run.repeatedHotTrackEditMs),
      coldTrackEditMs: metric(run => run.coldTrackEditMs),
      postIdleColdTrackEditMs: metric(run => run.postIdleTrackEditMs),
      hotTrackDecodeMs: metric(run => run.trackEditDecodeMs),
      coldTrackDecodeMs: metric(run => run.coldTrackEditDecodeMs),
      postIdleTrackDecodeMs: metric(run => run.postIdleTrackEditDecodeMs),
      maximumGapMs: metric(run => run.maximumGapMs),
      peakWorkerSourceBytes: metric(run => run.peakWorkerSourceBytes),
      peakAccountedSourcePcmOverlapBytes: metric(run => run.peakAccountedSourcePcmOverlapBytes),
      warmSourceBytesAfterInitialRender: metric(run => run.warmSourceBytes),
    };
    medianStageBreakdownByVariant[label] = Object.fromEntries(componentStages.map(stage => [
      stage, Object.fromEntries(componentFields.map(field => [
        field, median(rows.map(run => run.stageBreakdown[stage][field])),
      ])),
    ]));
  }
  const p3 = medianByVariant.prototype3, p4 = medianByVariant.prototype4, p5 = medianByVariant.prototype5;
  comparisons.push({
    sources, repeats: expectedRepeats.length,
    activeSelectionFixture: "Up to four synthetic source identities (220/237/254/271 Hz); at 4 sources, three are selected so one cold source remains. Resolved to real track IDs identically by fixture semantics.",
    hashes: Object.fromEntries(hashFields.map(field => [field, variantRows.baseline[0][field]])),
    medianByVariant, medianStageBreakdownByVariant, rawRuns: variantRows,
    p3AllPeakSamplesAtOrBelow512MiB: variantRows.prototype3.every(run => run.sampledWholeBrowserPeakPssBytes <= 512 * 1024 * 1024),
    p4AllPeakSamplesAtOrBelow512MiB: variantRows.prototype4.every(run => run.sampledWholeBrowserPeakPssBytes <= 512 * 1024 * 1024),
    p5AllPeakSamplesAtOrBelow512MiB: variantRows.prototype5.every(run => run.sampledWholeBrowserPeakPssBytes <= 512 * 1024 * 1024),
    p5PeakPssSavingsVsP3Bytes: p3.peakPssBytes - p5.peakPssBytes,
    p5RetainedPssSavingsVsP3Bytes: p3.retainedPssBytes - p5.retainedPssBytes,
    p5HotEditLatencyReductionVsP4: p4.hotTrackEditMs > 0 ? 1 - p5.hotTrackEditMs / p4.hotTrackEditMs : null,
  });
}

const at32 = comparisons.find(row => row.sources === 32);
const hotLatencyReduction = at32.p5HotEditLatencyReductionVsP4;
const peakMemorySavings = at32.p5PeakPssSavingsVsP3Bytes;
const retainedMemorySavings = at32.p5RetainedPssSavingsVsP3Bytes;
const targets = {
  hotEditAtLeast25PercentFasterThanP4: hotLatencyReduction >= 0.25,
  peakPssAtLeast50MiBBelowP3: peakMemorySavings >= 50 * 1024 * 1024,
  retainedPssBelowP3: retainedMemorySavings > 0,
};
const summary = {
  schemaVersion: 1,
  baselineCommit: process.env.BENCHMARK_BASELINE_SHA ?? null,
  prototype2Commit: process.env.BENCHMARK_PROTOTYPE2_SHA ?? null,
  prototype3Commit: process.env.BENCHMARK_PROTOTYPE3_SHA ?? null,
  prototype4Commit: process.env.BENCHMARK_PROTOTYPE4_SHA ?? null,
  prototype5Commit: process.env.BENCHMARK_PROTOTYPE5_SHA ?? null,
  runtime: { node: process.version, chromium: process.env.CHROMIUM_VERSION ?? null, runner: process.env.RUNNER_NAME ?? null, os: process.env.RUNNER_OS ?? null },
  correctness: {
    matchedProfilesPerVariant: keys.length,
    totalMatchedVariantRuns: keys.length * variantLogs.length,
    allSevenStereoPcmHashesMatchedAcrossVariants: true,
    unchangedReplayPreservedFinishedBufferIdentity: true,
    masterOnlyEditsReusedPreMasterMixWithoutFetchOrDecode: true,
    hotAndColdEditsUsedLocalRecoveryWithoutNetworkFetch: true,
    workerErrorAndWarmCancellationRecoveredLocally: true,
    existingMainThreadGapGateMs: 250,
    comparisonCeilingMs: 300,
  },
  recoveryByVariant,
  componentMeasurement: "Browser-side fetch/body/decode/recovery lookup/channel copy/transfer timings; Worker track-ack, render-result, and finish-render round trips. Worker round trips include scheduling/IPC, not just DSP CPU.",
  warmSetPolicy: {
    signal: "Current user-selected track or selected clips in StudioCore, translated to stable track/source keys.",
    byteBudget: 16 * 1024 * 1024,
    replacement: "Unselected source PCM released after its last consumer; selected completed PCM retained by priority only while within byte budget.",
    idleReleaseMs: 5000,
    recoveryOwner: "Bounded encoded Blob recovery remains intact; no network fallback is required for local edits.",
  },
  memoryTarget: "512 MiB sampled browser-tree peak PSS is diagnostic only, not a release gate.",
  p5Targets: {
    hotEditLatencyReductionVsP4: hotLatencyReduction,
    peakPssSavingsVsP3Bytes: peakMemorySavings,
    retainedPssSavingsVsP3Bytes: retainedMemorySavings,
    criteria: targets,
    decision: Object.values(targets).every(Boolean) ? "continue" : "iterate-or-reject; P5 does not meet every specified target",
  },
  sourceCountGrowthByVariant: Object.fromEntries(variantLogs.map(([label]) => {
    const byCount = Object.fromEntries(comparisons.map(row => [row.sources, row.medianByVariant[label]]));
    return [label, {
      peakAboveRuntimeFloor4To16Bytes: byCount[16].peakAboveRuntimeFloorBytes - byCount[4].peakAboveRuntimeFloorBytes,
      peakAboveRuntimeFloor4To32Bytes: byCount[32].peakAboveRuntimeFloorBytes - byCount[4].peakAboveRuntimeFloorBytes,
      retainedAboveRuntimeFloor4To16Bytes: byCount[16].retainedAboveRuntimeFloorBytes - byCount[4].retainedAboveRuntimeFloorBytes,
      retainedAboveRuntimeFloor4To32Bytes: byCount[32].retainedAboveRuntimeFloorBytes - byCount[4].retainedAboveRuntimeFloorBytes,
    }];
  })),
  comparisons,
};
await mkdir(path.dirname(outputPath), { recursive: true });
await writeFile(outputPath, `${JSON.stringify(summary, null, 2)}\n`);
console.log(JSON.stringify({
  kind: "waveyard-five-way-ownership-comparison",
  baselineCommit: summary.baselineCommit, prototype2Commit: summary.prototype2Commit,
  prototype3Commit: summary.prototype3Commit, prototype4Commit: summary.prototype4Commit,
  prototype5Commit: summary.prototype5Commit,
  matchedProfilesPerVariant: keys.length, totalMatchedVariantRuns: keys.length * variantLogs.length,
  targetDecision: summary.p5Targets,
  bySources: comparisons.map(({ sources, medianByVariant, p5HotEditLatencyReductionVsP4, p5PeakPssSavingsVsP3Bytes }) =>
    ({ sources, medianByVariant, p5HotEditLatencyReductionVsP4, p5PeakPssSavingsVsP3Bytes })),
}));
