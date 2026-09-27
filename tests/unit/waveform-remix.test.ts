import { describe, expect, it } from "vitest";
import { normaliseMusicalKey, semitoneShift } from "@waveyard/types";
import { validateWaveform, waveformPeaksForResolution } from "@waveyard/audio";
import { pitchFilterChain, pitchRatioForSemitones, resolveKeySync } from "../../apps/worker/src/key";
import { atempoFilterChain, requiredSourceDurationMs, sourceDurationFits, tempoRatio } from "../../apps/worker/src/tempo";
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

import { moveClip, splitClipAt, trimClipLeft, trimClipRight } from "../../apps/web/src/lib/arrangement";
import { barMs, beatMs, musicalPosition, snapTimelineMs } from "../../apps/web/src/lib/timing";

describe("tempo sync derivation", () => {
  it("defaults legacy clip intent off and preserves explicit boolean intent", () => {
    const base = {
      masterVolume: 1, loopStartMs: 0, loopEndMs: null,
      tracks: [{ id: "t", stemAssetId: "s", name: "Stem", sortOrder: 0, volume: 1, pan: 0, muted: false, solo: false,
        clips: [{ stemAssetId: "s", timelineStartMs: 0, durationMs: 1000, sourceOffsetMs: 0, gain: 1 }] }],
    };
    expect(normaliseRemixState(base)?.tracks[0].clips[0].tempoSyncEnabled).toBe(false);
    expect(normaliseRemixState({ ...base, tracks: [{ ...base.tracks[0], clips: [{ ...base.tracks[0].clips[0], tempoSyncEnabled: true }] }] })?.tracks[0].clips[0].tempoSyncEnabled).toBe(true);
  });

  it("derives ratio and deterministic single or chained atempo filters", () => {
    expect(tempoRatio(150, 100)).toBe(1.5);
    expect(atempoFilterChain(1.5)).toBe("atempo=1.50000000");
    expect(atempoFilterChain(8)).toBe("atempo=2.00000000,atempo=2.00000000,atempo=2.00000000");
    expect(atempoFilterChain(0.125)).toBe("atempo=0.50000000,atempo=0.50000000,atempo=0.50000000");
    expect(requiredSourceDurationMs(1000, 1.5)).toBe(1500);
    expect(sourceDurationFits(8_400, 1000, 1.5, 10_000)).toBe(true);
    expect(sourceDurationFits(8_501, 1000, 1.5, 10_000)).toBe(false);
  });

  it("rejects unavailable normalized source BPM", () => {
    expect(() => tempoRatio(120, Number.NaN)).toThrow("unavailable");
    expect(() => tempoRatio(120, 39)).toThrow("unavailable");
  });
});

describe("key sync derivation", () => {
  it("parses source-analysis keys and normalizes enharmonic spellings", () => {
    expect(normaliseMusicalKey("Gb minor")).toBe("F# minor");
    expect(normaliseMusicalKey("B# major")).toBe("C major");
    expect(normaliseMusicalKey("not a key")).toBeNull();
  });

  it("calculates deterministic signed chromatic shifts across C and B", () => {
    expect(semitoneShift("B major", "C major")).toBe(1);
    expect(semitoneShift("C major", "B major")).toBe(-1);
    expect(semitoneShift("F# minor", "D minor")).toBe(-4);
    expect(semitoneShift("Gb minor", "F# major")).toBe(0);
    expect(semitoneShift(null, "C major")).toBeNull();
    expect(resolveKeySync("failed", "F# minor", "D minor")).toEqual({ errorCode: "key_sync_analysis_missing" });
    expect(resolveKeySync("complete", null, "D minor")).toEqual({ errorCode: "key_sync_key_unavailable" });
  });

  it("builds a deterministic pitch-preserving FFmpeg chain", () => {
    expect(() => pitchRatioForSemitones(12)).toThrow("Invalid");
    expect(pitchRatioForSemitones(3)).toBeCloseTo(2 ** (3 / 12));
    expect(pitchFilterChain(-1, 44_100)).toContain("asetrate=41625,aresample=44100,atempo=");
  });

  it("defaults legacy key intent off and preserves an explicit enabled intent", () => {
    const base = {
      masterVolume: 1, loopStartMs: 0, loopEndMs: null,
      tracks: [{ id: "t", stemAssetId: "s", name: "Stem", sortOrder: 0, volume: 1, pan: 0, muted: false, solo: false,
        clips: [{ stemAssetId: "s", timelineStartMs: 0, durationMs: 1000, sourceOffsetMs: 0, gain: 1 }] }],
    };
    expect(normaliseRemixState(base)?.targetKey).toBeNull();
    expect(normaliseRemixState(base)?.tracks[0].clips[0].keySyncEnabled).toBe(false);
    const enabled = normaliseRemixState({ ...base, targetKey: "Db minor", tracks: [{ ...base.tracks[0], clips: [{ ...base.tracks[0].clips[0], keySyncEnabled: true }] }] });
    expect(enabled).toMatchObject({ targetKey: "C# minor", tracks: [{ clips: [{ keySyncEnabled: true }] }] });
  });
});

describe("musical timing and clip operations", () => {
  const timing = {
    tempoBpm: 120,
    timeSignatureNumerator: 4,
    timeSignatureDenominator: 4,
    gridDivision: "beat" as const,
    snapEnabled: true,
  };
  const clip = {
    stemAssetId: "stem-a",
    timelineStartMs: 1000,
    durationMs: 4000,
    sourceOffsetMs: 500,
    gain: 1,
    fadeInMs: 0,
    fadeOutMs: 0,
    tempoSyncEnabled: false,
    keySyncEnabled: false,
  };

  it("calculates stable musical positions and snapping", () => {
    expect(beatMs(timing)).toBe(500);
    expect(barMs(timing)).toBe(2000);
    expect(snapTimelineMs(760, timing)).toBe(1000);
    expect(musicalPosition(2500, timing)).toEqual({ bar: 2, beat: 2, subdivision: 1 });
  });

  it("preserves source media while moving, trimming, and splitting clips", () => {
    expect(moveClip(clip, 2250).timelineStartMs).toBe(2250);
    expect(trimClipLeft(clip, 1500, 10_000)).toMatchObject({
      timelineStartMs: 1500,
      sourceOffsetMs: 1000,
      durationMs: 3500,
    });
    expect(trimClipRight(clip, 3500, 10_000).durationMs).toBe(2500);
    expect(splitClipAt(clip, 2500)).toMatchObject({
      left: { durationMs: 1500, sourceOffsetMs: 500 },
      right: { timelineStartMs: 2500, sourceOffsetMs: 2000, durationMs: 2500 },
    });
  });

  it("defaults missing Phase 5 snapshot fields without changing legacy clips", () => {
    const normalized = normaliseRemixState({
      masterVolume: 1,
      loopStartMs: 0,
      loopEndMs: null,
      tracks: [{
        id: "track-a",
        stemAssetId: "stem-a",
        name: "Legacy track",
        sortOrder: 0,
        volume: 1,
        pan: 0,
        muted: false,
        solo: false,
        clips: [{ stemAssetId: "stem-a", timelineStartMs: 0, durationMs: 1000, sourceOffsetMs: 0, gain: 1 }],
      }],
    });
    expect(normalized).toMatchObject({
      tempoBpm: 120,
      timeSignatureNumerator: 4,
      timeSignatureDenominator: 4,
      gridDivision: "beat",
      snapEnabled: true,
      tracks: [{ clips: [{ fadeInMs: 0, fadeOutMs: 0 }] }],
    });
  });
});
