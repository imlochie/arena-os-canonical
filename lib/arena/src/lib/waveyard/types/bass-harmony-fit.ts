/**
 * Independent bass-line assessment against the retained bed's chord timeline.
 *
 * Why this is separate from the vocal-to-chord check.
 *
 * The bed's chord labels come from a chroma template match over the whole
 * non-vocal stem. They describe the harmony as a whole, not the harmonic
 * *foundation*. A bass line is the foundation: it decides which chord tone is in
 * the bass, whether the movement is a stepwise approach or a jump, and whether a
 * pedal is holding the piece together. Treating "the bass must play the chord
 * root" as the rule would be wrong — inversions, pedals, passing notes and
 * approach notes are all ordinary and good.
 *
 * So this does not score "is the bass note the root". It classifies what each
 * bass note is doing musically, and only calls a passage contradictory when the
 * bass sustains a pitch that has no defensible relationship to the harmony under
 * it and does not resolve.
 *
 * Everything here is conditional on evidence that is actually trustworthy. A
 * bass estimate from a separated stem is an estimate: gaps, ambiguous notes and
 * unpitched attacks are preserved as unjudged rather than guessed.
 */

export type BassLineNote = {
  startMs: number;
  endMs: number;
  /** MIDI note in the anchor's timeline after the arrangement's shift. */
  midiNote: number;
  /** Tracker confidence for this segment, 0..1. */
  confidence: number;
};

export type BassHarmonyChord = {
  startMs: number;
  endMs: number;
  root: number | null;
  pitchClasses: readonly number[];
};

/**
 * What the bass is doing relative to the harmony above it.
 *
 * `root`        — the chord root is in the bass. The plain case.
 * `chordTone`   — another chord tone in the bass: an inversion or a doubling.
 * `pedal`       — the same pitch held under a chord that changes. A device, not
 *                 an error, so it is named rather than penalised.
 * `passing`     — a non-chord tone that moves by step to a chord tone.
 * `approach`    — a non-chord tone that moves by step into the next chord's root.
 * `contradiction` — a non-chord tone that neither resolves by step nor sits as a
 *                 pedal. This is the only case that argues against a pairing.
 * `unjudged`    — no named chord above this note, or the note is unattributed.
 */
export type BassRelationKind =
  | "root" | "chordTone" | "pedal" | "passing" | "approach" | "contradiction" | "unjudged";

export type BassRelation = {
  kind: BassRelationKind;
  startMs: number;
  endMs: number;
  midiNote: number;
  pitchClass: number;
  /** Semitones from the nearest chord tone; 0 for chord tones. */
  distanceSemitones: number;
  /** For non-chord tones: semitones the bass moves next (null when nothing follows). */
  resolutionSemitones: number | null;
};

export type BassLineAssessment = {
  status: "measured";
  /** Share of judged bass time that is root, chord tone or pedal support. */
  supportShare: number;
  /** Share of judged time on a stepwise non-chord tone (passing/approach). */
  motionShare: number;
  /** Share of judged time on sustained, unresolved contradiction. */
  contradictionShare: number;
  /** Judged bass time in ms. */
  judgedMs: number;
  /** Bass time that could not be attributed at all (gaps, low confidence). */
  unjudgedMs: number;
  /** Total bass time examined. */
  examinedMs: number;
  relations: BassRelation[];
  /** Distinct bass pitches used, so a static pedal is distinguishable. */
  distinctPitches: number;
  /** Distinct bed chords the bass spans. */
  bedChordChanges: number;
};

export type BassLineResult =
  | BassLineAssessment
  | { status: "unavailable"; reason: string };

/** Minimum judged bass time before the line says anything. */
export const MIN_BASS_JUDGED_MS = 1500;
/** A bass segment shorter than this is an attack transient, not a note. */
export const MIN_BASS_NOTE_MS = 80;
/** A non-chord tone resolving within this many semitones is stepwise. */
export const BASS_STEPWISE_SEMITONES = 2;
/**
 * A pitch held across a chord change for at least this long, and not matching
 * either chord, is treated as a pedal rather than as two contradictions.
 */
export const BASS_PEDAL_MIN_MS = 600;

function pitchClassOf(midiNote: number): number {
  return ((midiNote % 12) + 12) % 12;
}

function circularDistance(a: number, b: number): number {
  const raw = Math.abs(a - b) % 12;
  return Math.min(raw, 12 - raw);
}

function distanceToChord(pitchClass: number, chord: BassHarmonyChord): number {
  if (!chord.pitchClasses.length) return NaN;
  return Math.min(...chord.pitchClasses.map((tone) => circularDistance(pitchClass, tone)));
}

function chordAt(chords: readonly BassHarmonyChord[], timeMs: number): BassHarmonyChord | null {
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

/**
 * Whether two chord events are the SAME harmony.
 *
 * Compared by pitch content, not by row identity or timing. A bed that repeats
 * C major across four events is still one harmony repeated, so a bass note held
 * over it has not spanned a chord change. Treating each event as a change would
 * misclassify a plain sustained non-chord tone as a pedal and excuse it.
 */
function sameHarmony(a: BassHarmonyChord | null, b: BassHarmonyChord | null): boolean {
  if (!a || !b) return false;
  if (!a.pitchClasses.length || !b.pitchClasses.length) return false;
  return a.pitchClasses.length === b.pitchClasses.length
    && a.pitchClasses.every((tone) => b.pitchClasses.includes(tone));
}

/**
 * Assess an isolated bass line against the bed harmony.
 *
 * `notes` must already be in the anchor timeline with the arrangement's pitch
 * shift applied; this function judges, it does not transform.
 */
export function assessBassLine(input: {
  notes: readonly BassLineNote[];
  bedChords: readonly BassHarmonyChord[];
  fromMs: number;
  toMs: number;
}): BassLineResult {
  const { notes, bedChords, fromMs, toMs } = input;
  if (!Number.isFinite(fromMs) || !Number.isFinite(toMs) || toMs <= fromMs) {
    return { status: "unavailable", reason: "The examined window is empty." };
  }
  if (!bedChords.length) {
    return {
      status: "unavailable",
      reason: "The retained bed has no chord timeline, so its bass line cannot be related to any harmony.",
    };
  }
  const usable = notes
    .filter((note) => Number.isFinite(note.startMs) && Number.isFinite(note.endMs)
      && note.endMs - note.startMs >= MIN_BASS_NOTE_MS)
    .map((note) => ({
      ...note,
      startMs: Math.max(note.startMs, fromMs),
      endMs: Math.min(note.endMs, toMs),
    }))
    .filter((note) => note.endMs > note.startMs)
    .sort((left, right) => left.startMs - right.startMs);
  if (!usable.length) {
    return { status: "unavailable", reason: "No sustained bass notes were tracked inside the examined window." };
  }

  const examinedMs = usable.reduce((sum, note) => sum + (note.endMs - note.startMs), 0);
  const relations: BassRelation[] = [];
  let judgedMs = 0;
  let unjudgedMs = 0;
  let supportMs = 0;
  let motionMs = 0;
  let contradictionMs = 0;

  // Split each note at chord boundaries so every segment is judged against
  // exactly one harmony. A held bass note under a chord change is two events.
  const segments: Array<{ note: BassLineNote; fromMs: number; toMs: number; chord: BassHarmonyChord | null }> = [];
  for (const note of usable) {
    let cursor = note.startMs;
    while (cursor < note.endMs) {
      const chord = chordAt(bedChords, cursor);
      const boundary = chord ? Math.min(note.endMs, chord.endMs) : note.endMs;
      if (boundary <= cursor) break;
      segments.push({ note, fromMs: cursor, toMs: boundary, chord });
      cursor = boundary;
    }
  }
  segments.sort((left, right) => left.fromMs - right.fromMs || left.note.midiNote - right.note.midiNote);

  for (let index = 0; index < segments.length; index += 1) {
    const segment = segments[index]!;
    const weight = segment.toMs - segment.fromMs;
    const pitchClass = pitchClassOf(segment.note.midiNote);
    if (!segment.chord || !segment.chord.pitchClasses.length) {
      unjudgedMs += weight;
      relations.push({
        kind: "unjudged", startMs: segment.fromMs, endMs: segment.toMs,
        midiNote: segment.note.midiNote, pitchClass, distanceSemitones: 0, resolutionSemitones: null,
      });
      continue;
    }
    judgedMs += weight;
    const distance = distanceToChord(pitchClass, segment.chord);
    const isRoot = segment.chord.root !== null && pitchClass === segment.chord.root;
    if (distance === 0) {
      supportMs += weight;
      relations.push({
        kind: isRoot ? "root" : "chordTone",
        startMs: segment.fromMs, endMs: segment.toMs,
        midiNote: segment.note.midiNote, pitchClass,
        distanceSemitones: 0, resolutionSemitones: null,
      });
      continue;
    }

    const next = segments[index + 1];
    const resolution = next ? Math.abs(next.note.midiNote - segment.note.midiNote) : null;
    const stepwise = resolution !== null && resolution > 0 && resolution <= BASS_STEPWISE_SEMITONES;

    // A single sustained pitch held under changing harmony is a pedal point.
    // That is the definition of the device, and it is why the test is on the
    // whole held NOTE rather than on one chord slice of it: a pedal is a
    // property of the note, so slicing it by chord would call the same device a
    // contradiction on whichever chord it happens to be foreign to.
    //
    // This only applies to a genuinely sustained note (BASS_PEDAL_MIN_MS). A
    // walking bass line changes pitch before the chord does, so it never reaches
    // this branch and its non-chord tones are judged as motion.
    const noteSegments = segments.filter((candidate) => candidate.note === segment.note);
    const noteSpanMs = noteSegments.reduce((sum, candidate) => sum + (candidate.toMs - candidate.fromMs), 0);
    // "Spans a change" means the HARMONY changed under the held note. Comparing
    // chord-row identity would call a repeated C major a change.
    const distinctHarmonies: BassHarmonyChord[] = [];
    for (const candidate of noteSegments) {
      if (!candidate.chord || !candidate.chord.pitchClasses.length) continue;
      if (!distinctHarmonies.some((existing) => sameHarmony(existing, candidate.chord))) {
        distinctHarmonies.push(candidate.chord);
      }
    }
    const spansChange = distinctHarmonies.length > 1;
    const heldAcrossChange = noteSpanMs >= BASS_PEDAL_MIN_MS && spansChange;
    if (heldAcrossChange) {
      supportMs += weight;
      relations.push({
        kind: "pedal", startMs: segment.fromMs, endMs: segment.toMs,
        midiNote: segment.note.midiNote, pitchClass,
        distanceSemitones: distance, resolutionSemitones: resolution,
      });
      continue;
    }

    const nextIsRoot = next !== undefined && next.chord !== null
      && next.chord.pitchClasses.length > 0 && next.chord.root !== null
      && pitchClassOf(next.note.midiNote) === next.chord.root;
    const resolvesToTone = next !== undefined && next.chord !== null
      && next.chord.pitchClasses.length > 0
      && distanceToChord(pitchClassOf(next.note.midiNote), next.chord) === 0;

    if (stepwise && nextIsRoot) {
      motionMs += weight;
      relations.push({
        kind: "approach", startMs: segment.fromMs, endMs: segment.toMs,
        midiNote: segment.note.midiNote, pitchClass,
        distanceSemitones: distance, resolutionSemitones: resolution,
      });
    } else if (stepwise && resolvesToTone) {
      motionMs += weight;
      relations.push({
        kind: "passing", startMs: segment.fromMs, endMs: segment.toMs,
        midiNote: segment.note.midiNote, pitchClass,
        distanceSemitones: distance, resolutionSemitones: resolution,
      });
    } else {
      contradictionMs += weight;
      relations.push({
        kind: "contradiction", startMs: segment.fromMs, endMs: segment.toMs,
        midiNote: segment.note.midiNote, pitchClass,
        distanceSemitones: distance, resolutionSemitones: resolution,
      });
    }
  }

  if (judgedMs < MIN_BASS_JUDGED_MS) {
    return {
      status: "unavailable",
      reason: `Only ${Math.round(judgedMs)}ms of bass sounds under a named bed chord; at least ${MIN_BASS_JUDGED_MS}ms is required before judging the line.`,
    };
  }

  const named = bedChords.filter((chord) => chord.pitchClasses.length > 0
    && chord.endMs > fromMs && chord.startMs < toMs);
  let bedChordChanges = 0;
  for (let index = 1; index < named.length; index += 1) {
    const previous = named[index - 1]!;
    const current = named[index]!;
    const same = previous.pitchClasses.length === current.pitchClasses.length
      && previous.pitchClasses.every((tone) => current.pitchClasses.includes(tone));
    if (!same) bedChordChanges += 1;
  }
  return {
    status: "measured",
    supportShare: supportMs / judgedMs,
    motionShare: motionMs / judgedMs,
    contradictionShare: contradictionMs / judgedMs,
    judgedMs,
    unjudgedMs,
    examinedMs,
    relations,
    distinctPitches: new Set(usable.map((note) => pitchClassOf(note.midiNote))).size,
    bedChordChanges,
  };
}

/**
 * Whether the bass argues against the pairing.
 *
 * Deliberately not a score: support and stepwise motion are both legitimate, so
 * only sustained contradiction that dominates the judged line is a problem. A
 * line that is mostly supportive with one deliberate dissonance is not rejected.
 */
export function bassContradictsHarmony(assessment: BassLineAssessment): {
  contradicts: boolean;
  reason: string;
} {
  if (assessment.contradictionShare > MAX_BASS_CONTRADICTION_SHARE) {
    return {
      contradicts: true,
      reason: `${(assessment.contradictionShare * 100).toFixed(0)}% of judged bass time sustains a pitch with no resolvable relationship to the harmony above it`,
    };
  }
  return {
    contradicts: false,
    reason: `bass support ${(assessment.supportShare * 100).toFixed(0)}%, stepwise motion ${(assessment.motionShare * 100).toFixed(0)}%, contradiction ${(assessment.contradictionShare * 100).toFixed(0)}%`,
  };
}

/**
 * More than half of the judged bass line in unresolved contradiction. Stated as
 * a musical condition: if the foundation spends most of its time outside the
 * harmony and never resolves, it is not supporting that harmony.
 */
export const MAX_BASS_CONTRADICTION_SHARE = 0.5;
