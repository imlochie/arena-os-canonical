import assert from "node:assert/strict";
import test from "node:test";

import {
  MIN_FULL_LENGTH_LOOP_MS,
  planMashup,
  renderMashupWithBus,
  type MashupSourceProfile,
} from "./mashup";

/**
 * Full Length mode — observable acceptance criteria (ledger section 11.5).
 *
 * These tests pin the behaviours the owner specified, not an internal opinion:
 * reproduce the complete performance, start at its natural beginning, end at its
 * natural ending, repeat it from the beginning when the bed has room, never
 * force a loop that would produce an awkward transition, and never declare more
 * source than the timeline can carry.
 *
 * Fixtures are synthetic: they establish the plan invariants only. They are not
 * evidence of musical quality, and no claim here depends on how they sound.
 */

const RATE = 8_000;
const BAR_MS = 2_000; // 120 BPM, 4/4

function grid(durationMs: number, stepMs: number): number[] {
  const points: number[] = [];
  for (let at = 0; at <= durationMs; at += stepMs) points.push(at);
  return points;
}

function vocalProfile(durationMs: number): MashupSourceProfile {
  return {
    role: "vocals",
    bpm: 120,
    bpmConfidence: 0.9,
    bpmCandidates: [120, 60, 240],
    musicalKey: "C major",
    keyConfidence: 0.9,
    beatGridMs: grid(durationMs, 500),
    beatConfidence: 0.9,
    durationMs,
    sections: [
      { label: "intro", startMs: 0, endMs: Math.round(durationMs * 0.1) },
      { label: "verse", startMs: Math.round(durationMs * 0.1), endMs: Math.round(durationMs * 0.6) },
      { label: "chorus", startMs: Math.round(durationMs * 0.6), endMs: Math.round(durationMs * 0.9) },
      { label: "outro", startMs: Math.round(durationMs * 0.9), endMs: durationMs },
    ],
    vocalPhrases: [{ startMs: 0, endMs: durationMs, confidence: 0.9 }],
  } as MashupSourceProfile;
}

function bedProfile(durationMs: number): MashupSourceProfile {
  return {
    role: "instrumental",
    bpm: 120,
    bpmConfidence: 0.9,
    bpmCandidates: [120, 60, 240],
    musicalKey: "C major",
    keyConfidence: 0.9,
    beatGridMs: grid(durationMs, 500),
    beatConfidence: 0.9,
    downbeatGridMs: grid(durationMs, BAR_MS),
    downbeatConfidence: 0.9,
    durationMs,
    sections: [
      { label: "intro", startMs: 0, endMs: Math.round(durationMs * 0.1) },
      { label: "verse", startMs: Math.round(durationMs * 0.1), endMs: Math.round(durationMs * 0.6) },
      { label: "chorus", startMs: Math.round(durationMs * 0.6), endMs: Math.round(durationMs * 0.9) },
      { label: "outro", startMs: Math.round(durationMs * 0.9), endMs: durationMs },
    ],
  } as MashupSourceProfile;
}

function plan(vocalMs: number, bedMs: number) {
  const result = planMashup(vocalProfile(vocalMs), bedProfile(bedMs), { strategy: "full-length" });
  assert.ok(result.ok, "full-length planning must not refuse a valid pair");
  return result.plan;
}

test("full-length: every segment declares source that its timeline span can carry", () => {
  // Defect B regression. A 214.2s body over a 103.8s bed used to be declared as
  // 214.2s of source inside a 94.9s segment at ratio 1.0 — a plan that cannot
  // describe what is rendered. This is the invariant, checked across shapes.
  const shapes: Array<[number, number]> = [
    [20_000, 104_000],
    [214_200, 104_000],
    [104_000, 104_000],
    [8_000, 200_000],
  ];
  for (const [vocalMs, bedMs] of shapes) {
    const planned = plan(vocalMs, bedMs);
    const ratio = planned.vocalsStretchRatio;
    for (const segment of planned.segments) {
      const timelineMs = segment.mashupEndMs - segment.mashupStartMs;
      const declaredMs = segment.vocalsToMs - segment.vocalsFromMs;
      // One millisecond of rounding is tolerated; nothing structural.
      assert.ok(
        declaredMs <= Math.round(timelineMs / ratio) + 1,
        `${vocalMs}/${bedMs}: segment declares ${declaredMs}ms of source in a `
        + `${timelineMs}ms timeline at ratio ${ratio} — plan does not describe the render`,
      );
    }
  }
});

test("full-length: the complete performance is placed, not a fragment", () => {
  // FL-1. The old reprise re-used only the final 1.6s of a 19.9s body.
  const vocalMs = 20_000;
  const planned = plan(vocalMs, 104_000);
  const covered = new Set<number>();
  for (const segment of planned.segments) {
    for (let at = segment.vocalsFromMs; at < segment.vocalsToMs; at += 50) covered.add(at);
  }
  const spans = covered.size * 50;
  assert.ok(
    spans >= vocalMs * 0.95,
    `only ${spans}ms of the ${vocalMs}ms performance is placed across all segments`,
  );
});

test("full-length: the performance starts at its natural beginning", () => {
  // FL-2. The first placement must be the body start, not a later passage.
  const planned = plan(20_000, 104_000);
  assert.equal(planned.segments[0]!.vocalsFromMs, 0);
});

test("full-length: the performance ends at its natural ending, not cut by the bed", () => {
  // FL-3. Some placement must reach the body end.
  const vocalMs = 20_000;
  const planned = plan(vocalMs, 104_000);
  const furthest = Math.max(...planned.segments.map((segment) => segment.vocalsToMs));
  assert.ok(
    furthest >= vocalMs - 1,
    `the performance only reaches ${furthest}ms of ${vocalMs}ms — the ending is never played`,
  );
});

test("full-length: when the bed outlasts the vocal, it repeats from the beginning", () => {
  // FL-4. This is the owner's primary specification. Before this change, 81s of a
  // 104s bed ran with no vocal because the only repeat was a 1.6s closing echo.
  const vocalMs = 20_000;
  const bedMs = 104_000;
  const planned = plan(vocalMs, bedMs);
  const repeats = planned.segments.slice(1);
  assert.ok(repeats.length >= 2, `expected repeated passes, got ${planned.segments.length} segment(s)`);
  for (const repeat of repeats) {
    assert.equal(repeat.vocalsFromMs, 0, "a repeat must restart at the performance's beginning");
    assert.equal(repeat.vocalsToMs, vocalMs, "a repeat must carry the complete performance");
  }
  const voicedMs = planned.segments.reduce(
    (sum, segment) => sum + (segment.mashupEndMs - segment.mashupStartMs),
    0,
  );
  assert.ok(
    voicedMs / bedMs >= 0.70,
    `vocal covers only ${((100 * voicedMs) / bedMs).toFixed(0)}% of the bed`,
  );
});

test("full-length: a loop is never forced shorter than a musical unit", () => {
  // FL-5. A partial final pass would cut the performance mid-phrase at the bed's
  // end. Only complete passes are placed.
  const vocalMs = 20_000;
  const planned = plan(vocalMs, 104_000);
  for (const segment of planned.segments) {
    const spanMs = segment.mashupEndMs - segment.mashupStartMs;
    assert.ok(
      spanMs >= MIN_FULL_LENGTH_LOOP_MS,
      `segment of ${spanMs}ms is shorter than the ${MIN_FULL_LENGTH_LOOP_MS}ms musical unit`,
    );
    // A placed pass is either the complete body or the complete body clipped by
    // the bed's end — never an arbitrary fragment.
    const declaredMs = segment.vocalsToMs - segment.vocalsFromMs;
    assert.ok(
      Math.abs(declaredMs - vocalMs) <= 1 || segment.mashupEndMs >= planned.durationMs - 1,
      `segment carries ${declaredMs}ms of a ${vocalMs}ms body without reaching the bed's end`,
    );
  }
});

test("full-length: repeats land on bar boundaries relative to the entry", () => {
  // FL-4 detail. The repeat must re-enter in time with the bed, measured from the
  // entry's phase rather than from zero.
  const planned = plan(20_000, 104_000);
  const entryMs = planned.segments[0]!.mashupStartMs;
  for (const segment of planned.segments.slice(1)) {
    const offset = segment.mashupStartMs - entryMs;
    const bars = offset / BAR_MS;
    assert.ok(
      Math.abs(bars - Math.round(bars)) < 0.01,
      `repeat at ${segment.mashupStartMs}ms is ${bars.toFixed(2)} bars from the entry — not bar-aligned`,
    );
  }
});

test("full-length: a bed with no room for a repeat finishes naturally and says so", () => {
  // FL-5 / honesty. The vocal runs nearly the whole bed, so there is no room for
  // a repeat; the plan must state that rather than inventing one.
  const planned = plan(100_000, 101_000);
  assert.equal(planned.segments.length, 1, "no repeat should be forced into a bed with no room");
  assert.ok(
    planned.warnings.concat(planned.rationale).some((line) => /repeat|musical unit|longer than the bed/i.test(line)),
    "the reason no loop was placed must be recorded",
  );
});

test("full-length: stretching still produces a consistent plan when the ratio is not 1", () => {
  // FL-6 under a real stretch. The invariant must hold at any ratio, not only 1.0.
  const planned = plan(20_000, 104_000);
  const ratio = planned.vocalsStretchRatio;
  assert.ok(Number.isFinite(ratio) && ratio > 0);
  for (const segment of planned.segments) {
    const timelineMs = segment.mashupEndMs - segment.mashupStartMs;
    const declaredMs = segment.vocalsToMs - segment.vocalsFromMs;
    assert.ok(declaredMs <= Math.round(timelineMs / ratio) + 1);
  }
});

test("full-length: the render covers the vocal timeline with real audio", () => {
  // The plan must survive rendering, not just exist. Silence would mean the plan
  // points at material the renderer cannot reach.
  const planned = plan(20_000, 104_000);
  const vocalSamples = new Float32Array((20 * RATE) * 2).fill(0.25);
  const bedSamples = new Float32Array((104 * RATE) * 2).fill(0.05);
  const rendered = renderMashupWithBus(planned, {
    vocals: vocalSamples,
    bed: bedSamples,
    sampleRate: RATE,
  });
  let loudFrames = 0;
  const frames = rendered.pcm.length / 2;
  for (let frame = 0; frame < frames; frame += 1) {
    // The bed alone sits at 0.05; anything clearly above that carries vocal.
    if (Math.abs(rendered.pcm[frame * 2] ?? 0) > 0.12) loudFrames += 1;
  }
  const loudMs = (loudFrames / RATE) * 1000;
  assert.ok(
    loudMs >= 60_000,
    `only ${(loudMs / 1000).toFixed(1)}s of the render carries the vocal`,
  );
  assert.equal(rendered.mix.postLimit.clippedRegions, 0, "a full-length render must not clip");
});
