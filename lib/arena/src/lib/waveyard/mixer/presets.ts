/**
 * Real channel/master presets — parameter recipes only, applied
 * transactionally to a channel's insert chain (never baked into audio).
 */

import {
  addInsert,
  makeInsert,
  type InsertProcessorId,
} from "./inserts";
import {
  findChannel,
  updateChannel,
  type StemInput,
  type SourceInput,
} from "./state";
import type { MixerState } from "./types";

export type MixPresetId =
  | "vocal-clarity"
  | "drum-punch"
  | "bass-control"
  | "master-clean"
  | "lo-fi"
  | "wide-mono-safe"
  | "vocal-cleanup";

type PresetSpec = {
  label: string;
  description: string;
  /** Insert chain recipes in order. */
  chain: Array<{ processor: InsertProcessorId; params: Record<string, number> }>;
  /** Applied to the channel strip itself. */
  strip?: { trimDb?: number; pan?: number };
  /** Suggested channel kinds this preset makes sense on. */
  suggestedKinds: Array<"source" | "stem" | "bus" | "master">;
};

export const MIX_PRESETS: Record<MixPresetId, PresetSpec> = {
  "vocal-clarity": {
    label: "Vocal clarity",
    description: "High-pass rumble removal plus a presence lift around 3.5 kHz.",
    chain: [
      { processor: "highpass", params: { cutoffHz: 90, q: 0.7071 } },
      { processor: "eq-band", params: { freqHz: 3500, gainDb: 3, q: 0.9 } },
    ],
    suggestedKinds: ["stem"],
  },
  "vocal-cleanup": {
    label: "Vocal cleanup",
    description: "Tame sibilance and boxiness, then gentle leveling.",
    chain: [
      { processor: "highpass", params: { cutoffHz: 85, q: 0.7071 } },
      { processor: "eq-band", params: { freqHz: 250, gainDb: -2.5, q: 1.1 } },
      { processor: "eq-band", params: { freqHz: 6800, gainDb: -3, q: 4 } },
      { processor: "compressor", params: { thresholdDb: -22, ratio: 2.5, attackMs: 12, releaseMs: 180, makeupDb: 2 } },
    ],
    suggestedKinds: ["stem"],
  },
  "drum-punch": {
    label: "Drum punch",
    description: "Glue compression with a soft ceiling for punch without digital overs.",
    chain: [
      { processor: "compressor", params: { thresholdDb: -18, ratio: 3, attackMs: 10, releaseMs: 120, makeupDb: 3 } },
      { processor: "softclip", params: { ceilingDb: -3 } },
    ],
    suggestedKinds: ["stem", "bus"],
  },
  "bass-control": {
    label: "Bass control",
    description: "Sub rumble filter plus slow compression for a steady low end.",
    chain: [
      { processor: "highpass", params: { cutoffHz: 30, q: 0.7071 } },
      { processor: "compressor", params: { thresholdDb: -24, ratio: 4, attackMs: 20, releaseMs: 250, makeupDb: 1.5 } },
    ],
    suggestedKinds: ["stem"],
  },
  "master-clean": {
    label: "Master clean",
    description: "Remove sub rumble and protect the ceiling. Transparent.",
    chain: [
      { processor: "highpass", params: { cutoffHz: 25, q: 0.7071 } },
      { processor: "softclip", params: { ceilingDb: -0.3 } },
    ],
    suggestedKinds: ["master", "bus"],
  },
  "lo-fi": {
    label: "Lo-fi",
    description: "Band-limited, saturated character.",
    chain: [
      { processor: "lowpass", params: { cutoffHz: 6000, q: 0.7071 } },
      { processor: "saturator", params: { drive: 3 } },
    ],
    suggestedKinds: ["stem", "bus", "master"],
  },
  "wide-mono-safe": {
    label: "Wide, mono-safe",
    description: "Moderate widening that keeps the mid intact.",
    chain: [
      { processor: "width", params: { width: 0.35 } },
    ],
    suggestedKinds: ["bus", "master"],
  },
};

/** Apply a preset to a channel — replaces its insert chain (returns a new state). */
export function applyMixPreset(
  state: MixerState,
  channelId: string,
  presetId: MixPresetId,
): { state: MixerState; error?: string } {
  const preset = MIX_PRESETS[presetId];
  const strip = findChannel(state, channelId);
  if (preset === undefined) return { state, error: "unknown preset" };
  if (strip === undefined) return { state, error: "unknown channel" };
  let chain = strip.inserts as import("./inserts").InsertChain;
  for (const step of preset.chain) {
    const insert = makeInsert(step.processor, step.params);
    if (insert === null) return { state, error: `invalid preset step: ${step.processor}` };
    chain = addInsert(chain, insert);
  }
  return {
    state: updateChannel(state, channelId, {
      inserts: chain,
      ...(preset.strip ?? {}),
    }),
  };
}

/** Preset catalog for UI (labels + descriptions, no hidden behavior). */
export function presetCatalog(): Array<{
  id: MixPresetId;
  label: string;
  description: string;
  suggestedKinds: PresetSpec["suggestedKinds"];
}> {
  return Object.entries(MIX_PRESETS).map(([id, preset]) => ({
    id: id as MixPresetId,
    label: preset.label,
    description: preset.description,
    suggestedKinds: preset.suggestedKinds,
  }));
}

export type { StemInput, SourceInput };
