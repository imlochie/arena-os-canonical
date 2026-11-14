/**
 * Scores Waveyard key detection against the GiantSteps annotations.
 *
 * ## The honest contract
 *
 * The annotations live in this repo; the **audio does not** and must not (it is
 * commercial Beatport preview audio — see `waveyard-key-corpus-annotations.ts`).
 * So this harness has two states and it is important that it distinguishes them:
 *
 *   - **audio absent** → reports `scored: false` and an explicit reason. It never
 *     emits an accuracy figure, because there is nothing to measure. An accuracy
 *     number over annotations with no audio would be fabricated.
 *   - **audio present** → scores exact accuracy, relative major/minor confusion,
 *     a pitch-class confusion matrix, confidence calibration, trusted coverage,
 *     and the subset where confidence is high enough to be actionable.
 *
 * The point of the split is that the *corpus* work is finished and reviewable
 * today, while the *accuracy* claim waits for audio that only the user can
 * legitimately supply.
 *
 * ## Supplying audio
 *
 * The dataset's own download script fetches 2-minute previews. Place them as
 * `<trackId>.mp3` in the audio directory and pass `--audio <dir>`. Then:
 *
 *   tsx scripts/waveyard-key-evaluation.ts --audio /path/to/previews --out report.json
 */

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { analysePcm } from "../lib/arena/src/lib/waveyard/worker-local/analysis-engine";
import { hasReliableMixingConfidence } from "../lib/arena/src/lib/waveyard/types/analysis-confidence";

const here = dirname(fileURLToPath(import.meta.url));
const annotationsDirectory = resolve(here, "..", "generated-artifacts", "waveyard-key-annotations");
const ANALYSIS_RATE = 22_050;

type Annotation = { trackId: string; key: string; keys: string[] };

type Manifest = {
  totals: { annotated: number; distinctKeys: number; missingKeyClasses: number[] };
  groundTruth: { status: string; method: string; caveat: string };
  annotations: Annotation[];
};

const PITCH_CLASSES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];

function parseKey(value: string): { root: number; mode: "major" | "minor" } | null {
  const match = /^([A-G][#]?)\s+(major|minor)$/.exec(value);
  if (!match) return null;
  const root = PITCH_CLASSES.indexOf(match[1]!);
  if (root < 0) return null;
  return { root, mode: match[2] as "major" | "minor" };
}

/** Relative major/minor share a key signature; a confusion here is musical, not arbitrary. */
function isRelativePair(left: string, right: string): boolean {
  const a = parseKey(left);
  const b = parseKey(right);
  if (!a || !b || a.mode === b.mode) return false;
  return a.mode === "minor"
    ? b.root === (a.root + 3) % 12
    : b.root === (a.root + 9) % 12;
}

/** Perfect fifth: the other musically explainable confusion. */
function isFifthPair(left: string, right: string): boolean {
  const a = parseKey(left);
  const b = parseKey(right);
  if (!a || !b || a.mode !== b.mode) return false;
  return b.root === (a.root + 7) % 12 || b.root === (a.root + 5) % 12;
}

function decodeMono(path: string, ffmpeg: string): Float32Array {
  const stdout = execFileSync(
    ffmpeg,
    ["-v", "error", "-i", path, "-ac", "1", "-ar", String(ANALYSIS_RATE), "-f", "f32le", "-"],
    { maxBuffer: 1 << 30 },
  );
  return new Float32Array(stdout.buffer, stdout.byteOffset, stdout.byteLength / 4);
}

function main(): void {
  const manifestPath = join(annotationsDirectory, "manifest.json");
  if (!existsSync(manifestPath)) {
    console.error("Annotations missing. Run: tsx scripts/waveyard-key-corpus-annotations.ts");
    process.exit(1);
  }
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as Manifest;

  const audioIndex = process.argv.indexOf("--audio");
  const audioDirectory = audioIndex !== -1 ? process.argv[audioIndex + 1] : undefined;
  const ffmpeg = process.env.ARENA_FFMPEG_PATH;

  const withAudio = audioDirectory
    ? manifest.annotations.filter((annotation) => existsSync(join(resolve(audioDirectory!), `${annotation.trackId}.mp3`)))
    : [];

  // --- state 1: no audio. Report the corpus, refuse to invent a score. --------
  if (!audioDirectory || withAudio.length === 0 || !ffmpeg) {
    console.log(JSON.stringify({
      scored: false,
      reason: !audioDirectory
        ? "no --audio directory supplied; the corpus is annotations-only by design (the audio is commercial and must not be committed)"
        : !ffmpeg
        ? "ARENA_FFMPEG_PATH is not set, so the audio cannot be decoded"
        : `no annotated track had matching audio in ${resolve(audioDirectory)} (expected <trackId>.mp3)`,
      corpus: {
        annotatedTracks: manifest.totals.annotated,
        distinctKeys: manifest.totals.distinctKeys,
        missingKeyClasses: manifest.totals.missingKeyClasses,
        groundTruth: manifest.groundTruth,
      },
      readyToScore: true,
      instructions: "Provide the annotated previews as <trackId>.mp3 and re-run with --audio <dir>.",
      accuracyClaim: "none — an accuracy figure without audio would be fabricated",
    }, null, 2));
    return;
  }

  // --- state 2: audio present. Score honestly. ------------------------------
  const confusion = new Map<string, Map<string, number>>();
  let exact = 0;
  let relative = 0;
  let fifth = 0;
  let unrelated = 0;
  let trusted = 0;
  let trustedCorrect = 0;
  const calibration: Array<{ predicted: string; actual: string; confidence: number; correct: boolean }> = [];
  const failures: Array<{ trackId: string; actual: string; predicted: string | null; confidence: number | null }> = [];

  for (const annotation of withAudio) {
    const pcm = decodeMono(join(resolve(audioDirectory!), `${annotation.trackId}.mp3`), ffmpeg);
    const analysis = analysePcm(pcm);
    const predicted = analysis.musicalKey;
    const confidence = analysis.keyConfidence ?? 0;
    const actual = annotation.key;

    if (!confusion.has(actual)) confusion.set(actual, new Map());
    const row = confusion.get(actual)!;
    const column = predicted ?? "(none)";
    row.set(column, (row.get(column) ?? 0) + 1);

    const correct = predicted === actual;
    calibration.push({ predicted: column, actual, confidence, correct });
    if (correct) exact += 1;
    else if (predicted && isRelativePair(predicted, actual)) relative += 1;
    else if (predicted && isFifthPair(predicted, actual)) fifth += 1;
    else unrelated += 1;

    if (hasReliableMixingConfidence(confidence)) {
      trusted += 1;
      if (correct) trustedCorrect += 1;
    }
    if (!correct) failures.push({ trackId: annotation.trackId, actual, predicted, confidence });
  }

  const total = withAudio.length;
  // Calibration: mean confidence among correct vs incorrect predictions. A
  // trustworthy estimator has a clear gap; a badly calibrated one does not.
  const mean = (values: number[]) => values.length === 0 ? null : values.reduce((a, b) => a + b, 0) / values.length;
  const correctConfidence = mean(calibration.filter((entry) => entry.correct).map((entry) => entry.confidence));
  const incorrectConfidence = mean(calibration.filter((entry) => !entry.correct).map((entry) => entry.confidence));

  const report = {
    scored: true,
    corpus: { annotatedTracks: manifest.totals.annotated, scoredTracks: total, groundTruth: manifest.groundTruth },
    accuracy: {
      exact: exact / total,
      exactCount: exact,
      relativeConfusion: relative / total,
      fifthConfusion: fifth / total,
      unrelated: unrelated / total,
    },
    coverage: { trusted, trustedFraction: trusted / total, trustedAccuracy: trusted === 0 ? null : trustedCorrect / trusted },
    calibration: { meanConfidenceCorrect: correctConfidence, meanConfidenceIncorrect: incorrectConfidence },
    confusionMatrix: Object.fromEntries([...confusion.entries()].map(([actual, row]) => [actual, Object.fromEntries(row)])),
    failures: failures.slice(0, 80),
    listeners: 0,
    disclaimer:
      "Annotations are independent (ISMIR 2015 professional annotation) but come from one genre and one "
      + "annotation pipeline. This measures key detection; it says nothing about mashup musical quality.",
  };

  console.log(JSON.stringify({
    scored: true,
    accuracy: report.accuracy,
    coverage: report.coverage,
    calibration: report.calibration,
  }, null, 2));

  const outIndex = process.argv.indexOf("--out");
  if (outIndex !== -1 && process.argv[outIndex + 1]) {
    const destination = resolve(process.argv[outIndex + 1]!);
    writeFileSync(destination, JSON.stringify(report, null, 2));
    console.log(`\nWrote ${destination}`);
  }
}

main();
