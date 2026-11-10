import { describe, it } from "node:test";
import { expect } from "./test-shim";
import {
  derivePlayerPhase,
  formatPlayerTime,
  playerPhaseLabel,
  sectionWidths,
} from "../../../../../artifacts/arenaforge/src/components/waveyard/player/player-state";

describe("Living Player presentation state", () => {
  it("observes idle, loading, analysis, playing, paused, and errors without creating transport state", () => {
    expect(derivePlayerPhase({ hasSource: false, duration: 0, playing: false })).toBe("idle");
    expect(derivePlayerPhase({ hasSource: true, duration: 0, playing: false })).toBe("loading");
    expect(derivePlayerPhase({ hasSource: true, duration: 180, playing: false, analysisStatus: "processing" })).toBe("analysis");
    expect(derivePlayerPhase({ hasSource: true, duration: 180, playing: true, analysisStatus: "complete" })).toBe("playing");
    expect(derivePlayerPhase({ hasSource: true, duration: 180, playing: false, analysisStatus: "complete" })).toBe("paused");
    expect(derivePlayerPhase({ hasSource: true, duration: 180, playing: true, error: "Decode failed" })).toBe("error");
    expect(playerPhaseLabel("seeking")).toBe("Seeking");
  });

  it("formats playback time defensively", () => {
    expect(formatPlayerTime(0)).toBe("0:00");
    expect(formatPlayerTime(65.9)).toBe("1:05");
    expect(formatPlayerTime(Number.NaN)).toBe("0:00");
    expect(formatPlayerTime(-4)).toBe("0:00");
  });

  it("derives bounded presentation section widths from source-relative timing", () => {
    expect(sectionWidths([{ startMs: 0, endMs: 25_000 }, { startMs: 25_000, endMs: 100_000 }], 100)).toEqual([
      { startPercent: 0, widthPercent: 25 },
      { startPercent: 25, widthPercent: 75 },
    ]);
    expect(sectionWidths([{ startMs: -20, endMs: 140_000 }], 100)).toEqual([{ startPercent: 0, widthPercent: 100 }]);
    expect(sectionWidths([], 100)).toEqual([]);
  });
});
