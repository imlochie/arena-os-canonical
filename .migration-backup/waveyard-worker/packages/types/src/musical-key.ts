/**
 * Canonical key representation shared by analysis, arrangement UI, and export.
 * The analysis engine emits sharp tonic names; flats and uncommon enharmonics are
 * accepted at the boundary and deterministically normalized to that vocabulary.
 */
export const CANONICAL_PITCH_CLASSES = [
  "C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B",
] as const;

const ENHARMONIC_PITCHES: Record<string, (typeof CANONICAL_PITCH_CLASSES)[number]> = {
  C: "C", "B#": "C", "C#": "C#", Db: "C#", D: "D", "D#": "D#", Eb: "D#",
  E: "E", Fb: "E", "E#": "F", F: "F", "F#": "F#", Gb: "F#", G: "G",
  "G#": "G#", Ab: "G#", A: "A", "A#": "A#", Bb: "A#", B: "B", Cb: "B",
};

export type MusicalKey = `${(typeof CANONICAL_PITCH_CLASSES)[number]} ${"major" | "minor"}`;

export function normaliseMusicalKey(value: unknown): MusicalKey | null {
  if (typeof value !== "string") return null;
  const match = /^\s*([A-G](?:#|b)?)[\s_-]+(major|minor)\s*$/i.exec(value);
  if (!match) return null;
  const pitch = ENHARMONIC_PITCHES[`${match[1][0].toUpperCase()}${match[1].slice(1)}`];
  const mode = match[2].toLowerCase();
  return pitch && (mode === "major" || mode === "minor")
    ? `${pitch} ${mode}` as MusicalKey
    : null;
}

/** The target tonic relative to source, in the deterministic range -5 through +6. */
export function semitoneShift(sourceKey: unknown, targetKey: unknown): number | null {
  const source = normaliseMusicalKey(sourceKey);
  const target = normaliseMusicalKey(targetKey);
  if (!source || !target) return null;
  const sourcePitch = source.split(" ")[0];
  const targetPitch = target.split(" ")[0];
  let shift = CANONICAL_PITCH_CLASSES.indexOf(targetPitch as (typeof CANONICAL_PITCH_CLASSES)[number])
    - CANONICAL_PITCH_CLASSES.indexOf(sourcePitch as (typeof CANONICAL_PITCH_CLASSES)[number]);
  if (shift > 6) shift -= 12;
  if (shift < -5) shift += 12;
  return shift;
}

export const SUPPORTED_MUSICAL_KEYS = CANONICAL_PITCH_CLASSES.flatMap((pitch) => [
  `${pitch} major` as MusicalKey,
  `${pitch} minor` as MusicalKey,
]);
