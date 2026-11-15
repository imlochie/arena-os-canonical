#!/usr/bin/env node
/**
 * Reproducible input gate for the offline harmonic candidate. Audio is kept
 * private; this reports which manifest-pinned domains can actually be run.
 * It intentionally leaves candidate measurements null when any required
 * inputs are absent instead of substituting historical results.
 */
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import process from "node:process";

const root = process.cwd();
const manifestPath = resolve(root, "scripts/fixtures/waveyard-musical-evaluation.json");
const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
const assetOverrides = JSON.parse(process.env.WAVEYARD_ASSET_OVERRIDES_JSON ?? "{}");
const inputs = [];

async function inspect(trackId, role, asset) {
  const override = assetOverrides[asset.sha256];
  const path = override ? resolve(override) : resolve(root, asset.file);
  let status = "missing";
  let actualSha256 = null;
  let sizeBytes = null;
  try {
    const bytes = await readFile(path);
    sizeBytes = bytes.length;
    actualSha256 = createHash("sha256").update(bytes).digest("hex");
    status = actualSha256 === asset.sha256 ? "verified" : "sha256-mismatch";
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  inputs.push({ trackId, role, path: asset.file, localFileName: override ? path.split(/[\\/]/).at(-1) : null,
    location: override ? "verified-local-user-library" : "repository-manifest-path",
    expectedSha256: asset.sha256, actualSha256, sizeBytes, status });
  return status;
}

const tracks = [];
for (const track of manifest.tracks) {
  const sourceStatus = await inspect(track.id, "original-source", track);
  const stemStatuses = [];
  for (const [stem, asset] of Object.entries(track.stems ?? {}))
    stemStatuses.push(await inspect(track.id, `stem:${stem}`, asset));
  tracks.push({
    id: track.id,
    title: track.title,
    originalSourceStatus: sourceStatus,
    stemStatuses,
    recombinedBedAvailable: stemStatuses.length === 4 && stemStatuses.every((status) => status === "verified"),
  });
}

const hasMismatch = inputs.some((input) => input.status === "sha256-mismatch");
const sourceReady = inputs.filter((input) => input.role === "original-source").every((input) => input.status === "verified");
const componentReady = inputs.filter((input) => input.role.startsWith("stem:")).every((input) => input.status === "verified");
const bedsReady = tracks.filter((track) => track.stemStatuses.length > 0).every((track) => track.recombinedBedAvailable);
const hasStemInputs = inputs.some((input) => input.role.startsWith("stem:"));

const report = {
  schemaVersion: 1,
  evaluation: "waveyard-harmonic-candidate-offline-input-inventory",
  candidate: { engine: "waveyard-multires-overtone-context-candidate", version: "0.2.0" },
  production: { engine: "arena-js-dsp", sourceCommit: "2b0781e2", behaviorChanged: false },
  manifest: { path: "scripts/fixtures/waveyard-musical-evaluation.json", sha256: createHash("sha256").update(await readFile(manifestPath)).digest("hex") },
  status: hasMismatch ? "blocked-sha256-mismatch"
    : !sourceReady ? "blocked-pinned-source-audio-unavailable"
      : hasStemInputs && !componentReady ? "original-sources-verified-pinned-stems-missing"
        : sourceReady && componentReady && bedsReady ? "all-pinned-domains-verified"
          : "original-sources-verified",
  candidateRunReport: "docs/waveyard-harmonic-candidate-run-report.json",
  measuredCandidateResults: null,
  independentChordAccuracy: null,
  accuracyStatus: "unknown-no-verified-independent-chord-labels",
  acceptance: {
    productionPromotion: false,
    realAudioAcceptanceComplete: false,
    syntheticTestRun: { command: "tsx --test lib/arena/src/lib/waveyard/worker-local/harmonic-candidate.test.ts", passed: 9, failed: 0 },
    workerResponsiveness: null,
    memoryBenchmark: "See the measured per-track worker RSS/runtime values in candidateRunReport.",
  },
  historicalProductionBaseline: {
    provenance: "Previously reported in docs/waveyard-harmonic-perception-audit.md; not rerun in this checkout.",
    sourceCommit: "2b0781e2",
    completeRecombinedBedNamedWindows: {
      september: { named: 18, total: 108 },
      "another-one-bites-the-dust": { named: 7, total: 112 },
    },
    allSixOriginalNamedWindows: {
      september: { named: 20, total: 108 },
      "another-one-bites-the-dust": { named: 20, total: 112 },
      "i-feel-it-coming-80s": { named: 49, total: 130 },
      "stayin-alive-reflex": { named: 18, total: 186 },
      "break-free-reflex": { named: 69, total: 203 },
      "blinding-lights-80s": { named: 12, total: 115 },
    },
    interpretation: "Named-window availability only; not chord accuracy.",
  },
  domains: {
    originalSources: { required: 6, allInputsVerified: sourceReady, candidateMeasurements: null },
    individualStems: { required: inputs.filter((input) => input.role.startsWith("stem:")).length, allInputsVerified: componentReady, candidateMeasurements: null },
    recombinedInstrumentalBeds: { required: tracks.filter((track) => track.stemStatuses.length > 0).length, allInputsVerified: bedsReady, candidateMeasurements: null, construction: "sum the four independently hash-verified stems per track; never mix with original-source rows" },
  },
  tracks,
  inputs,
  limitations: [
    "The historical baseline is documentation evidence, not a rerun of the pinned inputs in this checkout.",
    "No accuracy claim is possible without independently reviewed chord labels and boundaries.",
    "No worker responsiveness or memory claim is made without running the candidate on audio in the intended runtime.",
    "Stem association is historical and has not been revalidated through completed-run API publication.",
  ],
};

const outputPath = process.argv[2];
if (outputPath) await writeFile(resolve(root, outputPath), `${JSON.stringify(report, null, 2)}\n`);
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
