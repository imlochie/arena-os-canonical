/**
 * The four-way controlled mix comparison: A / B / C / D.
 *
 *   A  baseline            old composition, old mix
 *   B  composition only    corrected stem composition, old mix
 *   C  mix only            old composition, corrected mix
 *   D  both                corrected composition, corrected mix
 *
 * "Old mix" is reproduced faithfully, not approximated: vocal and bed summed
 * at unity, no loudness match, hard clamp at full scale, and donor stems
 * summed additively from timeline zero at the historical 0.6 gain. That code
 * is kept here as a deliberate, quarantined copy of the previous behaviour so
 * the comparison is against what the old renderer actually did.
 *
 * Why the split matters: it separates the two claims. If B does not beat A,
 * the composition fix is not the reason renders sounded chaotic. If C does not
 * beat A, the mix bus is not either. Cases where A already wins are useful
 * results and must not be discarded.
 *
 * Both variants of each pair are loudness-matched for playback before being
 * written, so a listener cannot prefer a file for being louder. The matched
 * gain is reported per file. This is a level control, not a quality score.
 *
 *   tsx scripts/waveyard-mashup-abcd.ts --manifest fixtures/abcd.json --out out/abcd
 *
 * Manifest shape (paths are relative to the manifest file):
 * {
 *   "vocals":  { "path": "queen-vocals.wav",  "bpm": 109.96, "key": "F minor",
 *                "bpmConfidence": 0.74, "keyConfidence": 0.8,
 *                "sections": [{ "label": "verse", "startMs": 0, "endMs": 60000 }] },
 *   "bed":     { "path": "september-bed.wav", "bpm": 126.05, "key": "F minor",
 *                "bpmConfidence": 0.89, "keyConfidence": 0.8,
 *                "sections": [{ "label": "chorus", "startMs": 0, "endMs": 60000 }] },
 *   "strategy": "continuous",
 *   "layerStemTypes": [],
 *   "donorStems": { "drums": "queen-drums.wav" }
 * }
 *
 * `sections` are optional but strongly affect the plan; the planner never
 * invents semantic labels. No file here is committed: the outputs are build
 * artefacts and the sources keep their own licence.
 */
import { readFileSync, writeFileSync, mkdirSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { createHash } from "node:crypto";
import {
  planMashup,
  type MashupPlan,
  type MashupSourceProfile,
  type MashupSection,
} from "../lib/arena/src/lib/waveyard/studio/mashup.ts";
import {
  planMashupBalance,
  finishMashupMix,
  measurePresentLoudness,
} from "../lib/arena/src/lib/waveyard/studio/mashup-mix-bus.ts";
import { pitchShift, timeStretch, type TimeStretchMapPoint } from "../lib/arena/src/lib/waveyard/elastic.ts";
import { decodeWav16, encodeWav16 } from "../lib/arena/src/lib/waveyard/mixer/synth.ts";
import { clippedRegions, measureLoudness, samplePeak, truePeakDb } from "../lib/arena/src/lib/waveyard/mixer/meters.ts";

const RATE = 44_100;
const DUCK_DEPTH = 0.28;
const CROSSFADE_MS = 250;
const LEGACY_DONOR_GAIN = 0.6;

type TrackSpec = {
  path: string;
  bpm?: number | null;
  key?: string | null;
  bpmConfidence?: number | null;
  keyConfidence?: number | null;
  beatGridMs?: number[] | null;
  beatConfidence?: number | null;
  downbeatGridMs?: number[] | null;
  downbeatConfidence?: number | null;
  sections?: Array<{ label: string; startMs: number; endMs: number }>;
};

type Manifest = {
  vocals: TrackSpec;
  bed: TrackSpec;
  strategy?: "continuous" | "paired-grid" | "downbeat" | "phrase-aware";
  layerStemTypes?: string[];
  donorStems?: Record<string, string>;
  outputSeconds?: number;
};

function sha256(bytes: Uint8Array | Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function readWav(path: string): Float32Array {
  const decoded = decodeWav16(new Uint8Array(readFileSync(path)));
  if (decoded === null) throw new Error(`${path} is not a decodable PCM16 WAV`);
  if (decoded.sampleRate !== RATE) {
    throw new Error(`${path} is ${decoded.sampleRate} Hz; the mashup renderer requires ${RATE} Hz. Convert it first rather than resampling silently.`);
  }
  if (decoded.channels !== 2) throw new Error(`${path} has ${decoded.channels} channels; stereo is required`);
  return decoded.samples;
}

function toProfile(spec: TrackSpec, role: "vocals" | "instrumental", pcm: Float32Array): MashupSourceProfile {
  const sections: MashupSection[] = (spec.sections ?? []).map((section) => ({
    label: section.label,
    startMs: section.startMs,
    endMs: section.endMs,
  }));
  return {
    role,
    bpm: spec.bpm ?? null,
    bpmConfidence: spec.bpmConfidence ?? null,
    musicalKey: spec.key ?? null,
    keyConfidence: spec.keyConfidence ?? null,
    beatGridMs: spec.beatGridMs ?? null,
    beatConfidence: spec.beatConfidence ?? null,
    downbeatGridMs: spec.downbeatGridMs ?? null,
    downbeatConfidence: spec.downbeatConfidence ?? null,
    durationMs: Math.round((pcm.length / 2 / RATE) * 1000),
    sections,
  };
}

function trapezoidGain(atMs: number, startMs: number, endMs: number, crossfadeMs: number): number {
  if (atMs < startMs || atMs > endMs) return 0;
  const into = atMs - startMs;
  const remaining = endMs - atMs;
  if (into < crossfadeMs) return into / crossfadeMs;
  if (remaining < crossfadeMs) return remaining / crossfadeMs;
  return 1;
}

/**
 * The previous renderer, reproduced exactly: unity vocal and bed, every donor
 * stem from timeline frame 0 at 0.6 gain, hard clamp at full scale.
 */
function renderLegacyComposition(
  plan: MashupPlan,
  input: {
    vocals: Float32Array;
    bed: Float32Array;
    donorStems: Map<string, Float32Array>;
    layerStemTypes: readonly string[];
    /**
     * The legacy renderer clamped at full scale. Variant A must keep that
     * (it is the historical behaviour), but variant C feeds the *same*
     * composition into the corrected mix bus, and the bus needs the sum
     * before clamping — otherwise the clamp is baked in and the mix fix is
     * not isolated.
     */
    clamp?: boolean;
  },
): Float32Array {
  const totalFrames = Math.max(1, Math.round((plan.durationMs / 1000) * RATE));
  const out = new Float32Array(totalFrames * 2);
  const prepared = plan.segments.map((segment) => {
    const fromFrame = Math.max(0, Math.round((segment.vocalsFromMs / 1000) * RATE) * 2);
    const toFrame = Math.min(input.vocals.length, Math.max(fromFrame, Math.round((segment.vocalsToMs / 1000) * RATE) * 2));
    const span = input.vocals.slice(fromFrame, toFrame);
    if (span.length === 0) return { segment, pcm: new Float32Array(0) };
    let stretched: Float32Array;
    if (segment.localTempoMap) {
      const inputFrames = span.length / 2;
      const outputFrames = Math.max(1, Math.round((segment.localTempoMap.points.at(-1)!.outputMs / 1000) * RATE));
      const timeMap: TimeStretchMapPoint[] = segment.localTempoMap.points.map((point) => ({
        outputFrame: Math.round((point.outputMs / 1000) * RATE),
        inputFrame: Math.round((point.sourceMs / 1000) * RATE),
      }));
      timeMap[0] = { outputFrame: 0, inputFrame: 0 };
      timeMap[timeMap.length - 1] = { outputFrame: outputFrames, inputFrame: inputFrames };
      stretched = timeStretch(span, outputFrames / inputFrames, RATE, timeMap);
    } else {
      stretched = timeStretch(span, plan.vocalsStretchRatio, RATE);
    }
    return { segment, pcm: pitchShift(stretched, plan.vocalsPitchSemitones, RATE) };
  });

  // Legacy composition: every donor stem, from frame 0, no request needed.
  const legacyStems: Float32Array[] = [];
  for (const [, buffer] of input.donorStems) {
    const stretched = Math.abs(plan.vocalsStretchRatio - 1) > 1e-6
      ? timeStretch(buffer, plan.vocalsStretchRatio, RATE)
      : Float32Array.from(buffer);
    legacyStems.push(stretched);
  }

  const bedFrames = Math.min(totalFrames, Math.floor(input.bed.length / 2));
  for (let frame = 0; frame < totalFrames; frame += 1) {
    const atMs = (frame / RATE) * 1000;
    let duck = 0;
    for (const { segment } of prepared) {
      duck = Math.max(duck, trapezoidGain(atMs, segment.mashupStartMs, segment.mashupEndMs, CROSSFADE_MS));
    }
    const bedGain = 1 - DUCK_DEPTH * duck;
    let left = frame < bedFrames ? input.bed[frame * 2]! * bedGain : 0;
    let right = frame < bedFrames ? input.bed[frame * 2 + 1]! * bedGain : 0;
    for (const { segment, pcm } of prepared) {
      const gain = trapezoidGain(atMs, segment.mashupStartMs, segment.mashupEndMs, CROSSFADE_MS);
      if (gain <= 0) continue;
      const vocalFrame = Math.round(((atMs - segment.mashupStartMs) / 1000) * RATE);
      if (vocalFrame < 0 || vocalFrame * 2 + 1 >= pcm.length) continue;
      left += pcm[vocalFrame * 2]! * gain;
      right += pcm[vocalFrame * 2 + 1]! * gain;
    }
    for (const stem of legacyStems) {
      if (frame * 2 + 1 < stem.length) {
        const dynamicGain = LEGACY_DONOR_GAIN * (1 - DUCK_DEPTH * duck);
        left += stem[frame * 2]! * dynamicGain;
        right += stem[frame * 2 + 1]! * dynamicGain;
      }
    }
    if (input.clamp === false) {
      out[frame * 2] = left;
      out[frame * 2 + 1] = right;
    } else {
      out[frame * 2] = Math.max(-1, Math.min(1, left));
      out[frame * 2 + 1] = Math.max(-1, Math.min(1, right));
    }
  }
  return out;
}

/**
 * The corrected composition with the *old* mix: donor layers are opt-in and
 * offset to the vocal entry, but the sum is still at unity and clamped.
 */
function renderCorrectedCompositionOldMix(
  plan: MashupPlan,
  input: {
    vocals: Float32Array;
    bed: Float32Array;
    donorStems: Map<string, Float32Array>;
    layerStemTypes: readonly string[];
    clamp?: boolean;
  },
): Float32Array {
  const totalFrames = Math.max(1, Math.round((plan.durationMs / 1000) * RATE));
  const out = new Float32Array(totalFrames * 2);
  const prepared = plan.segments.map((segment) => {
    const fromFrame = Math.max(0, Math.round((segment.vocalsFromMs / 1000) * RATE) * 2);
    const toFrame = Math.min(input.vocals.length, Math.max(fromFrame, Math.round((segment.vocalsToMs / 1000) * RATE) * 2));
    const span = input.vocals.slice(fromFrame, toFrame);
    if (span.length === 0) return { segment, pcm: new Float32Array(0) };
    const stretched = timeStretch(span, plan.vocalsStretchRatio, RATE);
    return { segment, pcm: pitchShift(stretched, plan.vocalsPitchSemitones, RATE) };
  });
  const firstSegment = plan.segments[0];
  const offsetFrames = Math.max(0, Math.round(((firstSegment?.mashupStartMs ?? 0) / 1000) * RATE));
  const layers: Float32Array[] = [];
  for (const type of input.layerStemTypes) {
    const buffer = input.donorStems.get(type);
    if (!buffer) continue;
    layers.push(Math.abs(plan.vocalsStretchRatio - 1) > 1e-6
      ? timeStretch(buffer, plan.vocalsStretchRatio, RATE)
      : Float32Array.from(buffer));
  }
  const bedFrames = Math.min(totalFrames, Math.floor(input.bed.length / 2));
  for (let frame = 0; frame < totalFrames; frame += 1) {
    const atMs = (frame / RATE) * 1000;
    let duck = 0;
    for (const { segment } of prepared) {
      duck = Math.max(duck, trapezoidGain(atMs, segment.mashupStartMs, segment.mashupEndMs, CROSSFADE_MS));
    }
    const bedGain = 1 - DUCK_DEPTH * duck;
    let left = frame < bedFrames ? input.bed[frame * 2]! * bedGain : 0;
    let right = frame < bedFrames ? input.bed[frame * 2 + 1]! * bedGain : 0;
    for (const { segment, pcm } of prepared) {
      const gain = trapezoidGain(atMs, segment.mashupStartMs, segment.mashupEndMs, CROSSFADE_MS);
      if (gain <= 0) continue;
      const vocalFrame = Math.round(((atMs - segment.mashupStartMs) / 1000) * RATE);
      if (vocalFrame < 0 || vocalFrame * 2 + 1 >= pcm.length) continue;
      left += pcm[vocalFrame * 2]! * gain;
      right += pcm[vocalFrame * 2 + 1]! * gain;
    }
    for (const stem of layers) {
      const stemFrame = frame - offsetFrames;
      if (stemFrame < 0 || stemFrame * 2 + 1 >= stem.length) continue;
      const dynamicGain = LEGACY_DONOR_GAIN * (1 - DUCK_DEPTH * duck);
      left += stem[stemFrame * 2]! * dynamicGain;
      right += stem[stemFrame * 2 + 1]! * dynamicGain;
    }
    if (input.clamp === false) {
      out[frame * 2] = left;
      out[frame * 2 + 1] = right;
    } else {
      out[frame * 2] = Math.max(-1, Math.min(1, left));
      out[frame * 2 + 1] = Math.max(-1, Math.min(1, right));
    }
  }
  return out;
}

/** Loudness-match a finished render for fair A/B playback. */
function matchForListening(pcm: Float32Array, targetLufs: number | null): { pcm: Float32Array; gainDb: number | null } {
  const lufs = measureLoudness(pcm, RATE).integrated;
  if (lufs === null || targetLufs === null) return { pcm, gainDb: null };
  const gainDb = targetLufs - lufs;
  const gain = 10 ** (gainDb / 20);
  const out = new Float32Array(pcm.length);
  let peak = 0;
  for (let i = 0; i < pcm.length; i += 1) {
    out[i] = pcm[i]! * gain;
    peak = Math.max(peak, Math.abs(out[i]!));
  }
  // Never let the matched file clip: scale back and report it if it would.
  if (peak > 0.98) {
    const trim = 0.98 / peak;
    for (let i = 0; i < out.length; i += 1) out[i] *= trim;
    return { pcm: out, gainDb: gainDb + 20 * Math.log10(trim) };
  }
  return { pcm: out, gainDb };
}

function measure(pcm: Float32Array) {
  const presence = measurePresentLoudness(pcm, RATE);
  return {
    peakDb: Number((20 * Math.log10(Math.max(samplePeak(pcm), 1e-12))).toFixed(2)),
    truePeakDb: Number(truePeakDb(pcm, RATE).toFixed(2)),
    lufsIntegrated: (() => {
      const value = measureLoudness(pcm, RATE).integrated;
      return value === null ? null : Number(value.toFixed(2));
    })(),
    activeFraction: presence?.activeFraction ?? null,
    clippedRegions: clippedRegions(pcm, RATE).regions,
    clippedSamples: clippedRegions(pcm, RATE).clippedSamples,
    sha256: sha256(Buffer.from(new Uint8Array(pcm.buffer, pcm.byteOffset, pcm.byteLength))),
  };
}

function main() {
  const argv = process.argv.slice(2);
  const manifestIndex = argv.indexOf("--manifest");
  const outIndex = argv.indexOf("--out");
  if (manifestIndex === -1 || outIndex === -1 || !argv[manifestIndex + 1] || !argv[outIndex + 1]) {
    console.error("Usage: tsx scripts/waveyard-mashup-abcd.ts --manifest <manifest.json> --out <directory>");
    process.exit(2);
  }
  const manifestPath = resolve(argv[manifestIndex + 1]!);
  const outDir = resolve(argv[outIndex + 1]!);
  const root = dirname(manifestPath);
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as Manifest;

  const vocalsPcm = readWav(resolve(root, manifest.vocals.path));
  const bedPcm = readWav(resolve(root, manifest.bed.path));
  const donorStems = new Map<string, Float32Array>();
  for (const [type, path] of Object.entries(manifest.donorStems ?? {})) {
    donorStems.set(type, readWav(resolve(root, path)));
  }
  const layerStemTypes = manifest.layerStemTypes ?? [];

  const vocals = toProfile(manifest.vocals, "vocals", vocalsPcm);
  const bed = toProfile(manifest.bed, "instrumental", bedPcm);
  const planned = planMashup(vocals, bed, { strategy: manifest.strategy ?? "continuous" });
  if (!planned.ok) throw new Error(`The planner refused this pair: ${planned.reason}`);
  const plan = planned.plan;

  const variants = [
    {
      id: "A-baseline",
      title: "A — baseline (old composition + old mix)",
      composition: "legacy",
      mix: "legacy",
      pcm: renderLegacyComposition(plan, { vocals: vocalsPcm, bed: bedPcm, donorStems, layerStemTypes }),
      mixReport: null as null | ReturnType<typeof finishMashupMix>,
      balance: null as ReturnType<typeof planMashupBalance> | null,
    },
    {
      id: "B-composition-only",
      title: "B — corrected composition, old mix",
      composition: "corrected",
      mix: "legacy",
      pcm: renderCorrectedCompositionOldMix(plan, { vocals: vocalsPcm, bed: bedPcm, donorStems, layerStemTypes }),
      mixReport: null as null | ReturnType<typeof finishMashupMix>,
      balance: null as ReturnType<typeof planMashupBalance> | null,
    },
    {
      id: "C-mix-only",
      title: "C — old composition, corrected mix",
      composition: "legacy",
      mix: "corrected",
      pcm: null as Float32Array | null,
      mixReport: null as null | ReturnType<typeof finishMashupMix>,
      balance: null as ReturnType<typeof planMashupBalance> | null,
    },
    {
      id: "D-both",
      title: "D — corrected composition + corrected mix",
      composition: "corrected",
      mix: "corrected",
      pcm: null as Float32Array | null,
      mixReport: null as null | ReturnType<typeof finishMashupMix>,
      balance: null as ReturnType<typeof planMashupBalance> | null,
    },
  ];

  // The mix bus only exists once: C and D go through the real production path
  // by asking the renderer for the corrected composition and re-running the
  // legacy composition through the same bus.
  for (const variant of variants) {
    if (variant.mix !== "corrected") continue;
    // Unclamped on purpose: the corrected bus must receive the real sum so it
    // can attenuate an overshoot instead of inheriting a clamp.
    const summed = variant.composition === "legacy"
      ? renderLegacyComposition(plan, { vocals: vocalsPcm, bed: bedPcm, donorStems, layerStemTypes, clamp: false })
      : renderCorrectedCompositionOldMix(plan, { vocals: vocalsPcm, bed: bedPcm, donorStems, layerStemTypes, clamp: false });
    const finished = finishMashupMix({ summed, sampleRate: RATE });
    variant.pcm = finished.pcm;
    variant.mixReport = finished;
    variant.balance = planMashupBalance({ vocals: vocalsPcm, bed: bedPcm, sampleRate: RATE });
  }

  const finishedVariants = variants.filter((variant) => variant.pcm !== null) as Array<
    typeof variants[number] & { pcm: Float32Array }
  >;
  const targetLufs = Math.max(...finishedVariants.map((variant) => measureLoudness(variant.pcm, RATE).integrated ?? -Infinity));

  mkdirSync(outDir, { recursive: true });
  const report = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    manifest: {
      path: manifestPath,
      sha256: sha256(readFileSync(manifestPath)),
      vocals: { ...manifest.vocals, sha256: sha256(readFileSync(resolve(root, manifest.vocals.path))) },
      bed: { ...manifest.bed, sha256: sha256(readFileSync(resolve(root, manifest.bed.path))) },
      donorStems: Object.fromEntries(Object.entries(manifest.donorStems ?? {}).map(([type, path]) => [
        type,
        { path, sha256: sha256(readFileSync(resolve(root, path))) },
      ])),
      layerStemTypes,
      strategy: plan.alignmentStrategy,
    },
    plan: {
      planner: plan.engine,
      alignmentStrategy: plan.alignmentStrategy,
      masterBpm: plan.masterBpm,
      vocalsStretchRatio: plan.vocalsStretchRatio,
      vocalsPitchSemitones: plan.vocalsPitchSemitones,
      keyRelationship: plan.keyRelationship,
      segments: plan.segments.map((segment) => ({
        mashupStartMs: segment.mashupStartMs,
        mashupEndMs: segment.mashupEndMs,
        vocalsFromMs: segment.vocalsFromMs,
        vocalsToMs: segment.vocalsToMs,
        hasLocalTempoMap: Boolean(segment.localTempoMap),
      })),
      warnings: plan.warnings,
    },
    variants: finishedVariants.map((variant) => {
      const file = `${variant.id}.wav`;
      const matched = matchForListening(variant.pcm, targetLufs);
      writeFileSync(join(outDir, file), new Uint8Array(encodeWav16(matched.pcm, RATE)));
      const raw = measure(variant.pcm);
      return {
        id: variant.id,
        title: variant.title,
        composition: variant.composition,
        mix: variant.mix,
        file,
        rawRender: raw,
        listeningFile: {
          file,
          matchedToLufs: targetLufs === null ? null : Number(targetLufs.toFixed(2)),
          matchGainDb: matched.gainDb === null ? null : Number(matched.gainDb.toFixed(2)),
          measuredAfterMatch: measure(matched.pcm),
        },
        mixBus: variant.mixReport === null ? null : {
          balance: variant.balance,
          staticGainDb: variant.mixReport.staticGainDb,
          preLimit: variant.mixReport.preLimit,
          postLimit: variant.mixReport.postLimit,
          postTruePeakMeasured: variant.mixReport.postTruePeakMeasured,
          limiter: variant.mixReport.limiter,
        },
      };
    }),
    listeningInstruction: [
      "Each variant is written twice-worth of information but only one file: the WAV on disk is already loudness-matched to the loudest variant, and `matchGainDb` records the adjustment.",
      "Listen blind if possible: the report maps files to variants, so a listener should be given only the WAVs.",
      "A/B/C/D answer two separate questions. B vs A isolates composition. C vs A isolates the mix bus. D is the combination.",
      "This harness scores nothing. Listener count remains 0 until responses exist.",
    ],
    evidenceLimits: [
      "The legacy path is a faithful re-implementation of the previous renderer kept here for comparison; it is not the shipping code.",
      "Level matching is applied for fair playback only and is not a quality judgement.",
      "One song pair cannot establish a general improvement.",
      "No listening has occurred: these are rendered files and measurements.",
    ],
  };
  writeFileSync(join(outDir, "abcd-report.json"), `${JSON.stringify(report, null, 2)}\n`);
  console.log(`wrote ${join(outDir, "abcd-report.json")}`);
  for (const variant of report.variants) {
    console.log(
      variant.id.padEnd(22),
      `peak ${variant.rawRender.peakDb.toFixed(2)} dB`.padEnd(18),
      `LUFS ${String(variant.rawRender.lufsIntegrated ?? "n/a").padStart(6)}`.padEnd(14),
      `match ${String(variant.listeningFile.matchGainDb ?? "n/a").padStart(6)} dB`,
    );
  }
  console.log("\nListener count: 0. These files have not been judged.");
}

main();
