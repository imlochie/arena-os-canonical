import { describe, expect, it } from "vitest";
import {
  beatGridAvailability,
  beatRangeToSourceWindow,
  createLoopClips,
  nearestBeat,
  normaliseMusicalKey,
  projectSourceBeatToTimelineMs,
  semitoneShift,
  sliceClipToBeatRange,
  snapSourceWindowToBeats,
  tempoRatioForBpm,
} from "@waveyard/types";
import { validateWaveform, waveformPeaksForResolution } from "@waveyard/audio";
import { pitchFilterChain, pitchRatioForSemitones, resolveKeySync } from "../../apps/worker/src/key";
import { atempoFilterChain, requiredSourceDurationMs, sourceDurationFits, tempoRatio } from "../../apps/worker/src/tempo";
import {
  crossfadeError,
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

  it("persists timeline starts as millisecond integers", () => {
    const result = normaliseRemixState({
      ...state,
      tracks: [{
        ...state.tracks[0],
        clips: [{
          ...state.tracks[0].clips[0],
          timelineStartMs: 2.4,
          durationMs: 1_000,
        }],
      }],
    });

    expect(result?.tracks[0].clips[0].timelineStartMs).toBe(2);
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

  it("requires each persisted overlap to match both boundary fades", () => {
    const first = {
      stemAssetId: "stem-a", timelineStartMs: 0, durationMs: 7_000,
      sourceOffsetMs: 0, gain: 1, fadeInMs: 0, fadeOutMs: 1_000,
      tempoSyncEnabled: false, keySyncEnabled: false, beatSnapEnabled: false,
    };
    const second = {
      stemAssetId: "stem-a", timelineStartMs: 6_000, durationMs: 6_000,
      sourceOffsetMs: 6_000, gain: 1, fadeInMs: 1_000, fadeOutMs: 0,
      tempoSyncEnabled: false, keySyncEnabled: false, beatSnapEnabled: false,
    };
    expect(crossfadeError({ clips: [first, second] })).toBeNull();
    expect(crossfadeError({
      clips: [{ ...first, timelineStartMs: 2_000 }, second],
    })).toBe(
      "Adjacent overlapping clips require matching fade-out, fade-in, and overlap durations.",
    );
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

describe("beat-aware arrangement", () => {
  const grid = [1_000, 1_500, 2_000, 2_500];

  it("selects exact and nearest beats deterministically without mutating the grid", () => {
    const original = [2_000, 1_000, 1_500];
    expect(nearestBeat(1_500, grid)).toBe(1_500);
    expect(nearestBeat(1_740, grid)).toBe(1_500);
    expect(nearestBeat(1_750, grid)).toBe(1_500); // equal-distance chooses earlier
    expect(nearestBeat(1_760, grid)).toBe(2_000);
    expect(nearestBeat(1_300, original)).toBe(1_500);
    expect(original).toEqual([2_000, 1_000, 1_500]);
  });

  it("clamps before and after the analyzed grid and leaves empty grids unavailable", () => {
    expect(nearestBeat(10, grid)).toBe(1_000);
    expect(nearestBeat(9_999, grid)).toBe(2_500);
    expect(nearestBeat(1_000, [])).toBeNull();
    expect(beatGridAvailability("complete", [], 0.9)).toBe("unavailable");
    expect(beatGridAvailability("complete", grid, 0.2)).toBe("low-confidence");
    expect(beatGridAvailability("complete", grid, 0.8)).toBe("available");
  });

  it("resolves source windows to beat boundaries and preserves disabled freeform intent", () => {
    expect(snapSourceWindowToBeats(1_120, 840, grid)).toEqual({ sourceOffsetMs: 1_000, durationMs: 1_000 });
    expect(snapSourceWindowToBeats(1_120, 840, [])).toBeNull();
    const legacy = normaliseRemixState({
      masterVolume: 1, loopStartMs: 0, loopEndMs: null,
      tracks: [{ id: "t", stemAssetId: "s", name: "Stem", sortOrder: 0, volume: 1, pan: 0, muted: false, solo: false,
        clips: [{ stemAssetId: "s", timelineStartMs: 111, durationMs: 333, sourceOffsetMs: 127, gain: 1 }] }],
    });
    expect(legacy?.tracks[0].clips[0]).toMatchObject({ beatSnapEnabled: false, sourceOffsetMs: 127 });
  });

  it("keeps timeline snapping on the existing remix musical grid", () => {
    const timing = { tempoBpm: 120, timeSignatureNumerator: 4, timeSignatureDenominator: 4, gridDivision: "beat" as const, snapEnabled: true };
    expect(snapTimelineMs(760, timing)).toBe(1_000);
    expect(snapTimelineMs(760, { ...timing, snapEnabled: false })).toBe(760);
  });

  it("projects source beats through the existing target/source tempo ratio", () => {
    const ratio = tempoRatioForBpm(96, 120);
    expect(ratio).toBe(0.8);
    expect(projectSourceBeatToTimelineMs(2_000, 1_000, 500, ratio!)).toBe(1_750);
    expect(projectSourceBeatToTimelineMs(2_000, 1_000, 500, 0)).toBeNull();
  });
});

describe("beat-aligned chopping and looping", () => {
  const grid = [0, 500, 1_000, 1_500, 2_000];
  const clip = {
    id: "clip-a",
    stemAssetId: "stem-a",
    timelineStartMs: 2_000,
    durationMs: 1_000,
    sourceOffsetMs: 0,
    gain: 0.75,
    fadeInMs: 100,
    fadeOutMs: 200,
    tempoSyncEnabled: true,
    keySyncEnabled: true,
    beatSnapEnabled: true,
  };

  it("resolves first, interior, and final valid beat intervals", () => {
    expect(beatRangeToSourceWindow(grid, 0, 1, 2_000)).toEqual({ ok: true, sourceOffsetMs: 0, sourceDurationMs: 500 });
    expect(beatRangeToSourceWindow(grid, 1, 3, 2_000)).toEqual({ ok: true, sourceOffsetMs: 500, sourceDurationMs: 1_000 });
    expect(beatRangeToSourceWindow(grid, 3, 4, 2_000)).toEqual({ ok: true, sourceOffsetMs: 1_500, sourceDurationMs: 500 });
  });

  it("rejects invalid beat ranges, duplicate timestamps, unavailable grids, and out-of-source windows", () => {
    expect(beatRangeToSourceWindow(grid, -1, 1, 2_000)).toMatchObject({ ok: false, reason: "beat_range_invalid" });
    expect(beatRangeToSourceWindow(grid, 3, 2, 2_000)).toMatchObject({ ok: false, reason: "beat_range_invalid" });
    expect(beatRangeToSourceWindow([], 0, 1, 2_000)).toMatchObject({ ok: false, reason: "beat_grid_unavailable" });
    expect(beatRangeToSourceWindow([0, 500, 500], 1, 2, 2_000)).toMatchObject({ ok: false, reason: "beat_range_invalid" });
    expect(beatRangeToSourceWindow(grid, 2, 4, 1_900)).toMatchObject({ ok: false, reason: "source_bounds_invalid" });
  });

  it("creates independent transformed slice metadata from source beats", () => {
    const result = sliceClipToBeatRange(clip, grid, 1, 3, 2_000, 0.8);
    expect(result).toMatchObject({ ok: true, clip: {
      id: undefined,
      stemAssetId: "stem-a",
      sourceOffsetMs: 500,
      durationMs: 1_250,
      timelineStartMs: 2_000,
      gain: 0.75,
      fadeInMs: 100,
      fadeOutMs: 200,
      tempoSyncEnabled: true,
      keySyncEnabled: true,
      beatSnapEnabled: true,
    } });
    expect(clip).toMatchObject({ id: "clip-a", sourceOffsetMs: 0, durationMs: 1_000 });
  });

  it("creates bounded deterministic loop clips with independent entries", () => {
    expect(createLoopClips(clip, 1)).toMatchObject([{ timelineStartMs: 3_000 }]);
    const loops = createLoopClips(clip, 3);
    expect(loops).toMatchObject([
      { id: undefined, timelineStartMs: 3_000, sourceOffsetMs: 0, durationMs: 1_000, tempoSyncEnabled: true, keySyncEnabled: true, beatSnapEnabled: true, gain: 0.75, fadeInMs: 100, fadeOutMs: 200 },
      { id: undefined, timelineStartMs: 4_000 },
      { id: undefined, timelineStartMs: 5_000 },
    ]);
    expect(loops?.[0]).not.toBe(loops?.[1]);
    expect(createLoopClips(clip, 0)).toBeNull();
    expect(createLoopClips(clip, -1)).toBeNull();
    expect(createLoopClips(clip, 65)).toBeNull();
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
    beatSnapEnabled: false,
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
