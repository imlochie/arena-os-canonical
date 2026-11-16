import { normaliseMusicalKey, semitoneShift, type MusicalKey } from "./musical-key";
import { usableBeatGrid } from "./beat-grid";
import { HARMONY_TEMPLATE_MIN_MARGIN, type HarmonyEvent } from "./harmony-analysis";
import {
  assessStemHarmonicFit,
  assessWholeArrangementHarmony,
  harmonicConformance,
  wholeArrangementConforming,
  type ArrangementSectionAssessmentInput,
  type StemHarmonicResult,
  type StemHarmonyNote,
  type WholeArrangementHarmony,
} from "./stem-harmonic-fit";
import { bedChordsFromHarmonyEvents } from "./stem-harmonic-adapter";
import {
  assessBassLine,
  bassContradictsHarmony,
  type BassLineNote,
  type BassLineResult,
} from "./bass-harmony-fit";
import {
  type AutomaticRemixCompatibilityPair,
  comparePassageCompatibility,
  type PassageFingerprint,
} from "./passage-compatibility";
import {
  trustedAnalysisBpm,
  trustedAnalysisKey,
  WAVEYARD_MIXING_CONFIDENCE_THRESHOLD,
} from "./analysis-confidence";
import { measureStemGroove } from "./stem-groove";
import {
  decideDonorDrumBed,
  type DrumBedDecision,
  type DrumPlacement,
} from "./drum-bed-decision";
import { DRUM_ANALYSIS_ENGINE, DRUM_ANALYSIS_ENGINE_VERSION, LOCAL_DRUM_ANALYSIS_ENGINE, LOCAL_DRUM_ANALYSIS_ENGINE_VERSION, drumAnalysisProvenanceReason } from "./drum-analysis";

export const AUTOMATIC_REMIX_ENGINE = "waveyard-deterministic-arranger";
export const AUTOMATIC_REMIX_ENGINE_VERSION = "5";
export const AUTOMATIC_REMIX_VARIANTS = ["original", "hybrid"] as const;
export type AutomaticRemixVariant = (typeof AUTOMATIC_REMIX_VARIANTS)[number];

export type AutomaticRemixStem = {
  id: string;
  sourceAssetId: string;
  stemType: string;
  durationMs: number;
  /**
   * Checksum of the stem's bytes, when the caller supplies it. Per-stem
   * evidence (drums, bass) is only trusted when the evidence's own recorded
   * checksum still matches this value, so a re-rendered stem cannot be judged
   * against onsets measured from bytes that no longer exist.
   */
  checksumSha256?: string;
};

export type AutomaticRemixSection = {
  id: string;
  sectionIndex: number;
  startMs: number;
  endMs: number;
  label: string;
  labelConfidence: number;
  structuralConfidence: number;
  passageFingerprint?: PassageFingerprint | null;
  startBeatIndex?: number;
  endBeatIndex?: number;
};

export type AutomaticRemixSource = {
  id: string;
  originalFilename: string;
  checksumSha256: string;
  durationMs: number;
  analysis: {
    id: string;
    status: string;
    sourceChecksumSha256: string;
    bpm: number | null;
    bpmConfidence: number | null;
    musicalKey: string | null;
    keyConfidence: number | null;
    beatConfidence: number | null;
    beatGridMs: unknown;
  } | null;
  sections: AutomaticRemixSection[];
  stems: AutomaticRemixStem[];
  /** Current checksum-bound source-mix chords; advisory because named-chord accuracy is not independently established. */
  harmony?: {
    analysisId: string;
    analysisEngine: string;
    analysisEngineVersion: string;
    sourceChecksumSha256: string;
    events: HarmonyEvent[];
  } | null;
  /**
   * Chord timeline measured on the non-vocal stem this source will actually
   * contribute to a hybrid. Distinct from `harmony`, which is the complete
   * source mix and includes instruments a hybrid discards. Absent means the
   * bed cannot be judged; it never means "no harmony here".
   */
  bedHarmony?: {
    analysisEngine: string;
    analysisEngineVersion: string;
    stemAssetId: string;
    stemType: string;
    stemChecksumSha256: string;
    sourceChecksumSha256: string;
    events: HarmonyEvent[];
  } | null;
  /**
   * Isolated donor vocal notes, placed by the caller into the anchor timeline.
   * These are the notes a vocal hybrid actually carries.
   */
  vocalNotes?: readonly StemHarmonyNote[] | null;
  /**
   * Independently tracked bass notes of this source's bass stem, in this
   * source's own timeline. Absent means the harmonic foundation was not
   * measured -- it never means the bass agrees.
   */
  bassLine?: readonly BassLineNote[] | null;
  /**
   * Checksum-current broadband transient onsets of this source's isolated drum
   * (or percussion) stem, in this source's own timeline. Absent means the drum
   * part was not measured -- it never means the part is compatible.
   *
   * Only onsets exist: production transient detection records no kick/snare/hat
   * class, so nothing here can support a rhythmic-role claim.
   */
  drumEvidence?: {
    analysisEngine: string;
    analysisEngineVersion: string;
    stemAssetId: string;
    stemType: string;
    stemChecksumSha256: string;
    sourceChecksumSha256: string;
    events: readonly { timestampMs: number; strength: number; confidence: number }[];
  } | null;
};

/** High-level preferences only. Clip-level editing remains in the existing Studio. */
export type AutomaticRemixConstraints = {
  variant?: AutomaticRemixVariant;
  anchorSourceId?: string;
  vocalStemId?: string;
  drumsStemId?: string;
  instrumental?: boolean;
};

export type AutomaticRemixClipPlan = {
  stemAssetId: string;
  timelineStartMs: number;
  durationMs: number;
  sourceOffsetMs: number;
  gain: number;
  fadeInMs: number;
  fadeOutMs: number;
  tempoSyncEnabled: boolean;
  keySyncEnabled: boolean;
  beatSnapEnabled: boolean;
};

export type AutomaticRemixTrackPlan = {
  stemAssetId: string;
  name: string;
  stemType: string;
  sortOrder: number;
  volume: number;
  pan: number;
  clips: AutomaticRemixClipPlan[];
};

export type AutomaticRemixProvenance = {
  engine: typeof AUTOMATIC_REMIX_ENGINE;
  engineVersion: typeof AUTOMATIC_REMIX_ENGINE_VERSION;
  variant: AutomaticRemixVariant;
  anchorSourceId: string;
  anchorSourceChecksumSha256: string;
  sourceAnalysisIds: string[];
  targetBpm: number | null;
  targetKey: MusicalKey | null;
  constraints: Required<Pick<AutomaticRemixConstraints, "instrumental">> & Omit<AutomaticRemixConstraints, "instrumental">;
  decisions: string[];
  passageCompatibility?: AutomaticRemixCompatibilityReport;
  /**
   * What each donor's drum part was decided to do, with the measurements behind
   * it. Present only when a donor drum part was actually considered; an absent
   * entry means no drum question was asked, not that the drums were retained.
   */
  drumBedDecisions?: Array<{
    donorSourceId: string;
    donorFilename: string;
    outcome: DrumBedDecision["decision"];
    reason: string;
    measurements: DrumBedDecision["measurements"];
  }>;
};

export type AutomaticRemixCompatibilityReport = {
  evaluatedPairs: number;
  eligiblePairs: number;
  pairs: AutomaticRemixCompatibilityPair[];
  missingEvidence: string[];
  note: string;
};

export type AutomaticRemixPlan = {
  name: string;
  tempoBpm: number;
  targetKey: MusicalKey | null;
  tracks: AutomaticRemixTrackPlan[];
  provenance: AutomaticRemixProvenance;
  notices: string[];
  compatibility?: AutomaticRemixCompatibilityReport;
};

export type AutomaticRemixResult =
  | { ok: true; plan: AutomaticRemixPlan }
  | {
      ok: false;
      reason:
        | "no_usable_source"
        | "no_stems"
        | "hybrid_evidence_unavailable"
        | "no_compatible_hybrid_source"
        | "unsafe_hybrid_alignment";
      compatibility?: AutomaticRemixCompatibilityReport;
    };

const roleOrder = ["drums", "percussion", "bass", "other", "melody", "vocals"];
const defaultVolume: Record<string, number> = { vocals: 0.94, drums: 0.88, percussion: 0.82, bass: 0.84, other: 0.82, melody: 0.82 };

function usableSections(source: AutomaticRemixSource) {
  return [...source.sections]
    .filter((section) => Number.isSafeInteger(section.startMs) && Number.isSafeInteger(section.endMs)
      && section.startMs >= 0 && section.endMs > section.startMs && section.endMs <= source.durationMs)
    .sort((left, right) => left.sectionIndex - right.sectionIndex || left.startMs - right.startMs)
    .filter((section, index, all) => index === 0 || section.startMs >= all[index - 1].endMs);
}

function sourceIsUsable(source: AutomaticRemixSource) {
  return source.stems.length > 0 && source.durationMs > 0;
}

function sourceHasVerifiedAnalysis(source: AutomaticRemixSource) {
  return source.analysis?.status === "complete"
    && source.analysis.sourceChecksumSha256 === source.checksumSha256;
}

function sourceCanStructure(source: AutomaticRemixSource) {
  return sourceHasVerifiedAnalysis(source)
    && trustedBpm(source) !== null
    && confidenceAtLeast(source.analysis?.beatConfidence, WAVEYARD_MIXING_CONFIDENCE_THRESHOLD)
    && usableSections(source).length > 0
    && Boolean(usableBeatGrid(source.analysis?.beatGridMs));
}

function sourceLabel(source: AutomaticRemixSource, stem: AutomaticRemixStem) {
  const role = stem.stemType === "other" ? "Melody" : `${stem.stemType[0]?.toUpperCase() ?? ""}${stem.stemType.slice(1)}`;
  return `${source.originalFilename} — ${role}`;
}

function roleRank(stem: AutomaticRemixStem) {
  const index = roleOrder.indexOf(stem.stemType);
  return index === -1 ? roleOrder.length : index;
}

function confidenceAtLeast(value: number | null | undefined, minimum: number): boolean {
  return typeof value === "number" && Number.isFinite(value) && value >= minimum && value <= 1;
}

function trustedBpm(source: AutomaticRemixSource): number | null {
  return trustedAnalysisBpm(source.analysis?.bpm, source.analysis?.bpmConfidence);
}

function trustedKey(source: AutomaticRemixSource): MusicalKey | null {
  return normaliseMusicalKey(trustedAnalysisKey(source.analysis?.musicalKey, source.analysis?.keyConfidence));
}

function progressionContext(
  anchor: AutomaticRemixSource,
  anchorSection: AutomaticRemixSection,
  donor: AutomaticRemixSource,
  donorSection: AutomaticRemixSection,
  shiftSemitones: number,
) {
  const validFor = (source: AutomaticRemixSource) => source.harmony
    && source.harmony.sourceChecksumSha256 === source.checksumSha256
    && source.analysis?.sourceChecksumSha256 === source.checksumSha256
    ? source.harmony.events : null;
  const anchorEvents = validFor(anchor)?.filter((event) => event.endMs > anchorSection.startMs && event.startMs < anchorSection.endMs) ?? null;
  const donorEvents = validFor(donor)?.filter((event) => event.endMs > donorSection.startMs && event.startMs < donorSection.endMs) ?? null;
  if (!anchorEvents?.length || !donorEvents?.length) return {
    status: "unavailable" as const,
    similarity: null,
    detail: "Current checksum-bound source-mix chord timelines are unavailable for one or both sections.",
  };

  const durationA = anchorSection.endMs - anchorSection.startMs;
  const durationB = donorSection.endMs - donorSection.startMs;
  const bins = 48;
  let compared = 0;
  let matching = 0;
  for (let index = 0; index < bins; index += 1) {
    const fraction = (index + 0.5) / bins;
    const eventAt = (events: HarmonyEvent[], section: AutomaticRemixSection, duration: number) => events.find((event) => {
      const start = Math.max(event.startMs, section.startMs);
      const end = Math.min(event.endMs, section.endMs);
      return end > start && fraction >= (start - section.startMs) / duration && fraction < (end - section.startMs) / duration;
    });
    const left = eventAt(anchorEvents, anchorSection, durationA);
    const right = eventAt(donorEvents, donorSection, durationB);
    if (!left?.root || left.quality === "unknown" || left.confidence < HARMONY_TEMPLATE_MIN_MARGIN
      || !right?.root || right.quality === "unknown" || right.confidence < HARMONY_TEMPLATE_MIN_MARGIN) continue;
    compared += 1;
    const rootKey = (root: string) => normaliseMusicalKey(`${root} major`);
    const leftRoot = rootKey(left.root);
    const rightRoot = rootKey(right.root);
    if (!leftRoot || !rightRoot) continue;
    const shiftedRoot = semitoneShift(rightRoot, leftRoot);
    if (left.quality === right.quality && shiftedRoot === shiftSemitones) matching += 1;
  }
  const coverage = compared / bins;
  if (coverage < 0.5) return {
    status: "unavailable" as const,
    similarity: null,
    detail: `Named chord events cover ${(coverage * 100).toFixed(0)}% of aligned section bins; at least 50% is required for progression context.`,
  };
  const similarity = matching / compared;
  return {
    status: "context" as const,
    similarity,
    detail: `Checksum-bound production chord events agree in root, quality and authorized shift across ${(coverage * 100).toFixed(0)}% of aligned bins (${(similarity * 100).toFixed(0)}% agreement among named bins). Advisory only; chord accuracy has no independent reference yet.`,
  };
}

/**
 * Judge a candidate donor vocal against the chord timeline of the anchor bed it
 * would actually be placed on.
 *
 * This is the retained-material check. `progressionContext` compares two
 * complete source mixes, which a hybrid does not play: it keeps the anchor's
 * instrumental and the donor's vocal and discards everything else. A pair whose
 * mixes agree can still place a melody over a bed it fights, and a pair whose
 * mixes disagree can place one that fits. Only this function looks at what will
 * be heard.
 *
 * `alignment` is the arrangement's real placement: the first matched anchor
 * section and the donor section mapped onto it, with the authorized shift.
 * Without that mapping the notes cannot be put in the bed's timeline, and the
 * check reports unavailable rather than guessing.
 */
export function assessRetainedHybridHarmony(input: {
  anchor: AutomaticRemixSource;
  donor: AutomaticRemixSource;
  /** Anchor section the donor section is placed under. */
  anchorSection: AutomaticRemixSection;
  /** Donor section whose vocal notes survive. */
  donorSection: AutomaticRemixSection;
  /** Authorized pitch shift applied to the donor vocal, in semitones. */
  semitones: number;
}): StemHarmonicResult {
  const { anchor, donor, anchorSection, donorSection, semitones } = input;
  if (!Number.isFinite(semitones) || !Number.isInteger(semitones)) {
    return { status: "unavailable", reason: "No authorized pitch shift is available for this placement." };
  }
  if (!anchor.bedHarmony) {
    return {
      status: "unavailable",
      reason: `The anchor bed for ${anchor.originalFilename} has no current checksum-bound chord analysis from its non-vocal stems, so the placed donor vocal cannot be judged against it.`,
    };
  }
  if (anchor.bedHarmony.sourceChecksumSha256 !== anchor.checksumSha256) {
    return { status: "unavailable", reason: "The anchor bed chord analysis does not match the current source checksum." };
  }
  if (!donor.vocalNotes?.length) {
    return { status: "unavailable", reason: `No isolated vocal notes are available for ${donor.originalFilename}.` };
  }
  const anchorDuration = anchorSection.endMs - anchorSection.startMs;
  const donorDuration = donorSection.endMs - donorSection.startMs;
  if (anchorDuration <= 0 || donorDuration <= 0) {
    return { status: "unavailable", reason: "The compared sections have no duration." };
  }
  const stretchRatio = anchorDuration / donorDuration;
  const bedChords = bedChordsFromHarmonyEvents(anchor.bedHarmony.events);
  const placed: StemHarmonyNote[] = donor.vocalNotes
    .filter((note) => note.startMs < donorSection.endMs && note.endMs > donorSection.startMs)
    .map((note) => {
      const from = Math.max(note.startMs, donorSection.startMs);
      const to = Math.min(note.endMs, donorSection.endMs);
      return {
        startMs: Math.round(anchorSection.startMs + (from - donorSection.startMs) * stretchRatio),
        endMs: Math.round(anchorSection.startMs + (to - donorSection.startMs) * stretchRatio),
        midiNote: note.midiNote + semitones,
        velocity: note.velocity,
      };
    })
    .filter((note) => note.endMs > note.startMs);
  return assessStemHarmonicFit({
    notes: placed,
    bedChords,
    fromMs: anchorSection.startMs,
    toMs: anchorSection.endMs,
  });
}

export type WholeArrangementDecision =
  | {
    status: "measured";
    conforming: boolean;
    reason: string;
    harmony: WholeArrangementHarmony;
    bass: BassLineResult;
    /** True when the bass also argues against this candidate. */
    bassContradicts: boolean;
    bassReason: string;
    /** Sections assessed, so "the whole song" is auditable. */
    assessedSectionCount: number;
  }
  | { status: "unavailable"; reason: string };

/**
 * Judge a whole proposed hybrid arrangement: every matched section the planner
 * intends to use, plus the retained bed's independent bass line.
 *
 * This replaces asking "does the first matched section work". A pairing that is
 * perfect for its opening and fights the bed later must not be endorsed, and a
 * pairing whose retained bass contradicts the harmony must not be preferred just
 * because the vocal fits.
 *
 * Refusing is a valid answer: without a checksum-bound bed analysis, a trusted
 * key, or enough judged material the result is unavailable, never "compatible".
 */
/**
 * Which candidate bed should anchor the arrangement when the caller did not
 * choose one.
 *
 * The anchor decides the key, the tempo and the chords every placed donor vocal
 * is judged against, so picking the first structurally usable source is an
 * arbitrary musical choice. Where a candidate bed carries its own independently
 * tracked bass line, that bass can corroborate or contradict the bed's own chord
 * analysis. A bed whose bass agrees is a safer foundation than one whose own
 * harmonic foundation argues with its labels.
 *
 * This only ever moves between candidates that are already structurally usable,
 * and returns null when nothing corroborates anything, leaving the previous
 * ordering untouched.
 */
function bedConfirmedByBass(sources: readonly AutomaticRemixSource[]): AutomaticRemixSource | null {
  for (const source of sources) {
    if (!source.bedHarmony || !source.bassLine?.length) continue;
    if (source.bedHarmony.sourceChecksumSha256 !== source.checksumSha256) continue;
    const bedChords = bedChordsFromHarmonyEvents(source.bedHarmony.events);
    if (!bedChords.length) continue;
    const bass = assessBassLine({
      notes: source.bassLine,
      bedChords,
      fromMs: Math.min(...bedChords.map((chord) => chord.startMs)),
      toMs: Math.max(...bedChords.map((chord) => chord.endMs)),
    });
    if (bass.status !== "measured") continue;
    if (bassContradictsHarmony(bass).contradicts) continue;
    return source;
  }
  return null;
}

export function assessWholeHybridArrangement(input: {
  anchor: AutomaticRemixSource;
  donor: AutomaticRemixSource;
  /** Every counterpart pair the planner intends to place. */
  counterparts: ReadonlyMap<string, AutomaticRemixSection>;
}): WholeArrangementDecision {
  const { anchor, donor, counterparts } = input;
  if (!anchor.bedHarmony) {
    return {
      status: "unavailable",
      reason: `The anchor bed for ${anchor.originalFilename} has no current checksum-bound chord analysis from its non-vocal stems, so the placed donor vocal cannot be judged against it.`,
    };
  }
  if (anchor.bedHarmony.sourceChecksumSha256 !== anchor.checksumSha256) {
    return { status: "unavailable", reason: "The anchor bed chord analysis does not match the current source checksum." };
  }
  const donorKey = trustedKey(donor);
  const anchorKey = trustedKey(anchor);
  const semitones = donorKey && anchorKey ? semitoneShift(donorKey, anchorKey) : null;
  if (semitones === null) {
    return { status: "unavailable", reason: "No authorized pitch shift is available for this placement." };
  }
  if (!donor.vocalNotes?.length) {
    return { status: "unavailable", reason: `No isolated vocal notes are available for ${donor.originalFilename}.` };
  }
  const anchorSections = usableSections(anchor);
  const donorSections = usableSections(donor);
  const sectionInputs: ArrangementSectionAssessmentInput[] = [];
  for (const [anchorSectionId, donorSection] of counterparts) {
    const anchorSection = anchorSections.find((section) => section.id === anchorSectionId);
    if (!anchorSection || !donorSection) continue;
    sectionInputs.push({
      anchorSectionId,
      donorSectionId: donorSection.id,
      anchorStartMs: anchorSection.startMs,
      anchorEndMs: anchorSection.endMs,
      donorStartMs: donorSection.startMs,
      donorEndMs: donorSection.endMs,
      notes: donor.vocalNotes,
      pitchShiftSemitones: semitones,
    });
  }
  if (!sectionInputs.length) {
    return { status: "unavailable", reason: "No matched section pair could be resolved on the planned timeline." };
  }
  const bedChords = bedChordsFromHarmonyEvents(anchor.bedHarmony.events);
  const harmony = assessWholeArrangementHarmony({ sections: sectionInputs, bedChords });
  if (harmony.status === "unavailable") return { status: "unavailable", reason: harmony.reason };

  // Independent bass evidence for the retained bed. Absent or stale evidence is
  // reported as unavailable and never treated as support.
  const bass = anchor.bassLine?.length
    ? assessBassLine({
      notes: anchor.bassLine,
      bedChords,
      fromMs: Math.min(...sectionInputs.map((section) => section.anchorStartMs)),
      toMs: Math.max(...sectionInputs.map((section) => section.anchorEndMs)),
    })
    : { status: "unavailable" as const, reason: "No trustworthy bass-line evidence is available for the retained bed." };
  const bassVerdict = bass.status === "measured"
    ? bassContradictsHarmony(bass)
    : { contradicts: false, reason: bass.reason };
  const harmonyVerdict = wholeArrangementConforming(harmony);
  const parts = [harmonyVerdict.reason];
  if (bass.status === "measured") parts.push(`bass: ${bassVerdict.reason}`);
  else parts.push(`bass not judged: ${bassVerdict.reason}`);
  return {
    status: "measured",
    conforming: harmonyVerdict.conforming && !bassVerdict.contradicts,
    reason: parts.join("; "),
    harmony,
    bass,
    bassContradicts: bassVerdict.contradicts,
    bassReason: bassVerdict.reason,
    assessedSectionCount: sectionInputs.length,
  };
}

function passageHybridCounterparts(anchor: AutomaticRemixSource, candidate: AutomaticRemixSource) {
  if (anchor.id === candidate.id || !sourceHasVerifiedAnalysis(anchor) || !sourceHasVerifiedAnalysis(candidate)) return null;
  const anchorBpm = trustedBpm(anchor) ?? 0;
  const candidateBpm = trustedBpm(candidate) ?? 0;
  const anchorKey = trustedKey(anchor);
  const donorKey = trustedKey(candidate);
  const expectedKeyShift = anchorKey && donorKey ? semitoneShift(donorKey, anchorKey) : null;
  const anchorSections = usableSections(anchor);
  const donorSections = usableSections(candidate);
  const fingerprintCount = anchorSections.filter((section) => section.passageFingerprint).length
    + donorSections.filter((section) => section.passageFingerprint).length;
  const usedDonorSections = new Set<string>();
  const matches = new Map<string, AutomaticRemixSection>();
  const comparisons: AutomaticRemixCompatibilityPair[] = [];
  for (const anchorSection of anchorSections) {
    const anchorFingerprint = anchorSection.passageFingerprint;
    if (!anchorFingerprint) continue;
    const choices = donorSections.flatMap((donorSection) => {
      const donorFingerprint = donorSection.passageFingerprint;
      if (!donorFingerprint || usedDonorSections.has(donorSection.id)) return [];
      const comparison = comparePassageCompatibility({
        anchorSectionId: anchorSection.id,
        donorSectionId: donorSection.id,
        anchor: anchorFingerprint,
        donor: donorFingerprint,
        anchorBpm,
        donorBpm: candidateBpm,
        anchorBeatConfidence: anchor.analysis?.beatConfidence ?? 0,
        donorBeatConfidence: candidate.analysis?.beatConfidence ?? 0,
        anchorKeyTrusted: anchorKey !== null,
        donorKeyTrusted: donorKey !== null,
        expectedKeyShift,
      });
      const progression = progressionContext(anchor, anchorSection, candidate, donorSection, comparison.transpositionSemitones ?? 0);
      comparisons.push({
        ...comparison,
        dimensions: { ...comparison.dimensions, chordProgression: progression },
        anchorSourceName: anchor.originalFilename,
        donorSourceName: candidate.originalFilename,
      });
      if (!comparison.eligible) return [];
      const score = Math.min(
        comparison.dimensions.rhythm.similarity ?? -1,
        comparison.dimensions.harmony.similarity ?? -1,
        comparison.dimensions.beatPhase.similarity ?? -1,
      );
      return [{ section: donorSection, comparison, score, progression: progression.status === "context" ? progression.similarity ?? -1 : -1 }];
    }).sort((left, right) => right.score - left.score || right.progression - left.progression || left.section.startMs - right.section.startMs);
    const selected = choices[0];
    if (selected) {
      usedDonorSections.add(selected.section.id);
      matches.set(anchorSection.id, selected.section);
    }
  }
  const ranked = [...comparisons].sort((left, right) =>
    Number(right.eligible) - Number(left.eligible)
    || Math.min(right.dimensions.rhythm.similarity ?? -1, right.dimensions.harmony.similarity ?? -1, right.dimensions.beatPhase.similarity ?? -1)
      - Math.min(left.dimensions.rhythm.similarity ?? -1, left.dimensions.harmony.similarity ?? -1, left.dimensions.beatPhase.similarity ?? -1)
    || (right.dimensions.chordProgression?.similarity ?? -1) - (left.dimensions.chordProgression?.similarity ?? -1),
  ).slice(0, 12);
  const missingEvidence = [...new Set([
    ...ranked.flatMap((pair) => pair.missingEvidence),
    ...(fingerprintCount < anchorSections.length + donorSections.length
      ? ["current passage fingerprints for every section; rerun section analysis with engine 1.6.0"] : []),
    ...(anchorBpm <= 0 || candidateBpm <= 0 ? ["trusted BPM analysis for both sources"] : []),
  ])];
  return {
    matches,
    report: {
      evaluatedPairs: comparisons.length,
      eligiblePairs: comparisons.filter((pair) => pair.eligible).length,
      pairs: ranked,
      missingEvidence,
      note: fingerprintCount === 0
        ? "No current passage fingerprints were found. Re-run structural analysis; older section rows are not silently upgraded."
        : "Passage matches require independent onset, chroma, beat-phase, and trusted tempo evidence. A match is an audition candidate, not a listening-quality claim.",
    } satisfies AutomaticRemixCompatibilityReport,
  };
}

function unavailablePassageReport(candidate: AutomaticRemixSource): AutomaticRemixCompatibilityReport {
  const hasCurrentAnalysis = sourceHasVerifiedAnalysis(candidate);
  const hasFingerprint = usableSections(candidate).some((section) => section.passageFingerprint);
  const missingEvidence = [
    ...(!hasCurrentAnalysis ? [`current checksum-verified source analysis for ${candidate.originalFilename}`] : []),
    ...(!trustedBpm(candidate) ? [`trusted tempo and beat analysis for ${candidate.originalFilename}`] : []),
    ...(!hasFingerprint ? [`current passage fingerprints for ${candidate.originalFilename}; rerun section analysis with engine 1.6.0`] : []),
  ];
  return {
    evaluatedPairs: 0,
    eligiblePairs: 0,
    pairs: [],
    missingEvidence: missingEvidence.length ? missingEvidence : ["current cross-song passage evidence"],
    note: "No passage pairs could be evaluated because current provenance or analysis evidence is missing.",
  };
}

function requestedStem(sources: AutomaticRemixSource[], stemId: string | undefined, stemType: string) {
  if (!stemId) return null;
  return sources.flatMap((source) => source.stems.map((stem) => ({ source, stem })))
    .find((candidate) => candidate.stem.id === stemId && candidate.stem.stemType === stemType) ?? null;
}

/**
 * The drum question, answered from evidence this pipeline actually persists.
 *
 * `drumEvidence` is checksum-bound transient onsets. A row from a non-current
 * engine is NOT evidence (an older engine measured something else), so it is
 * refused rather than read as "the donor played nothing". A bed with no drum
 * stem at all is a different fact from a bed whose drums were not measured, and
 * both are reported as unavailable rather than as a preference.
 */
function decideDrumBedForCandidate(input: {
  anchor: AutomaticRemixSource;
  donor: AutomaticRemixSource;
  counterparts: ReadonlyMap<string, AutomaticRemixSection>;
}): DrumBedDecision {
  const { anchor, donor, counterparts } = input;
  const verified = (source: AutomaticRemixSource, stemType: "drums" | "percussion") => {
    const stem = source.stems.find((candidate) => candidate.stemType === stemType)
      ?? source.stems.find((candidate) => candidate.stemType === "drums")
      ?? source.stems.find((candidate) => candidate.stemType === "percussion");
    if (!stem) return null;
    const evidence = source.drumEvidence;
    if (!evidence) return null;
    const supportedEngine = (evidence.analysisEngine === DRUM_ANALYSIS_ENGINE
      && evidence.analysisEngineVersion === DRUM_ANALYSIS_ENGINE_VERSION)
      || (evidence.analysisEngine === LOCAL_DRUM_ANALYSIS_ENGINE
        && evidence.analysisEngineVersion === LOCAL_DRUM_ANALYSIS_ENGINE_VERSION);
    if (!supportedEngine) return null;
    // The stem bytes this evidence was measured from must still be the stem's
    // bytes. Comparing the evidence's checksum against itself would certify
    // anything, so the stem record has to carry its own checksum for the claim
    // to mean something.
    if (!stem.checksumSha256) return null;
    if (drumAnalysisProvenanceReason({
      sourceAssetId: source.id,
      expectedSourceAssetId: source.id,
      stemAssetId: evidence.stemAssetId,
      expectedStemAssetId: stem.id,
      sourceChecksumSha256: evidence.sourceChecksumSha256,
      expectedSourceChecksumSha256: source.checksumSha256,
      stemChecksumSha256: evidence.stemChecksumSha256,
      expectedStemChecksumSha256: stem.checksumSha256,
      analysisEngine: evidence.analysisEngine,
      analysisEngineVersion: evidence.analysisEngineVersion,
    }, {
      // A local-worker row and a desktop-detector row are separate engines with
      // separate version histories; judging one against the other's constant
      // would reject every row the worker writes.
      engine: evidence.analysisEngine === DRUM_ANALYSIS_ENGINE
        ? DRUM_ANALYSIS_ENGINE : LOCAL_DRUM_ANALYSIS_ENGINE,
      version: evidence.analysisEngine === DRUM_ANALYSIS_ENGINE
        ? DRUM_ANALYSIS_ENGINE_VERSION : LOCAL_DRUM_ANALYSIS_ENGINE_VERSION,
    })) return null;
    return { stem, evidence };
  };
  const anchorPart = verified(anchor, "drums");
  if (!anchorPart)
    return {
      decision: "unavailable",
      reason: `The bed ${anchor.originalFilename} has no checksum-current drum transient evidence, so its own rhythm section cannot be compared with the donor's.`,
      measurements: null,
    };
  const donorPart = verified(donor, "drums");
  if (!donorPart)
    return {
      decision: "unavailable",
      reason: `The donor ${donor.originalFilename} has no checksum-current drum transient evidence, so its drum part cannot be compared with the bed's.`,
      measurements: null,
    };
  const anchorGrid = usableBeatGrid(anchor.analysis?.beatGridMs);
  const anchorBpm = trustedBpm(anchor);
  const donorBpm = trustedBpm(donor);
  // The transform the clip plan will apply. When either tempo is untrusted the
  // planner authorizes no stretch, so the ratio is 1 -- and the decision must
  // judge the parts as they would actually be played, not as a hypothetical.
  const tempoRatio = anchorBpm && donorBpm ? anchorBpm / donorBpm : 1;
  const placements: DrumPlacement[] = [];
  for (const [anchorSectionId, donorSection] of counterparts) {
    const anchorSection = usableSections(anchor).find((section) => section.id === anchorSectionId);
    if (!anchorSection) continue;
    placements.push({
      anchorSectionId,
      donorSectionId: donorSection.id,
      durationMs: anchorSection.endMs - anchorSection.startMs,
      anchorSourceStartMs: anchorSection.startMs,
      donorSourceStartMs: donorSection.startMs,
    });
  }
  return decideDonorDrumBed({
    anchorGroove: measureStemGroove("drums", anchorPart.evidence.events, anchorGrid, anchor.analysis?.beatConfidence),
    donorGroove: measureStemGroove("drums", donorPart.evidence.events, usableBeatGrid(donor.analysis?.beatGridMs), donor.analysis?.beatConfidence),
    anchorGrid,
    tempoRatio,
    placements,
  });
}


function firstStem(source: AutomaticRemixSource, stemType: string) {
  return source.stems.find((stem) => stem.stemType === stemType) ?? null;
}

function clipWindows(
  source: AutomaticRemixSource,
  anchor: AutomaticRemixSource,
  targetBpm: number | null,
  counterparts?: ReadonlyMap<string, AutomaticRemixSection>,
) {
  const anchorSections = sourceCanStructure(anchor) ? usableSections(anchor) : [];
  const foreign = source.id !== anchor.id;
  const sourceSections = sourceCanStructure(source) ? usableSections(source) : [];
  if (foreign && !counterparts) return null;
  const sourceBpm = trustedBpm(source);
  const ratio = foreign && targetBpm && sourceBpm ? targetBpm / sourceBpm : 1;
  const tempoSyncEnabled = foreign && ratio !== 1;
  const targetKey = trustedKey(anchor);
  const sourceKey = trustedKey(source);
  const keySyncEnabled = foreign && Boolean(targetKey && sourceKey && semitoneShift(sourceKey, targetKey));
  const beatSnapEnabled = sourceCanStructure(source);
  if (!anchorSections.length) return [{ timelineStartMs: 0, durationMs: source.durationMs, sourceOffsetMs: 0, gain: 1, fadeInMs: 0, fadeOutMs: 0, tempoSyncEnabled: false, keySyncEnabled: false, beatSnapEnabled: false }];
  let cursor = 0;
  const clips: Omit<AutomaticRemixClipPlan, "stemAssetId">[] = [];
  for (const anchorSection of anchorSections) {
    const section = foreign ? counterparts?.get(anchorSection.id) : anchorSection;
    const durationMs = anchorSection.endMs - anchorSection.startMs;
    if (section && (!foreign || sourceSections.some((candidate) => candidate.id === section.id))) {
      clips.push({
        timelineStartMs: cursor,
        durationMs,
        sourceOffsetMs: section.startMs,
        gain: 1,
        fadeInMs: 0,
        fadeOutMs: 0,
        tempoSyncEnabled,
        keySyncEnabled,
        beatSnapEnabled,
      });
    }
    cursor += durationMs;
  }
  return clips.length ? clips : null;
}

function completeConstraints(constraints: AutomaticRemixConstraints, variant: AutomaticRemixVariant) {
  return {
    variant,
    ...(constraints.anchorSourceId ? { anchorSourceId: constraints.anchorSourceId } : {}),
    ...(constraints.vocalStemId ? { vocalStemId: constraints.vocalStemId } : {}),
    ...(constraints.drumsStemId ? { drumsStemId: constraints.drumsStemId } : {}),
    instrumental: constraints.instrumental === true,
  };
}

function combinedCompatibilityReport(reports: AutomaticRemixCompatibilityReport[]): AutomaticRemixCompatibilityReport | undefined {
  if (!reports.length) return undefined;
  const pairs = reports.flatMap((report) => report.pairs)
    .sort((left, right) => Number(right.eligible) - Number(left.eligible)
      || Math.min(right.dimensions.rhythm.similarity ?? -1, right.dimensions.harmony.similarity ?? -1, right.dimensions.beatPhase.similarity ?? -1)
        - Math.min(left.dimensions.rhythm.similarity ?? -1, left.dimensions.harmony.similarity ?? -1, left.dimensions.beatPhase.similarity ?? -1))
    .slice(0, 12);
  return {
    evaluatedPairs: reports.reduce((total, report) => total + report.evaluatedPairs, 0),
    eligiblePairs: reports.reduce((total, report) => total + report.eligiblePairs, 0),
    pairs,
    missingEvidence: [...new Set(reports.flatMap((report) => report.missingEvidence))],
    note: "Passage matches require independent onset, chroma, beat-phase, and trusted tempo evidence. A match is an audition candidate, not a listening-quality claim.",
  };
}

/**
 * Builds only ordinary RemixTrack/RemixClip-shaped decisions. No new timeline,
 * beat grid, audio renderer, or persistent opaque arrangement object is made.
 */
export function buildAutomaticRemixPlan(
  sources: AutomaticRemixSource[],
  constraints: AutomaticRemixConstraints = {},
): AutomaticRemixResult {
  const usableSources = sources.filter(sourceIsUsable);
  if (!usableSources.length) return { ok: false, reason: "no_usable_source" };
  const variant: AutomaticRemixVariant = constraints.variant === "hybrid" ? "hybrid" : "original";
  const explicitAnchor = usableSources.find((source) => source.id === constraints.anchorSourceId);
  const anchor = explicitAnchor
    ?? bedConfirmedByBass(usableSources.filter(sourceCanStructure))
    ?? usableSources.find(sourceCanStructure)
    ?? usableSources[0];
  const anchorBpm = trustedBpm(anchor);
  const targetKey = trustedKey(anchor);
  const notices: string[] = [];
  const decisions = ["anchored to one preserved source structure"];
  // State the reason only when the evidence actually supports it. Emitting this
  // whenever a bass line merely exists would be an unsupported claim, and it is
  // exactly what a stale or contradicting analysis must not produce.
  if (!explicitAnchor && anchor.bedHarmony && anchor.bassLine?.length) {
    const anchorBedChords = bedChordsFromHarmonyEvents(anchor.bedHarmony.events);
    const anchorBass = anchorBedChords.length
      ? assessBassLine({
        notes: anchor.bassLine,
        bedChords: anchorBedChords,
        fromMs: Math.min(...anchorBedChords.map((chord) => chord.startMs)),
        toMs: Math.max(...anchorBedChords.map((chord) => chord.endMs)),
      })
      : null;
    if (anchorBass?.status === "measured" && !bassContradictsHarmony(anchorBass).contradicts) {
      decisions.push("preferred this anchor because its own bass line corroborates its chord analysis");
    }
  }
  if (!sourceCanStructure(anchor)) notices.push("Structural analysis is incomplete, so Waveyard preserved the source as one continuous arrangement.");
  if (!anchorBpm) notices.push("Tempo confidence is insufficient, so Waveyard will not claim BPM matching or beat snapping for this arrangement.");
  const selected = new Map<string, { source: AutomaticRemixSource; stem: AutomaticRemixStem }>();
  const counterpartsBySource = new Map<string, ReadonlyMap<string, AutomaticRemixSection>>();
  const compatibilityBySource = new Map<string, AutomaticRemixCompatibilityReport>();
  /** Drum-bed decisions per donor, kept for provenance so the choice is auditable. */
  const drumDecisionBySource = new Map<string, DrumBedDecision>();
  for (const stem of anchor.stems) selected.set(stem.stemType, { source: anchor, stem });

  if (variant === "hybrid" && !sourceCanStructure(anchor)) {
    const compatibility = combinedCompatibilityReport(usableSources.map(unavailablePassageReport));
    return { ok: false, reason: "hybrid_evidence_unavailable", ...(compatibility ? { compatibility } : {}) };
  }

  if (variant === "hybrid" && sourceCanStructure(anchor)) {
    const requestedVocals = requestedStem(usableSources, constraints.vocalStemId, "vocals");
    const requestedDrums = requestedStem(usableSources, constraints.drumsStemId, "drums");
    const candidates = new Map<string, { source: AutomaticRemixSource; stem: AutomaticRemixStem }>();
    for (const value of [requestedVocals, requestedDrums]) {
      if (value) candidates.set(`${value.source.id}:${value.stem.stemType}`, value);
    }
    const defaultVocalCandidates: Array<{
      source: AutomaticRemixSource;
      stem: AutomaticRemixStem;
      counterparts: Map<string, AutomaticRemixSection>;
    }> = [];
    for (const source of usableSources) {
      const stem = firstStem(source, "vocals");
      if (!stem || source.id === anchor.id) continue;
      const passage = passageHybridCounterparts(anchor, source);
      if (passage) {
        compatibilityBySource.set(source.id, passage.report);
        if (passage.matches.size) defaultVocalCandidates.push({ source, stem, counterparts: passage.matches });
      } else compatibilityBySource.set(source.id, unavailablePassageReport(source));
    }
    // Rank donor vocals on the material a hybrid keeps, not on how many
    // structural passage pairs happened to match. A candidate with fewer
    // matched sections but a melody that sits on the retained bed is a better
    // arrangement than one with more matches and a melody that fights it.
    const retainedFitBySource = new Map<string, WholeArrangementDecision>();
    const retainedFitFor = (source: AutomaticRemixSource, counterparts: ReadonlyMap<string, AutomaticRemixSection>) => {
      const cached = retainedFitBySource.get(source.id);
      if (cached) return cached;
      // Judge the complete proposed arrangement: every matched section the
      // planner would actually place, plus the bed's independent bass line.
      // A pairing that only works at the opening fails here.
      const result = counterparts.size > 0
        ? assessWholeHybridArrangement({ anchor, donor: source, counterparts })
        : { status: "unavailable" as const, reason: "No matched section pair is available to place the donor vocal." };
      retainedFitBySource.set(source.id, result);
      return result;
    };
    /**
     * Ranking for the actual selection.
     *
     * The decision is categorical, not a composite: a candidate whose complete
     * arrangement is endorsed outranks one that is not, regardless of how good
     * its best passage looked. Within the endorsed group the least-consonant
     * judged section decides, because a pairing is only as good as its weakest
     * moment. Unavailable evidence sorts below a measured endorsement and below
     * a measured conflict, because it is not a fact about the music.
     */
    const conforms = (source: AutomaticRemixSource, counterparts: ReadonlyMap<string, AutomaticRemixSection>) => {
      const fit = retainedFitFor(source, counterparts);
      if (fit.status !== "measured") return -1;
      if (!fit.conforming) return -0.5;
      // Smallest weakest-section conformance first; ties fall through to the
      // existing counterparts.size ordering.
      return fit.harmony.weakestConformance ?? 0;
    };
    const defaultVocal = defaultVocalCandidates
      .sort((left, right) =>
        conforms(right.source, right.counterparts) - conforms(left.source, left.counterparts)
        || right.counterparts.size - left.counterparts.size)[0] ?? null;
    if (defaultVocal) {
      candidates.set(`${defaultVocal.source.id}:vocals`, { source: defaultVocal.source, stem: defaultVocal.stem });
      counterpartsBySource.set(defaultVocal.source.id, defaultVocal.counterparts);
    }
    for (const candidate of candidates.values()) {
      const passage = passageHybridCounterparts(anchor, candidate.source);
      const counterparts = passage?.matches.size ? passage.matches : null;
      if (passage) compatibilityBySource.set(candidate.source.id, passage.report);
      else compatibilityBySource.set(candidate.source.id, unavailablePassageReport(candidate.source));
      if (!counterparts) {
        notices.push(`${candidate.source.originalFilename} was kept out of the hybrid because no section pair passed the measured tempo, rhythm, chroma, and beat-phase checks.`);
        continue;
      }
      if (candidate.stem.stemType === "vocals") {
        selected.set(candidate.stem.stemType, candidate);
        counterpartsBySource.set(candidate.source.id, counterparts);
        continue;
      }
      if (candidate.stem.stemType === "drums") {
        // The requested donor drum part is not accepted on arrival order. What
        // happens to the bed's own rhythm section is decided from measured
        // transient evidence; when that evidence cannot support an answer the
        // bed keeps its own drums and the plan says so.
        const drumDecision = decideDrumBedForCandidate({
          anchor,
          donor: candidate.source,
          counterparts,
        });
        drumDecisionBySource.set(candidate.source.id, drumDecision);
        const pairing = `${candidate.source.originalFilename}'s drums`;
        if (drumDecision.decision === "retain") {
          notices.push(`The bed keeps its own drums: ${drumDecision.reason}`);
          continue;
        }
        if (drumDecision.decision === "unavailable") {
          notices.push(`Drum evidence is insufficient, so the bed keeps its own drums: ${drumDecision.reason}`);
          continue;
        }
        if (drumDecision.decision === "reject") {
          notices.push(`The donor drums were refused: ${drumDecision.reason}`);
          continue;
        }
        if (drumDecision.decision === "replace") {
          selected.set("drums", candidate);
          counterpartsBySource.set(candidate.source.id, counterparts);
          decisions.push(`replaced the anchor drums with ${pairing} on measured compatibility: ${drumDecision.reason}`);
          continue;
        }
        // `layer` needs two drum tracks, which only exists if the donor is a
        // different source. Layering a source's own drums over itself would be
        // the same part twice, so that is refused rather than planned.
        if (candidate.source.id === anchor.id) {
          notices.push(`The bed keeps its own drums: the requested drum stem belongs to the anchor itself, so layering it would play the same part twice.`);
          continue;
        }
        selected.set("drums+donor", candidate);
        counterpartsBySource.set(candidate.source.id, counterparts);
        decisions.push(`layered the donor drums over the anchor drums on measured compatibility: ${drumDecision.reason}`);
      }
    }
    if ([...selected.values()].some((choice) => choice.source.id !== anchor.id)) {
      // Say what actually happened. A donor used only to layer drums over the
      // bed's did not replace that part, and a plan that claims it did would
      // misdescribe the arrangement the listener gets.
      const replaced = ["vocals", "drums"].filter((role) =>
        [...selected.entries()].some(([key, choice]) => key === role && choice.source.id !== anchor.id));
      const layeredOnly = [...selected.keys()].includes("drums+donor");
      decisions.push(replaced.length
        ? `replaced only verified, structurally compatible featured stems (${replaced.join(", ")})`
        : "did not remove any part of the anchor bed; only added verified, structurally compatible donor material"
        );
      if (layeredOnly) decisions.push("kept the anchor's drums alongside the donor's on measured complementarity");
    }
    else {
      const compatibility = combinedCompatibilityReport([...compatibilityBySource.values()]);
      const reason = compatibility && compatibility.evaluatedPairs > 0
        ? "no_compatible_hybrid_source"
        : "hybrid_evidence_unavailable";
      return { ok: false, reason, ...(compatibility ? { compatibility } : {}) };
    }
    if (compatibilityBySource.size) {
      const compatibility = combinedCompatibilityReport([...compatibilityBySource.values()]);
      if (compatibility) {
        notices.push(`Passage-level matches: ${compatibility.eligiblePairs}. They are audition candidates; ${compatibility.missingEvidence.length ? `still missing ${compatibility.missingEvidence.join(", ")}.` : "all listed evidence is present."}`);
        decisions.push("used independent passage-level rhythm, chroma, beat-phase, and tempo evidence without requiring semantic verse/chorus labels");
        const selectedProgressionMatches = [...counterpartsBySource.entries()].some(([sourceId, counterparts]) =>
          sourceId !== anchor.id && [...counterparts.entries()].some(([anchorSectionId, donorSection]) =>
            compatibilityBySource.get(sourceId)?.pairs.some((pair) => pair.anchorSectionId === anchorSectionId
              && pair.donorSectionId === donorSection.id && pair.dimensions.chordProgression?.status === "context")));
        if (selectedProgressionMatches)
          decisions.push("used advisory checksum-bound chord-progression agreement to rank otherwise-equivalent passage matches");
        decisions.push("judged every matched section of the proposed arrangement rather than its opening alone");
      }
    }
  }

  if (constraints.instrumental) {
    for (const [key, choice] of selected) {
      if (choice.stem.stemType === "vocals") selected.delete(key);
    }
    decisions.push("removed vocals at the user’s request");
  }
  if (!selected.size) return { ok: false, reason: "no_stems" };
  const ordered = [...selected.values()].sort((left, right) => roleRank(left.stem) - roleRank(right.stem) || left.stem.id.localeCompare(right.stem.id));
  const tracks: AutomaticRemixTrackPlan[] = [];
  for (const [sortOrder, { source, stem }] of ordered.entries()) {
    const clips = clipWindows(source, anchor, anchorBpm, counterpartsBySource.get(source.id));
    if (!clips) return { ok: false, reason: "unsafe_hybrid_alignment" };
    tracks.push({
      stemAssetId: stem.id,
      stemType: stem.stemType,
      name: sourceLabel(source, stem),
      sortOrder,
      volume: defaultVolume[stem.stemType] ?? 0.82,
      pan: 0,
      clips: clips.map((clip) => ({ ...clip, stemAssetId: stem.id })),
    });
  }
  const analysisIds = [...new Set(ordered.map((choice) => choice.source.analysis?.id).filter((id): id is string => Boolean(id)))];
  const compatibility = combinedCompatibilityReport([...compatibilityBySource.values()]);
  return {
    ok: true,
    plan: {
      name: variant === "hybrid" ? "Automatic hybrid" : "Automatic original",
      tempoBpm: anchorBpm ?? 120,
      targetKey,
      tracks,
      notices,
      ...(compatibility ? { compatibility } : {}),
      provenance: {
        engine: AUTOMATIC_REMIX_ENGINE,
        engineVersion: AUTOMATIC_REMIX_ENGINE_VERSION,
        variant,
        anchorSourceId: anchor.id,
        anchorSourceChecksumSha256: anchor.checksumSha256,
        sourceAnalysisIds: analysisIds,
        targetBpm: anchorBpm,
        targetKey,
        constraints: completeConstraints(constraints, variant),
        decisions,
        ...(compatibility ? { passageCompatibility: compatibility } : {}),
        ...(drumDecisionBySource.size ? {
          drumBedDecisions: [...drumDecisionBySource.entries()].map(([donorSourceId, decision]) => ({
            donorSourceId,
            donorFilename: usableSources.find((source) => source.id === donorSourceId)?.originalFilename ?? donorSourceId,
            outcome: decision.decision,
            reason: decision.reason,
            measurements: decision.measurements,
          })),
        } : {}),
      },
    },
  };
}
