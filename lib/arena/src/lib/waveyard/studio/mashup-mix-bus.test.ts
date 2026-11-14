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
import { measureLoudness, samplePeak } from "../mixer/meters";

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
  assert.equal(balance.vocalGainDb, 9, "the correction is clamped to the documented window");
  assert.equal(balance.correctionClamped, true, "a clamped correction must be reported, not hidden");
  assert.match(balance.note, /clamped/);

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
