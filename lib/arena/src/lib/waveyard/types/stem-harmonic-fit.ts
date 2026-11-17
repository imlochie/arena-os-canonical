/**
 * Stem-aware vocal-versus-bed harmonic assessment.
 *
 * Why this exists, and why it is not another weighted score.
 *
 * The hybrid planner compared the *complete source mix* of the donor against
 * the complete source mix of the anchor. A hybrid keeps the anchor's
 * instrumental and the donor's vocal, and discards the donor's instrumental
 * entirely. So the planner was partly judging harmony belonging to material it
 * throws away, and never judged the material it keeps. Two songs whose mixes
 * both sit in C can look perfectly compatible while the donor's vocal is
 * written against a bed that shares nothing with the one it is about to land on.
 *
 * This module answers the question the arrangement actually asks: given the
 * donor vocal notes that will be placed, and the anchor bed's chord timeline
 * under their new position, how does the melody sit *over time*? It reports
 * what it observed and refuses to answer when it cannot.
 *
 * Scope, stated honestly:
 *
 *  - The bed evidence is the anchor's non-vocal stem chord timeline. Bass and
 *    drum evidence remain unavailable in the automatic route (see
 *    docs/waveyard-harmonic-acceptance-readiness.md); this does not invent
 *    them.
 *  - Passing/neighbour tones are judged with the local harmonic context, not a
 *    fixed key. Whether a non-chord tone sounds like a suspension or a clash
 *    depends on what follows it, which is exactly what this measures.
 *  - This is not a perceptual model. It does not know whether the result sounds
 *    good; it knows whether the melody is consonant with the bed that will
 *    actually play underneath it.
 */

export type StemHarmonyChord = {
  startMs: number;
  endMs: number;
  /** Pitch-class root 0..11, or null for an unnamed chord. */
  root: number | null;
  /** Pitch classes in the chord; empty for an unnamed chord. */
  pitchClasses: readonly number[];
};

export type StemHarmonyNote = {
  startMs: number;
  endMs: number;
  /** MIDI note number after the arrangement's pitch shift is applied. */
  midiNote: number;
  velocity: number;
};

/**
 * How a melodic note relates to the chord sounding underneath it.
 *
 * `chordTone`   — member of the chord.
 * `suspension`  — non-member that resolves downward by step within the same chord.
 * `passing`     — non-member that resolves by step onward (upward, or across a
 *                 chord change) into a chord tone.
 * `clash`       — non-member that does not resolve, or resolves by leap.
 * `unjudged`    — the bed has no named chord here, so nothing was concluded.
 */
export type MelodicRelationKind = "chordTone" | "suspension" | "passing" | "clash" | "unjudged";

export type MelodicRelation = {
  kind: MelodicRelationKind;
  startMs: number;
  endMs: number;
  midiNote: number;
  pitchClass: number;
  /** Semitones from the nearest chord tone (0 when a chord tone). */
  distanceSemitones: number;
  /** For non-chord tones: semitones the following note moves (null when none). */
  resolutionSemitones: number | null;
};

export type StemHarmonicAssessment = {
  status: "measured";
  /** Share of sounded time that lands on a chord tone. */
  chordToneShare: number;
  /** Share of sounded time on a non-chord tone that resolves by step. */
  resolvedShare: number;
  /** Share of sounded time on a non-chord tone that does not resolve. */
  clashShare: number;
  /** Share of sounded time where the bed had no named chord to judge against. */
  unjudgedShare: number;
  /** Played milliseconds that could actually be judged (named bed chord). */
  judgedMs: number;
  /** Total played milliseconds examined. */
  examinedMs: number;
  relations: MelodicRelation[];
  /** How many distinct bed chords the melody moved across. */
  bedChordChanges: number;
  method: string;
};

export type StemHarmonicShortfall = {
  status: "unavailable";
  reason: string;
};

export type StemHarmonicResult = StemHarmonicAssessment | StemHarmonicShortfall;

/**
 * Minimum judged sounding time before an assessment means anything. Below this
 * the melody simply has not played long enough under named bed chords to say
 * how it sits; returning a share from two notes would manufacture confidence.
 */
export const MIN_JUDGED_MS = 1200;

/** A non-chord tone resolving this far or less is treated as stepwise. */
export const STEPWISE_RESOLUTION_SEMITONES = 2;

function pitchClassOf(midiNote: number): number {
  return ((midiNote % 12) + 12) % 12;
}

function circularDistance(a: number, b: number): number {
  const raw = Math.abs(a - b) % 12;
  return Math.min(raw, 12 - raw);
}

function distanceToChord(pitchClass: number, chord: StemHarmonyChord): number {
  if (!chord.pitchClasses.length) return NaN;
  return Math.min(...chord.pitchClasses.map((tone) => circularDistance(pitchClass, tone)));
}

function chordAt(chords: readonly StemHarmonyChord[], timeMs: number): StemHarmonyChord | null {
  // Chords are expected sorted and non-overlapping; scan forward from a hint.
  let low = 0;
  let high = chords.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (chords[middle]!.endMs <= timeMs) low = middle + 1;
    else high = middle;
  }
  const candidate = chords[low];
  return candidate && candidate.startMs <= timeMs ? candidate : null;
}

/** Count distinct named bed chords the melody spans, so "movement" is visible. */
function countChordChanges(chords: readonly StemHarmonyChord[], fromMs: number, toMs: number): number {
  const named = chords.filter((chord) => chord.pitchClasses.length > 0
    && chord.endMs > fromMs && chord.startMs < toMs);
  let changes = 0;
  for (let index = 0; index < named.length; index += 1) {
    if (index === 0) continue;
    const previous = named[index - 1]!;
    const current = named[index]!;
    const same = previous.pitchClasses.length === current.pitchClasses.length
      && previous.pitchClasses.every((tone) => current.pitchClasses.includes(tone));
    if (!same) changes += 1;
  }
  return changes;
}

/**
 * Split notes at chord boundaries so each relation is judged against exactly
 * one chord. A sustained note over a chord change is two relations, because it
 * genuinely is two harmonic events.
 */
function splitNotesAcrossChords(
  notes: readonly StemHarmonyNote[],
  chords: readonly StemHarmonyChord[],
): Array<{ note: StemHarmonyNote; fromMs: number; toMs: number }> {
  const segments: Array<{ note: StemHarmonyNote; fromMs: number; toMs: number }> = [];
  for (const note of notes) {
    let cursor = note.startMs;
    while (cursor < note.endMs) {
      const chord = chordAt(chords, cursor);
      const boundary = chord ? Math.min(note.endMs, chord.endMs) : note.endMs;
      if (boundary <= cursor) break;
      segments.push({ note, fromMs: cursor, toMs: boundary });
      cursor = boundary;
    }
  }
  return segments;
}

/**
 * Assess one placement of donor vocal notes over an anchor bed chord timeline.
 *
 * `notes` are already transposed and time-mapped into the anchor's timeline by
 * the caller: this function judges the arrangement as it will be heard, and
 * performs no stretching or transposition of its own.
 */
export function assessStemHarmonicFit(input: {
  notes: readonly StemHarmonyNote[];
  bedChords: readonly StemHarmonyChord[];
  /** Examined window in the bed's timeline. */
  fromMs: number;
  toMs: number;
}): StemHarmonicResult {
  const { notes, bedChords, fromMs, toMs } = input;
  if (!Number.isFinite(fromMs) || !Number.isFinite(toMs) || toMs <= fromMs) {
    return { status: "unavailable", reason: "The examined window is empty." };
  }
  if (!notes.length) {
    return { status: "unavailable", reason: "No isolated donor vocal notes are available to place." };
  }
  if (!bedChords.length) {
    return {
      status: "unavailable",
      reason: "The anchor bed has no chord timeline from its non-vocal stems, so the placed melody cannot be judged against it.",
    };
  }

  const inWindow = notes
    .map((note) => ({
      ...note,
      startMs: Math.max(note.startMs, fromMs),
      endMs: Math.min(note.endMs, toMs),
    }))
    .filter((note) => note.endMs > note.startMs)
    .sort((left, right) => left.startMs - right.startMs || left.midiNote - right.midiNote);
  if (!inWindow.length) {
    return { status: "unavailable", reason: "No donor vocal notes fall inside the examined window." };
  }

  const segments = splitNotesAcrossChords(inWindow, bedChords);
  const relationAt = new Map<(typeof segments)[number], MelodicRelation>();
  let examinedMs = 0;
  let judgedMs = 0;
  let chordToneMs = 0;
  let resolvedMs = 0;
  let clashMs = 0;
  let unjudgedMs = 0;

  // Resolve each segment against its own chord, then classify non-chord tones by
  // what the melody does next. This is what separates a passing tone from a
  // wrong note: both are non-members, and only the continuation tells them apart.
  const orderedSegments = [...segments].sort((left, right) =>
    left.fromMs - right.fromMs || left.note.midiNote - right.note.midiNote);

  for (const segment of orderedSegments) {
    const weight = segment.toMs - segment.fromMs;
    examinedMs += weight;
    const chord = chordAt(bedChords, segment.fromMs);
    const named = chord !== null && chord.pitchClasses.length > 0;
    if (!named) {
      unjudgedMs += weight;
      relationAt.set(segment, {
        kind: "unjudged",
        startMs: segment.fromMs,
        endMs: segment.toMs,
        midiNote: segment.note.midiNote,
        pitchClass: pitchClassOf(segment.note.midiNote),
        distanceSemitones: 0,
        resolutionSemitones: null,
      });
      continue;
    }
    judgedMs += weight;
    const pitchClass = pitchClassOf(segment.note.midiNote);
    const distance = distanceToChord(pitchClass, chord);
    if (distance === 0) {
      chordToneMs += weight;
      relationAt.set(segment, {
        kind: "chordTone",
        startMs: segment.fromMs,
        endMs: segment.toMs,
        midiNote: segment.note.midiNote,
        pitchClass,
        distanceSemitones: 0,
        resolutionSemitones: null,
      });
      continue;
    }

    // Non-chord tone: what happens next, in this same chord or the next one?
    const index = orderedSegments.indexOf(segment);
    const next = orderedSegments[index + 1];
    const resolution = next ? Math.abs(next.note.midiNote - segment.note.midiNote) : null;
    const nextChord = next ? chordAt(bedChords, next.fromMs) : null;
    const sameChord = nextChord && nextChord === chord;
    const stepwise = resolution !== null && resolution <= STEPWISE_RESOLUTION_SEMITONES;
    const resolvesToMember = next !== undefined && nextChord !== null
      && nextChord.pitchClasses.length > 0
      && distanceToChord(pitchClassOf(next.note.midiNote), nextChord) === 0;

    // A non-chord tone that resolves by step is not a clash. Whether it reads
    // as a passing tone or a suspension is decided by resolution direction:
    // suspensions resolve downward, passing tones move upward or connect. The
    // pipeline has no metrical accent position, so direction is used as the
    // proxy for the suspension convention and that limit is documented rather
    // than patched with an invented accent detector.
    const resolvesDownward = next !== undefined && next.note.midiNote < segment.note.midiNote;
    if (stepwise && sameChord && resolvesDownward) {
      resolvedMs += weight;
      relationAt.set(segment, {
        kind: "suspension",
        startMs: segment.fromMs,
        endMs: segment.toMs,
        midiNote: segment.note.midiNote,
        pitchClass,
        distanceSemitones: distance,
        resolutionSemitones: resolution,
      });
    } else if (stepwise && resolvesToMember) {
      resolvedMs += weight;
      relationAt.set(segment, {
        kind: "passing",
        startMs: segment.fromMs,
        endMs: segment.toMs,
        midiNote: segment.note.midiNote,
        pitchClass,
        distanceSemitones: distance,
        resolutionSemitones: resolution,
      });
    } else {
      clashMs += weight;
      relationAt.set(segment, {
        kind: "clash",
        startMs: segment.fromMs,
        endMs: segment.toMs,
        midiNote: segment.note.midiNote,
        pitchClass,
        distanceSemitones: distance,
        resolutionSemitones: resolution,
      });
    }
  }

  if (judgedMs < MIN_JUDGED_MS) {
    return {
      status: "unavailable",
      reason: `Only ${Math.round(judgedMs)}ms of the placed melody sounds under a named bed chord; at least ${MIN_JUDGED_MS}ms is required before judging it.`,
    };
  }

  const relations = [...relationAt.values()].sort((left, right) => left.startMs - right.startMs);
  const share = (part: number) => part / judgedMs;
  return {
    status: "measured",
    // Denominator is judged time, not examined time: an unjudged window is not
    // evidence of agreement, so it is excluded from the share and reported
    // separately instead.
    chordToneShare: share(chordToneMs),
    resolvedShare: share(resolvedMs),
    clashShare: share(clashMs),
    unjudgedShare: examinedMs > 0 ? unjudgedMs / examinedMs : 0,
    judgedMs,
    examinedMs,
    relations,
    bedChordChanges: countChordChanges(bedChords, fromMs, toMs),
    method: "stem-vocal-notes-vs-bed-chord-timeline",
  };
}

/**
 * Combine a measured assessment into a single comparable figure ONLY for
 * ranking, and only in the presence of measured evidence. This is deliberately
 * not exposed as a "compatibility score": it is the resolved share of the
 * placed melody, so a caller cannot mistake it for perceptual quality.
 *
 * Tension without resolution is the only thing that reduces it; unjudged time
 * never counts for or against.
 */
export function harmonicConformance(assessment: StemHarmonicAssessment): number {
  return assessment.chordToneShare + assessment.resolvedShare;
}

/**
 * One planned section of the arrangement, aligned to the anchor timeline the
 * listener will hear. The caller supplies the real mapping; this module never
 * guesses a stretch or a shift.
 */
export type ArrangementSectionAssessmentInput = {
  anchorSectionId: string;
  donorSectionId: string;
  /** Section span in the anchor's (rendered) timeline. */
  anchorStartMs: number;
  anchorEndMs: number;
  /** Donor span that is mapped onto it. */
  donorStartMs: number;
  donorEndMs: number;
  /** Exact WSOLA output-time / source-time slope when the clip already has one. */
  timelinePerSourceRatio?: number;
  /** Notes of this donor section, in the donor's own timeline. */
  notes: readonly StemHarmonyNote[];
  /** Semitones applied by the arrangement's authorized key shift. */
  pitchShiftSemitones: number;
};

export type ArrangementSectionResult =
  | {
    status: "measured";
    anchorSectionId: string;
    donorSectionId: string;
    anchorStartMs: number;
    anchorEndMs: number;
    stretchRatio: number;
    assessment: StemHarmonicAssessment;
  }
  | {
    status: "unavailable";
    anchorSectionId: string;
    donorSectionId: string;
    anchorStartMs: number;
    anchorEndMs: number;
    reason: string;
  };

export type WholeArrangementHarmony = {
  status: "measured";
  sections: ArrangementSectionResult[];
  /** Judged sounding time across every measured section. */
  judgedMs: number;
  /** Total played time the arrangement proposed, measured or not. */
  proposedMs: number;
  /** Sections that could not be evaluated at all. */
  unjudgedSections: number;
  /** Sections with a measured, unresolved harmonic conflict. */
  conflictingSections: string[];
  /** The least consonant measured section, so a weak passage cannot hide. */
  weakestSectionId: string | null;
  weakestConformance: number | null;
  /**
   * Conformance across judged time, weighted by section duration. Reported for
   * ordering only; `conforming` is the decision, not this number.
   */
  weightedConformance: number;
};

/**
 * Judge every section the arrangement intends to play.
 *
 * The decision is deliberately not an average. A pairing that works for its
 * opening and clashes later must not receive an unconditional endorsement, so
 * `conforming` requires that no measured section is in sustained conflict, and
 * that enough of the proposal was actually judged. A weak average cannot buy
 * back a section that fights.
 */
export function assessWholeArrangementHarmony(input: {
  sections: readonly ArrangementSectionAssessmentInput[];
  /** Bed chord timeline in the anchor's timeline. */
  bedChords: readonly StemHarmonyChord[];
}): WholeArrangementHarmony | { status: "unavailable"; reason: string } {
  const { sections, bedChords } = input;
  if (!sections.length) return { status: "unavailable", reason: "The arrangement proposes no sections to judge." };
  if (!bedChords.length) {
    return {
      status: "unavailable",
      reason: "The retained bed has no chord timeline, so no part of the arrangement can be judged against it.",
    };
  }
  const results: ArrangementSectionResult[] = [];
  let judgedMs = 0;
  let proposedMs = 0;
  let unjudgedSections = 0;
  let weighted = 0;
  let weight = 0;
  let weakestSectionId: string | null = null;
  let weakestConformance: number | null = null;
  const conflictingSections: string[] = [];
  for (const section of sections) {
    const proposed = Math.max(0, section.anchorEndMs - section.anchorStartMs);
    proposedMs += proposed;
    const span = section.donorEndMs - section.donorStartMs;
    if (span <= 0 || proposed <= 0) {
      unjudgedSections += 1;
      results.push({
        status: "unavailable",
        anchorSectionId: section.anchorSectionId,
        donorSectionId: section.donorSectionId,
        anchorStartMs: section.anchorStartMs,
        anchorEndMs: section.anchorEndMs,
        reason: "This section has no duration on the planned timeline.",
      });
      continue;
    }
    const stretchRatio = section.timelinePerSourceRatio ?? proposed / span;
    if (!Number.isFinite(stretchRatio) || stretchRatio <= 0
      || Math.abs(span * stretchRatio - proposed) > 1) {
      unjudgedSections += 1;
      results.push({
        status: "unavailable",
        anchorSectionId: section.anchorSectionId,
        donorSectionId: section.donorSectionId,
        anchorStartMs: section.anchorStartMs,
        anchorEndMs: section.anchorEndMs,
        reason: "The supplied timing transform does not map the donor source window onto the planned section.",
      });
      continue;
    }
    // Place this section's notes on the anchor timeline exactly as the renderer
    // will, then judge them against the bed chords under each one.
    const placed: StemHarmonyNote[] = section.notes
      .filter((note) => note.startMs < section.donorEndMs && note.endMs > section.donorStartMs)
      .map((note) => {
        const from = Math.max(note.startMs, section.donorStartMs);
        const to = Math.min(note.endMs, section.donorEndMs);
        return {
          startMs: Math.round(section.anchorStartMs + (from - section.donorStartMs) * stretchRatio),
          endMs: Math.round(section.anchorStartMs + (to - section.donorStartMs) * stretchRatio),
          midiNote: note.midiNote + section.pitchShiftSemitones,
          velocity: note.velocity,
        };
      })
      .filter((note) => note.endMs > note.startMs);
    const assessment = assessStemHarmonicFit({
      notes: placed,
      bedChords,
      fromMs: section.anchorStartMs,
      toMs: section.anchorEndMs,
    });
    if (assessment.status === "unavailable") {
      unjudgedSections += 1;
      results.push({
        status: "unavailable",
        anchorSectionId: section.anchorSectionId,
        donorSectionId: section.donorSectionId,
        anchorStartMs: section.anchorStartMs,
        anchorEndMs: section.anchorEndMs,
        reason: assessment.reason,
      });
      continue;
    }
    judgedMs += assessment.judgedMs;
    const conformance = harmonicConformance(assessment);
    weighted += conformance * assessment.judgedMs;
    weight += assessment.judgedMs;
    if (weakestConformance === null || conformance < weakestConformance) {
      weakestConformance = conformance;
      weakestSectionId = section.anchorSectionId;
    }
    // "In sustained conflict" means most judged sounding time in the section is
    // unresolved tension. A single expressive clash does not condemn a section.
    if (assessment.clashShare > MAX_SECTION_CLASH_SHARE) conflictingSections.push(section.anchorSectionId);
    results.push({
      status: "measured",
      anchorSectionId: section.anchorSectionId,
      donorSectionId: section.donorSectionId,
      anchorStartMs: section.anchorStartMs,
      anchorEndMs: section.anchorEndMs,
      stretchRatio,
      assessment,
    });
  }
  if (!weight) {
    return {
      status: "unavailable",
      reason: `None of the ${sections.length} proposed sections could be judged against the retained bed.`,
    };
  }
  return {
    status: "measured",
    sections: results,
    judgedMs,
    proposedMs,
    unjudgedSections,
    conflictingSections,
    weakestSectionId,
    weakestConformance,
    weightedConformance: weighted / weight,
  };
}

/**
 * The decision, not a score.
 *
 * A whole-arrangement pairing conforms only when it was measured, no section is
 * in sustained conflict, and a substantial share of the proposal was actually
 * judged. Refusing is the correct answer when most of the song is unknown.
 */
export function wholeArrangementConforming(result: WholeArrangementHarmony): { conforming: boolean; reason: string } {
  if (result.conflictingSections.length) {
    return {
      conforming: false,
      reason: `section ${result.conflictingSections[0]} is in sustained harmonic conflict with the retained bed`,
    };
  }
  const judgedShare = result.proposedMs > 0 ? result.judgedMs / result.proposedMs : 0;
  if (judgedShare < MIN_ARRANGEMENT_JUDGED_SHARE) {
    return {
      conforming: false,
      reason: `only ${(judgedShare * 100).toFixed(0)}% of the proposed arrangement could be judged`,
    };
  }
  return {
    conforming: true,
    reason: `every judged section conforms; ${(judgedShare * 100).toFixed(0)}% of the proposed arrangement was judged`,
  };
}

/**
 * Sustained conflict threshold: more than half of a section's judged sounding
 * time in unresolved tension. This is a musical statement about the section,
 * not a tuning knob: a section where most of the melody does not resolve is not
 * a section that works.
 */
export const MAX_SECTION_CLASH_SHARE = 0.5;

/** Below this judged share the arrangement is mostly unknown and is not endorsed. */
export const MIN_ARRANGEMENT_JUDGED_SHARE = 0.5;
