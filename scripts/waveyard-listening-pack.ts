/**
 * Renders a listening pack of real Waveyard mashups.
 *
 * This produces the deliverable that automated tests cannot: audible output for
 * a human to judge. Everything downstream of the analyser runs through the
 * production planner and mix bus (`planMashup` + `renderMashupWithBus`), so what
 * you hear is what the app would render, not a simplified stand-in.
 *
 * ## Inputs, and why they are legitimate
 *
 * - **Beds**: the CC0 (public-domain) AERIS instrumentals already used as the
 *   real-audio acceptance corpus. Instrumental only.
 * - **Vocals**: the MTG *turkish-makam-solo-voice* dataset, **CC BY 4.0**,
 *   credited below. These are recordings of unaccompanied singing, which makes
 *   them genuine isolated vocals without running a separation model.
 *
 * No commercial recording is used. The vocal dataset's licence requires
 * attribution and it is stated in the manifest this script writes.
 *
 * ## What it deliberately includes
 *
 * The pairs are chosen to cover the conditions the acceptance milestone names:
 * similar and different tempos, both sides with trustworthy and untrustworthy
 * tempo, and the normal case of no trustworthy key on either side. The varied
 * cases are labelled in the manifest so a listener knows what each example is
 * meant to demonstrate rather than judging twenty anonymous files.
 *
 * Usage:
 *   ARENA_FFMPEG_PATH=/path/to/ffmpeg \
 *     tsx scripts/waveyard-listening-pack.ts --vocals <dir> --beds <dir> --out <dir>
 */

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { analysePcm } from "../lib/arena/src/lib/waveyard/worker-local/analysis-engine";
import {
  planMashup,
  renderMashupWithBus,
  type MashupSourceProfile,
} from "../lib/arena/src/lib/waveyard/studio/mashup";

const here = dirname(fileURLToPath(import.meta.url));
const ANALYSIS_RATE = 22_050;
const RENDER_RATE = 44_100;

const VOCAL_ATTRIBUTION =
  "Vocals: MTG turkish-makam-solo-voice dataset (CC BY 4.0, "
  + "https://github.com/MTG/turkish-makam-acapella-sections-dataset). "
  + "Beds: AERIS MUSIC CC0 instrumentals (https://github.com/farmmer938-lgtm/aeris-cc0-music).";

type Input = {
  id: string;
  path: string;
  durationMs: number;
  analysis: ReturnType<typeof analysePcm>;
};

function arg(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? undefined : process.argv[index + 1];
}

function requireFfmpeg(): string {
  const ffmpeg = process.env.ARENA_FFMPEG_PATH;
  if (!ffmpeg) throw new Error("ARENA_FFMPEG_PATH must point at an ffmpeg binary.");
  return ffmpeg;
}

function decode(path: string, ffmpeg: string, channels: 1 | 2, rate: number): Float32Array {
  const stdout = execFileSync(
    ffmpeg,
    ["-v", "error", "-i", path, "-ac", String(channels), "-ar", String(rate), "-f", "f32le", "-"],
    { maxBuffer: 1 << 30 },
  );
  return new Float32Array(stdout.buffer, stdout.byteOffset, stdout.byteLength / 4);
}

function load(path: string, id: string, ffmpeg: string): Input {
  const mono = decode(path, ffmpeg, 1, ANALYSIS_RATE);
  return {
    id,
    path,
    durationMs: Math.round((mono.length / ANALYSIS_RATE) * 1000),
    analysis: analysePcm(mono),
  };
}

/** Real audio has no section analysis here, so use a conservative two-part shape. */
function sections(durationMs: number) {
  const at = (fraction: number) => Math.round(durationMs * fraction);
  return [
    { label: "intro", startMs: 0, endMs: at(0.08) },
    { label: "verse", startMs: at(0.08), endMs: at(0.6) },
    { label: "chorus", startMs: at(0.6), endMs: at(0.92) },
    { label: "outro", startMs: at(0.92), endMs: durationMs },
  ];
}

function profile(role: "vocals" | "instrumental", input: Input): MashupSourceProfile {
  const a = input.analysis;
  return {
    role,
    bpm: a.bpm,
    bpmConfidence: a.bpmConfidence,
    bpmCandidates: a.bpmCandidates,
    musicalKey: a.musicalKey,
    keyConfidence: a.keyConfidence,
    beatGridMs: a.beatGridMs,
    beatConfidence: a.beatConfidence,
    downbeatGridMs: a.downbeatGridMs,
    downbeatConfidence: a.downbeatConfidence,
    durationMs: input.durationMs,
    sections: sections(input.durationMs),
  };
}

function writeWav(path: string, samples: Float32Array, sampleRate: number): void {
  const frames = Math.floor(samples.length / 2);
  const buffer = Buffer.alloc(44 + frames * 4);
  buffer.write("RIFF", 0);
  buffer.writeUInt32LE(36 + frames * 4, 4);
  buffer.write("WAVE", 8);
  buffer.write("fmt ", 12);
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(2, 22);
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(sampleRate * 4, 28);
  buffer.writeUInt16LE(4, 32);
  buffer.writeUInt16LE(16, 34);
  buffer.write("data", 36);
  buffer.writeUInt32LE(frames * 4, 40);
  for (let frame = 0; frame < frames; frame += 1) {
    for (let channel = 0; channel < 2; channel += 1) {
      const value = Math.max(-1, Math.min(1, samples[frame * 2 + channel] ?? 0));
      buffer.writeInt16LE(Math.round(value * 32767), 44 + (frame * 2 + channel) * 2);
    }
  }
  writeFileSync(path, buffer);
}

type PairSpec = { label: string; vocals: string; bed: string; note: string };

/**
 * Deliberate coverage rather than a combinatorial sweep: each row demonstrates a
 * different analysis condition, which is what a listener needs to find the real
 * weaknesses. Ids are matched against the input file names by substring.
 */
const PAIRS: PairSpec[] = [
  { label: "01-similar-tempo", vocals: "02_Gel_2_zemin", bed: "horizon-monolith", note: "vocals ~103 BPM against a ~112 BPM bed; a light stretch is expected" },
  { label: "02-different-tempo", vocals: "02_Gel_4_nakarat", bed: "ash", note: "vocals ~112 BPM against an ~88 BPM bed; the largest warp in the pack" },
  { label: "03-long-vocal", vocals: "02_Hicran_Part1", bed: "overdrive-signal-lost", note: "a 104 s vocal phrase over a ~128 BPM bed" },
  { label: "04-full-song-vocal", vocals: "02_Kimseye", bed: "signal-lost", note: "a 214 s vocal over a ~96 BPM bed; the longest output" },
  { label: "05-uncertain-tempo", vocals: "02_Gel_5_nakarat2", bed: "beneath", note: "vocal tempo confidence is low, so stretching should be withheld" },
  { label: "06-different-style", vocals: "02_Gel_6_meyan", bed: "overdrive-signal-lost", note: "rubato-like singing against a driving electronic bed" },
  { label: "07-bed-slow", vocals: "02_Gel_7_meyan2", bed: "quiet-room", note: "the slowest bed (~68-83 BPM) in the corpus" },
  { label: "08-bed-lofi", vocals: "02_Gel_8_nakarat", bed: "bedroom-window-vast", note: "lofi/hazy bed at ~74 BPM" },
  { label: "09-dense-bed", vocals: "02_Hicran_Part2_T1", bed: "afterglow-vast", note: "dense warm pad bed; checks whether the vocal stays intelligible" },
  { label: "10-leftover-pair", vocals: "02_Kimseye_4_nakarat", bed: "old-photos-outlands", note: "a short section; checks a short vocal body over a full bed" },
];

function main(): void {
  const ffmpeg = requireFfmpeg();
  const vocalDirectory = arg("vocals");
  const bedDirectory = arg("beds");
  const outDirectory = arg("out");
  if (!vocalDirectory || !bedDirectory || !outDirectory) {
    console.error("usage: --vocals <dir> --beds <dir> --out <dir>");
    process.exit(1);
  }
  mkdirSync(resolve(outDirectory), { recursive: true });

  const vocalFiles = readdirSync(resolve(vocalDirectory)).filter((name) => name.toLowerCase().endsWith(".wav"));
  const bedFiles = readdirSync(resolve(bedDirectory)).filter((name) => name.toLowerCase().endsWith(".mp3"));

  const vocalCache = new Map<string, Input>();
  const bedCache = new Map<string, Input>();
  const loadVocal = (needle: string) => {
    if (vocalCache.has(needle)) return vocalCache.get(needle)!;
    const file = vocalFiles.find((name) => name.includes(needle));
    if (!file) throw new Error(`no vocal file matching "${needle}" in ${vocalDirectory}`);
    const input = load(join(resolve(vocalDirectory), file), file.replace(/\.wav$/i, ""), ffmpeg);
    vocalCache.set(needle, input);
    return input;
  };
  const loadBed = (needle: string) => {
    if (bedCache.has(needle)) return bedCache.get(needle)!;
    const file = bedFiles.find((name) => name.includes(needle));
    if (!file) throw new Error(`no bed file matching "${needle}" in ${bedDirectory}`);
    const input = load(join(resolve(bedDirectory), file), file.replace(/\.mp3$/i, ""), ffmpeg);
    bedCache.set(needle, input);
    return input;
  };

  const entries: Array<Record<string, unknown>> = [];
  for (const spec of PAIRS) {
    const vocals = loadVocal(spec.vocals);
    const bed = loadBed(spec.bed);
    const result = planMashup(profile("vocals", vocals), profile("instrumental", bed));
    const base = {
      label: spec.label,
      note: spec.note,
      vocals: vocals.id,
      bed: bed.id,
      vocalsAnalysis: {
        bpm: vocals.analysis.bpm, bpmConfidence: vocals.analysis.bpmConfidence,
        key: vocals.analysis.musicalKey, keyConfidence: vocals.analysis.keyConfidence,
      },
      bedAnalysis: {
        bpm: bed.analysis.bpm, bpmConfidence: bed.analysis.bpmConfidence,
        key: bed.analysis.musicalKey, keyConfidence: bed.analysis.keyConfidence,
      },
    };
    if (!result.ok) {
      entries.push({ ...base, planned: false, reason: result.reason });
      continue;
    }

    const vocalStereo = decode(vocals.path, ffmpeg, 2, RENDER_RATE);
    const bedStereo = decode(bed.path, ffmpeg, 2, RENDER_RATE);
    const { pcm, mix } = renderMashupWithBus(result.plan, {
      vocals: vocalStereo, bed: bedStereo, sampleRate: RENDER_RATE,
    });
    const file = join(resolve(outDirectory), `${spec.label}.wav`);
    writeWav(file, pcm, RENDER_RATE);

    let peak = 0;
    let clipped = 0;
    let sumSquares = 0;
    for (const sample of pcm) {
      const magnitude = Math.abs(sample);
      if (magnitude > peak) peak = magnitude;
      if (magnitude >= 0.999) clipped += 1;
      sumSquares += sample * sample;
    }
    const rms = Math.sqrt(sumSquares / Math.max(1, pcm.length));
    entries.push({
      ...base,
      planned: true,
      file,
      seconds: Number((pcm.length / 2 / RENDER_RATE).toFixed(1)),
      masterBpm: result.plan.masterBpm,
      stretchRatio: Number(result.plan.vocalsStretchRatio.toFixed(3)),
      pitchSemitones: result.plan.vocalsPitchSemitones,
      keyRelationship: result.plan.keyRelationship,
      peak: Number(peak.toFixed(3)),
      rmsDb: Number((20 * Math.log10(Math.max(1e-9, rms))).toFixed(1)),
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
      rationale: result.plan.rationale.slice(0, 10),
      warnings: result.plan.warnings,
    });
  }

  const manifest = {
    purpose:
      "Listening pack of real Waveyard mashups for human assessment. These are actual renders from the "
      + "production planner and mix bus, not synthetic fixtures.",
    listeners: 0,
    listenerAssessment: "NOT PERFORMED — this pack exists so a human can do it. No automated score here is a quality claim.",
    inputs: VOCAL_ATTRIBUTION,
    inputsArePreSeparated:
      "The vocal side is unaccompanied singing and the bed side is an instrumental, so both are already "
      + "isolated. No separation model was run — none could be downloaded in this environment — and that is "
      + "recorded here so nobody assumes the separation stage was exercised.",
    renderRate: RENDER_RATE,
    entries,
  };
  writeFileSync(join(resolve(outDirectory), "manifest.json"), JSON.stringify(manifest, null, 2));

  for (const entry of entries) {
    const status = entry.planned === true
      ? `${String(entry.seconds).padStart(6)}s  peak ${entry.peak}  rms ${entry.rmsDb}dB  stretch x${entry.stretchRatio}  ${entry.clippedSamples} clipped`
      : `REFUSED: ${entry.reason}`;
    console.log(`${String(entry.label).padEnd(22)} ${status}`);
  }
  console.log(`\n${entries.filter((entry) => entry.planned === true).length}/${entries.length} rendered -> ${resolve(outDirectory)}`);
}

main();
