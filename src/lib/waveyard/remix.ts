import {
  AUTOMATION_PARAMETERS,
  normaliseAutomationPoints,
  normaliseMusicalKey,
  type RemixAutomationLane,
} from "./types";
import { INSERTS_FORMAT, parseInserts, type InsertChain } from "./mixer/inserts";
import {
  DEFAULT_TIMING,
  GRID_DIVISIONS,
  type GridDivision,
  type MusicalTiming,
} from "./timing";

export type RemixClipInput = {
  id?: string;
  stemAssetId: string;
  timelineStartMs: number;
  durationMs: number;
  sourceOffsetMs: number;
  gain: number;
  fadeInMs: number;
  fadeOutMs: number;
  // Missing on historical snapshots means preserve the original, untransformed behavior.
  tempoSyncEnabled: boolean;
  // Missing on historical snapshots means preserve the original, untransformed behavior.
  keySyncEnabled: boolean;
  // Missing on historical snapshots retains freehand source editing.
  beatSnapEnabled: boolean;
};
export type RemixTrackInput = {
  id: string;
  stemAssetId: string;
  name: string;
  sortOrder: number;
  volume: number;
  pan: number;
  muted: boolean;
  solo: boolean;
  clips: RemixClipInput[];
  /** Insert chain (waveyard-inserts-v1); undefined = leave persisted chain untouched. */
  inserts?: InsertChain;
};
export type RemixStateInput = MusicalTiming & {
  name?: string;
  masterVolume: number;
  loopStartMs: number;
  loopEndMs: number | null;
  targetKey: string | null;
  tracks: RemixTrackInput[];
  /** Master insert chain; undefined = leave the persisted chain untouched. */
  masterInserts?: InsertChain;
  // Omitted by pre-Phase-15 callers so their ordinary arrangement PUTs do not
  // accidentally erase newly persisted automation.
  automation?: RemixAutomationLane[];
};

/**
 * Insert chains arrive as untrusted JSON. A present-but-invalid chain
 * rejects the whole state (strict, like every other field): the validator
 * is the authority. undefined = field not sent (legacy callers) = keep.
 */
function normaliseInserts(raw: unknown): InsertChain | undefined | null {
  if (raw === undefined) return undefined;
  if (raw === null) return [];
  if (typeof raw === "string") {
    try {
      return normaliseInserts(JSON.parse(raw));
    } catch {
      return null;
    }
  }
  return parseInserts({ format: INSERTS_FORMAT, inserts: raw });
}

function finiteNumber(value: unknown, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}
export function clamp(value: unknown, lower: number, upper: number) {
  return Math.min(upper, Math.max(lower, finiteNumber(value, lower)));
}

function normaliseTiming(raw: Partial<RemixStateInput>): MusicalTiming {
  const denominator = Number(raw.timeSignatureDenominator);
  return {
    tempoBpm: Number(clamp(raw.tempoBpm ?? DEFAULT_TIMING.tempoBpm, 20, 300).toFixed(2)),
    timeSignatureNumerator: Math.round(clamp(raw.timeSignatureNumerator ?? DEFAULT_TIMING.timeSignatureNumerator, 1, 12)),
    timeSignatureDenominator: [1, 2, 4, 8, 16].includes(denominator)
      ? denominator
      : DEFAULT_TIMING.timeSignatureDenominator,
    gridDivision: GRID_DIVISIONS.includes(raw.gridDivision as GridDivision)
      ? (raw.gridDivision as GridDivision)
      : DEFAULT_TIMING.gridDivision,
    snapEnabled: raw.snapEnabled !== false,
  };
}

export function normaliseRemixState(raw: unknown): RemixStateInput | null {
  if (!raw || typeof raw !== "object") return null;
  const value = raw as Partial<RemixStateInput>;
  if (!Array.isArray(value.tracks) || value.tracks.length > 32) return null;
  const tracks: RemixTrackInput[] = [];
  for (const [trackIndex, input] of value.tracks.entries()) {
    if (!input || typeof input !== "object" || !input.id || !input.stemAssetId || !Array.isArray(input.clips) || input.clips.length > 256) return null;
    const trackInserts = normaliseInserts(input.inserts);
    if (trackInserts === null) return null;
    const clips: RemixClipInput[] = [];
    for (const clip of input.clips) {
      if (!clip || typeof clip !== "object" || !clip.stemAssetId) return null;
      const timelineStartMs = Math.round(clamp(clip.timelineStartMs, 0, 86_400_000));
      const durationMs = Math.round(clamp(clip.durationMs, 1, 86_400_000));
      const sourceOffsetMs = Math.round(clamp(clip.sourceOffsetMs, 0, 86_400_000));
      const fadeInMs = Math.round(clamp(clip.fadeInMs ?? 0, 0, durationMs));
      const fadeOutMs = Math.round(clamp(clip.fadeOutMs ?? 0, 0, durationMs));
      if (fadeInMs + fadeOutMs > durationMs) return null;
      clips.push({
        id: clip.id,
        stemAssetId: String(clip.stemAssetId),
        timelineStartMs,
        durationMs,
        sourceOffsetMs,
        gain: clamp(clip.gain, 0, 4),
        fadeInMs,
        fadeOutMs,
        // Missing in historical snapshots preserves prior, untransformed export behavior.
        tempoSyncEnabled: clip.tempoSyncEnabled === true,
        keySyncEnabled: clip.keySyncEnabled === true,
        beatSnapEnabled: clip.beatSnapEnabled === true,
      });
    }
    tracks.push({
      id: String(input.id),
      stemAssetId: String(input.stemAssetId),
      name: String(input.name || "Stem").slice(0, 80),
      sortOrder: Math.round(clamp(input.sortOrder ?? trackIndex, 0, 99)),
      volume: clamp(input.volume, 0, 2),
      pan: clamp(input.pan, -1, 1),
      muted: input.muted === true,
      solo: input.solo === true,
      clips,
      ...(trackInserts !== undefined ? { inserts: trackInserts } : {}),
    });
  }
  const masterInserts = normaliseInserts(value.masterInserts);
  if (masterInserts === null) return null;
  const loopStartMs = Math.round(clamp(value.loopStartMs, 0, 86_400_000));
  const loopEndCandidate = value.loopEndMs === null || value.loopEndMs === undefined ? null : Math.round(clamp(value.loopEndMs, 0, 86_400_000));
  const targetKey = value.targetKey === null || value.targetKey === undefined
    ? null
    : normaliseMusicalKey(value.targetKey);
  if (value.targetKey !== null && value.targetKey !== undefined && !targetKey) return null;
  let automation: RemixAutomationLane[] | undefined;
  if (value.automation !== undefined) {
    if (!Array.isArray(value.automation)) return null;
    const laneByTarget = new Map<string, RemixAutomationLane>();
    for (const lane of value.automation) {
      if (!lane || typeof lane !== "object" || !tracks.some((track) => track.id === lane.remixTrackId)
        || !AUTOMATION_PARAMETERS.includes(lane.parameter)) return null;
      const points = normaliseAutomationPoints(lane.parameter, lane.points);
      if (!points) return null;
      // A legacy/malformed snapshot cannot create two independent curves for
      // one target. Its final lane has deterministic last-write authority.
      laneByTarget.set(`${lane.remixTrackId}:${lane.parameter}`, {
        remixTrackId: lane.remixTrackId,
        parameter: lane.parameter,
        points,
      });
    }
    automation = [...laneByTarget.values()];
  }
  return {
    name: value.name ? String(value.name).trim().slice(0, 120) : undefined,
    masterVolume: clamp(value.masterVolume, 0, 2),
    loopStartMs,
    loopEndMs: loopEndCandidate && loopEndCandidate > loopStartMs ? loopEndCandidate : null,
    targetKey,
    ...(masterInserts !== undefined ? { masterInserts } : {}),
    tracks,
    ...(automation === undefined ? {} : { automation }),
    ...normaliseTiming(value),
  };
}

export function crossfadeError(track: Pick<RemixTrackInput, "clips">) {
  const clips = [...track.clips].sort((left, right) => left.timelineStartMs - right.timelineStartMs);
  for (let index = 0; index < clips.length - 1; index += 1) {
    const left = clips[index];
    const right = clips[index + 1];
    const overlap = left.timelineStartMs + left.durationMs - right.timelineStartMs;
    if (overlap <= 0) continue;
    const usesBoundaryFade = left.fadeOutMs > 0 || right.fadeInMs > 0;
    if (usesBoundaryFade && (left.fadeOutMs !== overlap || right.fadeInMs !== overlap))
      return "Adjacent overlapping clips require matching fade-out, fade-in, and overlap durations.";
  }
  return null;
}

export function effectiveMuted(track: Pick<RemixTrackInput, "muted" | "solo">, anySolo: boolean) {
  return track.muted || (anySolo && !track.solo);
}
