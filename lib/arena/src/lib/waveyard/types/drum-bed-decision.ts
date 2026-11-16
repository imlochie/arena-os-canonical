/**
 * Retain / replace / layer / reject for a donor drum part over an anchor bed.
 *
 * WHAT THIS DECIDES
 *
 * When a hybrid plays a donor vocal over an anchor bed, the drum question is
 * concrete and singular: the bed already has drums that fit its own harmony and
 * pulse. Does the donor's drum part (a) leave them alone, (b) take their place,
 * (c) play alongside them, or (d) get refused outright?
 *
 * WHAT THIS IS BUILT ON
 *
 * Only evidence that production actually persists and measure: checksum-bound
 * broadband transient onsets per isolated stem, plus the source's own beat grid.
 * Groove profile and groove comparison are the existing cross-stem system
 * (`stem-groove.ts`), reused rather than rebuilt, including its refusals.
 *
 * WHAT THIS DELIBERATELY CANNOT DO
 *
 * - There are NO kick/snare/hat labels in production (`detectDrumTransients`
 *   emits `rhythmicClass: null`). Rhythmic ROLE is therefore not measurable and
 *   is never used as a deciding dimension. It is reported as unavailable.
 * - There is no spectral-overlap measurement, so general MASKING is not
 *   measurable. What IS measurable is the narrower, auditable case: two parts
 *   striking the *same* instants, which is phase-doubling of identical
 *   transients. That is reported as attack coincidence, and never called
 *   masking.
 * - No quality judgement. Which kit sounds better is not measured here and is
 *   never claimed. Every outcome below is a statement about measured
 *   compatibility, not about musical merit.
 *
 * All outcomes are categorical. There is no weighted score and no synthetic
 * confidence value; the raw measurements are attached to the decision so it can
 * be audited and argued with.
 */
import {
  compareStemGrooves,
  stemPulsesAgree,
  type StemGrooveEvidence,
} from "./stem-groove";

export const DONOR_DRUM_DECISION_ENGINE = "waveyard-donor-drum-bed-decision";
export const DONOR_DRUM_DECISION_ENGINE_VERSION = "1.0.0";

/**
 * Two attacks this close together are the same stroke. This is the existing
 * attack-match window `proposeGrooveEntryShift` already uses to pair onsets
 * across stems; reusing it keeps one definition of "the same attack" in the
 * codebase instead of a second, drifting one.
 */
export const DRUM_SAME_STROKE_MS = 35;
/** Tight on-grid tolerance, again matching the existing entry-shift bound. */
export const DRUM_ON_GRID_MS = 8;

/**
 * One placed clip: the section pair the planner actually matched.
 *
 * Both starts are in each source's OWN time. The comparison below maps the
 * donor onto the anchor section's span, so measurements are expressed in the
 * coordinate the anchor's beat grid is already in.
 */
export type DrumPlacement = {
  anchorSectionId: string;
  donorSectionId: string;
  /** Clip length: the anchor section's duration, which the clip is cut to. */
  durationMs: number;
  /** Source-space start of the retained bed section. */
  anchorSourceStartMs: number;
  /** Source-space start of the donor section supplying drums. */
  donorSourceStartMs: number;
};

export type DrumBedMeasurements = {
  /** Donor attacks compared inside a placed clip. */
  comparedOnsets: number;
  /** Donor attacks landing on an anchor attack, i.e. the same stroke. */
  sameStrokeOnsets: number;
  /** Donor attacks occupying a beat phase the anchor leaves empty. */
  complementaryOnsets: number;
  /** Median distance from a donor attack to the nearest anchor attack. */
  medianAttackDistanceMs: number | null;
  /** Measured pulse agreement after the authorized tempo transform. */
  pulseAgreementRatio: number | null;
  /** Feel relationship from the existing cross-stem comparison. */
  feel: ReturnType<typeof compareStemGrooves>["relationship"];
  /** Sections that actually contributed compared attacks. */
  examinedSections: number;
  /** Placed clips that were examined. */
  placedSections: number;
  /**
   * Dimensions the pipeline cannot measure. Named explicitly so an unavailable
   * oddity is never mistaken for an examined one.
   */
  unmeasuredDimensions: string[];
};

export type DrumBedDecision = {
  decision: "retain" | "replace" | "layer" | "reject" | "unavailable";
  /** Why, in terms of the measurement that produced it. */
  reason: string;
  /** Populated whenever anything was measured, including for `unavailable`. */
  measurements: DrumBedMeasurements | null;
};

const UNMEASURED_ROLE =
  "Rhythmic role (kick/snare/hat) is not measured: production transient detection records no instrument class, so no part can be called complementary by role.";
const UNMEASURED_MASKING =
  "General masking is not measured: there is no spectral-overlap evidence, so only simultaneous attacks (phase-doubling) are examined, never audibility.";
const UNMEASURED_QUALITY =
  "Which drum part sounds better is not measured; this decision is about compatibility only.";

const median = (values: number[]) => {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)]!;
};

/** Phase within the beat, and which sixteenth of it, for a timeline instant. */
function beatPhaseAt(at: number, grid: readonly number[]) {
  if (at < grid[0]! || at >= grid.at(-1)!) return null;
  let low = 0;
  let high = grid.length - 1;
  while (low + 1 < high) {
    const mid = (low + high) >>> 1;
    if (grid[mid]! <= at) low = mid;
    else high = mid;
  }
  const period = grid[low + 1]! - grid[low]!;
  const phase = (at - grid[low]!) / period;
  return { beatIndex: low, phase, slot: Math.round(phase * 4) % 4 };
}

/**
 * Decide the drum arrangement for one donor drum part over one anchor bed.
 *
 * `anchorGrid` and `donorGrid` are the sources' own beat grids in source time.
 * `tempoRatio` is the transform the clip plan will actually apply
 * (anchor BPM / donor BPM, or 1 when either tempo is untrusted and no stretch is
 * authorized). Nothing here invents a transform of its own.
 */
export function decideDonorDrumBed(input: {
  anchorGroove: StemGrooveEvidence;
  donorGroove: StemGrooveEvidence;
  anchorGrid: readonly number[] | null | undefined;
  tempoRatio: number;
  placements: readonly DrumPlacement[];
}): DrumBedDecision {
  const { anchorGroove, donorGroove, anchorGrid, tempoRatio, placements } = input;
  const unmeasuredDimensions = [UNMEASURED_ROLE, UNMEASURED_MASKING, UNMEASURED_QUALITY];
  const unavailable = (reason: string, measurements: DrumBedMeasurements | null = null): DrumBedDecision =>
    ({ decision: "unavailable", reason, measurements });

  // 1. Both grooves must be measured. measureStemGroove already refuses without
  //    enough beats, confidence, onsets and beat coverage; inherit that refusal
  //    verbatim instead of papering over it.
  if (anchorGroove.status !== "measured")
    return unavailable(`The anchor bed's own drum part is not measured: ${anchorGroove.reason}`);
  if (donorGroove.status !== "measured")
    return unavailable(`The donor drum part is not measured: ${donorGroove.reason}`);
  if (!placements.length)
    return unavailable("No section pair places the donor drum part, so there is nothing to compare.");
  if (!Number.isFinite(tempoRatio) || tempoRatio <= 0)
    return unavailable("No measured tempo transform places the donor drums on the bed.");

  // 2. Tempo adaptation: the measured pulses must agree once the authorized
  //    transform is applied. Contradiction is not evidence of fit.
  const pulses = stemPulsesAgree(anchorGroove, donorGroove, { bedRatio: 1, donorRatio: tempoRatio });
  if (pulses.status !== "measured")
    return unavailable(pulses.reason);
  if (Math.abs(pulses.agreementRatio - 1) > 0.02)
    return unavailable(
      `The measured drum pulses disagree by ${((pulses.agreementRatio - 1) * 100).toFixed(1)}% after the authorized ${tempoRatio.toFixed(3)}x transform, so the two grids cannot be treated as one pulse.`,
    );

  // 3. Groove compatibility from the existing cross-stem comparison.
  //
  //    Its three answers mean different things and must not be collapsed:
  //    - `unavailable`   : a stem's onsets were never measured. Nothing to judge.
  //    - `rhythmic-contrast`: two DIFFERENT feels were measured. The existing
  //      system refuses to swing-convert that, so the donor cannot be laid over
  //      the bed's drums.
  //    - `context`       : both stems were measured, but a stable eighth-note
  //      feel is not established on both (a part that plays only offbeats has no
  //      on-beat reference). That is a gap in one dimension, not a conflict.
  //      The decision may still proceed on the dimensions that WERE measured
  //      (pulse agreement and beat-position occupancy), but it must say that
  //      feel is unestablished rather than imply it agreed.
  const feel = compareStemGrooves(anchorGroove, donorGroove);
  if (feel.relationship === "unavailable")
    return unavailable(`Groove compatibility is unavailable: ${feel.detail}`);
  if (feel.relationship === "context") {
    unmeasuredDimensions.push(
      `Eighth-note feel is not established on both parts, so it is not part of this decision: ${feel.detail}`,
    );
  }

  // 4. Transient alignment in the coordinate the anchor's grid lives in: the
  //    donor's section is mapped onto the anchor section's span, exactly as the
  //    clip plan maps it.
  const donorOnsets: number[] = [];
  const anchorOnsets: number[] = [];
  const sectionDirections: Array<"same-stroke" | "complementary"> = [];
  let examinedSections = 0;
  for (const placement of placements) {
    const from = placement.anchorSourceStartMs;
    const to = from + placement.durationMs;
    if (!Number.isFinite(placement.durationMs) || placement.durationMs <= 0) continue;
    const anchorInSection = anchorGroove.onsets
      .filter((onset) => onset.timestampMs >= from && onset.timestampMs < to)
      .map((onset) => onset.timestampMs);
    const donorInSection = donorGroove.onsets
      .map((onset) => from + (onset.timestampMs - placement.donorSourceStartMs) * tempoRatio)
      .filter((at) => at >= from && at < to);
    if (!anchorInSection.length || donorInSection.length < 2) continue;
    examinedSections += 1;
    donorOnsets.push(...donorInSection);
    anchorOnsets.push(...anchorInSection);
    // Direction of this section, so a decision cannot claim one uniform answer
    // while the sections it was built from disagree.
    let sameStroke = 0;
    let complementary = 0;
    for (const at of donorInSection) {
      if (anchorInSection.some((anchorAt) => Math.abs(anchorAt - at) <= DRUM_SAME_STROKE_MS)) {
        sameStroke += 1;
        continue;
      }
      const phase = beatPhaseAt(at, anchorGrid ?? []);
      if (phase) {
        const occupied = anchorInSection.some((anchorAt) => {
          const anchorPhase = beatPhaseAt(anchorAt, anchorGrid ?? []);
          return anchorPhase !== null && anchorPhase.beatIndex === phase.beatIndex && anchorPhase.slot === phase.slot;
        });
        if (!occupied) complementary += 1;
      }
    }
    sectionDirections.push(sameStroke >= complementary ? "same-stroke" : "complementary");
  }

  if (!examinedSections)
    return unavailable(
      "No placed clip contains both the bed's own drum attacks and the donor's drum attacks, so the two parts were never compared where they would be heard.",
    );

  // Measured, not assumed: a section where the donor drum part produced no
  // attacks cannot be covered by a single uniform decision.
  if (examinedSections < placements.length)
    return unavailable(
      `Only ${examinedSections} of ${placements.length} placed clips carried comparable drum attacks, so no single decision holds across the arrangement.`,
    );
  if (sectionDirections.some((direction) => direction !== sectionDirections[0]!))
    return unavailable(
      "The placed sections do not agree: the donor's attacks double the bed's drums in some sections and fill different positions in others, so no single drum arrangement is supported across the sections.",
    );

  // Same-stroke and complementary counts are counted once, over the pooled set,
  // using the same rules the per-section direction used.
  let sameStrokeOnsets = 0;
  let complementaryOnsets = 0;
  const distances: number[] = [];
  for (const at of donorOnsets) {
    const nearest = anchorOnsets.reduce<number | null>((best, anchorAt) => {
      const distance = Math.abs(anchorAt - at);
      return best === null || distance < best ? distance : best;
    }, null);
    if (nearest !== null) distances.push(nearest);
    if (nearest !== null && nearest <= DRUM_SAME_STROKE_MS) {
      sameStrokeOnsets += 1;
      continue;
    }
    const phase = beatPhaseAt(at, anchorGrid ?? []);
    if (!phase) continue;
    const occupied = anchorOnsets.some((anchorAt) => {
      const anchorPhase = beatPhaseAt(anchorAt, anchorGrid ?? []);
      return anchorPhase !== null && anchorPhase.beatIndex === phase.beatIndex && anchorPhase.slot === phase.slot;
    });
    if (!occupied) complementaryOnsets += 1;
  }

  const measurements: DrumBedMeasurements = {
    comparedOnsets: donorOnsets.length,
    sameStrokeOnsets,
    complementaryOnsets,
    medianAttackDistanceMs: median(distances),
    pulseAgreementRatio: pulses.agreementRatio,
    feel: feel.relationship,
    examinedSections,
    placedSections: placements.length,
    unmeasuredDimensions,
  };

  // 5. The decision itself. Every branch below turns on a different measured
  //    fact, and none of them is a score.
  if (feel.relationship === "rhythmic-contrast") {
    // Two measured eighth-note feels that disagree, in the same instrument role
    // (both are the kit — no role labels exist to prove otherwise). The existing
    // system refuses to swing-convert a measured contrast, so the donor drums
    // cannot be laid over the bed's drums.
    return {
      decision: "reject",
      reason: `The donor drum part's measured eighth-note feel differs from the bed's (${feel.detail.trim()}) and there are no rhythmic-role measurements to establish it as a separate, complementary part, so it is refused rather than layered or time-converted.`,
      measurements,
    };
  }

  if (complementaryOnsets > sameStrokeOnsets) {
    // Positive evidence for layering: the two parts were measured on one pulse
    // and no feel conflict was found, and most donor attacks occupy beat
    // positions the bed's drums leave empty. The reason states the feel
    // situation exactly, including when it was not established.
    const feelClause = feel.relationship === "similar-feel"
      ? "On a measured similar eighth-note feel"
      : "With no measured feel conflict (a stable eighth-note feel is not established on both parts)";
    return {
      decision: "layer",
      reason: `${feelClause}, ${complementaryOnsets} of ${donorOnsets.length} donor attacks occupy beat positions the bed's drums leave empty and only ${sameStrokeOnsets} double an existing stroke, so the parts are complementary rather than duplicative.`,
      measurements,
    };
  }

  // Same strokes dominate: the two parts hit the same instants, so keeping both
  // would double identical transients. Exactly one part is kept.
  if (sameStrokeOnsets > 0 && sameStrokeOnsets * 2 > donorOnsets.length
    && measurements.medianAttackDistanceMs !== null
    && measurements.medianAttackDistanceMs <= DRUM_ON_GRID_MS) {
    // The requested donor sits tightly on the bed's measured grid and would
    // simply duplicate it, so the request can be honoured without measured harm.
    return {
      decision: "replace",
      reason: `The donor drum part sits on the bed's pulse (median attack distance ${measurements.medianAttackDistanceMs.toFixed(1)} ms) with the same measured feel, and ${sameStrokeOnsets} of ${donorOnsets.length} attacks double the bed's strokes, so it substitutes for the bed's drums instead of playing alongside them.`,
      measurements,
    };
  }

  // Same strokes dominate but not tightly enough to certify a substitute: the
  // request cannot be honoured without measured harm, and nothing measured
  // argues for adding a second part.
  return {
    decision: "retain",
    reason: measurements.medianAttackDistanceMs === null
      ? "No donor attack could be placed against a bed attack, so the bed keeps its own drums."
      : `The donor's attacks do not land on the bed's grid (median attack distance ${measurements.medianAttackDistanceMs.toFixed(1)} ms) and do not fill positions the bed leaves empty, so the bed keeps its own drums.`,
    measurements,
  };
}
