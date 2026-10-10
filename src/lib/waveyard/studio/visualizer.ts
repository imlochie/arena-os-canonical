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
  // Layered stems ("other/vocals") inherit their parent's color.
  return STEM_COLORS[stemType.split("/")[0]] ?? "#7ae5e7";
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

export type SceneId =
  | "nebula"
  | "terrain"
  | "orbits"
  | "tide"
  | "bloom"
  | "waves"
  | "helix"
  | "waterfall"
  | "beatcity"
  | "halo"
  | "circuit"
  | "lyrics"
  | "chopgalaxy";

export const SCENE_IDS: SceneId[] = [
  "nebula",
  "terrain",
  "orbits",
  "tide",
  "bloom",
  "waves",
  "helix",
  "waterfall",
  "beatcity",
  "halo",
  "circuit",
  "lyrics",
  "chopgalaxy",
];

export const SCENE_LABELS: Record<SceneId, string> = {
  nebula: "Nebula",
  terrain: "Terrain",
  orbits: "Orbits",
  tide: "Tide",
  bloom: "Bloom",
  waves: "Waves",
  helix: "DNA helix",
  waterfall: "Waterfall",
  beatcity: "Beat city",
  halo: "Harmony halo",
  circuit: "Circuit",
  lyrics: "Phrase constellation",
  chopgalaxy: "Chop galaxy",
};

export const SCENE_BLURBS: Record<SceneId, string> = {
  nebula: "particles breathe with each stem — bass bursts, treble sparkles; the pointer pulls them in",
  terrain: "the spectrum carves a scrolling landscape — every ridge is a moment you just heard",
  orbits: "stems as bodies around the vocal star — drag to spin the system",
  tide: "mirrored band bars per stem — press for ripples",
  bloom: "flowers grow from onsets — bright sounds bloom bright; press to plant",
  waves: "each stem's actual audio wave, flowing together — press and hold to freeze and inspect",
  helix: "stems as strands of one helix — beats build the rungs; drag to twist",
  waterfall: "every stem's spectrum painted into falling history — hold to freeze the fall",
  beatcity: "the analysed bar grid as a skyline — buildings rise while their bar plays",
  halo: "the circle of fifths with the live chord lit — modulations sweep the wheel",
  circuit: "the real audio graph as living circuitry — wire thickness is level",
  lyrics: "vocal phrases bloom as the voice sings, height follows pitch — no lyric text, the analysis gives phrases",
  chopgalaxy: "the scanned vocal chops as stars by pitch and time — they light as the playhead passes",
};

/** A stem's per-frame perceptual input to the scenes. */
export type StemInput = {
  stemType: string;
  features: SpectrumFeatures;
  /** The raw time-domain tap ([-1, 1]) when the consumer provides one —
   *  the waves scene draws this literally; other scenes ignore it. */
  waveform?: Float32Array;
};

/** The pointer as the interaction input (normalized 0–1, y down). */
export type PointerState = { x: number; y: number; active: boolean };

export const IDLE_POINTER: PointerState = { x: 0.5, y: 0.5, active: false };

/**
 * The analysed-music context the data-driven scenes read (phrases, chords,
 * chops, bars, the playhead). All optional — a scene degrades honestly when
 * its data is missing.
 */
export type HarmonyChordInput = { startMs: number; endMs: number; root: string | null; quality: string };
export type PhraseInput = { startMs: number; endMs: number; midi: number | null };
export type ChopInput = { startMs: number; durationMs: number; rootMidi: number; confidence: number };

export type MusicContext = {
  /** Transport playhead in ms along the analysed song timeline. */
  positionMs?: number | null;
  /** The analysed timeline's total length (draw-time star maps). */
  durationMs?: number | null;
  /** Analysed tempo, when the source analysis has one. */
  bpm?: number | null;
  /** Manual beat re-anchor (beat-tap): overrides the analyzer's phase. */
  beatPhaseOverride?: number | null;
  /** Live chroma (12 pitch classes, 0–1) from the master spectrum. */
  chroma?: readonly number[];
  /** Chord events from the source's harmony analysis. */
  chords?: readonly HarmonyChordInput[];
  /** Vocal phrases with their mean pitch (midi), from the vocals stem. */
  phrases?: readonly PhraseInput[];
  /** Scanned vocal chops. */
  chops?: readonly ChopInput[];
  /** Arrangement-layer count per stem (the real graph's children). */
  layerCounts?: readonly number[];
};

/** Customization limits threaded into the engine (all optional). */
export type SceneLimits = {
  /** Particle cap (the reactivity knob). */
  particles?: number;
  /** Waterfall history length. */
  waterfallColumns?: number;
};

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
  /** Waves history: per stem, [min, max] columns, newest last. */
  waveColumns: Array<Array<[number, number]>>;
  blooms: Bloom[];
  ripples: Ripple[];
  /** Helix rotation + rungs (beats become the rungs). */
  helixRotation: number;
  helixRungs: Array<{ age: number; glow: number; x: number }>;
  helixLastPhase: number | null;
  /** Waterfall history: per stem, columns of the 6 band values. */
  waterfallColumns: Array<Array<number[]>>;
  /** Beat city: bar-indexed skyline heights (ring buffer) + cursor. */
  cityHeights: number[];
  cityLastBar: number;
  /** Halo: smoothed chroma + the modulation sweep. */
  haloChroma: number[];
  haloSweep: { age: number; fromRoot: number } | null;
  haloLastRoot: number | null;
  /** Circuit: the current phase flowing along the wires. */
  circuitPulse: number;
  /** Phrase constellation / chop galaxy glows (parallel to the music data). */
  phraseGlows: number[];
  chopGlows: number[];
  /** Monotonic step counter — the deterministic pseudo-random source. */
  tick: number;
};

export const TERRAIN_ROWS = 90;
export const WAVES_COLUMNS = 180;
export const WATERFALL_COLUMNS = 160;
export const CITY_BARS = 64;
const HELIX_RUNG_LIFE_MS = 2600;
const MAX_HELIX_RUNGS = 48;
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
    waveColumns: Array.from({ length: Math.max(1, stemCount) }, () => [] as Array<[number, number]>),
    waterfallColumns: Array.from({ length: Math.max(1, stemCount) }, () => [] as number[][]),
    blooms: [],
    ripples: [],
    helixRotation: 0,
    helixRungs: [],
    helixLastPhase: null,
    cityHeights: [],
    cityLastBar: -1,
    haloChroma: new Array<number>(12).fill(0),
    haloSweep: null,
    haloLastRoot: null,
    circuitPulse: 0,
    phraseGlows: [],
    chopGlows: [],
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
  music: MusicContext = {},
  limits: SceneLimits = {},
): SceneState {
  const dt = Math.min(64, Math.max(0, dtMs)) / 1000;
  const tick = state.tick + 1;

  if (state.scene === "helix") {
    // Strands twist on their own; the pointer adds torque (like orbits).
    const torque = pointer.active ? (pointer.x - 0.5) * 2.2 : 0;
    const rotation = state.helixRotation + (0.5 + torque) * dt * 1.6;
    // Rungs: one per beat — from the manual beat-tap anchor when present,
    // else the analyzer's phase; onsets are the fallback pulse.
    const phase = music.beatPhaseOverride ?? master.beatPhase;
    const newBeat = beatWrap(state.helixLastPhase, phase) || master.onset;
    let rungs = state.helixRungs.map((rung) => ({ ...rung, age: rung.age + dtMs, x: rung.x - dt * 0.22 }));
    rungs = rungs.filter((rung) => rung.age < HELIX_RUNG_LIFE_MS && rung.x > -0.05);
    if (newBeat && rungs.length < MAX_HELIX_RUNGS) {
      rungs = [
        ...rungs,
        { age: 0, glow: Math.min(1, 0.25 + master.rms * 2), x: 1 },
      ].slice(-MAX_HELIX_RUNGS);
    }
    return { ...state, helixRotation: rotation, helixRungs: rungs, helixLastPhase: phase, tick };
  }

  if (state.scene === "waterfall") {
    // Per-stem band snapshots fall like paint. Hold to freeze (like waves).
    if (pointer.active) return { ...state, tick };
    const cap = limits.waterfallColumns ?? WATERFALL_COLUMNS;
    const waterfallColumns = state.waterfallColumns.map((columns, index) => {
      const stem = stems[Math.min(index, stems.length - 1)];
      if (stem === undefined) return columns;
      const column = BAND_NAMES.map((band) => stem.features.bands[band]);
      return [...columns, column].slice(-cap);
    });
    return { ...state, waterfallColumns, tick };
  }

  if (state.scene === "beatcity") {
    // The skyline: one building per bar; the playing bar's height follows
    // the level, past bars keep their peak (decaying slowly).
    const bar = music.bpm !== null && music.bpm !== undefined && music.bpm > 0
      ? barIndexAt(music.positionMs ?? 0, music.bpm)
      : null;
    let heights = state.cityHeights.length === 0 ? new Array<number>(CITY_BARS).fill(0) : [...state.cityHeights];
    if (bar !== null) {
      // The playing bar's height follows the level (seeks just re-light it).
      const active = Math.min(1, 0.3 + master.rms * 1.6);
      heights[bar % CITY_BARS] = Math.max(heights[bar % CITY_BARS], active);
    }
    heights = heights.map((height) => height * (1 - dt * 0.05));
    return { ...state, cityHeights: heights, cityLastBar: bar ?? state.cityLastBar, tick };
  }

  if (state.scene === "halo") {
    // Smooth the live chroma, light the analysed chord, sweep on change.
    const target = music.chroma ?? state.haloChroma;
    const smoothing = Math.min(1, dt * 8);
    const haloChroma = state.haloChroma.map((value, index) => value + ((target[index] ?? 0) - value) * smoothing);
    const analysed = chordAt(music.chords ?? [], music.positionMs ?? 0);
    const live = bestChord(haloChroma);
    const root = analysed?.rootIndex ?? live?.rootIndex ?? null;
    let sweep = state.haloSweep === null ? null : { ...state.haloSweep, age: state.haloSweep.age + dtMs };
    if (sweep !== null && sweep.age > 900) sweep = null;
    if (root !== null && state.haloLastRoot !== null && root !== state.haloLastRoot) {
      sweep = { age: 0, fromRoot: state.haloLastRoot };
    }
    return { ...state, haloChroma, haloSweep: sweep, haloLastRoot: root ?? state.haloLastRoot, tick };
  }

  if (state.scene === "circuit") {
    // Current flows faster when the master is louder.
    const pulse = state.circuitPulse + dt * (0.35 + master.rms * 2.2);
    return { ...state, circuitPulse: pulse, tick };
  }

  if (state.scene === "lyrics") {
    // The active phrase glows; the rest dim.
    const phrases = music.phrases ?? [];
    const position = music.positionMs ?? null;
    let glows = state.phraseGlows.length === phrases.length ? [...state.phraseGlows] : new Array<number>(phrases.length).fill(0);
    glows = glows.map((glow, index) => {
      const phrase = phrases[index];
      const active = phrase !== undefined && position !== null && position >= phrase.startMs && position < phrase.endMs;
      if (active) return Math.min(1, glow + dt * 6);
      return Math.max(0, glow - dt * 1.4);
    });
    return { ...state, phraseGlows: glows, tick };
  }

  if (state.scene === "chopgalaxy") {
    // Chops light when the playhead is inside them; onsets spark the near.
    const chops = music.chops ?? [];
    const position = music.positionMs ?? null;
    let glows = state.chopGlows.length === chops.length ? [...state.chopGlows] : new Array<number>(chops.length).fill(0);
    glows = glows.map((glow, index) => {
      const chop = chops[index];
      if (chop === undefined || position === null) return Math.max(0, glow - dt * 2);
      const inside = position >= chop.startMs && position < chop.startMs + chop.durationMs;
      if (inside) return Math.min(1, glow + dt * 8);
      const near = Math.abs(position - chop.startMs) < 900;
      if (near && master.onset) return Math.min(1, glow + 0.5);
      return Math.max(0, glow - dt * 2);
    });
    return { ...state, chopGlows: glows, tick };
  }

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

  if (state.scene === "waves") {
    // Each stem's live oscillation, compressed to [min, max] columns and
    // scrolled right-to-left. Pressing FREEZES the flow for inspection
    // (the pointer is held) — release to let the waves run again.
    if (pointer.active) return { ...state, tick };
    const waveColumns = state.waveColumns.map((columns, index) => {
      const waveform = stems[Math.min(index, stems.length - 1)]?.waveform;
      if (waveform === undefined || waveform.length === 0) return columns;
      // Seed from the first sample — an all-positive (or all-negative)
      // signal must report its TRUE extent, not a clamp at zero.
      let min = waveform[0];
      let max = waveform[0];
      for (let i = 1; i < waveform.length; i += 1) {
        const value = waveform[i];
        if (value < min) min = value;
        if (value > max) max = value;
      }
      return [...columns, [min, max] as [number, number]].slice(-WAVES_COLUMNS);
    });
    return { ...state, waveColumns, tick };
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

  const particleCap = limits.particles !== undefined ? Math.max(20, Math.min(2400, Math.round(limits.particles))) : MAX_PARTICLES;
  const spawn = (count: number, stemIndex: number, speed: number) => {
    for (let i = 0; i < count && particles.length < particleCap; i += 1) {
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

// ------------------------------------------------------- music + interaction

/** The reactivity knob: scale a feature set's magnitudes (onsets stay on). */
export function scaleFeatures(features: SpectrumFeatures, gain: number): SpectrumFeatures {
  const g = Math.max(0, gain);
  const clamp = (value: number) => Math.min(1, value * g);
  return {
    ...features,
    rms: clamp(features.rms),
    bands: {
      sub: clamp(features.bands.sub),
      bass: clamp(features.bands.bass),
      lowMid: clamp(features.bands.lowMid),
      mid: clamp(features.bands.mid),
      highMid: clamp(features.bands.highMid),
      treble: clamp(features.bands.treble),
    },
    flux: clamp(features.flux),
  };
}

export const PITCH_CLASS_NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"] as const;

/** "C", "c#", "Db", "Bb" → pitch class 0–11 (null when unparseable). */
export function noteNameToPitchClass(name: string): number | null {
  const match = /^([A-Ga-g])([#bB]?)/.exec(name.trim());
  if (match === null) return null;
  const base = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 }[match[1].toUpperCase() as "C" | "D" | "E" | "F" | "G" | "A" | "B"];
  const accidental = match[2] === "#" ? 1 : match[2] === "b" || match[2] === "B" ? -1 : 0;
  return (base + accidental + 12) % 12;
}

/**
 * Live chroma from a spectrum: energy per pitch class, C..B. Bins from
 * A2 (110 Hz) to C7 (~2093 Hz) are folded onto the 12 classes.
 */
export function detectChroma(spectrum: Uint8Array, opts: { sampleRate: number; fftSize: number }): number[] {
  const binWidthHz = opts.sampleRate / opts.fftSize;
  const chroma = new Array<number>(12).fill(0);
  const fromBin = Math.max(1, Math.floor(110 / binWidthHz));
  const toBin = Math.min(spectrum.length - 1, Math.ceil(2100 / binWidthHz));
  for (let i = fromBin; i <= toBin; i += 1) {
    const hz = i * binWidthHz;
    const midi = 69 + 12 * Math.log2(hz / 440);
    const pitchClass = ((Math.round(midi) % 12) + 12) % 12;
    chroma[pitchClass] += spectrum[i] / 255;
  }
  const max = Math.max(...chroma);
  return max > 0 ? chroma.map((value) => value / max) : chroma;
}

export const CHORD_TEMPLATES: ReadonlyArray<{ quality: string; intervals: readonly number[] }> = [
  { quality: "major", intervals: [0, 4, 7] },
  { quality: "minor", intervals: [0, 3, 7] },
  { quality: "dominant7", intervals: [0, 4, 7, 10] },
  { quality: "minor7", intervals: [0, 3, 7, 10] },
  { quality: "major7", intervals: [0, 4, 7, 11] },
  { quality: "diminished", intervals: [0, 3, 6] },
  { quality: "augmented", intervals: [0, 4, 8] },
];

/**
 * Best-scoring chord for a chroma vector: chord tones must stand above the
 * rest. Returns null when the chroma is too flat to say anything honest.
 */
export function bestChord(chroma: readonly number[]): { rootIndex: number; quality: string } | null {
  if (chroma.length !== 12) return null;
  let best: { rootIndex: number; quality: string; score: number } | null = null;
  for (let root = 0; root < 12; root += 1) {
    for (const template of CHORD_TEMPLATES) {
      const tones = template.intervals.map((interval) => (root + interval) % 12);
      const others = chroma.filter((_, index) => !tones.includes(index));
      const toneMean = tones.reduce((sum, pc) => sum + chroma[pc], 0) / tones.length;
      const otherMean = others.length > 0 ? others.reduce((sum, value) => sum + value, 0) / others.length : 0;
      const score = toneMean - otherMean;
      if (best === null || score > best.score) best = { rootIndex: root, quality: template.quality, score };
    }
  }
  if (best === null || best.score < 0.04) return null;
  return { rootIndex: best.rootIndex, quality: best.quality };
}

/** The circle of fifths, clockwise from C. */
export const FIFTHS_ORDER: readonly number[] = [0, 7, 2, 9, 4, 11, 6, 1, 8, 3, 10, 5];

/** Position on the circle-of-fifths wheel (0–11 clockwise). */
export function fifthsSlot(pitchClass: number): number {
  const slot = FIFTHS_ORDER.indexOf(((pitchClass % 12) + 12) % 12);
  return slot === -1 ? 0 : slot;
}

/** The chord event covering `positionMs` (null when none does). */
export function chordAt(chords: readonly HarmonyChordInput[], positionMs: number): { rootIndex: number; quality: string } | null {
  const covering = chords.find((chord) => positionMs >= chord.startMs && positionMs < chord.endMs);
  if (covering === undefined) return null;
  const rootIndex = covering.root !== null ? noteNameToPitchClass(covering.root) : null;
  return rootIndex === null ? null : { rootIndex, quality: covering.quality };
}

/** Bar index at a playhead (4/4), null when the tempo is unknown. */
export function barIndexAt(positionMs: number, bpm: number | null, beatsPerBar = 4): number | null {
  if (bpm === null || bpm <= 0) return null;
  const barMs = (60_000 / bpm) * beatsPerBar;
  return Math.floor(Math.max(0, positionMs) / barMs);
}

/** True when the beat phase wrapped around (a new beat began). */
export function beatWrap(prevPhase: number | null, nextPhase: number | null): boolean {
  if (prevPhase === null || nextPhase === null) return false;
  return nextPhase < prevPhase;
}

/** Phase within the beat cycle, re-anchored to a manual tap. */
export function tappedBeatPhase(nowMs: number, anchorMs: number, bpm: number): number {
  const interval = 60_000 / bpm;
  const elapsed = Math.max(0, nowMs - anchorMs);
  return (elapsed % interval) / interval;
}

/** Median BPM from tap timestamps (≥3 taps, 30–240 bpm) — null when unclear. */
export function estimateBpmFromTaps(tapsMs: readonly number[]): number | null {
  if (tapsMs.length < 3) return null;
  const intervals: number[] = [];
  for (let i = 1; i < tapsMs.length; i += 1) intervals.push(tapsMs[i] - tapsMs[i - 1]);
  intervals.sort((a, b) => a - b);
  const median = intervals[intervals.length >> 1];
  if (median <= 0) return null;
  const bpm = 60_000 / median;
  return bpm >= 30 && bpm <= 240 ? Math.round(bpm * 10) / 10 : null;
}

/**
 * Lasso-to-isolate: which stems fall inside the drawn stroke. Each stem owns
 * a horizontal band ((i + 0.5) / n — the emitter lanes); a stem is selected
 * when its band center is inside the stroke's bounding box. Fewer than two
 * points selects everything (a click is not a lasso).
 */
export function lassoSelection(stemCount: number, points: readonly { x: number; y: number }[]): boolean[] {
  const selected = Array.from({ length: stemCount }, () => true);
  if (points.length < 2 || stemCount === 0) return selected;
  const minX = Math.min(...points.map((point) => point.x));
  const maxX = Math.max(...points.map((point) => point.x));
  const minY = Math.min(...points.map((point) => point.y));
  const maxY = Math.max(...points.map((point) => point.y));
  return selected.map((_, index) => {
    const center = (index + 0.5) / stemCount;
    return center >= minX && center <= maxX && minY < 1 && maxY > 0;
  });
}

/** Arrangement-layer count per stem (layers attach by instrument prefix). */
export function countLayersByStem(stemTypes: readonly string[], instruments: readonly string[]): number[] {
  return stemTypes.map((stemType) => {
    const base = stemType.split("/")[0];
    return instruments.filter((instrument) => instrument.split("/")[0] === base).length;
  });
}

/** Mean voiced midi within a phrase window (null when nothing voiced). */
export function phraseMeanMidi(
  frames: readonly { timestampMs: number; midiFloat: number | null; voiced: boolean }[],
  startMs: number,
  endMs: number,
): number | null {
  const values = frames.filter(
    (frame) => frame.voiced && frame.midiFloat !== null && frame.timestampMs >= startMs && frame.timestampMs < endMs,
  );
  if (values.length === 0) return null;
  return values.reduce((sum, frame) => sum + (frame.midiFloat ?? 0), 0) / values.length;
}

/** Midi note → vertical position (0.12 low … 0.88 high, clamped). */
export function midiToHeight(midi: number): number {
  const clamped = Math.min(84, Math.max(36, midi));
  return 0.88 - ((clamped - 36) / 48) * 0.76;
}

/** Deterministic circuit layout: stems left, layers mid, master right. */
export function circuitLayout(
  stemCount: number,
  layerCounts: readonly number[],
  width: number,
  height: number,
): { stems: Array<{ x: number; y: number }>; layers: Array<{ x: number; y: number; stemIndex: number }>; master: { x: number; y: number } } {
  const stems = Array.from({ length: stemCount }, (_, index) => ({
    x: width * 0.14,
    y: stemCount > 0 ? height * ((index + 0.5) / stemCount) : height / 2,
  }));
  const layers: Array<{ x: number; y: number; stemIndex: number }> = [];
  for (let index = 0; index < stemCount; index += 1) {
    const count = layerCounts[index] ?? 0;
    for (let layer = 0; layer < count; layer += 1) {
      layers.push({
        x: width * 0.5,
        y: stems[index].y + (layer - (count - 1) / 2) * Math.min(26, height * 0.06),
        stemIndex: index,
      });
    }
  }
  return { stems, layers, master: { x: width * 0.86, y: height / 2 } };
}

/** Chop star layout: angle from pitch class, radius from time, size from confidence. */
export function chopStarLayout(chops: readonly ChopInput[], durationMs: number): Array<{ angle: number; radius: number; size: number }> {
  const span = Math.max(1, durationMs);
  return chops.map((chop) => {
    const pc = ((Math.round(chop.rootMidi) % 12) + 12) % 12;
    return {
      angle: (pc / 12) * Math.PI * 2 + (chop.startMs / span) * 0.5,
      radius: 0.18 + 0.62 * Math.min(1, chop.startMs / span),
      size: 1.5 + chop.confidence * 3.5,
    };
  });
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
  /** How many stems are active (absolute — the helix wants exactly two). */
  activeCount?: number;
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
    activeCount: active.length,
  };
}

export const DIRECTOR_DWELL_MS = 12_000;

export type DirectorOptions = {
  /**
   * Scenes beyond the classic six the director may choose. The component
   * passes the data-gated ones (chords → halo, phrases → lyrics, chops →
   * chopgalaxy) plus helix/circuit/waterfall/beatcity when wanted. Without
   * this, the director behaves exactly as it always did.
   */
  extra?: readonly SceneId[];
  /** The policy whitelist (empty/undefined = every scene allowed). */
  whitelist?: readonly SceneId[];
  /** Dwell override (the director-policy aggressiveness knob). */
  dwellMs?: number;
};

/**
 * The director: pick the scene that fits what the music is doing.
 * Returns null while the current scene should hold (dwell hysteresis).
 *
 *   terrain   — ambient / low energy: the landscape listens patiently
 *   helix     — exactly two stems in dialogue (opt-in)
 *   lyrics    — vocal-led with phrase analysis: the phrase constellation
 *   bloom     — vocal-led: organic growth around the voice
 *   beatcity  — percussive and driving with a bar grid (opt-in)
 *   orbits    — percussive and driving: kinetic bodies
 *   chopgalaxy— vocal cuts over a beat, chop scan present (opt-in)
 *   tide      — dense and mid-heavy: layered bars
 *   circuit   — busy and bright: the signal graph (opt-in)
 *   halo      — harmonic, not percussive, chords available (opt-in)
 *   nebula    — bright and spacious: the particle field
 *   waterfall — layered sustained texture (opt-in)
 *   waves     — sustained textures: the audio waves themselves
 */
export function directScene(
  current: SceneId,
  character: SoundCharacter,
  lastSwitchMs: number,
  nowMs: number,
  opts: DirectorOptions = {},
): { scene: SceneId; reason: string } | null {
  if (nowMs - lastSwitchMs < (opts.dwellMs ?? DIRECTOR_DWELL_MS)) return null;
  const extra = opts.extra ?? [];
  const offered = (scene: SceneId) => extra.includes(scene);
  const allowed = (scene: SceneId) =>
    opts.whitelist === undefined || opts.whitelist.length === 0 || opts.whitelist.includes(scene);

  const rules: ReadonlyArray<{ scene: SceneId; reason: string; when: boolean }> = [
    { scene: "terrain", reason: "quiet, ambient passage — the landscape listens", when: character.energy < 0.08 },
    { scene: "helix", reason: "two stems in dialogue — the helix", when: offered("helix") && character.activeCount === 2 && character.energy > 0.15 },
    { scene: "lyrics", reason: "the voice is singing — the phrase constellation", when: offered("lyrics") && character.vocalDominance > 0.45 && character.percussiveness < 0.5 },
    { scene: "bloom", reason: "the vocals are leading — growing around the voice", when: character.vocalDominance > 0.45 && character.percussiveness < 0.5 },
    { scene: "beatcity", reason: "the beat is building — the city rises", when: offered("beatcity") && character.percussiveness > 0.4 && character.energy > 0.35 },
    { scene: "orbits", reason: "the drums are driving — a kinetic system", when: character.percussiveness > 0.4 && character.energy > 0.35 },
    { scene: "chopgalaxy", reason: "vocal cuts over the beat — the chop galaxy", when: offered("chopgalaxy") && character.vocalDominance > 0.25 && character.percussiveness > 0.3 },
    { scene: "tide", reason: "everything is playing at once — layered tide", when: character.density > 0.7 && character.brightness < 0.45 },
    { scene: "circuit", reason: "the graph is busy — watch the signal flow", when: offered("circuit") && character.density > 0.55 && character.brightness >= 0.45 },
    { scene: "halo", reason: "harmonic movement — the halo turns", when: offered("halo") && character.brightness > 0.35 && character.percussiveness < 0.4 },
    { scene: "nebula", reason: "bright and open — a particle field", when: character.brightness > 0.5 },
    { scene: "waterfall", reason: "layered texture — the spectrum falls", when: offered("waterfall") && character.percussiveness < 0.3 && character.energy > 0.15 && character.density > 0.4 },
    { scene: "waves", reason: "sustained textures — the waves themselves", when: character.percussiveness < 0.3 && character.energy > 0.15 },
  ];

  for (const rule of rules) {
    if (!rule.when) continue;
    if (!allowed(rule.scene)) continue;
    if (current === rule.scene) return null;
    return { scene: rule.scene, reason: rule.reason };
  }
  return null;
}
