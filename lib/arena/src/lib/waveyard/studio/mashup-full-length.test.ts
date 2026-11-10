import test from "node:test";
import assert from "node:assert/strict";

import {
  planMashup,
  renderMashup,
  analyseStereoPcm,
  type MashupSourceProfile,
  type MashupPlan,
} from "./mashup";
import { encodeWav16, decodeWav16 } from "../mixer/synth";

const RATE = 44_100;

function tone(freq: number, seconds: number, gain: number): Float32Array {
  const frames = Math.round(seconds * RATE);
  const out = new Float32Array(frames * 2);
  for (let i = 0; i < frames; i++) {
    const s = gain * Math.sin((2 * Math.PI * freq * i) / RATE);
    out[i * 2] = s;
    out[i * 2 + 1] = s;
  }
  return out;
}

function clickPattern(bpm: number, seconds: number, gain = 0.5): Float32Array {
  const frames = Math.round(seconds * RATE);
  const out = new Float32Array(frames * 2);
  const beatSec = 60 / bpm;
  const clickFrames = Math.round(0.01 * RATE);
  for (let beat = 0; beat * beatSec < seconds; beat++) {
    const start = Math.round(beat * beatSec * RATE);
    for (let i = 0; i < clickFrames && start + i < frames; i++) {
      const s = gain * Math.sin((Math.PI * i) / clickFrames);
      out[(start + i) * 2] = s;
      out[(start + i) * 2 + 1] = s;
    }
  }
  return out;
}

test("Pair A: Large BPM difference (85 BPM vs 135 BPM) and differing keys", () => {
  const vocalProfile: MashupSourceProfile = {
    role: "vocals",
    bpm: 85,
    musicalKey: "E minor",
    durationMs: 45_000,
    sections: [
      { label: "intro", startMs: 0, endMs: 5_000 },
      { label: "verse", startMs: 5_000, endMs: 25_000 },
      { label: "chorus", startMs: 25_000, endMs: 45_000 },
    ],
  };

  const bedProfile: MashupSourceProfile = {
    role: "instrumental",
    bpm: 135,
    musicalKey: "C major",
    durationMs: 90_000,
    sections: [
      { label: "intro", startMs: 0, endMs: 7_111 },
      { label: "verse 1", startMs: 7_111, endMs: 35_555 },
      { label: "chorus 1", startMs: 35_555, endMs: 64_000 },
      { label: "breakdown", startMs: 64_000, endMs: 90_000 },
    ],
  };

  const planned = planMashup(vocalProfile, bedProfile);
  assert.ok(planned.ok);
  assert.equal(planned.plan.masterBpm, 135);
  assert.ok(planned.plan.vocalsStretchRatio < 1.0);
  assert.ok(planned.plan.segments.length >= 2, "Structured multi-segment arrangement across 90s");

  const vocalPcm = tone(330, 45, 0.4);
  const bedPcm = tone(110, 90, 0.4);

  const rendered = renderMashup(planned.plan, {
    vocals: vocalPcm,
    bed: bedPcm,
    sampleRate: RATE,
  });

  assert.equal(rendered.length, 90 * RATE * 2);
  for (let i = 0; i < rendered.length; i++) {
    assert.ok(!Number.isNaN(rendered[i]));
    assert.ok(rendered[i] <= 1.0001 && rendered[i] >= -1.0001);
  }
});

test("Pair B: Completely unanalyzed audio with on-the-fly native analysis", () => {
  const rawVocalPcm = clickPattern(120, 20, 0.5);
  const rawBedPcm = clickPattern(120, 30, 0.5);

  const vocalAnalysis = analyseStereoPcm(rawVocalPcm);
  assert.ok(vocalAnalysis.bpm !== null, "On-the-fly analysis must detect tempo from audio");

  const vocalProfile: MashupSourceProfile = {
    role: "vocals",
    bpm: vocalAnalysis.bpm,
    musicalKey: vocalAnalysis.musicalKey,
    durationMs: 20_000,
    sections: [],
  };

  const bedProfile: MashupSourceProfile = {
    role: "instrumental",
    bpm: null,
    musicalKey: null,
    durationMs: 30_000,
    sections: [],
  };

  const planned = planMashup(vocalProfile, bedProfile);
  assert.ok(planned.ok);
  assert.ok(planned.plan.masterBpm > 0);

  const rendered = renderMashup(planned.plan, {
    vocals: rawVocalPcm,
    bed: rawBedPcm,
    sampleRate: RATE,
  });

  assert.equal(rendered.length, 30 * RATE * 2);
  assert.ok(rendered.some((sample) => Math.abs(sample) > 0.1), "Audible audio present");
});

test("Pair C: Harmonic clash requiring pitch transposition", () => {
  const vocalProfile: MashupSourceProfile = {
    role: "vocals",
    bpm: 120,
    musicalKey: "F# major",
    durationMs: 50_000,
    sections: [{ label: "body", startMs: 0, endMs: 50_000 }],
  };
  const bedProfile: MashupSourceProfile = {
    role: "instrumental",
    bpm: 120,
    musicalKey: "C major",
    durationMs: 50_000,
    sections: [{ label: "body", startMs: 0, endMs: 50_000 }],
  };

  const planned = planMashup(vocalProfile, bedProfile);
  assert.ok(planned.ok);
  assert.equal(Math.abs(planned.plan.vocalsPitchSemitones), 6);
  assert.ok(planned.plan.warnings.some((w) => /semitone shift is large/i.test(w)));

  const rendered = renderMashup(planned.plan, {
    vocals: tone(370, 50, 0.4),
    bed: tone(261.63, 50, 0.4),
    sampleRate: RATE,
  });
  assert.equal(rendered.length, 50 * RATE * 2);
});

test("Pair D: Full-length multi-stem arrangement with save, reopen, and WAV export", () => {
  const vocalProfile: MashupSourceProfile = {
    role: "vocals",
    bpm: 124,
    musicalKey: "A minor",
    durationMs: 60_000,
    sections: [
      { label: "intro", startMs: 0, endMs: 8_000 },
      { label: "verse", startMs: 8_000, endMs: 32_000 },
      { label: "chorus", startMs: 32_000, endMs: 56_000 },
      { label: "outro", startMs: 56_000, endMs: 60_000 },
    ],
  };

  const bedProfile: MashupSourceProfile = {
    role: "instrumental",
    bpm: 124,
    musicalKey: "C major",
    durationMs: 120_000,
    sections: [
      { label: "intro", startMs: 0, endMs: 7_742 },
      { label: "verse 1", startMs: 7_742, endMs: 38_710 },
      { label: "chorus 1", startMs: 38_710, endMs: 69_677 },
      { label: "breakdown", startMs: 69_677, endMs: 85_161 },
      { label: "chorus 2", startMs: 85_161, endMs: 116_129 },
      { label: "outro", startMs: 116_129, endMs: 120_000 },
    ],
  };

  const planned = planMashup(vocalProfile, bedProfile);
  assert.ok(planned.ok);
  const plan = planned.plan;

  // Stems from both songs
  const vocalPcm = tone(440, 60, 0.35);
  const bedPcm = tone(130, 120, 0.35);
  const discreteStems = new Map<string, Float32Array>([
    ["drums", tone(65, 120, 0.3)],
    ["bass", tone(130, 120, 0.3)],
  ]);

  const rendered = renderMashup(plan, { vocals: vocalPcm, bed: bedPcm, stems: discreteStems, sampleRate: RATE });

  // Encode to WAV and decode back
  const wavBytes = encodeWav16(rendered, RATE);
  const decoded = decodeWav16(new Uint8Array(wavBytes));
  assert.ok(decoded !== null);
  assert.equal(decoded.frames, 120 * RATE);

  // Reopen and save verification
  const json = JSON.stringify(plan);
  const restored = JSON.parse(json) as MashupPlan;
  assert.deepEqual(restored, plan);
});
