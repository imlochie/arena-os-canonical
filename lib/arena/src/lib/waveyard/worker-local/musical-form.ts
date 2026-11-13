import type { SourceSectionCandidate } from "../types/source-sections";
import { ANALYSIS_PCM_RATE, chromaFromPcm } from "./analysis-engine";

export type FormWindow = {
  startBar: number;
  /** Time-ordered, track-centred vocal and original source pitch-class observations. */
  vocal: number[];
  backing: number[];
  /** Beat-relative vocal activity and pitched articulation, not words/lyrics. */
  vocalPhraseTiming?: number[];
  vocalCoverage: number;
  energyDb: number;
};
export type FormPrediction = {
  startBar: number;
  endBar: number;
  label: "verse" | "chorus";
  /** Uncalibrated evidence strength, never a probability of correctness. */
  strength: number;
};
// Section-role evidence must outlast a short hook/phrase. Four-bar motifs can
// be different parts of ONE verse; use eight-bar arrangements for form.
const WINDOW_BARS = 8;
const MAX_BARS = 512;
const MIN_REPEAT_SIMILARITY = 0.78;
const PHRASE_RUN_CONFIDENCE = 0.6;

function cosine(a: readonly number[], b: readonly number[]): number | null {
  let dot = 0, aa = 0, bb = 0;
  if (a.length !== b.length) return null;
  for (let i = 0; i < a.length; i++) {
    dot += a[i]! * b[i]!;
    aa += a[i]! ** 2;
    bb += b[i]! ** 2;
  }
  return aa > 1e-8 && bb > 1e-8 ? dot / Math.sqrt(aa * bb) : null;
}
const mean = (values: number[]) => values.reduce((a, b) => a + b, 0) / Math.max(1, values.length);

/**
 * Conservative recurrence/context model, not a trained semantic classifier.
 * Requires TWO distinct recurrent vocal arrangements in an A–B–A–B context,
 * plus a measured dynamic lift for the proposed chorus. Repeating a bass riff,
 * an energy peak alone, or a constant loop cannot establish either role.
 * Quiet choruses, chorus-first forms and ambiguous material may abstain.
 */
export function inferFormFromWindows(windows: readonly FormWindow[]): FormPrediction[] {
  if (windows.length < 8) return [];
  const usable = windows.filter(w => w.vocalCoverage >= 0.5
    && Number.isFinite(w.energyDb)
    && w.vocal.length > 0 && w.backing.length > 0
    && [...w.vocal, ...w.backing].every(Number.isFinite));
  const similarity = (a: FormWindow, b: FormWindow) => {
    const voice = cosine(a.vocal, b.vocal);
    const music = cosine(a.backing, b.backing);
    if (voice === null || music === null) return -1;
    const phraseTiming = cosine(a.vocalPhraseTiming ?? [], b.vocalPhraseTiming ?? []);
    // Older/unavailable vocal analysis remains a supported fallback. When
    // both windows have measured activity, their beat-relative timing is an
    // additional, explicitly non-lexical recurrence signal.
    return phraseTiming === null ? 0.7 * voice + 0.3 * music
      : 0.55 * voice + 0.15 * phraseTiming + 0.3 * music;
  };
  // Star groups are pairwise checked, not transitive similarity chains.
  const groups = usable.map(seed => {
    const members = [seed];
    const peers = usable.filter(w => Math.abs(w.startBar - seed.startBar) >= WINDOW_BARS * 2)
      .map(w => ({ w, similarity: similarity(seed, w) }))
      .filter(w => w.similarity >= MIN_REPEAT_SIMILARITY)
      .sort((a, b) => b.similarity - a.similarity);
    for (const { w } of peers) {
      if (members.every(m => Math.abs(m.startBar - w.startBar) >= WINDOW_BARS * 2
        && similarity(m, w) >= MIN_REPEAT_SIMILARITY)) members.push(w);
    }
    members.sort((a, b) => a.startBar - b.startBar);
    return { members, energy: mean(members.map(w => w.energyDb)),
      recurrence: mean(members.slice(1).map(w => similarity(seed, w))) };
  }).filter(g => g.members.length >= 2);
  const pairs: { verse: typeof groups[number]; chorus: typeof groups[number]; score: number }[] = [];
  for (const chorus of groups) {
    const first = chorus.members[0]!.startBar, last = chorus.members.at(-1)!.startBar;
    for (const verse of groups) {
      // Establish distinct arrangements, not arbitrary names for the same loop.
      if (similarity(verse.members[0]!, chorus.members[0]!) > 0.55) continue;
      if (!verse.members.some(w => w.startBar + WINDOW_BARS <= first)
        || !verse.members.some(w => w.startBar >= first + WINDOW_BARS && w.startBar + WINDOW_BARS <= last)) continue;
      if (verse.members.some(v => chorus.members.some(c =>
        Math.abs(v.startBar - c.startBar) < WINDOW_BARS))) continue;
      const lift = chorus.energy - verse.energy;
      if (lift < 1.5) continue;
      pairs.push({ verse, chorus, score: 0.5 * Math.min(verse.recurrence, chorus.recurrence)
        + 0.3 * Math.min(1, lift / 6) + 0.2 * Math.min(1, chorus.members.length / 3) });
    }
  }
  pairs.sort((a, b) => b.score - a.score);
  const best = pairs[0];
  if (!best) return [];
  const strength = Number(Math.min(0.7, 0.45 + best.score * 0.25).toFixed(3));
  // Competing, non-overlapping hook locations are ambiguous, not a tie to hide.
  // Compare non-overlapping occurrences, not the many overlapping rolling
  // windows around the same occurrence.
  const competitor = pairs.find(p => p.chorus.members.every(c =>
    best.chorus.members.every(b => Math.abs(c.startBar - b.startBar) >= WINDOW_BARS)));
  if (competitor && best.score - competitor.score < 0.05) return [];
  // A recurrent eight-bar observation identifies a passage, but is not itself
  // the whole section. Use the next independently recurring role transition
  // as its measured end. Do not fill beyond the last supported transition.
  const anchors = [
    ...best.verse.members.map(w => ({ startBar: w.startBar, label: "verse" as const })),
    ...best.chorus.members.map(w => ({ startBar: w.startBar, label: "chorus" as const })),
  ].sort((a, b) => a.startBar - b.startBar);
  const alternating: FormPrediction[] = [];
  for (let index = 0; index < anchors.length; index++) {
    const anchor = anchors[index]!;
    const nextOpposite = anchors.slice(index + 1).find(candidate => candidate.label !== anchor.label);
    const event = { ...anchor,
      // A second hook-like match does not prove the first chorus continued
      // through a breakdown/outro. Without a following opposite-role anchor,
      // keep only the directly observed eight-bar passage.
      endBar: nextOpposite?.startBar ?? anchor.startBar + WINDOW_BARS, strength };
    if (event.endBar <= event.startBar) continue;
    const expected = alternating.at(-1)?.label === "verse" ? "chorus" : "verse";
    if (event.label === expected) alternating.push(event);
  }
  // A later hook reprise without another observed verse is not automatically
  // a new chorus: it may be a breakdown or an outro.
  // A trailing verse not followed by a chorus is not enough evidence to extend
  // the form; the final repeated chorus may retain only its directly observed
  // eight-bar passage.
  if (alternating.at(-1)?.label === "verse") alternating.pop();
  return alternating;
}

/** Bounded, beat-synchronous source + independently isolated vocal features. */
export function measureFormWindows(
  sourcePcm: Float32Array,
  vocalPcm: Float32Array,
  beats: readonly number[],
  vocalPitchContinuityRuns: readonly { startMs: number; endMs: number; confidence: number }[] = [],
  vocalActivityIntervals: readonly { startMs: number; endMs: number; confidence: number }[] = [],
): FormWindow[] {
  if (!beats.every((t, i) => Number.isFinite(t) && t >= 0 && (i === 0 || t > beats[i - 1]!))) return [];
  if (Math.abs(sourcePcm.length - vocalPcm.length) / ANALYSIS_PCM_RATE > 0.5) return [];
  const validRuns = (runs: typeof vocalPitchContinuityRuns) => runs.length <= 10_000 && !runs.some((run, i) =>
    !Number.isSafeInteger(run.startMs) || !Number.isSafeInteger(run.endMs)
    || run.startMs < 0 || run.endMs <= run.startMs || !Number.isFinite(run.confidence)
    || run.confidence < 0 || run.confidence > 1
    || run.endMs > sourcePcm.length * 1000 / ANALYSIS_PCM_RATE
    || (i > 0 && run.startMs < runs[i - 1]!.startMs));
  if (!validRuns(vocalPitchContinuityRuns)) {
    // Optional stale/malformed timing must not suppress valid PCM recurrence.
    // Discard the entire optional observation set rather than invent repairs.
    vocalPitchContinuityRuns = [];
  }
  if (!validRuns(vocalActivityIntervals)) vocalActivityIntervals = [];
  const bars = Math.min(MAX_BARS, Math.floor((beats.length - 1) / 4));
  if (bars < 16) return [];
  const measurements = Array.from({ length: bars }, (_, bar) => {
    const from = Math.floor(beats[bar * 4]! * ANALYSIS_PCM_RATE / 1000);
    const to = Math.floor(beats[(bar + 1) * 4]! * ANALYSIS_PCM_RATE / 1000);
    if (from < 0 || to <= from || to > Math.min(sourcePcm.length, vocalPcm.length)) return null;
    const rms = (pcm: Float32Array) => {
      let sum = 0;
      for (let i = from; i < to; i++) sum += pcm[i]! ** 2;
      return 10 * Math.log10(Math.max(1e-12, sum / (to - from)));
    };
    return { vocal: chromaFromPcm(vocalPcm.subarray(from, to)),
      backing: chromaFromPcm(sourcePcm.subarray(from, to)),
      energyDb: rms(sourcePcm), vocalDb: rms(vocalPcm) };
  });
  if (measurements.some(m => m === null)) return [];
  const valid = measurements as NonNullable<typeof measurements[number]>[];
  const loudVoice = [...valid.map(m => m.vocalDb)].sort((a, b) => a - b)[Math.floor(bars * 0.9)]!;
  if (loudVoice < -65) return [];
  const centre = (key: "vocal" | "backing") =>
    Array.from({ length: 12 }, (_, i) => mean(valid.map(m => m[key][i]!)));
  const voiceCentre = centre("vocal");
  const centred = valid.map(m => ({ ...m,
    vocal: m.vocal.map((x, i) => x - voiceCentre[i]!),
    // Do not centre a nearly stationary backing: that amplifies tiny spectral
    // noise in one-chord songs into a spurious harmonic disagreement.
    backing: m.backing,
    active: m.vocalDb >= Math.max(-65, loudVoice - 20),
  }));
  const beatCount = bars * 4;
  const binsPerBeat = 2;
  const binsPerWindow = WINDOW_BARS * 4 * binsPerBeat;
  const phraseActivityBins = new Float64Array(beatCount * binsPerBeat);
  const phraseOnsetBins = new Float64Array(beatCount * binsPerBeat);
  // Energy-qualified vocal activity retains unpitched syllables. Pitch runs
  // independently describe tonal articulation; neither is a lyric transcript.
  const coverageRuns = vocalActivityIntervals.length ? vocalActivityIntervals : vocalPitchContinuityRuns;
  const onsetRuns = vocalPitchContinuityRuns.length ? vocalPitchContinuityRuns : vocalActivityIntervals;
  for (const [kind, runs] of [["coverage", coverageRuns], ["onset", onsetRuns]] as const) {
    for (const run of runs) {
      if (run.confidence < PHRASE_RUN_CONFIDENCE || run.startMs >= beats[beatCount]!) continue;
      let low = 0, high = beatCount;
      while (low < high) {
        const middle = (low + high) >>> 1;
        if (beats[middle]! <= run.startMs) low = middle + 1;
        else high = middle;
      }
      for (let beat = Math.max(0, low - 1); beat < beatCount && beats[beat]! < run.endMs; beat += 1) {
        const beatStartMs = beats[beat]!;
        const beatEndMs = beats[beat + 1]!;
        for (let half = 0; half < binsPerBeat; half += 1) {
          const bin = beat * binsPerBeat + half;
          const startMs = beatStartMs + (beatEndMs - beatStartMs) * half / binsPerBeat;
          const endMs = beatStartMs + (beatEndMs - beatStartMs) * (half + 1) / binsPerBeat;
          const overlap = Math.max(0, Math.min(endMs, run.endMs) - Math.max(startMs, run.startMs));
          if (kind === "coverage") phraseActivityBins[bin] = Math.max(phraseActivityBins[bin]!, overlap / (endMs - startMs) * run.confidence);
          if (kind === "onset" && run.startMs >= startMs && run.startMs < endMs) {
            phraseOnsetBins[bin] = Math.max(phraseOnsetBins[bin]!, run.confidence);
          }
        }
      }
    }
  }
  return Array.from({ length: bars - WINDOW_BARS + 1 }, (_, startBar) => {
    const window = centred.slice(startBar, startBar + WINDOW_BARS);
    const firstBin = startBar * 4 * binsPerBeat;
    return { startBar, vocal: window.flatMap(m => m.active ? m.vocal : m.vocal.map(() => 0)),
      backing: window.flatMap(m => m.backing),
      ...(coverageRuns.length || onsetRuns.length ? { vocalPhraseTiming: [
        ...phraseActivityBins.slice(firstBin, firstBin + binsPerWindow),
        ...phraseOnsetBins.slice(firstBin, firstBin + binsPerWindow),
      ] } : {}),
      vocalCoverage: window.filter(m => m.active).length / WINDOW_BARS,
      energyDb: mean(window.map(m => m.energyDb)) };
  });
}

/** Keep source section coordinates/IDs stable for saved arrangements. */
export function applyFormPredictions(
  candidates: readonly SourceSectionCandidate[],
  predictions: readonly FormPrediction[],
): SourceSectionCandidate[] {
  return candidates.map(candidate => {
    const firstBar = candidate.startBeatIndex / 4, lastBar = candidate.endBeatIndex / 4;
    const covered = (label: "verse" | "chorus") => {
      const spans = predictions.filter(p => p.label === label)
        .map(p => [Math.max(firstBar, p.startBar), Math.min(lastBar, p.endBar)] as const)
        .filter(([a, b]) => b > a).sort((a, b) => a[0] - b[0]);
      let total = 0, end = firstBar;
      for (const [a, b] of spans) { total += Math.max(0, b - Math.max(a, end)); end = Math.max(end, b); }
      return total / (lastBar - firstBar);
    };
    const verse = covered("verse"), chorus = covered("chorus");
    if (Math.max(verse, chorus) < 0.65 || Math.min(verse, chorus) > 0.2) return { ...candidate };
    const label = verse > chorus ? "verse" : "chorus";
    return { ...candidate, label,
      labelConfidence: Math.min(...predictions.filter(p => p.label === label).map(p => p.strength)) };
  });
}
