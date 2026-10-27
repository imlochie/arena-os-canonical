/**
 * Remix ↔ MixerState bridge — maps the persisted remix session onto the
 * AI mixer-state model and applied proposals back onto remix persistence.
 * The AI layer can only express what remix_tracks/remix_sessions can store
 * (volume, pan, muted, solo, inserts, master inserts) — by construction it
 * cannot touch source assets or files.
 */

import {
  createMixerState,
  findChannel,
  toLegacyControls,
  type StemInput,
} from "../mixer/state";
import { dbToGain, gainToDb } from "../mixer/gain";
import { INSERTS_FORMAT, parseInserts } from "../mixer/inserts";
import type { MinimalInsert } from "../mixer/types";
import type { MixerState } from "../mixer/types";
import { MASTER_CHANNEL_ID } from "../mixer/state";

export type RemixTrackView = {
  /** remix track row id */
  id: string;
  stemAssetId: string;
  name: string;
  volume: number;
  pan: number;
  muted: boolean;
  solo: boolean;
  /** Raw stored inserts JSON (string) — parsed defensively. */
  insertsRaw: string;
};

export type RemixSessionView = {
  masterVolume: number;
  masterInsertsRaw: string;
  tracks: RemixTrackView[];
};

export function mixerStateFromRemix(session: RemixSessionView): MixerState {
  const stems: StemInput[] = session.tracks.map((track) => ({
    id: track.stemAssetId,
    name: track.name,
  }));
  const state = createMixerState({ stems, masterName: "Master" });
  const withChannels = state.channels.map((channel) => {
    if (channel.kind === "master") {
      const masterInserts = parseStoredChain(session.masterInsertsRaw);
      const gain = session.masterVolume <= 0 ? -60 : gainToDb(session.masterVolume);
      return { ...channel, faderDb: Math.max(-60, Math.min(6, gain)), inserts: masterInserts };
    }
    const track = session.tracks.find((candidate) => candidate.stemAssetId === channel.stemAssetId);
    if (track === undefined) return channel;
    const gain = track.volume <= 0 ? -60 : gainToDb(track.volume);
    return {
      ...channel,
      faderDb: Math.max(-60, Math.min(6, gain)),
      pan: track.pan,
      muted: track.muted,
      solo: track.solo,
      inserts: parseStoredChain(track.insertsRaw),
    };
  });
  return { ...state, channels: withChannels };
}

function parseStoredChain(raw: string): MinimalInsert[] {
  try {
    const parsed = JSON.parse(raw);
    // remix_tracks.inserts / remix_sessions.masterInserts persist the
    // BARE-ARRAY canonical form; the {format, inserts} envelope appears in
    // exports/tests. Accept both, validate every insert, degrade to [] only
    // on genuinely corrupt data.
    const inserts = Array.isArray(parsed)
      ? parsed
      : parsed !== null && typeof parsed === "object" && Array.isArray((parsed as { inserts?: unknown }).inserts)
        ? (parsed as { inserts: unknown[] }).inserts
        : null;
    if (inserts === null) return [];
    const chain = parseInserts({ format: INSERTS_FORMAT, inserts });
    return chain ?? [];
  } catch {
    return [];
  }
}

export type RemixUpdate = {
  tracks: Array<{ id: string; volume: number; pan: number; muted: boolean; solo: boolean; inserts: MinimalInsert[] }>;
  masterVolume: number;
  masterInserts: MinimalInsert[];
};

/** Project an applied mixer state back onto remix persistence rows. */
export function remixUpdateFromMixerState(
  session: RemixSessionView,
  next: MixerState,
): RemixUpdate {
  const legacy = toLegacyControls(next);
  const master = findChannel(next, MASTER_CHANNEL_ID);
  return {
    tracks: session.tracks.map((track) => {
      const strip = next.channels.find((channel) => channel.stemAssetId === track.stemAssetId);
      const control = legacy.controls[track.stemAssetId];
      return {
        id: track.id,
        volume: control?.volume ?? track.volume,
        pan: control?.pan ?? track.pan,
        muted: control?.muted ?? track.muted,
        solo: control?.solo ?? track.solo,
        inserts: strip?.inserts ?? parseStoredChain(track.insertsRaw),
      };
    }),
    masterVolume: legacy.masterVolume,
    masterInserts: master?.inserts ?? parseStoredChain(session.masterInsertsRaw),
  };
}

export { dbToGain };
