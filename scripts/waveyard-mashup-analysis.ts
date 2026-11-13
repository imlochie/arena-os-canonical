import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { writeFile } from "node:fs/promises";
import { basename, resolve } from "node:path";
import {
  analysePcm,
  beatConfidenceFromGrid,
  decodeMonoPcm,
  DESKTOP_ANALYSIS_ENGINE,
  DESKTOP_ANALYSIS_ENGINE_VERSION,
  normaliseBeatGrid,
  onsetEnvelope,
} from "../lib/arena/src/lib/waveyard/worker-local/analysis-engine";
import { buildPassageFingerprint, desktopSectionCandidates, detectRepeatedPhraseMatches, sectionEnergyChangeDb } from "../lib/arena/src/lib/waveyard/worker-local/section-rhythm";
import { DESKTOP_SECTION_ENGINE, DESKTOP_SECTION_ENGINE_VERSION } from "../lib/arena/src/lib/waveyard/types/analysis-provenance";
import { normalizeSourceSections, sourceSectionsAreValid } from "../lib/arena/src/lib/waveyard/types/source-sections";
import { comparePassageCompatibility } from "../lib/arena/src/lib/waveyard/types/passage-compatibility";
import { normaliseMusicalKey, semitoneShift } from "../lib/arena/src/lib/waveyard/types/musical-key";
import {
  hasReliableLiveStemBeatEvidence,
  liveStemBeatOffsetSeconds,
  liveStemSectionAlignment,
  liveStemTempoStretchRatio,
} from "../lib/arena/src/lib/waveyard/library/session-logic";

const args = process.argv.slice(2).filter((value) => value !== "--");
const [outputPath, excerptStartText, excerptDurationText, ...sourcePaths] = args;
const excerptStartSeconds = Number(excerptStartText ?? "15");
const fullTrack = excerptDurationText === "full";
const excerptDurationSeconds = fullTrack ? null : Number(excerptDurationText ?? "12");
if (!outputPath || sourcePaths.length < 2
  || !Number.isFinite(excerptStartSeconds) || excerptStartSeconds < 0
  || (fullTrack && excerptStartSeconds !== 0)
  || (!fullTrack && (
    excerptDurationSeconds === null
    || !Number.isFinite(excerptDurationSeconds)
    || excerptDurationSeconds < 2
  ))) {
  throw new Error(
    "Usage: tsx scripts/waveyard-mashup-analysis.ts -- <output.json> <excerpt-start-seconds> <excerpt-duration-seconds|full> <two or more audio paths>",
  );
}

async function checksumFile(path: string) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}

const tracks = [];
for (const sourcePath of sourcePaths) {
  const absolutePath = resolve(sourcePath);
  const pcm = fullTrack
    ? await decodeMonoPcm(absolutePath)
    : await decodeMonoPcm(absolutePath, Math.max(60, excerptStartSeconds + excerptDurationSeconds! + 15));
  const analysis = analysePcm(pcm);
  const analyzedDurationSeconds = Math.round((pcm.length / 22_050) * 100) / 100;
  const evaluatedDurationSeconds = fullTrack
    ? Math.max(0, analyzedDurationSeconds - excerptStartSeconds)
    : excerptDurationSeconds!;
  const beatGridMs = analysis.beatGridMs === null
    ? null
    : normaliseBeatGrid(analysis.beatGridMs, analyzedDurationSeconds);
  if (analysis.beatGridMs !== null && beatGridMs === null) {
    throw new Error(`Analysis returned an invalid beat grid for ${basename(absolutePath)}.`);
  }
  const combinedBeatConfidence = beatGridMs === null
    ? analysis.beatConfidence
    : beatConfidenceFromGrid(analysis.bpmConfidence, beatGridMs, analysis.beatConfidence);
  if (beatGridMs === null && combinedBeatConfidence !== null) {
    throw new Error(`Analysis returned beat confidence without a beat grid for ${basename(absolutePath)}.`);
  }
  const startMs = Math.round(excerptStartSeconds * 1000);
  const endMs = startMs + Math.round(evaluatedDurationSeconds * 1000);
  const { envelope, frameMs } = onsetEnvelope(pcm);
  const phraseMatches = beatGridMs
    ? detectRepeatedPhraseMatches(beatGridMs, envelope, frameMs, pcm)
    : null;
  const sectionCandidates = beatGridMs
    ? desktopSectionCandidates(beatGridMs, envelope, frameMs, pcm, phraseMatches ?? undefined)
    : null;
  const sourceChecksumSha256 = await checksumFile(absolutePath);
  const fingerprintedCandidates = sectionCandidates && beatGridMs
    ? sectionCandidates.map((candidate) => ({
      ...candidate,
      passageFingerprint: buildPassageFingerprint({
        sourceChecksumSha256,
        startBeatIndex: candidate.startBeatIndex,
        endBeatIndex: candidate.endBeatIndex,
        beatGridMs,
        beatConfidence: combinedBeatConfidence,
        envelope,
        frameMs,
        pcm,
      }),
    }))
    : null;
  const normalizedSections = fingerprintedCandidates && beatGridMs
    ? normalizeSourceSections(
      fingerprintedCandidates,
      beatGridMs,
      {
        analysisEngine: DESKTOP_SECTION_ENGINE,
        analysisEngineVersion: DESKTOP_SECTION_ENGINE_VERSION,
        sourceChecksumSha256,
      },
      ({ startBeatIndex, endBeatIndex, sectionIndex }) => `evaluation:${sectionIndex}:${startBeatIndex}:${endBeatIndex}`,
      analyzedDurationSeconds * 1000,
    )
    : null;
  if (sectionCandidates && beatGridMs) {
    if (!normalizedSections || normalizedSections.length !== sectionCandidates.length) {
      throw new Error(`Some section candidates were rejected by persistence normalization for ${basename(absolutePath)}.`);
    }
    if (!sourceSectionsAreValid(normalizedSections, beatGridMs, analyzedDurationSeconds * 1000)) {
      throw new Error(`Section candidates failed persistence validation for ${basename(absolutePath)}.`);
    }
  }
  const phraseMatchesWithTimes = phraseMatches?.map((match) => {
    const section = normalizedSections?.find((candidate) =>
      candidate.startBeatIndex === match.startBeatIndex && candidate.endBeatIndex === match.endBeatIndex,
    );
    if (!section) {
      throw new Error(`A repeated phrase was not preserved by persistence normalization for ${basename(absolutePath)}.`);
    }
    return {
      startBeatIndex: match.startBeatIndex,
      endBeatIndex: match.endBeatIndex,
      startMs: section.startMs,
      endMs: section.endMs,
      label: match.label,
      similarity: match.labelConfidence,
    };
  }) ?? null;
  const sections = normalizedSections?.map((section, index) => {
    const candidate = sectionCandidates![index]!;
    return {
      id: section.id,
      sectionIndex: section.sectionIndex,
      startBeatIndex: section.startBeatIndex,
      endBeatIndex: section.endBeatIndex,
      startBar: section.startBar,
      endBar: section.endBar,
      startMs: section.startMs,
      endMs: section.endMs,
      label: section.label,
      labelConfidence: section.labelConfidence,
      structuralConfidence: section.structuralConfidence,
      analysisEngine: section.analysisEngine,
      analysisEngineVersion: section.analysisEngineVersion,
      sourceChecksumSha256: section.sourceChecksumSha256,
      passageFingerprint: section.passageFingerprint,
      energyChangeDb: beatGridMs
        ? sectionEnergyChangeDb(sectionCandidates![index - 1] ?? null, candidate, beatGridMs, pcm)
        : null,
    };
  }) ?? null;
  tracks.push({
    filename: basename(absolutePath),
    sourceChecksumSha256,
    analysisEngine: DESKTOP_ANALYSIS_ENGINE,
    analysisEngineVersion: DESKTOP_ANALYSIS_ENGINE_VERSION,
    sectionAnalysisEngine: DESKTOP_SECTION_ENGINE,
    sectionAnalysisEngineVersion: DESKTOP_SECTION_ENGINE_VERSION,
    repeatedPhraseMatches: phraseMatchesWithTimes,
    analyzedDurationSeconds,
    bpm: analysis.bpm,
    bpmConfidence: analysis.bpmConfidence,
    musicalKey: analysis.musicalKey,
    keyConfidence: analysis.keyConfidence,
    excerpt: {
      startSeconds: excerptStartSeconds,
      durationSeconds: evaluatedDurationSeconds,
      beatGridMs: beatGridMs
        ?.filter((beatMs) => beatMs >= startMs && beatMs <= endMs)
        .map((beatMs) => beatMs - startMs) ?? null,
    },
    rawBeatGridConfidence: analysis.beatConfidence,
    beatConfidence: combinedBeatConfidence,
    sections,
  });
}
const liveStemAlignmentProbe = fullTrack
  ? (() => {
    const orderedPairs = [];
    let evaluatedWindowPositions = 0;
    let acceptedWindowAlignments = 0;
    let beatFallbackWindowPositions = 0;
    let noAutomaticOffsetWindowPositions = 0;
    const candidateAlignments = [];

    for (const recipient of tracks) {
      for (const donor of tracks) {
        if (recipient === donor) continue;
        const recipientGrid = recipient.excerpt.beatGridMs;
        const donorGrid = donor.excerpt.beatGridMs;
        const tempoEvidence = {
          recipientBpmConfidence: recipient.bpmConfidence,
          donorBpmConfidence: donor.bpmConfidence,
          recipientBeatConfidence: recipient.beatConfidence,
          donorBeatConfidence: donor.beatConfidence,
        };
        const stretchRatio = recipientGrid && donorGrid
          ? liveStemTempoStretchRatio(recipient.bpm, donor.bpm, tempoEvidence)
          : null;
        const reliableBeatEvidence = hasReliableLiveStemBeatEvidence(tempoEvidence);
        const beatFallbackOffsetSeconds = stretchRatio !== null && reliableBeatEvidence
          ? liveStemBeatOffsetSeconds(recipientGrid, donorGrid, stretchRatio)
          : null;
        let pairWindows = 0;
        let pairAlignments = 0;
        let pairBeatFallbacks = 0;

        for (const section of recipient.sections ?? []) {
          const rollingWindows = section.passageFingerprint?.rollingWindows;
          if (rollingWindows?.status !== "measured") continue;
          for (const window of rollingWindows.value) {
            const recipientPositionMs = recipientGrid?.[window.startBeatIndex];
            if (!Number.isFinite(recipientPositionMs)) continue;
            pairWindows += 1;
            if (stretchRatio === null) continue;
            const alignment = liveStemSectionAlignment(
              recipient.sections,
              donor.sections,
              recipientPositionMs / 1000,
              stretchRatio,
              {
                ...tempoEvidence,
                recipientBeatGridMs: recipientGrid,
                donorBeatGridMs: donorGrid,
                recipientBpm: recipient.bpm,
                donorBpm: donor.bpm,
                recipientKey: recipient.musicalKey,
                donorKey: donor.musicalKey,
                recipientKeyConfidence: recipient.keyConfidence,
                donorKeyConfidence: donor.keyConfidence,
              },
            );
            if (alignment) {
              pairAlignments += 1;
              if (candidateAlignments.length < 50) {
                candidateAlignments.push({
                  recipient: recipient.filename,
                  donor: donor.filename,
                  recipientWindowStartMs: recipientPositionMs,
                  donorOffsetSeconds: alignment.offsetSeconds,
                  basis: alignment.basis,
                });
              }
            } else if (beatFallbackOffsetSeconds !== null) {
              pairBeatFallbacks += 1;
            }
          }
        }

        evaluatedWindowPositions += pairWindows;
        acceptedWindowAlignments += pairAlignments;
        beatFallbackWindowPositions += pairBeatFallbacks;
        noAutomaticOffsetWindowPositions += pairWindows - pairAlignments - pairBeatFallbacks;
        orderedPairs.push({
          recipient: recipient.filename,
          donor: donor.filename,
          recipientBpmConfidence: recipient.bpmConfidence,
          donorBpmConfidence: donor.bpmConfidence,
          recipientBeatConfidence: recipient.beatConfidence,
          donorBeatConfidence: donor.beatConfidence,
          stretchRatio,
          evaluatedWindowPositions: pairWindows,
          acceptedWindowAlignments: pairAlignments,
          beatFallbackOffsetSeconds,
          beatFallbackWindowPositions: pairBeatFallbacks,
          status: pairAlignments > 0
            ? "section-window-candidate"
            : beatFallbackOffsetSeconds !== null
              ? "beat-fallback"
              : "no-automatic-offset",
        });
      }
    }

    return {
      method: "Current liveStemSectionAlignment helper on full-track PCM-derived rolling feature windows",
      orderedTrackPairCount: orderedPairs.length,
      evaluatedWindowPositions,
      acceptedWindowAlignments,
      beatFallbackWindowPositions,
      noAutomaticOffsetWindowPositions,
      orderedPairs,
      candidateAlignments,
      groundTruth: {
        status: "blocked-no-independent-phrase-pairs",
        correctMatches: null,
        misses: null,
        falseMatches: null,
        meanAbsoluteOffsetErrorMs: null,
        reason: "The pipeline does not emit lyric-phrase boundaries, and the recordings have no locked independent vocal-phrase pair annotations or adjudicated usefulness judgments.",
      },
      interpretation: "These are 8-beat rolling feature-window alignments, not detected vocal or lyric phrases. A returned section-window alignment is only a feature-based candidate; it is not proof that lyrics align, the pairing is useful, or the result sounds good. A beat fallback is reported only when the current confidence gates provide a beat offset. No automatic offset means evidence is insufficient, not that the songs are incompatible.",
    };
  })()
  : null;
const crossSourceComparisons = [];
for (let leftTrackIndex = 0; leftTrackIndex < tracks.length; leftTrackIndex += 1) {
  for (let rightTrackIndex = leftTrackIndex + 1; rightTrackIndex < tracks.length; rightTrackIndex += 1) {
    const left = tracks[leftTrackIndex]!;
    const right = tracks[rightTrackIndex]!;
    const leftKey = left.musicalKey ? normaliseMusicalKey(left.musicalKey) : null;
    const rightKey = right.musicalKey ? normaliseMusicalKey(right.musicalKey) : null;
    const expectedKeyShift = leftKey && rightKey ? semitoneShift(rightKey, leftKey) : null;
    for (const anchorSection of left.sections ?? []) {
      for (const donorSection of right.sections ?? []) {
        if (!anchorSection.passageFingerprint || !donorSection.passageFingerprint) continue;
        crossSourceComparisons.push({
          anchorSourceName: left.filename,
          donorSourceName: right.filename,
          ...comparePassageCompatibility({
          anchorSectionId: anchorSection.id,
          donorSectionId: donorSection.id,
          anchor: anchorSection.passageFingerprint,
          donor: donorSection.passageFingerprint,
          anchorBpm: left.bpm ?? 0,
          donorBpm: right.bpm ?? 0,
          anchorBeatConfidence: left.beatConfidence ?? 0,
          donorBeatConfidence: right.beatConfidence ?? 0,
          anchorKeyTrusted: left.keyConfidence !== null && left.keyConfidence >= 0.5 && leftKey !== null,
          donorKeyTrusted: right.keyConfidence !== null && right.keyConfidence >= 0.5 && rightKey !== null,
          expectedKeyShift,
          }),
        });
      }
    }
  }
}
const rankedCrossSourceComparisons = crossSourceComparisons
  .sort((left, right) => Number(right.eligible) - Number(left.eligible)
    || Math.min(right.dimensions.rhythm.similarity ?? -1, right.dimensions.harmony.similarity ?? -1, right.dimensions.beatPhase.similarity ?? -1)
      - Math.min(left.dimensions.rhythm.similarity ?? -1, left.dimensions.harmony.similarity ?? -1, left.dimensions.beatPhase.similarity ?? -1))
  .slice(0, 20);
await writeFile(resolve(outputPath), `${JSON.stringify({
  schemaVersion: 1,
  createdAt: new Date().toISOString(),
  tracks,
  liveStemAlignmentProbe,
  crossSourceCompatibility: {
    evaluatedPassagePairs: crossSourceComparisons.length,
    coreEligibleMatches: crossSourceComparisons.filter((comparison) => comparison.eligible).length,
    missingEvidence: [...new Set(crossSourceComparisons.flatMap((comparison) => comparison.missingEvidence))],
    bestPairs: rankedCrossSourceComparisons,
    interpretation: "A core candidate requires separate onset, chroma, beat-phase, equal measured phrase length and trusted tempo evidence. Vocal/instrument activity and downbeat gaps are retained; the report is not a subjective listening result.",
  },
}, null, 2)}\n`);
