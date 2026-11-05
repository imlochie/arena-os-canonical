import type { SourceSectionCandidate } from "@workspace/arena/lib/waveyard/types/source-sections";

const SUBDIVISIONS_PER_BEAT = 4;
const MINIMUM_PHRASE_BEATS = 8;
const MINIMUM_REPEAT_SIMILARITY = 0.92;

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

function repeatLabel(index: number): string {
  let value = index;
  let label = "";
  do {
    label = String.fromCharCode(97 + (value % 26)) + label;
    value = Math.floor(value / 26) - 1;
  } while (value >= 0);
  return `rhythm-repeat-${label}`;
}

/**
 * Marks only repeated, beat-grid-aligned rhythmic fingerprints within one
 * source. These are not verse/chorus labels and must not be used as evidence
 * that a phrase in another song is equivalent.
 */
export function labelRepeatedRhythmSections(
  candidates: readonly SourceSectionCandidate[],
  beatGridMs: number[],
  envelope: Float32Array,
  frameMs: number,
): SourceSectionCandidate[] {
  if (candidates.length < 2) return candidates.map((candidate) => ({ ...candidate }));

  const signatures = candidates.map((candidate) =>
    candidate.label === "section" && candidate.labelConfidence <= 0
      ? sectionRhythmSignature(candidate.startBeatIndex, candidate.endBeatIndex, beatGridMs, envelope, frameMs)
      : null,
  );
  const similarity = signatures.map((left) => signatures.map((right) =>
    left && right ? signatureSimilarity(left, right) : -1,
  ));
  const remaining = new Set(signatures.flatMap((signature, index) => signature ? [index] : []));
  const groups: { indices: number[]; score: number }[] = [];

  while (remaining.size >= 2) {
    let bestClique: number[] = [];
    for (const first of remaining) {
      const clique = [first];
      for (const candidate of remaining) {
        if (candidate === first) continue;
        if (clique.every((member) => similarity[member][candidate] >= MINIMUM_REPEAT_SIMILARITY)) {
          clique.push(candidate);
        }
      }
      if (clique.length > bestClique.length) bestClique = clique;
    }

    if (bestClique.length < 2) break;
    const score = Math.min(
      ...bestClique.flatMap((left, index) =>
        bestClique.slice(index + 1).map((right) => similarity[left][right]),
      ),
    );
    groups.push({ indices: bestClique, score });
    bestClique.forEach((index) => remaining.delete(index));
  }

  const labeled = candidates.map((candidate) => ({ ...candidate }));
  groups.forEach(({ indices, score }, groupIndex) => {
    for (const index of indices) {
      labeled[index] = {
        ...labeled[index],
        label: repeatLabel(groupIndex),
        labelConfidence: Math.round(Math.min(1, score) * 1000) / 1000,
      };
    }
  });
  return labeled;
}
