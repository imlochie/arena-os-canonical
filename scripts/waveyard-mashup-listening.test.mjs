import assert from "node:assert/strict";
import test from "node:test";
import { summarizeMashupResponses, trimPcmWavToSamples } from "./waveyard-mashup-listening.mjs";

test("blind mashup ratings are attributed to the true baseline and swapped versions", () => {
  const report = { combinations: [{ id: "mix-1" }] };
  const key = {
    trials: [{
      trialId: "blind-code",
      combinationId: "mix-1",
      versionA: "swap",
      versionB: "baseline",
    }],
  };
  const responses = [
    {
      responses: [{
        trialId: "blind-code",
        ratings: {
          A: { harmonicFit: 5, rhythmFit: 4, stemArtifacts: 4, overallFit: 5 },
          B: { harmonicFit: 2, rhythmFit: 3, stemArtifacts: 2, overallFit: 2 },
        },
        preference: "A",
      }],
    },
    {
      responses: [{
        trialId: "blind-code",
        ratings: {
          A: { harmonicFit: 3, rhythmFit: 3, stemArtifacts: 5, overallFit: 4 },
          B: { harmonicFit: 1, rhythmFit: 2, stemArtifacts: 3, overallFit: 2 },
        },
        preference: "tie",
      }],
    },
  ];
  const [summary] = summarizeMashupResponses(report, key, responses);
  assert.equal(summary.responseCount, 2);
  assert.deepEqual(summary.ratings.swap.harmonicFit, { mean: 4, n: 2 });
  assert.deepEqual(summary.ratings.baseline.overallFit, { mean: 2, n: 2 });
  assert.deepEqual(summary.preference, { baseline: 0, swap: 1, tie: 1 });
});

test("unrecognized trials and invalid ratings do not contaminate combination summaries", () => {
  const report = { combinations: [{ id: "mix-1" }] };
  const key = { trials: [{ trialId: "known", combinationId: "mix-1", versionA: "baseline", versionB: "swap" }] };
  const [summary] = summarizeMashupResponses(report, key, [{
    responses: [
      { trialId: "other", ratings: { A: { harmonicFit: 5 } }, preference: "A" },
      { trialId: "known", ratings: { A: { harmonicFit: 9 }, B: { harmonicFit: 4 } }, preference: "B" },
    ],
  }]);
  assert.equal(summary.responseCount, 1);
  assert.deepEqual(summary.ratings.baseline, {});
  assert.deepEqual(summary.ratings.swap.harmonicFit, { mean: 4, n: 1 });
  assert.deepEqual(summary.preference, { baseline: 0, swap: 1, tie: 0 });
});

test("blind A/B WAVs can be trimmed to identical sample counts", () => {
  const dataBytes = 8 * 2;
  const wav = Buffer.alloc(44 + dataBytes);
  wav.write("RIFF", 0);
  wav.writeUInt32LE(wav.length - 8, 4);
  wav.write("WAVEfmt ", 8);
  wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20);
  wav.writeUInt16LE(2, 22);
  wav.writeUInt32LE(44_100, 24);
  wav.writeUInt32LE(44_100 * 2 * 2, 28);
  wav.writeUInt16LE(4, 32);
  wav.writeUInt16LE(16, 34);
  wav.write("data", 36);
  wav.writeUInt32LE(dataBytes, 40);

  const trimmed = trimPcmWavToSamples(wav, 6);
  assert.equal(trimmed.length, 44 + 12);
  assert.equal(trimmed.readUInt32LE(4), trimmed.length - 8);
  assert.equal(trimmed.readUInt32LE(40), 12);
});
