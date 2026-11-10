import { describe, it } from "node:test";
import { expect } from "./test-shim";
import {
  barMs,
  beatMs,
  formatMusicalPosition,
  musicalPosition,
  quarterNoteMs,
  snapIncrementMs,
  snapTimelineMs,
  type MusicalTiming,
} from "./timing";

const timing120_4_4: MusicalTiming = {
  tempoBpm: 120,
  timeSignatureNumerator: 4,
  timeSignatureDenominator: 4,
  gridDivision: "beat",
  snapEnabled: true,
};

const timing90_3_4: MusicalTiming = {
  tempoBpm: 90,
  timeSignatureNumerator: 3,
  timeSignatureDenominator: 4,
  gridDivision: "half-beat",
  snapEnabled: true,
};

const timing180_6_8: MusicalTiming = {
  tempoBpm: 180,
  timeSignatureNumerator: 6,
  timeSignatureDenominator: 8,
  gridDivision: "quarter-note",
  snapEnabled: true,
};

describe("quarterNoteMs", () => {
  it("returns 500 ms at 120 BPM", () => {
    expect(quarterNoteMs(timing120_4_4)).toBe(500);
  });

  it("returns 1000 ms at 60 BPM", () => {
    expect(quarterNoteMs({ ...timing120_4_4, tempoBpm: 60 })).toBe(1000);
  });

  it("returns 250 ms at 240 BPM", () => {
    expect(quarterNoteMs({ ...timing120_4_4, tempoBpm: 240 })).toBe(250);
  });

  it("is the reciprocal of tempo", () => {
    expect(quarterNoteMs({ ...timing120_4_4, tempoBpm: 100 })).toBeCloseTo(600);
  });
});

describe("beatMs", () => {
  it("equals the quarter note at 4/4", () => {
    expect(beatMs(timing120_4_4)).toBe(500);
  });

  it("equals the quarter note when the denominator is 4 regardless of numerator", () => {
    expect(beatMs({ ...timing120_4_4, timeSignatureNumerator: 3 })).toBe(500);
    expect(beatMs({ ...timing120_4_4, timeSignatureNumerator: 7 })).toBe(500);
  });

  it("is the eighth note at 6/8", () => {
    expect(beatMs(timing180_6_8)).toBeCloseTo(166.67, 1);
  });

  it("scales linearly with tempo", () => {
    const at120 = beatMs(timing120_4_4);
    const at60 = beatMs({ ...timing120_4_4, tempoBpm: 60 });
    expect(at60).toBe(at120 * 2);
  });
});

describe("barMs", () => {
  it("is four beats at 4/4", () => {
    expect(barMs(timing120_4_4)).toBe(2000);
  });

  it("is three beats at 3/4", () => {
    expect(barMs(timing90_3_4)).toBeCloseTo(2000, 0);
  });

  it("scales with the numerator", () => {
    const at4_4 = barMs(timing120_4_4);
    const at2_4 = barMs({ ...timing120_4_4, timeSignatureNumerator: 2 });
    expect(at2_4).toBe(at4_4 / 2);
  });
});


describe("snapIncrementMs", () => {
  it("returns one beat for the default beat division", () => {
    expect(snapIncrementMs(timing120_4_4)).toBe(500);
  });

  it("returns one half-beat for the half-beat division", () => {
    expect(snapIncrementMs({ ...timing120_4_4, gridDivision: "half-beat" })).toBe(250);
  });

  it("returns one bar for the bar division", () => {
    expect(snapIncrementMs({ ...timing120_4_4, gridDivision: "bar" })).toBe(2000);
  });

  it("returns one quarter-note for the quarter-note division", () => {
    expect(snapIncrementMs({ ...timing120_4_4, gridDivision: "quarter-note" })).toBe(500);
  });

  it("respects tempo and time signature", () => {
    const increment = snapIncrementMs({ ...timing120_4_4, tempoBpm: 90 });
    expect(increment).toBeCloseTo(666.67, 1);
  });
});

describe("snapTimelineMs", () => {
  it("snaps forward to the nearest grid increment", () => {
    expect(snapTimelineMs(1234, timing120_4_4)).toBe(1000);
  });

  it("snaps .5 up to the next increment", () => {
    expect(snapTimelineMs(750, timing120_4_4)).toBe(1000);
  });

  it("snaps exactly-on-grid values to themselves", () => {
    expect(snapTimelineMs(1000, timing120_4_4)).toBe(1000);
    expect(snapTimelineMs(0, timing120_4_4)).toBe(0);
  });

  it("clamps negative values to zero", () => {
    expect(snapTimelineMs(-100, timing120_4_4)).toBe(0);
    expect(snapTimelineMs(-1, timing120_4_4)).toBe(0);
  });

  it("returns the raw rounded value when snap is disabled", () => {
    expect(snapTimelineMs(1234, { ...timing120_4_4, snapEnabled: false })).toBe(1234);
    expect(snapTimelineMs(1234.7, { ...timing120_4_4, snapEnabled: false })).toBe(1235);
  });

  it("uses the half-beat increment when configured", () => {
    const halfBeat = { ...timing120_4_4, gridDivision: "half-beat" };
    expect(snapTimelineMs(300, halfBeat)).toBe(250);
    expect(snapTimelineMs(375, halfBeat)).toBe(500);
  });
});

describe("musicalPosition", () => {
  it("places the start of the timeline at bar 1 beat 1 subdivision 1", () => {
    expect(musicalPosition(0, timing120_4_4)).toEqual({ bar: 1, beat: 1, subdivision: 1 });
  });

  it("advances the beat after one beat length", () => {
    expect(musicalPosition(500, timing120_4_4)).toEqual({ bar: 1, beat: 2, subdivision: 1 });
  });

  it("advances the bar after one bar length", () => {
    expect(musicalPosition(2000, timing120_4_4)).toEqual({ bar: 2, beat: 1, subdivision: 1 });
  });

  it("reports subdivision within a beat", () => {
    expect(musicalPosition(125, timing120_4_4)).toEqual({ bar: 1, beat: 1, subdivision: 2 });
    expect(musicalPosition(375, timing120_4_4)).toEqual({ bar: 1, beat: 1, subdivision: 4 });
  });

  it("clamps subdivision to 4", () => {
    expect(musicalPosition(499, timing120_4_4).subdivision).toBeLessThanOrEqual(4);
  });

  it("clamps negative milliseconds to the start", () => {
    expect(musicalPosition(-500, timing120_4_4)).toEqual({ bar: 1, beat: 1, subdivision: 1 });
  });

  it("works with 3/4 time", () => {
    const pos = musicalPosition(700, timing90_3_4);
    expect(pos.bar).toBe(1);
    expect(pos.beat).toBe(2);
  });
});

describe("formatMusicalPosition", () => {
  it("formats the timeline start", () => {
    expect(formatMusicalPosition(0, timing120_4_4)).toBe("Bar 1 · Beat 1 · 1");
  });

  it("formats a later position", () => {
    expect(formatMusicalPosition(2500, timing120_4_4)).toBe("Bar 2 · Beat 2 · 1");
  });

  it("includes the subdivision", () => {
    expect(formatMusicalPosition(125, timing120_4_4)).toBe("Bar 1 · Beat 1 · 2");
  });
});