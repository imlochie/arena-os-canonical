import { describe, expect, it } from "vitest";
import { artworkEnvironment, deriveCinematicVisualScene, deriveVisualState, motionPolicy } from "@waveyard/types";

const base = {
  durationMs: 4_000,
  playing: true,
  bpm: 120,
  beatGridMs: [0, 500, 1_000, 1_500, 2_000],
  sections: [{ id: "verse", startMs: 0, endMs: 2_000 }, { id: "chorus", startMs: 2_000, endMs: 4_000 }],
  stems: [{ id: "vocals", volume: 1, muted: false, solo: false }, { id: "drums", volume: 2, muted: false, solo: false }],
  reducedMotion: false,
};

describe("Waveyard shared visual state", () => {
  it("derives transport, beat, bar, and section state from the authoritative transport inputs", () => {
    const state = deriveVisualState({ ...base, positionMs: 2_000 });
    expect(state).toMatchObject({ transportPhase: 0.5, beatIndex: 4, beatPulse: 1, barPulse: 1, sectionId: "chorus", sectionProgress: 0 });
    expect(deriveVisualState({ ...base, positionMs: 2_250 }).beatPulse).toBeLessThan(1);
  });

  it("normalizes stem intensity and communicates mute/solo without colour-only state", () => {
    expect(deriveVisualState({ ...base, positionMs: 1_000, stems: [{ id: "a", volume: 2, muted: false, solo: false }, { id: "b", volume: 1, muted: false, solo: true }] }).stemIntensity).toEqual({ a: 0, b: 0.5 });
    expect(deriveVisualState({ ...base, positionMs: 1_000, stems: [{ id: "a", volume: 1, muted: true, solo: false }] }).stemIntensity.a).toBe(0);
  });

  it("keeps visual derivation deterministic with calm reduced-motion fallback", () => {
    const input = { ...base, positionMs: 650, reducedMotion: true };
    expect(deriveVisualState(input)).toEqual(deriveVisualState(input));
    expect(deriveVisualState(input).beatPulse).toBe(0);
    expect(motionPolicy(true)).toMatchObject({ reducedMotion: true, beatScale: 0, transitionMs: 0 });
  });

  it("turns shared visual state into deterministic, non-persistent cinematic presets", () => {
    const state = deriveVisualState({ ...base, positionMs: 2_000 });
    expect(deriveCinematicVisualScene({ visualState: state, preset: "prism", reducedMotion: false })).toEqual(
      deriveCinematicVisualScene({ visualState: state, preset: "prism", reducedMotion: false }),
    );
    expect(deriveCinematicVisualScene({ visualState: state, preset: "halo", reducedMotion: false })).not.toMatchObject(
      deriveCinematicVisualScene({ visualState: state, preset: "tide", reducedMotion: false }),
    );
    const calm = deriveCinematicVisualScene({ visualState: state, preset: "halo", reducedMotion: true });
    expect(calm.rotationDeg).toBe(0);
    expect(calm.scale).toBeGreaterThanOrEqual(1);
  });

  it("generates stable artwork environments and a deterministic fallback", () => {
    expect(artworkEnvironment("art-key")).toEqual(artworkEnvironment("art-key"));
    expect(artworkEnvironment(null)).toEqual(artworkEnvironment(undefined));
    expect(artworkEnvironment("art-key").hue).not.toBe(artworkEnvironment("another-key").hue);
  });
});
