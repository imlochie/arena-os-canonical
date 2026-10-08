/**
 * Waveyard insert chain — real processors, real parameters.
 *
 * Every processor id in the registry maps to a DSP kernel in dsp.ts.
 * There are no decorative plugins: if a processor is listed here it
 * processes audio; if a backend doesn't exist for an operation, the
 * operation simply isn't in the registry.
 *
 * Chains are plain serializable data (waveyard-inserts-v1), reorderable,
 * bypassable, removable, and versioned. This module is the offline/bounce
 * path and the validation authority; the live Web Audio transport applies
 * the same chain shape through native nodes (later phase) so preview and
 * render agree by construction.
 */

import { z } from "zod";

import {
  applyBiquad,
  applyCompressor,
  applyDelay,
  applyGain,
  applyGate,
  applySaturation,
  applySoftClipCeiling,
  applyStereoWidth,
  designBiquad,
  dspDbToGain,
  mixDryWet,
  newBiquadState,
  type StereoBuffer,
} from "./dsp";
import { applyReverb } from "./reverb";
import { clamp } from "./types";

export const INSERTS_FORMAT = "waveyard-inserts-v1" as const;

export type InsertProcessorId =
  | "gain"
  | "highpass"
  | "lowpass"
  | "eq-band"
  | "notch"
  | "compressor"
  | "gate"
  | "saturator"
  | "softclip"
  | "width"
  | "delay"
  | "reverb"
  | "plate-reverb";

export type ParamRange = { min: number; max: number; default: number };

export const INSERT_PARAM_RANGES: Record<
  InsertProcessorId,
  Record<string, ParamRange>
> = {
  gain: { gainDb: { min: -24, max: 24, default: 0 } },
  highpass: {
    cutoffHz: { min: 20, max: 500, default: 80 },
    q: { min: 0.1, max: 4, default: 0.7071 },
  },
  lowpass: {
    cutoffHz: { min: 500, max: 20000, default: 12000 },
    q: { min: 0.1, max: 4, default: 0.7071 },
  },
  "eq-band": {
    freqHz: { min: 40, max: 16000, default: 1000 },
    gainDb: { min: -18, max: 18, default: 0 },
    q: { min: 0.1, max: 8, default: 1 },
  },
  notch: {
    freqHz: { min: 30, max: 8000, default: 60 },
    q: { min: 2, max: 30, default: 12 },
  },
  compressor: {
    thresholdDb: { min: -60, max: 0, default: -24 },
    ratio: { min: 1, max: 20, default: 3 },
    attackMs: { min: 0.1, max: 200, default: 10 },
    releaseMs: { min: 5, max: 2000, default: 150 },
    makeupDb: { min: -12, max: 24, default: 0 },
  },
  gate: {
    thresholdDb: { min: -90, max: 0, default: -50 },
    attackMs: { min: 0.1, max: 100, default: 1 },
    releaseMs: { min: 5, max: 2000, default: 120 },
    holdMs: { min: 0, max: 2000, default: 50 },
  },
  saturator: { drive: { min: 0.1, max: 20, default: 2 } },
  softclip: { ceilingDb: { min: -24, max: 0, default: -1 } },
  width: { width: { min: 0, max: 4, default: 1 } },
  delay: {
    delayMs: { min: 1, max: 2000, default: 250 },
    feedback: { min: 0, max: 0.95, default: 0.3 },
    mix: { min: 0, max: 1, default: 0.25 },
  },
  reverb: {
    predelayMs: { min: 0, max: 250, default: 10 },
    decaySeconds: { min: 0.1, max: 20, default: 1.2 },
    sizePercent: { min: 0, max: 100, default: 50 },
    dampingHz: { min: 1000, max: 20000, default: 6000 },
    diffusionPercent: { min: 0, max: 100, default: 70 },
    widthPercent: { min: 0, max: 100, default: 100 },
    lowCutHz: { min: 20, max: 1000, default: 20 },
    mix: { min: 0, max: 1, default: 0.25 },
  },
  "plate-reverb": {
    predelayMs: { min: 0, max: 250, default: 20 },
    decaySeconds: { min: 0.1, max: 20, default: 2.5 },
    sizePercent: { min: 0, max: 100, default: 50 },
    dampingHz: { min: 1000, max: 20000, default: 10000 },
    diffusionPercent: { min: 0, max: 100, default: 85 },
    widthPercent: { min: 0, max: 100, default: 100 },
    lowCutHz: { min: 20, max: 1000, default: 20 },
    mix: { min: 0, max: 1, default: 0.3 },
  },
};

export const INSERT_PROCESSOR_LABELS: Record<InsertProcessorId, string> = {
  gain: "Gain",
  highpass: "High-pass",
  lowpass: "Low-pass",
  "eq-band": "EQ band",
  notch: "Notch (de-hum)",
  compressor: "Compressor",
  gate: "Gate",
  saturator: "Saturation",
  softclip: "Soft clip",
  width: "Stereo width",
  delay: "Delay",
  reverb: "Reverb (room)",
  "plate-reverb": "Reverb (plate)",
};

export type Insert = {
  id: string;
  processor: InsertProcessorId;
  enabled: boolean;
  /** Dry/wet 0..1 (1 = fully processed). */
  wet: number;
  params: Record<string, number>;
};

export type InsertChain = Insert[];

// ---------------------------------------------------------------------------
// Validation (clamp numeric params into declared ranges)
// ---------------------------------------------------------------------------

export type ParamValidation = {
  params: Record<string, number>;
  clamped: string[];
  invalid: string[];
};

export function validateInsertParams(
  processor: string,
  raw: unknown,
): ParamValidation | null {
  const ranges = INSERT_PARAM_RANGES[processor as InsertProcessorId];
  if (ranges === undefined) return null;
  if (raw === null || typeof raw !== "object" || Array.isArray(raw))
    return null;
  const params: Record<string, number> = {};
  const clamped: string[] = [];
  const invalid: string[] = [];
  const input = raw as Record<string, unknown>;

  const seen = new Set<string>();
  for (const [key, value] of Object.entries(input)) {
    const range = ranges[key];
    if (range === undefined) {
      invalid.push(key);
      continue;
    }
    if (typeof value !== "number" || !Number.isFinite(value)) {
      invalid.push(key);
      continue;
    }
    seen.add(key);
    const bounded = clamp(value, range.min, range.max);
    if (bounded !== value) clamped.push(key);
    params[key] = bounded;
  }
  for (const [key, range] of Object.entries(ranges)) {
    if (!seen.has(key)) params[key] = range.default;
  }
  if (invalid.length > 0) return null;
  return { params, clamped, invalid };
}

// ---------------------------------------------------------------------------
// Chain operations (pure)
// ---------------------------------------------------------------------------

let insertCounter = 0;
export function newInsertId(): string {
  insertCounter += 1;
  return `ins-${Date.now().toString(36)}-${insertCounter}`;
}

export function makeInsert(
  processor: InsertProcessorId,
  params: Record<string, number> = {},
  options: { enabled?: boolean; wet?: number; id?: string } = {},
): Insert | null {
  const validation = validateInsertParams(processor, params);
  if (validation === null) return null;
  return {
    id: options.id ?? newInsertId(),
    processor,
    enabled: options.enabled ?? true,
    wet: clamp(options.wet ?? 1, 0, 1),
    params: validation.params,
  };
}

export function addInsert(chain: InsertChain, insert: Insert): InsertChain {
  return [...chain, insert];
}

export function removeInsert(chain: InsertChain, insertId: string): InsertChain {
  return chain.filter((insert) => insert.id !== insertId);
}

export function moveInsert(
  chain: InsertChain,
  fromIndex: number,
  toIndex: number,
): InsertChain {
  if (fromIndex < 0 || fromIndex >= chain.length) return chain;
  const target = clamp(toIndex, 0, chain.length - 1);
  if (target === fromIndex) return chain;
  const next = [...chain];
  const [moved] = next.splice(fromIndex, 1);
  next.splice(target, 0, moved);
  return next;
}

export function toggleInsert(chain: InsertChain, insertId: string): InsertChain {
  return chain.map((insert) =>
    insert.id === insertId ? { ...insert, enabled: !insert.enabled } : insert,
  );
}

// ---------------------------------------------------------------------------
// Serialization
// ---------------------------------------------------------------------------

const InsertSchema = z.object({
  id: z.string().min(1),
  processor: z.string().min(1),
  enabled: z.boolean(),
  wet: z.number().min(0).max(1),
  params: z.record(z.string(), z.number()),
});

export function serializeInserts(chain: readonly MinimalInsertLike[]): string {
  return JSON.stringify({ format: INSERTS_FORMAT, inserts: chain });
}

/** Structural shape accepted by serializeInserts (parse revalidates on read). */
export type MinimalInsertLike = {
  id: string;
  processor: string;
  enabled: boolean;
  wet: number;
  params: Record<string, number>;
};

export function parseInserts(raw: unknown): InsertChain | null {
  if (raw === null || typeof raw !== "object") return null;
  const parsed = z
    .object({ format: z.literal(INSERTS_FORMAT), inserts: z.array(InsertSchema) })
    .safeParse(raw);
  if (!parsed.success) return null;
  const chain: InsertChain = [];
  for (const insert of parsed.data.inserts) {
    const validation = validateInsertParams(insert.processor, insert.params);
    if (validation === null) return null;
    chain.push({
      id: insert.id,
      processor: insert.processor as InsertProcessorId,
      enabled: insert.enabled,
      wet: insert.wet,
      params: validation.params,
    });
  }
  return chain;
}

// ---------------------------------------------------------------------------
// Processing
// ---------------------------------------------------------------------------

/**
 * Run a chain over a buffer. In-place kernels mutate `buffer`; delay
 * returns a new buffer. Callers that need the original untouched pass a
 * copy. Disabled inserts are skipped; wet < 1 mixes dry back in.
 */
export function processWithChain(
  buffer: StereoBuffer,
  chain: InsertChain,
  sampleRate: number,
): StereoBuffer {
  let current = buffer;
  for (const insert of chain) {
    if (!insert.enabled) continue;
    if (insert.wet < 1) {
      let dry = Float32Array.from(current);
      const processed = runProcessor(current, insert, sampleRate);
      // Processors may return a LONGER buffer (reverb tail); the dry copy is
      // zero-padded so the tail survives the dry/wet mix instead of being
      // truncated at the original input length.
      if (processed.length > dry.length) {
        const padded = new Float32Array(processed.length);
        padded.set(dry);
        dry = padded;
      }
      mixDryWet(dry, processed, insert.wet);
      current = dry;
    } else {
      current = runProcessor(current, insert, sampleRate);
    }
  }
  return current;
}

function runProcessor(
  buffer: StereoBuffer,
  insert: Insert,
  sampleRate: number,
): StereoBuffer {
  const p = insert.params;
  switch (insert.processor) {
    case "gain":
      applyGain(buffer, dspDbToGain(p.gainDb));
      return buffer;
    case "highpass":
      applyBiquad(
        buffer,
        designBiquad({ type: "highpass", freqHz: p.cutoffHz, q: p.q }, sampleRate),
        newBiquadState(),
        newBiquadState(),
      );
      return buffer;
    case "lowpass":
      applyBiquad(
        buffer,
        designBiquad({ type: "lowpass", freqHz: p.cutoffHz, q: p.q }, sampleRate),
        newBiquadState(),
        newBiquadState(),
      );
      return buffer;
    case "eq-band":
      applyBiquad(
        buffer,
        designBiquad({ type: "peaking", freqHz: p.freqHz, gainDb: p.gainDb, q: p.q }, sampleRate),
        newBiquadState(),
        newBiquadState(),
      );
      return buffer;
    case "notch":
      applyBiquad(
        buffer,
        designBiquad({ type: "notch", freqHz: p.freqHz, q: p.q }, sampleRate),
        newBiquadState(),
        newBiquadState(),
      );
      return buffer;
    case "compressor":
      applyCompressor(buffer, {
        thresholdDb: p.thresholdDb,
        ratio: p.ratio,
        attackMs: p.attackMs,
        releaseMs: p.releaseMs,
        makeupDb: p.makeupDb,
        sampleRate,
      });
      return buffer;
    case "gate":
      applyGate(buffer, {
        thresholdDb: p.thresholdDb,
        attackMs: p.attackMs,
        releaseMs: p.releaseMs,
        holdMs: p.holdMs,
        sampleRate,
      });
      return buffer;
    case "saturator":
      applySaturation(buffer, p.drive);
      return buffer;
    case "softclip":
      applySoftClipCeiling(buffer, p.ceilingDb);
      return buffer;
    case "width":
      applyStereoWidth(buffer, p.width);
      return buffer;
    case "delay":
      return applyDelay(buffer, {
        delayMs: p.delayMs,
        feedback: p.feedback,
        mix: p.mix,
        sampleRate,
      });
    case "reverb":
    case "plate-reverb":
      return applyReverb(buffer, {
        model: insert.processor === "plate-reverb" ? "plate" : "room",
        predelayMs: p.predelayMs,
        decaySeconds: p.decaySeconds,
        sizePercent: p.sizePercent,
        dampingHz: p.dampingHz,
        diffusionPercent: p.diffusionPercent,
        widthPercent: p.widthPercent,
        lowCutHz: p.lowCutHz,
        mix: p.mix,
        sampleRate,
      });
  }
}
