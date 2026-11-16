import {
  assessBassLine,
  bassContradictsHarmony,
  type BassHarmonyChord,
  type BassLineNote,
  type BassLineResult,
} from "./bass-harmony-fit";

export type BassLineEvidenceSummary =
  | {
    status: "measured";
    supportShare: number;
    motionShare: number;
    contradictionShare: number;
    judgedMs: number;
    unjudgedMs: number;
    examinedMs: number;
    distinctPitches: number;
    bedChordChanges: number;
  }
  | { status: "unavailable"; reason: string };

export type DonorBassBedDecision = {
  outcome: "retain" | "replace" | "reject" | "unavailable";
  reason: string;
  measurements: {
    fromMs: number;
    toMs: number;
    donorBass: BassLineEvidenceSummary;
    retainedBedBass: BassLineEvidenceSummary;
  };
};

function summarise(result: BassLineResult): BassLineEvidenceSummary {
  if (result.status === "unavailable") return result;
  return {
    status: "measured",
    supportShare: result.supportShare,
    motionShare: result.motionShare,
    contradictionShare: result.contradictionShare,
    judgedMs: result.judgedMs,
    unjudgedMs: result.unjudgedMs,
    examinedMs: result.examinedMs,
    distinctPitches: result.distinctPitches,
    bedChordChanges: result.bedChordChanges,
  };
}

/**
 * Compare the donor bass and bed bass against one checksum-current chord
 * timeline. This can recommend replacement only when the donor avoids the
 * existing unresolved-contradiction criterion and the retained bed bass fails
 * it. It never recommends layering: pitch/chord evidence cannot establish
 * whether two bass parts will mask each other or sound better together.
 *
 * The caller supplies notes in source time. The current Mashup render composes
 * donor and bed stems from the same source-clock origin, then applies the
 * shared bed timing transform; neither bass line is independently transposed.
 */
export function decideDonorBassBed(input: {
  donorBass: readonly BassLineNote[];
  retainedBedBass: readonly BassLineNote[];
  bedChords: readonly BassHarmonyChord[];
  fromMs: number;
  toMs: number;
}): DonorBassBedDecision {
  const { donorBass, retainedBedBass, bedChords, fromMs, toMs } = input;
  const donor = assessBassLine({ notes: donorBass, bedChords, fromMs, toMs });
  const retained = assessBassLine({ notes: retainedBedBass, bedChords, fromMs, toMs });
  const measurements = {
    fromMs,
    toMs,
    donorBass: summarise(donor),
    retainedBedBass: summarise(retained),
  };

  if (donor.status !== "measured") {
    return {
      outcome: "unavailable",
      reason: `Donor bass cannot be compared: ${donor.reason}`,
      measurements,
    };
  }
  if (retained.status !== "measured") {
    return {
      outcome: "unavailable",
      reason: `The bed's existing bass cannot be compared: ${retained.reason}`,
      measurements,
    };
  }

  const donorVerdict = bassContradictsHarmony(donor);
  const retainedVerdict = bassContradictsHarmony(retained);
  if (!donorVerdict.contradicts && retainedVerdict.contradicts) {
    return {
      outcome: "replace",
      reason: `The donor line avoids majority unresolved contradiction with the bed chords; the retained bed line does not (${retainedVerdict.reason}). This supports replacement on harmonic evidence only, not sound quality.`,
      measurements,
    };
  }
  if (donorVerdict.contradicts && !retainedVerdict.contradicts) {
    return {
      outcome: "reject",
      reason: `The donor line has majority unresolved contradiction with the bed chords while the retained bed line does not (${donorVerdict.reason}). Keep the bed bass.`,
      measurements,
    };
  }
  if (donorVerdict.contradicts && retainedVerdict.contradicts) {
    return {
      outcome: "unavailable",
      reason: "Both lines have majority unresolved contradiction against the available chord timeline, so this evidence cannot safely choose between them.",
      measurements,
    };
  }
  return {
    outcome: "retain",
    reason: "Neither line has majority unresolved contradiction against the available chord timeline. There is no measured harmonic reason to displace the existing bed bass.",
    measurements,
  };
}
