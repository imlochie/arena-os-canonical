import { describe, expect, it } from "vitest";
import {
  remixFromResponse,
  type PersistedRemixResponse,
} from "../../apps/web/src/components/studio/remix-response";

function completedAutomaticRemix(): PersistedRemixResponse {
  const stemTypes = ["bass", "drums", "other", "vocals"];
  return {
    remix: {
      id: "automatic-remix",
      name: "Automatic original",
      masterVolume: 1,
      loopStartMs: 0,
      loopEndMs: null,
      tempoBpm: 120,
      timeSignatureNumerator: 4,
      timeSignatureDenominator: 4,
      gridDivision: "beat",
      snapEnabled: true,
      targetKey: "F# minor",
    },
    tracks: stemTypes.map((stemType, trackIndex) => ({
      id: `track-${stemType}`,
      stemAssetId: `stem-${stemType}`,
      name: `fixture.wav — ${stemType}`,
      sortOrder: trackIndex,
      volume: 1,
      pan: 0,
      muted: false,
      solo: false,
      clips: [0, 1, 2].map((windowIndex) => ({
        id: `${stemType}-clip-${windowIndex}`,
        stemAssetId: `stem-${stemType}`,
        timelineStartMs: windowIndex * 6_000,
        sourceOffsetMs: windowIndex * 6_000,
        durationMs: windowIndex === 2 ? 8_000 : 6_000,
        gain: 1,
        fadeInMs: 0,
        fadeOutMs: 0,
        tempoSyncEnabled: false,
        keySyncEnabled: false,
        beatSnapEnabled: false,
      })),
    })),
    // The persisted endpoint returns an empty array for a newly generated
    // arrangement. It is still required Studio state because the timeline
    // renders automation lanes for every track immediately on Studio entry.
    automation: [],
  };
}

describe("Studio remix response hydration", () => {
  it("keeps empty automation lanes when hydrating a completed automatic remix", () => {
    const remix = remixFromResponse(completedAutomaticRemix());

    expect(remix.tracks).toHaveLength(4);
    expect(remix.tracks.every((track) => track.clips)).toBe(true);
    expect(remix.tracks.flatMap((track) => track.clips)).toHaveLength(12);
    expect(remix.automation).toEqual([]);
    expect(() => remix.automation.find((lane) => lane.parameter === "volume")).not.toThrow();
  });
});
