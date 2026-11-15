/**
 * Renders a **tempo-synced** listening pack, and one deliberately hostile case.
 *
 * ## Why this exists alongside `waveyard-listening-pack.ts`
 *
 * The dry pack runs the planner exactly as production does. On real
 * unaccompanied singing that means every pair withheld tempo stretching, because
 * rubato vocals never clear the 0.5 confidence gate. That is the honest
 * behaviour, but it makes a poor listening test: nothing is synced, so a
 * listener cannot judge arrangement, transitions or rhythmic stability — the
 * things the acceptance milestone is actually about.
 *
 * So this pack supplies tempo evidence for *one* pair and leaves everything else
 * alone. The stretch, the beat grid, the arrangement and the mix are all still
 * produced by the production code. Only the input confidence is stated up front,
 * and the manifest says so on every row.
 *
 * ## What each case demonstrates
 *
 *   - `synced`   — both sides declare a trustworthy tempo. Exercises stretching,
 *                  entry placement, phrase alignment and the mix bus.
 *   - `half-time`— 2:1 tempo pair. Must sync through a half-time lock, not by
 *                  halving the vocal.
 *   - `control-dry` — the same pair with the real confidence, for A/B against
 *                  the synced render so the cost of not syncing is audible.
 *   - `hostile`  — keys three semitones apart would normally invite transposition;
 *                  with untrusted keys it must stay at 0 semitones.
 *
 * Usage:
 *   ARENA_FFMPEG_PATH=... tsx scripts/waveyard-listening-pack-synced.ts \
 *     --vocals <dir> --beds <dir> --out <dir>
 */

import { execFileSync } from "node:child_process";
import { mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

import {
  analysePcm,
  tempoCandidates,
} from "../lib/arena/src/lib/waveyard/worker-local/analysis-engine";
import {
  planMashup,
  renderMashupWithBus,
  type MashupSourceProfile,
} from "../lib/arena/src/lib/waveyard/studio/mashup";

const ANALYSIS_RATE = 22_050;
const RENDER_RATE = 44_100;

const ATTRIBUTION =
  "Vocals: MTG turkish-makam-solo-voice dataset (CC BY 4.0). "
  + "Beds: AERIS MUSIC CC0 instrumentals.";

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

function sections(durationMs: number) {
  const at = (fraction: number) => Math.round(durationMs * fraction);
  return [
    { label: "intro", startMs: 0, endMs: at(0.08) },
    { label: "verse", startMs: at(0.08), endMs: at(0.6) },
    { label: "chorus", startMs: at(0.6), endMs: at(0.92) },
    { label: "outro", startMs: at(0.92), endMs: durationMs },
  ];
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

type Case = {
  label: string;
  planNote: string;
  vocals: string;
  bed: string;
  /** Tempo/key evidence handed to the planner, stated explicitly per case. */
  declared: { vocalBpm: number; vocalConfidence: number; bedBpm: number; bedConfidence: number };
  keyClaim: { vocal: string; bed: string };
  /**
   * Which tempo candidate families to hand the planner. `declared` derives the
   * octave family from the declared BPM, so the planner's octave resolution
   * cannot silently override the case. `measured` uses the real analysis, which
   * is what the dry control needs in order to behave exactly as production does.
   */
  candidates: "declared" | "measured";
};

const CASES: Case[] = [
  { label: "11-synced-close", planNote: "100 vs 112 BPM — small stretch, the common case",
    vocals: "02_Gel_2_zemin", bed: "horizon-monolith",
    declared: { vocalBpm: 100, vocalConfidence: 0.9, bedBpm: 112, bedConfidence: 0.9 },
    keyClaim: { vocal: "D minor", bed: "C major" }, candidates: "declared" },
  { label: "12-synced-half-time", planNote: "70 vs 140 BPM — must lock 1:1 as half-time, not halve the vocal",
    vocals: "02_Gel_4_nakarat", bed: "ash",
    declared: { vocalBpm: 70, vocalConfidence: 0.9, bedBpm: 140, bedConfidence: 0.9 },
    keyClaim: { vocal: "C major", bed: "C major" }, candidates: "declared" },
  { label: "13-synced-large-warp", planNote: "96 vs 128 BPM — a genuinely large stretch",
    vocals: "02_Hicran_Part1", bed: "overdrive-signal-lost",
    declared: { vocalBpm: 96, vocalConfidence: 0.9, bedBpm: 128, bedConfidence: 0.9 },
    keyClaim: { vocal: "E minor", bed: "C major" }, candidates: "declared" },
  { label: "14-control-dry", planNote: "the REAL analysis of case 11 — nothing synced (A/B control)",
    vocals: "02_Gel_2_zemin", bed: "horizon-monolith",
    declared: { vocalBpm: 103.36, vocalConfidence: 0.172, bedBpm: 112.347, bedConfidence: 0.621 },
    keyClaim: { vocal: "D minor", bed: "C major" }, candidates: "measured" },
  { label: "15-hostile-untrusted-keys", planNote: "keys 3 semitones apart with untrusted evidence — must not transpose",
    vocals: "02_Gel_6_meyan", bed: "quiet-room",
    declared: { vocalBpm: 92, vocalConfidence: 0.9, bedBpm: 84, bedConfidence: 0.9 },
    keyClaim: { vocal: "C major", bed: "A major" }, candidates: "declared" },
];

function main(): void {
  const ffmpeg = process.env.ARENA_FFMPEG_PATH;
  const vocalDirectory = arg("vocals");
  const bedDirectory = arg("beds");
  const outDirectory = arg("out");
  if (!ffmpeg || !vocalDirectory || !bedDirectory || !outDirectory) {
    console.error("usage: ARENA_FFMPEG_PATH=... --vocals <dir> --beds <dir> --out <dir>");
    process.exit(1);
  }
  const out = resolve(outDirectory);
  mkdirSync(out, { recursive: true });
  const vocalFiles = readdirSync(resolve(vocalDirectory));
  const bedFiles = readdirSync(resolve(bedDirectory));

  const entries: Array<Record<string, unknown>> = [];
  for (const spec of CASES) {
    const vocalFile = vocalFiles.find((name) => name.includes(spec.vocals));
    const bedFile = bedFiles.find((name) => name.includes(spec.bed));
    if (!vocalFile || !bedFile) { console.error(`missing input for ${spec.label}`); continue; }
    const vocalPath = join(resolve(vocalDirectory), vocalFile);
    const bedPath = join(resolve(bedDirectory), bedFile);

    const vocalMono = decode(vocalPath, ffmpeg, 1, ANALYSIS_RATE);
    const bedMono = decode(bedPath, ffmpeg, 1, ANALYSIS_RATE);
    const vocalDurationMs = Math.round((vocalMono.length / ANALYSIS_RATE) * 1000);
    const bedDurationMs = Math.round((bedMono.length / ANALYSIS_RATE) * 1000);
    const vocalAnalysis = analysePcm(vocalMono);
    const bedAnalysis = analysePcm(bedMono);

    // Tempo and key evidence are overridden per case; everything else — beat
    // grid, downbeats, sections — comes from the real analysis. The candidate
    // family must match the declared tempo, otherwise the planner's own octave
    // resolution (which is correct behaviour) rewrites the case under test.
    const vocalCandidates = spec.candidates === "declared"
      ? tempoCandidates(spec.declared.vocalBpm)
      : vocalAnalysis.bpmCandidates;
    const bedCandidates = spec.candidates === "declared"
      ? tempoCandidates(spec.declared.bedBpm)
      : bedAnalysis.bpmCandidates;
    const vocals: MashupSourceProfile = {
      role: "vocals",
      bpm: spec.declared.vocalBpm,
      bpmConfidence: spec.declared.vocalConfidence,
      bpmCandidates: vocalCandidates,
      musicalKey: spec.keyClaim.vocal,
      keyConfidence: 0.1,
      beatGridMs: vocalAnalysis.beatGridMs,
      beatConfidence: vocalAnalysis.beatConfidence,
      durationMs: vocalDurationMs,
      sections: sections(vocalDurationMs),
    };
    const bed: MashupSourceProfile = {
      role: "instrumental",
      bpm: spec.declared.bedBpm,
      bpmConfidence: spec.declared.bedConfidence,
      bpmCandidates: bedCandidates,
      musicalKey: spec.keyClaim.bed,
      keyConfidence: 0.1,
      beatGridMs: bedAnalysis.beatGridMs,
      beatConfidence: bedAnalysis.beatConfidence,
      downbeatGridMs: bedAnalysis.downbeatGridMs,
      downbeatConfidence: bedAnalysis.downbeatConfidence,
      durationMs: bedDurationMs,
      sections: sections(bedDurationMs),
    };

    const result = planMashup(vocals, bed);
    if (!result.ok) { entries.push({ label: spec.label, planned: false, reason: result.reason }); continue; }

    const vocalStereo = decode(vocalPath, ffmpeg, 2, RENDER_RATE);
    const bedStereo = decode(bedPath, ffmpeg, 2, RENDER_RATE);
    const { pcm, mix } = renderMashupWithBus(result.plan, {
      vocals: vocalStereo, bed: bedStereo, sampleRate: RENDER_RATE,
    });
    const file = join(out, `${spec.label}.wav`);
    writeWav(file, pcm, RENDER_RATE);

    let peak = 0, clipped = 0, sumSquares = 0;
    for (const sample of pcm) {
      const magnitude = Math.abs(sample);
      if (magnitude > peak) peak = magnitude;
      if (magnitude >= 0.999) clipped += 1;
      sumSquares += sample * sample;
    }
    entries.push({
      label: spec.label,
      planNote: spec.planNote,
      declaredEvidence: spec.declared,
      candidateFamily: spec.candidates,
      vocalKeyClaim: spec.keyClaim.vocal,
      bedKeyClaim: spec.keyClaim.bed,
      vocals: vocalFile,
      bed: bedFile,
      file,
      seconds: Number((pcm.length / 2 / RENDER_RATE).toFixed(1)),
      masterBpm: result.plan.masterBpm,
      stretchRatio: Number(result.plan.vocalsStretchRatio.toFixed(3)),
      pitchSemitones: result.plan.vocalsPitchSemitones,
      keyRelationship: result.plan.keyRelationship,
      peak: Number(peak.toFixed(3)),
      rmsDb: Number((20 * Math.log10(Math.max(1e-9, Math.sqrt(sumSquares / pcm.length)))).toFixed(1)),
      clippedSamples: clipped,
      limiterApplied: mix.limiter.applied,
      staticGainDb: Number(mix.staticGainDb.toFixed(2)),
      // Balance measurements. `vocalSourceActiveFraction` is the active-block
      // fraction of the WHOLE vocal file, not of the finished mix — the plan
      // only places a few seconds of it, so this is NOT a vocal-coverage figure.
      // MixBus samples `vocalCoverage` separately for that.
      vocalSourceActiveFraction: mix.balance.vocalActiveFraction ?? null,
      vocalGainDb: Number(mix.balance.vocalGainDb.toFixed(2)),
      balanceCorrectionClamped: mix.balance.correctionClamped,
      balanceNote: mix.balance.note,
      // Structural evidence only. Whether this SOUNDS synced is a listener's
      // call, not this script's, so no verdict is recorded here.
      vocalEntryMs: result.plan.segments[0]?.mashupStartMs ?? null,
      segmentCount: result.plan.segments.length,
      // Measured structure, not a quality verdict: how much of the runtime the
      // vocal is actually audible on. A 60 s render with a 9 s vocal cameo is a
      // different musical object from a 60 s duet, and a listener should know
      // which one they are hearing before they judge it.
      vocalCoverage: (() => {
        const total = Number((pcm.length / 2 / RENDER_RATE).toFixed(2));
        const voiced = result.plan.segments.reduce(
          (sum, segment) => sum + Math.max(0, segment.mashupEndMs - segment.mashupStartMs), 0,
        ) / 1000;
        return {
          secondsWithVocal: Number(voiced.toFixed(1)),
          totalSeconds: total,
          fraction: Number((voiced / total).toFixed(3)),
        };
      })(),
      segments: result.plan.segments.slice(0, 8).map((segment) => ({
        mashupStartMs: segment.mashupStartMs,
        mashupEndMs: segment.mashupEndMs,
        vocalsFromMs: segment.vocalsFromMs,
        vocalsToMs: segment.vocalsToMs,
        crossfadeMs: segment.crossfadeMs,
        localTempoCorrection: Boolean(segment.localTempoMap),
      })),
      rationale: result.plan.rationale.slice(0, 8),
      warnings: result.plan.warnings,
    });
    console.log(`${spec.label.padEnd(26)} ${String(entries.at(-1)!.seconds).padStart(6)}s  stretch x${result.plan.vocalsStretchRatio.toFixed(3)}  ${result.plan.vocalsPitchSemitones} st  peak ${peak.toFixed(2)}  ${clipped} clipped`);
  }

  writeFileSync(join(out, "manifest-synced.json"), JSON.stringify({
    purpose: "Tempo-SYNCED listening pack for judging arrangement, transitions and rhythmic stability.",
    listeners: 0,
    listenerAssessment: "NOT PERFORMED — produced for human listening.",
    inputs: ATTRIBUTION,
    honesty:
      "Tempo (and, for two cases, key) evidence is DECLARED per case rather than measured, because rubato "
      + "a-cappella singing never clears the 0.5 confidence gate. Stretching, beat grids, entry placement, "
      + "arrangement and the mix are all still produced by the production code path.",
    entries,
  }, null, 2));
  console.log(`\nwrote ${entries.length} cases -> ${out}`);
}

main();
