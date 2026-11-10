import type { SourceSectionCandidate } from "@workspace/arena/lib/waveyard/types/source-sections";
import { ANALYSIS_PCM_RATE, chromaFromPcm } from "./analysis-engine";

const SUBDIVISIONS_PER_BEAT = 4;
const MINIMUM_PHRASE_BEATS = 8;
const MINIMUM_REPEAT_SIMILARITY = 0.92;
const HARMONIC_BINS_PER_SECTION = 4;
const MINIMUM_CHROMA_VARIATION = 1e-5;
const MINIMUM_SECTION_ENERGY_CHANGE_DB = 3;

function median(values: number[]): number {
  if (!values.length) return 500;
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.floor(sorted.length / 2)];
}

function sectionRhythmSignature(
  startBeatIndex: number,
  endBeatIndex: number,
  beatGridMs: number[],
  envelope: Float32Array,
  frameMs: number,
): number[] | null {
  const beatCount = endBeatIndex - startBeatIndex;
  if (
    beatCount < MINIMUM_PHRASE_BEATS
    || beatCount % 4 !== 0
    || startBeatIndex < 0
    || endBeatIndex > beatGridMs.length
    || !Number.isFinite(frameMs)
    || frameMs <= 0
    || envelope.length === 0
  ) return null;

  const fallbackBeatMs = median(
    beatGridMs.slice(1).map((time, index) => time - beatGridMs[index]).filter((interval) => Number.isFinite(interval) && interval > 0),
  );
  const samples: number[] = [];
  for (let beatIndex = startBeatIndex; beatIndex < endBeatIndex; beatIndex += 1) {
    const beatStartMs = beatGridMs[beatIndex];
    const beatEndMs = beatGridMs[beatIndex + 1] ?? beatStartMs + fallbackBeatMs;
    if (!Number.isFinite(beatStartMs) || !Number.isFinite(beatEndMs) || beatEndMs <= beatStartMs) return null;

    for (let subdivision = 0; subdivision < SUBDIVISIONS_PER_BEAT; subdivision += 1) {
      const binStartMs = beatStartMs + ((beatEndMs - beatStartMs) * subdivision) / SUBDIVISIONS_PER_BEAT;
      const binEndMs = beatStartMs + ((beatEndMs - beatStartMs) * (subdivision + 1)) / SUBDIVISIONS_PER_BEAT;
      const firstFrame = Math.max(0, Math.floor(binStartMs / frameMs));
      const afterLastFrame = Math.min(envelope.length, Math.max(firstFrame + 1, Math.ceil(binEndMs / frameMs)));
      if (firstFrame >= envelope.length || afterLastFrame <= firstFrame) return null;

      let peak = 0;
      for (let frame = firstFrame; frame < afterLastFrame; frame += 1) {
        peak = Math.max(peak, envelope[frame] ?? 0);
      }
      samples.push(peak);
    }
  }

  const mean = samples.reduce((total, value) => total + value, 0) / samples.length;
  const centered = samples.map((value) => value - mean);
  const magnitude = Math.sqrt(centered.reduce((total, value) => total + value * value, 0));
  if (!Number.isFinite(magnitude) || magnitude < 1e-8) return null;
  return centered.map((value) => value / magnitude);
}

function signatureSimilarity(left: number[], right: number[]): number {
  if (left.length !== right.length || left.length === 0) return -1;
  return left.reduce((total, value, index) => total + value * right[index], 0);
}

function sectionHarmonicSignature(
  pcm: Float32Array,
  startBeatIndex: number,
  endBeatIndex: number,
  beatGridMs: number[],
): number[] | null {
  const beatCount = endBeatIndex - startBeatIndex;
  if (beatCount < MINIMUM_PHRASE_BEATS || beatCount % HARMONIC_BINS_PER_SECTION !== 0) return null;

  const fallbackBeatMs = median(
    beatGridMs.slice(1).map((time, index) => time - beatGridMs[index]).filter((interval) => Number.isFinite(interval) && interval > 0),
  );
  const beatTimeMs = (index: number) => {
    if (index < 0 || index > beatGridMs.length) return null;
    if (index < beatGridMs.length) return beatGridMs[index];
    const last = beatGridMs.at(-1);
    return last === undefined ? null : last + fallbackBeatMs;
  };

  const signature: number[] = [];
  for (let bin = 0; bin < HARMONIC_BINS_PER_SECTION; bin += 1) {
    const startBeat = startBeatIndex + (beatCount * bin) / HARMONIC_BINS_PER_SECTION;
    const endBeat = startBeatIndex + (beatCount * (bin + 1)) / HARMONIC_BINS_PER_SECTION;
    const startMs = beatTimeMs(startBeat);
    const endMs = beatTimeMs(endBeat);
    if (startMs === null || endMs === null || endMs <= startMs) return null;

    const startSample = Math.max(0, Math.floor((startMs * ANALYSIS_PCM_RATE) / 1000));
    const endSample = Math.min(pcm.length, Math.ceil((endMs * ANALYSIS_PCM_RATE) / 1000));
    if (endSample - startSample < 8192) return null;

    const chroma = chromaFromPcm(pcm.subarray(startSample, endSample));
    if (chroma.length !== 12 || chroma.some((value) => !Number.isFinite(value) || value < 0)) return null;
    const mean = chroma.reduce((total, value) => total + value, 0) / chroma.length;
    const centered = chroma.map((value) => value - mean);
    const magnitude = Math.sqrt(centered.reduce((total, value) => total + value * value, 0));
    if (!Number.isFinite(magnitude) || magnitude < MINIMUM_CHROMA_VARIATION) return null;
    signature.push(...centered.map((value) => value / magnitude));
  }

  const magnitude = Math.sqrt(signature.reduce((total, value) => total + value * value, 0));
  return magnitude > 0 ? signature.map((value) => value / magnitude) : null;
}

function beatBoundaryMs(index: number, beatGridMs: number[]): number | null {
  if (index < 0 || index > beatGridMs.length || beatGridMs.length === 0) return null;
  if (index < beatGridMs.length) return beatGridMs[index];
  const fallbackBeatMs = median(
    beatGridMs.slice(1).map((time, beatIndex) => time - beatGridMs[beatIndex]).filter((interval) => Number.isFinite(interval) && interval > 0),
  );
  return beatGridMs.at(-1)! + fallbackBeatMs;
}

function sectionRmsDb(
  pcm: Float32Array,
  startBeatIndex: number,
  endBeatIndex: number,
  beatGridMs: number[],
): number | null {
  const startMs = beatBoundaryMs(startBeatIndex, beatGridMs);
  const endMs = beatBoundaryMs(endBeatIndex, beatGridMs);
  if (startMs === null || endMs === null || endMs <= startMs) return null;
  const startSample = Math.max(0, Math.floor((startMs * ANALYSIS_PCM_RATE) / 1000));
  const endSample = Math.min(pcm.length, Math.ceil((endMs * ANALYSIS_PCM_RATE) / 1000));
  if (endSample - startSample < 8192) return null;

  let squaredEnergy = 0;
  for (let sample = startSample; sample < endSample; sample += 1) {
    const value = pcm[sample] ?? 0;
    squaredEnergy += value * value;
  }
  const rms = Math.sqrt(squaredEnergy / (endSample - startSample));
  return Number.isFinite(rms) && rms > 1e-8 ? 20 * Math.log10(rms) : null;
}

/** Average section loudness difference; positive means a rise into the section. */
export function sectionEnergyChangeDb(
  previous: Pick<SourceSectionCandidate, "startBeatIndex" | "endBeatIndex"> | null,
  current: Pick<SourceSectionCandidate, "startBeatIndex" | "endBeatIndex">,
  beatGridMs: number[],
  pcm: Float32Array,
): number | null {
  if (!previous) return null;
  const previousDb = sectionRmsDb(pcm, previous.startBeatIndex, previous.endBeatIndex, beatGridMs);
  const currentDb = sectionRmsDb(pcm, current.startBeatIndex, current.endBeatIndex, beatGridMs);
  if (previousDb === null || currentDb === null) return null;
  return currentDb - previousDb;
}

function repeatLabel(index: number, kind: "rhythm" | "pattern"): string {
  let value = index;
  let label = "";
  do {
    label = String.fromCharCode(97 + (value % 26)) + label;
    value = Math.floor(value / 26) - 1;
  } while (value >= 0);
  return `${kind}-repeat-${label}`;
}

function similarityMatrix(signatures: readonly (number[] | null)[]): number[][] {
  return signatures.map((left) => signatures.map((right) =>
    left && right ? signatureSimilarity(left, right) : -1,
  ));
}

function findCliqueGroups(
  similarities: number[][],
  eligibleIndices: readonly number[],
  minimumSimilarity: number,
): { indices: number[]; score: number }[] {
  const remaining = new Set(eligibleIndices);
  const groups: { indices: number[]; score: number }[] = [];

  while (remaining.size >= 2) {
    let bestClique: number[] = [];
    for (const first of remaining) {
      const clique = [first];
      for (const candidate of remaining) {
        if (candidate === first) continue;
        if (clique.every((member) => similarities[member][candidate] >= minimumSimilarity)) {
          clique.push(candidate);
        }
      }
      if (clique.length > bestClique.length) bestClique = clique;
    }

    if (bestClique.length < 2) break;
    const score = Math.min(
      ...bestClique.flatMap((left, index) =>
        bestClique.slice(index + 1).map((right) => similarities[left][right]),
      ),
    );
    groups.push({ indices: bestClique, score });
    bestClique.forEach((index) => remaining.delete(index));
  }

  return groups;
}

export type RepeatedPhraseMatch = {
  startBeatIndex: number;
  endBeatIndex: number;
  label: string;
  labelConfidence: number;
};

/**
 * Finds repeated two-bar phrases independently of novelty-boundary segmentation.
 * Windows are beat-grid aligned, one bar apart, and matches cannot overlap.
 * A pattern repeat requires both rhythm and four-bin chroma similarity; when
 * chroma is absent or disagrees, only the rhythmic evidence may be labelled.
 * These are recurrence labels, not semantic song roles or cross-song matches.
 */
export function detectRepeatedPhraseMatches(
  beatGridMs: number[],
  envelope: Float32Array,
  frameMs: number,
  pcm?: Float32Array,
): RepeatedPhraseMatch[] {
  const windows: {
    startBeatIndex: number;
    endBeatIndex: number;
    rhythm: number[];
    harmonic: number[] | null;
  }[] = [];
  for (
    let startBeatIndex = 0;
    startBeatIndex + MINIMUM_PHRASE_BEATS <= beatGridMs.length;
    startBeatIndex += 4
  ) {
    const endBeatIndex = startBeatIndex + MINIMUM_PHRASE_BEATS;
    const rhythm = sectionRhythmSignature(startBeatIndex, endBeatIndex, beatGridMs, envelope, frameMs);
    if (!rhythm) continue;
    windows.push({
      startBeatIndex,
      endBeatIndex,
      rhythm,
      harmonic: pcm
        ? sectionHarmonicSignature(pcm, startBeatIndex, endBeatIndex, beatGridMs)
        : null,
    });
  }
  if (windows.length < 2) return [];

  const rhythmSimilarities = windows.map(() => windows.map(() => -1));
  const patternSimilarities = windows.map(() => windows.map(() => -1));
  for (let left = 0; left < windows.length; left += 1) {
    for (let right = left + 1; right < windows.length; right += 1) {
      const leftWindow = windows[left]!;
      const rightWindow = windows[right]!;
      if (leftWindow.endBeatIndex > rightWindow.startBeatIndex) continue;
      const rhythmScore = signatureSimilarity(leftWindow.rhythm, rightWindow.rhythm);
      rhythmSimilarities[left]![right] = rhythmScore;
      rhythmSimilarities[right]![left] = rhythmScore;
      if (
        rhythmScore < MINIMUM_REPEAT_SIMILARITY
        || !leftWindow.harmonic
        || !rightWindow.harmonic
      ) continue;
      const harmonicScore = signatureSimilarity(leftWindow.harmonic, rightWindow.harmonic);
      if (harmonicScore < MINIMUM_REPEAT_SIMILARITY) continue;
      const score = Math.min(rhythmScore, harmonicScore);
      patternSimilarities[left]![right] = score;
      patternSimilarities[right]![left] = score;
    }
  }

  const matches: RepeatedPhraseMatch[] = [];
  const occupied: { startBeatIndex: number; endBeatIndex: number }[] = [];
  const acceptGroups = (
    groups: { indices: number[] }[],
    similarities: number[][],
    kind: "rhythm" | "pattern",
  ) => {
    let labelIndex = 0;
    for (const group of [...groups].sort((left, right) => right.indices.length - left.indices.length)) {
      const selected = group.indices.filter((index) => {
        const window = windows[index]!;
        return !occupied.some((range) =>
          window.startBeatIndex < range.endBeatIndex && window.endBeatIndex > range.startBeatIndex,
        );
      });
      if (selected.length < 2) continue;
      const score = Math.min(
        ...selected.flatMap((left, index) =>
          selected.slice(index + 1).map((right) => similarities[left]![right]!),
        ),
      );
      if (score < MINIMUM_REPEAT_SIMILARITY) continue;
      const label = repeatLabel(labelIndex, kind);
      labelIndex += 1;
      for (const index of selected) {
        const window = windows[index]!;
        matches.push({
          startBeatIndex: window.startBeatIndex,
          endBeatIndex: window.endBeatIndex,
          label,
          labelConfidence: Math.round(score * 1000) / 1000,
        });
        occupied.push({
          startBeatIndex: window.startBeatIndex,
          endBeatIndex: window.endBeatIndex,
        });
      }
    }
  };

  const allIndices = windows.map((_window, index) => index);
  const patternGroups = findCliqueGroups(patternSimilarities, allIndices, MINIMUM_REPEAT_SIMILARITY);
  acceptGroups(patternGroups, patternSimilarities, "pattern");
  const acceptedPatternStarts = new Set(matches.map((match) => match.startBeatIndex));
  const rhythmOnlyIndices = allIndices.filter((index) =>
    !acceptedPatternStarts.has(windows[index]!.startBeatIndex),
  );
  const rhythmGroups = findCliqueGroups(rhythmSimilarities, rhythmOnlyIndices, MINIMUM_REPEAT_SIMILARITY);
  acceptGroups(rhythmGroups, rhythmSimilarities, "rhythm");
  return matches.sort((left, right) => left.startBeatIndex - right.startBeatIndex);
}

/**
 * Marks repeated beat-grid-aligned structure within one source. When original
 * PCM is available, a pattern label requires both a repeated onset fingerprint
 * and a repeated four-bin harmonic profile. If that stronger evidence is not
 * available, the function may still report a rhythm-only repeat. Neither label
 * claims verse/chorus meaning or cross-song equivalence.
 */
export function labelRepeatedRhythmSections(
  candidates: readonly SourceSectionCandidate[],
  beatGridMs: number[],
  envelope: Float32Array,
  frameMs: number,
  pcm?: Float32Array,
): SourceSectionCandidate[] {
  if (candidates.length < 2) return candidates.map((candidate) => ({ ...candidate }));

  const eligibleIndices = candidates.flatMap((candidate, index) =>
    candidate.label === "section" && candidate.labelConfidence <= 0 ? [index] : [],
  );
  const rhythmSignatures = candidates.map((candidate) =>
    candidate.label === "section" && candidate.labelConfidence <= 0
      ? sectionRhythmSignature(candidate.startBeatIndex, candidate.endBeatIndex, beatGridMs, envelope, frameMs)
      : null,
  );
  const labeled = candidates.map((candidate) => ({ ...candidate }));
  const rhythmSimilarities = similarityMatrix(rhythmSignatures);
  const repeatedPatternGroups = pcm
    ? (() => {
      const harmonicSignatures = candidates.map((candidate, index) =>
        rhythmSignatures[index]
          ? sectionHarmonicSignature(pcm, candidate.startBeatIndex, candidate.endBeatIndex, beatGridMs)
          : null,
      );
      const harmonicSimilarities = similarityMatrix(harmonicSignatures);
      const patternSimilarities = rhythmSimilarities.map((rhythmRow, left) =>
        rhythmRow.map((rhythmScore, right) => {
          const harmonicScore = harmonicSimilarities[left][right];
          return rhythmScore >= MINIMUM_REPEAT_SIMILARITY && harmonicScore >= MINIMUM_REPEAT_SIMILARITY
            ? Math.min(rhythmScore, harmonicScore)
            : -1;
        }),
      );
      return findCliqueGroups(patternSimilarities, eligibleIndices, MINIMUM_REPEAT_SIMILARITY);
    })()
    : [];

  const patternIndices = new Set(repeatedPatternGroups.flatMap(({ indices }) => indices));
  repeatedPatternGroups.forEach(({ indices, score }, groupIndex) => {
    for (const index of indices) {
      labeled[index] = {
        ...labeled[index],
        label: repeatLabel(groupIndex, "pattern"),
        labelConfidence: Math.round(Math.min(1, score) * 1000) / 1000,
      };
    }
  });

  const rhythmOnlyIndices = eligibleIndices.filter((index) => !patternIndices.has(index) && rhythmSignatures[index]);
  const repeatedRhythmGroups = findCliqueGroups(rhythmSimilarities, rhythmOnlyIndices, MINIMUM_REPEAT_SIMILARITY);
  repeatedRhythmGroups.forEach(({ indices, score }, groupIndex) => {
    for (const index of indices) {
      labeled[index] = {
        ...labeled[index],
        label: repeatLabel(groupIndex, "rhythm"),
        labelConfidence: Math.round(Math.min(1, score) * 1000) / 1000,
      };
    }
  });

  return labeled;
}

/** Describes only sustained loudness changes between adjacent detected sections. */
export function labelSectionEnergyChanges(
  candidates: readonly SourceSectionCandidate[],
  beatGridMs: number[],
  pcm: Float32Array,
): SourceSectionCandidate[] {
  return candidates.map((candidate, index) => {
    if (index === 0 || candidate.label !== "section" || candidate.labelConfidence > 0) return { ...candidate };
    const changeDb = sectionEnergyChangeDb(candidates[index - 1], candidate, beatGridMs, pcm);
    if (changeDb === null || Math.abs(changeDb) < MINIMUM_SECTION_ENERGY_CHANGE_DB) return { ...candidate };
    return {
      ...candidate,
      label: changeDb > 0 ? "energy-rise" : "energy-drop",
      // This is normalized signal-change strength, not a probability of a
      // semantic role. The UI names it accordingly.
      labelConfidence: Math.round(Math.min(1, Math.abs(changeDb) / 6) * 1000) / 1000,
    };
  });
}
