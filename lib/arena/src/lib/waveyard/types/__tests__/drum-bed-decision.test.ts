/**
 * Donor drum retain / replace / layer / reject.
 *
 * These tests hand `buildAutomaticRemixPlan` the same evidence shape production
 * attaches (`drumEvidence` = checksum-bound transient onsets + the source's own
 * beat grid), so the assertions are about the REAL planner path and not about a
 * helper that production never calls.
 *
 * What is asserted here is deliberately narrow: which of the four drum
 * arrangements the planner chooses, and that it returns `unavailable` -- not a
 * preference -- when the evidence cannot support an answer. Nothing here claims
 * the result sounds good; no listening test has been performed.
 */
import assert from "node:assert/strict";
import test from "node:test";

import { buildAutomaticRemixPlan, type AutomaticRemixSource } from "../index";
import { DRUM_ANALYSIS_ENGINE, DRUM_ANALYSIS_ENGINE_VERSION } from "../drum-analysis";

const GRID = Array.from({ length: 33 }, (_, index) => index * 500);
const BEAT = 500;

/** Onsets at given phase offsets (in beats) from every beat of a 16 s grid. */
function onsets(phases: number[], offsetMs = 0) {
  return GRID.slice(0, -1).flatMap((at) => phases.map((phase) => ({
    timestampMs: Math.round(at + phase * BEAT + offsetMs),
    strength: phase === 0 ? 1 : 0.7,
    confidence: 0.95,
  }))).filter((event) => event.timestampMs <= 16_000);
}

function source(input: {
  id: string;
  bpm?: number;
  beatGridMs?: number[];
  drumEvents?: ReturnType<typeof onsets> | null;
  drumStemType?: string;
  sections?: Array<{ startMs: number; endMs: number }>;
}): AutomaticRemixSource {
  const { id } = input;
  const bpm = input.bpm ?? 120;
  const beatGrid = input.beatGridMs ?? GRID;
  const sections = input.sections ?? [{ startMs: 0, endMs: 8_000 }, { startMs: 8_000, endMs: 16_000 }];
  return {
    id,
    originalFilename: `${id}.wav`,
    checksumSha256: `${id}-checksum`,
    durationMs: 16_000,
    analysis: {
      id: `${id}-analysis`, status: "complete", sourceChecksumSha256: `${id}-checksum`,
      bpm, bpmConfidence: 0.9, musicalKey: "C major", keyConfidence: 0.9,
      beatConfidence: 0.9, beatGridMs: beatGrid,
    },
    sections: sections.map((section, index) => ({
      id: `${id}-s${index}`, sectionIndex: index,
      startMs: section.startMs, endMs: section.endMs,
      label: "section", labelConfidence: 0, structuralConfidence: 0.9,
    })),
    stems: [
      { id: `${id}-drums`, sourceAssetId: id, stemType: "drums", durationMs: 16_000, checksumSha256: `${id}-drums-checksum` },
      { id: `${id}-bass`, sourceAssetId: id, stemType: "bass", durationMs: 16_000, checksumSha256: `${id}-bass-checksum` },
      { id: `${id}-other`, sourceAssetId: id, stemType: "other", durationMs: 16_000, checksumSha256: `${id}-other-checksum` },
      { id: `${id}-vocals`, sourceAssetId: id, stemType: "vocals", durationMs: 16_000, checksumSha256: `${id}-vocals-checksum` },
    ],
    // Absent means "not measured", never "compatible".
    ...(input.drumEvents === null ? {} : {
      drumEvidence: input.drumEvents
        ? {
          analysisEngine: DRUM_ANALYSIS_ENGINE,
          analysisEngineVersion: DRUM_ANALYSIS_ENGINE_VERSION,
          stemAssetId: `${id}-drums`,
          stemType: input.drumStemType ?? "drums",
          stemChecksumSha256: `${id}-drums-checksum`,
          sourceChecksumSha256: `${id}-checksum`,
          events: input.drumEvents,
        }
        : undefined,
    }),
  };
}

/**
 * Sections whose fingerprints match, so a hybrid passage can actually be built.
 * Reuses the same measured fingerprint the existing planner tests use.
 */
function withFingerprints(input: AutomaticRemixSource): AutomaticRemixSource {
  const measure = <T>(value: T) => ({ status: "measured" as const, value, method: "fixture", confidence: 0.95 });
  return {
    ...input,
    sections: input.sections.map((section) => ({
      ...section,
      passageFingerprint: {
        schemaVersion: 3 as const,
        engine: "waveyard-passage-fingerprint" as const,
        engineVersion: "2.2.0" as const,
        sourceChecksumSha256: input.checksumSha256,
        startBeatIndex: section.startMs / 500,
        endBeatIndex: section.endMs / 500,
        rhythm: measure(Array.from({ length: (section.endMs - section.startMs) / 125 }, (_, index) => Number(index % 4 === 0))),
        chroma: measure(Array.from({ length: 48 }, (_, index) => {
          const pitch = index % 12;
          return pitch === 0 ? 1 : pitch === 4 ? 0.75 : pitch === 7 ? 0.5 : 0.02;
        })),
        beatPhase: measure({ subdivisionProfile: [0.9, 0.05, 0.03, 0.02], beatPeriodMs: 500 }),
        energy: measure({ rmsDb: -12 }),
        downbeatConfidence: measure(0.95),
        vocalActivity: { status: "unavailable" as const, reason: "fixture" },
        instrumentalDensity: { status: "unavailable" as const, reason: "fixture" },
        stemActivity: { status: "unavailable" as const, reason: "fixture" },
      },
    })),
  };
}

function planFor(anchor: AutomaticRemixSource, donor: AutomaticRemixSource, drumsStemId: string) {
  const result = buildAutomaticRemixPlan(
    [withFingerprints(anchor), withFingerprints(donor)],
    { variant: "hybrid", anchorSourceId: anchor.id, drumsStemId },
  );
  return result;
}

function drumDecisionOf(result: ReturnType<typeof planFor>) {
  assert.equal(result.ok, true, `the planner must build a plan: ${JSON.stringify(result).slice(0, 400)}`);
  if (!result.ok) throw new Error("unreachable");
  const decisions = result.plan.provenance.drumBedDecisions;
  assert.ok(decisions?.length, "the plan must expose the drum decision it made");
  return decisions![0]!;
}

function drumTrackIds(result: ReturnType<typeof planFor>) {
  assert.equal(result.ok, true, `the planner must build a plan: ${JSON.stringify(result).slice(0, 400)}`);
  if (!result.ok) throw new Error("unreachable");
  return result.plan.tracks.filter((track) => track.stemType === "drums").map((track) => track.stemAssetId);
}

// A bed with a plain on-beat backbeat: attacks on every beat and every offbeat
// eighth, which is what makes an on-grid donor provably duplicative.
const BED_DRUMS = onsets([0, 0.5]);

test("an on-grid donor drum part replaces the bed's drums instead of doubling them", () => {
  const anchor = source({ id: "bed", drumEvents: BED_DRUMS });
  const donor = source({ id: "donor", drumEvents: onsets([0, 0.5]) });
  const result = planFor(anchor, donor, "donor-drums");
  const decision = drumDecisionOf(result);
  assert.equal(decision.outcome, "replace",
    `an identical measured pattern on one grid must substitute, not stack: ${decision.reason}`);
  // The outcome must be real: the selected drum track is the donor's, not the bed's.
  const drums = drumTrackIds(result);
  assert.deepEqual(drums, ["donor-drums"],
    "replacing must actually swap the drum track, not merely say so");
  assert.ok(decision.measurements, "a measured decision must carry its measurements");
  assert.ok(decision.measurements!.sameStrokeOnsets > 0, "the decision must rest on measured same-stroke attacks");
  assert.ok(Math.abs((decision.measurements!.pulseAgreementRatio ?? 0) - 1) < 0.02,
    "the two parts must genuinely share a measured pulse");
  // Role and masking are NOT measurable and must be reported as such.
  assert.ok(decision.measurements!.unmeasuredDimensions.some((dimension) => dimension.includes("Rhythmic role")));
  assert.ok(decision.measurements!.unmeasuredDimensions.some((dimension) => dimension.includes("masking")));
});

test("a donor filling positions the bed leaves empty layers instead of replacing", () => {
  // The bed plays on the beat only; the donor plays the offbeats and the
  // sixteenths between them, so the two parts occupy different positions.
  const anchor = source({ id: "bed", drumEvents: onsets([0]) });
  const donor = source({ id: "donor", drumEvents: onsets([0.25, 0.5, 0.75]) });
  const result = planFor(anchor, donor, "donor-drums");
  const decision = drumDecisionOf(result);
  assert.equal(decision.outcome, "layer",
    `attacks that fill empty beat positions on a shared pulse must layer: ${decision.reason}`);
  const drums = drumTrackIds(result);
  assert.deepEqual([...drums].sort(), ["bed-drums", "donor-drums"],
    "layering must genuinely keep both drum tracks");
  assert.ok(decision.measurements!.complementaryOnsets > 0);
});

test("a donor that neither doubles the bed tightly nor fills gaps leaves the bed's drums alone", () => {
  // Both parts hit every beat, but the donor lands ~20 ms late: close enough to
  // count as the same stroke, too loose to certify as a substitute, and not
  // filling any position the bed leaves empty. Stacking them would flam, so the
  // bed keeps its own drums.
  const anchor = source({ id: "bed", drumEvents: onsets([0]) });
  const donor = source({ id: "donor", drumEvents: onsets([0], 20) });
  const decision = drumDecisionOf(planFor(anchor, donor, "donor-drums"));
  assert.equal(decision.outcome, "retain",
    `a loose duplicate is neither a substitute nor an addition: ${decision.reason}`);
  assert.ok(decision.measurements!.medianAttackDistanceMs! > 8,
    "the decision must rest on the measured attack distance, not a guess");
  assert.deepEqual(drumTrackIds(planFor(anchor, donor, "donor-drums")), ["bed-drums"],
    "retaining must leave exactly the bed's own drum track");
});

test("a measured rhythmic contrast rejects the donor drums rather than time-converting them", () => {
  // Straight eighths against a stable swung eighth: the existing groove
  // comparison measures this as contrast and refuses to convert it.
  const anchor = source({ id: "bed", drumEvents: onsets([0, 0.5]) });
  const donor = source({ id: "donor", drumEvents: onsets([0, 2 / 3]) });
  const result = planFor(anchor, donor, "donor-drums");
  const decision = drumDecisionOf(result);
  assert.equal(decision.outcome, "reject",
    `measured feel contrast must refuse the donor drums: ${decision.reason}`);
  const drums = drumTrackIds(result);
  assert.deepEqual(drums, ["bed-drums"],
    "a rejected donor must leave the bed's own drums in place");
});

test("missing drum evidence is reported as insufficient rather than resolved into a preference", () => {
  const anchor = source({ id: "bed", drumEvents: BED_DRUMS });
  const donor = source({ id: "donor", drumEvents: null });
  const result = planFor(anchor, donor, "donor-drums");
  const decision = drumDecisionOf(result);
  assert.equal(decision.outcome, "unavailable",
    "no donor drum evidence must answer unavailable, never retain-by-default");
  assert.equal(decision.measurements, null, "nothing was measured, so nothing may be reported as measured");
  assert.deepEqual(drumTrackIds(result), ["bed-drums"],
    "an unavailable decision must not remove the bed's drums");
  assert.match(decision.reason, /no checksum-current drum transient evidence/i);
});

test("a bed with no measured drum part cannot be compared against at all", () => {
  const anchor = source({ id: "bed", drumEvents: null });
  const donor = source({ id: "donor", drumEvents: onsets([0, 0.5]) });
  const result = planFor(anchor, donor, "donor-drums");
  const decision = drumDecisionOf(result);
  assert.equal(decision.outcome, "unavailable");
  assert.match(decision.reason, /bed bed\.wav has no checksum-current drum/i);
});

test("a donor whose pulse disagrees after the authorized transform is not stretched into place", () => {
  // 120 vs 125 BPM is inside the passage-compatibility tempo band, so the hybrid
  // itself is legitimate. Its drum grid is 480 ms against the bed's 500 ms, and
  // the authorized 0.96x transform does not reconcile the two pulses.
  const anchor = source({ id: "bed", drumEvents: BED_DRUMS });
  const donorGrid = Array.from({ length: 34 }, (_, index) => index * 480);
  const donor = source({
    id: "donor",
    bpm: 125,
    beatGridMs: donorGrid,
    drumEvents: donorGrid.slice(0, -1).flatMap((at) => [0, 0.5].map((phase) => ({
      timestampMs: Math.round(at + phase * 480), strength: 0.8, confidence: 0.95,
    }))).filter((event) => event.timestampMs <= 16_000),
  });
  const decision = drumDecisionOf(planFor(anchor, donor, "donor-drums"));
  assert.equal(decision.outcome, "unavailable",
    `pulses the authorized transform cannot reconcile must not be forced together: ${decision.reason}`);
  assert.match(decision.reason, /pulse/i);
});

test("an untrusted tempo refuses the hybrid before any drum decision is claimed", () => {
  // Same 480 ms grid with no donor tempo confidence. Passage compatibility
  // requires trusted tempo on both sides, so no hybrid is built and no drum
  // judgement is emitted at all. That is the correct answer: the drum question
  // is never asked, so it must never be answered.
  const anchor = source({ id: "bed", drumEvents: BED_DRUMS });
  const donorGrid = Array.from({ length: 34 }, (_, index) => index * 480);
  const donor = source({
    id: "donor",
    bpm: 125,
    beatGridMs: donorGrid,
    drumEvents: donorGrid.slice(0, -1).flatMap((at) => [0, 0.5].map((phase) => ({
      timestampMs: Math.round(at + phase * 480), strength: 0.8, confidence: 0.95,
    }))).filter((event) => event.timestampMs <= 16_000),
  });
  const untrusted = { ...donor, analysis: donor.analysis ? { ...donor.analysis, bpmConfidence: 0 } : null };
  const result = planFor(anchor, untrusted, "donor-drums");
  assert.equal(result.ok, false, "an untrusted tempo must not produce a hybrid plan");
  if (result.ok) return;
  assert.equal(result.reason, "no_compatible_hybrid_source");
  assert.equal((result.compatibility?.pairs ?? []).some((pair) => pair.eligible), false,
    "no passage may be certified on untrusted tempo");
});

test("a stale drum analysis engine is not read as evidence", () => {
  const anchor = source({ id: "bed", drumEvents: BED_DRUMS });
  const donor = source({ id: "donor", drumEvents: onsets([0, 0.5]) });
  const stale = {
    ...donor,
    drumEvidence: donor.drumEvidence ? { ...donor.drumEvidence, analysisEngineVersion: "0.0.1" } : null,
  };
  const decision = drumDecisionOf(planFor(anchor, stale, "donor-drums"));
  assert.equal(decision.outcome, "unavailable",
    "a row from an older engine measured something else and must not be trusted");
});

test("a drum analysis bound to different stem bytes is refused", () => {
  const anchor = source({ id: "bed", drumEvents: BED_DRUMS });
  const donor = source({ id: "donor", drumEvents: onsets([0, 0.5]) });
  const tampered = {
    ...donor,
    drumEvidence: donor.drumEvidence ? { ...donor.drumEvidence, stemChecksumSha256: "different-bytes" } : null,
  };
  const decision = drumDecisionOf(planFor(anchor, tampered, "donor-drums"));
  assert.equal(decision.outcome, "unavailable",
    "checksum-bound evidence that no longer matches the stem must not justify a choice");
});

test("the decision is categorical, not a weighted score", () => {
  const anchor = source({ id: "bed", drumEvents: BED_DRUMS });
  const donor = source({ id: "donor", drumEvents: onsets([0, 0.5]) });
  const decision = drumDecisionOf(planFor(anchor, donor, "donor-drums"));
  assert.ok(["retain", "replace", "layer", "reject", "unavailable"].includes(decision.outcome));
  // No synthetic confidence is emitted anywhere in the decision.
  assert.equal(Object.prototype.hasOwnProperty.call(decision, "confidence"), false);
  assert.equal(Object.prototype.hasOwnProperty.call(decision.measurements ?? {}, "score"), false);
});
