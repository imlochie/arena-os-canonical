import { normaliseMusicalKey } from "./musical-key";

export const HARMONY_ANALYSIS_ENGINE = "waveyard-numpy-chroma-chords";
export const HARMONY_ANALYSIS_ENGINE_VERSION = "1.0.0";
export const CHORD_QUALITIES = ["major", "minor", "dominant7", "minor7", "major7", "diminished", "augmented", "unknown"] as const;
export type ChordQuality = (typeof CHORD_QUALITIES)[number];

export type HarmonyEvent = {
  startMs: number;
  endMs: number;
  root: string | null;
  quality: ChordQuality;
  confidence: number;
};

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
}) {
  if (input.sourceAssetId !== input.expectedSourceAssetId) return "source_identity_mismatch" as const;
  if (input.sourceChecksumSha256 !== input.expectedSourceChecksumSha256) return "analysis_stale" as const;
  if (input.analysisEngine !== HARMONY_ANALYSIS_ENGINE || input.analysisEngineVersion !== HARMONY_ANALYSIS_ENGINE_VERSION) return "analysis_version_mismatch" as const;
  return null;
}
