/**
 * Real-audio validation for Full Length looping and the stem-swap ordering.
 *
 * What this can and cannot prove is stated up front, in the manifest it writes
 * and in the ledger. Read `docs/waveyard-completion-ledger.md` section 13.
 *
 * ## The corpus limit that shapes everything here
 *
 * The owner's Full Length case is "a complete vocal shorter than its
 * instrumental". The licensed corpus has one complete performance (214.2s) and
 * every CC0 bed is <=103.8s, so the vocal is always the longer side. Rather than
 * fake the case with a trimmed vocal, this script makes the BED genuinely longer
 * using Waveyard's own `planSongExtension`/`renderSongExtension` — a real feature
 * that appends bar-aligned repeats of a measured section. The extended bed is a
 * real, if synthetic-arrangement, instrumental.
 *
 * A licensed multitrack with per-role stems (drums/bass/other) does not exist in
 * any reachable source: Git LFS endpoints are blocked, `uploads.github.com` and
 * `objects.githubusercontent.com` are blocked, and separation weights
 * (dl.fbaipublicfiles.com, huggingface.co) are blocked. So the stem-swap renders
 * here are produced by composing the retained-plus-replacement audio through the
 * SAME production functions the route uses, in the corrected order, and labelled
 * as such. They validate the planning order and the audible result; they are not
 * evidence of demucs-quality stem separation.
 *
 * ## What is produced
 *
 *   01-full-length-baseline       complete vocal vs extended bed (loops)
 *   02-full-length-original-bed   the same vocal vs the unextended bed
 *   03-swap-drum-context          composition where the drum band is replaced
 *   04-swap-bass-context          composition where the bass band is replaced
 *   05-original-composition       the unswapped composition, for A/B
 *
 * Usage:
 *   ARENA_FFMPEG_PATH=... tsx scripts/waveyard-real-audio-validation.ts \
 *     --vocals <wav> --bed <mp3> --out <dir>
 */

import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { analysePcm } from "../lib/arena/src/lib/waveyard/worker-local/analysis-engine";
import {
  planMashup,
  planSongExtension,
  renderMashupWithBus,
  renderSongExtension,
  type MashupPlan,
  type MashupSourceProfile,
} from "../lib/arena/src/lib/waveyard/studio/mashup";

const ANALYSIS_RATE = 22_050;
const RENDER_RATE = 44_100;

function arg(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? undefined : process.argv[index + 1];
}

function decode(path: string, ffmpeg: string, channels: 1 | 2, rate: number): Float32Array {
  const stdout = execFileSync(
    ffmpeg,
    ["-v", "error", "-i", path, "-ac", String(channels), "-ar", String(rate), "-f", "f32le", "-"],
    { maxBuffer: 1 << 30 },
  );
  return new Float32Array(stdout.buffer, stdout.byteOffset, stdout.byteLength / 4);
}

function writeWav(path: string, samples: Float32Array, sampleRate: number): void {
  const frames = Math.floor(samples.length / 2);
  const buffer = Buffer.alloc(44 + frames * 4);
  buffer.write("RIFF", 0); buffer.writeUInt32LE(36 + frames * 4, 4); buffer.write("WAVE", 8);
  buffer.write("fmt ", 12); buffer.writeUInt32LE(16, 16); buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(2, 22); buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(sampleRate * 4, 28); buffer.writeUInt16LE(4, 32); buffer.writeUInt16LE(16, 34);
  buffer.write("data", 36); buffer.writeUInt32LE(frames * 4, 40);
  for (let frame = 0; frame < frames; frame += 1) {
    for (let channel = 0; channel < 2; channel += 1) {
      const value = Math.max(-1, Math.min(1, samples[frame * 2 + channel] ?? 0));
      buffer.writeInt16LE(Math.round(value * 32767), 44 + (frame * 2 + channel) * 2);
    }
  }
  writeFileSync(path, buffer);
}

function sections(durationMs: number) {
  const at = (fraction: number) => Math.round(durationMs * fraction);
  return [
    { label: "intro", startMs: 0, endMs: at(0.08) },
    { label: "verse", startMs: at(0.08), endMs: at(0.6) },
    { label: "chorus", startMs: at(0.6), endMs: at(0.92) },
    { label: "outro", startMs: at(0.92), endMs: durationMs },
  ];
}

/** Measure a render, so the manifest carries evidence rather than a claim. */
function measure(pcm: Float32Array, sampleRate: number) {
  let peak = 0;
  let sumSquares = 0;
  let clipped = 0;
  for (const sample of pcm) {
    const magnitude = Math.abs(sample);
    if (magnitude > peak) peak = magnitude;
    if (magnitude >= 0.999) clipped += 1;
    sumSquares += sample * sample;
  }
  return {
    seconds: Number((pcm.length / 2 / sampleRate).toFixed(2)),
    peak: Number(peak.toFixed(3)),
    rmsDb: Number((20 * Math.log10(Math.max(1e-9, Math.sqrt(sumSquares / pcm.length)))).toFixed(1)),
    clippedSamples: clipped,
  };
}

/**
 * A one-pole crossover, used to build a "resulting composition" whose drum band
 * and bass band can be swapped independently. This is NOT a separation model and
 * the manifest says so: it is a frequency view of one real instrumental, used to
 * create a composition where a role genuinely differs.
 */
function splitBands(pcm: Float32Array, sampleRate: number): {
  low: Float32Array;
  high: Float32Array;
  bassBand: Float32Array;
  drumBand: Float32Array;
} {
  const high = new Float32Array(pcm.length);
  const low = new Float32Array(pcm.length);
  const bassBand = new Float32Array(pcm.length);
  const drumBand = new Float32Array(pcm.length);
  const frames = pcm.length / 2;
  // Two cascaded one-pole low-passes: ~250 Hz (drum body) and ~120 Hz (bass).
  const alphaDrum = 1 - Math.exp((-2 * Math.PI * 250) / sampleRate);
  const alphaBass = 1 - Math.exp((-2 * Math.PI * 120) / sampleRate);
  let stateDrumL = 0, stateDrumR = 0, stateBassL = 0, stateBassR = 0;
  for (let frame = 0; frame < frames; frame += 1) {
    const left = pcm[frame * 2] ?? 0;
    const right = pcm[frame * 2 + 1] ?? 0;
    stateDrumL += alphaDrum * (left - stateDrumL);
    stateDrumR += alphaDrum * (right - stateDrumR);
    stateBassL += alphaBass * (left - stateBassL);
    stateBassR += alphaBass * (right - stateBassR);
    drumBand[frame * 2] = stateDrumL;
    drumBand[frame * 2 + 1] = stateDrumR;
    bassBand[frame * 2] = stateBassL;
    bassBand[frame * 2 + 1] = stateBassR;
    // The drum band is everything below 250 Hz minus the pure bass, so the two
    // bands do not double-count the low end when recombined.
    low[frame * 2] = stateDrumL - stateBassL;
    low[frame * 2 + 1] = stateDrumR - stateBassR;
    high[frame * 2] = left - stateDrumL;
    high[frame * 2 + 1] = right - stateDrumR;
  }
  return { low, high, bassBand, drumBand };
}

function mix(...layers: Float32Array[]): Float32Array {
  const frames = Math.max(...layers.map((layer) => layer.length));
  const out = new Float32Array(frames);
  for (const layer of layers) {
    for (let index = 0; index < layer.length; index += 1) out[index] = (out[index] ?? 0) + (layer[index] ?? 0);
  }
  return out;
}

function main(): void {
  const ffmpeg = process.env.ARENA_FFMPEG_PATH;
  const vocalPath = arg("vocals");
  const bedPath = arg("bed");
  const outDirectory = arg("out");
  if (!ffmpeg || !vocalPath || !bedPath || !outDirectory) {
    console.error("usage: ARENA_FFMPEG_PATH=... --vocals <wav> --bed <file> --out <dir>");
    process.exit(1);
  }
  const out = resolve(outDirectory);
  mkdirSync(out, { recursive: true });
  const entries: Array<Record<string, unknown>> = [];

  // ---- source analysis (real) ------------------------------------------------
  const vocalMono = decode(vocalPath, ffmpeg, 1, ANALYSIS_RATE);
  const bedMono = decode(bedPath, ffmpeg, 1, ANALYSIS_RATE);
  const vocalDurationMs = Math.round((vocalMono.length / ANALYSIS_RATE) * 1000);
  const bedDurationMs = Math.round((bedMono.length / ANALYSIS_RATE) * 1000);
  const vocalAnalysis = analysePcm(vocalMono);
  const bedAnalysis = analysePcm(bedMono);

  const vocalStereo = decode(vocalPath, ffmpeg, 2, RENDER_RATE);
  const bedStereo = decode(bedPath, ffmpeg, 2, RENDER_RATE);

  const vocalProfile: MashupSourceProfile = {
    role: "vocals",
    bpm: vocalAnalysis.bpm, bpmConfidence: vocalAnalysis.bpmConfidence,
    bpmCandidates: vocalAnalysis.bpmCandidates,
    musicalKey: vocalAnalysis.musicalKey, keyConfidence: vocalAnalysis.keyConfidence,
    beatGridMs: vocalAnalysis.beatGridMs, beatConfidence: vocalAnalysis.beatConfidence,
    durationMs: vocalDurationMs, sections: sections(vocalDurationMs),
  };
  const bedProfile: MashupSourceProfile = {
    role: "instrumental",
    bpm: bedAnalysis.bpm, bpmConfidence: bedAnalysis.bpmConfidence,
    bpmCandidates: bedAnalysis.bpmCandidates,
    musicalKey: bedAnalysis.musicalKey, keyConfidence: bedAnalysis.keyConfidence,
    beatGridMs: bedAnalysis.beatGridMs, beatConfidence: bedAnalysis.beatConfidence,
    downbeatGridMs: bedAnalysis.downbeatGridMs, downbeatConfidence: bedAnalysis.downbeatConfidence,
    durationMs: bedDurationMs, sections: sections(bedDurationMs),
  };

  console.log(`vocal ${(vocalDurationMs / 1000).toFixed(1)}s  bed ${(bedDurationMs / 1000).toFixed(1)}s`);

  // ---- 1. extend the bed so it genuinely outlasts the complete vocal --------
  // Extend by a LONG measured section so the bed can genuinely outlast the vocal.
  // The owner's case needs bed > 2 x body before a loop has room.
  const extensionRepeats = Number(arg("repeats") ?? "3");
  const extensionSection = arg("section");
  const extension = planSongExtension(bedProfile, {
    repeats: extensionRepeats,
    ...(extensionSection ? { sectionLabel: extensionSection } : {}),
  });
  if (extension === null) {
    console.error("the bed has no sections to extend");
    process.exit(1);
  }
  const extendedBedStereo = renderSongExtension(extension, bedStereo, RENDER_RATE);
  const extendedBedMs = Math.round((extendedBedStereo.length / 2 / RENDER_RATE) * 1000);
  const extendedBedProfile: MashupSourceProfile = {
    ...bedProfile,
    durationMs: extendedBedMs,
    sections: sections(extendedBedMs),
  };
  console.log(`extended bed -> ${(extendedBedMs / 1000).toFixed(1)}s (${extension.repeats} repeats of "${extension.section.label}")`);

  const renderOne = (label: string, plan: MashupPlan, vocals: Float32Array, bed: Float32Array, notes: Record<string, unknown>) => {
    const { pcm, mix: mixResult } = renderMashupWithBus(plan, { vocals, bed, sampleRate: RENDER_RATE });
    const file = join(out, `${label}.wav`);
    writeWav(file, pcm, RENDER_RATE);
    const voicedMs = plan.segments.reduce(
      (sum, segment) => sum + Math.max(0, segment.mashupEndMs - segment.mashupStartMs), 0,
    );
    const entry = {
      label,
      file,
      strategy: plan.alignmentStrategy,
      plan: {
        masterBpm: plan.masterBpm,
        stretchRatio: Number(plan.vocalsStretchRatio.toFixed(3)),
        pitchSemitones: plan.vocalsPitchSemitones,
        segments: plan.segments.map((segment) => ({
          mashupStartMs: Math.round(segment.mashupStartMs),
          mashupEndMs: Math.round(segment.mashupEndMs),
          vocalsFromMs: Math.round(segment.vocalsFromMs),
          vocalsToMs: Math.round(segment.vocalsToMs),
        })),
        vocalCoverageFraction: Number((voicedMs / plan.durationMs).toFixed(3)),
        completePasses: plan.segments.filter(
          (segment) => Math.abs((segment.vocalsToMs - segment.vocalsFromMs) - (vocalDurationMs - 0)) < 1_500,
        ).length,
        warnings: plan.warnings.slice(0, 4),
      },
      ...measure(pcm, RENDER_RATE),
      limiterApplied: mixResult.limiter.applied,
      ...notes,
    };
    entries.push(entry);
    console.log(
      `${label.padEnd(28)} ${String(entry.seconds).padStart(7)}s  cover ${(Number(entry.plan.vocalCoverageFraction) * 100).toFixed(0)}%  segs ${plan.segments.length}  peak ${entry.peak}  clipped ${entry.clippedSamples}`,
    );
    return pcm;
  };

  // ---- 2. Full Length against the EXTENDED bed: the owner's case ----------
  const fullLength = planMashup(vocalProfile, extendedBedProfile, { strategy: "full-length" });
  if (!fullLength.ok) {
    console.error(`full-length planning refused: ${fullLength.reason}`);
    process.exit(1);
  }
  renderOne("01-full-length-looped", fullLength.plan, vocalStereo, extendedBedStereo, {
    case: "complete vocal shorter than the instrumental, looping",
    bed: "extended via planSongExtension (real Waveyard feature)",
  });

  // Control: the same vocal against the UNEXTENDED bed.
  const fullLengthShortBed = planMashup(vocalProfile, bedProfile, { strategy: "full-length" });
  if (fullLengthShortBed.ok) {
    renderOne("02-full-length-unextended", fullLengthShortBed.plan, vocalStereo, bedStereo, {
      case: "same vocal, original bed — no room to loop",
      bed: "original",
    });
  }

  // ---- 3. Composition swap: build a different resulting bed, then plan ----
  // The corrected order: construct the composition, analyse the composition,
  // plan against it. That is what the route now does.
  const bands = splitBands(extendedBedStereo, RENDER_RATE);
  const swappedDrum = mix(bands.high, bands.bassBand, bands.low.map((value) => value * 0.35));
  const swappedBass = mix(bands.high, bands.low, bands.bassBand.map((value) => value * 0.30));

  const analysisOf = (pcm: Float32Array) => {
    const mono = new Float32Array(pcm.length / 2);
    for (let frame = 0; frame < mono.length; frame += 1) {
      mono[frame] = ((pcm[frame * 2] ?? 0) + (pcm[frame * 2 + 1] ?? 0)) / 2;
    }
    // Decimate to the analysis rate for a comparable measurement.
    const factor = Math.round(RENDER_RATE / ANALYSIS_RATE);
    const decimated = new Float32Array(Math.floor(mono.length / factor));
    for (let index = 0; index < decimated.length; index += 1) decimated[index] = mono[index * factor] ?? 0;
    return analysePcm(decimated);
  };

  const compositionCases: Array<[string, Float32Array, string]> = [
    ["03-swap-drum-context", swappedDrum, "drum band reduced to 35%, bass retained"],
    ["04-swap-bass-context", swappedBass, "bass band reduced to 30%, drums retained"],
  ];

  for (const [label, compositionPcm, note] of compositionCases) {
    const compositionAnalysis = analysisOf(compositionPcm);
    const compositionProfile: MashupSourceProfile = {
      ...extendedBedProfile,
      bpm: compositionAnalysis.bpm ?? extendedBedProfile.bpm,
      bpmConfidence: compositionAnalysis.bpmConfidence ?? extendedBedProfile.bpmConfidence,
      musicalKey: compositionAnalysis.musicalKey ?? extendedBedProfile.musicalKey,
      keyConfidence: compositionAnalysis.keyConfidence ?? extendedBedProfile.keyConfidence,
      beatGridMs: compositionAnalysis.beatGridMs ?? extendedBedProfile.beatGridMs,
      beatConfidence: compositionAnalysis.beatConfidence ?? extendedBedProfile.beatConfidence,
    };
    const planned = planMashup(vocalProfile, compositionProfile, { strategy: "full-length" });
    if (!planned.ok) { console.error(`${label}: refused — ${planned.reason}`); continue; }
    renderOne(label, planned.plan, vocalStereo, compositionPcm, {
      case: note,
      analysedFromResultingComposition: true,
      plannedBpm: compositionProfile.bpm,
      plannedBeatGridPoints: Array.isArray(compositionProfile.beatGridMs) ? compositionProfile.beatGridMs.length : 0,
      originalBedPlannedBpm: extendedBedProfile.bpm,
    });
  }

  // Control: the unswapped composition under the same strategy.
  const originalComposition = planMashup(vocalProfile, extendedBedProfile, { strategy: "full-length" });
  if (originalComposition.ok) {
    renderOne("05-original-composition", originalComposition.plan, vocalStereo, extendedBedStereo, {
      case: "control for 03/04 — same vocal and strategy, unswapped bed",
    });
  }

  writeFileSync(join(out, "manifest.json"), JSON.stringify({
    purpose: "Real-audio validation of Full Length looping and composition-first planning.",
    listeners: 0,
    listenerAssessment: "NOT PERFORMED — produced for human listening.",
    realAudio: {
      vocals: "MTG turkish-makam-solo-voice, CC BY 4.0 (complete 214.2s performance)",
      bed: "AERIS MUSIC, CC0 1.0, extended with Waveyard planSongExtension",
    },
    limitations: [
      "No licensed multitrack with per-role stems was obtainable: Git LFS endpoints, uploads.github.com, objects.githubusercontent.com and separation weight hosts (dl.fbaipublicfiles.com, huggingface.co) are all blocked from this environment.",
      "The stem-swap cases therefore build a different resulting composition with a crossover filter, not a separation model. They validate the planning ORDER and the audible result; they are not evidence of demucs-quality separation.",
      "The extended bed is a real Waveyard feature output, so it is a genuine instrumental, but its arrangement is generated by looping a measured section.",
      "N = 0 listeners. No quality claim is made.",
    ],
    entries,
  }, null, 2));
  console.log(`\nwrote ${entries.length} renders -> ${out}`);
}

main();
