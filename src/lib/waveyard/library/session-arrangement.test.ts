import test from "node:test";
import assert from "node:assert/strict";
import { sessionPlacements, sessionVolumePoints } from "./session-arrangement";
import { defaultTransitionConfig, normalizeTransitionConfig } from "./session-logic";
const a = "11111111-1111-4111-8111-111111111111", b = "22222222-2222-4222-8222-222222222222", c = "33333333-3333-4333-8333-333333333333";
function items() { return [
  { id: a, durationSeconds: 10, transition: { ...defaultTransitionConfig(), crossfadeSeconds: 2, keepStems: ["drums"], cue: { toSessionTrackId: b, fromDeck: 0 as const, toDeck: 1 as const, fromSeconds: 4, incomingSeconds: 1 } } },
  { id: b, durationSeconds: 12, transition: { ...defaultTransitionConfig(), crossfadeSeconds: 1, cue: { toSessionTrackId: c, fromDeck: 1 as const, toDeck: 0 as const, fromSeconds: 6, incomingSeconds: 2 } } },
  { id: c, durationSeconds: 8, transition: defaultTransitionConfig() },
]; }
test("consecutive completed crossfades preserve ranges and held outgoing stems", () => {
  const plan = sessionPlacements(items());
  assert.deepEqual(plan.map((p) => [p.timelineStartMs, p.sourceStartMs, p.sourceEndMs, p.fadeInMs, p.fadeOutMs]), [[0, 0, 6000, 0, 2000], [4000, 1000, 7000, 2000, 1000], [9000, 2000, 8000, 1000, 0]]);
  assert.deepEqual(sessionVolumePoints(plan[0], "drums", 0.4), [{ timelineMs: 0, value: 0.4 }]);
  assert.deepEqual(sessionVolumePoints(plan[0], "vocals", 0.4), [{ timelineMs: 0, value: 0.4 }, { timelineMs: 4000, value: 0.4 }, { timelineMs: 6000, value: 0 }]);
  assert.deepEqual(sessionVolumePoints(plan[1], "drums", 0.5), [{ timelineMs: 4000, value: 0 }, { timelineMs: 6000, value: 0.5 }, { timelineMs: 9000, value: 0.5 }, { timelineMs: 10000, value: 0 }]);
});
test("unrecorded/reordered/mismatched physical decks and impossible ranges are refused", () => {
  const noCue = items(); delete (noCue[0].transition as { cue?: unknown }).cue;
  assert.throws(() => sessionPlacements(noCue), /no completed transition/);
  const reordered = items(); [reordered[1], reordered[2]] = [reordered[2], reordered[1]];
  assert.throws(() => sessionPlacements(reordered), /no completed transition/);
  const short = items(); short[0].durationSeconds = 5;
  assert.throws(() => sessionPlacements(short), /invalid source range/);
  const early = items(); early[1].transition.cue!.fromSeconds = 2;
  assert.throws(() => sessionPlacements(early), /overlapping transitions/);
  const wrongDeck = items(); wrongDeck[1].transition.cue!.fromDeck = 0;
  assert.throws(() => sessionPlacements(wrongDeck), /deck identities/);
});
test("historical configs remain valid; malformed present cues cannot silently disappear", () => {
  assert.deepEqual(normalizeTransitionConfig(defaultTransitionConfig()), defaultTransitionConfig());
  assert.deepEqual(normalizeTransitionConfig(items()[0].transition), items()[0].transition);
  for (const cue of [null, {}, { ...items()[0].transition.cue, fromSeconds: NaN }, { ...items()[0].transition.cue, toDeck: 0 }])
    assert.equal(normalizeTransitionConfig({ ...defaultTransitionConfig(), cue }), null);
});
