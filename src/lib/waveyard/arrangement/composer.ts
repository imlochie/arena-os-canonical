/**
 * Arrangement composer — turns a validated ArrangementInstruction into
 * real note events using ONLY authoritative source evidence: musical key,
 * tempo, beat grid, and section analysis. Nothing is invented: if the key
 * is missing the composer says so instead of guessing; notes are diatonic
 * to the analyzed key; placement is quantized to the analyzed beat grid;
 * scoping follows the analyzed sections.
 *
 * Deterministic: same instruction + same evidence + same seed ⇒ same notes
 * (seeded xorshift RNG — no Math.random anywhere).
 */

import { z } from "zod";

import {
  CANONICAL_PITCH_CLASSES,
  normaliseMusicalKey,
} from "../types/musical-key";
import type { NoteEvent } from "../mixer/synth";

export const ARRANGEMENT_INSTRUCTION_FORMAT = "waveyard-arrangement-instruction-v1" as const;

export const MOODS = [
  "sinister", "dark", "tense", "epic", "cinematic",
  "bright", "warm", "dreamy", "melancholy", "aggressive", "minimal",
] as const;
export type Mood = (typeof MOODS)[number];

export const DENSITIES = ["sparse", "medium", "dense"] as const;
export const REGISTERS = ["low", "mid", "high"] as const;
export const INSTRUMENT_FAMILIES = ["strings", "pad", "pluck", "choir", "sub-bass"] as const;

export const ArrangementInstructionSchema = z.object({
  format: z.literal(ARRANGEMENT_INSTRUCTION_FORMAT),
  instrument: z.enum(INSTRUMENT_FAMILIES),
  mood: z.enum(MOODS),
  /** Which sections to fill: "all" or explicit section indices. */
  targetSections: z.union([z.literal("all"), z.array(z.number().int().min(0))]),
  density: z.enum(DENSITIES),
  register: z.enum(REGISTERS),
  /** 0–1 loudness scale for the generated layer. */
  level: z.number().min(0).max(1),
  /** Deterministic seed for reproducible compositions. */
  seed: z.number().int().min(0).max(2 ** 31 - 1),
});

export type ArrangementInstruction = z.infer<typeof ArrangementInstructionSchema>;

export type ComposerSection = {
  sectionIndex: number;
  startMs: number;
  endMs: number;
  startBeatIndex: number;
  endBeatIndex: number;
};

export type ComposerEvidence = {
  musicalKey: string;
  bpm: number;
  /** Sorted beat positions in ms (authoritative from analysis). */
  beatGridMs: number[];
  sections: ComposerSection[];
};

export type ComposedLayer = {
  format: "waveyard-composed-layer-v1";
  instruction: ArrangementInstruction;
  instrument: ArrangementInstruction["instrument"];
  events: NoteEvent[];
  /** Human-readable statement of exactly what was placed where and why. */
  realizationNotes: string[];
};

/** Major/natural-minor scale semitone offsets. */
const MAJOR_STEPS = [0, 2, 4, 5, 7, 9, 11];
const MINOR_STEPS = [0, 2, 3, 5, 7, 8, 10];

export function scaleForKey(musicalKey: string): number[] | null {
  const key = normaliseMusicalKey(musicalKey);
  if (key === null) return null;
  const [tonic, mode] = key.split(" ");
  const tonicIndex = CANONICAL_PITCH_CLASSES.indexOf(tonic as (typeof CANONICAL_PITCH_CLASSES)[number]);
  if (tonicIndex < 0) return null;
  const steps = mode === "major" ? MAJOR_STEPS : MINOR_STEPS;
  return steps.map((step) => (tonicIndex + step) % 12);
}

/** Mood → musical biases. All deterministic, all documented. */
type MoodBias = {
  /** Prefer the relative minor of a major key (mode-flip), or darken further. */
  darken: boolean;
  /** Chord rhythm: chords per bar. */
  chordsPerBar: Record<(typeof DENSITIES)[number], number>;
  /** Voicing spread in semitones between chord tones. */
  spread: number;
};

const MOOD_BIASES: Record<Mood, MoodBias> = {
  sinister: { darken: true, chordsPerBar: { sparse: 1, medium: 1, dense: 2 }, spread: 3 },
  dark: { darken: true, chordsPerBar: { sparse: 1, medium: 1, dense: 2 }, spread: 3 },
  tense: { darken: true, chordsPerBar: { sparse: 1, medium: 2, dense: 2 }, spread: 2 },
  epic: { darken: false, chordsPerBar: { sparse: 1, medium: 1, dense: 2 }, spread: 5 },
  cinematic: { darken: false, chordsPerBar: { sparse: 1, medium: 1, dense: 2 }, spread: 5 },
  bright: { darken: false, chordsPerBar: { sparse: 1, medium: 2, dense: 4 }, spread: 4 },
  warm: { darken: false, chordsPerBar: { sparse: 1, medium: 2, dense: 4 }, spread: 4 },
  dreamy: { darken: false, chordsPerBar: { sparse: 1, medium: 1, dense: 2 }, spread: 6 },
  melancholy: { darken: true, chordsPerBar: { sparse: 1, medium: 1, dense: 2 }, spread: 4 },
  aggressive: { darken: true, chordsPerBar: { sparse: 2, medium: 4, dense: 8 }, spread: 2 },
  minimal: { darken: false, chordsPerBar: { sparse: 1, medium: 1, dense: 1 }, spread: 3 },
};

const REGISTER_BASE_MIDI: Record<(typeof REGISTERS)[number], number> = {
  low: 36,
  mid: 55,
  high: 67,
};

/** Deterministic xorshift32. */
function makeRng(seed: number): () => number {
  let state = seed === 0 ? 1 : seed;
  return () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return (state >>> 0) / 0xffffffff;
  };
}

function beatsPerBar(bpm: number, beatGridMs: number[]): number {
  // Infer bars from the beat grid via autocorrelation of accent spacing is
  // overkill here; Waveyard's timing model is 4/4. Honest simplification,
  // documented: 4 beats per bar.
  void bpm;
  void beatGridMs;
  return 4;
}

/**
 * Compose a layer. Throws an honest error when required evidence is
 * missing — the caller surfaces it (never a silent fallback).
 */
export function composeArrangementLayer(
  instruction: ArrangementInstruction,
  evidence: ComposerEvidence,
): ComposedLayer {
  const scale = scaleForKey(evidence.musicalKey);
  if (scale === null)
    throw new Error("No musical key analysis available — cannot compose diatonic material honestly.");
  if (!Array.isArray(evidence.beatGridMs) || evidence.beatGridMs.length < 4)
    throw new Error("No beat grid analysis available — cannot quantize placement honestly.");
  if (evidence.sections.length === 0)
    throw new Error("No section analysis available — cannot scope placement honestly.");

  const key = normaliseMusicalKey(evidence.musicalKey)!;
  const mode = key.split(" ")[1];
  const bias = MOOD_BIASES[instruction.mood];
  const rng = makeRng(instruction.seed);
  const realizationNotes: string[] = [];

  let steps = scale;
  let actualMode = mode;
  if (bias.darken && mode === "major") {
    // PARALLEL minor (same tonic, minor degrees) — keeps the harmonic
    // anchor of the analyzed key while darkening the color.
    steps = scaleForKey(`${key.split(" ")[0]} minor`)!;
    actualMode = "minor";
    realizationNotes.push(
      `Mood "${instruction.mood}" darkens the analyzed ${key} to its parallel minor.`,
    );
  } else {
    realizationNotes.push(`Using the analyzed key ${key} as-is.`);
  }
  void actualMode;
  realizationNotes.push(
    `Instrument ${instruction.instrument}, register ${instruction.register} (base MIDI ${REGISTER_BASE_MIDI[instruction.register]}), density ${instruction.density}.`,
  );

  const sections = evidence.sections
    .filter((section) =>
      instruction.targetSections === "all"
        ? true
        : instruction.targetSections.includes(section.sectionIndex),
    )
    .sort((left, right) => left.startMs - right.startMs);
  if (sections.length === 0)
    throw new Error("Target sections selected, but none match the section analysis.");

  const events: NoteEvent[] = [];
  // Snap the register anchor to the key's tonic (at or above the register
  // base) so an A-minor layer in low register actually centers on A.
  const tonicClass = CANONICAL_PITCH_CLASSES.indexOf(
    key.split(" ")[0] as (typeof CANONICAL_PITCH_CLASSES)[number],
  );
  const registerBase = REGISTER_BASE_MIDI[instruction.register];
  const tonicMidi =
    registerBase + (((tonicClass - (registerBase % 12)) % 12) + 12) % 12;
  // Degree-relative semitone offsets (tonic = 0): steps[0] is the tonic
  // class, so subtract it to get the scale's internal distances.
  const degreeSemis = steps.map((cls) => (cls - steps[0] + 12) % 12);
  const beatsPerBarCount = beatsPerBar(evidence.bpm, evidence.beatGridMs);

  for (const section of sections) {
    const sectionBeats = evidence.beatGridMs
      .map((beat, index) => ({ beat, index }))
      .filter(({ index }) => index >= section.startBeatIndex && index < section.endBeatIndex);
    if (sectionBeats.length === 0) continue;

    const chordsPerBar = bias.chordsPerBar[instruction.density];
    const barCount = Math.ceil(sectionBeats.length / beatsPerBarCount);
    const chordsTotal = Math.max(1, Math.round(barCount * chordsPerBar));

    for (let chordIndex = 0; chordIndex < chordsTotal; chordIndex += 1) {
      const beatOffset = Math.floor((chordIndex / chordsPerBar) * beatsPerBarCount);
      const anchor = sectionBeats[Math.min(beatOffset, sectionBeats.length - 1)];
      const nextAnchor =
        sectionBeats[Math.min(beatOffset + Math.ceil(beatsPerBarCount / chordsPerBar), sectionBeats.length - 1)];

      // Diatonic triad: root on a scale degree (seeded choice), third and
      // fifth above within the scale.
      const degreeCount = steps.length;
      const rootDegree = Math.floor(rng() * degreeCount);
      const chordMs = Math.max(120, nextAnchor.beat - anchor.beat);
      const durationMs = Math.min(
        chordMs * (instruction.instrument === "pluck" ? 0.45 : 0.98),
        section.endMs - anchor.beat,
      );
      if (durationMs <= 0) continue;

      const velocity = 0.35 + instruction.level * 0.5 + rng() * 0.1;
      const voiceCount = instruction.instrument === "sub-bass" ? 1 : 3;
      for (let voice = 0; voice < voiceCount; voice += 1) {
        const degreeOffset = [0, 2, 4][voice]; // root, third, fifth
        const degree = rootDegree + degreeOffset;
        // Degree-relative semitones (tonic = 0) — tonicMidi already carries
        // the absolute tonic pitch, so classes must never be added again.
        const midi = tonicMidi
          + degreeSemis[degree % degreeCount]
          + 12 * Math.floor(degree / degreeCount);
        events.push({
          startMs: anchor.beat,
          durationMs,
          midi,
          velocity: Math.min(1, velocity),
        });
      }
    }
    realizationNotes.push(
      `Section ${section.sectionIndex}: ${barCount} bar${barCount === 1 ? "" : "s"}, ${chordsTotal} chord placement${chordsTotal === 1 ? "" : "s"} on the analyzed beat grid.`,
    );
  }

  return {
    format: "waveyard-composed-layer-v1",
    instruction,
    instrument: instruction.instrument,
    events,
    realizationNotes,
  };
}

/** All pitch classes actually used by the composed events (for tests/UI). */
export function usedPitchClasses(layer: ComposedLayer): number[] {
  const classes = new Set(layer.events.map((event) => ((event.midi % 12) + 12) % 12));
  return [...classes].sort((left, right) => left - right);
}

/** Validate a raw instruction (AI or UI origin) — clamp-free strictness. */
export function validateArrangementInstruction(raw: unknown): ArrangementInstruction | null {
  const parsed = ArrangementInstructionSchema.safeParse(raw);
  if (!parsed.success) return null;
  if (parsed.data.targetSections !== "all" && parsed.data.targetSections.length === 0) return null;
  return parsed.data;
}
