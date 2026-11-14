/**
 * Mix-bus regressions.
 *
 * Every assertion here is about a defect that was audible in a rendered
 * mashup and is now pinned by a fixture:
 *
 *   1. Donor stems used to be summed unconditionally (two rhythm sections).
 *   2. Donor stems used to be indexed from timeline zero, so a vocal that
 *      entered at 20 s was accompanied by a second band that started at 0 s.
 *   3. The mix used to be hard-clamped at full scale instead of limited.
 *   4. Vocal and bed were summed at unity with no reference to their
 *      relative loudness.
 *
 * These are signal-level tests. They do not claim that any of this sounds
 * better; only that the mixing behaviour is now the intended one.
 */
import assert from "node:assert/strict";
import test from "node:test";
import {
  planMashup,
  renderMashupWithBus,
  type MashupSourceProfile,
} from "./mashup";
import { MASHUP_MAX_BALANCE_CORRECTION_DB, measurePresentLoudness, planMashupBalance } from "./mashup-mix-bus";
import { measureLoudness, samplePeak } from "../mixer/meters";
import { InstrumentalBedError, sumInstrumentalStems } from "./mashup-bed";

const RATE = 44_100;

function section(label: string, startMs: number, endMs: number) {
  return { label, startMs, endMs };
}

function profile(overrides: Partial<MashupSourceProfile>): MashupSourceProfile {
  return {
    role: "instrumental",
    bpm: null,
    bpmConfidence: null,
    musicalKey: null,
    keyConfidence: null,
    durationMs: 12_000,
    sections: [],
    ...overrides,
  };
}

function plan() {
  const result = planMashup(
    profile({ role: "vocals", bpm: 100, durationMs: 12_000, sections: [section("verse", 0, 12_000)] }),
    profile({ bpm: 100, durationMs: 12_000, sections: [section("verse", 0, 12_000)] }),
  );
  assert.ok(result.ok);
  return result.plan;
}

/** A tone with the given amplitude, so a stem's presence is unambiguous. */
function tone(seconds: number, frequency: number, amplitude: number): Float32Array {
  const frames = Math.round(seconds * RATE);
  const out = new Float32Array(frames * 2);
  for (let frame = 0; frame < frames; frame += 1) {
    const value = amplitude * Math.sin((2 * Math.PI * frequency * frame) / RATE);
    out[frame * 2] = value;
    out[frame * 2 + 1] = value;
  }
  return out;
}

function silence(seconds: number): Float32Array {
  return new Float32Array(Math.round(seconds * RATE) * 2);
}

test("default composition does not add donor stems: vocal donor + instrumental bed only", () => {
  const mashed = plan();
  const donorStems = new Map<string, Float32Array>([
    ["donor_drums", tone(12, 90, 0.5)],
    ["donor_bass", tone(12, 60, 0.5)],
    ["donor_other", tone(12, 300, 0.5)],
  ]);

  const withStemsAvailable = renderMashupWithBus(mashed, {
    vocals: silence(12),
    bed: silence(12),
    stems: donorStems,
    sampleRate: RATE,
  });
  // Nothing was requested, so nothing may be audible: the render is silent
  // even though a full donor drum/bass/other set was supplied.
  assert.equal(samplePeak(withStemsAvailable.pcm), 0, "unrequested donor stems must not be summed");

  const oneLayer = renderMashupWithBus(mashed, {
    vocals: silence(12),
    bed: silence(12),
    stems: donorStems,
    layerStemTypes: ["drums"],
    sampleRate: RATE,
  });
  assert.ok(samplePeak(oneLayer.pcm) > 0.1, "an explicitly requested donor layer is audible");
});

test("a layered donor stem starts at the vocal entry, not at timeline zero", () => {
  // The bed's first body section starts late, so the vocal entry is late.
  const lateEntry = planMashup(
    profile({ role: "vocals", bpm: 100, durationMs: 8_000, sections: [section("verse", 0, 8_000)] }),
    profile({
      bpm: 100,
      durationMs: 20_000,
      sections: [section("intro", 0, 6_000), section("chorus", 6_000, 20_000)],
    }),
  );
  assert.ok(lateEntry.ok);
  const entryMs = lateEntry.plan.segments[0]!.mashupStartMs;
  assert.ok(entryMs >= 6_000, `fixture needs a late vocal entry, got ${entryMs}`);

  const rendered = renderMashupWithBus(lateEntry.plan, {
    vocals: silence(8),
    bed: silence(20),
    stems: new Map([["donor_drums", tone(20, 90, 0.5)]]),
    layerStemTypes: ["drums"],
    sampleRate: RATE,
  });

  const beforeEntry = rendered.pcm.subarray(0, Math.round((entryMs / 1000) * RATE) * 2);
  assert.equal(
    beforeEntry.some((value) => Math.abs(value) > 1e-6),
    false,
    "the layered donor stem must not play before the vocal it accompanies",
  );
  const afterEntry = rendered.pcm.subarray(
    Math.round((entryMs / 1000) * RATE) * 2,
    Math.round((entryMs / 1000) * RATE) * 2 + RATE,
  );
  assert.ok(afterEntry.some((value) => Math.abs(value) > 0.1), "the layer is audible from the entry");
});

test("an overloaded mix is attenuated and limited, never hard-clipped", () => {
  const mashed = plan();
  const rendered = renderMashupWithBus(mashed, {
    vocals: tone(12, 180, 0.95),
    bed: tone(12, 70, 0.95),
    sampleRate: RATE,
    // Composition-only fixture: gain matching is off so the sum really does
    // overshoot and the attenuation/limiting path is what is under test.
    mix: { matchVocalLoudness: false },
  });
  const peak = samplePeak(rendered.pcm);
  assert.ok(peak <= 1, `sample peak ${peak} must stay inside full scale`);
  let pinned = 0;
  for (const value of rendered.pcm) if (Math.abs(value) > 0.9999) pinned += 1;
  assert.equal(pinned, 0, "no sample may be pinned at full scale (the old clamp)");
  assert.ok(rendered.mix.preLimit.rawPeak > 1,
    "the fixture must genuinely overload full scale so the attenuation path is exercised");
  assert.ok(rendered.mix.staticGainDb < 0, "overload is recovered by attenuation");
});

test("a mix that already fits is not made quieter just because a limiter exists", () => {
  const mashed = plan();
  const rendered = renderMashupWithBus(mashed, {
    vocals: silence(12),
    bed: tone(12, 70, 0.3),
    sampleRate: RATE,
    mix: { matchVocalLoudness: false },
  });
  assert.equal(rendered.mix.staticGainDb, 0, "no attenuation below the ceiling");
  assert.equal(rendered.mix.limiter.applied, false, "the limiter must not be needed here");
  // Unity gain, apart from the limiter's fixed lookahead shift.
  const staticGain = 10 ** (rendered.mix.staticGainDb / 20);
  const expected = 0.3 * staticGain;
  const measured = samplePeak(rendered.pcm);
  assert.ok(Math.abs(measured - expected) < 0.01, `peak ${measured} ≈ ${expected}`);
});

test("the vocal is fitted to the bed's measured loudness, and the correction is bounded", () => {
  const mashed = plan();
  // A quietly separated vocal over a loud bed: +12 dB would be needed, so the
  // bus must clamp to its ±9 dB window and say so.
  const quietVocal = tone(12, 220, 0.03);
  const loudBed = tone(12, 80, 0.6);
  const rendered = renderMashupWithBus(mashed, {
    vocals: quietVocal,
    bed: loudBed,
    sampleRate: RATE,
  });
  const balance = rendered.mix.balance;
  assert.ok(balance.vocalLufs !== null && balance.bedLufs !== null, "both sides must be measured");
  assert.ok(balance.bedLufs! > balance.vocalLufs!, "fixture needs a quieter vocal than bed");
  assert.equal(balance.vocalGainDb, MASHUP_MAX_BALANCE_CORRECTION_DB,
    "the correction is clamped to the documented window");
  assert.equal(balance.correctionClamped, true, "a clamped correction must be reported, not hidden");
  assert.match(balance.note, /clamped/);
  // The report must carry the evidence the owner asked for, not just a number.
  assert.ok(balance.vocalIntegratedLufs !== null, "whole-programme loudness is reported for comparison");
  assert.ok(balance.bedActiveFraction !== null && balance.bedActiveFraction! > 0.9,
    "a continuous bed reads as present throughout");

  // The applied correction is exactly the measured loudness difference,
  // never a fixed guess: this is the property that makes the balance
  // explainable rather than a magic number.
  const matched = renderMashupWithBus(mashed, {
    vocals: tone(12, 220, 0.3),
    bed: tone(12, 80, 0.3),
    sampleRate: RATE,
  });
  const { vocalLufs, bedLufs, vocalGainDb } = matched.mix.balance;
  assert.ok(vocalLufs !== null && bedLufs !== null);
  assert.ok(Math.abs(vocalGainDb - (bedLufs! - vocalLufs!)) < 0.01,
    `correction ${vocalGainDb} dB must equal the measured ${(bedLufs! - vocalLufs!).toFixed(2)} LU difference`);
});

test("measured render levels are reported from the audio, not asserted from the plan", () => {
  const mashed = plan();
  const rendered = renderMashupWithBus(mashed, {
    vocals: tone(12, 220, 0.2),
    bed: tone(12, 80, 0.2),
    sampleRate: RATE,
  });
  const lufs = measureLoudness(rendered.pcm, RATE).integrated;
  assert.ok(lufs !== null, "the finished render must be measurable");
  assert.ok(Math.abs((rendered.mix.postLimit.lufsIntegrated ?? 0) - lufs!) < 0.01,
    "the reported LUFS must come from the finished PCM");
  assert.ok(rendered.mix.postLimit.truePeakDb < 1,
    `post-limit true peak ${rendered.mix.postLimit.truePeakDb} dBFS must respect the ceiling`);
});

test("BS.1770 gating already handles silence and bleed, so the balance statistic stays boring", () => {
  // Regression against re-inventing a loudness gate: a sparse phrase and a
  // bleed-padded phrase must both read at their phrase level. This pins the
  // existing meter's behaviour so the mix bus does not silently need a second
  // hand-rolled statistic on top of it.
  const frames = Math.round(30 * RATE);
  const build = (bleedAmplitude: number) => {
    const out = new Float32Array(frames * 2);
    for (let frame = 0; frame < frames; frame += 1) {
      const t = frame / RATE;
      const phrase = t > 5 && t < 6.5 ? 0.3 * Math.sin(2 * Math.PI * 330 * t) : 0;
      const blevel = bleedAmplitude * Math.sin(2 * Math.PI * 1200 * t);
      const value = phrase + blevel;
      out[frame * 2] = value;
      out[frame * 2 + 1] = value;
    }
    return out;
  };
  const silentElsewhere = build(0);
  const bleedPadded = build(0.003); // ≈ −50 dBFS floor, typical separation bleed
  const silent = measureLoudness(silentElsewhere, RATE).integrated;
  const bleed = measureLoudness(bleedPadded, RATE).integrated;
  assert.ok(silent !== null && bleed !== null);
  assert.ok(Math.abs(bleed! - silent!) < 0.5,
    `a −50 dB bleed floor must not dilute the phrase loudness (${bleed!.toFixed(2)} vs ${silent!.toFixed(2)} LUFS)`);

  // The report still exposes how much of the stem was actually active, so a
  // mostly-empty vocal stem is visible to whoever reads the render.
  const presence = measurePresentLoudness(bleedPadded, RATE);
  assert.ok(presence !== null && presence!.activeFraction < 0.2);

  const balance = planMashupBalance({ vocals: bleedPadded, bed: silentElsewhere, sampleRate: RATE });
  assert.equal(balance.method, "integrated");
  assert.ok(balance.vocalActiveFraction !== null && balance.bedActiveFraction !== null,
    "active-block fractions are reported alongside the correction");
  assert.ok(Math.abs(balance.vocalGainDb - (balance.bedLufs! - balance.vocalLufs!)) < 1e-3,
    "the applied correction is exactly the measured difference");
});

test("the applied gain is exact and the correction is reported with the evidence behind it", () => {
  const frames = Math.round(8 * RATE);
  const tone = (frequency: number, amplitude: number) => {
    const out = new Float32Array(frames * 2);
    for (let frame = 0; frame < frames; frame += 1) {
      const value = amplitude * Math.sin((2 * Math.PI * frequency * frame) / RATE);
      out[frame * 2] = value;
      out[frame * 2 + 1] = value;
    }
    return out;
  };
  const result = renderMashupWithBus(plan(), {
    vocals: tone(220, 0.15),
    bed: tone(80, 0.15),
    sampleRate: RATE,
  });
  const { balance } = result.mix;
  assert.ok(Math.abs(balance.vocalGainDb - (balance.bedLufs! - balance.vocalLufs!)) < 1e-3,
    "the applied correction must equal the measured difference, not a rounded stand-in");
  assert.ok(balance.vocalActiveFraction !== null && balance.bedActiveFraction !== null);
  assert.ok(result.mix.postLimit.stereoCorrelation !== null, "stereo integrity must be reported");
});

test("long renders skip the post-limit true-peak pass but say so, instead of implying one", () => {
  // 70 s of bed needs a 70 s *bed profile*, otherwise the planner's own
  // duration (12 s from the shared fixture) decides the render length.
  const longPlan = planMashup(
    profile({ role: "vocals", bpm: 100, durationMs: 70_000, sections: [section("verse", 0, 70_000)] }),
    profile({ bpm: 100, durationMs: 70_000, sections: [section("verse", 0, 70_000)] }),
  );
  assert.ok(longPlan.ok);
  const frames = Math.round(70 * RATE); // just over the 60 s measurement ceiling
  const bed = new Float32Array(frames * 2);
  for (let frame = 0; frame < frames; frame += 1) {
    const value = 0.2 * Math.sin((2 * Math.PI * 90 * frame) / RATE);
    bed[frame * 2] = value;
    bed[frame * 2 + 1] = value;
  }
  const result = renderMashupWithBus(longPlan.plan, {
    vocals: new Float32Array(frames * 2),
    bed,
    sampleRate: RATE,
    mix: { matchVocalLoudness: false },
  });
  assert.equal(result.mix.postTruePeakMeasured, false,
    "a multi-minute render must not claim a post-limit true-peak measurement it did not take");
  assert.ok(Number.isFinite(result.mix.postLimit.samplePeakDb));
  assert.equal(result.mix.postLimit.clippedRegions, 0);
});

test("a layered donor stem follows the session tempo map, not just the entry offset", () => {
  // A donor at 140 BPM over a 100 BPM bed: the vocal is stretched by 1.4 and a
  // layered donor stem must receive the same treatment, otherwise the layer
  // and the bed drift apart within a bar.
  const planned = planMashup(
    profile({ role: "vocals", bpm: 140, bpmConfidence: 0.9, durationMs: 10_000, sections: [section("verse", 0, 10_000)] }),
    profile({ bpm: 100, bpmConfidence: 0.9, durationMs: 16_000, sections: [section("verse", 0, 16_000)] }),
  );
  assert.ok(planned.ok);
  assert.ok(Math.abs(planned.plan.vocalsStretchRatio - 1.4) < 1e-6,
    `fixture must require a real stretch, got ${planned.plan.vocalsStretchRatio}`);

  // The layered stem carries one click at 0.5 s of donor source time.
  const donorFrames = Math.round(10 * RATE);
  const layer = new Float32Array(donorFrames * 2);
  const clickStart = Math.round(0.5 * RATE);
  for (let i = 0; i < 200; i += 1) {
    const value = 0.9 * Math.sin((Math.PI * i) / 200);
    layer[(clickStart + i) * 2] = value;
    layer[(clickStart + i) * 2 + 1] = value;
  }

  const rendered = renderMashupWithBus(planned.plan, {
    vocals: silence(10),
    bed: silence(16),
    stems: new Map([["donor_drums", layer]]),
    layerStemTypes: ["drums"],
    sampleRate: RATE,
    mix: { matchVocalLoudness: false, limit: false },
  });

  const entryMs = planned.plan.segments[0]!.mashupStartMs;
  const stretch = planned.plan.vocalsStretchRatio;
  const expectedMs = entryMs + 500 * stretch;
  const assertClickNear = (atMs: number, label: string) => {
    const from = Math.round(((atMs - 40) / 1000) * RATE) * 2;
    const to = Math.round(((atMs + 40) / 1000) * RATE) * 2;
    let peak = 0;
    for (let i = from; i < to; i += 2) peak = Math.max(peak, Math.abs(rendered.pcm[i]!));
    assert.ok(peak > 0.05, `${label} click must be audible at ${atMs.toFixed(0)}ms (peak ${peak.toFixed(3)})`);
  };
  assertClickNear(expectedMs, "tempo-mapped");
  // The un-stretched position is 0.5 s × 1.4 = 200 ms away — far outside the
  // ±40 ms window, so this cannot pass by accident.
  assert.ok(Math.abs(expectedMs - (entryMs + 500)) > 150,
    "the fixture needs the mapped and unmapped positions to be clearly different");
});

test("a donor layer starts with the vocal phrase, not with the donor's own source lead-in", () => {
  // The plan takes its vocal phrase from the middle of the donor source
  // (vocalsFromMs > 0 means the first usable vocal arrives 2 s in). A donor
  // drum part cut from the same take therefore also begins 2 s in, and the
  // layer must begin at the phrase, not 2 s early — the "donor stem starts at
  // its own zero" failure. The plan's own segments are used unchanged, so this
  // is the production contract, not a fixture convenience.
  const vocalProfile = profile({
    role: "vocals",
    bpm: 120,
    bpmConfidence: 0.9,
    durationMs: 12_000,
    sections: [section("verse", 0, 12_000)],
    vocalPhrases: [{ startMs: 2_000, endMs: 10_000, confidence: 0.9 }],
  });
  const bedProfile = profile({
    bpm: 120,
    bpmConfidence: 0.9,
    durationMs: 16_000,
    sections: [section("verse", 0, 16_000)],
  });
  const planned = planMashup(vocalProfile, bedProfile);
  assert.ok(planned.ok);
  const segment = planned.plan.segments[0]!;
  // The planner pads a little before the detected phrase; the exact crop does
  // not matter, only that it is a long way from the donor file's zero.
  assert.ok(segment.vocalsFromMs > 1_000,
    `fixture must plan a mid-source vocal phrase, got ${segment.vocalsFromMs} ms`);
  assert.ok(Math.abs(planned.plan.vocalsStretchRatio - 1) < 1e-6, "no stretch, so placement is the only variable");

  // One click at 0.5 s of donor source time, plus a loud marker at donor
  // source 0 s that must NOT reach the mix.
  const donorFrames = Math.round(12 * RATE);
  const layer = new Float32Array(donorFrames * 2);
  for (let i = 0; i < 400; i += 1) {
    const value = 0.9 * Math.sin((Math.PI * i) / 400);
    layer[i * 2] = value;
    layer[i * 2 + 1] = value;
  }
  // 0.5 s of donor time into the phrase the plan actually crops.
  const clickStart = Math.round((segment.vocalsFromMs + 500) * (RATE / 1000));
  for (let i = 0; i < 200; i += 1) {
    const value = 0.6 * Math.sin((Math.PI * i) / 200);
    layer[(clickStart + i) * 2] = value;
    layer[(clickStart + i) * 2 + 1] = value;
  }

  const rendered = renderMashupWithBus(planned.plan, {
    vocals: silence(12),
    bed: silence(16),
    stems: new Map([["donor_drums", layer]]),
    layerStemTypes: ["drums"],
    sampleRate: RATE,
    mix: { matchVocalLoudness: false, limit: false },
  });

  const peakBetween = (fromMs: number, toMs: number) => {
    const from = Math.round((fromMs / 1000) * RATE) * 2;
    const to = Math.round((toMs / 1000) * RATE) * 2;
    let peak = 0;
    for (let i = Math.max(0, from); i < Math.min(rendered.pcm.length, to); i += 1) {
      peak = Math.max(peak, Math.abs(rendered.pcm[i]!));
    }
    return peak;
  };

  // Donor source 2.5 s is 0.5 s into the phrase, so it lands at the vocal
  // entry (0 ms here) + 500 ms. The donor's own lead-in at source 0 s is
  // dropped, so nothing appears at 0 ms.
  const entryMs = segment.mashupStartMs;
  // Threshold is well above the 0.05 silence floor and well below the click's
  // rendered peak, so placement — not level — is what the assertion measures.
  assert.ok(peakBetween(entryMs + 440, entryMs + 560) > 0.15,
    "the phrase-relative click lands 500 ms after the vocal entry");
  assert.ok(peakBetween(0, entryMs + 100) < 0.05,
    "the donor's own source lead-in must not be prefixed to the phrase");
});

test("a layered donor follows the accepted local tempo map, not just a constant ratio", () => {
  // The planner can accept a piecewise local tempo map, in which case the
  // vocal is warped through that map and drifts away from a constant stretch.
  // A layered donor that used the constant ratio would start correctly and
  // then slide against the vocal it accompanies — audible as a flam that grows
  // through the phrase, and invisible to any measurement taken at the entry.
  const basePlan = (() => {
    const planned = planMashup(
      profile({ role: "vocals", bpm: 140, bpmConfidence: 0.9, durationMs: 10_000, sections: [section("verse", 0, 10_000)] }),
      profile({ bpm: 100, bpmConfidence: 0.9, durationMs: 16_000, sections: [section("verse", 0, 16_000)] }),
    );
    assert.ok(planned.ok);
    return planned.plan;
  })();

  // A map that removes the constant bias: the first half runs faster than the
  // constant ratio and the second half slower. Net duration is unchanged, so
  // only *within-phrase* placement can distinguish the two strategies.
  const entryShiftMs = 120;
  const localTempoMap = {
    points: [
      { sourceMs: 0, outputMs: 0 },
      { sourceMs: 2_500, outputMs: 1_750 },
      { sourceMs: 5_000, outputMs: 5_250 },
      { sourceMs: 7_500, outputMs: 7_300 },
      { sourceMs: 10_000, outputMs: 14_000 },
    ],
    baselineFit: { matchedBeats: 10, comparedBeats: 20, meanErrorMs: 40 },
    correctedFit: { matchedBeats: 19, comparedBeats: 20, meanErrorMs: 9 },
    maximumRateDeviationPercent: 6,
    entryShiftMs,
  };
  const plan = {
    ...basePlan,
    segments: [{ ...basePlan.segments[0]!, mashupStartMs: entryShiftMs, localTempoMap }],
  };

  // One click per second of donor source time, so drift is measurable at
  // several points instead of only at the entry.
  const donorFrames = Math.round(10 * RATE);
  const layer = new Float32Array(donorFrames * 2);
  const clickSourceMs = [1_000, 2_000, 5_000, 7_500];
  for (const atMs of clickSourceMs) {
    const start = Math.round((atMs / 1000) * RATE);
    for (let i = 0; i < 120; i += 1) {
      const value = 0.7 * Math.sin((Math.PI * i) / 120);
      layer[(start + i) * 2] = value;
      layer[(start + i) * 2 + 1] = value;
    }
  }

  const rendered = renderMashupWithBus(plan, {
    vocals: silence(10),
    bed: silence(16),
    stems: new Map([["donor_drums", layer]]),
    layerStemTypes: ["drums"],
    sampleRate: RATE,
    mix: { matchVocalLoudness: false, limit: false },
  });

  const clickMs = (nearMs: number): number | null => {
    const from = Math.max(0, Math.round(((nearMs - 250) / 1000) * RATE) * 2);
    const to = Math.min(rendered.pcm.length, Math.round(((nearMs + 250) / 1000) * RATE) * 2);
    let best: number | null = null;
    let bestValue = 0.05;
    for (let i = from; i < to; i += 2) {
      const value = Math.abs(rendered.pcm[i]!);
      if (value > bestValue) {
        bestValue = value;
        best = (i / 2 / RATE) * 1000;
      }
    }
    return best;
  };

  // The map is the contract: a click at donor source time T must land at the
  // mapped output time plus the (map-corrected) entry. A constant-ratio layer
  // passes at 1 s and fails badly by 7.5 s.
  const mappedOffset = (sourceMs: number): number => {
    for (let index = 1; index < localTempoMap.points.length; index += 1) {
      const previous = localTempoMap.points[index - 1]!;
      const next = localTempoMap.points[index]!;
      if (sourceMs <= next.sourceMs) {
        const span = next.sourceMs - previous.sourceMs;
        const fraction = span === 0 ? 0 : (sourceMs - previous.sourceMs) / span;
        return previous.outputMs + fraction * (next.outputMs - previous.outputMs);
      }
    }
    return localTempoMap.points.at(-1)!.outputMs;
  };

  const deviations: number[] = [];
  for (const atMs of clickSourceMs) {
    const expected = entryShiftMs + mappedOffset(atMs);
    const actual = clickMs(expected);
    assert.ok(actual !== null, `a click must be audible near ${expected.toFixed(0)} ms`);
    const deviation = Math.abs(actual! - expected);
    deviations.push(deviation);
    assert.ok(deviation <= 40,
      `donor click from source ${atMs} ms must land at ${expected.toFixed(0)} ms, got ${actual!.toFixed(0)} ms (${deviation.toFixed(0)} ms off)`);
  }

  // Prove the assertion has teeth: a constant-ratio layer would put these
  // clicks somewhere else by a wide margin, so this test cannot pass by
  // accidentally measuring the old behaviour.
  const constantDeviations = clickSourceMs.map((atMs) => {
    const expected = entryShiftMs + mappedOffset(atMs);
    const constant = entryShiftMs + atMs * basePlan.vocalsStretchRatio;
    return Math.abs(constant - expected);
  });
  assert.ok(Math.max(...constantDeviations) > 400,
    "the map and the constant ratio must be far apart, or this test measures nothing");
  assert.ok(Math.max(...deviations) < Math.min(...constantDeviations),
    "the mapped placement must be closer than a constant stretch at every click");
});

test("drum replacement leaves exactly one rhythm section, and refuses to leave none", () => {
  const bedStems = (types: string[]) => types.map((stemType) => ({
    stemType,
    sourceAssetId: "source-a",
    separationJobId: "job-a",
    startMs: 0,
    sampleRate: RATE,
    channels: 2,
    frames: Math.round(2 * RATE),
    samples: tone(2, stemType === "bass" ? 60 : 90, 0.3),
  }));

  const all = ["drums", "bass", "other"];
  // Default: the bed keeps its own rhythm section.
  const complete = sumInstrumentalStems(bedStems(all));
  assert.deepEqual(complete.includedStemTypes, ["drums", "bass", "other"]);
  assert.deepEqual(complete.replacedStemTypes, []);

  // Replacement: the bed's drums are gone, so the donor's drums are the only
  // drum part. This is the difference between a replacement and a doubled
  // rhythm section.
  const replaced = sumInstrumentalStems(bedStems(all), { omitStemTypes: ["drums"] });
  assert.deepEqual(replaced.includedStemTypes, ["bass", "other"]);
  assert.deepEqual(replaced.replacedStemTypes, ["drums"]);

  // A replacement that would remove every bed stem is refused explicitly
  // rather than rendering a vocal over nothing.
  assert.throws(
    () => sumInstrumentalStems(bedStems(all), { omitStemTypes: all }),
    (error: unknown) => error instanceof InstrumentalBedError && error.code === "all-stems-replaced",
  );
});
