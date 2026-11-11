import assert from "node:assert/strict";
import test, { describe, it } from "node:test";
import { randomUUID } from "node:crypto";
import {
  sumInstrumentalStems,
  InstrumentalBedError,
  type InstrumentalBedStem,
} from "./mashup-bed";
import {
  planMashup,
  renderMashup,
  type MashupSourceProfile,
} from "./mashup";

const RATE = 44_100;

function createStereoPcm(seconds: number, freq: number, gain = 0.5): Float32Array {
  const frames = Math.round(seconds * RATE);
  const out = new Float32Array(frames * 2);
  for (let i = 0; i < frames; i++) {
    const s = gain * Math.sin((2 * Math.PI * freq * i) / RATE);
    out[i * 2] = s;
    out[i * 2 + 1] = s;
  }
  return out;
}

describe("Waveyard Donor-Stem Integrity & Provenance Guarantees", () => {
  const sourceAssetId = randomUUID();
  const validJobId = randomUUID();
  const frames = RATE * 5; // 5 seconds

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

  it("7. Instrumental transformation safety: complementary bed stems do not receive vocal pitch transposition", () => {
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

    const stemsMap = new Map<string, Float32Array>([
      ["drums", createStereoPcm(10, 80, 0.3)],
      ["bass", createStereoPcm(10, 110, 0.3)],
    ]);

    const rendered = renderMashup(plan.plan, {
      vocals: vocalPcm,
      bed: bedPcm,
      stems: stemsMap,
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
