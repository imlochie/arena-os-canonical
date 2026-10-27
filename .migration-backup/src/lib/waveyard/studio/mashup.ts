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

export const MASHUP_PLANNER_ENGINE = "waveyard-mashup-planner-v1";
export const MASHUP_RENDER_ENGINE = "waveyard-mashup-render-v1";

export type MashupSection = { label: string; startMs: number; endMs: number };

export type MashupSourceProfile = {
  role: "vocals" | "instrumental";
  bpm: number | null;
  musicalKey: string | null;
  durationMs: number;
  sections: MashupSection[];
};

export type MashupSegment = {
  /** Placement on the mashup (bed) timeline. */
  mashupStartMs: number;
  mashupEndMs: number;
  /** Span of the VOCAL source this segment carries (before stretch). */
  vocalsFromMs: number;
  vocalsToMs: number;
  /** Trapezoid fade in/out on the segment (ms). */
  crossfadeMs: number;
  rationale: string;
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
const DUCK_DEPTH = 0.28;

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
  if (bed.bpm === null || bed.bpm <= 0) {
    return { ok: false, reason: "The instrumental's tempo analysis is not complete — the mashup has no tempo master to sync to." };
  }
  if (vocals.bpm === null || vocals.bpm <= 0) {
    return { ok: false, reason: "The vocal track's tempo analysis is not complete — run analysis first so the stretch can be computed honestly." };
  }
  const rationale: string[] = [];
  const warnings: string[] = [];

  const masterBpm = bed.bpm;
  rationale.push(`master tempo = the instrumental's ${masterBpm} BPM (the bed wins the tempo war).`);

  const stretchRatio = warpRatioForTempos(vocals.bpm, masterBpm);
  if (Math.abs(stretchRatio - 1) < 1e-9) {
    rationale.push(`vocals stay at natural speed (${vocals.bpm} BPM syncs to ${masterBpm} BPM as-is or via a double/half lock).`);
  } else {
    rationale.push(`vocals are time-stretched ×${stretchRatio.toFixed(3)} (${vocals.bpm} → ${masterBpm} BPM, pitch preserved by WSOLA).`);
  }
  if (vocals.bpm !== masterBpm && Math.abs(vocals.bpm - masterBpm) <= 6) {
    rationale.push("tempos are near-equal — a light stretch, not a resample.");
  }

  const pitchMove = pitchMoveForKeys(vocals.musicalKey, bed.musicalKey);
  if (pitchMove.relationship === "unknown") {
    warnings.push("Key analysis is missing for at least one track — no pitch move was made (0 semitones).");
  } else if (pitchMove.semitones === 0 && pitchMove.relationship === "relative") {
    rationale.push(`keys are relative (${vocals.musicalKey} / ${bed.musicalKey}) — same scale, no pitch shift needed.`);
  } else if (pitchMove.semitones === 0) {
    rationale.push(`same key (${bed.musicalKey}) — no pitch shift needed.`);
  } else {
    rationale.push(`vocals shift ${pitchMove.semitones > 0 ? "+" : ""}${pitchMove.semitones} semitones (${vocals.musicalKey} → ${bed.musicalKey}, ${pitchMove.relationship}).`);
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
  const segment: MashupSegment = {
    mashupStartMs: entry.at,
    mashupEndMs: Math.min(bed.durationMs, entry.at + stretchedMs),
    vocalsFromMs: body.fromMs,
    vocalsToMs: body.toMs,
    crossfadeMs: CROSSFADE_MS,
    rationale: `vocals run ${(stretchedMs / 1000).toFixed(1)}s over the bed from ${(entry.at / 1000).toFixed(1)}s`,
  };
  if (stretchedMs > bedRoomMs) {
    warnings.push(`The stretched vocal (${(stretchedMs / 1000).toFixed(1)}s) is longer than the bed has room (${(bedRoomMs / 1000).toFixed(1)}s) — it fades out at the bed's end.`);
    segment.rationale += " (truncated at the bed's end)";
  }

  return {
    ok: true,
    plan: {
      engine: MASHUP_PLANNER_ENGINE,
      masterBpm,
      vocalsStretchRatio: stretchRatio,
      vocalsPitchSemitones: pitchMove.semitones,
      keyRelationship: pitchMove.relationship,
      segments: [segment],
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

/** Mix the plan: bed (ducked under vocals) + stretched/pitched vocal
 *  segments with trapezoid fades. Deterministic from the plan. */
export function renderMashup(plan: MashupPlan, input: MashupPcmInput): StereoBuffer {
  const { sampleRate } = input;
  const totalFrames = Math.max(1, Math.round((plan.durationMs / 1000) * sampleRate));
  const out = new Float32Array(totalFrames * 2);

  // Prepared vocal segments (stretched once, then pitched once each).
  const prepared = plan.segments.map((segment) => {
    const fromFrame = Math.max(0, Math.round((segment.vocalsFromMs / 1000) * sampleRate) * 2);
    const toFrame = Math.min(input.vocals.length, Math.round((segment.vocalsToMs / 1000) * sampleRate) * 2);
    const span = input.vocals.slice(fromFrame, toFrame);
    const stretched = timeStretch(span, plan.vocalsStretchRatio, sampleRate);
    return { segment, pcm: pitchShift(stretched, plan.vocalsPitchSemitones, sampleRate) };
  });

  const bedFrames = Math.min(totalFrames, Math.floor(input.bed.length / 2));
  for (let frame = 0; frame < totalFrames; frame += 1) {
    const atMs = (frame / sampleRate) * 1000;

    // Bed gain: 1.0, ducked by a smoothed trapezoid under active vocals.
    let duck = 0;
    for (const { segment } of prepared) {
      duck = Math.max(duck, trapezoidGain(atMs, segment.mashupStartMs, segment.mashupEndMs, segment.crossfadeMs));
    }
    const bedGain = 1 - DUCK_DEPTH * duck;

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
