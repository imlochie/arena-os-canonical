/**
 * Layer edit planning — the pure contract between the piano roll and the
 * arrangement layer it edits. Lives in a lib (not the route) so the
 * validation + re-render planning is directly unit-testable.
 */

import { toSynthEvents, validatePianoNotes, type PianoNote, type SynthNoteEvent } from "./piano-roll";

export type LayerEditPlan = {
  /** Validated, normalised piano-roll notes (the edit's new content). */
  notes: PianoNote[];
  /** Synth-domain events to persist (velocity 0–1, ms). */
  synthEvents: SynthNoteEvent[];
  /** Duration that covers the edit (never shrinks below the layer's current
   *  length — clips already placed against the layer must keep working). */
  durationSeconds: number;
};

/**
 * Plan a layer edit from untrusted input. Returns null when the notes fail
 * validation — the caller maps that to an honest 400, never a guess.
 */
export function planLayerEdit(
  layer: { durationSeconds: number },
  incoming: unknown,
): LayerEditPlan | null {
  const notes = validatePianoNotes(incoming);
  if (notes === null) return null;
  const synthEvents = toSynthEvents(notes);
  const lastEndMs = synthEvents.reduce((latest, event) => Math.max(latest, event.startMs + event.durationMs), 0);
  const durationSeconds = Math.max(layer.durationSeconds, Math.ceil(lastEndMs / 1000) + 1);
  return { notes, synthEvents, durationSeconds };
}
