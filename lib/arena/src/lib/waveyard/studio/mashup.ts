/**
 * The mashup brain — song × song (vision: "Waveyard's main goal will always
 * be making mashups and extending songs").
 *
 * planMashup composes the app's EXISTING analysis primitives into a full,
 * explained decision: which tempo wins, how the vocal is stretched and
 * pitched, where it enters, and why every choice was made. renderMashup
 * turns the plan into real PCM using the elastic primitives (WSOLA stretch,
 * sinc pitch shift) — the same math the session layer uses.
 *
 * Authority rules (the user's, verbatim: "if my work is better to my ears
 * we keep that"): a plan is a PROPOSAL. Nothing here mutates a source, and
 * the render is stateless — the user's own arrangement is never touched.
 */

import { pitchShift, timeStretch } from "../elastic";
import type { StereoBuffer } from "../mixer/dsp";
import { keyCompatibility } from "../library/session-logic";
import { semitoneShift } from "../types/musical-key";
import { analysePcm, type AnalysisResult } from "../worker-local/analysis-engine";
import { trustedAnalysisBpm, trustedAnalysisKey } from "../types/analysis-confidence";
import type { AutomationPoint } from "../types/arrangement-automation";

export const MASHUP_PLANNER_ENGINE = "waveyard-mashup-planner-v1";
export const MASHUP_RENDER_ENGINE = "waveyard-mashup-render-v1";

export type MashupSection = { label: string; startMs: number; endMs: number };

export type MashupSourceProfile = {
  role: "vocals" | "instrumental";
  bpm: number | null;
  bpmConfidence?: number | null;
  musicalKey: string | null;
  keyConfidence?: number | null;
  beatGridMs?: number[] | null;
  beatConfidence?: number | null;
  durationMs: number;
  sections: MashupSection[];
  stems?: Array<{ id: string; stemType: string }>;
};

export type MashupSegment = {
  /** Placement on the mashup (bed) timeline. */
  mashupStartMs: number;
  mashupEndMs: number;
  /** Span of the source audio this segment carries (before stretch). */
  vocalsFromMs: number;
  vocalsToMs: number;
  /** Trapezoid fade in/out on the segment (ms). */
  crossfadeMs: number;
  rationale: string;
  /** Stem role for multi-stem arrangement (defaults to "vocals"). */
  stemType?: string;
  sourceRole?: "vocals" | "instrumental";
};

export type MashupPlan = {
  engine: typeof MASHUP_PLANNER_ENGINE;
  /** The bed's tempo — the instrumental always wins the tempo war. */
  masterBpm: number;
  /** timeStretch ratio for the vocal (output length / input length). */
  vocalsStretchRatio: number;
  /** Semitones to pitch the vocal into the bed's key. */
  vocalsPitchSemitones: number;
  keyRelationship: "same" | "fifth" | "relative" | "other" | "unknown";
  segments: MashupSegment[];
  durationMs: number;
  rationale: string[];
  warnings: string[];
};

export type MashupPlanResult =
  | { ok: true; plan: MashupPlan }
  | { ok: false; reason: string };

const LOCK_TOLERANCE = 0.03;
const CROSSFADE_MS = 250;
/** Bed attenuation while vocals are active (the classic mashup pocket). */
export const MASHUP_DUCK_DEPTH = 0.28;
export const MASHUP_DONOR_STEM_BASE_VOLUME = 0.6;

function isIntro(label: string): boolean {
  return /intro/i.test(label);
}
function isOutro(label: string): boolean {
  return /outro/i.test(label);
}

/**
 * Stretch ratio that syncs a vocal at vocalBpm to a bed at bedBpm.
 * When the raw ratio is an essentially-exact double/half relationship
 * (±1%), the vocal stays at natural speed: a 140 BPM vocal over a 70 BPM
 * bed is already grid-consistent in double-time, and a 2× WSOLA stretch
 * would only degrade it. Anything else stretches to match the bed's tempo,
 * clamped to 0.5–2.
 */
export function warpRatioForTempos(vocalBpm: number, bedBpm: number): number {
  if (vocalBpm <= 0 || bedBpm <= 0) return 1;
  const raw = vocalBpm / bedBpm;
  if (Math.abs(raw - 1) <= 0.01) return 1;
  if (Math.abs(raw - 0.5) <= 0.01 || Math.abs(raw - 2) <= 0.01) return 1;
  return Math.min(2, Math.max(0.5, raw));
}

/**
 * Estimates a musically sensible tempo (BPM) from section timestamps or duration
 * when formal tempo analysis is missing. Sections give bar/phrase cadence; otherwise
 * common pop/electronic tempo ranges (100–128 BPM) guide duration-to-beat fitting.
 */
/**
 * Downsamples interleaved stereo 44.1 kHz PCM to mono 22.05 kHz for analysis.
 */
export function downsampleToAnalysisPcm(stereo44k: Float32Array): Float32Array {
  const frames44k = Math.floor(stereo44k.length / 2);
  const frames22k = Math.floor(frames44k / 2);
  const out = new Float32Array(frames22k);
  for (let i = 0; i < frames22k; i++) {
    const srcIndex = i * 4;
    out[i] = (stereo44k[srcIndex] + stereo44k[srcIndex + 1]) * 0.5;
  }
  return out;
}

/**
 * Runs native DSP musical analysis on stereo audio PCM when metadata is absent.
 */
export function analyseStereoPcm(stereo44k: Float32Array): AnalysisResult {
  const mono = downsampleToAnalysisPcm(stereo44k);
  return analysePcm(mono);
}

export function estimateFallbackTempo(profile: MashupSourceProfile): { bpm: number; confidence: number; source: "sections" | "default" } {
  if (profile.sections && profile.sections.length >= 2) {
    const intervals: number[] = [];
    for (let i = 0; i < profile.sections.length - 1; i++) {
      const diff = profile.sections[i + 1].startMs - profile.sections[i].startMs;
      if (diff > 2000 && diff < 60000) intervals.push(diff);
    }
    if (intervals.length > 0) {
      intervals.sort((a, b) => a - b);
      const medianMs = intervals[Math.floor(intervals.length / 2)];
      // Assume median section is roughly 8 or 16 bars (32 or 64 beats in 4/4)
      for (const beats of [32, 16, 64, 8]) {
        const candidateBpm = (beats * 60_000) / medianMs;
        if (candidateBpm >= 75 && candidateBpm <= 160) {
          // Section timing is phrase cadence, never verified beat timing. Set confidence to 0.0.
          return { bpm: Math.round(candidateBpm * 10) / 10, confidence: 0.0, source: "sections" };
        }
      }
    }
  }

  // Never invent a duration-derived BPM guess presented as musical synchronization.
  return { bpm: 120, confidence: 0.0, source: "default" };
}

/** The vocal's pitch move into the bed's key. Relative major/minor shares
 *  the same scale — the correct move is NO shift, not a tonic shift. */
export function pitchMoveForKeys(
  vocalKey: string | null,
  bedKey: string | null,
): { semitones: number; relationship: "same" | "fifth" | "relative" | "other" | "unknown" } {
  const compatibility = keyCompatibility(vocalKey, bedKey);
  if (!compatibility.compatible || compatibility.shiftSemitones === null) {
    if (compatibility.relationship === "unknown") return { semitones: 0, relationship: "unknown" };
    return { semitones: compatibility.shiftSemitones ?? 0, relationship: "other" };
  }
  if (compatibility.relationship === "relative") {
    return { semitones: 0, relationship: "relative" };
  }
  const shift = semitoneShift(vocalKey, bedKey) ?? 0;
  return { semitones: shift, relationship: compatibility.relationship };
}

/** First non-intro bed section = where vocals traditionally enter. */
function bedEntryMs(bed: MashupSourceProfile, barMs: number): { at: number; why: string } {
  const bodySections = bed.sections.filter((section) => !isIntro(section.label) && !isOutro(section.label));
  if (bodySections.length > 0) {
    const first = bodySections[0];
    return { at: Math.max(0, first.startMs), why: `vocals enter at the bed's first body section (“${first.label}” at ${(first.startMs / 1000).toFixed(1)}s)` };
  }
  if (bed.sections.length > 0) {
    return { at: 0, why: "the bed has no labeled body sections — vocals enter at the top" };
  }
  return { at: Math.round(barMs), why: "no section analysis for the bed — vocals enter after one bar" };
}

/** The vocal span that carries content (skipping its intro/outro padding). */
function vocalBodySpan(vocals: MashupSourceProfile): { fromMs: number; toMs: number; why: string } {
  const active = vocals.sections.filter((section) => !isIntro(section.label) && !isOutro(section.label));
  if (active.length > 0) {
    const from = active[0].startMs;
    const to = active[active.length - 1].endMs;
    return { fromMs: from, toMs: Math.min(vocals.durationMs, to), why: `vocal body spans ${active.length} section${active.length === 1 ? "" : "s"} (${(from / 1000).toFixed(1)}s–${(to / 1000).toFixed(1)}s)` };
  }
  return { fromMs: 0, toMs: vocals.durationMs, why: "no section analysis for the vocal — its full length is used" };
}

export function planMashup(vocals: MashupSourceProfile, bed: MashupSourceProfile): MashupPlanResult {
  const rationale: string[] = [];
  const warnings: string[] = [];

  let masterBpm: number;
  let estimatedBed = false;
  let estimatedVocal = false;

  const trustedBedBpm = trustedAnalysisBpm(bed.bpm, bed.bpmConfidence);
  const trustedVocalBpm = trustedAnalysisBpm(vocals.bpm, vocals.bpmConfidence);

  if (trustedBedBpm !== null) {
    masterBpm = trustedBedBpm;
    rationale.push(`master tempo = the instrumental's verified ${masterBpm} BPM.`);
  } else if (bed.bpm !== null && bed.bpm > 0) {
    masterBpm = bed.bpm;
    warnings.push(`Instrumental tempo (${masterBpm} BPM) has low confidence (${bed.bpmConfidence ?? 0}); beat synchronization may drift.`);
    rationale.push(`master tempo = the instrumental's ${masterBpm} BPM (low confidence).`);
  } else if (trustedVocalBpm !== null || (vocals.bpm !== null && vocals.bpm > 0)) {
    masterBpm = trustedVocalBpm ?? vocals.bpm!;
    rationale.push(`master tempo = the vocal's ${masterBpm} BPM (adopted because instrumental tempo is unanalyzed).`);
    warnings.push(`The instrumental has no complete tempo analysis — adopting vocal tempo (${masterBpm} BPM) as master.`);
  } else {
    const fallbackBed = estimateFallbackTempo(bed);
    masterBpm = fallbackBed.bpm;
    estimatedBed = true;
    warnings.push(`Neither track has complete tempo analysis — using unaligned reference (${masterBpm} BPM). Musical beat synchronization cannot be guaranteed.`);
    rationale.push(`master tempo = reference tempo (${masterBpm} BPM, untrusted).`);
  }

  let effectiveVocalBpm: number;
  if (trustedVocalBpm !== null) {
    effectiveVocalBpm = trustedVocalBpm;
  } else if (vocals.bpm !== null && vocals.bpm > 0) {
    effectiveVocalBpm = vocals.bpm;
    warnings.push(`Vocal tempo (${effectiveVocalBpm} BPM) has low confidence (${vocals.bpmConfidence ?? 0}).`);
  } else {
    const fallbackVocal = estimateFallbackTempo(vocals);
    effectiveVocalBpm = fallbackVocal.bpm;
    estimatedVocal = true;
    warnings.push(`Vocal tempo analysis is incomplete — estimated at ${effectiveVocalBpm} BPM (${fallbackVocal.source}).`);
  }

  // Only calculate automatic tempo stretching when BOTH sources have trustworthy BPM evidence.
  // Otherwise preserve natural speed (1.0), mark alignment unverified, and explain honestly.
  let stretchRatio = 1.0;
  if (trustedBedBpm !== null && trustedVocalBpm !== null) {
    stretchRatio = warpRatioForTempos(effectiveVocalBpm, masterBpm);
    if (Math.abs(stretchRatio - 1) < 1e-9) {
      rationale.push(`vocals stay at natural speed (${effectiveVocalBpm} BPM syncs to ${masterBpm} BPM as-is or via a double/half lock).`);
    } else {
      rationale.push(`vocals are time-stretched ×${stretchRatio.toFixed(3)} (${effectiveVocalBpm} → ${masterBpm} BPM, pitch preserved by WSOLA).`);
    }
    if (vocals.bpm !== null && vocals.bpm !== masterBpm && Math.abs(vocals.bpm - masterBpm) <= 6) {
      rationale.push("tempos are near-equal — a light stretch, not a resample.");
    }
  } else {
    stretchRatio = 1.0;
    warnings.push("Automatic tempo stretching withheld (ratio 1.0): both tracks must have verified tempo confidence (>=0.5) to enable musical beat synchronization.");
    rationale.push("vocals remain at natural speed (1.000×): tempo evidence is unverified on at least one track.");
  }

  // Enforce trustedAnalysisKey strictly: missing confidence means untrusted evidence,
  // including legacy records. Only verified keys from both sources may trigger automatic pitch shifting.
  const trustedVocalKey = trustedAnalysisKey(vocals.musicalKey, vocals.keyConfidence);
  const trustedBedKey = trustedAnalysisKey(bed.musicalKey, bed.keyConfidence);

  const pitchMove = (trustedVocalKey !== null && trustedBedKey !== null)
    ? pitchMoveForKeys(trustedVocalKey, trustedBedKey)
    : { semitones: 0, relationship: "unknown" as const };

  if (pitchMove.relationship === "unknown") {
    if (!vocals.musicalKey || !bed.musicalKey) {
      warnings.push("Key analysis is missing for at least one track — no pitch move was made (0 semitones).");
    } else {
      warnings.push("Key analysis confidence is below the trusted threshold (0.5) — automatic pitch move withheld (0 semitones).");
    }
  } else if (pitchMove.semitones === 0 && pitchMove.relationship === "relative") {
    rationale.push(`keys are relative (${trustedVocalKey} / ${trustedBedKey}) — same scale, no pitch shift needed.`);
  } else if (pitchMove.semitones === 0) {
    rationale.push(`same key (${trustedBedKey}) — no pitch shift needed.`);
  } else {
    rationale.push(`vocals shift ${pitchMove.semitones > 0 ? "+" : ""}${pitchMove.semitones} semitones (${trustedVocalKey} → ${trustedBedKey}, ${pitchMove.relationship}).`);
  }
  if (Math.abs(pitchMove.semitones) > 4) {
    warnings.push(`A ${pitchMove.semitones}-semitone shift is large — expect audible formant change. Trust your ears; you can veto the shift.`);
  }

  const beatMs = 60_000 / masterBpm;
  const barMs = beatMs * 4;
  const entry = bedEntryMs(bed, barMs);
  rationale.push(entry.why);

  const body = vocalBodySpan(vocals);
  rationale.push(body.why);

  const vocalSpanMs = Math.max(0, body.toMs - body.fromMs);
  const stretchedMs = vocalSpanMs * stretchRatio;
  const bedRoomMs = Math.max(0, bed.durationMs - entry.at);

  const segments: MashupSegment[] = [];

  // Intelligently arrange full-length vocal segments across the bed timeline.
  // When vocals are significantly shorter than the bed (e.g. bed has extra sections / 2nd verse / chorus),
  // place recurring vocal sections (or loop phrases aligned to bar boundaries) so both tracks contribute
  // throughout the entire song.
  if (stretchedMs > 0 && bedRoomMs > 0) {
    if (stretchedMs >= bedRoomMs * 0.75) {
      // Standard full or near-full overlay
      const segEndMs = Math.min(bed.durationMs, entry.at + stretchedMs);
      segments.push({
        mashupStartMs: entry.at,
        mashupEndMs: segEndMs,
        vocalsFromMs: body.fromMs,
        vocalsToMs: body.toMs,
        crossfadeMs: CROSSFADE_MS,
        rationale: `primary vocal body runs ${(stretchedMs / 1000).toFixed(1)}s from ${(entry.at / 1000).toFixed(1)}s`,
        stemType: "vocals",
        sourceRole: "vocals",
      });
      if (stretchedMs > bedRoomMs) {
        warnings.push(`The stretched vocal (${(stretchedMs / 1000).toFixed(1)}s) is longer than the bed has room (${(bedRoomMs / 1000).toFixed(1)}s) — it fades out at the bed's end.`);
      }
    } else {
      // Bed is significantly longer than vocals. We build a structured multi-segment arrangement:
      // Segment 1: initial vocal verse/body
      // Segment 2: chorus/body recap later in the bed after an instrumental breakdown/solo pocket
      const firstSegmentEnd = entry.at + stretchedMs;
      segments.push({
        mashupStartMs: entry.at,
        mashupEndMs: firstSegmentEnd,
        vocalsFromMs: body.fromMs,
        vocalsToMs: body.toMs,
        crossfadeMs: CROSSFADE_MS,
        rationale: `first vocal passage runs ${(stretchedMs / 1000).toFixed(1)}s over the bed`,
        stemType: "vocals",
        sourceRole: "vocals",
      });

      // Calculate bar-aligned breakdown gap
      const breakdownBars = Math.max(2, Math.floor((barMs > 0 ? (bedRoomMs - stretchedMs) / 3 / barMs : 4)));
      const breakdownMs = barMs > 0 ? breakdownBars * barMs : 8_000;
      const secondStart = Math.min(bed.durationMs - Math.min(stretchedMs, 30_000), firstSegmentEnd + breakdownMs);
      const remainingMs = bed.durationMs - secondStart;

      if (remainingMs > 4_000) {
        const vocalPortionMs = Math.min(vocalSpanMs, (remainingMs / stretchRatio));
        segments.push({
          mashupStartMs: secondStart,
          mashupEndMs: Math.min(bed.durationMs, secondStart + vocalPortionMs * stretchRatio),
          vocalsFromMs: body.fromMs,
          vocalsToMs: body.fromMs + vocalPortionMs,
          crossfadeMs: CROSSFADE_MS,
          rationale: `re-entry after instrumental breakdown (${(breakdownMs / 1000).toFixed(1)}s pocket) extending vocals to song climax`,
          stemType: "vocals",
          sourceRole: "vocals",
        });
        rationale.push(`arranged secondary vocal re-entry at ${(secondStart / 1000).toFixed(1)}s following an instrumental section`);
      }
    }
  } else {
    // Fallback: minimal single segment
    segments.push({
      mashupStartMs: entry.at,
      mashupEndMs: Math.min(bed.durationMs, entry.at + stretchedMs),
      vocalsFromMs: body.fromMs,
      vocalsToMs: body.toMs,
      crossfadeMs: CROSSFADE_MS,
      rationale: `vocals run ${(stretchedMs / 1000).toFixed(1)}s over the bed`,
      stemType: "vocals",
      sourceRole: "vocals",
    });
  }

  return {
    ok: true,
    plan: {
      engine: MASHUP_PLANNER_ENGINE,
      masterBpm,
      vocalsStretchRatio: stretchRatio,
      vocalsPitchSemitones: pitchMove.semitones,
      keyRelationship: pitchMove.relationship,
      segments,
      durationMs: bed.durationMs,
      rationale,
      warnings,
    },
  };
}

// ---------------------------------------------------------------------------
// Render
// ---------------------------------------------------------------------------

export type MashupPcmInput = {
  /** Interleaved stereo vocal stem PCM. */
  vocals: StereoBuffer;
  /** Interleaved stereo bed (instrumental) PCM. */
  bed: StereoBuffer;
  /** Optional discrete stems from both songs for stem-level mixing. */
  stems?: Map<string, StereoBuffer>;
  sampleRate: number;
};

function trapezoidGain(atMs: number, startMs: number, endMs: number, crossfadeMs: number): number {
  if (atMs < startMs || atMs > endMs) return 0;
  const into = atMs - startMs;
  const remaining = endMs - atMs;
  if (into < crossfadeMs) return into / crossfadeMs;
  if (remaining < crossfadeMs) return remaining / crossfadeMs;
  return 1;
}

/**
 * Build the saved Studio volume lane that mirrors the renderer's donor-stem
 * ducking. The max of overlapping vocal trapezoids is piecewise linear; add
 * both their corners and any pairwise crossings so linear automation retains
 * that same envelope after a remix is reopened.
 */
export function buildMashupDonorDuckingAutomation(
  plan: MashupPlan,
  baseVolume = MASHUP_DONOR_STEM_BASE_VOLUME,
): AutomationPoint[] {
  if (!Number.isFinite(plan.durationMs) || plan.durationMs <= 0
    || !Number.isFinite(baseVolume) || baseVolume < 0 || baseVolume > 2) return [];

  const segments = plan.segments.filter((segment) =>
    Number.isFinite(segment.mashupStartMs)
    && Number.isFinite(segment.mashupEndMs)
    && Number.isFinite(segment.crossfadeMs)
    && segment.mashupEndMs > segment.mashupStartMs,
  );
  if (segments.length === 0) return [];

  const clampTime = (time: number) => Math.max(0, Math.min(plan.durationMs, time));
  const boundaries = new Set<number>([0, plan.durationMs]);
  for (const segment of segments) {
    const start = clampTime(segment.mashupStartMs);
    const end = clampTime(segment.mashupEndMs);
    const crossfade = Math.max(0, segment.crossfadeMs);
    boundaries.add(start);
    boundaries.add(end);
    boundaries.add(clampTime(segment.mashupStartMs + crossfade));
    boundaries.add(clampTime(segment.mashupEndMs - crossfade));
  }

  const envelopeAt = (time: number) => segments.reduce(
    (maximum, segment) => Math.max(
      maximum,
      trapezoidGain(time, segment.mashupStartMs, segment.mashupEndMs, Math.max(0, segment.crossfadeMs)),
    ),
    0,
  );
  const orderedBoundaries = [...boundaries].sort((left, right) => left - right);
  const breakpoints = new Set(orderedBoundaries);
  for (let index = 1; index < orderedBoundaries.length; index += 1) {
    const left = orderedBoundaries[index - 1]!;
    const right = orderedBoundaries[index]!;
    if (right <= left) continue;
    const leftValues = segments.map((segment) =>
      trapezoidGain(left, segment.mashupStartMs, segment.mashupEndMs, Math.max(0, segment.crossfadeMs)),
    );
    const rightValues = segments.map((segment) =>
      trapezoidGain(right, segment.mashupStartMs, segment.mashupEndMs, Math.max(0, segment.crossfadeMs)),
    );
    for (let first = 0; first < segments.length; first += 1) {
      for (let second = first + 1; second < segments.length; second += 1) {
        const differenceAtLeft = leftValues[first]! - leftValues[second]!;
        const differenceAtRight = rightValues[first]! - rightValues[second]!;
        if (differenceAtLeft * differenceAtRight >= 0) continue;
        const fraction = differenceAtLeft / (differenceAtLeft - differenceAtRight);
        if (fraction > 0 && fraction < 1) breakpoints.add(left + (right - left) * fraction);
      }
    }
  }

  // The persistence schema stores integer milliseconds. Merge points that
  // round to the same frame, evaluating the original envelope at that time.
  const pointsByTime = new Map<number, AutomationPoint>();
  for (const time of [...breakpoints].sort((left, right) => left - right)) {
    const timelineMs = Math.round(clampTime(time));
    const duck = envelopeAt(timelineMs);
    pointsByTime.set(timelineMs, {
      timelineMs,
      value: baseVolume * (1 - MASHUP_DUCK_DEPTH * duck),
    });
  }
  return [...pointsByTime.values()].sort((left, right) => left.timelineMs - right.timelineMs);
}

/** Mix the plan: bed (ducked under vocals) + stretched/pitched vocal
 *  segments with trapezoid fades. Deterministic from the plan. */
export function renderMashup(plan: MashupPlan, input: MashupPcmInput): StereoBuffer {
  const { sampleRate } = input;
  const totalFrames = Math.max(1, Math.round((plan.durationMs / 1000) * sampleRate));
  const out = new Float32Array(totalFrames * 2);

  // Prepared vocal segments (stretched once, then pitched once each).
  const prepared = plan.segments.map((segment) => {
    const fromFrame = Math.max(0, Math.round((segment.vocalsFromMs / 1000) * sampleRate) * 2);
    const toFrame = Math.min(input.vocals.length, Math.max(fromFrame, Math.round((segment.vocalsToMs / 1000) * sampleRate) * 2));
    const span = input.vocals.slice(fromFrame, toFrame);
    if (span.length === 0) {
      return { segment, pcm: new Float32Array(0) };
    }
    const stretched = timeStretch(span, plan.vocalsStretchRatio, sampleRate);
    return { segment, pcm: pitchShift(stretched, plan.vocalsPitchSemitones, sampleRate) };
  });

  // Pre-process complementary donor stems ONCE before the rendering loop.
  // Instrumental stems (drums, bass, guitar, keys, other) must NEVER inherit vocal-specific
  // pitch transposition or vocal transformations. Preserve their native pitch.
  // Time-stretching is applied only when beat synchronization is mutually trusted.
  const preparedStems: Array<{ name: string; pcm: StereoBuffer }> = [];
  if (input.stems) {
    for (const [stemName, rawStemBuffer] of input.stems) {
      if (stemName !== "vocals") {
        // Instrumental donor stems preserve native pitch (0 semitones shift).
        // Only time-stretch to match master tempo if tempo stretch ratio differs from 1.0.
        const pcm = (stemName.startsWith("donor_") && Math.abs(plan.vocalsStretchRatio - 1.0) > 1e-6)
          ? timeStretch(rawStemBuffer, plan.vocalsStretchRatio, sampleRate)
          : rawStemBuffer;
        preparedStems.push({ name: stemName, pcm });
      }
    }
  }

  const bedFrames = Math.min(totalFrames, Math.floor(input.bed.length / 2));
  for (let frame = 0; frame < totalFrames; frame += 1) {
    const atMs = (frame / sampleRate) * 1000;

    // Bed gain: 1.0, ducked by a smoothed trapezoid under active vocals.
    let duck = 0;
    for (const { segment } of prepared) {
      duck = Math.max(duck, trapezoidGain(atMs, segment.mashupStartMs, segment.mashupEndMs, segment.crossfadeMs));
    }
    const bedGain = 1 - MASHUP_DUCK_DEPTH * duck;

    let left = 0;
    let right = 0;
    if (frame < bedFrames) {
      left = input.bed[frame * 2] * bedGain;
      right = input.bed[frame * 2 + 1] * bedGain;
    }

    for (const { segment, pcm } of prepared) {
      const gain = trapezoidGain(atMs, segment.mashupStartMs, segment.mashupEndMs, segment.crossfadeMs);
      if (gain <= 0) continue;
      const vocalFrame = Math.round(((atMs - segment.mashupStartMs) / 1000) * sampleRate);
      if (vocalFrame < 0 || vocalFrame * 2 + 1 >= pcm.length) continue;
      left += pcm[vocalFrame * 2] * gain;
      right += pcm[vocalFrame * 2 + 1] * gain;
    }

    // Mix prepared discrete stems with dynamic ducking into the vocal pocket
    for (const { pcm: stemBuffer } of preparedStems) {
      if (frame * 2 + 1 < stemBuffer.length) {
        const dynamicGain = MASHUP_DONOR_STEM_BASE_VOLUME * (1 - MASHUP_DUCK_DEPTH * duck);
        left += stemBuffer[frame * 2] * dynamicGain;
        right += stemBuffer[frame * 2 + 1] * dynamicGain;
      }
    }

    out[frame * 2] = Math.max(-1, Math.min(1, left));
    out[frame * 2 + 1] = Math.max(-1, Math.min(1, right));
  }
  return out;
}

// ---------------------------------------------------------------------------
// Song extension — loop a section to lengthen a song (bar-aligned)
// ---------------------------------------------------------------------------

export type ExtensionPlan = {
  engine: typeof MASHUP_PLANNER_ENGINE;
  /** The section being looped. */
  section: MashupSection;
  /** How many extra plays of the section are appended. */
  repeats: number;
  /** Bar-aligned crossfade between the original end and each loop (ms). */
  crossfadeMs: number;
  durationMs: number;
  rationale: string[];
};

/** Plan an extension by looping a song section (default: the last chorus).
 *  The original audio is never cut — loops are appended at the section end. */
export function planSongExtension(
  source: MashupSourceProfile,
  options: { sectionLabel?: string; repeats?: number } = {},
): ExtensionPlan | null {
  const repeats = Math.max(1, Math.min(8, options.repeats ?? 2));
  const wanted = options.sectionLabel;
  const candidates = source.sections.filter((section) =>
    wanted === undefined ? !isIntro(section.label) : section.label.toLowerCase().includes(wanted.toLowerCase()),
  );
  const section = (candidates.length > 0 ? candidates[candidates.length - 1] : null) ?? source.sections[source.sections.length - 1] ?? null;
  if (section === null) return null;

  const barMs = source.bpm !== null && source.bpm > 0 ? (240_000 / source.bpm) : 0;
  const crossfadeMs = barMs > 0 ? Math.min(Math.round(barMs / 2), 1000) : 500;
  const loopMs = Math.max(0, section.endMs - section.startMs);
  const rationale = [
    `extending “${section.label}” (${(section.startMs / 1000).toFixed(1)}s–${(section.endMs / 1000).toFixed(1)}s) by ${repeats} more play${repeats === 1 ? "" : "s"}`,
    `loops append at ${(section.endMs / 1000).toFixed(1)}s with ${(crossfadeMs / 1000).toFixed(2)}s bar-aligned crossfades`,
    "the original audio is untouched — the extension is additive",
  ];
  return {
    engine: MASHUP_PLANNER_ENGINE,
    section,
    repeats,
    crossfadeMs,
    durationMs: section.endMs + loopMs * repeats + (barMs > 0 ? barMs : 1000),
    rationale,
  };
}

/** Render an extension: original (fading out as the loops take over) +
 *  crossfaded extra plays of the section, bar-length tail. */
export function renderSongExtension(
  plan: ExtensionPlan,
  pcm: StereoBuffer,
  sampleRate: number,
): StereoBuffer {
  const totalFrames = Math.max(1, Math.round((plan.durationMs / 1000) * sampleRate));
  const out = new Float32Array(totalFrames * 2);
  const sourceFrames = Math.floor(pcm.length / 2);

  const sectionFrom = Math.round((plan.section.startMs / 1000) * sampleRate);
  const sectionMs = plan.section.endMs - plan.section.startMs;
  const sectionFrames = Math.max(1, Math.round((sectionMs / 1000) * sampleRate));
  const sectionEndMs = plan.section.endMs;

  for (let frame = 0; frame < totalFrames; frame += 1) {
    const atMs = (frame / sampleRate) * 1000;

    // Original pass: full gain until the section ends, then a short fade as
    // the first loop takes over. Anything past the plan is simply not used.
    if (frame < sourceFrames) {
      const originalGain = atMs <= sectionEndMs
        ? 1
        : Math.max(0, 1 - (atMs - sectionEndMs) / plan.crossfadeMs);
      out[frame * 2] += pcm[frame * 2] * originalGain;
      out[frame * 2 + 1] += pcm[frame * 2 + 1] * originalGain;
    }

    // Loop passes: each begins where the previous material ends, fading in
    // over crossfadeMs and out over its final crossfadeMs (into the next
    // loop or the outro bar).
    if (atMs >= sectionEndMs) {
      const loopIndex = Math.floor((atMs - sectionEndMs) / sectionMs);
      if (loopIndex < plan.repeats) {
        const loopStartMs = sectionEndMs + loopIndex * sectionMs;
        const loopEndMs = loopStartMs + sectionMs;
        const fadeIn = Math.min(1, (atMs - loopStartMs) / plan.crossfadeMs);
        const fadeOut = Math.min(1, (loopEndMs - atMs) / plan.crossfadeMs);
        const gain = Math.min(fadeIn, fadeOut);
        const sourceFrame = sectionFrom + (frame - Math.round((loopStartMs / 1000) * sampleRate));
        if (sourceFrame >= 0 && sourceFrame < sectionFrames && sourceFrame < sourceFrames) {
          out[frame * 2] += pcm[sourceFrame * 2] * gain;
          out[frame * 2 + 1] += pcm[sourceFrame * 2 + 1] * gain;
        }
      }
    }

    out[frame * 2] = Math.max(-1, Math.min(1, out[frame * 2]));
    out[frame * 2 + 1] = Math.max(-1, Math.min(1, out[frame * 2 + 1]));
  }
  return out;
}
