export type VisualStemState = {
  id: string;
  volume: number;
  muted: boolean;
  solo: boolean;
};

export type VisualSection = { id: string; startMs: number; endMs: number };
export type WaveyardVisualState = {
  transportPhase: number;
  beatIndex: number | null;
  beatPulse: number;
  barPulse: number;
  sectionId: string | null;
  sectionProgress: number;
  stemIntensity: Record<string, number>;
};

function clamp(value: number) { return Math.max(0, Math.min(1, value)); }

/** A deterministic contextual palette; CSS decides how much of it to reveal. */
export function artworkEnvironment(seed: string | null | undefined) {
  let hash = 2166136261;
  for (const character of seed || "waveyard") { hash ^= character.charCodeAt(0); hash = Math.imul(hash, 16777619); }
  const hue = Math.abs(hash) % 360;
  return { hue, accentHue: (hue + 42) % 360, shadowHue: (hue + 212) % 360 };
}

export function motionPolicy(reducedMotion: boolean) {
  return reducedMotion
    ? { reducedMotion: true, beatScale: 0, transitionMs: 0, overlayDelayMs: 0 }
    : { reducedMotion: false, beatScale: 1, transitionMs: 480, overlayDelayMs: 2800 };
}

export const CINEMATIC_VISUAL_PRESETS = ["halo", "prism", "tide"] as const;
export type CinematicVisualPreset = (typeof CINEMATIC_VISUAL_PRESETS)[number];

export type CinematicVisualScene = {
  preset: CinematicVisualPreset;
  energy: number;
  scale: number;
  rotationDeg: number;
  accentOpacity: number;
  activeStemCount: number;
};

/**
 * Turns the shared transport-observing visual state into a small CSS scene.
 * The preset is deliberately display-only and has no project persistence.
 */
export function deriveCinematicVisualScene(input: {
  visualState: WaveyardVisualState;
  preset: CinematicVisualPreset;
  reducedMotion: boolean;
}): CinematicVisualScene {
  const intensities = Object.values(input.visualState.stemIntensity);
  const activeStemCount = intensities.filter((value) => value > 0).length;
  const energy = intensities.length ? clamp(intensities.reduce((sum, value) => sum + value, 0) / intensities.length) : 0;
  const pulse = input.reducedMotion ? 0 : input.visualState.beatPulse;
  const presetRotation = input.preset === "halo" ? 0 : input.preset === "prism" ? 32 : -26;
  const presetOpacity = input.preset === "halo" ? 0.38 : input.preset === "prism" ? 0.52 : 0.31;
  return {
    preset: input.preset,
    energy,
    scale: 1 + energy * 0.12 + pulse * 0.045,
    rotationDeg: presetRotation + (input.reducedMotion ? 0 : input.visualState.transportPhase * 22),
    accentOpacity: clamp(presetOpacity + energy * 0.25 + pulse * 0.1),
    activeStemCount,
  };
}

export function deriveVisualState(input: {
  positionMs: number;
  durationMs: number;
  playing: boolean;
  bpm: number | null | undefined;
  beatGridMs: readonly number[] | null | undefined;
  sections: readonly VisualSection[] | null | undefined;
  stems: readonly VisualStemState[];
  reducedMotion: boolean;
}): WaveyardVisualState {
  const durationMs = Number.isFinite(input.durationMs) && input.durationMs > 0 ? input.durationMs : 1;
  const positionMs = clamp(Number.isFinite(input.positionMs) ? input.positionMs / durationMs : 0) * durationMs;
  const anySolo = input.stems.some((stem) => stem.solo && !stem.muted);
  const beatGrid = Array.isArray(input.beatGridMs) && input.beatGridMs.length > 0
    ? input.beatGridMs.filter((beat) => Number.isSafeInteger(beat) && beat >= 0)
    : [];
  let beatIndex: number | null = null;
  let beatAt = 0;
  let beatInterval = input.bpm && input.bpm >= 20 && input.bpm <= 300 ? 60_000 / input.bpm : 500;
  if (beatGrid.length) {
    for (let index = 0; index < beatGrid.length; index += 1) {
      if (beatGrid[index] <= positionMs) { beatIndex = index; beatAt = beatGrid[index]; } else break;
    }
    if (beatIndex === null) { beatIndex = 0; beatAt = beatGrid[0]; }
    const following = beatGrid[Math.min(beatGrid.length - 1, beatIndex + 1)];
    const prior = beatGrid[Math.max(0, beatIndex - 1)];
    beatInterval = Math.max(1, (following > beatAt ? following - beatAt : beatAt - prior) || beatInterval);
  } else if (input.bpm && input.bpm >= 20 && input.bpm <= 300) {
    beatIndex = Math.floor(positionMs / beatInterval);
    beatAt = beatIndex * beatInterval;
  }
  const beatPulse = !input.playing || input.reducedMotion || beatIndex === null ? 0 : clamp(1 - (positionMs - beatAt) / Math.max(80, beatInterval * 0.32));
  const barPulse = beatIndex !== null && beatIndex % 4 === 0 ? beatPulse : 0;
  const section = (input.sections ?? []).find((candidate) => positionMs >= candidate.startMs && positionMs < candidate.endMs) ?? null;
  const stemIntensity = Object.fromEntries(input.stems.map((stem) => {
    const audible = !stem.muted && (!anySolo || stem.solo);
    return [stem.id, audible ? clamp(stem.volume / 2) : 0];
  }));
  return {
    transportPhase: clamp(positionMs / durationMs), beatIndex, beatPulse, barPulse,
    sectionId: section?.id ?? null,
    sectionProgress: section ? clamp((positionMs - section.startMs) / Math.max(1, section.endMs - section.startMs)) : 0,
    stemIntensity,
  };
}
