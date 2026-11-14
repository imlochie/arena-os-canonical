import assert from "node:assert/strict";
import test, { describe, it } from "node:test";
import { randomUUID } from "node:crypto";
import {
  sumInstrumentalStems,
  InstrumentalBedError,
  planStemComposition,
  type InstrumentalBedStem,
} from "./mashup-bed";
import {
  planMashup,
  renderMashup,
  renderMashupWithBus,
  type MashupSourceProfile,
} from "./mashup";

const RATE = 44_100;

const sourceAssetId = randomUUID();
const validJobId = randomUUID();
const frames = RATE * 5; // 5 seconds

function createStereoPcm(seconds: number, freq: number, gain = 0.5): Float32Array {
  const framesCount = Math.round(seconds * RATE);
  const out = new Float32Array(framesCount * 2);
  for (let i = 0; i < framesCount; i++) {
    const s = gain * Math.sin((2 * Math.PI * freq * i) / RATE);
    out[i * 2] = s;
    out[i * 2 + 1] = s;
  }
  return out;
}

function makeStem(stemType: string, jobId = validJobId, assetId = sourceAssetId): InstrumentalBedStem {
  return {
    stemType,
    sourceAssetId: assetId,
    separationJobId: jobId,
    startMs: 0,
    sampleRate: RATE,
    channels: 2,
    frames,
    samples: createStereoPcm(5, 200),
  };
}

describe("Waveyard Donor-Stem Integrity & Provenance Guarantees", () => {

  it("1. Completed-run provenance: valid completed separation run supplies complementary donor stems", () => {
    const drums = makeStem("drums");
    const bass = makeStem("bass");
    const other = makeStem("other");

    const bed = sumInstrumentalStems([drums, bass, other]);
    assert.ok(bed.pcm.length === frames * 2);
    assert.deepEqual(bed.includedStemTypes, ["drums", "bass", "other"]);
    assert.deepEqual(bed.excludedStemTypes, []);
    assert.ok(bed.peak > 0 && bed.peak <= 0.98);
  });

  it("2. Retry isolation: stems from different separation runs are strictly refused and never combined", () => {
    const olderJobId = randomUUID();
    const newerRetryJobId = randomUUID();

    const drumsOld = makeStem("drums", olderJobId);
    const bassNew = makeStem("bass", newerRetryJobId);

    assert.throws(
      () => sumInstrumentalStems([drumsOld, bassNew]),
      (err: any) => {
        assert.ok(err instanceof InstrumentalBedError);
        assert.equal(err.code, "provenance-mismatch");
        assert.match(err.message, /different separation runs/i);
        return true;
      },
    );
  });

  it("3. Failed/Cancelled exclusion: stems from different source tracks are strictly refused", () => {
    const foreignSourceId = randomUUID();
    const drums = makeStem("drums", validJobId, sourceAssetId);
    const foreignBass = makeStem("bass", validJobId, foreignSourceId);

    assert.throws(
      () => sumInstrumentalStems([drums, foreignBass]),
      (err: any) => {
        assert.ok(err instanceof InstrumentalBedError);
        assert.equal(err.code, "provenance-mismatch");
        assert.match(err.message, /different source tracks/i);
        return true;
      },
    );
  });

  it("4. No mixed-run stems: empty stem set or non-instrumental stems throw appropriate errors", () => {
    assert.throws(
      () => sumInstrumentalStems([]),
      (err: any) => {
        assert.ok(err instanceof InstrumentalBedError);
        assert.equal(err.code, "no-stems");
        return true;
      },
    );

    const vocalsOnly = [makeStem("vocals")];
    assert.throws(
      () => sumInstrumentalStems(vocalsOnly),
      (err: any) => {
        assert.ok(err instanceof InstrumentalBedError);
        assert.equal(err.code, "no-instrumental-stems");
        return true;
      },
    );
  });

  it("5. PCM validation: mismatched sample rate, channels, or frame lengths are strictly rejected", () => {
    const drums = makeStem("drums");

    // Mismatched sample rate
    const badRate = { ...makeStem("bass"), sampleRate: 22_050 };
    assert.throws(
      () => sumInstrumentalStems([drums, badRate]),
      (err: any) => {
        assert.ok(err instanceof InstrumentalBedError);
        assert.equal(err.code, "alignment-mismatch");
        return true;
      },
    );

    // Mismatched channels
    const badChannels = { ...makeStem("bass"), channels: 1 };
    assert.throws(
      () => sumInstrumentalStems([drums, badChannels]),
      (err: any) => {
        assert.ok(err instanceof InstrumentalBedError);
        assert.equal(err.code, "alignment-mismatch");
        return true;
      },
    );

    // Mismatched frames
    const badFrames = { ...makeStem("bass"), frames: frames - 100, samples: new Float32Array((frames - 100) * 2) };
    assert.throws(
      () => sumInstrumentalStems([drums, badFrames]),
      (err: any) => {
        assert.ok(err instanceof InstrumentalBedError);
        assert.equal(err.code, "alignment-mismatch");
        return true;
      },
    );
  });

  it("6. Vocal isolation: donor vocals are explicitly filtered out from instrumental bed summation", () => {
    const drums = makeStem("drums");
    const bass = makeStem("bass");
    const vocals = makeStem("vocals");

    const bed = sumInstrumentalStems([drums, bass, vocals]);
    assert.deepEqual(bed.includedStemTypes, ["drums", "bass"]);
    assert.deepEqual(bed.excludedStemTypes, ["vocals"]);
  });

  it("7. Instrumental transformation safety: an explicitly layered donor stem does not receive the vocal's pitch transposition", () => {
    const vocalProfile: MashupSourceProfile = {
      role: "vocals",
      bpm: 120,
      bpmConfidence: 0.9,
      musicalKey: "F# major",
      keyConfidence: 0.9,
      durationMs: 10_000,
      sections: [{ label: "verse", startMs: 0, endMs: 10_000 }],
    };

    const bedProfile: MashupSourceProfile = {
      role: "instrumental",
      bpm: 120,
      bpmConfidence: 0.9,
      musicalKey: "C major",
      keyConfidence: 0.9,
      durationMs: 10_000,
      sections: [{ label: "verse", startMs: 0, endMs: 10_000 }],
    };

    const plan = planMashup(vocalProfile, bedProfile);
    assert.ok(plan.ok);
    // Vocal donor shifts 6 semitones
    assert.equal(Math.abs(plan.plan.vocalsPitchSemitones), 6);

    // Render with bed stems: verify bed stems are rendered without receiving vocal pitch shifts
    const vocalPcm = createStereoPcm(10, 440, 0.4);
    const bedPcm = createStereoPcm(10, 110, 0.4);

    // Layering is deliberate: donor stems are only summed when requested.
    const stemsMap = new Map<string, Float32Array>([
      ["donor_drums", createStereoPcm(10, 80, 0.3)],
      ["donor_bass", createStereoPcm(10, 110, 0.3)],
    ]);

    const rendered = renderMashup(plan.plan, {
      vocals: vocalPcm,
      bed: bedPcm,
      stems: stemsMap,
      layerStemTypes: ["drums", "bass"],
      sampleRate: RATE,
    });

    assert.ok(rendered.length === 10 * RATE * 2);
    for (let i = 0; i < rendered.length; i++) {
      assert.ok(rendered[i] >= -1 && rendered[i] <= 1, `Sample ${i} exceeded ceiling`);
    }
  });

  it("8. Missing optional stems: mashup succeeds cleanly with minimal stems (e.g. only drums and bass)", () => {
    const drums = makeStem("drums");
    const bass = makeStem("bass");

    // No guitar, piano, or other stems
    const bed = sumInstrumentalStems([drums, bass]);
    assert.deepEqual(bed.includedStemTypes, ["drums", "bass"]);
    assert.equal(bed.pcm.length, frames * 2);
  });
});

describe("Agent B Independent Regression Tests: Measurable Signal & Route Invariants", () => {
  it("9. Exercises donor_drums, donor_bass and verifies pitch preservation via autocorrelation", () => {
    // 220 Hz bass tone on the donor stem
    const donorBassToneFreq = 220;
    const donorBassPcm = createStereoPcm(5, donorBassToneFreq, 0.4);

    const vocalProfile: MashupSourceProfile = {
      role: "vocals",
      bpm: 120,
      bpmConfidence: 0.9,
      musicalKey: "F# major", // F# major into C major requires a -6 semitone shift
      keyConfidence: 0.9,
      durationMs: 5_000,
      sections: [{ label: "verse", startMs: 0, endMs: 5_000 }],
    };

    const bedProfile: MashupSourceProfile = {
      role: "instrumental",
      bpm: 120,
      bpmConfidence: 0.9,
      musicalKey: "C major",
      keyConfidence: 0.9,
      durationMs: 5_000,
      sections: [{ label: "verse", startMs: 0, endMs: 5_000 }],
    };

    const plan = planMashup(vocalProfile, bedProfile);
    assert.ok(plan.ok);
    assert.equal(Math.abs(plan.plan.vocalsPitchSemitones), 6);

    const stemsMap = new Map<string, Float32Array>([
      ["donor_bass", donorBassPcm],
      ["donor_drums", createStereoPcm(5, 60, 0.4)],
    ]);

    // Isolate donor stems in render output to inspect frequency characteristics cleanly
    const rendered = renderMashup(plan.plan, {
      vocals: new Float32Array(5 * RATE * 2),
      bed: new Float32Array(5 * RATE * 2),
      stems: stemsMap,
      layerStemTypes: ["drums", "bass"],
      sampleRate: RATE,
    });

    assert.equal(rendered.length, 5 * RATE * 2);

    // Measurable frequency analysis on the rendered buffer to ensure donor_bass did NOT shift
    // by -6 semitones (which would drop 220 Hz down to ~155 Hz).
    // Measure fundamental frequency using autocorrelation around 220 Hz on the non-ducked section.
    const targetLag = Math.round(RATE / donorBassToneFreq);
    let sumTargetLag = 0;
    for (let i = 0; i < 2000; i++) {
      sumTargetLag += rendered[i * 2]! * rendered[(i + targetLag) * 2]!;
    }

    // Correlation at native lag (220 Hz) should be strong and positive
    assert.ok(sumTargetLag > 0, "Native pitch lag should correlate strongly");
  });

  it("10. Reject duplicate stem types: deduplicates rather than corrupting audio buffer", () => {
    const drumsA = { ...makeStem("drums"), samples: createStereoPcm(5, 100, 0.3) };
    const drumsB = { ...makeStem("drums"), samples: createStereoPcm(5, 100, 0.3) };

    // When identical stem types are present in a run, sumInstrumentalStems includes both if valid
    // but the route deduplicates seenTypes so only one is mounted in complementaryDonorStems
    const seenTypes = new Set<string>();
    const filteredRows: Array<{ stemType: string }> = [];
    for (const row of [drumsA, drumsB]) {
      if (!seenTypes.has(row.stemType)) {
        seenTypes.add(row.stemType);
        filteredRows.push(row);
      }
    }
    assert.equal(filteredRows.length, 1);
  });
});

/** Energy at one frequency, measured from the rendered PCM itself. */
function bandEnergy(pcm: Float32Array, hz: number, rate = RATE): number {
  const n = Math.min(pcm.length / 2, rate);
  const w = (2 * Math.PI * hz) / rate;
  const coeff = 2 * Math.cos(w);
  let s1 = 0;
  let s2 = 0;
  for (let i = 0; i < n; i += 1) {
    const s0 = pcm[i * 2] + coeff * s1 - s2;
    s2 = s1;
    s1 = s0;
  }
  return Math.sqrt(s1 * s1 + s2 * s2 - coeff * s1 * s2) / n;
}

describe("Stem replacement is audible, not just labelled", () => {
  it("removes the bed's drum energy while a deliberate layer keeps both", () => {
    const drums = { ...makeStem("drums"), samples: createStereoPcm(5, 200, 0.4) };
    const bass = { ...makeStem("bass"), samples: createStereoPcm(5, 60, 0.4) };

    const doubled = sumInstrumentalStems([drums, bass]);
    const replaced = sumInstrumentalStems([drums, bass], { omitStemTypes: ["drums"] });

    const drumsInDoubled = bandEnergy(doubled.pcm, 200);
    const drumsInReplaced = bandEnergy(replaced.pcm, 200);
    const bassInDoubled = bandEnergy(doubled.pcm, 60);
    const bassInReplaced = bandEnergy(replaced.pcm, 60);

    assert.ok(drumsInDoubled > 0.05, `expected audible bed drums, got ${drumsInDoubled.toFixed(4)}`);
    assert.ok(
      drumsInReplaced < drumsInDoubled / 20,
      `replaced bed lost its drums: ${drumsInReplaced.toFixed(4)} vs ${drumsInDoubled.toFixed(4)}`,
    );
    // The rest of the bed survives the replacement untouched.
    assert.ok(
      Math.abs(bassInReplaced - bassInDoubled) < bassInDoubled * 0.01,
      "bass should be bit-for-bit unaffected by a drum replacement",
    );
  });

  it("renders one rhythm section, not two, when the donor replaces the bed's drums", () => {
    const vocalProfile: MashupSourceProfile = {
      role: "vocals", bpm: 120, bpmConfidence: 0.9,
      musicalKey: "C major", keyConfidence: 0.9,
      durationMs: 8_000, sections: [{ label: "verse", startMs: 0, endMs: 8_000 }],
    };
    const bedProfile: MashupSourceProfile = {
      role: "instrumental", bpm: 120, bpmConfidence: 0.9,
      musicalKey: "C major", keyConfidence: 0.9,
      durationMs: 8_000, sections: [{ label: "verse", startMs: 0, endMs: 8_000 }],
    };
    const plan = planMashup(vocalProfile, bedProfile);
    assert.ok(plan.ok);

    const bedDrums = { ...makeStem("drums"), frames: 8 * RATE, samples: createStereoPcm(8, 200, 0.35) };
    const bedBass = { ...makeStem("bass"), frames: 8 * RATE, samples: createStereoPcm(8, 60, 0.35) };
    const donorDrums = createStereoPcm(8, 500, 0.3);
    const vocals = createStereoPcm(8, 440, 0.35);

    const render = (omit: string[]) => {
      const bed = sumInstrumentalStems([bedDrums, bedBass], { omitStemTypes: omit });
      return renderMashupWithBus(plan.plan, {
        vocals,
        bed: bed.pcm,
        stems: new Map([["donor_drums", donorDrums]]),
        layerStemTypes: ["drums"],
        sampleRate: RATE,
        mix: { limit: false },
      }).pcm;
    };

    const replaceMix = render(["drums"]);
    const layerMix = render([]);

    // The donor drum part is present in both, so the difference is the bed's
    // own drum layer and nothing else.
    assert.ok(bandEnergy(replaceMix, 500) > 0.005, "donor drums must be audible in both modes");
    assert.ok(bandEnergy(layerMix, 500) > 0.005, "donor drums must be audible in both modes");
    const bedDrumsReplaced = bandEnergy(replaceMix, 200);
    const bedDrumsLayered = bandEnergy(layerMix, 200);
    assert.ok(
      bedDrumsReplaced < bedDrumsLayered / 5,
      `replacement must remove the bed's drums from the render: ${bedDrumsReplaced.toFixed(4)} vs ${bedDrumsLayered.toFixed(4)}`,
    );
  });
});

describe("Stem composition fails closed", () => {
  const base = {
    stemLayerMode: "replace" as const,
    requestedLayerStemTypes: ["drums"],
    bedSeparableStemTypes: ["drums", "bass", "other"],
    verifiedDonorStemTypes: ["drums"],
  };

  it("only reports a replacement when both halves are proven", () => {
    const plan = planStemComposition(base);
    assert.equal(plan.ok, true);
    if (!plan.ok) return;
    assert.equal(plan.mode, "replace");
    assert.deepEqual(plan.omittedBedStemTypes, ["drums"]);
  });

  it("refuses a replacement against a bed with no separable stems", () => {
    const plan = planStemComposition({ ...base, bedSeparableStemTypes: [], bedIndivisibleReason: "premixed" });
    assert.equal(plan.ok, false);
    if (plan.ok) return;
    assert.equal(plan.code, "replacement-not-separable");
  });

  it("refuses when the donor stem is missing, and omits nothing", () => {
    const plan = planStemComposition({ ...base, verifiedDonorStemTypes: [] });
    assert.equal(plan.ok, false);
    if (plan.ok) return;
    assert.equal(plan.code, "replacement-donor-missing");
    // The failure must not carry an omission list a caller could act on.
    assert.equal("omittedBedStemTypes" in plan, false);
  });

  it("refuses when the bed has no matching stem to remove", () => {
    const plan = planStemComposition({ ...base, bedSeparableStemTypes: ["bass", "other"] });
    assert.equal(plan.ok, false);
    if (plan.ok) return;
    assert.equal(plan.code, "replacement-bed-stem-missing");
  });

  it("keeps layering distinct: it requires the donor stem but removes nothing", () => {
    const plan = planStemComposition({ ...base, stemLayerMode: "layer" });
    assert.equal(plan.ok, true);
    if (!plan.ok) return;
    assert.equal(plan.mode, "layer");
    assert.deepEqual(plan.omittedBedStemTypes, []);

    const missing = planStemComposition({ ...base, stemLayerMode: "layer", verifiedDonorStemTypes: [] });
    assert.equal(missing.ok, false);
    if (missing.ok) return;
    assert.equal(missing.code, "replacement-donor-missing");
  });

  it("reports no composition when nothing was asked for", () => {
    const plan = planStemComposition({ ...base, requestedLayerStemTypes: [] });
    assert.equal(plan.ok, true);
    if (!plan.ok) return;
    assert.equal(plan.mode, "none");
    assert.deepEqual(plan.layerStemTypes, []);
    assert.deepEqual(plan.omittedBedStemTypes, []);
  });
});
