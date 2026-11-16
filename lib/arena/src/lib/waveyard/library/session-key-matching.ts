import { CAMELOT_CELLS, camelotCodeForKey, camelotCompatibleCodes } from "./camelot-wheel";
import { CANONICAL_PITCH_CLASSES, normaliseMusicalKey, semitoneShift, type MusicalKey } from "../types/musical-key";

export type SessionKeyMode = "camelot" | "match" | "preserve" | "off";

/** A saved correction belongs to a specific session entry and source track. */
export interface SessionKeyShiftState {
  trackId: string;
  semitones: number;
}

export type SessionKeyShifts = Record<string, SessionKeyShiftState>;

export function normalizeSessionKeyMode(value: unknown): SessionKeyMode {
  return value === "camelot" || value === "match" || value === "preserve" || value === "off"
    ? value
    : "off";
}

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

/** Correction before the receiving deck's own pitch processor. */
export function resolveLiveStemKeyCorrection(
  mode: SessionKeyMode,
  leadKey: unknown,
  donorKey: unknown,
  deckSemitones: number,
  stemType: string,
): number | null {
  if (!Number.isInteger(deckSemitones) || Math.abs(deckSemitones) > 11) return null;
  const match = stemType === "drums"
    ? { semitones: 0 }
    : resolveSessionKeyMatch(mode, shiftMusicalKey(leadKey, deckSemitones), donorKey);
  // If analysis is missing, the donor cannot be harmonically matched. Cancel
  // the receiving deck's shift instead of silently transposing the donor.
  const relative = (match.semitones ?? 0) - deckSemitones;
  // Equivalent pitch-class correction within the real-time processor's range.
  return relative > 11 ? relative - 12 : relative < -11 ? relative + 12 : relative;
}

export interface InstrumentalBedVocalCorrection {
  semitones: number;
  sourceKey: MusicalKey | null;
  bedKey: MusicalKey | null;
  applied: boolean;
  reason: string;
}

/**
 * A complete donor instrumental bed may become the vocal's key reference, but
 * only measured keys with adequate confidence can authorize an automatic shift.
 * Weak or missing evidence keeps the vocal at its source pitch.
 */
export function resolveInstrumentalBedVocalCorrection(
  mode: SessionKeyMode,
  bedKeyValue: unknown,
  bedKeyConfidence: number | null,
  vocalKeyValue: unknown,
  vocalKeyConfidence: number | null,
): InstrumentalBedVocalCorrection {
  const bedKey = normaliseMusicalKey(bedKeyValue);
  const sourceKey = normaliseMusicalKey(vocalKeyValue);
  if (mode === "off" || mode === "preserve") {
    return {
      semitones: 0,
      sourceKey,
      bedKey,
      applied: false,
      reason: mode === "off"
        ? "The donor instrumental bed is the key reference, but key correction is off."
        : "The donor instrumental bed is the key reference, but preserve mode keeps the vocal in its original key.",
    };
  }
  const confident = (value: number | null) => value !== null && Number.isFinite(value) && value >= 0.5;
  if (!bedKey || !sourceKey || !confident(bedKeyConfidence) || !confident(vocalKeyConfidence)) {
    return {
      semitones: 0,
      sourceKey,
      bedKey,
      applied: false,
      reason: "Bed or vocal key evidence is missing or below 0.50 confidence; the vocal stays at its source pitch.",
    };
  }
  const match = resolveSessionKeyMatch(mode, bedKey, sourceKey);
  if (match.semitones === null) {
    return {
      semitones: 0,
      sourceKey,
      bedKey,
      applied: false,
      reason: "A compatible bed/vocal key shift could not be calculated; the vocal stays at its source pitch.",
    };
  }
  return {
    semitones: match.semitones,
    sourceKey,
    bedKey,
    applied: match.semitones !== 0,
    reason: match.semitones === 0
      ? `The vocal is already in the donor bed's ${bedKey} key.`
      : `${match.reason} Shift the vocal ${match.semitones > 0 ? "+" : ""}${match.semitones} semitones.`,
  };
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
