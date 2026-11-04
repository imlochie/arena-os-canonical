import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

const outputPath = resolve(process.argv[2] ?? "generated-artifacts/waveyard-mashup-quality/manifest.json");
const root = dirname(outputPath);
const sources = [
  {
    id: "monkeys-spinning-monkeys",
    title: "Monkeys Spinning Monkeys",
    artist: "Kevin MacLeod",
    file: "sources/monkeys-spinning-monkeys.mp3",
    sourceUrl: "https://incompetech.com/music/royalty-free/index.html?isrc=USUAN1400011",
    officialBpm: 144,
  },
  {
    id: "sneaky-snitch",
    title: "Sneaky Snitch",
    artist: "Kevin MacLeod",
    file: "sources/sneaky-snitch.mp3",
    sourceUrl: "https://incompetech.com/music/royalty-free/index.html?isrc=USUAN1100772",
    officialBpm: 87,
  },
];
const licenseUrl = "https://creativecommons.org/licenses/by/4.0/";
// Mirror tempoCompatibility in lib/arena/src/lib/waveyard/library/session-logic.ts.
const BPM_NEAR_TOLERANCE = 6;
const RATIO_LOCK_TOLERANCE = 0.03;

function tempoMatchRatio(recipientBpm, donorBpm) {
  if (!Number.isFinite(recipientBpm) || !Number.isFinite(donorBpm)
    || recipientBpm <= 0 || donorBpm <= 0) return null;
  const ratio = donorBpm / recipientBpm;
  const compatible = Math.abs(recipientBpm - donorBpm) <= BPM_NEAR_TOLERANCE
    || [0.5, 1, 2].some(lock => Math.abs(ratio - lock) <= RATIO_LOCK_TOLERANCE);
  return compatible ? ratio : null;
}
const analysisFile = resolve(root, "audio-analysis.json");
if (!existsSync(analysisFile)) {
  throw new Error(`Missing ${analysisFile}; run scripts/waveyard-mashup-analysis.ts first.`);
}
const analysisReport = JSON.parse(readFileSync(analysisFile, "utf8"));
const analysisByFile = new Map(analysisReport.tracks.map(item => [item.filename, item]));
const tracks = sources.map(source => {
  const sourcePath = resolve(root, source.file);
  const reportPath = resolve(root, `${source.id}-separation-report.json`);
  if (!existsSync(sourcePath) || !existsSync(reportPath)) {
    throw new Error(`Missing licensed input or separation report for ${source.id}.`);
  }
  const bytes = readFileSync(sourcePath);
  const separation = JSON.parse(readFileSync(reportPath, "utf8"));
  if (separation.input.sha256 !== createHash("sha256").update(bytes).digest("hex")) {
    throw new Error(`Separation report source hash does not match ${source.id}.`);
  }
  const detected = analysisByFile.get(source.file.split("/").at(-1));
  if (!detected) throw new Error(`No Waveyard analysis output for ${source.id}.`);
  const keyIsConfident = Number(detected.keyConfidence) >= 0.6 && Boolean(detected.musicalKey);
  const beatGridMs = detected.excerpt.beatGridMs?.length >= 4
    ? detected.excerpt.beatGridMs
    : null;
  const stems = Object.fromEntries(["vocals", "drums", "bass", "other"].map(stemType => {
    const path = `mixtures/${source.id}/${stemType}-estimate.wav`;
    const absoluteStemPath = resolve(root, path);
    if (!existsSync(absoluteStemPath)) throw new Error(`Missing ${source.id} ${stemType} WAV.`);
    const stemBytes = readFileSync(absoluteStemPath);
    return [stemType, {
      path,
      bytes: stemBytes.length,
      sha256: createHash("sha256").update(stemBytes).digest("hex"),
      ...separation.result.stems[stemType],
    }];
  }));
  return {
    id: source.id,
    title: source.title,
    artist: source.artist,
    album: "",
    sourcePath: source.file,
    sourceSha256: createHash("sha256").update(bytes).digest("hex"),
    sourceBytes: bytes.length,
    sourceUrl: source.sourceUrl,
    license: "CC BY 4.0",
    licenseUrl,
    officialTempoBpm: source.officialBpm,
    separationReport: `${source.id}-separation-report.json`,
    excerpt: {
      startSeconds: separation.input.processedStartSeconds,
      durationSeconds: separation.input.processedDurationSeconds,
    },
    separationMetrics: {
      platform: separation.platform,
      osType: separation.osType,
      osRelease: separation.osRelease,
      architecture: separation.architecture,
      cpuModel: separation.cpuModel,
      logicalCpuCount: separation.logicalCpuCount,
      requestedDevice: separation.requestedDevice,
      resolvedDevice: separation.result.resolvedDevice,
      ortExecutionMode: separation.ortExecutionMode,
      ortIntraOpThreads: separation.ortIntraOpThreads,
      ortInterOpThreads: separation.ortInterOpThreads,
      elapsedMs: separation.result.elapsedMs,
      realtimeFactor: separation.result.realtimeFactor,
      maxPlaybackTimerGapMs: separation.timings?.maxPlaybackTimerGapMs ?? null,
      playbackResponsivenessPassed: separation.timings?.playbackResponsivenessPassed
        ?? (typeof separation.timings?.maxPlaybackTimerGapMs === "number"
          && separation.timings.maxPlaybackTimerGapMs < 1_000),
      models: separation.models,
    },
    analysis: {
      bpm: detected.bpm ?? source.officialBpm,
      bpmConfidence: detected.bpmConfidence,
      bpmSource: detected.bpm === null ? "publisher-listed fallback" : "Waveyard analyzer",
      detectedMusicalKey: detected.musicalKey,
      musicalKey: keyIsConfident ? detected.musicalKey : null,
      keyConfidence: detected.keyConfidence,
      analyzedExcerptStartSeconds: detected.excerpt.startSeconds,
      analyzedExcerptDurationSeconds: detected.excerpt.durationSeconds,
      beatGridMs,
      beatConfidence: detected.beatConfidence,
      keyMatchEligible: keyIsConfident,
    },
    stems,
  };
});

const trackById = new Map(tracks.map(track => [track.id, track]));
const candidateCombinations = [
  { id: "monkeys-to-sneaky-other", leadTrackId: "monkeys-spinning-monkeys", donorTrackId: "sneaky-snitch", stemType: "other" },
  { id: "sneaky-to-monkeys-other", leadTrackId: "sneaky-snitch", donorTrackId: "monkeys-spinning-monkeys", stemType: "other" },
];
const combinations = candidateCombinations.filter(combination => {
  const lead = JSON.parse(readFileSync(resolve(root, trackById.get(combination.leadTrackId).separationReport), "utf8"));
  const donor = JSON.parse(readFileSync(resolve(root, trackById.get(combination.donorTrackId).separationReport), "utf8"));
  return lead.result.stems[combination.stemType].rmsDbfs > -60
    && donor.result.stems[combination.stemType].rmsDbfs > -60;
}).map(combination => {
  const lead = trackById.get(combination.leadTrackId);
  const donor = trackById.get(combination.donorTrackId);
  return {
    ...combination,
    keyMatchMode: lead.analysis.keyMatchEligible && donor.analysis.keyMatchEligible ? "camelot" : "off",
    requestedTempoStretchRatio: donor.analysis.bpm / lead.analysis.bpm,
    expectedTempoStretchRatio: tempoMatchRatio(lead.analysis.bpm, donor.analysis.bpm),
  };
});
if (combinations.length < 2) {
  throw new Error("Fewer than two audible candidate stem swaps passed the RMS eligibility check.");
}

const manifest = {
  schemaVersion: 1,
  captureSeconds: 8,
  outputDirectory: "live-captures",
  platform: "Linux Chromium; fixture-backed API, real licensed source excerpts and local model-separated stems",
  tracks,
  combinations,
};
writeFileSync(outputPath, `${JSON.stringify(manifest, null, 2)}\n`);
console.log(JSON.stringify({
  outputPath,
  combinationIds: combinations.map(item => item.id),
  analysis: tracks.map(track => ({
    id: track.id,
    officialTempoBpm: track.officialTempoBpm,
    analyzedTempoBpm: track.analysis.bpm,
    tempoConfidence: track.analysis.bpmConfidence,
    detectedKey: track.analysis.detectedMusicalKey,
    keyConfidence: track.analysis.keyConfidence,
    keyMatchMode: combinations.find(item => item.leadTrackId === track.id)?.keyMatchMode ?? "n/a",
  })),
}, null, 2));
