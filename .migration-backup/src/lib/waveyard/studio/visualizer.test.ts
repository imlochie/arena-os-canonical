/**
 * Visualizer engine tests — perception, scene evolution, and the director.
 * Spectra are synthetic with known peaks (fftSize 2048 @ 44.1 kHz → bin
 * width ≈ 21.53 Hz), so band placement, centroid, onsets, and beat locks
 * are verified arithmetically. Scenes are checked for determinism and for
 * the interactions they promise (pointer gravity, torque, ripples, blooms).
 */

import assert from "node:assert/strict";
import test from "node:test";

import {
  analyzeSpectrum,
  BAND_NAMES,
  barIndexAt,
  bestChord,
  beatWrap,
  chordAt,
  chopStarLayout,
  circuitLayout,
  classifyCharacter,
  countLayersByStem,
  createAnalyzerState,
  createScene,
  detectChroma,
  directScene,
  estimateBpmFromTaps,
  fifthsSlot,
  IDLE_POINTER,
  lassoSelection,
  midiToHeight,
  noteNameToPitchClass,
  phraseMeanMidi,
  scaleFeatures,
  stepScene,
  tappedBeatPhase,
  TERRAIN_ROWS,
  WATERFALL_COLUMNS,
  CITY_BARS,
  type PointerState,
  type SpectrumFeatures,
  type StemInput,
} from "./visualizer";

const SAMPLE_RATE = 44_100;
const FFT_SIZE = 2048;
const BINS = FFT_SIZE / 2;

function spectrum(): Uint8Array {
  return new Uint8Array(BINS);
}

/** A single spectral peak: value 255 at `hz`, zero everywhere else. */
function peakAt(hz: number): Uint8Array {
  const bins = spectrum();
  const index = Math.round(hz / (SAMPLE_RATE / FFT_SIZE));
  bins[Math.min(bins.length - 1, index)] = 255;
  return bins;
}

/** Fill a frequency range at full level — a real note has bandwidth. */
function fill(fromHz: number, toHz: number): Uint8Array {
  const bins = spectrum();
  const from = Math.max(0, Math.floor(fromHz / (SAMPLE_RATE / FFT_SIZE)));
  const to = Math.min(bins.length - 1, Math.ceil(toHz / (SAMPLE_RATE / FFT_SIZE)));
  for (let i = from; i <= to; i += 1) bins[i] = 255;
  return bins;
}

/** A broad musical attack: energy from low mids up through the presence. */
function attackTone(): Uint8Array {
  return fill(120, 2200);
}

function analyze(bins: Uint8Array, state = createAnalyzerState(), nowMs = 1000) {
  return analyzeSpectrum(bins, state, { sampleRate: SAMPLE_RATE, fftSize: FFT_SIZE, nowMs });
}

function makeFeatures(overrides: Partial<SpectrumFeatures> = {}): SpectrumFeatures {
  return {
    rms: 0.5,
    bands: { sub: 0.1, bass: 0.3, lowMid: 0.2, mid: 0.2, highMid: 0.1, treble: 0.05 },
    centroid: 0.4,
    flux: 0.01,
    onset: false,
    beatPhase: null,
    ...overrides,
  };
}

function stem(stemType: string, overrides: Partial<SpectrumFeatures> = {}): StemInput {
  return { stemType, features: makeFeatures(overrides) };
}

// ------------------------------------------------------------------ perception

test("band energies land where the peaks are", () => {
  // Band edges fall mid-bin, so ADJACENT bands may share one boundary bin —
  // the assertions check dominance + clean FAR bands (the true contract).
  const bass = analyze(fill(70, 240)).features;
  assert.ok(bass.bands.bass > 0.6, `bass-band signal → bass ${bass.bands.bass}`);
  assert.ok(bass.bands.treble < 0.02, "far band stays clean");
  assert.ok(bass.bands.bass > bass.bands.sub, "the target band dominates its neighbor");

  const treble = analyze(fill(4000, 8000)).features;
  assert.ok(treble.bands.treble > 0.4, `treble-band signal → treble ${treble.bands.treble}`);
  assert.ok(treble.bands.bass < 0.02, "far band stays clean");

  const sub = analyze(fill(20, 50)).features;
  assert.ok(sub.bands.sub > 0.5, `sub-band signal → sub ${sub.bands.sub}`);
  assert.ok(sub.bands.treble < 0.02, "far band stays clean");
  assert.ok(sub.bands.sub > sub.bands.bass, "the target band dominates its neighbor");
});

test("spectral centroid tracks the peak position", () => {
  const low = analyze(peakAt(200)).features.centroid;
  const high = analyze(peakAt(8000)).features.centroid;
  assert.ok(high > low + 0.2, `centroid rises with peak (${low} → ${high})`);
  // Single 255-valued peak at bin k → centroid ≈ k / bins.
  const hz = 3000;
  const expected = Math.round(hz / (SAMPLE_RATE / FFT_SIZE)) / BINS;
  const actual = analyze(peakAt(hz)).features.centroid;
  assert.ok(Math.abs(actual - expected) < 0.01, `${actual} ≈ ${expected}`);
});

test("onsets fire on attacks, not on steady tones", () => {
  let state = createAnalyzerState();
  // Steady tone for a while: no onsets after the first rise.
  for (let frame = 0; frame < 12; frame += 1) {
    const result = analyze(attackTone(), state, 1000 + frame * 16);
    state = result.state;
    if (frame > 1) assert.equal(result.features.onset, false, "steady tone must not retrigger");
  }
  // Silence, then an attack: onset fires.
  state = analyze(spectrum(), state, 1200).state;
  const attack = analyze(attackTone(), state, 1400);
  assert.equal(attack.features.onset, true, "silence → tone is an attack");
  assert.ok(attack.features.flux > 0.004);
});

test("beat tracking locks onto a steady onset interval", () => {
  let state = createAnalyzerState();
  let locked: number | null = null;
  let phase: number | null = null;
  for (let beat = 0; beat < 8; beat += 1) {
    const at = 1000 + beat * 500;
    const attack = analyze(attackTone(), state, at);
    state = attack.state;
    const decay = analyze(spectrum(), state, at + 100);
    state = decay.state;
    locked = state.beatIntervalMs;
    phase = attack.features.beatPhase;
  }
  assert.ok(locked !== null, "beat lock acquired");
  assert.ok(Math.abs(locked - 500) < 125, `interval ${locked} ≈ 500ms`);
  assert.ok(phase === null || (phase >= 0 && phase < 1), "phase in [0,1)");
});

// ------------------------------------------------------------------ scenes

test("scenes are deterministic — identical inputs, identical state", () => {
  const stems = [stem("vocals"), stem("drums", { flux: 0.05, onset: true }), stem("bass", { rms: 0.8 })];
  const master = makeFeatures({ onset: true, flux: 0.03 });
  const pointer: PointerState = { x: 0.4, y: 0.6, active: true };
  const run = () => {
    let scene = createScene("nebula", stems.length);
    for (let step = 0; step < 30; step += 1) scene = stepScene(scene, stems, master, 16, pointer);
    return scene;
  };
  assert.deepEqual(run(), run());
});

test("nebula: onsets burst particles; the pointer pulls them in", () => {
  const stems = [stem("drums", { rms: 0.9, flux: 0.08, onset: true })];
  const master = makeFeatures();
  let scene = createScene("nebula", 1);
  for (let step = 0; step < 10; step += 1) scene = stepScene(scene, stems, master, 16, IDLE_POINTER);
  const burstCount = scene.particles.length;
  assert.ok(burstCount > 10, `onset bursts spawned particles (${burstCount})`);

  // A lone particle at (0.9, 0.9), pointer at center: gravity must pull it in.
  let lone = createScene("nebula", 0);
  lone = { ...lone, particles: [{ x: 0.9, y: 0.9, vx: 0, vy: 0, life: 0, maxLife: 10_000, size: 2, stemIndex: 0 }] };
  const pointer: PointerState = { x: 0.5, y: 0.5, active: true };
  const before = Math.hypot(lone.particles[0].x - 0.5, lone.particles[0].y - 0.5);
  for (let step = 0; step < 40; step += 1) lone = stepScene(lone, stems, master, 16, pointer);
  const after = Math.hypot(lone.particles[0].x - 0.5, lone.particles[0].y - 0.5);
  assert.ok(after < before, `pointer gravity pulled the particle in (${before} → ${after})`);
});

test("nebula: particles expire and the field is capped", () => {
  const stems = [stem("drums", { rms: 1, flux: 0.1, onset: true })];
  const master = makeFeatures();
  let scene = createScene("nebula", 1);
  for (let step = 0; step < 400; step += 1) scene = stepScene(scene, stems, master, 32, IDLE_POINTER);
  assert.ok(scene.particles.length <= 600, `cap respected (${scene.particles.length})`);
});

test("terrain: each frame appends a band row, history bounded", () => {
  const master = makeFeatures();
  let scene = createScene("terrain");
  for (let step = 0; step < TERRAIN_ROWS + 40; step += 1) scene = stepScene(scene, [], master, 16, IDLE_POINTER);
  assert.equal(scene.terrain.length, TERRAIN_ROWS);
  assert.equal(scene.terrain[0].length, BAND_NAMES.length);
  // The newest row reflects the current bands.
  assert.deepEqual(scene.terrain[scene.terrain.length - 1], BAND_NAMES.map((band) => master.bands[band]));
});

test("orbits: per-stem energies track their stems; pointer torque spins the system", () => {
  const stems = [stem("vocals", { rms: 0.2 }), stem("drums", { rms: 0.9, flux: 0.06 })];
  const master = makeFeatures();
  let scene = createScene("orbits", 2);
  for (let step = 0; step < 60; step += 1) scene = stepScene(scene, stems, master, 16, IDLE_POINTER);
  assert.ok(scene.orbits[1].energy > scene.orbits[0].energy + 0.3, "the loud stem's body carries more energy");

  // Torque: dragging right (pointer.x = 1) advances angles faster.
  const spin = (pointer: PointerState) => {
    let s = createScene("orbits", 1);
    for (let step = 0; step < 50; step += 1) s = stepScene(s, [stem("drums")], master, 16, pointer);
    return s.orbits[0].angle;
  };
  const idle = spin(IDLE_POINTER);
  const dragged = spin({ x: 1, y: 0.5, active: true });
  assert.ok(dragged > idle, `drag spins the field (${idle} → ${dragged})`);
});

test("tide: an active pointer spawns ripples that age out", () => {
  const master = makeFeatures();
  let scene = createScene("tide");
  const pointer: PointerState = { x: 0.3, y: 0.7, active: true };
  for (let step = 0; step < 12; step += 1) scene = stepScene(scene, [stem("bass")], master, 16, pointer);
  assert.ok(scene.ripples.length > 0, "ripples spawned");
  // Release the pointer and let time pass: ripples age out.
  for (let step = 0; step < 120; step += 1) scene = stepScene(scene, [stem("bass")], master, 16, IDLE_POINTER);
  assert.equal(scene.ripples.length, 0, "ripples expired");
});

test("bloom: onsets grow flowers, vocal-led blooms center, blooms expire", () => {
  const master = makeFeatures({ onset: true, flux: 0.05, centroid: 0.8 });
  const vocalLed = [stem("vocals", { rms: 0.6 }), stem("drums", { rms: 0.1 })];
  let scene = createScene("bloom", 2);
  scene = stepScene(scene, vocalLed, master, 16, IDLE_POINTER);
  assert.equal(scene.blooms.length, 1, "one bloom per onset");
  assert.ok(Math.abs(scene.blooms[0].x - 0.5) < 1e-9, "vocal-led bloom is centered");
  assert.ok(scene.blooms[0].hue > 200, `bright sound → bright hue (${scene.blooms[0].hue})`);

  // Growth advances with time and old blooms are removed.
  for (let step = 0; step < 200; step += 1) scene = stepScene(scene, vocalLed, makeFeatures(), 16, IDLE_POINTER);
  assert.equal(scene.blooms.length, 0, "the bloom expired");

  // Instrument-led onsets bloom off-center.
  let other = createScene("bloom", 2);
  other = stepScene(other, [stem("drums", { rms: 0.7 })], master, 16, IDLE_POINTER);
  assert.ok(other.blooms[0].x !== 0.5 || other.blooms[0].y !== 0.42, "instrument-led bloom is not centered");
});

test("bloom: the pointer plants flowers", () => {
  const master = makeFeatures();
  let scene = createScene("bloom", 1);
  const pointer: PointerState = { x: 0.25, y: 0.75, active: true };
  for (let step = 0; step < 20; step += 1) scene = stepScene(scene, [stem("bass")], master, 16, pointer);
  const planted = scene.blooms.find((bloom) => bloom.x === 0.25 && bloom.y === 0.75);
  assert.ok(planted !== undefined, "a bloom was planted at the pointer");
});

test("waves: each stem's live oscillation becomes bounded [min,max] columns", () => {
  // A full-scale sine over one tap: min ≈ −1, max ≈ +1.
  const sine = new Float32Array(2048);
  for (let i = 0; i < sine.length; i += 1) sine[i] = Math.sin((2 * Math.PI * 12 * i) / sine.length);
  const quiet = new Float32Array(2048).fill(0.05);
  const stems: StemInput[] = [
    { stemType: "vocals", features: makeFeatures(), waveform: sine },
    { stemType: "bass", features: makeFeatures(), waveform: quiet },
  ];
  let scene = createScene("waves", 2);
  for (let step = 0; step < 5; step += 1) scene = stepScene(scene, stems, makeFeatures(), 16, IDLE_POINTER);
  assert.equal(scene.waveColumns[0].length, 5, "a column per frame per stem");
  const [min, max] = scene.waveColumns[0][4];
  assert.ok(min < -0.9 && max > 0.9, `full-scale sine captured (${min}…${max})`);
  const [quietMin, quietMax] = scene.waveColumns[1][4];
  assert.ok(Math.abs(quietMin - 0.05) < 1e-6 && Math.abs(quietMax - 0.05) < 1e-6, "quiet stem captured");

  // Bounded history.
  for (let step = 0; step < 500; step += 1) scene = stepScene(scene, stems, makeFeatures(), 16, IDLE_POINTER);
  assert.ok(scene.waveColumns[0].length <= 180, `bounded (${scene.waveColumns[0].length})`);
});

test("waves: pressing and holding FREEZES the flow", () => {
  const sine = new Float32Array(2048);
  for (let i = 0; i < sine.length; i += 1) sine[i] = Math.sin(i / 32);
  const stems: StemInput[] = [{ stemType: "drums", features: makeFeatures(), waveform: sine }];
  let scene = createScene("waves", 1);
  for (let step = 0; step < 10; step += 1) scene = stepScene(scene, stems, makeFeatures(), 16, IDLE_POINTER);
  const frozenColumns = scene.waveColumns[0].length;
  const lastColumn = scene.waveColumns[0][frozenColumns - 1];

  const hold: PointerState = { x: 0.5, y: 0.5, active: true };
  for (let step = 0; step < 30; step += 1) scene = stepScene(scene, stems, makeFeatures(), 16, hold);
  assert.equal(scene.waveColumns[0].length, frozenColumns, "no columns advance while held");
  assert.deepEqual(scene.waveColumns[0][frozenColumns - 1], lastColumn, "the last column is untouched");

  // Release: the flow resumes.
  scene = stepScene(scene, stems, makeFeatures(), 16, IDLE_POINTER);
  assert.equal(scene.waveColumns[0].length, frozenColumns + 1);
});

test("waves: stems without a waveform tap keep their history", () => {
  const stems: StemInput[] = [{ stemType: "drums", features: makeFeatures() }];
  let scene = createScene("waves", 1);
  scene = stepScene(scene, stems, makeFeatures(), 16, IDLE_POINTER);
  scene = stepScene(scene, stems, makeFeatures(), 16, IDLE_POINTER);
  assert.equal(scene.waveColumns[0].length, 0, "no tap → no columns, no crash");
});

// ------------------------------------------------------------------ director

test("character classification reads the stems honestly", () => {
  const drums = [stem("drums", { rms: 0.9, flux: 0.08 }), stem("bass", { rms: 0.3 })];
  const drumsCharacter = classifyCharacter(drums, makeFeatures({ rms: 0.5, flux: 0.03, centroid: 0.3 }));
  assert.ok(drumsCharacter.percussiveness > 0.5, `percussive ${drumsCharacter.percussiveness}`);
  assert.ok(drumsCharacter.vocalDominance === 0);

  const vocalLed = [stem("vocals", { rms: 0.8 }), stem("drums", { rms: 0.05, flux: 0.005 })];
  const vocalCharacter = classifyCharacter(vocalLed, makeFeatures({ rms: 0.5, centroid: 0.5 }));
  assert.ok(vocalCharacter.vocalDominance > 0.7, `vocal dominance ${vocalCharacter.vocalDominance}`);

  const quiet = classifyCharacter([stem("pad", { rms: 0.01 })], makeFeatures({ rms: 0.02 }));
  assert.ok(quiet.energy < 0.1);
});

test("the director switches content to match the music — after the dwell", () => {
  const ambient = { energy: 0.02, brightness: 0.2, percussiveness: 0.05, vocalDominance: 0.1, density: 0.2 };
  const driving = { energy: 0.7, brightness: 0.4, percussiveness: 0.8, vocalDominance: 0.05, density: 0.8 };
  const vocalLed = { energy: 0.5, brightness: 0.5, percussiveness: 0.1, vocalDominance: 0.8, density: 0.5 };
  const dense = { energy: 0.6, brightness: 0.3, percussiveness: 0.2, vocalDominance: 0.1, density: 0.9 };
  const bright = { energy: 0.5, brightness: 0.8, percussiveness: 0.1, vocalDominance: 0.2, density: 0.5 };

  // Dwell hysteresis: no switch before the dwell elapses.
  assert.equal(directScene("nebula", driving, 0, 5000), null);

  // After the dwell, the scene follows the character.
  const t = 100_000;
  assert.equal(directScene("nebula", driving, 0, t)?.scene, "orbits", "drums driving → Orbits");
  assert.equal(directScene("orbits", driving, 0, t), null, "already matching → no switch event");
  assert.equal(directScene("nebula", ambient, 0, t)?.scene, "terrain", "ambient → Terrain");
  assert.equal(directScene("terrain", vocalLed, 0, t)?.scene, "bloom", "vocal-led → Bloom");
  assert.equal(directScene("bloom", dense, 0, t)?.scene, "tide", "dense and dark → Tide");
  assert.equal(directScene("tide", bright, 0, t)?.scene, "nebula", "bright and open → Nebula");

  // Sustained, mid-density, not bright → the waves themselves.
  const sustained = { energy: 0.45, brightness: 0.35, percussiveness: 0.15, vocalDominance: 0.2, density: 0.5 };
  assert.equal(directScene("nebula", sustained, 0, t)?.scene, "waves", "sustained textures → Waves");
  assert.equal(directScene("waves", sustained, 0, t), null, "already waves → stays");

  // A character nothing matches (mid everything) honestly stays put.
  const middling = { energy: 0.4, brightness: 0.45, percussiveness: 0.35, vocalDominance: 0.2, density: 0.6 };
  assert.equal(directScene("nebula", middling, 0, t), null, "no strong character → no forced switch");

  // Every switch carries a human-readable reason.
  for (const character of [ambient, driving, vocalLed, dense, bright, sustained]) {
    const decision = directScene("nebula", character, 0, t);
    if (decision !== null) assert.ok(decision.reason.length > 5, "reason present");
  }
});

// ------------------------------------------------------------- new scenes

test("helix: beats build rungs; rungs age, drift, and expire; torque twists", () => {
  const master = makeFeatures();
  let scene = createScene("helix", 2);
  // Beat phase wraps 0.9 → 0.1: a new beat.
  scene = stepScene(scene, [stem("vocals"), stem("drums")], { ...master, rms: 0.4 }, 16, IDLE_POINTER, { beatPhaseOverride: 0.9 });
  scene = stepScene(scene, [stem("vocals"), stem("drums")], { ...master, rms: 0.4 }, 16, IDLE_POINTER, { beatPhaseOverride: 0.1 });
  assert.equal(scene.helixRungs.length, 1, "a beat wrap spawns a rung");
  assert.ok(scene.helixRungs[0].glow > 0, "the rung carries glow");

  const rotationBefore = scene.helixRotation;
  for (let step = 0; step < 60; step += 1) scene = stepScene(scene, [stem("vocals"), stem("drums")], master, 32, IDLE_POINTER, { beatPhaseOverride: 0.5 });
  assert.ok(scene.helixRotation > rotationBefore, "the helix turns on its own");
  assert.equal(scene.helixRungs.length, 1, "no wrap, no onset → no extra rungs");

  // Torque: dragging right twists faster.
  const twist = (pointer: PointerState) => {
    let s2 = createScene("helix", 1);
    for (let step = 0; step < 30; step += 1) s2 = stepScene(s2, [stem("drums")], master, 16, pointer);
    return s2.helixRotation;
  };
  assert.ok(twist({ x: 1, y: 0.5, active: true }) > twist(IDLE_POINTER), "pointer torque twists the helix");

  // Rungs expire with age.
  for (let step = 0; step < 200; step += 1) scene = stepScene(scene, [stem("vocals"), stem("drums")], master, 32, IDLE_POINTER);
  assert.equal(scene.helixRungs.length, 0, "rungs expired");
});

test("waterfall: per-stem band columns fall, bounded; hold freezes", () => {
  const stems = [stem("vocals", { rms: 0.6 }), stem("bass", { rms: 0.2 })];
  const master = makeFeatures();
  let scene = createScene("waterfall", 2);
  for (let step = 0; step < 5; step += 1) scene = stepScene(scene, stems, master, 16, IDLE_POINTER);
  assert.equal(scene.waterfallColumns[0].length, 5, "a column per frame per stem");
  assert.equal(scene.waterfallColumns[0][4].length, BAND_NAMES.length, "each column holds the 6 bands");
  assert.ok(scene.waterfallColumns[0][4][1] > 0, "the bass band value landed");

  for (let step = 0; step < 500; step += 1) scene = stepScene(scene, stems, master, 16, IDLE_POINTER);
  assert.equal(scene.waterfallColumns[0].length, WATERFALL_COLUMNS, "history bounded");

  const hold: PointerState = { x: 0.5, y: 0.5, active: true };
  const before = scene.waterfallColumns[0].length;
  for (let step = 0; step < 20; step += 1) scene = stepScene(scene, stems, master, 16, hold);
  assert.equal(scene.waterfallColumns[0].length, before, "hold freezes the fall");
});

test("beatcity: the playing bar's height follows the level; bars decay slowly", () => {
  const master = makeFeatures({ rms: 0.6 });
  let scene = createScene("beatcity", 4);
  scene = stepScene(scene, [stem("drums")], master, 16, IDLE_POINTER, { positionMs: 0, bpm: 120 });
  const barZeroHeight = scene.cityHeights[0];
  assert.ok(barZeroHeight > 0.3, `bar 0 lit (${barZeroHeight})`);

  // 120 bpm → 2000 ms/bar: bar 1 at 2500 ms.
  scene = stepScene(scene, [stem("drums")], master, 16, IDLE_POINTER, { positionMs: 2500, bpm: 120 });
  assert.ok(scene.cityHeights[1] > 0.3, "bar 1 lit");
  assert.ok(scene.cityHeights[1] > scene.cityHeights[2], "the future bar is dark");
  assert.ok(scene.cityHeights[0] <= barZeroHeight + 1e-9, "the past bar keeps (or decays below) its peak");

  // Without a tempo the city is honest: nothing changes but the decay.
  const heights = [...scene.cityHeights];
  scene = stepScene(scene, [stem("drums")], master, 16, IDLE_POINTER, { positionMs: 2500, bpm: null });
  assert.equal(scene.cityLastBar, 1, "cursor unchanged without a tempo");
  assert.ok(heights.every((height, index) => scene.cityHeights[index] <= height), "no growth without a tempo");
});

test("halo: chroma smooths toward the live vector; chord changes sweep", () => {
  const chroma = new Array<number>(12).fill(0);
  chroma[9] = 1; // A
  chroma[0] = 0.6; // C#
  chroma[4] = 0.7; // E
  const master = makeFeatures();
  let scene = createScene("halo", 1);
  for (let step = 0; step < 60; step += 1) scene = stepScene(scene, [stem("vocals")], master, 16, IDLE_POINTER, { chroma });
  assert.ok(scene.haloChroma[9] > 0.9, `chroma approached the target (${scene.haloChroma[9]})`);
  assert.ok(scene.haloChroma[8] < 0.01, "absent classes stay near zero");

  // The analysed chord drives the root; a root change sweeps.
  scene = stepScene(scene, [stem("vocals")], master, 16, IDLE_POINTER, {
    chroma,
    chords: [{ startMs: 0, endMs: 10_000, root: "A", quality: "major" }],
    positionMs: 5000,
  });
  assert.equal(scene.haloLastRoot, 9, "root A lit");
  scene = stepScene(scene, [stem("vocals")], master, 16, IDLE_POINTER, {
    chroma,
    chords: [{ startMs: 0, endMs: 10_000, root: "A", quality: "major" }, { startMs: 10_000, endMs: 20_000, root: "D", quality: "major" }],
    positionMs: 15_000,
  });
  assert.equal(scene.haloLastRoot, 2, "modulation to D");
  assert.ok(scene.haloSweep !== null, "the sweep fired");
  for (let step = 0; step < 80; step += 1) scene = stepScene(scene, [stem("vocals")], master, 16, IDLE_POINTER, { chroma, positionMs: 15_000, chords: [{ startMs: 10_000, endMs: 20_000, root: "D", quality: "major" }] });
  assert.equal(scene.haloSweep, null, "the sweep expired");
});

test("circuit: the current flows faster when the master is louder", () => {
  const master = makeFeatures({ rms: 0.8 });
  let scene = createScene("circuit", 3);
  for (let step = 0; step < 30; step += 1) scene = stepScene(scene, [stem("drums")], master, 16, IDLE_POINTER);
  const fast = scene.circuitPulse;
  let quiet = createScene("circuit", 3);
  for (let step = 0; step < 30; step += 1) quiet = stepScene(quiet, [stem("drums")], makeFeatures({ rms: 0.02 }), 16, IDLE_POINTER);
  assert.ok(fast > quiet.circuitPulse * 1.5, `loud flows faster (${fast} vs ${quiet.circuitPulse})`);
});

test("lyrics: the active phrase glows and the rest dim; no phrases is a no-op", () => {
  const master = makeFeatures();
  const phrases = [
    { startMs: 0, endMs: 1000, midi: 60 },
    { startMs: 1000, endMs: 2000, midi: 64 },
  ];
  let scene = createScene("lyrics", 1);
  for (let step = 0; step < 20; step += 1) scene = stepScene(scene, [stem("vocals")], master, 32, IDLE_POINTER, { phrases, positionMs: 500 });
  assert.ok(scene.phraseGlows[0] > 0.8, `active phrase lit (${scene.phraseGlows[0]})`);
  assert.equal(scene.phraseGlows[1], 0, "future phrase dark");
  for (let step = 0; step < 60; step += 1) scene = stepScene(scene, [stem("vocals")], master, 32, IDLE_POINTER, { phrases, positionMs: 999_999 });
  assert.ok(scene.phraseGlows[0] < 0.1, "the phrase faded");
  // No phrase data: no crash, glows empty.
  scene = stepScene(scene, [stem("vocals")], master, 16, IDLE_POINTER, {});
  assert.equal(scene.phraseGlows.length, 0);
});

test("chopgalaxy: chops light inside their window and spark on nearby onsets", () => {
  const master = makeFeatures({ onset: true, flux: 0.05 });
  const chops = [
    { startMs: 1000, durationMs: 400, rootMidi: 60, confidence: 0.9 },
    { startMs: 5000, durationMs: 400, rootMidi: 64, confidence: 0.8 },
  ];
  let scene = createScene("chopgalaxy", 1);
  for (let step = 0; step < 10; step += 1) scene = stepScene(scene, [stem("vocals")], master, 32, IDLE_POINTER, { chops, positionMs: 1200 });
  assert.ok(scene.chopGlows[0] > 0.7, `the playing chop lit (${scene.chopGlows[0]})`);
  assert.equal(scene.chopGlows[1], 0, "the far chop stays dark");
  // Near (but not inside) + onset → a spark.
  scene = stepScene(scene, [stem("vocals")], master, 16, IDLE_POINTER, { chops, positionMs: 4400 });
  assert.ok(scene.chopGlows[1] > 0, "a nearby onset sparked the chop");
});

// --------------------------------------------------- music + interaction

test("scaleFeatures scales magnitudes and preserves events", () => {
  const features = makeFeatures({ rms: 0.4, flux: 0.05, onset: true, beatPhase: 0.3 });
  const boosted = scaleFeatures(features, 2);
  assert.ok(Math.abs(boosted.rms - 0.8) < 1e-9, "rms scales");
  assert.equal(boosted.onset, true, "onset preserved");
  assert.equal(boosted.beatPhase, 0.3, "phase preserved");
  const clamped = scaleFeatures(features, 10);
  assert.ok(clamped.rms <= 1 && clamped.bands.bass <= 1, "values clamp at 1");
  const zeroed = scaleFeatures(features, 0);
  assert.equal(zeroed.rms, 0, "gain 0 silences");
});

test("detectChroma folds spectrum peaks onto pitch classes", () => {
  // A4 = 440 Hz → class 9; C5 ≈ 523.25 Hz → class 0.
  const a = detectChroma(peakAt(440), { sampleRate: SAMPLE_RATE, fftSize: FFT_SIZE });
  let maxClass = 0;
  for (let i = 1; i < 12; i += 1) if (a[i] > a[maxClass]) maxClass = i;
  assert.equal(maxClass, 9, "A4 dominates class A");
  const c = detectChroma(peakAt(523.25), { sampleRate: SAMPLE_RATE, fftSize: FFT_SIZE });
  maxClass = 0;
  for (let i = 1; i < 12; i += 1) if (c[i] > c[maxClass]) maxClass = i;
  assert.equal(maxClass, 0, "C5 dominates class C");
  const silence = detectChroma(spectrum(), { sampleRate: SAMPLE_RATE, fftSize: FFT_SIZE });
  assert.ok(silence.every((value) => value === 0), "silence → all-zero chroma");
});

test("bestChord names triads and stays quiet on flat chroma", () => {
  const aMajor = new Array<number>(12).fill(0.05);
  aMajor[9] = 1; aMajor[1] = 0.8; aMajor[4] = 0.9; // A C# E
  const chord = bestChord(aMajor);
  assert.deepEqual(chord, { rootIndex: 9, quality: "major" }, "A major detected");

  const flat = new Array<number>(12).fill(0.5);
  assert.equal(bestChord(flat), null, "no chord without contrast");
  assert.equal(bestChord([0.1, 0.2]), null, "malformed chroma rejected");
});

test("fifths + chord lookup + bars + beats + taps", () => {
  assert.equal(noteNameToPitchClass("C"), 0);
  assert.equal(noteNameToPitchClass("Db"), 1);
  assert.equal(noteNameToPitchClass("A#"), 10);
  assert.equal(noteNameToPitchClass("H"), null);

  assert.equal(fifthsSlot(0), 0, "C at 12 o'clock");
  assert.equal(fifthsSlot(7), 1, "G one step clockwise");
  assert.equal(fifthsSlot(5), 11, "F one step counter-clockwise");

  const chords = [{ startMs: 0, endMs: 1000, root: "F#", quality: "minor7" }, { startMs: 1000, endMs: 2000, root: null, quality: "major" }];
  assert.deepEqual(chordAt(chords, 500), { rootIndex: 6, quality: "minor7" });
  assert.equal(chordAt(chords, 1500), null, "null root is honestly unusable");
  assert.equal(chordAt(chords, 9999), null, "outside every window");

  assert.equal(barIndexAt(0, 120), 0);
  assert.equal(barIndexAt(1999, 120), 0);
  assert.equal(barIndexAt(2000, 120), 1, "120 bpm → 2000 ms bars");
  assert.equal(barIndexAt(1000, null), null, "no tempo → no bars");

  assert.equal(beatWrap(null, 0.5), false);
  assert.equal(beatWrap(0.2, 0.5), false);
  assert.equal(beatWrap(0.9, 0.1), true, "the wrap is a new beat");

  assert.equal(tappedBeatPhase(250, 0, 120), 0.5, "half a beat at 120 bpm");
  assert.equal(tappedBeatPhase(1000, 0, 120), 0, "two whole beats wrap to 0");
  assert.equal(estimateBpmFromTaps([0, 500, 1000]), 120, "500 ms taps → 120 bpm");
  assert.equal(estimateBpmFromTaps([0, 100]), null, "too few taps");
  assert.equal(estimateBpmFromTaps([0, 10, 20]), null, "machine-gun taps rejected");
});

test("lasso selection takes the stems inside the stroke's span", () => {
  const points = [{ x: 0.1, y: 0.2 }, { x: 0.45, y: 0.8 }];
  const selected = lassoSelection(4, points);
  assert.deepEqual(selected, [true, true, false, false], "stems 0 and 1 inside");

  const click = [{ x: 0.3, y: 0.5 }];
  assert.deepEqual(lassoSelection(4, click), [true, true, true, true], "a click is not a lasso");
  assert.deepEqual(lassoSelection(0, points), [], "no stems, no selection");
});

test("layer counts, phrase pitch, midi heights, layouts", () => {
  assert.deepEqual(countLayersByStem(["vocals", "drums"], ["drums", "drums/extra", "bass"]), [0, 2]);

  const frames = [
    { timestampMs: 0, midiFloat: 60, voiced: true },
    { timestampMs: 100, midiFloat: 64, voiced: true },
    { timestampMs: 200, midiFloat: 67, voiced: false },
  ];
  assert.equal(phraseMeanMidi(frames, 0, 200), 62, "only voiced frames inside the window count");
  assert.equal(phraseMeanMidi(frames, 500, 900), null, "empty window → null");

  assert.equal(midiToHeight(36), 0.88, "low notes sit low");
  assert.equal(midiToHeight(84), 0.12, "high notes sit high");
  assert.equal(midiToHeight(12), 0.88, "below range clamps");
  assert.equal(midiToHeight(120), 0.12, "above range clamps");

  const layout = circuitLayout(2, [0, 2], 800, 400);
  assert.equal(layout.stems.length, 2);
  assert.equal(layout.layers.length, 2, "two layers on the second stem");
  assert.ok(layout.layers.every((layer) => layer.stemIndex === 1));
  assert.ok(layout.master.x > layout.stems[0].x, "master sits right");

  const stars = chopStarLayout([{ startMs: 0, durationMs: 400, rootMidi: 60, confidence: 0.5 }, { startMs: 5000, durationMs: 400, rootMidi: 72, confidence: 1 }], 10_000);
  assert.ok(Math.abs((stars[1].angle - stars[0].angle) - 0.25) < 1e-9, "same pitch class, later time → the time spiral offsets the angle");
  assert.ok(stars[1].radius > stars[0].radius, "later chops sit further out");
  assert.ok(stars[1].size > stars[0].size, "confidence sizes the star");
});

// --------------------------------------------------- director extensions

test("the director stays classic without extra scenes, and honors policy", () => {
  const t = 100_000;
  // Middling music with no extras: unchanged — stays put.
  const middling = { energy: 0.4, brightness: 0.45, percussiveness: 0.35, vocalDominance: 0.2, density: 0.6 };
  assert.equal(directScene("nebula", middling, 0, t, { extra: [] }), null, "no data-gated scenes offered → stays");

  // With circuit offered, busy-and-bright music goes to the graph.
  assert.equal(directScene("nebula", middling, 0, t, { extra: ["circuit"] })?.scene, "circuit", "busy + bright → circuit");

  // The whitelist overrides taste: circuit banned → fall through to nebula.
  const brightBusy = { energy: 0.4, brightness: 0.8, percussiveness: 0.35, vocalDominance: 0.2, density: 0.6 };
  assert.equal(directScene("terrain", brightBusy, 0, t, { extra: ["circuit"], whitelist: ["nebula", "terrain"] })?.scene, "nebula", "whitelist bans circuit → nebula");

  // Dwell policy: an impatient director switches sooner.
  const driving = { energy: 0.7, brightness: 0.4, percussiveness: 0.8, vocalDominance: 0.05, density: 0.8 };
  assert.equal(directScene("nebula", driving, 0, 5000, { dwellMs: 4000 })?.scene, "orbits", "short dwell switches at 5 s");
  assert.equal(directScene("nebula", driving, 0, 5000), null, "default dwell still holds at 5 s");

  // The helix wants exactly two stems in dialogue.
  const dialogue = { energy: 0.5, brightness: 0.4, percussiveness: 0.2, vocalDominance: 0.3, density: 0.5, activeCount: 2 };
  assert.equal(directScene("nebula", dialogue, 0, t, { extra: ["helix"] })?.scene, "helix", "two active stems → helix");
  assert.notEqual(directScene("nebula", { ...dialogue, activeCount: 3 }, 0, t, { extra: ["helix"] })?.scene, "helix", "three stems is not a dialogue (it may honestly match another rule)");
});
