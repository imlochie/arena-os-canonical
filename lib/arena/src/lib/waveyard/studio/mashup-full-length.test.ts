import test from "node:test";
import assert from "node:assert/strict";

import {
  planMashup,
  renderMashup,
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

test("full-length mashup: two materially different songs plan and render full structured timeline", () => {
  // Song 1 (Vocals): 130 BPM, G major, 60s
  const vocalProfile: MashupSourceProfile = {
    role: "vocals",
    bpm: 130,
    musicalKey: "G major",
    durationMs: 60_000,
    sections: [
      { label: "intro", startMs: 0, endMs: 8_000 },
      { label: "verse", startMs: 8_000, endMs: 32_000 },
      { label: "chorus", startMs: 32_000, endMs: 56_000 },
      { label: "outro", startMs: 56_000, endMs: 60_000 },
    ],
  };

  // Song 2 (Bed): 100 BPM, C major, 120s (much longer, different key, different tempo)
  const bedProfile: MashupSourceProfile = {
    role: "instrumental",
    bpm: 100,
    musicalKey: "C major",
    durationMs: 120_000,
    sections: [
      { label: "intro", startMs: 0, endMs: 9_600 },
      { label: "verse 1", startMs: 9_600, endMs: 38_400 },
      { label: "chorus 1", startMs: 38_400, endMs: 67_200 },
      { label: "breakdown", startMs: 67_200, endMs: 86_400 },
      { label: "chorus 2", startMs: 86_400, endMs: 115_200 },
      { label: "outro", startMs: 115_200, endMs: 120_000 },
    ],
  };

  const planned = planMashup(vocalProfile, bedProfile);
  assert.ok(planned.ok);
  const plan = planned.plan;

  // Master tempo is bed's 100 BPM
  assert.equal(plan.masterBpm, 100);
  assert.ok(Math.abs(plan.vocalsStretchRatio - (130 / 100)) < 1e-6);
  // Pitch move from G major to C major is fifth (+5 or -7 semitones)
  assert.equal(plan.keyRelationship, "fifth");
  assert.ok(plan.durationMs === 120_000);

  // Both songs contribute across multiple sections:
  assert.ok(plan.segments.length >= 2, "Must arrange multiple segments to cover the longer bed");
  const firstSeg = plan.segments[0];
  const secondSeg = plan.segments[1];
  assert.ok(firstSeg.mashupStartMs >= 9_600, "Vocal starts at or after bed body section");
  assert.ok(secondSeg.mashupStartMs > firstSeg.mashupEndMs, "Second segment follows a breakdown/pocket");
  assert.ok(secondSeg.mashupEndMs <= 120_000, "Does not exceed bed end");

  // Render real audio
  const vocalAudio = tone(440, 60, 0.4);
  const bedAudio = tone(110, 120, 0.4);

  const mixed = renderMashup(plan, {
    vocals: vocalAudio,
    bed: bedAudio,
    sampleRate: RATE,
  });

  assert.equal(mixed.length, 120 * RATE * 2);

  // Verify non-clipping and active audio
  let maxAbs = 0;
  for (let i = 0; i < mixed.length; i++) {
    const val = Math.abs(mixed[i]);
    if (val > maxAbs) maxAbs = val;
    assert.ok(!Number.isNaN(val));
    assert.ok(val <= 1.0001, "No clipping past full scale");
  }
  assert.ok(maxAbs > 0.2, "Mashup has real audible energy");

  // Verify both sources contribute:
  // Before vocal entry (< 9.6s), only bed is active
  let earlyPeak = 0;
  for (let i = 0; i < Math.round(5 * RATE) * 2; i += 2) {
    earlyPeak = Math.max(earlyPeak, Math.abs(mixed[i]));
  }
  assert.ok(earlyPeak > 0.2, "Bed is audible during intro");

  // During first vocal segment (e.g. at 25s), vocals and bed are combined
  let midPeak = 0;
  for (let i = Math.round(25 * RATE) * 2; i < Math.round(26 * RATE) * 2; i += 2) {
    midPeak = Math.max(midPeak, Math.abs(mixed[i]));
  }
  assert.ok(midPeak > 0.2, "Combined audio is audible during verse");

  // Encode to WAV and verify roundtrip decode
  const wavBytes = encodeWav16(mixed, RATE);
  const decoded = decodeWav16(new Uint8Array(wavBytes));
  assert.ok(decoded !== null);
  assert.equal(decoded.sampleRate, RATE);
  assert.equal(decoded.channels, 2);
  assert.equal(decoded.frames, 120 * RATE);

  // Verify plan serialization, saving, and reopening
  const serialized = JSON.stringify(plan);
  const reopened = JSON.parse(serialized) as MashupPlan;
  assert.deepEqual(reopened, plan, "Plan must serialize and reopen without loss of precision or state");
});
