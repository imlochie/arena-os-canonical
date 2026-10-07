/**
 * Procedural sound design — real synthesis from the existing engine.
 *
 * Every kind is a deterministic recipe: note events for the synth engine +
 * a post-render insert chain of REAL processors (+ two sample-level
 * transforms, reverse and stutter, implemented directly). No neural SFX
 * generator is claimed or faked. Output is a WAV buffer the caller stores;
 * the recipe JSON travels with the asset as provenance.
 */

import {
  renderNotes,
  midiToHz,
  type NoteEvent,
  type SynthInstrument,
} from "../mixer/synth";
import {
  processWithChain,
  type Insert,
} from "../mixer/inserts";
import { encodeWav16 } from "../mixer/synth";

export const SOUND_DESIGN_FORMAT = "waveyard-sound-design-v1" as const;

export const SOUND_DESIGN_KINDS = [
  "impact",
  "riser",
  "downlifter",
  "sweep",
  "drone",
  "texture",
  "sub",
  "tonal",
  "transition",
  "reverse",
  "stutter",
] as const;

export type SoundDesignKind = (typeof SOUND_DESIGN_KINDS)[number];

export type SoundDesignParams = {
  /** Render length in seconds (bounded). */
  lengthSeconds: number;
  /** Base MIDI note (bounded). */
  baseMidi: number;
  /** Output level 0.05–1. */
  level: number;
};

export const SOUND_DESIGN_PARAM_RANGES = {
  lengthSeconds: { min: 0.5, max: 16, default: 4 },
  baseMidi: { min: 24, max: 96, default: 45 },
  level: { min: 0.05, max: 1, default: 0.7 },
} as const;

export type SoundDesignRecipe = {
  format: typeof SOUND_DESIGN_FORMAT;
  kind: SoundDesignKind;
  params: SoundDesignParams;
  instrument: SynthInstrument;
  events: NoteEvent[];
  chain: Array<Pick<Insert, "processor" | "params">>;
  transform: "none" | "reverse" | "stutter";
};

export function isSoundDesignKind(value: unknown): value is SoundDesignKind {
  return typeof value === "string" && (SOUND_DESIGN_KINDS as readonly string[]).includes(value);
}

export function normaliseSoundDesignParams(raw: unknown): SoundDesignParams | null {
  if (raw === undefined) raw = {};
  if (raw === null || typeof raw !== "object") return null;
  const input = raw as Record<string, unknown>;
  const clampParam = (value: unknown, range: { min: number; max: number }) => {
    const numeric = Number(value);
    if (!Number.isFinite(numeric)) return null;
    return Math.min(range.max, Math.max(range.min, numeric));
  };
  const lengthSeconds = clampParam(input.lengthSeconds ?? SOUND_DESIGN_PARAM_RANGES.lengthSeconds.default, SOUND_DESIGN_PARAM_RANGES.lengthSeconds);
  const baseMidi = clampParam(input.baseMidi ?? SOUND_DESIGN_PARAM_RANGES.baseMidi.default, SOUND_DESIGN_PARAM_RANGES.baseMidi);
  const level = clampParam(input.level ?? SOUND_DESIGN_PARAM_RANGES.level.default, SOUND_DESIGN_PARAM_RANGES.level);
  if (lengthSeconds === null || baseMidi === null || level === null) return null;
  return { lengthSeconds, baseMidi: Math.round(baseMidi), level };
}

const FS = 44100;

/** Build the deterministic recipe for a kind. */
export function buildRecipe(kind: SoundDesignKind, params: SoundDesignParams): SoundDesignRecipe {
  const { lengthSeconds, baseMidi, level } = params;
  const events: NoteEvent[] = [];
  let instrument: SynthInstrument = "pluck";
  let chain: Array<Pick<Insert, "processor" | "params">> = [];
  let transform: SoundDesignRecipe["transform"] = "none";

  switch (kind) {
    case "impact": {
      instrument = "sub-bass";
      events.push({ startMs: 0, durationMs: Math.min(1200, lengthSeconds * 1000), midi: baseMidi, velocity: 1 });
      events.push({ startMs: 0, durationMs: 300, midi: baseMidi + 12, velocity: 0.6 });
      chain = [
        { processor: "softclip", params: { ceilingDb: -1 } },
        { processor: "lowpass", params: { cutoffHz: 220, q: 0.7071 } },
      ];
      break;
    }
    case "riser": {
      instrument = "strings";
      const steps = 16;
      for (let i = 0; i < steps; i += 1) {
        events.push({
          startMs: (lengthSeconds * 1000 * i) / steps,
          durationMs: (lengthSeconds * 1000) / steps + 60,
          midi: baseMidi + Math.round((i * 24) / steps),
          velocity: 0.35 + (0.6 * i) / steps,
        });
      }
      chain = [
        { processor: "saturator", params: { drive: 4 } },
        { processor: "delay", params: { delayMs: Math.max(1, Math.round((lengthSeconds * 1000) / 16)), feedback: 0.35, mix: 0.3 } },
      ];
      break;
    }
    case "downlifter": {
      instrument = "strings";
      const steps = 14;
      for (let i = 0; i < steps; i += 1) {
        events.push({
          startMs: (lengthSeconds * 1000 * i) / steps,
          durationMs: (lengthSeconds * 1000) / steps + 60,
          midi: baseMidi + Math.round(24 - (i * 24) / steps),
          velocity: 0.8 - (0.5 * i) / steps,
        });
      }
      chain = [{ processor: "lowpass", params: { cutoffHz: 3000, q: 0.7071 } }];
      break;
    }
    case "sweep": {
      instrument = "pad";
      events.push({ startMs: 0, durationMs: lengthSeconds * 1000, midi: baseMidi, velocity: 0.5 });
      chain = [
        { processor: "saturator", params: { drive: 2 } },
        { processor: "width", params: { width: 1.6 } },
      ];
      break;
    }
    case "drone": {
      instrument = "pad";
      events.push({ startMs: 0, durationMs: lengthSeconds * 1000, midi: baseMidi, velocity: 0.55 });
      events.push({ startMs: 0, durationMs: lengthSeconds * 1000, midi: baseMidi + 7, velocity: 0.4 });
      chain = [
        { processor: "lowpass", params: { cutoffHz: 1400, q: 0.7071 } },
        { processor: "width", params: { width: 1.3 } },
      ];
      break;
    }
    case "texture": {
      instrument = "choir";
      const cluster = [0, 3, 7, 10, 14];
      for (const offset of cluster) {
        events.push({ startMs: (offset * 137) % 400, durationMs: lengthSeconds * 1000, midi: baseMidi + offset, velocity: 0.3 });
      }
      chain = [
        { processor: "delay", params: { delayMs: 427, feedback: 0.45, mix: 0.4 } },
        { processor: "width", params: { width: 1.8 } },
      ];
      break;
    }
    case "sub": {
      instrument = "sub-bass";
      events.push({ startMs: 0, durationMs: lengthSeconds * 1000, midi: baseMidi, velocity: 0.9 });
      chain = [{ processor: "lowpass", params: { cutoffHz: 120, q: 0.7071 } }];
      break;
    }
    case "tonal": {
      instrument = "pluck";
      const pattern = [0, 7, 12, 7, 3, 10, 15, 10];
      const stepMs = Math.max(80, (lengthSeconds * 1000) / pattern.length);
      pattern.forEach((offset, index) => {
        events.push({ startMs: index * stepMs, durationMs: stepMs * 0.9, midi: baseMidi + offset, velocity: 0.7 });
      });
      chain = [{ processor: "delay", params: { delayMs: stepMs * 1.5, feedback: 0.3, mix: 0.25 } }];
      break;
    }
    case "transition": {
      instrument = "strings";
      const steps = 10;
      for (let i = 0; i < steps; i += 1) {
        events.push({
          startMs: (lengthSeconds * 1000 * i) / steps,
          durationMs: (lengthSeconds * 1000) / steps + 40,
          midi: baseMidi + Math.round((i * i * 18) / (steps * steps)),
          velocity: 0.3 + (0.65 * i) / steps,
        });
      }
      chain = [
        { processor: "saturator", params: { drive: 3 } },
        { processor: "softclip", params: { ceilingDb: -2 } },
      ];
      break;
    }
    case "reverse": {
      instrument = "pluck";
      const pattern = [0, 4, 7, 11, 14];
      const stepMs = Math.max(90, (lengthSeconds * 1000) / pattern.length);
      pattern.forEach((offset, index) => {
        events.push({ startMs: index * stepMs, durationMs: stepMs * 1.4, midi: baseMidi + offset, velocity: 0.65 });
      });
      chain = [{ processor: "eq-band", params: { freqHz: 3000, gainDb: 2, q: 0.8 } }];
      transform = "reverse";
      break;
    }
    case "stutter": {
      instrument = "pluck";
      events.push({ startMs: 0, durationMs: lengthSeconds * 1000, midi: baseMidi, velocity: 0.7 });
      events.push({ startMs: 0, durationMs: lengthSeconds * 1000, midi: baseMidi + 12, velocity: 0.4 });
      chain = [{ processor: "width", params: { width: 1.2 } }];
      transform = "stutter";
      break;
    }
  }

  return { format: SOUND_DESIGN_FORMAT, kind, params, instrument, events, chain, transform };
}

/** Render a recipe to a 16-bit stereo WAV buffer. Deterministic. */
export function renderRecipe(recipe: SoundDesignParams & { kind: SoundDesignKind }): {
  wav: Uint8Array;
  recipe: SoundDesignRecipe;
  durationSeconds: number;
  sampleRate: number;
} {
  const full = buildRecipe(recipe.kind, recipe);
  const pcm = renderNotes(full.events, full.instrument, FS, full.params.lengthSeconds, full.params.level);

  let buffer = pcm;
  if (full.transform === "reverse") buffer = reverseBuffer(buffer);
  if (full.transform === "stutter") buffer = stutterBuffer(buffer, 12);

  const chain: Insert[] = full.chain.map((stage, index) => ({
    id: `sd-${index}`,
    processor: stage.processor,
    enabled: true,
    wet: 1,
    params: stage.params,
  }));
  const processed = processWithChain(buffer, chain, FS);
  return {
    wav: encodeWav16(processed, FS),
    recipe: full,
    durationSeconds: full.params.lengthSeconds,
    sampleRate: FS,
  };
}

/** Sample-accurate time reverse (stereo interleaved). */
export function reverseBuffer(pcm: Float32Array): Float32Array {
  const out = new Float32Array(pcm.length);
  const frames = pcm.length / 2;
  for (let frame = 0; frame < frames; frame += 1) {
    const source = frames - 1 - frame;
    out[frame * 2] = pcm[source * 2];
    out[frame * 2 + 1] = pcm[source * 2 + 1];
  }
  return out;
}

/** Amplitude chopping — real gated stutter (hard zero segments). */
export function stutterBuffer(pcm: Float32Array, chopsPerSecond: number): Float32Array {
  const out = new Float32Array(pcm.length);
  const period = Math.max(2, Math.floor(FS / chopsPerSecond));
  for (let i = 0; i < pcm.length; i += 1) {
    const frame = Math.floor(i / 2);
    const phase = frame % period;
    const gate = phase < period / 2 ? 1 : 0;
    out[i] = pcm[i] * gate;
  }
  return out;
}

export function describeRecipe(recipe: SoundDesignRecipe): string {
  const hz = midiToHz(recipe.params.baseMidi).toFixed(1);
  const stages = recipe.chain.map((stage) => stage.processor).join(" → ");
  const base = `${recipe.kind} · ${recipe.instrument} · base ${hz} Hz · ${recipe.params.lengthSeconds}s · ${stages || "no chain"}`;
  if (recipe.transform === "reverse") return `${base} · time-reversed`;
  if (recipe.transform === "stutter") return `${base} · gated stutter`;
  return base;
}
