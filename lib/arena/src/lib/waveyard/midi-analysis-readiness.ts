export type MidiAnalysisKind = "vocal" | "drums" | "harmony";

const DEFAULT_MIDI_TEMPO_BPM = 120;

/** Prefer an explicit export tempo, then checksum-matched source analysis, then SMF's 120 BPM default. */
export function resolveMidiTempoBpm(explicitBpm: number | null, analyzedBpm: number | null): number {
  const usable = (value: number | null) =>
    value !== null && Number.isFinite(value) && value >= 20 && value <= 300;
  if (explicitBpm !== null && usable(explicitBpm)) return explicitBpm;
  if (analyzedBpm !== null && usable(analyzedBpm)) return analyzedBpm;
  return DEFAULT_MIDI_TEMPO_BPM;
}

/** Refuse to export queued/failed or stale evidence as if it were current. */
export function midiAnalysisReadinessError(
  kind: MidiAnalysisKind,
  status: string,
  provenanceReason: string | null,
): { status: 409; error: string } | null {
  const label = kind === "vocal" ? "vocal" : kind === "drums" ? "drum" : "harmony";
  if (status !== "complete") {
    return { status: 409, error: `Complete ${label} analysis is required for MIDI export.` };
  }
  if (provenanceReason !== null) {
    return { status: 409, error: `${label[0].toUpperCase()}${label.slice(1)} analysis is stale or has mismatched provenance; rerun analysis before exporting MIDI.` };
  }
  return null;
}
