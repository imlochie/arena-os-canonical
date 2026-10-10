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
  classifyCharacter,
  createAnalyzerState,
  createScene,
  directScene,
  IDLE_POINTER,
  stepScene,
  TERRAIN_ROWS,
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

  // Every switch carries a human-readable reason.
  for (const character of [ambient, driving, vocalLed, dense, bright]) {
    const decision = directScene("nebula", character, 0, t);
    if (decision !== null) assert.ok(decision.reason.length > 5, "reason present");
  }
});
