/**
 * Mixer state construction, serialization, and the legacy adapters that
 * keep the existing remix_tracks (volume/pan/muted/solo) and
 * remix_sessions.masterVolume columns working unchanged.
 */

import { z } from "zod";

import {
  MIXER_STATE_FORMAT,
  type ChannelKind,
  type ChannelStrip,
  type MixerState,
  FADER_DB_RANGE,
  PAN_RANGE,
  TRIM_DB_RANGE,
  clamp,
  isValidChannelStripShape,
} from "./types";
import {
  INSERT_PARAM_RANGES,
  parseInserts,
  type InsertChain,
  type InsertProcessorId,
} from "./inserts";
import { dbToGain, gainToDb } from "./gain";

export type StemInput = {
  id: string;
  name?: string;
  sourceAssetId?: string;
  stemType?: string;
};

export type SourceInput = { id: string; name?: string };

export const MASTER_CHANNEL_ID = "master";

export function defaultStrip(
  id: string,
  kind: ChannelKind,
  name: string,
  identity: { sourceAssetId?: string; stemAssetId?: string; stemType?: string } = {},
): ChannelStrip {
  return {
    id,
    kind,
    name,
    trimDb: 0,
    faderDb: 0,
    mutedInfinity: false,
    pan: 0,
    muted: false,
    solo: false,
    phaseInvert: false,
    monoMonitor: false,
    inserts: [],
    ...identity,
  };
}

export function createMixerState(input: {
  sources?: SourceInput[];
  stems?: StemInput[];
  masterName?: string;
}): MixerState {
  const channels: ChannelStrip[] = [];
  for (const source of input.sources ?? []) {
    channels.push(
      defaultStrip(`source:${source.id}`, "source", source.name ?? "Source", {
        sourceAssetId: source.id,
      }),
    );
  }
  for (const stem of input.stems ?? []) {
    channels.push(
      defaultStrip(
        `stem:${stem.id}`,
        "stem",
        stem.name ?? stem.stemType ?? "Stem",
        {
          stemAssetId: stem.id,
          sourceAssetId: stem.sourceAssetId,
          stemType: stem.stemType,
        },
      ),
    );
  }
  channels.push(defaultStrip(MASTER_CHANNEL_ID, "master", input.masterName ?? "Master"));
  return { format: MIXER_STATE_FORMAT, channels };
}

export function findChannel(state: MixerState, id: string): ChannelStrip | undefined {
  return state.channels.find((strip) => strip.id === id);
}

export function updateChannel(
  state: MixerState,
  id: string,
  patch: Partial<ChannelStrip>,
): MixerState {
  return {
    ...state,
    channels: state.channels.map((strip) =>
      strip.id === id ? { ...strip, ...patch } : strip,
    ),
  };
}

export function resetChannel(state: MixerState, id: string): MixerState {
  const strip = findChannel(state, id);
  if (strip === undefined) return state;
  const fresh = defaultStrip(strip.id, strip.kind, strip.name, {
    sourceAssetId: strip.sourceAssetId,
    stemAssetId: strip.stemAssetId,
    stemType: strip.stemType,
  });
  return {
    ...state,
    channels: state.channels.map((item) => (item.id === id ? fresh : item)),
  };
}

export function addBus(
  state: MixerState,
  input: { id?: string; name: string },
): { state: MixerState; busId: string } {
  const busId = input.id ?? `bus:${input.name.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`;
  if (findChannel(state, busId) !== undefined) return { state, busId };
  return {
    state: {
      ...state,
      channels: [
        ...state.channels.filter((strip) => strip.kind !== "master"),
        defaultStrip(busId, "bus", input.name),
        ...state.channels.filter((strip) => strip.kind === "master"),
      ],
    },
    busId,
  };
}

// ---------------------------------------------------------------------------
// Serialization — inserts are embedded and parsed through their own
// validated format so a mixer state is always safe to hydrate.
// ---------------------------------------------------------------------------

export function serializeMixerState(state: MixerState): string {
  return JSON.stringify(state);
}

const SerializedChannelSchema = z.object({
  id: z.string().min(1),
  kind: z.enum(["source", "stem", "bus", "master"]),
  name: z.string().min(1),
  trimDb: z.number(),
  faderDb: z.number(),
  mutedInfinity: z.boolean(),
  pan: z.number(),
  muted: z.boolean(),
  solo: z.boolean(),
  phaseInvert: z.boolean(),
  monoMonitor: z.boolean(),
  busId: z.string().optional(),
  inserts: z.array(z.record(z.string(), z.unknown())),
  sourceAssetId: z.string().optional(),
  stemAssetId: z.string().optional(),
  stemType: z.string().optional(),
});

export function parseMixerState(raw: unknown): MixerState | null {
  const parsed = z
    .object({
      format: z.literal(MIXER_STATE_FORMAT),
      channels: z.array(SerializedChannelSchema),
    })
    .safeParse(raw);
  if (!parsed.success) return null;

  const channels: ChannelStrip[] = [];
  for (const strip of parsed.data.channels) {
    if (!isValidChannelStripShape(strip)) return null;
    const inserts: InsertChain = [];
    for (const item of strip.inserts) {
      const chain = parseInserts(item);
      if (chain === null) return null;
      inserts.push(...chain);
    }
    channels.push({
      ...strip,
      trimDb: clamp(strip.trimDb, TRIM_DB_RANGE.min, TRIM_DB_RANGE.max),
      faderDb: clamp(strip.faderDb, FADER_DB_RANGE.min, FADER_DB_RANGE.max),
      pan: clamp(strip.pan, PAN_RANGE.min, PAN_RANGE.max),
      inserts,
    });
  }
  const masters = channels.filter((strip) => strip.kind === "master");
  if (masters.length !== 1) return null;
  return { format: MIXER_STATE_FORMAT, channels };
}

// ---------------------------------------------------------------------------
// Legacy adapters — remix_tracks.volume/pan/muted/solo + masterVolume
// ---------------------------------------------------------------------------

export type LegacyControl = { volume: number; pan: number; muted: boolean; solo: boolean };

/** Map a persisted legacy control row onto a stem channel (dB-domain). */
export function applyLegacyControl(state: MixerState, stemAssetId: string, control: LegacyControl): MixerState {
  const strip = state.channels.find(
    (item) => item.kind === "stem" && item.stemAssetId === stemAssetId,
  );
  if (strip === undefined) return state;
  const volume = clamp(control.volume, 0, 2);
  return updateChannel(state, strip.id, {
    faderDb: volume <= 0 ? FADER_DB_RANGE.min : clamp(gainToDb(volume), FADER_DB_RANGE.min, FADER_DB_RANGE.max),
    mutedInfinity: volume <= 0,
    pan: clamp(control.pan, PAN_RANGE.min, PAN_RANGE.max),
    muted: control.muted,
    solo: control.solo,
  });
}

/** Project mixer state back onto the legacy columns for persistence. */
export function toLegacyControls(state: MixerState): {
  controls: Record<string, LegacyControl>;
  masterVolume: number;
} {
  const controls: Record<string, LegacyControl> = {};
  for (const strip of state.channels) {
    if (strip.kind !== "stem" || strip.stemAssetId === undefined) continue;
    const gainDb = strip.mutedInfinity ? -Infinity : strip.trimDb + strip.faderDb;
    const linear = gainDb === -Infinity ? 0 : dbToGain(gainDb);
    controls[strip.stemAssetId] = {
      volume: clamp(linear, 0, 2),
      pan: clamp(strip.pan, -1, 1),
      muted: strip.muted,
      solo: strip.solo,
    };
  }
  const master = state.channels.find((strip) => strip.kind === "master");
  const masterDb = master === undefined || master.mutedInfinity
    ? -Infinity
    : master.trimDb + master.faderDb;
  return {
    controls,
    masterVolume: masterDb === -Infinity ? 0 : clamp(dbToGain(masterDb), 0, 2),
  };
}

/** Available processor ids (for tooling and the AI validator). */
export function availableProcessors(): InsertProcessorId[] {
  return Object.keys(INSERT_PARAM_RANGES) as InsertProcessorId[];
}
