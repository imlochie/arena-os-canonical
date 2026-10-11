/**
 * Analysis packet — the authoritative evidence bundle sent to AI models
 * in audio-derived mode. Built exclusively from real measurements (and,
 * when present, real analysis-table data). Every value in here is
 * measured; the packet schema records its own basis so a consumer can
 * never mistake it for raw audio.
 */

import { z } from "zod";

import type { AudioMeasurements } from "../mixer/meters";
import type { StereoBuffer } from "../mixer/dsp";
import { bandRmsDb, measureAudio } from "../mixer/meters";

export const ANALYSIS_PACKET_FORMAT = "waveyard-analysis-packet-v1" as const;

export type PacketTargetKind = "source" | "stem" | "mix" | "region";

export type PacketBandSet = {
  sub: number;
  low: number;
  lowMid: number;
  mid: number;
  highMid: number;
  high: number;
  air: number;
};

export type PacketMusical = {
  tempoBpm?: number;
  key?: string;
  sections?: Array<{ name: string; startMs: number; endMs: number }>;
};

export type PacketStem = {
  id: string;
  type: string;
  name?: string;
};

export type AnalysisPacket = {
  format: typeof ANALYSIS_PACKET_FORMAT;
  basis: "audio-derived";
  generatedAt: string;
  target: {
    kind: PacketTargetKind;
    name?: string;
    selection?: { startMs: number; endMs: number };
  };
  measurements: AudioMeasurements;
  spectral: PacketBandSet;
  musical?: PacketMusical;
  stems?: PacketStem[];
  /** Observed facts stated in words — all directly from measurements. */
  observations: string[];
};

export type PacketInput = {
  target: { kind: PacketTargetKind; name?: string; selection?: { startMs: number; endMs: number } };
  pcm: StereoBuffer;
  sampleRate: number;
  measurements?: AudioMeasurements;
  musical?: PacketMusical;
  stems?: PacketStem[];
  now?: () => string;
};

export function buildAnalysisPacket(input: PacketInput): AnalysisPacket {
  const { pcm, sampleRate } = input;
  const measurements = input.measurements ?? measureAudio(pcm, sampleRate);

  const overallRms = measurements.rmsDb;
  const airTop = Math.min(18000, sampleRate / 2 * 0.95);
  const spectral: PacketBandSet = {
    sub: round2(bandRmsDb(pcm, sampleRate, 20, 60) - overallRms),
    low: round2(bandRmsDb(pcm, sampleRate, 60, 120) - overallRms),
    lowMid: round2(bandRmsDb(pcm, sampleRate, 120, 350) - overallRms),
    mid: round2(bandRmsDb(pcm, sampleRate, 350, 2000) - overallRms),
    highMid: round2(bandRmsDb(pcm, sampleRate, 2000, 6000) - overallRms),
    high: round2(bandRmsDb(pcm, sampleRate, 6000, 12000) - overallRms),
    air: round2(bandRmsDb(pcm, sampleRate, 12000, airTop) - overallRms),
  };

  const observations: string[] = [];
  observations.push(
    `integrated loudness ${measurements.lufsIntegrated === null ? "not measurable (silence)" : measurements.lufsIntegrated.toFixed(1) + " LUFS"}`,
  );
  observations.push(`sample peak ${measurements.peakDb.toFixed(2)} dBFS, true peak ${measurements.truePeakDb.toFixed(2)} dBFS, crest ${measurements.crestDb.toFixed(1)} dB`);
  if (measurements.clipped.regions > 0)
    observations.push(`${measurements.clipped.regions} clipped regions detected`);
  if (measurements.stereoCorrelation !== null)
    observations.push(`stereo correlation ${measurements.stereoCorrelation.toFixed(2)}`);
  const loudestBand = (Object.entries(spectral) as Array<[keyof PacketBandSet, number]>)
    .filter(([, value]) => Number.isFinite(value))
    .sort((left, right) => right[1] - left[1])[0];
  if (loudestBand !== undefined)
    observations.push(`most prominent band: ${loudestBand[0]} (${loudestBand[1].toFixed(1)} dB relative)`);
  if (input.musical?.tempoBpm !== undefined)
    observations.push(`tempo ${input.musical.tempoBpm} BPM`);
  if (input.musical?.key !== undefined)
    observations.push(`musical key ${input.musical.key}`);
  if (input.stems !== undefined && input.stems.length > 0)
    observations.push(`${input.stems.length} stems available: ${input.stems.map((stem) => stem.type).join(", ")}`);

  return {
    format: ANALYSIS_PACKET_FORMAT,
    basis: "audio-derived",
    generatedAt: (input.now ?? (() => new Date().toISOString()))(),
    target: input.target,
    measurements,
    spectral,
    musical: input.musical,
    stems: input.stems,
    observations,
  };
}

function round2(value: number): number {
  return Number.isFinite(value) ? Number(value.toFixed(2)) : value;
}


/** Zod schema for validating packets that arrive from elsewhere. */
export const AnalysisPacketSchema = z.object({
  format: z.literal(ANALYSIS_PACKET_FORMAT),
  basis: z.literal("audio-derived"),
  generatedAt: z.string(),
  target: z.object({
    kind: z.enum(["source", "stem", "mix", "region"]),
    name: z.string().optional(),
    selection: z.object({ startMs: z.number(), endMs: z.number() }).optional(),
  }),
  measurements: z.any(),
  spectral: z.any(),
  musical: z.any().optional(),
  stems: z.array(z.object({ id: z.string(), type: z.string(), name: z.string().optional() })).optional(),
  observations: z.array(z.string()),
});
