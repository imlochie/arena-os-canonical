/**
 * Composition-first section re-derivation.
 *
 * A stem swap changes the audio the listener hears. Tempo, beat grid and
 * downbeats were already re-measured from the resulting composition
 * (`bedProfileFromComposition` in the mashup route), but **sections were not**.
 *
 * That is not cosmetic. `bedEntryMs` in the planner places the vocal at "the
 * bed's first body (non-intro, non-outro) section", and the arrangement's
 * phrase and bar placement read section boundaries. Drum and bass stems are
 * exactly what those boundaries are detected from
 * (`desktopSectionCandidates` builds them from the beat grid plus the onset
 * envelope and sustained component-level activity changes). So when a swap replaces drums,
 * inheriting the original bed's sections means the arrangement keeps a shape
 * derived from percussion that is no longer in the mix — the replacement is
 * audible while the arrangement still belongs to the replaced part. That is the
 * specific failure composition-first planning exists to prevent.
 *
 * This module re-derives sections from the composed PCM with the same
 * conservative bar-aligned engine the worker uses. When component PCM is
 * available, activity changes in the retained and replacement stems enter that
 * same section map. It falls back rather than inventing structure:
 *
 *  - If the composed bed yields no usable beat grid, no sections are produced.
 *    The caller must invalidate the old ones and use an explicitly unverified
 *    placement fallback, not structure derived from removed percussion.
 *  - If re-derivation throws, the same evidence invalidation applies.
 *
 * Deliberately no semantics are invented: no verse/chorus claims. Labels come
 * from the engine's own conservative vocabulary.
 */

import { analysePcm, onsetEnvelope } from "../worker-local/analysis-engine";
import {
  buildStemActivityLevelProfile,
  desktopSectionCandidates,
  detectStemActivityBoundaryChanges,
} from "../worker-local/section-rhythm";
import type { SourceSection } from "../types/source-sections";
import { downsampleToAnalysisPcm, type MashupSection } from "./mashup";

/** Identity for sections derived in-process from a composed bed, not persisted. */
export const COMPOSED_SECTION_ENGINE = "waveyard-composed-bed-sections";
export const COMPOSED_SECTION_ENGINE_VERSION = "1";

export type ComposedSectionResult =
  | { ok: true; sections: MashupSection[]; beatGridMs: number[]; note: string }
  | { ok: false; reason: string };


function toMashupSections(sections: readonly SourceSection[]): MashupSection[] {
  return sections.map((section) => ({
    id: section.id,
    label: section.label,
    startMs: section.startMs,
    endMs: section.endMs,
    startBeatIndex: section.startBeatIndex,
    endBeatIndex: section.endBeatIndex,
    passageFingerprint: section.passageFingerprint ?? null,
  }));
}

/**
 * Re-derive sections for a composed bed from its actual PCM.
 *
 * `stereo44k` must be the composed (post-swap) mix at the render sample rate —
 * the same signal the listener hears and the same one the tempo/beat grid were
 * re-measured from. Optional component stems must use the same source clock;
 * their activity indicates structural changes, not semantic form.
 */
export function deriveSectionsForComposition(
  stereo44k: Float32Array,
  options: {
    sampleRate?: number;
    /** Separate components on the same source clock as the summed composition. */
    stemPcms?: readonly { stemType: string; pcm: Float32Array }[];
  } = {},
): ComposedSectionResult {
  const sampleRate = options.sampleRate ?? 44_100;
  if (stereo44k.length < 2) return { ok: false, reason: "The composed bed contains no audio to analyse." };

  let analysis: ReturnType<typeof analysePcm>;
  try {
    // `analysePcm` runs on the ANALYSIS rate (22.05 kHz), not the render rate.
    // Feeding it a plain 44.1 kHz downmix made every onset frame half as long
    // as it really is, so the beat grid came out at double density and the
    // derived sections ran to twice the length of the actual audio (62.6 s of
    // sections inside a 32 s bed). Boundaries have to be measured on the same
    // signal the listener hears; this is the conversion that makes that true.
    const mono = downsampleToAnalysisPcm(stereo44k);
    analysis = analysePcm(mono);
  } catch (error) {
    return { ok: false, reason: `The composed bed could not be analysed for sections: ${String(error)}` };
  }

  const beatGridMs = analysis.beatGridMs;
  if (!Array.isArray(beatGridMs) || beatGridMs.length < 8) {
    return {
      ok: false,
      reason: "The composed bed produced no usable beat grid, so its section boundaries could not be re-derived.",
    };
  }

  let candidates: ReturnType<typeof desktopSectionCandidates>;
  let envelope: Float32Array = new Float32Array(0);
  let frameMs = 0;
  try {
    // The envelope must be measured on the same analysis-rate signal the beat
    // grid was derived from, or intro/outro density is judged on a different
    // timeline than the boundaries.
    const mono = downsampleToAnalysisPcm(stereo44k);
    const measured = onsetEnvelope(mono);
    envelope = measured.envelope;
    frameMs = measured.frameMs;
    const stemActivityProfiles = (options.stemPcms ?? []).flatMap((stem) => {
      if (!stem || typeof stem.stemType !== "string" || !stem.stemType.trim()
        || !(stem.pcm instanceof Float32Array) || stem.pcm.length < 2) return [];
      const stemMono = downsampleToAnalysisPcm(stem.pcm);
      const profile = buildStemActivityLevelProfile(stemMono, beatGridMs, stem.stemType);
      return profile ? [profile] : [];
    });
    const stemActivityBoundaryChanges = detectStemActivityBoundaryChanges(stemActivityProfiles);
    candidates = desktopSectionCandidates(
      beatGridMs,
      envelope,
      frameMs,
      mono,
      [],
      stemActivityBoundaryChanges,
    );
  } catch (error) {
    return { ok: false, reason: `Section boundaries could not be derived for the composed bed: ${String(error)}` };
  }

  if (candidates === null || candidates.length === 0) {
    return {
      ok: false,
      reason: "The composed bed yielded no section boundaries, so the arrangement would have no phrase structure to place against.",
    };
  }

  const durationMs = Math.round((stereo44k.length / 2 / sampleRate) * 1000);
  const sections = toMashupSections(
    normalize(candidates, beatGridMs, durationMs),
  );
  if (sections.length === 0) {
    return { ok: false, reason: "Composed-bed section candidates produced no usable ranges." };
  }
  return {
    ok: true,
    sections,
    beatGridMs,
    note: `Section boundaries, tempo and beat grid were re-derived from the resulting composition (${sections.length} section${sections.length === 1 ? "" : "s"}), not inherited from the original bed.`,
  };
}

/** Local normalisation: candidates -> monotonic SourceSection-shaped records. */
function normalize(
  candidates: NonNullable<ReturnType<typeof desktopSectionCandidates>>,
  beatGridMs: readonly number[],
  durationMs: number,
): SourceSection[] {
  const candidatesSorted = [...candidates].sort(
    (left, right) => left.startBeatIndex - right.startBeatIndex || left.endBeatIndex - right.endBeatIndex,
  );
  const out: SourceSection[] = [];
  const seen = new Set<string>();
  for (const candidate of candidatesSorted) {
    if (!Number.isInteger(candidate.startBeatIndex) || !Number.isInteger(candidate.endBeatIndex)) continue;
    if (candidate.startBeatIndex < 0 || candidate.endBeatIndex <= candidate.startBeatIndex) continue;
    if (candidate.startBeatIndex >= beatGridMs.length || candidate.endBeatIndex > beatGridMs.length) continue;
    const startMs = boundaryMs(beatGridMs, candidate.startBeatIndex, durationMs);
    const endMs = boundaryMs(beatGridMs, candidate.endBeatIndex, durationMs);
    if (startMs === null || endMs === null || endMs <= startMs) continue;
    const key = `${candidate.startBeatIndex}:${candidate.endBeatIndex}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const previous = out.at(-1);
    if (previous && candidate.startBeatIndex < previous.endBeatIndex) continue;
    out.push({
      id: `composed-section-${out.length}`,
      sectionIndex: out.length,
      startMs,
      endMs,
      startBeatIndex: candidate.startBeatIndex,
      endBeatIndex: candidate.endBeatIndex,
      startBar: Math.floor(candidate.startBeatIndex / 4),
      endBar: Math.floor(candidate.endBeatIndex / 4),
      label: candidate.label,
      labelConfidence: candidate.labelConfidence,
      structuralConfidence: candidate.structuralConfidence,
      analysisEngine: COMPOSED_SECTION_ENGINE,
      analysisEngineVersion: COMPOSED_SECTION_ENGINE_VERSION,
      sourceChecksumSha256: "composed-bed",
      passageFingerprint: null,
    });
  }
  return out;
}

/** Exclusive end past the last beat is extrapolated by the median interval. */
function boundaryMs(beatGridMs: readonly number[], beatIndex: number, durationMs: number): number | null {
  if (beatIndex < beatGridMs.length) {
    const value = beatGridMs[beatIndex];
    return typeof value === "number" && Number.isFinite(value) ? Math.round(value) : null;
  }
  if (beatIndex !== beatGridMs.length || beatGridMs.length < 2) return null;
  const intervals: number[] = [];
  for (let index = 1; index < beatGridMs.length; index += 1) {
    const gap = beatGridMs[index]! - beatGridMs[index - 1]!;
    if (gap > 0) intervals.push(gap);
  }
  if (intervals.length === 0) return null;
  intervals.sort((left, right) => left - right);
  const median = intervals[Math.floor(intervals.length / 2)]!;
  const end = Math.round((beatGridMs.at(-1) ?? 0) + median);
  return durationMs > 0 ? Math.min(end, durationMs) : end;
}

/** Average channels to mono; tolerant of interleaved stereo or mono input. */
function downmix(stereo: Float32Array): Float32Array {
  const frames = Math.floor(stereo.length / 2);
  if (frames === 0) return new Float32Array(0);
  const mono = new Float32Array(frames);
  for (let frame = 0; frame < frames; frame += 1) {
    const left = stereo[frame * 2] ?? 0;
    const right = stereo[frame * 2 + 1] ?? 0;
    mono[frame] = (left + right) / 2;
  }
  return mono;
}
