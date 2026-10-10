/**
 * The sound visualizer engine — "generate different kinds of content based
 * on the sounds it hears" (vision §V4).
 *
 * Pure, client-safe, deterministic. Three layers:
 *
 *  1. analyzeSpectrum   — per-stem perception: band energies (sub-bass →
 *     treble), spectral centroid (brightness), flux/onset detection with an
 *     adaptive threshold, and beat-phase tracking from onset intervals.
 *  2. stepScene         — five content generators (nebula, terrain, orbits,
 *     tide, bloom), each a pure state machine driven by the per-stem
 *     features + time + the pointer (interaction is a first-class input).
 *  3. classifyCharacter + directScene — the director: reads the music's
 *     character (energy, brightness, percussiveness, vocal dominance) and
 *     decides which content fits, with dwell hysteresis so it never strobes.
 *
 * The React component (VisualizerStudio.tsx) is only the skin: it feeds
 * real AnalyserNode spectrums in and draws the resulting state out.
 * No Math.random here — every scene owns a seeded PRNG so a session is
 * reproducible and testable.
 */

// ------------------------------------------------------------------ colors

/** The studio's stem palette (kept in sync with the CSS variables). */
export const STEM_COLORS: Record<string, string> = {
  vocals: "#ff98bd",
  drums: "#8be5ff",
  bass: "#b7a0ff",
  other: "#f8ca7b",
  melody: "#f8ca7b",
  instrumental: "#9ee79b",
};

export function stemColor(stemType: string): string {
  return STEM_COLORS[stemType] ?? "#7ae5e7";
}

// ------------------------------------------------------------------ features

export type SpectrumFeatures = {
  /** Overall level 0–1. */
  rms: number;
  bands: {
    sub: number;
    bass: number;
    lowMid: number;
    mid: number;
    highMid: number;
    treble: number;
  };
  /** Spectral centroid, normalized 0–1 (0 = dark, 1 = bright). */
  centroid: number;
  /** Positive spectral change since the last frame, 0–1 (onset strength). */
  flux: number;
  /** True when flux crossed the adaptive threshold this frame. */
  onset: boolean;
  /** Position within the estimated beat cycle, 0–1 (null before a lock). */
  beatPhase: number | null;
};

export type AnalyzerState = {
  previous: Uint8Array | null;
  /** Recent flux values the adaptive threshold averages over. */
  fluxHistory: number[];
  /** Timestamps (ms) of recent onsets — the beat-interval evidence. */
  onsetTimes: number[];
  /** Estimated beat interval (ms), null until two onsets agree. */
  beatIntervalMs: number | null;
};

export function createAnalyzerState(): AnalyzerState {
  return { previous: null, fluxHistory: [], onsetTimes: [], beatIntervalMs: null };
}

/** Band edges in Hz (sub-bass → treble), the usual five-way split. */
export const BAND_EDGES = {
  sub: [20, 60],
  bass: [60, 250],
  lowMid: [250, 500],
  mid: [500, 2000],
  highMid: [2000, 4000],
  treble: [4000, 12000],
} as const;

export type BandName = keyof typeof BAND_EDGES;
export const BAND_NAMES: BandName[] = ["sub", "bass", "lowMid", "mid", "highMid", "treble"];

const ONSET_SENSITIVITY = 1.6;
const FLUX_HISTORY = 24;
const ONSET_MEMORY = 8;
const MIN_ONSET_GAP_MS = 90;

function bandAverage(spectrum: Uint8Array, fromHz: number, toHz: number, binWidthHz: number): number {
  const from = Math.max(0, Math.floor(fromHz / binWidthHz));
  const to = Math.min(spectrum.length - 1, Math.ceil(toHz / binWidthHz));
  if (to < from) return 0;
  let sum = 0;
  for (let i = from; i <= to; i += 1) sum += spectrum[i];
  return sum / ((to - from + 1) * 255);
}

/**
 * Analyze one spectrum frame. Pure: returns the features AND the next
 * analyzer state (the caller owns both).
 */
export function analyzeSpectrum(
  spectrum: Uint8Array,
  state: AnalyzerState,
  opts: { sampleRate: number; fftSize: number; nowMs: number },
): { features: SpectrumFeatures; state: AnalyzerState } {
  const binWidthHz = opts.sampleRate / opts.fftSize;

  let sum = 0;
  let weighted = 0;
  let nonzero = 0;
  for (let i = 0; i < spectrum.length; i += 1) {
    const value = spectrum[i];
    sum += value;
    if (value > 0) {
      weighted += value * i;
      nonzero += 1;
    }
  }
  const rms = sum / (spectrum.length * 255);
  const centroid = nonzero > 0 ? weighted / sum / spectrum.length : 0;

  const bands = {
    sub: bandAverage(spectrum, BAND_EDGES.sub[0], BAND_EDGES.sub[1], binWidthHz),
    bass: bandAverage(spectrum, BAND_EDGES.bass[0], BAND_EDGES.bass[1], binWidthHz),
    lowMid: bandAverage(spectrum, BAND_EDGES.lowMid[0], BAND_EDGES.lowMid[1], binWidthHz),
    mid: bandAverage(spectrum, BAND_EDGES.mid[0], BAND_EDGES.mid[1], binWidthHz),
    highMid: bandAverage(spectrum, BAND_EDGES.highMid[0], BAND_EDGES.highMid[1], binWidthHz),
    treble: bandAverage(spectrum, BAND_EDGES.treble[0], BAND_EDGES.treble[1], binWidthHz),
  };

  // Spectral flux (positive-only change), normalized to 0–1.
  let fluxSum = 0;
  if (state.previous !== null && state.previous.length === spectrum.length) {
    for (let i = 0; i < spectrum.length; i += 1) {
      const rise = spectrum[i] - state.previous[i];
      if (rise > 0) fluxSum += rise;
    }
  }
  const flux = fluxSum / (spectrum.length * 255);

  // Adaptive onset threshold: flux must beat the recent average clearly.
  const history = state.fluxHistory.length > 0 ? state.fluxHistory.reduce((a, b) => a + b, 0) / state.fluxHistory.length : 0;
  const aboveThreshold = flux > history * ONSET_SENSITIVITY && flux > 0.004;
  const gapOk = state.onsetTimes.length === 0 || opts.nowMs - state.onsetTimes[state.onsetTimes.length - 1] >= MIN_ONSET_GAP_MS;
  const onset = aboveThreshold && gapOk;

  const nextFluxHistory = [...state.fluxHistory, flux].slice(-FLUX_HISTORY);
  const onsetTimes = onset ? [...state.onsetTimes, opts.nowMs].slice(-ONSET_MEMORY) : state.onsetTimes;

  // Beat lock: the median interval between recent onsets, accepted when
  // two consecutive intervals agree within 25%.
  let beatIntervalMs = state.beatIntervalMs;
  if (onsetTimes.length >= 3) {
    const intervals: number[] = [];
    for (let i = 1; i < onsetTimes.length; i += 1) intervals.push(onsetTimes[i] - onsetTimes[i - 1]);
    intervals.sort((a, b) => a - b);
    const median = intervals[intervals.length >> 1];
    const agrees = intervals.every((interval) => Math.abs(interval - median) <= median * 0.25);
    if (agrees && median >= 180 && median <= 2000) beatIntervalMs = median;
  }

  let beatPhase: number | null = null;
  if (beatIntervalMs !== null && onsetTimes.length > 0) {
    const elapsed = opts.nowMs - onsetTimes[onsetTimes.length - 1];
    beatPhase = (elapsed % beatIntervalMs) / beatIntervalMs;
  }

  return {
    features: { rms, bands, centroid, flux, onset, beatPhase },
    state: { previous: spectrum.slice(), fluxHistory: nextFluxHistory, onsetTimes, beatIntervalMs },
  };
}

// ------------------------------------------------------------------ scenes

export type SceneId = "nebula" | "terrain" | "orbits" | "tide" | "bloom";

export const SCENE_IDS: SceneId[] = ["nebula", "terrain", "orbits", "tide", "bloom"];

export const SCENE_LABELS: Record<SceneId, string> = {
  nebula: "Nebula",
  terrain: "Terrain",
  orbits: "Orbits",
  tide: "Tide",
  bloom: "Bloom",
};

export const SCENE_BLURBS: Record<SceneId, string> = {
  nebula: "particles breathe with each stem — bass bursts, treble sparkles; the pointer pulls them in",
  terrain: "the spectrum carves a scrolling landscape — every ridge is a moment you just heard",
  orbits: "stems as bodies around the vocal star — drag to spin the system",
  tide: "mirrored band bars per stem — press for ripples",
  bloom: "flowers grow from onsets — bright sounds bloom bright; press to plant",
};

/** A stem's per-frame perceptual input to the scenes. */
export type StemInput = {
  stemType: string;
  features: SpectrumFeatures;
};

/** The pointer as the interaction input (normalized 0–1, y down). */
export type PointerState = { x: number; y: number; active: boolean };

export const IDLE_POINTER: PointerState = { x: 0.5, y: 0.5, active: false };

export type Particle = {
  x: number;
  y: number;
  vx: number;
  vy: number;
  life: number;
  maxLife: number;
  size: number;
  stemIndex: number;
};

export type Bloom = {
  x: number;
  y: number;
  growth: number;
  petals: number[];
  hue: number;
  stemIndex: number;
};

export type Ripple = { x: number; y: number; age: number };

export type SceneState = {
  scene: SceneId;
  particles: Particle[];
  /** Terrain history: rows of band snapshots, newest last. */
  terrain: number[][];
  /** Per-stem orbit bodies. */
  orbits: Array<{ angle: number; energy: number; speed: number }>;
  blooms: Bloom[];
  ripples: Ripple[];
  /** Monotonic step counter — the deterministic pseudo-random source. */
  tick: number;
};

export const TERRAIN_ROWS = 90;
const MAX_PARTICLES = 600;
const MAX_BLOOMS = 24;
const MAX_RIPPLES = 24;
const RIPPLE_LIFE_MS = 1400;
const BLOOM_LIFE_MS = 2600;
const POINTER_PLANT_GAP_TICKS = 12;

/** Deterministic 0–1 noise from the tick counter (no Math.random — pure). */
function noise(tick: number, salt: number): number {
  let a = (tick * 2654435761 + salt * 40503) >>> 0;
  a = (a ^ (a >>> 13)) * 1274126177;
  a = (a ^ (a >>> 16)) >>> 0;
  return a / 4294967296;
}

export function createScene(scene: SceneId, stemCount = 0): SceneState {
  return {
    scene,
    particles: [],
    terrain: [],
    orbits: Array.from({ length: Math.max(1, stemCount) }, (_, index) => ({
      angle: (index / Math.max(1, stemCount)) * Math.PI * 2,
      energy: 0,
      speed: 0.35 + index * 0.11,
    })),
    blooms: [],
    ripples: [],
    tick: 0,
  };
}

function hueFromString(color: string): number {
  // "#rrggbb" → 0–360 hue for the bloom palette.
  const r = parseInt(color.slice(1, 3), 16) / 255;
  const g = parseInt(color.slice(3, 5), 16) / 255;
  const b = parseInt(color.slice(5, 7), 16) / 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  if (max === min) return 0;
  const d = max - min;
  let h: number;
  if (max === r) h = ((g - b) / d) % 6;
  else if (max === g) h = (b - r) / d + 2;
  else h = (r - g) / d + 4;
  return (h * 60 + 360) % 360;
}

/**
 * Evolve one scene frame. Pure: same state + inputs → same next state.
 * `dtMs` should be clamped by the caller (the component sends real frame
 * time; tests send fixed steps).
 */
export function stepScene(
  state: SceneState,
  stems: readonly StemInput[],
  master: SpectrumFeatures,
  dtMs: number,
  pointer: PointerState,
): SceneState {
  const dt = Math.min(64, Math.max(0, dtMs)) / 1000;
  const tick = state.tick + 1;

  if (state.scene === "terrain") {
    const row = BAND_NAMES.map((band) => master.bands[band]);
    const terrain = [...state.terrain, row].slice(-TERRAIN_ROWS);
    return { ...state, terrain, tick };
  }

  if (state.scene === "orbits") {
    const torque = pointer.active ? (pointer.x - 0.5) * 2.4 : 0;
    const orbits = state.orbits.map((body, index) => {
      const stem = stems[Math.min(index, stems.length - 1)];
      const energy = stem?.features.rms ?? 0;
      const flux = stem?.features.flux ?? 0;
      return {
        angle: body.angle + (body.speed * (1 + flux * 4) + torque) * dt * 2,
        energy: body.energy + (energy - body.energy) * Math.min(1, dt * 6),
        speed: body.speed,
      };
    });
    return { ...state, orbits, tick };
  }

  if (state.scene === "tide") {
    let ripples = state.ripples.map((ripple) => ({ ...ripple, age: ripple.age + dtMs }));
    ripples = ripples.filter((ripple) => ripple.age < RIPPLE_LIFE_MS);
    if (pointer.active && tick % 6 === 0) {
      ripples = [...ripples, { x: pointer.x, y: pointer.y, age: 0 }].slice(-MAX_RIPPLES);
    }
    return { ...state, ripples, tick };
  }

  if (state.scene === "bloom") {
    let blooms = state.blooms.map((bloom) => ({ ...bloom, growth: bloom.growth + dtMs }));
    blooms = blooms.filter((bloom) => bloom.growth < BLOOM_LIFE_MS);
    if (master.onset && blooms.length < MAX_BLOOMS) {
      const vocalLed = stems.length > 0 && stems.some((stem) => stem.stemType === "vocals" && stem.features.rms > 0.25);
      const x = vocalLed ? 0.5 : 0.15 + noise(tick, 1) * 0.7;
      const y = vocalLed ? 0.42 : 0.2 + noise(tick, 2) * 0.6;
      const dominant = stems.reduce(
        (best, stem, index) => (stem.features.rms > (stems[best]?.features.rms ?? -1) ? index : best),
        0,
      );
      blooms = [
        ...blooms,
        {
          x,
          y,
          growth: 0,
          petals: BAND_NAMES.map((band) => master.bands[band]),
          hue: 40 + master.centroid * 280,
          stemIndex: dominant,
        },
      ].slice(-MAX_BLOOMS);
    }
    if (pointer.active && tick % POINTER_PLANT_GAP_TICKS === 0 && blooms.length < MAX_BLOOMS) {
      blooms = [
        ...blooms,
        { x: pointer.x, y: pointer.y, growth: 0, petals: BAND_NAMES.map((band) => master.bands[band]), hue: hueFromString(stemColor(stems[0]?.stemType ?? "")), stemIndex: 0 },
      ].slice(-MAX_BLOOMS);
    }
    return { ...state, blooms, tick };
  }

  // nebula — the particle field.
  let particles = state.particles.map((particle) => {
    let vx = particle.vx;
    let vy = particle.vy;
    if (pointer.active) {
      // Pointer gravity: pull toward the pointer, softened by distance.
      const dx = pointer.x - particle.x;
      const dy = pointer.y - particle.y;
      const distance = Math.max(0.02, Math.hypot(dx, dy));
      const pull = 0.9 / (distance * 8);
      vx += (dx / distance) * pull * dt;
      vy += (dy / distance) * pull * dt;
    }
    // Treble lifts, bass sinks slightly — the field stratifies by register.
    vy -= master.bands.treble * 0.22 * dt;
    vy += master.bands.bass * 0.06 * dt;
    return {
      ...particle,
      x: particle.x + vx * dt,
      y: particle.y + vy * dt,
      vx: vx * 0.995,
      vy: vy * 0.995,
      life: particle.life + dtMs,
    };
  });
  particles = particles.filter((particle) => particle.life < particle.maxLife && particle.y > -0.1 && particle.y < 1.1);

  const spawn = (count: number, stemIndex: number, speed: number) => {
    for (let i = 0; i < count && particles.length < MAX_PARTICLES; i += 1) {
      const stem = stems[Math.min(stemIndex, stems.length - 1)];
      const emitterX = stems.length > 1 ? (stemIndex + 0.5) / stems.length : 0.5;
      particles.push({
        x: emitterX + (noise(tick, i + stemIndex * 17) - 0.5) * 0.12,
        y: 0.96,
        vx: (noise(tick, 91 + i) - 0.5) * speed,
        vy: -(0.12 + noise(tick, 137 + i) * 0.25) * (1 + (stem?.features.bands.treble ?? 0)),
        life: 0,
        maxLife: 2400 + noise(tick, 211 + i) * 2600,
        size: 1.5 + noise(tick, 307 + i) * 3,
        stemIndex,
      });
    }
  };

  stems.forEach((stem, index) => {
    // Continuous breath: ~8/frame at full level.
    const continuous = Math.round(stem.features.rms * 8);
    spawn(continuous, index, 0.5);
    // Onsets burst.
    if (stem.features.onset) spawn(Math.round(10 + stem.features.flux * 90), index, 1.6);
  });

  return { ...state, particles, tick };
}

// ------------------------------------------------------------------ director

export type SoundCharacter = {
  /** Overall loudness 0–1. */
  energy: number;
  /** Spectral brightness 0–1. */
  brightness: number;
  /** How transient-driven the sound is 0–1. */
  percussiveness: number;
  /** Share of energy carried by the vocals 0–1. */
  vocalDominance: number;
  /** How many stems are active at once, 0–1. */
  density: number;
};

/** Read the music's character from the per-stem features (pure). */
export function classifyCharacter(stems: readonly StemInput[], master: SpectrumFeatures): SoundCharacter {
  const active = stems.filter((stem) => stem.features.rms > 0.02);
  const totalRms = active.reduce((sum, stem) => sum + stem.features.rms, 0);
  const vocalRms = active.filter((stem) => stem.stemType === "vocals").reduce((sum, stem) => sum + stem.features.rms, 0);
  const drumFlux = active.filter((stem) => stem.stemType === "drums").reduce((sum, stem) => sum + stem.features.flux, 0);
  return {
    energy: Math.min(1, master.rms * 2.2),
    brightness: master.centroid,
    percussiveness: Math.min(1, drumFlux * 18 + master.flux * 6),
    vocalDominance: totalRms > 0 ? Math.min(1, vocalRms / totalRms) : 0,
    density: stems.length > 0 ? active.length / stems.length : 0,
  };
}

export const DIRECTOR_DWELL_MS = 12_000;

/**
 * The director: pick the scene that fits what the music is doing.
 * Returns null while the current scene should hold (dwell hysteresis).
 *
 *   terrain   — ambient / low energy: the landscape listens patiently
 *   bloom     — vocal-led: organic growth around the voice
 *   orbits    — percussive and driving: kinetic bodies
 *   tide      — dense and mid-heavy: layered bars
 *   nebula    — bright and spacious: the particle field
 */
export function directScene(
  current: SceneId,
  character: SoundCharacter,
  lastSwitchMs: number,
  nowMs: number,
): { scene: SceneId; reason: string } | null {
  if (nowMs - lastSwitchMs < DIRECTOR_DWELL_MS) return null;
  if (character.energy < 0.08) {
    if (current === "terrain") return null;
    return { scene: "terrain", reason: "quiet, ambient passage — the landscape listens" };
  }
  if (character.vocalDominance > 0.45 && character.percussiveness < 0.5) {
    if (current === "bloom") return null;
    return { scene: "bloom", reason: "the vocals are leading — growing around the voice" };
  }
  if (character.percussiveness > 0.4 && character.energy > 0.35) {
    if (current === "orbits") return null;
    return { scene: "orbits", reason: "the drums are driving — a kinetic system" };
  }
  if (character.density > 0.7 && character.brightness < 0.45) {
    if (current === "tide") return null;
    return { scene: "tide", reason: "everything is playing at once — layered tide" };
  }
  if (character.brightness > 0.5) {
    if (current === "nebula") return null;
    return { scene: "nebula", reason: "bright and open — a particle field" };
  }
  return null;
}
