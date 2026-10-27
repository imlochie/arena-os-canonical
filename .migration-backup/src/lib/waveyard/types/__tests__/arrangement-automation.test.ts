import { describe, it } from "node:test";
import { expect } from "../../test-shim";
import {
  evaluateAutomation,
  normaliseAutomationPoints,
  upsertAutomationPoint,
} from "../index";

const points = [
  { id: "late", timelineMs: 1_000, value: 1.5 },
  { id: "early", timelineMs: 0, value: 0.5 },
  { id: "replacement", timelineMs: 1_000, value: 1.25 },
];

describe("V1 arrangement automation", () => {
  it("orders points and deterministically gives the last duplicate timestamp authority", () => {
    expect(normaliseAutomationPoints("volume", points)).toEqual([
      { id: "early", timelineMs: 0, value: 0.5 },
      { id: "replacement", timelineMs: 1_000, value: 1.25 },
    ]);
    expect(upsertAutomationPoint("pan", [{ id: "old", timelineMs: 500, value: -0.5 }], { id: "new", timelineMs: 500, value: 0.25 }))
      .toEqual([{ id: "new", timelineMs: 500, value: 0.25 }]);
  });

  it("linearly interpolates and clamps at both lane boundaries", () => {
    const lane = normaliseAutomationPoints("pan", [
      { timelineMs: 100, value: -1 },
      { timelineMs: 300, value: 1 },
    ])!;
    expect(evaluateAutomation(lane, 0, 0)).toBe(-1);
    expect(evaluateAutomation(lane, 200, 0)).toBe(0);
    expect(evaluateAutomation(lane, 1_000, 0)).toBe(1);
    expect(evaluateAutomation([], 200, 0.4)).toBe(0.4);
  });

  it("rejects malformed timings and parameter values rather than creating implicit curves", () => {
    expect(normaliseAutomationPoints("volume", [{ timelineMs: -1, value: 1 }])).toBeNull();
    expect(normaliseAutomationPoints("volume", [{ timelineMs: 1, value: 2.1 }])).toBeNull();
    expect(normaliseAutomationPoints("pan", [{ timelineMs: 1.5, value: 0 }])).toBeNull();
    expect(normaliseAutomationPoints("pan", [{ timelineMs: 1, value: Number.NaN }])).toBeNull();
  });
});
