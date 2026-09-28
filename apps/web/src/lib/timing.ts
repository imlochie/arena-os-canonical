export const GRID_DIVISIONS = ["bar", "beat", "half-beat", "quarter-note"] as const;
export type GridDivision = (typeof GRID_DIVISIONS)[number];

export type MusicalTiming = {
  tempoBpm: number;
  timeSignatureNumerator: number;
  timeSignatureDenominator: number;
  gridDivision: GridDivision;
  snapEnabled: boolean;
};

export const DEFAULT_TIMING: MusicalTiming = {
  tempoBpm: 120,
  timeSignatureNumerator: 4,
  timeSignatureDenominator: 4,
  gridDivision: "beat",
  snapEnabled: true,
};

export function quarterNoteMs(timing: Pick<MusicalTiming, "tempoBpm">) {
  return 60_000 / timing.tempoBpm;
}

export function beatMs(timing: Pick<MusicalTiming, "tempoBpm" | "timeSignatureDenominator">) {
  return quarterNoteMs(timing) * (4 / timing.timeSignatureDenominator);
}

export function barMs(timing: Pick<MusicalTiming, "tempoBpm" | "timeSignatureNumerator" | "timeSignatureDenominator">) {
  return beatMs(timing) * timing.timeSignatureNumerator;
}

export function snapIncrementMs(timing: MusicalTiming) {
  switch (timing.gridDivision) {
    case "bar": return barMs(timing);
    case "half-beat": return beatMs(timing) / 2;
    case "quarter-note": return quarterNoteMs(timing);
    default: return beatMs(timing);
  }
}

export function snapTimelineMs(value: number, timing: MusicalTiming) {
  if (!timing.snapEnabled) return Math.max(0, Math.round(value));
  const increment = snapIncrementMs(timing);
  return Math.max(0, Math.round(Math.round(value / increment) * increment));
}

export function musicalPosition(milliseconds: number, timing: MusicalTiming) {
  const safe = Math.max(0, milliseconds);
  const barLength = barMs(timing);
  const beatLength = beatMs(timing);
  const barIndex = Math.floor(safe / barLength);
  const withinBar = safe - barIndex * barLength;
  const beatIndex = Math.floor(withinBar / beatLength);
  const subdivision = Math.floor((withinBar - beatIndex * beatLength) / (beatLength / 4)) + 1;
  return { bar: barIndex + 1, beat: beatIndex + 1, subdivision: Math.min(4, subdivision) };
}

export function formatMusicalPosition(milliseconds: number, timing: MusicalTiming) {
  const position = musicalPosition(milliseconds, timing);
  return `Bar ${position.bar} · Beat ${position.beat} · ${position.subdivision}`;
}
