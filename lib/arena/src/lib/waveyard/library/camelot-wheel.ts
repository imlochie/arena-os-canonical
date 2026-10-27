import { normaliseMusicalKey, type MusicalKey } from "../types/musical-key";

export type CamelotMode = "A" | "B";
export type CamelotCell = {
  code: `${number}${CamelotMode}`;
  number: number;
  mode: CamelotMode;
  key: MusicalKey;
};

const MAJOR_TONICS = ["B", "F#", "C#", "G#", "D#", "A#", "F", "C", "G", "D", "A", "E"] as const;
const MINOR_TONICS = ["G#", "D#", "A#", "F", "C", "G", "D", "A", "E", "B", "F#", "C#"] as const;

export const CAMELOT_CELLS: CamelotCell[] = Array.from({ length: 12 }, (_, index) => {
  const number = index + 1;
  const major = `${MAJOR_TONICS[index]} major` as MusicalKey;
  const minor = `${MINOR_TONICS[index]} minor` as MusicalKey;
  return [
    { code: `${number}A` as const, number, mode: "A" as const, key: minor },
    { code: `${number}B` as const, number, mode: "B" as const, key: major },
  ];
}).flat();

const CODE_BY_KEY = new Map(CAMELOT_CELLS.map(({ key, code }) => [key, code]));

export function camelotCodeForKey(value: unknown): CamelotCell["code"] | null {
  const key = normaliseMusicalKey(value);
  return key === null ? null : CODE_BY_KEY.get(key) ?? null;
}

/** Same Camelot slot, its two neighbors, and its relative major/minor. */
export function camelotCompatibleCodes(code: string | null): CamelotCell["code"][] {
  if (code === null || !/^(?:[1-9]|1[0-2])[AB]$/.test(code)) return [];
  const number = Number(code.slice(0, -1));
  const mode = code.slice(-1) as CamelotMode;
  const relativeMode: CamelotMode = mode === "A" ? "B" : "A";
  const previous = ((number + 10) % 12) + 1;
  const next = (number % 12) + 1;
  return [
    code as CamelotCell["code"],
    `${number}${relativeMode}` as CamelotCell["code"],
    `${previous}${mode}` as CamelotCell["code"],
    `${next}${mode}` as CamelotCell["code"],
  ];
}
