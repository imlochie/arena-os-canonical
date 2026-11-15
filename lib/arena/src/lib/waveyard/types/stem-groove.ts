/**
 * Request-local rhythmic evidence from EXISTING isolated-stem onset detectors.
 * No kick/snare labels, semantic form, or listening-quality inference.
 */
import type { MusicalEvidenceProvenance } from "../studio/musical-evidence";

export type GrooveOnset = { timestampMs: number; strength: number; confidence: number };
export type StemGroove = {
  role: string;
  status: "measured";
  confidence: number;
  beatPeriodMs: number;
  observedBeats: number;
  onsetsPerBeat: number;
  offbeatFraction: number;
  accentBySixteenth: number[];
  swing: { offbeatPhase: number; ratio: number; confidence: number; observations: number } | null;
  subdivision: "eighth-evidence" | "sixteenth-evidence" | "undetermined";
  onsets: GrooveOnset[];
};
export type StemGrooveEvidence = (StemGroove | { role: string; status: "unavailable"; reason: string })
  & { provenance?: MusicalEvidenceProvenance | null };

const median = (values: number[]) => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted.length ? sorted[Math.floor(sorted.length / 2)]! : 0;
};

export function measureStemGroove(
  role: string,
  events: readonly GrooveOnset[],
  beatGridMs: readonly number[] | null | undefined,
  beatConfidence: number | null | undefined,
): StemGrooveEvidence {
  const missing = (reason: string): StemGrooveEvidence => ({ role, status: "unavailable", reason });
  if (!beatGridMs || beatGridMs.length < 9 || !Number.isFinite(beatConfidence) || (beatConfidence ?? 0) < 0.7)
    return missing("At least eight measured beats and a confident source grid are required.");
  const grid = beatGridMs;
  if (grid.some((time, index) => !Number.isFinite(time) || time < 0 || index > 0 && time <= grid[index - 1]!))
    return missing("Source beat grid is not finite and strictly increasing.");
  const onsets = events.filter((event) =>
    Number.isFinite(event.timestampMs) && event.timestampMs >= grid[0]! && event.timestampMs < grid.at(-1)!
    && Number.isFinite(event.strength) && event.strength > 0
    && Number.isFinite(event.confidence) && event.confidence >= 0.5 && event.confidence <= 1)
    .sort((a, b) => a.timestampMs - b.timestampMs);
  // Do not silently sample an unbounded event set into a confident profile.
  if (onsets.length < 8 || onsets.length > 16_384) return missing("Insufficient or excessive onset evidence.");
  const occupied = new Set<number>();
  const phases: number[] = [];
  const accents = [0, 0, 0, 0];
  const onbeat = new Map<number, number>();
  const offbeats: Array<{ beat: number; phase: number }> = [];
  for (const event of onsets) {
    let low = 0, high = grid.length - 1;
    while (low + 1 < high) {
      const mid = (low + high) >>> 1;
      if (grid[mid]! <= event.timestampMs) low = mid; else high = mid;
    }
    const phase = (event.timestampMs - grid[low]!) / (grid[low + 1]! - grid[low]!);
    occupied.add(low);
    phases.push(phase);
    accents[Math.round(phase * 4) % 4]! += event.strength;
    if (phase < 0.10 && !onbeat.has(low)) onbeat.set(low, phase);
    if (phase >= 0.4 && phase <= 0.78) offbeats.push({ beat: low, phase });
  }
  if (occupied.size < 8) return missing("Onsets do not cover eight distinct measured beats.");
  const confidence = Math.min(beatConfidence!, onsets.reduce((sum, event) => sum + event.confidence, 0) / onsets.length);
  const quarterCoverage = phases.filter((phase) => phase >= 0.19 && phase <= 0.31).length / phases.length;
  const paired = offbeats.filter((event) => onbeat.has(event.beat)).map((event) =>
    event.phase - onbeat.get(event.beat)!);
  const center = median(paired);
  const stable = paired.filter((phase) => Math.abs(phase - center) <= 0.035);
  // A .75 sixteenth is NOT proof of 3:1 eighth-note swing.
  const swing = paired.length >= 8 && stable.length / paired.length >= 0.8 && quarterCoverage < 0.15
    ? { offbeatPhase: center, ratio: center / (1 - center), confidence: confidence * stable.length / paired.length, observations: paired.length }
    : null;
  const totalAccent = accents.reduce((a, b) => a + b, 0);
  return {
    role, status: "measured", confidence,
    beatPeriodMs: median(grid.slice(1).map((time, index) => time - grid[index]!)),
    observedBeats: grid.length - 1,
    onsetsPerBeat: onsets.length / (grid.length - 1),
    offbeatFraction: phases.filter((phase) => phase > 0.10 && phase < 0.90).length / phases.length,
    accentBySixteenth: accents.map((value) => value / totalAccent),
    swing, subdivision: quarterCoverage >= 0.15 ? "sixteenth-evidence" : swing ? "eighth-evidence" : "undetermined",
    onsets,
  };
}

export function compareStemGrooves(anchor: StemGrooveEvidence, donor: StemGrooveEvidence) {
  if (anchor.status !== "measured" || donor.status !== "measured")
    return { relationship: "unavailable" as const, swingPhaseDifference: null, detail: "Missing independent stem rhythm evidence." };
  if (!anchor.swing || !donor.swing || Math.min(anchor.swing.confidence, donor.swing.confidence) < 0.8)
    return { relationship: "context" as const, swingPhaseDifference: null, detail: "Onsets are measured, but eighth-note feel is not established on both stems." };
  const difference = Math.abs(anchor.swing.offbeatPhase - donor.swing.offbeatPhase);
  return {
    relationship: difference <= 0.04 ? "similar-feel" as const : "rhythmic-contrast" as const,
    swingPhaseDifference: difference,
    detail: difference <= 0.04
      ? "Stable eighth-note onset phases are similar; this is not a quality judgment."
      : "Different eighth-note timing is measured. Contrast may be intentional; no swing conversion is authorized.",
  };
}

/** A common translation, NOT per-onset quantisation or swing conversion. */
export function proposeGrooveEntryShift(
  anchor: StemGrooveEvidence,
  donor: StemGrooveEvidence,
  timing: { bedRatio: number; donorRatio: number; sourceOffsetMs: number; entryMs: number; endMs: number },
) {
  const none = (reason: string) => ({ shiftMs: 0, comparedOnsets: 0, beforeErrorMs: null as number | null, afterErrorMs: null as number | null, reason });
  if (anchor.status !== "measured" || donor.status !== "measured"
    || Math.min(anchor.confidence, donor.confidence) < 0.8) return none("Independent stem timing confidence is insufficient.");
  if (compareStemGrooves(anchor, donor).relationship === "rhythmic-contrast") return none("Preserve measured rhythmic contrast.");
  const { bedRatio, donorRatio, sourceOffsetMs, entryMs, endMs } = timing;
  if (![bedRatio, donorRatio, endMs].every((n) => Number.isFinite(n) && n > 0)
    || !Number.isFinite(sourceOffsetMs) || sourceOffsetMs < 0 || !Number.isFinite(entryMs) || entryMs < 0)
    return none("Invalid composition timeline.");
  if (Math.abs(anchor.beatPeriodMs * bedRatio / (donor.beatPeriodMs * donorRatio) - 1) > 0.02)
    return none("The transformed source pulses do not agree.");
  const anchors = anchor.onsets.map((event) => event.timestampMs * bedRatio);
  const errors: number[] = [];
  const beats = new Set<number>();
  let eligibleOnsets = 0;
  for (const event of donor.onsets) {
    const at = entryMs + (event.timestampMs - sourceOffsetMs) * donorRatio;
    if (event.timestampMs < sourceOffsetMs || at >= endMs) continue;
    eligibleOnsets++;
    let low = 0, high = anchors.length;
    while (low < high) {
      const mid = (low + high) >>> 1;
      if (anchors[mid]! < at) low = mid + 1; else high = mid;
    }
    const distances = [anchors[low], anchors[low - 1]].filter((time): time is number => time !== undefined).map((time) => time - at);
    const nearest = distances.sort((a, b) => Math.abs(a) - Math.abs(b))[0];
    // Do not drag intentional offbeats toward kicks or shift whole subdivisions.
    if (nearest === undefined || Math.abs(nearest) > 35) continue;
    errors.push(nearest);
    beats.add(Math.floor(at / (anchor.beatPeriodMs * bedRatio)));
  }
  if (errors.length < 8 || beats.size < 8 || errors.length / eligibleOnsets < 0.8)
    return none("Too few independent beats or too little attack coverage support a small correction.");
  const shiftMs = Math.round(median(errors));
  const before = errors.reduce((sum, error) => sum + Math.abs(error), 0) / errors.length;
  const after = errors.reduce((sum, error) => sum + Math.abs(error - shiftMs), 0) / errors.length;
  if (Math.abs(shiftMs) < 8 || Math.abs(shiftMs) > 35 || after > 8 || before - after < 8
    || errors.filter((error) => Math.abs(error - shiftMs) <= 8).length / errors.length < 0.9)
    return none("No stable, minimal phase correction is justified.");
  return { shiftMs, comparedOnsets: errors.length, beforeErrorMs: before, afterErrorMs: after,
    reason: "Consistent measured attacks support one small common donor-group translation; no internal phrasing is warped." };
}

export type PerformancePhaseAssessment = {
  status: "measured" | "unavailable";
  comparedStarts: number;
  sourceOffbeatFraction: number | null;
  beforeErrorMs: number | null;
  afterErrorMs: number | null;
  preserveEntry: boolean;
  detail: string;
};

/**
 * Compare an entire performance's measured activity starts to its OWN beat
 * phases. The target is not the nearest beat: a source offbeat stays offbeat.
 * Activity starts are coarse observations, not words/syllables/note labels.
 */
export function assessPerformancePhase(
  intervals: readonly { startMs: number; endMs: number; confidence: number }[],
  sourceGrid: readonly number[] | null | undefined,
  targetGrid: readonly number[] | null | undefined,
  timing: { sourceFromMs: number; sourceToMs: number; entryMs: number; stretchRatio: number; proposedShiftMs: number },
): PerformancePhaseAssessment {
  const missing = (detail: string): PerformancePhaseAssessment => ({
    status: "unavailable", comparedStarts: 0, sourceOffbeatFraction: null,
    beforeErrorMs: null, afterErrorMs: null, preserveEntry: false, detail,
  });
  const validGrid = (grid: readonly number[] | null | undefined): grid is readonly number[] =>
    Boolean(grid && grid.length >= 9 && grid.every((time, index) =>
      Number.isFinite(time) && time >= 0 && (index === 0 || time > grid[index - 1]!)));
  if (!validGrid(sourceGrid) || !validGrid(targetGrid)) return missing("No trusted source/target grids for performance-phase comparison.");
  if (![timing.sourceFromMs, timing.sourceToMs, timing.entryMs, timing.stretchRatio, timing.proposedShiftMs].every(Number.isFinite)
    || timing.sourceFromMs < 0 || timing.sourceToMs <= timing.sourceFromMs || timing.stretchRatio <= 0)
    return missing("Invalid performance timeline.");
  const phaseAt = (at: number, grid: readonly number[]) => {
    if (at < grid[0]! || at >= grid.at(-1)!) return null;
    let low = 0, high = grid.length - 1;
    while (low + 1 < high) {
      const mid = (low + high) >>> 1;
      if (grid[mid]! <= at) low = mid; else high = mid;
    }
    const period = grid[low + 1]! - grid[low]!;
    return { phase: (at - grid[low]!) / period, period, beatIndex: low };
  };
  const observations: Array<{ before: number; after: number; offbeat: boolean; period: number }> = [];
  const beats = new Set<number>();
  for (const interval of intervals) {
    if (!Number.isFinite(interval.startMs) || !Number.isFinite(interval.endMs)
      || interval.endMs <= interval.startMs || interval.startMs < timing.sourceFromMs || interval.startMs >= timing.sourceToMs
      || !Number.isFinite(interval.confidence) || interval.confidence < 0.8 || interval.confidence > 1) continue;
    const source = phaseAt(interval.startMs, sourceGrid);
    const at = timing.entryMs + (interval.startMs - timing.sourceFromMs) * timing.stretchRatio;
    const before = phaseAt(at, targetGrid);
    const after = phaseAt(at + timing.proposedShiftMs, targetGrid);
    if (!source || !before || !after) continue;
    const distance = (phase: number) => {
      const delta = Math.abs(source.phase - phase);
      return Math.min(delta, 1 - delta);
    };
    observations.push({ before: distance(before.phase) * before.period, after: distance(after.phase) * after.period,
      offbeat: Math.min(source.phase, 1 - source.phase) >= 0.15, period: before.period });
    beats.add(source.beatIndex);
  }
  if (observations.length < 3 || beats.size < 3) return missing("Fewer than three independent, confidence-qualified activity starts.");
  const beforeErrorMs = observations.reduce((sum, point) => sum + point.before, 0) / observations.length;
  const afterErrorMs = observations.reduce((sum, point) => sum + point.after, 0) / observations.length;
  // Coarse activity timing cannot justify sub-frame performance corrections.
  const tolerance = Math.max(25, median(observations.map((point) => point.period)) * 0.05);
  const preserveEntry = afterErrorMs - beforeErrorMs > tolerance;
  return {
    status: "measured", comparedStarts: observations.length,
    sourceOffbeatFraction: observations.filter((point) => point.offbeat).length / observations.length,
    beforeErrorMs, afterErrorMs, preserveEntry,
    detail: preserveEntry
      ? "The proposed group translation worsens the performance's own measured beat phases. Preserve its current entry; do not quantise expressive starts."
      : "The group translation does not measurably worsen source-relative activity phases. This is not lyric timing or a quality judgment.",
  };
}
