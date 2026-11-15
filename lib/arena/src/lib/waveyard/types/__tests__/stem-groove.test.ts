import assert from "node:assert/strict";
import test from "node:test";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { assessPerformancePhase, measureStemGroove, compareStemGrooves, proposeGrooveEntryShift, type GrooveOnset } from "../stem-groove";
import { planMashup, renderMashupWithBus, type MashupSourceProfile } from "../../studio/mashup";
import { encodeWav16 } from "../../mixer/synth";
import { ANALYSIS_PCM_RATE, detectDrumTransients, detectSpectralAttacks } from "../../worker-local/analysis-engine";

const grid = Array.from({ length: 25 }, (_, i) => i * 500);
function events(phases: number[], delay = 0): GrooveOnset[] {
  return grid.slice(0, -1).flatMap((at) => phases.map((phase) => ({
    timestampMs: at + phase * 500 + delay, strength: phase === 0 ? 1 : 0.7, confidence: 0.95,
  })));
}
const profile = (role: string, phases: number[], delay = 0) =>
  measureStemGroove(role, events(phases, delay), grid, 0.95);
const timeline = { bedRatio: 1, donorRatio: 1, sourceOffsetMs: 0, entryMs: 0, endMs: 12000 };

test("independent straight and swung eighth timing is measured, not inferred from BPM", () => {
  const straight = profile("drums", [0, 0.5]);
  const swung = profile("bass", [0, 2 / 3]);
  assert.equal(straight.status, "measured");
  assert.equal(swung.status, "measured");
  if (straight.status !== "measured" || swung.status !== "measured") return;
  assert.ok(Math.abs(straight.swing!.ratio - 1) < 0.001);
  assert.ok(Math.abs(swung.swing!.ratio - 2) < 0.001);
  assert.equal(compareStemGrooves(straight, profile("bass", [0, 0.5])).relationship, "similar-feel");
  assert.equal(compareStemGrooves(straight, swung).relationship, "rhythmic-contrast");
  assert.equal(compareStemGrooves(swung, straight).relationship, "rhythmic-contrast");
  assert.equal(compareStemGrooves(swung, profile("bass", [0, 0.75])).relationship, "rhythmic-contrast");
  assert.equal(proposeGrooveEntryShift(straight, swung, timeline).shiftMs, 0);
});

test("subdivisions, syncopation and variable feel do not manufacture swing evidence", () => {
  const sixteenths = profile("bass", [0, 0.25, 0.5, 0.75]);
  assert.equal(sixteenths.status, "measured");
  if (sixteenths.status !== "measured") return;
  assert.equal(sixteenths.subdivision, "sixteenth-evidence");
  assert.equal(sixteenths.swing, null);
  const syncopated = profile("bass", [0.25, 0.75]);
  assert.equal(proposeGrooveEntryShift(profile("drums", [0]), syncopated, timeline).shiftMs, 0);
  const variable = measureStemGroove("bass", events([0, 0.5]).map((event, index) =>
    index % 4 === 1 ? { ...event, timestampMs: event.timestampMs + 80 } : event), grid, 0.95);
  assert.equal(variable.status, "measured");
  if (variable.status === "measured") assert.equal(variable.swing, null);
});

test("stable small phase errors earn a bounded translation without moving offbeat phrases", () => {
  const anchor = profile("bass", [0, 0.5]);
  const delayed = profile("drums", [0, 0.5], 20);
  const correction = proposeGrooveEntryShift(anchor, delayed, timeline);
  assert.equal(correction.shiftMs, -20);
  assert.ok(correction.comparedOnsets >= 16);
  assert.ok(correction.beforeErrorMs! >= 19);
  assert.ok(correction.afterErrorMs! < 1);
  assert.equal(proposeGrooveEntryShift(anchor, profile("vocals", [0.25, 0.75]), timeline).shiftMs, 0);
  assert.equal(proposeGrooveEntryShift(anchor, delayed, { ...timeline, donorRatio: 1.2 }).shiftMs, 0);
  const weak = measureStemGroove("drums", events([0, 0.5], 20), grid, 0.6);
  assert.equal(weak.status, "unavailable");
  assert.equal(proposeGrooveEntryShift(anchor, weak, timeline).shiftMs, 0);
  assert.equal(measureStemGroove("bass", [], grid, 0.95).status, "unavailable");
  assert.equal(measureStemGroove("bass", events([0]), [0, 500, 500, 1000], 0.95).status, "unavailable");
});

test("production onset extraction carries straight/swing evidence from PCM", () => {
  for (const [offbeat, expectedRatio] of [[0.5, 1], [2 / 3, 2]] as const) {
    const pcm = new Float32Array(12 * ANALYSIS_PCM_RATE);
    for (const event of events([0, offbeat], 40)) {
      const start = Math.round(event.timestampMs / 1000 * ANALYSIS_PCM_RATE);
      for (let frame = 0; frame < 400 && start + frame < pcm.length; frame++)
        pcm[start + frame] = 0.5 * Math.exp(-frame / 80) * Math.sin(frame * Math.PI * 2 * 900 / ANALYSIS_PCM_RATE);
    }
    const extracted = detectSpectralAttacks(pcm);
    assert.deepEqual(detectDrumTransients(pcm), extracted.map((event) => ({ ...event, rhythmicClass: null })),
      "sharing the attack extractor must not regress the existing drum detector");
    const measured = measureStemGroove("drums", extracted, grid, 0.95);
    assert.equal(measured.status, "measured");
    if (measured.status !== "measured") continue;
    assert.ok(measured.swing, `isolated PCM eighths must supply paired onset evidence (${JSON.stringify(measured)})`);
    assert.ok(Math.abs(measured.swing.ratio - expectedRatio) < 0.25,
      `onset-window resolution must not reverse straight/swing evidence (${measured.swing.ratio})`);
  }
});

test("vocal performance comparison preserves offbeats rather than snapping them to beats", () => {
  const intervals = [250, 1250, 2250, 3250].map((startMs) => ({ startMs, endMs: startMs + 150, confidence: 0.95 }));
  const timing = { sourceFromMs: 0, sourceToMs: 5000, entryMs: 2000, stretchRatio: 1, proposedShiftMs: 30 };
  const measured = assessPerformancePhase(intervals, grid, grid, timing);
  assert.equal(measured.status, "measured");
  assert.equal(measured.sourceOffbeatFraction, 1);
  assert.equal(measured.beforeErrorMs, 0);
  assert.ok(Math.abs(measured.afterErrorMs! - 30) < 0.001);
  assert.equal(measured.preserveEntry, true);
  const beatSnap = assessPerformancePhase(intervals, grid, grid, { ...timing, proposedShiftMs: -250 });
  assert.equal(beatSnap.preserveEntry, true, "do not treat a half-beat pickup as a timing mistake");
  const repair = assessPerformancePhase(intervals, grid, grid, { ...timing, entryMs: 2030, proposedShiftMs: -30 });
  assert.equal(repair.preserveEntry, false);
  assert.ok(repair.afterErrorMs! < repair.beforeErrorMs!);
  assert.equal(assessPerformancePhase([], grid, grid, timing).status, "unavailable");
  assert.equal(assessPerformancePhase(intervals.map((interval) => ({ ...interval, confidence: 0.4 })), grid, grid, timing).status, "unavailable");
  assert.equal(assessPerformancePhase(intervals, null, grid, timing).status, "unavailable");
  const transformed = assessPerformancePhase(intervals, grid, grid.map((at) => at * 1.1), {
    ...timing, entryMs: 2200, stretchRatio: 1.1,
  });
  assert.ok(transformed.beforeErrorMs! < 0.001, "tempo changes must preserve the original expressive beat phase");
  assert.equal(transformed.preserveEntry, true);
});

test("melodic layer attacks participate without being classified as drums or notes", () => {
  const attacks = profile("other", [0.25, 0.75], 20);
  assert.equal(attacks.status, "measured");
  assert.equal(attacks.role, "other");
  if (attacks.status === "measured") assert.equal(attacks.swing, null);
  const anchor = profile("drums", [0.25, 0.75]);
  assert.equal(proposeGrooveEntryShift(anchor, attacks, timeline).shiftMs, -20);
  assert.equal(proposeGrooveEntryShift(profile("drums", [0]), attacks, timeline).shiftMs, 0,
    "do not force a melodic offbeat pattern onto kick-like attacks");
});

test("a percussion proposal cannot override source-relative vocal delivery", () => {
  const bass = measureStemGroove("bass", events([0, 0.5]).map((event) =>
    ({ ...event, timestampMs: event.timestampMs + 2000 })), grid.map((at) => at + 2000), 0.95);
  const melodic = profile("other", [0, 0.5], 30);
  const vocals = source("vocals", {
    beatGridMs: grid, beatConfidence: 0.95, stemGrooves: [melodic],
    vocalActivityIntervals: [250, 1250, 2250, 3250, 4250, 5250, 6250, 7250].map((startMs) =>
      ({ startMs, endMs: startMs + 150, confidence: 0.95 })),
  });
  // Align the target reference to the unchanged whole-body baseline, not an
  // already corrected candidate. The human events themselves remain untouched.
  const initial = planMashup({ ...vocals, stemGrooves: undefined }, source("instrumental"), { strategy: "continuous" });
  assert.ok(initial.ok);
  const first = initial.plan.segments[0]!;
  const offset = first.mashupStartMs - first.vocalsFromMs;
  const targetGrid = grid.map((at) => at + offset);
  const result = planMashup(vocals, source("instrumental", {
    beatGridMs: targetGrid, beatConfidence: 0.95, stemGrooves: [bass],
  }), { strategy: "continuous" });
  assert.ok(result.ok);
  assert.equal(result.plan.crossStemGroove?.appliedEntryShiftMs, 0);
  assert.ok(result.plan.crossStemGroove?.performanceProtection.some((assessment) => assessment.preserveEntry),
    JSON.stringify(result.plan.crossStemGroove));
});

function source(role: "vocals" | "instrumental", overrides: Partial<MashupSourceProfile> = {}): MashupSourceProfile {
  return { role, durationMs: role === "vocals" ? 10000 : 16000, bpm: 120, bpmConfidence: 0.95,
    musicalKey: null, sections: [], ...overrides };
}

test("planner moves the complete donor group, preserves source measurements, and leaves safe fallbacks", async () => {
  // Bed events appear at 2s+; donor source starts at zero with a 20ms delay.
  const bedGroove = measureStemGroove("bass", events([0, 0.5]).map((event) =>
    ({ ...event, timestampMs: event.timestampMs + 2000 })), grid.map((at) => at + 2000), 0.95);
  const donorGroove = profile("drums", [0, 0.5], 20);
  const bed = source("instrumental", { stemGrooves: [bedGroove] });
  const vocals = source("vocals", { stemGrooves: [donorGroove] });
  const original = JSON.stringify({ vocals, bed });
  const baseline = planMashup({ ...vocals, stemGrooves: undefined }, { ...bed, stemGrooves: undefined }, { strategy: "continuous" });
  const adapted = planMashup(vocals, bed, { strategy: "continuous" });
  assert.ok(baseline.ok && adapted.ok);
  assert.equal(JSON.stringify({ vocals, bed }), original);
  assert.equal(adapted.plan.crossStemGroove?.appliedEntryShiftMs, -20);
  assert.equal(adapted.plan.segments[0]!.mashupStartMs, baseline.plan.segments[0]!.mashupStartMs - 20);
  assert.equal(adapted.plan.segments[0]!.vocalsFromMs, baseline.plan.segments[0]!.vocalsFromMs);
  assert.equal(adapted.plan.vocalsStretchRatio, baseline.plan.vocalsStretchRatio);
  const contrast = planMashup({ ...vocals, stemGrooves: [profile("drums", [0, 2 / 3])] }, bed, { strategy: "continuous" });
  assert.ok(contrast.ok);
  assert.equal(contrast.plan.crossStemGroove?.appliedEntryShiftMs, 0);
  const conflict = planMashup({ ...vocals, stemGrooves: [donorGroove, profile("bass", [0, 0.5], -20)] }, bed, { strategy: "continuous" });
  assert.ok(conflict.ok);
  assert.equal(conflict.plan.crossStemGroove?.appliedEntryShiftMs, 0);
  const boundary = planMashup({ ...vocals, durationMs: 14000, stemGrooves: [profile("drums", [0, 0.5], -20)] }, bed, { strategy: "continuous" });
  assert.ok(boundary.ok);
  assert.equal(boundary.plan.crossStemGroove?.appliedEntryShiftMs, 0,
    "do not move a full-length phrase past the arrangement end");
  const rate = 44100;
  function clicks(onsets: GrooveOnset[], seconds: number, frequency: number) {
    const pcm = new Float32Array(seconds * rate * 2);
    for (const onset of onsets) for (let i = 0; i < 500; i++) {
      const frame = Math.round(onset.timestampMs / 1000 * rate) + i;
      if (frame * 2 + 1 >= pcm.length) break;
      const sample = 0.12 * Math.exp(-i / 120) * Math.sin(i * Math.PI * 2 * frequency / rate);
      pcm[frame * 2] = sample; pcm[frame * 2 + 1] = sample;
    }
    return pcm;
  }
  const input = {
    vocals: new Float32Array(10000 / 1000 * rate * 2),
    bed: clicks(events([0, 0.5]).map((event) => ({ ...event, timestampMs: event.timestampMs + 2000 })), 16, 80),
    stems: new Map([["donor_drums", clicks(events([0, 0.5], 20), 10, 600)]]),
    layerStemTypes: ["drums"], sampleRate: rate, mix: { matchVocalLoudness: false, limit: false },
  };
  const before = renderMashupWithBus(baseline.plan, input).pcm;
  const after = renderMashupWithBus(adapted.plan, input).pcm;
  // Inside the phrase, away from its fades, the bed duck is identical.
  const expectedFrame = Math.round((adapted.plan.segments[0]!.mashupStartMs + 500 + 20) / 1000 * rate);
  let changedPower = 0;
  for (let frame = expectedFrame; frame < expectedFrame + 1000; frame++)
    changedPower += (before[frame * 2]! - after[frame * 2]!) ** 2;
  assert.ok(changedPower > 0.01, "the rendered donor must actually move, not only its metadata");
  const output = process.env.WAVEYARD_GROOVE_ARTIFACT_DIR;
  if (output) {
    await mkdir(output, { recursive: true });
    await writeFile(join(output, "synthetic-groove-before.wav"), encodeWav16(before, rate));
    await writeFile(join(output, "synthetic-groove-after.wav"), encodeWav16(after, rate));
    await writeFile(join(output, "decision.json"), JSON.stringify(adapted.plan.crossStemGroove, null, 2));
  }
});
