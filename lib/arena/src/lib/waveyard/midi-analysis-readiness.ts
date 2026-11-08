export type MidiAnalysisKind = "vocal" | "drums" | "harmony";

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
