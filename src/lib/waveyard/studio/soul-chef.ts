/**
 * The soul chef — early-Kanye sequencing brain for chop patterns (vision:
 * "the samples are automatically chopped and screwed and sequenced").
 *
 * sequenceChopPattern turns a project's scanned chops + its REAL analysis
 * (tempo, key) into a deterministic, explained pattern: grid-locked to the
 * beat, pitched into the song's key (chipmunk up / screwed down), with the
 * classic motifs (straight hits, end-of-bar stutters, call-and-response).
 *
 * cleanupPattern is the polite counterpart: after the user resequences the
 * chef's decisions (their right — "if my work is better to my ears we keep
 * that"), it QUANTIFIES what drifted and offers a tidy-up. It returns a
 * suggestion + a plain-language change list; applying it is always the
 * user's click, and undo covers it.
 */

import {
  MIDI_HIGH,
  MIDI_LOW,
  VELOCITY_MAX,
  VELOCITY_MIN,
  normalizeOverlaps,
  quantizeNotes,
  snapMs,
  type PianoNote,
} from "./piano-roll";
import { chopNoteId } from "./vocal-chops";
import { normaliseMusicalKey } from "../types/musical-key";

export const SOUL_CHEF_ENGINE = "waveyard-soul-chef-v1";

const MAJOR_SCALE = [0, 2, 4, 5, 7, 9, 11];
const MINOR_SCALE = [0, 2, 3, 5, 7, 8, 10];

/** Pitch classes in a canonical key ("C major" → {0,2,4,5,7,9,11}). */
export function keyPitchClasses(key: string | null): Set<number> | null {
  const normalised = normaliseMusicalKey(key);
  if (normalised === null) return null;
  const [tonic, mode] = normalised.split(" ");
  const PITCHES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];
  const tonicPc = PITCHES.indexOf(tonic);
  if (tonicPc < 0) return null;
  const scale = mode === "minor" ? MINOR_SCALE : MAJOR_SCALE;
  return new Set(scale.map((degree) => (degree + tonicPc) % 12));
}

/** Nearest in-scale midi note (null key → unchanged). */
export function snapMidiToKey(midi: number, key: string | null): number {
  const pcs = keyPitchClasses(key);
  if (pcs === null) return Math.round(midi);
  let best = Math.round(midi);
  let bestDistance = Number.POSITIVE_INFINITY;
  for (let candidate = MIDI_LOW; candidate <= MIDI_HIGH; candidate += 1) {
    if (!pcs.has(candidate % 12)) continue;
    const distance = Math.abs(candidate - midi);
    if (distance < bestDistance) {
      bestDistance = distance;
      best = candidate;
    }
  }
  return best;
}

/** Deterministic PRNG (mulberry32) — the chef's choices are reproducible
 *  from the seed, so "regenerate" is a deliberate new roll, not noise. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export type SoulChefStyle = "chipmunk" | "screwed" | "chopped";

export type SoulChefChop = { id: string; rootMidi: number };

export type SoulChefContext = {
  bpm: number;
  musicalKey: string | null;
};

/**
 * Sequence a chop pattern: bars of grid-locked hits from the project's
 * chops, in-key, in the requested style. Returns notes with chop-stamped
 * ids (ready for the chop renderer) + a per-bar rationale log.
 */
export function sequenceChopPattern(
  chops: readonly SoulChefChop[],
  context: SoulChefContext,
  options: { bars?: number; style?: SoulChefStyle; seed?: number } = {},
): { notes: PianoNote[]; rationale: string[] } {
  if (chops.length === 0 || context.bpm <= 0) return { notes: [], rationale: ["no chops or no tempo — nothing to sequence"] };
  const bars = Math.max(1, Math.min(16, options.bars ?? 4));
  const style = options.style ?? "chopped";
  const random = mulberry32(options.seed ?? 1);

  const beatMs = 60_000 / context.bpm;
  const barMs = beatMs * 4;
  const eighth = beatMs / 2;
  const sixteenth = beatMs / 4;
  const key = context.musicalKey;

  const notes: PianoNote[] = [];
  const rationale: string[] = [];
  let serial = 0;

  const pitchFor = (chop: SoulChefChop): number => {
    const inKey = snapMidiToKey(chop.rootMidi, key);
    const offset = style === "chipmunk" ? 12 : style === "screwed" ? -12 : 0;
    return Math.max(MIDI_LOW, Math.min(MIDI_HIGH, inKey + offset));
  };

  for (let bar = 0; bar < bars; bar += 1) {
    const barStart = bar * barMs;
    const chop = chops[Math.floor(random() * chops.length)];
    const midi = pitchFor(chop);
    const motifRoll = random();
    let motif: string;

    const push = (startMs: number, durationMs: number, velocity: number) => {
      serial += 1;
      notes.push({
        id: chopNoteId(chop.id, `b${bar}n${serial}`),
        startMs: Math.round(startMs),
        durationMs: Math.max(10, Math.round(durationMs)),
        midi,
        velocity: Math.max(VELOCITY_MIN, Math.min(VELOCITY_MAX, Math.round(velocity))),
      });
    };

    if (style === "screwed") {
      // Screwed: sparse, long, half-speed — the chopped-and-screwed crawl.
      motif = "screwed crawl";
      for (let beat = 0; beat < 4; beat += 2) {
        push(barStart + beat * beatMs, beatMs * 1.8, 70 + Math.floor(random() * 20));
      }
    } else if (motifRoll < 0.34) {
      // Straight hits on the beats.
      motif = "straight hits";
      for (let beat = 0; beat < 4; beat += 1) {
        push(barStart + beat * beatMs, eighth, beat === 0 ? 112 : 78 + Math.floor(random() * 18));
      }
    } else if (motifRoll < 0.67) {
      // End-of-bar stutter — the classic "ch-ch-chop".
      motif = "stutter ending";
      for (let beat = 0; beat < 3; beat += 1) {
        push(barStart + beat * beatMs, eighth, beat === 0 ? 110 : 82);
      }
      const stutterStart = barStart + 3 * beatMs;
      for (let hit = 0; hit < 3; hit += 1) {
        push(stutterStart + hit * sixteenth, sixteenth * 0.9, 96 - hit * 8);
      }
    } else {
      // Call and response: a long call, two short answers.
      motif = "call and response";
      push(barStart, beatMs * 1.5, 104);
      push(barStart + beatMs * 2, eighth, 86);
      push(barStart + beatMs * 3, eighth, 92);
    }
    rationale.push(`bar ${bar + 1}: ${motif} on ${chop.rootMidi >= 0 ? `chop rooted ${(midi + (style === "chipmunk" ? -12 : style === "screwed" ? 12 : 0))}` : "chop"}${key !== null ? `, in ${key}` : ""}`);
  }

  return { notes, rationale };
}

// ---------------------------------------------------------------------------
// Cleanup assistant — quantify drift, offer a tidy-up (never force it)
// ---------------------------------------------------------------------------

export type CleanupResult = {
  notes: PianoNote[];
  /** Plain-language list of every change the cleanup would make. */
  changes: string[];
};

/**
 * The consistency pass for hand edits: quantize to the grid, snap pitches
 * into the song's key, merge same-pitch overlaps, pull velocity outliers
 * toward the pattern's own median. Every change is counted and reported —
 * the user applies or ignores. Their version is never silently replaced.
 */
export function cleanupPattern(
  notes: readonly PianoNote[],
  context: SoulChefContext,
  stepMs: number,
): CleanupResult {
  if (notes.length === 0) return { notes: [], changes: [] };
  const changes: string[] = [];
  const grid = stepMs > 0 ? stepMs : 60_000 / context.bpm / 2;

  // 1. Quantize to the grid.
  let quantized = 0;
  const allIds = new Set(notes.map((note) => note.id));
  const quantizedNotes = quantizeNotes(notes, allIds, grid).map((note, index) => {
    if (note.startMs !== notes[index].startMs) quantized += 1;
    return note;
  });
  if (quantized > 0) changes.push(`snapped ${quantized} note${quantized === 1 ? "" : "s"} back to the ${Math.round(grid)}ms grid`);

  // 2. Snap pitches into the key.
  const pcs = keyPitchClasses(context.musicalKey);
  let snapped = 0;
  const inKeyNotes = pcs === null
    ? quantizedNotes
    : quantizedNotes.map((note) => {
        if (pcs.has(note.midi % 12)) return note;
        snapped += 1;
        return { ...note, midi: snapMidiToKey(note.midi, context.musicalKey) };
      });
  if (snapped > 0) changes.push(`moved ${snapped} note${snapped === 1 ? "" : "s"} into ${context.musicalKey}`);

  // 3. Merge same-pitch overlaps.
  const afterOverlap = normalizeOverlaps(inKeyNotes);
  if (afterOverlap.length < inKeyNotes.length) {
    changes.push(`merged ${inKeyNotes.length - afterOverlap.length} overlapping same-pitch note${inKeyNotes.length - afterOverlap.length === 1 ? "" : "s"}`);
  }

  // 4. Smooth velocity outliers toward the pattern's median.
  const velocities = [...afterOverlap].map((note) => note.velocity).sort((left, right) => left - right);
  const medianVelocity = velocities[velocities.length >> 1];
  let smoothed = 0;
  const finalNotes = afterOverlap.map((note) => {
    if (Math.abs(note.velocity - medianVelocity) <= 24) return note;
    smoothed += 1;
    const pulled = note.velocity > medianVelocity
      ? Math.max(medianVelocity + 24, note.velocity - 12)
      : Math.min(medianVelocity - 24, note.velocity + 12);
    return { ...note, velocity: Math.max(VELOCITY_MIN, Math.min(VELOCITY_MAX, pulled)) };
  });
  if (smoothed > 0) changes.push(`eased ${smoothed} extreme velocit${smoothed === 1 ? "y" : "ies"} toward the pattern's median (${medianVelocity})`);

  return { notes: finalNotes, changes };
}
