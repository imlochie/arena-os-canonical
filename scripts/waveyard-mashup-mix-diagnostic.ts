/**
 * Mashup mix-bus stage isolation — the diagnostic for "there is a thin
 * electronic whistle in some renders".
 *
 * The point of this script is to make the *stage* an explicit axis rather
 * than an assumption. For one seed signal it renders the same mashup seven
 * ways, from the untouched source stems through to the final exported WAV,
 * and measures every stage with the same estimator:
 *
 *   - narrow spectral peaks that are not present in the input, with their
 *     frequency and how far they sit above the local spectral floor;
 *   - high-band energy (2–22 kHz, 8–22 kHz, 12–22 kHz) as an absolute level
 *     and as a fraction of the total, against the untouched input.
 *
 * Reading the result: a stage that adds a *stationary* narrow peak has a
 * processing artefact. A stage that raises broadband high-frequency energy
 * but adds no stationary peak is doing something else (usually time-varying
 * reconstruction noise, which is audible as "grain", not a whistle).
 *
 * This is a synthetic fixture on purpose: it is deterministic, it carries no
 * licensing question, and a known input makes "new" energy measurable. It
 * does **not** prove anything about a particular real song, and it cannot by
 * itself identify a whistle that only appears in a real separated stem.
 *
 *   ./scripts/node_modules/.bin/tsx scripts/waveyard-mashup-mix-diagnostic.ts
 *   ./scripts/node_modules/.bin/tsx scripts/waveyard-mashup-mix-diagnostic.ts --json report.json
 */
import { writeFileSync } from "node:fs";
import { pitchShift, timeStretch } from "../lib/arena/src/lib/waveyard/elastic.ts";
import { fftInPlace } from "../lib/arena/src/lib/waveyard/separation/fft.ts";
import {
  planMashup,
  renderMashupWithBus,
  type MashupSourceProfile,
} from "../lib/arena/src/lib/waveyard/studio/mashup.ts";
import { encodeWav16, decodeWav16 } from "../lib/arena/src/lib/waveyard/mixer/synth.ts";
import { measureLoudness, samplePeak, truePeakDb } from "../lib/arena/src/lib/waveyard/mixer/meters.ts";

const RATE = 44_100;
const FFT_SIZE = 8192;
const BAND_EDGES = [2_000, 8_000, 12_000] as const;

/** Peak-to-local-floor threshold for calling something a narrow peak. */
const PEAK_LIFT_DB = 18;
/** Half-width (bins) of the neighbourhood a peak has to beat. */
const PEAK_NEIGHBOURHOOD = 20;
/** Bin skip either side of a candidate so the peak does not mask its own floor. */
const PEAK_GUARD = 3;
/** Peaks within this many bins are treated as the same component. */
const PEAK_MERGE_BINS = 3;
/** Level (dB) a component must gain over the comparison stage to count as new. */
const MIN_NEW_ENERGY_DB = 6;

type SpectrumStats = {
  hzPerBin: number;
  /** Averaged magnitude spectrum, bin 0..FFT_SIZE/2. */
  magnitude: Float64Array;
  totalPower: number;
};

type BandStats = { absDb: number; fractionDb: number };
type NarrowPeak = { hz: number; liftDb: number; levelDb: number };

type StageReport = {
  stage: string;
  note: string;
  bands: Record<string, BandStats>;
  narrowPeaks: NarrowPeak[];
  /** Narrow peaks absent from the untouched source stage. */
  newPeaks: NarrowPeak[];
  /** Narrow peaks introduced by this stage relative to the one before it. */
  newSincePrevious: NarrowPeak[];
  peakDb: number;
  truePeakDb: number;
  lufs: number | null;
};

function averageSpectrum(buffer: Float32Array): SpectrumStats {
  const frames = buffer.length >> 1;
  const bins = FFT_SIZE / 2;
  const magnitude = new Float64Array(bins);
  let windows = 0;
  for (let start = 0; start + FFT_SIZE <= frames; start += FFT_SIZE) {
    const re = new Float64Array(FFT_SIZE);
    const im = new Float64Array(FFT_SIZE);
    for (let i = 0; i < FFT_SIZE; i += 1) {
      const mono = (buffer[(start + i) * 2] + buffer[(start + i) * 2 + 1]) / 2;
      re[i] = mono * (0.5 - 0.5 * Math.cos((2 * Math.PI * i) / FFT_SIZE));
    }
    fftInPlace(re, im);
    for (let i = 0; i < bins; i += 1) magnitude[i] += Math.hypot(re[i], im[i]);
    windows += 1;
  }
  if (windows > 0) for (let i = 0; i < bins; i += 1) magnitude[i] /= windows;
  let totalPower = 0;
  for (let i = 1; i < bins; i += 1) totalPower += magnitude[i] ** 2;
  return { hzPerBin: RATE / FFT_SIZE, magnitude, totalPower };
}

function bandStats(spectrum: SpectrumStats): Record<string, BandStats> {
  const result: Record<string, BandStats> = {};
  const { magnitude, hzPerBin, totalPower } = spectrum;
  for (const lo of BAND_EDGES) {
    const label = `${lo / 1000}k+`;
    let power = 0;
    for (let i = 1; i < magnitude.length; i += 1) {
      if (i * hzPerBin >= lo) power += magnitude[i] ** 2;
    }
    result[label] = {
      absDb: Number((10 * Math.log10(power + 1e-24)).toFixed(2)),
      fractionDb: Number((10 * Math.log10((power + 1e-24) / (totalPower + 1e-24))).toFixed(2)),
    };
  }
  return result;
}

function narrowPeaks(spectrum: SpectrumStats): NarrowPeak[] {
  const { magnitude, hzPerBin } = spectrum;
  const candidates: NarrowPeak[] = [];
  for (let i = 8; i < magnitude.length - PEAK_NEIGHBOURHOOD - 1; i += 1) {
    const neighbourhood: number[] = [];
    for (let k = -PEAK_NEIGHBOURHOOD; k <= PEAK_NEIGHBOURHOOD; k += 1) {
      if (Math.abs(k) <= PEAK_GUARD) continue;
      neighbourhood.push(magnitude[i + k]!);
    }
    neighbourhood.sort((a, b) => a - b);
    const floor = neighbourhood[Math.floor(neighbourhood.length / 2)] ?? 1e-24;
    const liftDb = 20 * Math.log10((magnitude[i]! + 1e-24) / (floor + 1e-24));
    if (liftDb < PEAK_LIFT_DB) continue;
    candidates.push({
      hz: Number((i * hzPerBin).toFixed(1)),
      liftDb: Number(liftDb.toFixed(1)),
      levelDb: Number((20 * Math.log10(magnitude[i]! + 1e-24)).toFixed(1)),
    });
  }
  candidates.sort((a, b) => b.liftDb - a.liftDb);
  const merged: NarrowPeak[] = [];
  for (const candidate of candidates) {
    if (merged.some((kept) => Math.abs(kept.hz - candidate.hz) < PEAK_MERGE_BINS * hzPerBin)) continue;
    merged.push(candidate);
  }
  return merged;
}

/**
 * Components that are genuinely new: they must be a narrow local peak AND
 * carry at least `MIN_NEW_ENERGY_DB` more level, in the same bin, than the
 * comparison stage did. Peak-in-a-neighbourhood alone is not enough — a
 * shifted or attenuated copy of existing material can satisfy that without
 * any new energy existing at all.
 */
function newPeaksAgainst(
  reference: SpectrumStats,
  measured: SpectrumStats,
  peaks: NarrowPeak[],
): NarrowPeak[] {
  const bin = (hz: number) => Math.round(hz / measured.hzPerBin);
  return peaks
    .filter((peak) => {
      const index = bin(peak.hz);
      const referenceLevel = 20 * Math.log10((reference.magnitude[index] ?? 1e-24) + 1e-24);
      return peak.levelDb - referenceLevel >= MIN_NEW_ENERGY_DB;
    })
    .slice(0, 12);
}

function sample(seconds: number): Float32Array {
  const frames = Math.round(seconds * RATE);
  const out = new Float32Array(frames * 2);
  for (let frame = 0; frame < frames; frame += 1) {
    const t = frame / RATE;
    // A sung-ish tone with vibrato, an octave-down bass, a broadband hat
    // pattern and a slow amplitude envelope. Deliberately not a pure sine:
    // a pure sine makes every artefact look like a "peak".
    const vibrato = 1 + 0.004 * Math.sin(2 * Math.PI * 5.2 * t);
    const vocal = 0.22 * Math.sin(2 * Math.PI * 246.94 * vibrato * t);
    const fifth = 0.12 * Math.sin(2 * Math.PI * 369.99 * vibrato * t);
    const bass = 0.18 * Math.sin(2 * Math.PI * 61.74 * t);
    const hatPhase = (t * 4) % 1;
    const hat = hatPhase < 0.04 ? 0.06 * (Math.sin(2 * Math.PI * 7100 * t) + Math.sin(2 * Math.PI * 11_300 * t)) : 0;
    const value = (vocal + fifth + bass + hat) * (0.75 + 0.25 * Math.sin(2 * Math.PI * 0.15 * t));
    out[frame * 2] = value;
    out[frame * 2 + 1] = value * 0.92;
  }
  return out;
}

function profile(overrides: Partial<MashupSourceProfile>): MashupSourceProfile {
  return {
    role: "instrumental",
    bpm: null,
    bpmConfidence: null,
    musicalKey: null,
    keyConfidence: null,
    durationMs: 12_000,
    sections: [],
    ...overrides,
  };
}

function main() {
  const vocalStem = sample(8);
  const bedStem = sample(12);
  // Keys are set to a pair that forces a real semitone move (F# major into
  // C major is 6 semitones), so the pitch stage is actually exercised rather
  // than silently skipped at 0 semitones.
  const planned = planMashup(
    profile({
      role: "vocals",
      bpm: 100,
      bpmConfidence: 0.9,
      musicalKey: "F# major",
      keyConfidence: 0.9,
      durationMs: 8_000,
      sections: [{ label: "verse", startMs: 0, endMs: 8_000 }],
    }),
    profile({
      bpm: 100,
      bpmConfidence: 0.9,
      musicalKey: "C major",
      keyConfidence: 0.9,
      durationMs: 12_000,
      sections: [{ label: "verse", startMs: 0, endMs: 12_000 }],
    }),
  );
  if (!planned.ok) throw new Error(planned.reason);
  const plan = planned.plan;

  const bus = renderMashupWithBus(plan, {
    vocals: vocalStem,
    bed: bedStem,
    sampleRate: RATE,
    mix: { matchVocalLoudness: false },
  });

  const wav = new Uint8Array(encodeWav16(bus.pcm, RATE));
  const decoded = decodeWav16(wav);
  if (decoded === null) throw new Error("the diagnostic WAV must decode");

  const stages: Array<{ stage: string; note: string; pcm: Float32Array }> = [
    { stage: "source-stems", note: "untouched synthetic vocal + bed stems, monophonic reference", pcm: bedStem },
    { stage: "vocal-time-stretch", note: `vocal stretched ×${plan.vocalsStretchRatio.toFixed(4)} (WSOLA only)`, pcm: timeStretch(vocalStem, plan.vocalsStretchRatio, RATE) },
    { stage: "vocal-stretch-pitch", note: `then pitched ${plan.vocalsPitchSemitones} semitones (stretch + sinc resample)`, pcm: pitchShift(timeStretch(vocalStem, plan.vocalsStretchRatio, RATE), plan.vocalsPitchSemitones, RATE) },
    { stage: "summed-pre-limit", note: "bed + vocal after the mix bus balance, before attenuation/limiting", pcm: (() => {
      const raw = renderMashupWithBus(plan, { vocals: vocalStem, bed: bedStem, sampleRate: RATE, mix: { matchVocalLoudness: false, limit: false } });
      return raw.pcm;
    })() },
    { stage: "final-mix", note: `static gain ${bus.mix.staticGainDb} dB, limiter ${bus.mix.limiter.applied ? "active" : "not required"}`, pcm: bus.pcm },
    { stage: "exported-wav", note: "PCM16 WAV decode of the exported file", pcm: decoded.samples },
  ];

  const reports: StageReport[] = [];
  const reference = averageSpectrum(stages[0]!.pcm);
  const referencePeaks = narrowPeaks(reference);
  let previous = reference;
  let previousPeaks = referencePeaks;
  for (const stage of stages) {
    const spectrum = averageSpectrum(stage.pcm);
    const peaks = narrowPeaks(spectrum);
    reports.push({
      stage: stage.stage,
      note: stage.note,
      bands: bandStats(spectrum),
      narrowPeaks: peaks.slice(0, 12),
      newPeaks: newPeaksAgainst(reference, spectrum, peaks),
      newSincePrevious: newPeaksAgainst(previous, spectrum, peaks),
      peakDb: Number((20 * Math.log10(Math.max(samplePeak(stage.pcm), 1e-12))).toFixed(2)),
      truePeakDb: Number(truePeakDb(stage.pcm, RATE).toFixed(2)),
      lufs: (() => {
        const value = measureLoudness(stage.pcm, RATE).integrated;
        return value === null ? null : Number(value.toFixed(2));
      })(),
    });
    previous = spectrum;
    previousPeaks = peaks;
  }

  const report = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    engine: "waveyard-mashup-render-v1",
    planner: plan.alignmentStrategy,
    fixture: "synthetic 8 s vocal + 12 s bed, 44.1 kHz stereo, deterministic shared seed",
    estimator: {
      fftSize: FFT_SIZE,
      hzPerBin: reference.hzPerBin,
      peakLiftThresholdDb: PEAK_LIFT_DB,
      newEnergyThresholdDb: MIN_NEW_ENERGY_DB,
      peakNeighbourhoodBins: PEAK_NEIGHBOURHOOD,
      note: "Average magnitude spectrum per stage; a 'new peak' is a narrow component absent from the reference stage. Broadband high-band growth without a stationary peak is reconstruction noise, not a whistle.",
    },
    stages: reports,
    interpretationLimits: [
      "Synthetic fixture: this isolates processing stages, it does not reproduce any particular real song.",
      "A real separated stem can already contain a narrow artefact from separation; this script cannot invent or exonerate that.",
      "No listening judgement is recorded here and none is implied.",
    ],
  };

  const jsonFlag = process.argv.indexOf("--json");
  if (jsonFlag !== -1 && process.argv[jsonFlag + 1]) {
    writeFileSync(process.argv[jsonFlag + 1]!, `${JSON.stringify(report, null, 2)}\n`);
    console.log(`wrote ${process.argv[jsonFlag + 1]}`);
  }

  console.log(`\nMashup mix-bus stage diagnostic (${report.fixture})\n`);
  console.log(
    "stage".padEnd(22),
    "peak dB".padStart(8),
    "true dB".padStart(8),
    "LUFS".padStart(8),
    "8k+ frac".padStart(9),
    "12k+ frac".padStart(10),
    "new".padStart(4),
  );
  for (const stage of reports) {
    console.log(
      stage.stage.padEnd(22),
      stage.peakDb.toFixed(2).padStart(8),
      stage.truePeakDb.toFixed(2).padStart(8),
      String(stage.lufs ?? "n/a").padStart(8),
      String(stage.bands["8k+"]?.fractionDb ?? "n/a").padStart(9),
      String(stage.bands["12k+"]?.fractionDb ?? "n/a").padStart(10),
      String(stage.newSincePrevious.length).padStart(4),
    );
  }
  console.log("");
  for (const stage of reports) {
    if (stage.newSincePrevious.length === 0) continue;
    console.log(
      `${stage.stage} introduced: ${stage.newSincePrevious.map((peak) => `${peak.hz} Hz (+${peak.liftDb} dB over local floor)`).join(", ")}`,
    );
  }
  const stationary = reports.some((stage) => stage.newSincePrevious.some((peak) => peak.liftDb >= 30));
  console.log(
    stationary
      ? "\nAt least one stage adds a strong narrow component: investigate that stage before blaming another."
      : "\nNo stage added a strong narrow component on this fixture. A whistle reported on a real track therefore needs the real stem audio to reproduce; this run neither confirms nor clears it.",
  );
  console.log(
    "Note: a pitch stage relocates tonal content by design, so a component that appears only after it\n" +
    "is expected transposed material unless it is also stationary while the music moves. This script\n" +
    "cannot make that distinction automatically; it reports levels only.",
  );
}

main();
