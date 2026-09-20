import { describe, expect, it } from "vitest";
import { validateWaveform, waveformPeaksForResolution } from "@waveyard/audio";
import {
  effectiveMuted,
  normaliseRemixState,
} from "../../apps/web/src/lib/remix";

describe("waveform peak reduction", () => {
  it("reduces signed PCM into deterministic normalized min/max buckets", () => {
    const samples = new Int16Array([
      -32768, -16384, 0, 16384, 32767, 8192, -8192, 0,
    ]);
    const first = waveformPeaksForResolution(samples, 4);
    const second = waveformPeaksForResolution(samples, 4);

    expect(first).toEqual(second);
    expect(first).toEqual({
      min: [-1, 0, 0.25, -0.25],
      max: [-0.5, 0.5, 0.999969, 0],
    });
  });

  it("rejects a malformed stored waveform document", () => {
    expect(() =>
      validateWaveform({
        format: "waveyard-peaks-v1",
        durationSeconds: 12,
        sampleRate: 44_100,
        channels: 1,
        resolutions: {
          256: { min: [0], max: [0] },
          512: { min: [], max: [] },
          1024: { min: [], max: [] },
          2048: { min: [], max: [] },
          4096: { min: [], max: [] },
        },
      }),
    ).toThrow("Invalid 256-bucket waveform");
  });
});

describe("remix arrangement normalisation", () => {
  const state = {
    masterVolume: 8,
    loopStartMs: -20,
    loopEndMs: 500,
    tracks: [
      {
        id: "track-a",
        stemAssetId: "stem-a",
        name: "  Vocal arrangement  ",
        sortOrder: 999,
        volume: -2,
        pan: 4,
        muted: false,
        solo: true,
        clips: [
          {
            id: "clip-a",
            stemAssetId: "stem-a",
            timelineStartMs: -10,
            durationMs: 0,
            sourceOffsetMs: -40,
            gain: 99,
          },
        ],
      },
    ],
  };

  it("bounds numeric arrangement state before persistence", () => {
    expect(normaliseRemixState(state)).toMatchObject({
      masterVolume: 2,
      loopStartMs: 0,
      loopEndMs: 500,
      tracks: [
        {
          id: "track-a",
          stemAssetId: "stem-a",
          name: "  Vocal arrangement  ",
          sortOrder: 99,
          volume: 0,
          pan: 1,
          solo: true,
          clips: [
            { timelineStartMs: 0, durationMs: 1, sourceOffsetMs: 0, gain: 4 },
          ],
        },
      ],
    });
  });

  it("enforces mute and solo semantics", () => {
    expect(effectiveMuted({ muted: false, solo: false }, false)).toBe(false);
    expect(effectiveMuted({ muted: true, solo: true }, false)).toBe(true);
    expect(effectiveMuted({ muted: false, solo: false }, true)).toBe(true);
    expect(effectiveMuted({ muted: false, solo: true }, true)).toBe(false);
  });

  it("rejects malformed track and clip shapes", () => {
    expect(
      normaliseRemixState({
        ...state,
        tracks: [{ ...state.tracks[0], clips: [{}] }],
      }),
    ).toBeNull();
    expect(
      normaliseRemixState({
        ...state,
        tracks: new Array(33).fill(state.tracks[0]),
      }),
    ).toBeNull();
  });
});
