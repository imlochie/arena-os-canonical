import { CANONICAL_PITCH_CLASSES, normaliseMusicalKey } from "./musical-key";

export const HARMONY_ANALYSIS_ENGINE = "waveyard-numpy-chroma-chords";
export const HARMONY_ANALYSIS_ENGINE_VERSION = "1.0.0";
export { DESKTOP_STEM_ANALYSIS_ENGINE as LOCAL_HARMONY_ANALYSIS_ENGINE, DESKTOP_HARMONY_ANALYSIS_ENGINE_VERSION as LOCAL_HARMONY_ANALYSIS_ENGINE_VERSION } from "./analysis-provenance";
export const CHORD_QUALITIES = ["major", "minor", "dominant7", "minor7", "major7", "diminished", "augmented", "unknown"] as const;
export type ChordQuality = (typeof CHORD_QUALITIES)[number];
/** The local template matcher emits a named chord only when its top-two margin reaches this value. */
export const HARMONY_TEMPLATE_MIN_MARGIN = 0.04;

export function harmonyAnalysisIdempotencyKey(sourceAssetId: string, engine = HARMONY_ANALYSIS_ENGINE, version = HARMONY_ANALYSIS_ENGINE_VERSION) {
  return `harmony:${sourceAssetId}:${engine}:${version}`;
}

export type HarmonyEvent = {
  startMs: number;
  endMs: number;
  root: string | null;
  quality: ChordQuality;
  /** For the local matcher, this is top-two template separation, not a probability. */
  confidence: number;
};

export const HARMONY_CHORD_TEMPLATES: ReadonlyArray<{
  quality: Exclude<ChordQuality, "unknown">;
  intervals: readonly number[];
}> = [
  { quality: "major", intervals: [0, 4, 7] },
  { quality: "minor", intervals: [0, 3, 7] },
  { quality: "dominant7", intervals: [0, 4, 7, 10] },
  { quality: "minor7", intervals: [0, 3, 7, 10] },
  { quality: "major7", intervals: [0, 4, 7, 11] },
  { quality: "diminished", intervals: [0, 3, 6] },
  { quality: "augmented", intervals: [0, 4, 8] },
];

/**
 * Cosine template matching penalises expected-but-absent tones. An additive
 * pitch-class sum alone always favours a seventh-chord superset over its triad.
 * Margin remains discrimination between templates, not calibrated accuracy.
 */
export function matchHarmonyChroma(chroma: readonly number[]): {
  root: number | null; quality: ChordQuality; confidence: number;
} {
  const unknown = { root: null, quality: "unknown" as const, confidence: 0 };
  if (chroma.length !== 12 || chroma.some((value) => !Number.isFinite(value) || value < 0)
    || chroma.reduce((sum, value) => sum + value, 0) <= 1e-8) return unknown;
  const peak = Math.max(...chroma);
  const observed = chroma.map((value) => value / peak);
  const observedNorm = Math.hypot(...observed);
  let best: { root: number; quality: Exclude<ChordQuality, "unknown">; score: number } | null = null;
  let runner = 0;
  for (let root = 0; root < 12; root++) {
    for (const template of HARMONY_CHORD_TEMPLATES) {
      let dot = 0, templatePower = 0;
      for (let pitch = 0; pitch < 12; pitch++) {
        const weight = template.intervals.includes((pitch - root + 12) % 12) ? 1 : 0.08;
        dot += observed[pitch]! * weight;
        templatePower += weight * weight;
      }
      const score = dot / (observedNorm * Math.sqrt(templatePower));
      if (!best || score > best.score) {
        runner = best?.score ?? 0;
        best = { root, quality: template.quality, score };
      } else if (score > runner) runner = score;
    }
  }
  const margin = best ? Math.max(0, Math.min(1, (best.score - runner) / Math.max(best.score, 1e-9))) : 0;
  if (!best || best.score < 0.28 || margin < HARMONY_TEMPLATE_MIN_MARGIN) return { ...unknown, confidence: margin };
  return { root: best.root, quality: best.quality, confidence: margin };
}

/** Return the chord's measured pitch classes; unknown chords have no guessed notes. */
export function harmonyPitchClasses(event: Pick<HarmonyEvent, "root" | "quality">): number[] | null {
  if (!event.root || event.quality === "unknown") return null;
  const key = normaliseMusicalKey(`${event.root} major`);
  if (!key) return null;
  const root = CANONICAL_PITCH_CLASSES.indexOf(
    key.split(" ")[0] as (typeof CANONICAL_PITCH_CLASSES)[number],
  );
  const template = HARMONY_CHORD_TEMPLATES.find((candidate) => candidate.quality === event.quality);
  if (root < 0 || !template) return null;
  return template.intervals.map((interval) => (root + interval) % 12);
}

export function normaliseChordRoot(value: unknown) {
  if (typeof value !== "string") return null;
  const key = normaliseMusicalKey(`${value.trim()} major`);
  return key?.replace(" major", "") ?? null;
}

export function chordLabel(event: Pick<HarmonyEvent, "root" | "quality">) {
  if (!event.root || event.quality === "unknown") return "Unknown";
  const suffix: Record<Exclude<ChordQuality, "unknown">, string> = {
    major: "", minor: "m", dominant7: "7", minor7: "m7", major7: "maj7", diminished: "dim", augmented: "aug",
  };
  return `${event.root}${suffix[event.quality]}`;
}

/**
 * Validate against actual decoded audio first, then conservatively crop the
 * sub-second tail omitted by whole-second source metadata. Never relax the
 * persisted timeline contract or hide a larger duration discrepancy.
 */
export function normaliseHarmonyEventsWithinAudio(
  input: unknown,
  decodedDurationMs: number,
  sourceDurationMs: number,
): HarmonyEvent[] | null {
  if (!Number.isSafeInteger(sourceDurationMs) || sourceDurationMs < 0
    || decodedDurationMs - sourceDurationMs >= 1000) return null;
  const measured = normaliseHarmonyEvents(input, decodedDurationMs);
  if (measured === null) return null;
  const endMs = Math.min(decodedDurationMs, sourceDurationMs);
  return measured.filter(event => event.startMs < endMs)
    .map(event => ({ ...event, endMs: Math.min(event.endMs, endMs) }));
}

export function normaliseHarmonyEvents(input: unknown, durationMs: number): HarmonyEvent[] | null {
  if (!Array.isArray(input) || input.length > 50_000 || !Number.isSafeInteger(durationMs) || durationMs < 0) return null;
  const events: HarmonyEvent[] = [];
  for (const raw of input) {
    if (!raw || typeof raw !== "object") return null;
    const event = raw as Partial<HarmonyEvent>;
    const startMs = event.startMs; const endMs = event.endMs; const confidence = event.confidence;
    const quality = event.quality;
    if (typeof startMs !== "number" || typeof endMs !== "number" || !Number.isSafeInteger(startMs) || !Number.isSafeInteger(endMs) || startMs < 0 || endMs <= startMs || endMs > durationMs
      || typeof confidence !== "number" || !Number.isFinite(confidence) || confidence < 0 || confidence > 1
      || typeof quality !== "string" || !(CHORD_QUALITIES as readonly string[]).includes(quality)) return null;
    const root = event.root === null ? null : normaliseChordRoot(event.root);
    if ((quality === "unknown" && root !== null) || (quality !== "unknown" && root === null)) return null;
    events.push({ startMs, endMs, root, quality: quality as ChordQuality, confidence: Number(confidence.toFixed(6)) });
  }
  if (events.some((event, index) => index > 0 && event.startMs < events[index - 1].endMs)) return null;
  return events;
}

export function harmonyAnalysisProvenanceReason(input: {
  sourceAssetId: string; expectedSourceAssetId: string;
  sourceChecksumSha256: string; expectedSourceChecksumSha256: string;
  analysisEngine: string; analysisEngineVersion: string;
}, expected = { engine: HARMONY_ANALYSIS_ENGINE, version: HARMONY_ANALYSIS_ENGINE_VERSION }) {
  if (input.sourceAssetId !== input.expectedSourceAssetId) return "source_identity_mismatch" as const;
  if (input.sourceChecksumSha256 !== input.expectedSourceChecksumSha256) return "analysis_stale" as const;
  if (input.analysisEngine !== expected.engine || input.analysisEngineVersion !== expected.version) return "analysis_version_mismatch" as const;
  return null;
}
