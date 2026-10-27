/**
 * Remix version snapshot/restore mapping — the persistence contract for
 * "save version" and "restore version".
 *
 * Extracted from the routes exactly so this contract is testable without
 * a database (same pattern as the arrangement-layer mapping). If a field
 * stops travelling with a version — e.g. an insert chain — the
 * version-roundtrip tests fail.
 *
 * The export worker renders from these snapshots, so every piece of mixer
 * state that affects audio MUST appear here: volume, pan, mutes, solos,
 * TRACK INSERTS, MASTER INSERTS, clips, fades, automation.
 */

import type { remixAutomationPoints, remixClips, remixSessions, remixTracks } from "@/db/waveyardSchema";
import type { RemixStateInput, RemixTrackInput } from "./remix";

export type SessionRow = typeof remixSessions.$inferSelect;
export type TrackRow = typeof remixTracks.$inferSelect;
export type ClipRow = typeof remixClips.$inferSelect;
export type AutomationRow = typeof remixAutomationPoints.$inferSelect;

export type VersionSnapshot = {
  name: string;
  masterVolume: number;
  /** Master insert chain JSON (waveyard-inserts-v1) — must survive versioning. */
  masterInserts: string;
  loopStartMs: number;
  loopEndMs: number | null;
  tempoBpm: number;
  timeSignatureNumerator: number;
  timeSignatureDenominator: number;
  gridDivision: string;
  snapEnabled: boolean;
  targetKey: string | null;
  tracks: Array<TrackRow & { clips: ClipRow[] }>;
  automation: Array<{
    remixTrackId: string;
    parameter: string;
    points: Array<{ id: string; timelineMs: number; value: number }>;
  }>;
};

/** Assemble the immutable version snapshot from live session rows. */
export function buildVersionSnapshot(input: {
  remix: SessionRow;
  tracks: TrackRow[];
  clips: ClipRow[];
  automation: AutomationRow[];
}): VersionSnapshot {
  const { remix, clips, automation } = input;
  const tracks = [...input.tracks]
    .sort((left, right) => left.sortOrder - right.sortOrder)
    .map((track) => ({ ...track, clips: clips.filter((clip) => clip.remixTrackId === track.id) }));
  return {
    name: remix.name,
    masterVolume: remix.masterVolume,
    masterInserts: remix.masterInserts,
    loopStartMs: remix.loopStartMs,
    loopEndMs: remix.loopEndMs,
    tempoBpm: remix.tempoBpm,
    timeSignatureNumerator: remix.timeSignatureNumerator,
    timeSignatureDenominator: remix.timeSignatureDenominator,
    gridDivision: remix.gridDivision,
    snapEnabled: remix.snapEnabled,
    targetKey: remix.targetKey,
    tracks,
    automation: [...new Map(automation.map((point) => [
      `${point.remixTrackId}:${point.parameter}`,
      {
        remixTrackId: point.remixTrackId,
        parameter: point.parameter,
        points: automation.filter((candidate) => candidate.remixTrackId === point.remixTrackId && candidate.parameter === point.parameter)
          .map(({ id: pointId, timelineMs, value }) => ({ id: pointId, timelineMs, value })),
      },
    ])).values()],
  };
}

/** Field set written to remix_tracks when restoring a version. */
export function restoredTrackFields(sessionId: string, track: RemixTrackInput): {
  remixSessionId: string;
  stemAssetId: string;
  name: string;
  sortOrder: number;
  volume: number;
  pan: number;
  muted: boolean;
  solo: boolean;
  phaseInverted: boolean;
  updatedAt: Date;
  /** Insert chain JSON — present whenever the snapshot carried one. */
  inserts?: string;
} {
  return {
    remixSessionId: sessionId,
    stemAssetId: track.stemAssetId,
    name: track.name,
    sortOrder: track.sortOrder,
    volume: track.volume,
    pan: track.pan,
    muted: track.muted,
    solo: track.solo,
    phaseInverted: track.phaseInverted === true,
    updatedAt: new Date(),
    // Insert chains travel with the version — restore must not lose them.
    ...(track.inserts !== undefined ? { inserts: JSON.stringify(track.inserts) } : {}),
  };
}

/** Field set written to remix_sessions when restoring a version. */
export function restoredSessionFields(
  state: RemixStateInput,
  session: { name: string; version: number },
): {
  name: string;
  masterVolume: number;
  /** Master insert chain JSON — present whenever the snapshot carried one. */
  masterInserts?: string;
  loopStartMs: number;
  loopEndMs: number | null;
  tempoBpm: number;
  timeSignatureNumerator: number;
  timeSignatureDenominator: number;
  gridDivision: string;
  snapEnabled: boolean;
  targetKey: string | null;
  version: number;
  updatedAt: Date;
} {
  return {
    name: state.name || session.name,
    masterVolume: state.masterVolume,
    ...(state.masterInserts !== undefined ? { masterInserts: JSON.stringify(state.masterInserts) } : {}),
    loopStartMs: state.loopStartMs,
    loopEndMs: state.loopEndMs,
    tempoBpm: state.tempoBpm,
    timeSignatureNumerator: state.timeSignatureNumerator,
    timeSignatureDenominator: state.timeSignatureDenominator,
    gridDivision: state.gridDivision,
    snapEnabled: state.snapEnabled,
    targetKey: state.targetKey,
    version: session.version + 1,
    updatedAt: new Date(),
  };
}
