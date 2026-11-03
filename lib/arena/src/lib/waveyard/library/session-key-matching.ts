import { CAMELOT_CELLS, camelotCodeForKey, camelotCompatibleCodes } from "./camelot-wheel";
import { CANONICAL_PITCH_CLASSES, normaliseMusicalKey, semitoneShift, type MusicalKey } from "../types/musical-key";

export type SessionKeyMode = "camelot" | "match" | "preserve" | "off";

export type SessionKeyMatch = {
  semitones: number | null;
  sourceKey: MusicalKey | null;
  targetKey: MusicalKey | null;
  reason: string;
};

export function shiftMusicalKey(value: unknown, semitones: number): MusicalKey | null {
  const key = normaliseMusicalKey(value);
  if (key === null || !Number.isInteger(semitones)) return null;
  const [tonic, mode] = key.split(" ") as [string, "major" | "minor"];
  const sourceIndex = CANONICAL_PITCH_CLASSES.indexOf(tonic as (typeof CANONICAL_PITCH_CLASSES)[number]);
  const targetIndex = ((sourceIndex + semitones) % 12 + 12) % 12;
  return `${CANONICAL_PITCH_CLASSES[targetIndex]} ${mode}` as MusicalKey;
}

export function resolveSessionKeyMatch(
  mode: SessionKeyMode,
  leadValue: unknown,
  complementValue: unknown,
): SessionKeyMatch {
  const leadKey = normaliseMusicalKey(leadValue);
  const sourceKey = normaliseMusicalKey(complementValue);
  if (mode === "preserve") {
    return { semitones: 0, sourceKey, targetKey: sourceKey, reason: "Keep the incoming track in its original key." };
  }
  if (mode === "off") {
    return { semitones: 0, sourceKey, targetKey: sourceKey, reason: "No harmonic pitch correction is applied." };
  }
  if (!leadKey || !sourceKey) {
    return {
      semitones: null,
      sourceKey,
      targetKey: null,
      reason: "Analyze both tracks before live key matching can be applied.",
    };
  }
  if (mode === "match") {
    const semitones = semitoneShift(sourceKey, leadKey);
    const targetKey = semitones === null ? null : shiftMusicalKey(sourceKey, semitones);
    const modeMatches = sourceKey.endsWith(leadKey.split(" ")[1]);
    return {
      semitones,
      sourceKey,
      targetKey,
      reason: modeMatches
        ? `Match the lead tonic (${leadKey}).`
        : `Match the lead tonic; the incoming track stays ${sourceKey.split(" ")[1]}.`,
    };
  }

  const leadCode = camelotCodeForKey(leadKey);
  const compatible = new Set(camelotCompatibleCodes(leadCode));
  const sourceMode = sourceKey.endsWith("major") ? "B" : "A";
  const choices: Array<{ targetKey: MusicalKey; semitones: number; code: string }> = [];
  for (const cell of CAMELOT_CELLS) {
    if (!compatible.has(cell.code) || cell.mode !== sourceMode) continue;
    const semitones = semitoneShift(sourceKey, cell.key);
    if (semitones !== null) choices.push({ targetKey: cell.key, semitones, code: cell.code });
  }
  choices.sort((left, right) =>
      Math.abs(left.semitones) - Math.abs(right.semitones)
      || left.code.localeCompare(right.code),
  );
  const closest = choices[0];
  return closest
    ? {
        semitones: closest.semitones,
        sourceKey,
        targetKey: closest.targetKey,
        reason: `Shift to the nearest compatible Camelot key (${closest.code}).`,
      }
    : {
        semitones: null,
        sourceKey,
        targetKey: null,
        reason: "No compatible Camelot key can be calculated from these analyses.",
      };
}
