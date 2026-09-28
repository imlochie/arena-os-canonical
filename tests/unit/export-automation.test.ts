import { describe, expect, it } from "vitest";
import {
  automatedTrackBusFilters,
  ffmpegAutomationExpression,
  ffmpegPanGainExpressions,
} from "../../apps/worker/src/automation";
import { parseExportSnapshot } from "../../apps/worker/src/export";

const point = (timelineMs: number, value: number) => ({ timelineMs, value });

function snapshot(automation: unknown) {
  return JSON.stringify({
    masterVolume: 1,
    tempoBpm: 120,
    targetKey: null,
    tracks: [{
      id: "track-a", stemAssetId: "stem-a", sortOrder: 0, volume: 0.8, pan: -0.25,
      muted: false, solo: false,
      clips: [{ stemAssetId: "stem-a", timelineStartMs: 0, durationMs: 1_000, sourceOffsetMs: 0, gain: 1, fadeInMs: 0, fadeOutMs: 0 }],
    }],
    automation,
  });
}

describe("authoritative FFmpeg automation construction", () => {
  it("keeps a no-automation track at its established static values", () => {
    expect(ffmpegAutomationExpression([], 0.8)).toBe("0.8");
    const gains = ffmpegPanGainExpressions([], -0.25, "0.8");
    expect(gains.left).toContain("cos");
    expect(gains.left).toContain("0.8");
    expect(gains.right).toContain("sin");
  });

  it("creates absolute-timeline linear volume expressions for one and multiple points", () => {
    expect(ffmpegAutomationExpression([point(500, 1.25)], 0.8)).toBe("1.25");
    const expression = ffmpegAutomationExpression([point(0, 0.25), point(2_000, 1.25)], 0.8);
    expect(expression).toContain("t-0");
    expect(expression).toContain("2");
    expect(expression).toContain("1.25");
  });

  it("constructs a single automated track bus after multiple clip outputs", () => {
    const filters = automatedTrackBusFilters(
      ["[clip0]", "[clip1]"], "track0", [point(0, 0.5), point(1_000, 1)], [point(0, -1), point(1_000, 1)], 0.8, 0,
    ).join(";");
    expect(filters).toContain("[clip0][clip1]amix=inputs=2");
    expect(filters).toContain("volume='");
    expect(filters).toContain("eval=frame");
    expect(filters).toContain("cos");
    expect(filters).toContain("sin");
    expect(filters).toContain("[track0]");
  });

  it("rejects malformed immutable automation snapshots and accepts valid source-relative lanes", () => {
    expect(() => parseExportSnapshot(snapshot([{ remixTrackId: "track-a", parameter: "volume", points: [point(0, 0.5)] }]))).not.toThrow();
    expect(() => parseExportSnapshot(snapshot([{ remixTrackId: "missing", parameter: "volume", points: [point(0, 0.5)] }]))).toThrow("automation track identity");
    expect(() => parseExportSnapshot(snapshot([{ remixTrackId: "track-a", parameter: "volume", points: [point(0, 3)] }]))).toThrow("automation");
    expect(() => parseExportSnapshot(snapshot([{ remixTrackId: "track-a", parameter: "not-a-lane", points: [] }]))).toThrow("automation");
  });
});
