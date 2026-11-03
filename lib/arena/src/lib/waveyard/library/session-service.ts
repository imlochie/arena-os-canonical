/**
 * Listening-session service (docs/waveyard-evolution-plan.md P3).
 *
 * SESSIONS are ordered sets of playable Tracks with per-track stem mixes and
 * transition configs — a performance/listening object, deliberately distinct
 * from production remix_sessions. Persistence reuses the P1 listening tables
 * (wy_listen_sessions / wy_listen_session_tracks) plus the P3 additions
 * (restore state columns, wy_listen_session_swaps provenance).
 *
 * "Send to Studio" produces an explicit DERIVED Studio representation through
 * the EXISTING remix/arrangement machinery: a new studio project + remix
 * session whose remix tracks reference the session tracks' EXISTING stem
 * assets (remix_tracks.stem_asset_id has no project constraint). No audio is
 * copied, no source or stem is mutated — the derived arrangement is a new,
 * explicitly named object the user then edits with the normal Studio tools.
 */

import { and, asc, count, desc, eq, inArray, ne } from "drizzle-orm";
import { extname } from "node:path";

import { db } from "@workspace/db";
import {
  listenSessionSwaps,
  listenSessions,
  listenSessionTracks,
  queueItems,
  projects,
  remixClips,
  remixSessions,
  remixTracks,
  sourceAssets,
  sourceAnalyses,
  sourceAcquisitions,
  stemAssets,
  tracks,
} from "@workspace/db/waveyardSchema";
import { requireUser } from "@workspace/arena/lib/waveyard/local-context";
import { checksumFile, probeAudio, sanitizedFilename } from "@workspace/arena/lib/waveyard/audio";
import { getStorage, privateObjectKey } from "../storage";
import { sourceObjectLockQuery } from "../source-object-lock";
import {
  normalizeStemMix,
  parseStemMix,
  serializeStemMix,
  withUnityDefaults,
  type StemMix,
} from "./model";
import {
  beatAlignedTransitionStart,
  defaultTransitionConfig,
  normalizeTransitionConfig,
  validateStemSwap,
  type TransitionConfig,
} from "./session-logic";
import { getTrack, QueueItemNotFoundError, removeQueueItem, type TrackDetail, type TrackStem, type TrackSummary } from "./service";
import { assertExpectedOrder, withOrderingLock, type OrderingTransaction } from "./ordering";
export { OrderingConflictError } from "./ordering";

export class SessionNotFoundError extends Error {
  constructor() {
    super("Session not found.");
  }
}

export class SessionTrackNotFoundError extends Error {
  constructor() {
    super("Session track not found.");
  }
}

export class SessionTrackOriginalAudioRestoreError extends Error {
  constructor(message: string) {
    super(message);
  }
}

export class TrackNotInLibraryError extends Error {
  constructor() {
    super("Track not found.");
  }
}

export class StemSwapRefusedError extends Error {
  constructor(message: string) {
    super(message);
  }
}

export class StudioHandoffSelectionError extends Error {
  constructor(message: string) {
    super(message);
  }
}

// ------------------------------------------------------------------ shapes

export interface SessionTrackPayload {
  id: string;
  position: number;
  /** Saved queue row that created this entry; null for direct session additions. */
  queueItemId: string | null;
  track: TrackSummary;
  /** Original source asset when its private audio file is present; null if missing. */
  sourceAssetId: string | null;
  /** Real stems of the underlying track (empty if the track was deleted). */
  stems: TrackStem[];
  /** What a deck should load — stems when separated, source otherwise.
   * Null when no playable asset is available. */
  playback: { assetIds: string[]; kind: "stems" | "source" } | null;
  /** Explicit per-session playback choice; null follows the track's default. */
  playbackPreference: "source" | "stems" | null;
  stemMix: StemMix;
  transition: TransitionConfig;
  /** Real analysis evidence for the compatibility panel + beat alignment
   * (null when analysis has not completed — honest, never guessed). */
  analysis: SessionTrackAnalysis | null;
}

export interface SessionDetailPayload {
  id: string;
  name: string;
  currentSessionTrackId: string | null;
  positionSeconds: number;
  tracks: SessionTrackPayload[];
  swaps: SessionSwapPayload[];
  createdAt: string;
  updatedAt: string;
}

export interface SessionSummaryPayload {
  id: string;
  name: string;
  trackCount: number;
  updatedAt: string;
}

export interface SessionSwapPayload {
  id: string;
  sessionTrackId: string;
  stemType: string;
  fromTrackId: string;
  toTrackId: string;
  fromStemAssetId: string | null;
  toStemAssetId: string | null;
  atSeconds: number;
  createdAt: string;
  donorTrack: { id: string; title: string; stems: TrackStem[] } | null;
}

interface SessionTrackRow {
  id: string;
  trackId: string;
  queueItemId: string | null;
  position: number;
  stemMix: string;
  transition: string;
  playbackPreference: string | null;
}

async function loadSessionTracks(sessionId: string): Promise<SessionTrackRow[]> {
  const rows = await db
    .select({
      id: listenSessionTracks.id,
      trackId: listenSessionTracks.trackId,
      queueItemId: listenSessionTracks.queueItemId,
      position: listenSessionTracks.position,
      stemMix: listenSessionTracks.stemMix,
      transition: listenSessionTracks.transition,
      playbackPreference: listenSessionTracks.playbackPreference,
    })
    .from(listenSessionTracks)
    .where(eq(listenSessionTracks.sessionId, sessionId))
    .orderBy(asc(listenSessionTracks.position));
  return rows;
}

async function trackSummariesById(trackIds: string[]): Promise<Map<string, TrackSummary>> {
  const summaries = new Map<string, TrackSummary>();
  if (trackIds.length === 0) return summaries;
  const rows = await db
    .select({ id: tracks.id, ownerId: tracks.ownerId })
    .from(tracks)
    .where(inArray(tracks.id, trackIds));
  for (const row of rows) {
    const detail = await getTrack(row.ownerId, row.id);
    if (detail !== null) summaries.set(row.id, detail);
  }
  return summaries;
}

async function sessionPayload(sessionId: string): Promise<SessionDetailPayload> {
  const [session] = await db.select().from(listenSessions).where(eq(listenSessions.id, sessionId)).limit(1);
  if (session === undefined) throw new SessionNotFoundError();
  const trackRows = await loadSessionTracks(sessionId);
  // getTrack returns null for deleted tracks — failSummary keeps those
  // visible in the payload instead of silently dropping them.
  const details = new Map<string, TrackDetail>();
  for (const row of trackRows) {
    const detail = await getTrack(session.ownerId, row.trackId);
    if (detail !== null) details.set(row.trackId, detail);
  }
  const summaries = await trackSummariesById(trackRows.map((row) => row.trackId));
  const analyses = new Map<string, SessionTrackAnalysis | null>();
  for (const row of trackRows) {
    analyses.set(row.id, await sessionTrackAnalysis(session.ownerId, row.trackId));
  }
  const swapRows = await db
    .select()
    .from(listenSessionSwaps)
    .where(eq(listenSessionSwaps.sessionId, sessionId))
    .orderBy(asc(listenSessionSwaps.createdAt));
  // A live donor can be any track in the owner's library, not just a queued
  // session track. Include only the stem identities needed to restore audio.
  for (const donorId of new Set(swapRows.map((row) => row.toTrackId))) {
    if (!details.has(donorId)) {
      const donor = await getTrack(session.ownerId, donorId);
      if (donor) details.set(donorId, donor);
    }
  }
  const sourceAvailability = new Map<string, boolean>();
  const sourceRows = details.size > 0
    ? await db.select({ id: sourceAssets.id, storageKey: sourceAssets.storageKey })
      .from(sourceAssets)
      .where(inArray(sourceAssets.id, [...details.values()].map((detail) => detail.source.id)))
    : [];
  for (const source of sourceRows) {
    sourceAvailability.set(source.id, await getStorage().exists(source.storageKey));
  }
  return {
    id: session.id,
    name: session.name,
    currentSessionTrackId: session.currentTrackId,
    positionSeconds: session.positionSeconds,
    tracks: trackRows.map((row) => {
      const detail = details.get(row.trackId) ?? null;
      return {
        id: row.id,
        position: row.position,
        queueItemId: row.queueItemId,
        track: (detail as TrackSummary | null) ?? summaries.get(row.trackId) ?? failSummary(row.trackId),
        sourceAssetId: detail?.source && sourceAvailability.get(detail.source.id) === true ? detail.source.id : null,
        stems: detail?.stems ?? [],
        playback: detail === null ? null : sessionPlayback(
          detail,
          row.playbackPreference,
          sourceAvailability.get(detail.source.id) === true,
        ),
        playbackPreference: normalizePlaybackPreference(row.playbackPreference),
        stemMix: parseStemMix(row.stemMix),
        transition: normalizeTransitionConfig(safeParse(row.transition)) ?? defaultTransitionConfig(),
        analysis: analyses.get(row.id) ?? null,
      };
    }),
    swaps: swapRows.map((row) => ({
      id: row.id,
      sessionTrackId: row.sessionTrackId,
      stemType: row.stemType,
      fromTrackId: row.fromTrackId,
      toTrackId: row.toTrackId,
      fromStemAssetId: row.fromStemAssetId,
      toStemAssetId: row.toStemAssetId,
      atSeconds: row.atSeconds,
      createdAt: row.createdAt.toISOString(),
      donorTrack: details.has(row.toTrackId) ? {
        id: row.toTrackId,
        title: details.get(row.toTrackId)!.title,
        stems: details.get(row.toTrackId)!.stems,
      } : null,
    })),
    createdAt: session.createdAt.toISOString(),
    updatedAt: session.updatedAt.toISOString(),
  };
}

function sessionPlayback(
  detail: TrackDetail,
  preference: string | null,
  sourceAvailable: boolean,
): SessionTrackPayload["playback"] {
  if (preference === "source" && sourceAvailable && detail.source.id) {
    return { assetIds: [detail.source.id], kind: "source" };
  }
  if (preference === "stems") {
    const realStems = detail.stems.filter((stem) => stem.engine !== "passthrough-unseparated");
    if (realStems.length > 0) {
      return { assetIds: realStems.map((stem) => stem.id), kind: "stems" };
    }
  }
  if (!sourceAvailable && detail.playback.kind === "source") return null;
  return detail.playback;
}

/**
 * Restore missing source bytes for a stem-backed session track without
 * replacing its source identity. Stem assets and saved session choices
 * continue to reference the same source/track/session rows.
 */
export async function restoreSessionTrackOriginalAudio(
  ownerId: string,
  sessionId: string,
  sessionTrackId: string,
  input: { filePath: string; filename: string; mimeType: string },
): Promise<SessionDetailPayload> {
  await ownedSession(ownerId, sessionId);
  const [entry] = await db
    .select({
      trackId: tracks.id,
      projectId: tracks.projectId,
      source: sourceAssets,
    })
    .from(listenSessionTracks)
    .innerJoin(tracks, eq(tracks.id, listenSessionTracks.trackId))
    .innerJoin(sourceAssets, eq(sourceAssets.id, tracks.sourceAssetId))
    .where(and(
      eq(listenSessionTracks.id, sessionTrackId),
      eq(listenSessionTracks.sessionId, sessionId),
      eq(tracks.ownerId, ownerId),
    ))
    .limit(1);
  if (entry === undefined) throw new SessionTrackNotFoundError();

  const realStems = await db
    .select({ id: stemAssets.id })
    .from(stemAssets)
    .where(and(
      eq(stemAssets.sourceAssetId, entry.source.id),
      ne(stemAssets.engine, "passthrough-unseparated"),
    ));
  if (realStems.length === 0) {
    throw new SessionTrackOriginalAudioRestoreError("This track has no separated stems to restore alongside.");
  }
  const storage = getStorage();
  if (await storage.exists(entry.source.storageKey)) {
    throw new SessionTrackOriginalAudioRestoreError("The original audio is already available.");
  }

  const filename = sanitizedFilename(input.filename);
  const audio = await probeAudio(input.filePath);
  const checksum = await checksumFile(input.filePath);
  const storageKey = privateObjectKey(entry.projectId, "source", extname(filename));
  let stored = false;
  try {
    await db.transaction(async (tx) => {
      await tx.execute(sourceObjectLockQuery(entry.source.storageKey));
      await tx.execute(sourceObjectLockQuery(storageKey));
      const [current] = await tx
        .select()
        .from(sourceAssets)
        .where(eq(sourceAssets.id, entry.source.id))
        .for("update")
        .limit(1);
      if (current === undefined || current.storageKey !== entry.source.storageKey) {
        throw new SessionTrackOriginalAudioRestoreError("The track's source changed before the replacement could be attached.");
      }
      if (await storage.exists(current.storageKey)) {
        throw new SessionTrackOriginalAudioRestoreError("The original audio became available before the replacement could be attached.");
      }
      const stillHasStems = await tx
        .select({ id: stemAssets.id })
        .from(stemAssets)
        .where(and(
          eq(stemAssets.sourceAssetId, current.id),
          ne(stemAssets.engine, "passthrough-unseparated"),
        ))
        .limit(1);
      if (stillHasStems.length === 0) {
        throw new SessionTrackOriginalAudioRestoreError("This track no longer has separated stems to restore alongside.");
      }
      const [duplicate] = await tx
        .select({ id: tracks.id })
        .from(tracks)
        .where(and(
          eq(tracks.ownerId, ownerId),
          eq(tracks.sourceChecksumSha256, checksum),
          ne(tracks.id, entry.trackId),
        ))
        .limit(1);
      if (duplicate !== undefined) {
        throw new SessionTrackOriginalAudioRestoreError("This audio already belongs to another library track. Nothing was changed.");
      }

      await storage.putFile(storageKey, input.filePath, input.mimeType || "application/octet-stream");
      stored = true;
      await tx.update(sourceAssets).set({
        originalFilename: filename,
        mimeType: input.mimeType || "application/octet-stream",
        storageKey,
        checksumSha256: checksum,
        durationSeconds: Math.round(audio.durationSeconds),
        sampleRate: audio.sampleRate,
        channels: audio.channels,
        codec: audio.codec,
        bitrate: audio.bitrate,
        fileSizeBytes: audio.sizeBytes,
      }).where(eq(sourceAssets.id, current.id));
      await tx.update(tracks).set({ sourceChecksumSha256: checksum }).where(eq(tracks.id, entry.trackId));
      await tx.update(sourceAcquisitions).set({
        method: "local-upload",
        sourceUrl: null,
        title: null,
        artist: null,
        resolver: null,
        metadata: JSON.stringify({ intake: "waveyard-session-original-restore" }),
      }).where(eq(sourceAcquisitions.sourceAssetId, current.id));
    });
  } catch (error) {
    if (stored) {
      const [referenced] = await db
        .select({ id: sourceAssets.id })
        .from(sourceAssets)
        .where(and(eq(sourceAssets.id, entry.source.id), eq(sourceAssets.storageKey, storageKey)))
        .limit(1)
        .catch(() => []);
      if (referenced === undefined) await storage.delete(storageKey).catch(() => undefined);
    }
    throw error;
  }
  return sessionPayload(sessionId);
}

function normalizePlaybackPreference(value: string | null): "source" | "stems" | null {
  return value === "source" || value === "stems" ? value : null;
}

function safeParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/** Placeholder for a track deleted while the session survived — honest,
 * visible, and never a silent hole. */
function failSummary(trackId: string): TrackSummary {
  return {
    id: trackId,
    sourceAssetId: null,
    title: "(removed track)",
    artist: "",
    album: "",
    durationSeconds: 0,
    playCount: 0,
    rating: 0,
    labels: [],
    lastPlayedAt: null,
    addedAt: "",
    stemAvailability: { status: "unavailable", reason: "This track was removed from your library." },
    studioProjectId: "",
  };
}

async function ownedSession(ownerId: string, sessionId: string) {
  const [row] = await db
    .select({ id: listenSessions.id })
    .from(listenSessions)
    .where(and(eq(listenSessions.id, sessionId), eq(listenSessions.ownerId, ownerId)))
    .limit(1);
  if (row === undefined) throw new SessionNotFoundError();
  return row;
}

async function touchSession(sessionId: string): Promise<void> {
  await db.update(listenSessions).set({ updatedAt: new Date() }).where(eq(listenSessions.id, sessionId));
}

// --------------------------------------------------------------------- CRUD

export async function createSession(ownerId: string, name: string): Promise<SessionSummaryPayload> {
  const [row] = await db.insert(listenSessions).values({ ownerId, name }).returning();
  return {
    id: row.id,
    name: row.name,
    trackCount: 0,
    updatedAt: row.updatedAt.toISOString(),
  };
}

export async function listSessions(ownerId: string): Promise<SessionSummaryPayload[]> {
  const rows = await db
    .select({
      id: listenSessions.id,
      name: listenSessions.name,
      updatedAt: listenSessions.updatedAt,
      trackCount: count(listenSessionTracks.id),
    })
    .from(listenSessions)
    .leftJoin(listenSessionTracks, eq(listenSessionTracks.sessionId, listenSessions.id))
    .where(eq(listenSessions.ownerId, ownerId))
    .groupBy(listenSessions.id)
    .orderBy(desc(listenSessions.updatedAt));
  return rows.map((row) => ({
    id: row.id,
    name: row.name,
    trackCount: Number(row.trackCount ?? 0),
    updatedAt: row.updatedAt.toISOString(),
  }));
}

export async function getSession(ownerId: string, sessionId: string): Promise<SessionDetailPayload> {
  await ownedSession(ownerId, sessionId);
  return sessionPayload(sessionId);
}

export async function renameSession(ownerId: string, sessionId: string, name: string): Promise<SessionSummaryPayload> {
  await ownedSession(ownerId, sessionId);
  const [row] = await db
    .update(listenSessions)
    .set({ name, updatedAt: new Date() })
    .where(eq(listenSessions.id, sessionId))
    .returning();
  const detail = await sessionPayload(sessionId);
  return { id: row.id, name: row.name, trackCount: detail.tracks.length, updatedAt: row.updatedAt.toISOString() };
}

export async function deleteSession(ownerId: string, sessionId: string): Promise<void> {
  await ownedSession(ownerId, sessionId);
  await db.delete(listenSessions).where(eq(listenSessions.id, sessionId));
}

// ------------------------------------------------------------- membership

export async function addTrackToSession(input: {
  ownerId: string;
  sessionId: string;
  trackId: string;
  position?: number;
  queueItemId?: string;
}): Promise<SessionDetailPayload> {
  await ownedSession(input.ownerId, input.sessionId);
  const [track] = await db
    .select({ id: tracks.id })
    .from(tracks)
    .where(and(eq(tracks.id, input.trackId), eq(tracks.ownerId, input.ownerId)))
    .limit(1);
  if (track === undefined) throw new TrackNotInLibraryError();

  await withOrderingLock(input.ownerId, async (tx) => {
    const existing = await sessionTrackIds(input.sessionId, tx);
    if (input.queueItemId !== undefined) {
      const [queueItem] = await tx
        .select({ trackId: queueItems.trackId })
        .from(queueItems)
        .where(and(
          eq(queueItems.id, input.queueItemId),
          eq(queueItems.ownerId, input.ownerId),
        ))
        .limit(1);
      if (queueItem === undefined || queueItem.trackId !== input.trackId) throw new QueueItemNotFoundError();
    }
    const [item] = await tx
      .insert(listenSessionTracks)
      .values({
        sessionId: input.sessionId,
        trackId: input.trackId,
        queueItemId: input.queueItemId ?? null,
        position: existing.length,
        stemMix: "{}",
        transition: JSON.stringify(defaultTransitionConfig()),
      })
      .returning({ id: listenSessionTracks.id });
    const ordered = [...existing, item.id];
    if (input.position !== undefined) {
      const to = Math.min(Math.max(Math.trunc(input.position), 0), ordered.length - 1);
      ordered.splice(to, 0, ordered.pop()!);
    }
    await resequence(input.sessionId, ordered, tx);
    await tx.update(listenSessions).set({ updatedAt: new Date() }).where(eq(listenSessions.id, input.sessionId));
  });
  return sessionPayload(input.sessionId);
}

async function resequence(sessionId: string, orderedIds: string[], tx: OrderingTransaction): Promise<void> {
  for (const [index, id] of orderedIds.entries()) {
    await tx
      .update(listenSessionTracks)
      .set({ position: index })
      .where(and(eq(listenSessionTracks.id, id), eq(listenSessionTracks.sessionId, sessionId)));
  }
}

async function sessionTrackIds(sessionId: string, tx: OrderingTransaction): Promise<string[]> {
  const rows = await tx
    .select({ id: listenSessionTracks.id })
    .from(listenSessionTracks)
    .where(eq(listenSessionTracks.sessionId, sessionId))
    .orderBy(asc(listenSessionTracks.position), asc(listenSessionTracks.id));
  return rows.map((row) => row.id);
}

export async function removeSessionTrack(ownerId: string, sessionId: string, sessionTrackId: string): Promise<SessionDetailPayload> {
  await ownedSession(ownerId, sessionId);
  const [item] = await db
    .select({ queueItemId: listenSessionTracks.queueItemId })
    .from(listenSessionTracks)
    .where(and(eq(listenSessionTracks.id, sessionTrackId), eq(listenSessionTracks.sessionId, sessionId)))
    .limit(1);
  if (item === undefined) throw new SessionTrackNotFoundError();
  if (item.queueItemId !== null) {
    await removeQueueItem(ownerId, item.queueItemId);
  } else {
    const now = new Date();
    await withOrderingLock(ownerId, async (tx) => {
      await tx.delete(listenSessionTracks).where(and(
        eq(listenSessionTracks.id, sessionTrackId),
        eq(listenSessionTracks.sessionId, sessionId),
      ));
      await tx.update(listenSessions)
        .set({ currentTrackId: null, positionSeconds: 0, updatedAt: now })
        .where(and(
          eq(listenSessions.id, sessionId),
          eq(listenSessions.ownerId, ownerId),
          eq(listenSessions.currentTrackId, sessionTrackId),
        ));
      await resequence(sessionId, await sessionTrackIds(sessionId, tx), tx);
      await tx.update(listenSessions).set({ updatedAt: now }).where(eq(listenSessions.id, sessionId));
    });
  }
  return sessionPayload(sessionId);
}

export async function moveSessionTrack(
  ownerId: string,
  sessionId: string,
  sessionTrackId: string,
  position: number,
  sessionOnly = false,
  expectedOrder?: string[],
): Promise<SessionDetailPayload> {
  await ownedSession(ownerId, sessionId);
  await withOrderingLock(ownerId, async (tx) => {
    const rows = await tx.select({
      id: listenSessionTracks.id,
      queueItemId: listenSessionTracks.queueItemId,
      position: listenSessionTracks.position,
    }).from(listenSessionTracks)
      .where(eq(listenSessionTracks.sessionId, sessionId))
      .orderBy(asc(listenSessionTracks.position), asc(listenSessionTracks.id));
    assertExpectedOrder(rows.map((row) => row.id), expectedOrder);
    // Playlist-only moves protect linked slots. Explicit up-next/general
    // moves intentionally remain free to use all session slots.
    const slots = sessionOnly ? rows.filter((row) => row.queueItemId === null) : rows;
    const from = slots.findIndex((row) => row.id === sessionTrackId);
    if (from === -1) throw new SessionTrackNotFoundError();
    const to = Math.max(0, slots.filter((row) => row.position <= Math.trunc(position)).length - 1);
    const ids = slots.map((row) => row.id);
    ids.splice(to, 0, ids.splice(from, 1)[0]);
    for (const [index, id] of ids.entries()) {
      await tx.update(listenSessionTracks).set({ position: slots[index].position })
        .where(eq(listenSessionTracks.id, id));
    }
    await tx.update(listenSessions).set({ updatedAt: new Date() })
      .where(eq(listenSessions.id, sessionId));
  });
  return sessionPayload(sessionId);
}

// ------------------------------------------------------- mix / transition

export async function updateSessionTrack(
  ownerId: string,
  sessionId: string,
  sessionTrackId: string,
  patch: { stemMix?: unknown; transition?: unknown; playbackPreference?: unknown },
): Promise<SessionDetailPayload> {
  await ownedSession(ownerId, sessionId);
  const [row] = await db
    .select({ id: listenSessionTracks.id })
    .from(listenSessionTracks)
    .where(and(eq(listenSessionTracks.id, sessionTrackId), eq(listenSessionTracks.sessionId, sessionId)))
    .limit(1);
  if (row === undefined) throw new SessionTrackNotFoundError();

  const values: Partial<{ stemMix: string; transition: string; playbackPreference: "source" | "stems" | null }> = {};
  if (patch.playbackPreference !== undefined) {
    if (patch.playbackPreference !== "source" && patch.playbackPreference !== "stems" && patch.playbackPreference !== null) {
      throw new Error("The playback preference is invalid.");
    }
    values.playbackPreference = patch.playbackPreference;
  }
  if (patch.stemMix !== undefined) {
    const mix = normalizeStemMix(patch.stemMix);
    if (Object.keys(mix).length === 0 && Object.keys(patch.stemMix ?? {}).length > 0) {
      throw new Error("The stem mix contained no valid stem levels.");
    }
    values.stemMix = serializeStemMix(mix);
  }
  if (patch.transition !== undefined) {
    const config = normalizeTransitionConfig(patch.transition);
    if (config === null) throw new Error("The transition configuration is invalid.");
    values.transition = JSON.stringify(config);
  }
  if (Object.keys(values).length > 0) {
    await db.update(listenSessionTracks).set(values).where(eq(listenSessionTracks.id, sessionTrackId));
    await touchSession(sessionId);
  }
  return sessionPayload(sessionId);
}

// ---------------------------------------------------------- restore state

export async function saveSessionState(
  ownerId: string,
  sessionId: string,
  currentSessionTrackId: string | null,
  positionSeconds: number,
): Promise<SessionDetailPayload> {
  await ownedSession(ownerId, sessionId);
  let validId = currentSessionTrackId;
  if (validId !== null) {
    const [row] = await db
      .select({ id: listenSessionTracks.id })
      .from(listenSessionTracks)
      .where(and(eq(listenSessionTracks.id, validId), eq(listenSessionTracks.sessionId, sessionId)))
      .limit(1);
    if (row === undefined) validId = null;
  }
  await db
    .update(listenSessions)
    .set({
      currentTrackId: validId,
      positionSeconds:
        Number.isFinite(positionSeconds) && positionSeconds > 0 ? Math.min(positionSeconds, 86_400) : 0,
      updatedAt: new Date(),
    })
    .where(eq(listenSessions.id, sessionId));
  return sessionPayload(sessionId);
}

// ----------------------------------------------------------------- swaps

export async function recordStemSwap(input: {
  ownerId: string;
  sessionId: string;
  sessionTrackId: string;
  stemType: string;
  toTrackId: string;
  atSeconds: number;
  expectedSwapId?: string;
  toStemAssetId?: string | null;
}): Promise<SessionDetailPayload> {
  await ownedSession(input.ownerId, input.sessionId);

  const [sessionTrack] = await db
    .select({ id: listenSessionTracks.id, trackId: listenSessionTracks.trackId })
    .from(listenSessionTracks)
    .where(and(eq(listenSessionTracks.id, input.sessionTrackId), eq(listenSessionTracks.sessionId, input.sessionId)))
    .limit(1);
  if (sessionTrack === undefined) throw new SessionTrackNotFoundError();

  const [donor] = await db
    .select({ id: tracks.id })
    .from(tracks)
    .where(and(eq(tracks.id, input.toTrackId), eq(tracks.ownerId, input.ownerId)))
    .limit(1);
  if (donor === undefined) throw new TrackNotInLibraryError();

  const currentDetail = await getTrack(input.ownerId, sessionTrack.trackId);
  const donorDetail = await getTrack(input.ownerId, input.toTrackId);
  if (currentDetail === null || donorDetail === null) throw new TrackNotInLibraryError();

  const currentStem = currentDetail.stems.find((stem) =>
    stem.stemType === input.stemType && stem.engine !== "passthrough-unseparated",
  );
  const donorStem = donorDetail.stems.find((stem) =>
    stem.stemType === input.stemType && stem.engine !== "passthrough-unseparated" &&
    (!input.toStemAssetId || stem.id === input.toStemAssetId),
  );
  const validation = validateStemSwap(currentDetail.stems, donorDetail.stems, input.stemType);
  if (!validation.ok) throw new StemSwapRefusedError(validation.reason);
  if (currentStem === undefined || donorStem === undefined) {
    throw new StemSwapRefusedError("The exact audio for this stem swap is no longer available.");
  }

  await db.transaction(async (tx) => {
    // All selections for a session serialize here, including guarded restores.
    // A failed B must never restore A over a newer explicit selection C.
    await tx.select({ id: listenSessions.id }).from(listenSessions)
      .where(eq(listenSessions.id, input.sessionId)).for("update");
    if (input.expectedSwapId) {
      const [current] = await tx.select({ id: listenSessionSwaps.id }).from(listenSessionSwaps).where(and(
        eq(listenSessionSwaps.sessionId, input.sessionId),
        eq(listenSessionSwaps.sessionTrackId, input.sessionTrackId),
        eq(listenSessionSwaps.stemType, input.stemType),
      )).orderBy(desc(listenSessionSwaps.createdAt)).limit(1);
      if (current?.id !== input.expectedSwapId) return;
    }
    // A stem has one current donor. Repeated live selections must not leave
    // shadow swaps that reappear when the user restores Original.
    await tx.update(listenSessions).set({ updatedAt: new Date() }).where(eq(listenSessions.id, input.sessionId));
    await tx.delete(listenSessionSwaps).where(and(
      eq(listenSessionSwaps.sessionId, input.sessionId),
      eq(listenSessionSwaps.sessionTrackId, input.sessionTrackId),
      eq(listenSessionSwaps.stemType, input.stemType),
    ));
    await tx.insert(listenSessionSwaps).values({
      sessionId: input.sessionId,
      sessionTrackId: input.sessionTrackId,
      stemType: input.stemType,
      fromTrackId: sessionTrack.trackId,
      toTrackId: input.toTrackId,
      fromStemAssetId: currentStem.id,
      toStemAssetId: donorStem.id,
      atSeconds: Number.isFinite(input.atSeconds) && input.atSeconds > 0 ? input.atSeconds : 0,
    });
  });
  await touchSession(input.sessionId);
  return sessionPayload(input.sessionId);
}

export async function removeStemSwap(ownerId: string, sessionId: string, swapId: string): Promise<SessionDetailPayload> {
  await ownedSession(ownerId, sessionId);
  await db.transaction(async (tx) => {
    await tx.select({ id: listenSessions.id }).from(listenSessions)
      .where(eq(listenSessions.id, sessionId)).for("update");
    const [selection] = await tx.select().from(listenSessionSwaps).where(and(
      eq(listenSessionSwaps.id, swapId), eq(listenSessionSwaps.sessionId, sessionId),
    )).limit(1);
    // A stale cancel must not delete a donor restored by a different request.
    if (!selection) return;
    await tx.delete(listenSessionSwaps).where(and(
      eq(listenSessionSwaps.sessionId, sessionId),
      eq(listenSessionSwaps.sessionTrackId, selection.sessionTrackId),
      eq(listenSessionSwaps.stemType, selection.stemType),
    ));
  });
  return sessionPayload(sessionId);
}

// --------------------------------------------------------- studio handoff

export interface StudioHandoffResult {
  projectId: string;
  remixSessionId: string;
  remixTrackCount: number;
  preservedSwapCount: number;
  preservedTransitionCount: number;
  transitionWarnings?: Array<{ fromTitle: string; toTitle: string; reason: string }>;
  refused?: Array<{ title: string; reason: string }>;
}

export interface StudioHandoffTrackEdit {
  sessionTrackId: string;
  stemMix: unknown;
}

/**
 * "Send to Studio": derive an explicit Studio object from the session — a
 * new studio project + remix session whose tracks REFERENCE the session
 * tracks' existing stem assets (no copies, no mutations). Tracks without any
 * stem asset (separation never ran AND no passthrough bridge) are refused
 * honestly by name, because a remix track requires real audio to bind.
 */
export async function sendSessionToStudio(
  ownerId: string,
  sessionId: string,
  selectedSessionTrackIds?: string[],
  trackEdits?: StudioHandoffTrackEdit[],
): Promise<StudioHandoffResult> {
  await requireUser();
  const detail = await sessionPayload(sessionId);
  await ownedSession(ownerId, sessionId);
  let selectedTracks = detail.tracks;
  if (selectedSessionTrackIds !== undefined) {
    const selectedIds = new Set(selectedSessionTrackIds);
    if (selectedIds.size === 0) {
      throw new StudioHandoffSelectionError("Select at least one session track to send to Studio.");
    }
    if (selectedIds.size !== selectedSessionTrackIds.length) {
      throw new StudioHandoffSelectionError("The Studio selection contains duplicate session tracks.");
    }
    const availableIds = new Set(detail.tracks.map((entry) => entry.id));
    if (selectedSessionTrackIds.some((id) => !availableIds.has(id))) {
      throw new StudioHandoffSelectionError("One or more selected entries no longer belong to this session. Refresh and try again.");
    }
    selectedTracks = detail.tracks.filter((entry) => selectedIds.has(entry.id));
  }
  const selectedTrackIds = new Set(selectedTracks.map((entry) => entry.id));
  const mixEdits = new Map<string, StemMix>();
  for (const edit of trackEdits ?? []) {
    if (!selectedTrackIds.has(edit.sessionTrackId)) {
      throw new StudioHandoffSelectionError("Mixer values were provided for an entry not selected for Studio.");
    }
    if (mixEdits.has(edit.sessionTrackId)) {
      throw new StudioHandoffSelectionError("The Studio handoff contains duplicate mixer values.");
    }
    const sessionTrack = selectedTracks.find((entry) => entry.id === edit.sessionTrackId)!;
    mixEdits.set(
      edit.sessionTrackId,
      normalizeStemMix(withUnityDefaults(normalizeStemMix(edit.stemMix), sessionTrack.stems.map((stem) => stem.stemType))),
    );
  }

  const bindable: Array<{
    sessionTrack: SessionTrackPayload;
    stemId: string;
    stemType: string;
    trackName: string;
    timelineStartMs: number;
    sourceOffsetMs: number;
    durationMs: number;
    fadeInMs: number;
    fadeOutMs: number;
  }> = [];
  const refused: Array<{ title: string; reason: string }> = [];
  const transitionWarnings: NonNullable<StudioHandoffResult["transitionWarnings"]> = [];
  let preservedSwapCount = 0;
  let preservedTransitionCount = 0;
  let previousPlacement: {
    sessionTrack: SessionTrackPayload;
    startMs: number;
    sourceOffsetMs: number;
    durationMs: number;
    bindableStart: number;
    bindableEnd: number;
    transition: TransitionConfig;
  } | null = null;
  for (const [selectedIndex, sessionTrack] of selectedTracks.entries()) {
    const trackDetail = await getTrack(ownerId, sessionTrack.track.id);
    if (trackDetail === null) {
      refused.push({ title: sessionTrack.track.title, reason: "The source track is no longer available." });
      continue;
    }
    if (trackDetail.stems.length === 0) {
      refused.push({ title: sessionTrack.track.title, reason: "No separated stems or full-source audio are available." });
      continue;
    }
    // Carry every separated stem and its current session fader into Studio.
    // The full-source bridge is only used when no separated stems exist.
    const real = trackDetail.stems.filter((stem) => stem.engine !== "passthrough-unseparated");
    const passthrough = trackDetail.stems.find((stem) => stem.engine === "passthrough-unseparated");
    const playableStems = real.length > 0 ? real : passthrough ? [passthrough] : [];
    if (playableStems.length === 0) {
      refused.push({ title: sessionTrack.track.title, reason: "No separated stems or full-source audio are available." });
      continue;
    }
    const replacements = new Map<string, { stemId: string; donorTitle: string; durationSeconds: number }>();
    let invalidSwapReason: string | null = null;
    for (const swap of detail.swaps.filter((entry) => entry.sessionTrackId === sessionTrack.id)) {
      if (swap.fromTrackId !== sessionTrack.track.id || swap.fromStemAssetId === null || swap.toStemAssetId === null) {
        invalidSwapReason = `The saved ${swap.stemType} swap has no pinned audio version. Reapply that live swap in the session before sending this entry to Studio.`;
        break;
      }
      const originalStem = trackDetail.stems.find((stem) =>
        stem.id === swap.fromStemAssetId && stem.stemType === swap.stemType,
      );
      const donorDetail = await getTrack(ownerId, swap.toTrackId);
      const donorStem = donorDetail?.stems.find((stem) =>
        stem.id === swap.toStemAssetId && stem.stemType === swap.stemType && stem.engine !== "passthrough-unseparated",
      );
      if (originalStem === undefined || donorStem === undefined || donorDetail === null) {
        invalidSwapReason = `The saved ${swap.stemType} swap audio is no longer available at its recorded version. Reapply the swap before sending this entry to Studio.`;
        break;
      }
      replacements.set(swap.stemType, {
        stemId: donorStem.id,
        donorTitle: donorDetail.title,
        durationSeconds: donorStem.durationSeconds,
      });
    }
    if (invalidSwapReason !== null) {
      refused.push({ title: sessionTrack.track.title, reason: invalidSwapReason });
      continue;
    }
    const trackDurationMs = Number.isFinite(trackDetail.durationSeconds) && trackDetail.durationSeconds > 0
      ? Math.max(1, Math.round(trackDetail.durationSeconds * 1000))
      : Math.max(0, ...playableStems.map((stem) =>
        Number.isFinite(stem.durationSeconds) && stem.durationSeconds > 0
          ? Math.round(stem.durationSeconds * 1000)
          : 0,
      ));
    if (trackDurationMs <= 0) {
      refused.push({ title: sessionTrack.track.title, reason: "Audio duration is unavailable for Studio placement." });
      continue;
    }

    let timelineStartMs: number = previousPlacement
      ? previousPlacement.startMs + previousPlacement.durationMs
      : 0;
    let sourceOffsetMs = 0;
    let fadeInMs = 0;
    let boundaryOverlapMs = 0;
    if (previousPlacement) {
      const previousTransition = previousPlacement.transition;
      const rawRequestedFadeMs = Math.max(0, Math.round(previousTransition.crossfadeSeconds * 1000));
      const currentTransition = normalizeTransitionConfig(sessionTrack.transition) ?? defaultTransitionConfig();
      const requestedNextFadeMs = selectedIndex < selectedTracks.length - 1
        ? Math.max(0, Math.round(currentTransition.crossfadeSeconds * 1000))
        : 0;
      const incomingBudgetMs = requestedNextFadeMs > 0
        && rawRequestedFadeMs + requestedNextFadeMs > trackDurationMs
        ? Math.floor(trackDurationMs * rawRequestedFadeMs / (rawRequestedFadeMs + requestedNextFadeMs))
        : rawRequestedFadeMs;
      const outgoingFadeableClips = bindable
        .slice(previousPlacement.bindableStart, previousPlacement.bindableEnd)
        .filter((clip) => !previousTransition.keepStems.includes(clip.stemType));
      const outgoingFadeCapacityMs = outgoingFadeableClips.length > 0
        ? Math.min(...outgoingFadeableClips.map((clip) => Math.max(0, clip.durationMs - clip.fadeInMs)))
        : previousPlacement.durationMs;
      const requestedFadeMs = Math.min(
        rawRequestedFadeMs,
        previousPlacement.durationMs,
        trackDurationMs,
        incomingBudgetMs,
        outgoingFadeCapacityMs,
      );
      if (requestedFadeMs < rawRequestedFadeMs) {
        transitionWarnings.push({
          fromTitle: previousPlacement.sessionTrack.track.title,
          toTitle: sessionTrack.track.title,
          reason: "The saved fade was shortened to fit the audio and leave room for adjacent transitions.",
        });
      }
      if (requestedFadeMs > 0) {
        let startInPreviousMs = previousPlacement.sourceOffsetMs + previousPlacement.durationMs - requestedFadeMs;
        let incomingOffsetMs = 0;
        let needsManualFallback = previousTransition.mode === "manual";
        if (previousTransition.mode !== "manual") {
          const eitherHasLiveSwap = detail.swaps.some(
            (swap) => swap.sessionTrackId === previousPlacement!.sessionTrack.id || swap.sessionTrackId === sessionTrack.id,
          );
          if (eitherHasLiveSwap) {
            transitionWarnings.push({
              fromTitle: previousPlacement.sessionTrack.track.title,
              toTitle: sessionTrack.track.title,
              reason: "A live stem swap is present; this boundary uses a manual fade because its beat timing is not stored.",
            });
            needsManualFallback = true;
          } else {
            const aligned = beatAlignedTransitionStart(
              previousPlacement.sessionTrack.analysis?.beatGridMs ?? null,
              sessionTrack.analysis?.beatGridMs ?? null,
              Math.max(
                previousPlacement.sourceOffsetMs,
                previousPlacement.sourceOffsetMs + previousPlacement.durationMs - requestedFadeMs,
              ),
              previousTransition.mode,
            );
            if (
              aligned.ok
              && aligned.startInCurrentMs !== null
              && aligned.incomingOffsetMs !== null
              && aligned.startInCurrentMs >= previousPlacement.sourceOffsetMs
              && aligned.incomingOffsetMs < trackDurationMs
            ) {
              startInPreviousMs = Math.round(aligned.startInCurrentMs);
              incomingOffsetMs = Math.max(0, Math.round(aligned.incomingOffsetMs));
            } else {
              transitionWarnings.push({
                fromTitle: previousPlacement.sessionTrack.track.title,
                toTitle: sessionTrack.track.title,
                reason: aligned.ok
                  ? "The verified beat/bar cue falls outside the available audio; using a manual fade."
                  : aligned.reason,
              });
              needsManualFallback = true;
            }
          }
        }
        if (needsManualFallback) {
          startInPreviousMs = previousPlacement.sourceOffsetMs + previousPlacement.durationMs - requestedFadeMs;
          incomingOffsetMs = 0;
        }
        let overlapMs = Math.min(
          requestedFadeMs,
          previousPlacement.sourceOffsetMs + previousPlacement.durationMs - startInPreviousMs,
          trackDurationMs - incomingOffsetMs,
        );
        if (overlapMs <= 0 && !needsManualFallback) {
          transitionWarnings.push({
            fromTitle: previousPlacement.sessionTrack.track.title,
            toTitle: sessionTrack.track.title,
            reason: "The verified beat/bar cue falls outside the usable audio; this boundary uses a manual fade.",
          });
          needsManualFallback = true;
          startInPreviousMs = previousPlacement.sourceOffsetMs + previousPlacement.durationMs - requestedFadeMs;
          incomingOffsetMs = 0;
          overlapMs = Math.min(requestedFadeMs, previousPlacement.durationMs, trackDurationMs);
        }
        if (overlapMs > 0) {
          sourceOffsetMs = incomingOffsetMs;
          timelineStartMs = previousPlacement.startMs + Math.max(0, startInPreviousMs - previousPlacement.sourceOffsetMs);
          fadeInMs = overlapMs;
          boundaryOverlapMs = overlapMs;
        }
      }
    }
    const remainingTrackDurationMs = trackDurationMs - sourceOffsetMs;
    if (remainingTrackDurationMs <= 0) {
      refused.push({ title: sessionTrack.track.title, reason: "The saved transition starts beyond the available audio." });
      continue;
    }
    const bindableStart = bindable.length;
    for (const stem of playableStems) {
      const replacement = replacements.get(stem.stemType);
      const stemDuration = Number.isFinite(replacement?.durationSeconds) && (replacement?.durationSeconds ?? 0) > 0
        ? replacement!.durationSeconds
        : Number.isFinite(stem.durationSeconds) && stem.durationSeconds > 0
          ? stem.durationSeconds
        : trackDetail.durationSeconds;
      if (!Number.isFinite(stemDuration) || stemDuration <= 0) {
        refused.push({ title: sessionTrack.track.title, reason: "Audio duration is unavailable for Studio placement." });
        continue;
      }
      const clipDurationMs = Math.min(
        Math.round(stemDuration * 1000) - sourceOffsetMs,
        remainingTrackDurationMs,
      );
      if (clipDurationMs <= 0) {
        refused.push({ title: sessionTrack.track.title, reason: `The ${stem.stemType} audio ends before the saved transition offset.` });
        continue;
      }
      bindable.push({
        sessionTrack,
        stemId: replacement?.stemId ?? stem.id,
        stemType: stem.stemType,
        trackName: replacement
          ? `${sessionTrack.track.title} — ${stem.stemType} · ${replacement.donorTitle}`
          : `${sessionTrack.track.title} — ${stem.stemType}`,
        timelineStartMs,
        sourceOffsetMs,
        durationMs: clipDurationMs,
        fadeInMs: Math.min(fadeInMs, clipDurationMs),
        fadeOutMs: 0,
      });
      if (replacement !== undefined) preservedSwapCount += 1;
    }
    if (bindable.length === bindableStart) continue;
    if (previousPlacement && boundaryOverlapMs > 0) {
      for (let index = previousPlacement.bindableStart; index < previousPlacement.bindableEnd; index += 1) {
        const outgoing = bindable[index];
        if (previousPlacement.transition.keepStems.includes(outgoing.stemType)) continue;
        outgoing.fadeOutMs = Math.min(boundaryOverlapMs, outgoing.durationMs);
      }
      preservedTransitionCount += 1;
    }
    previousPlacement = {
      sessionTrack,
      startMs: timelineStartMs,
      sourceOffsetMs,
      durationMs: remainingTrackDurationMs,
      bindableStart,
      bindableEnd: bindable.length,
      transition: normalizeTransitionConfig(sessionTrack.transition) ?? defaultTransitionConfig(),
    };
  }
  if (bindable.length === 0) {
    const reasons = refused.map((item) => `${item.title}: ${item.reason}`).join("; ");
    throw new StemSwapRefusedError(
      reasons.length > 0
        ? `No selected session entry can be opened in Studio. ${reasons}. No Studio project was created. Restore or re-separate the named tracks in the Library, or remove them from the selection, then retry.`
        : "No selected session entry has audio the Studio can bind (needs separated stems or the full-source bridge). No Studio project was created. Restore or re-separate the tracks in the Library, or remove them from the selection, then retry.",
    );
  }

  const [project] = await db
    .insert(projects)
    .values({
      ownerId,
      title: `Session · ${detail.name}`,
      description: `Derived from listening session “${detail.name}” (${selectedTracks.length} of ${detail.tracks.length} entries selected). Original tracks and stems are referenced, never copied or modified.`,
      kind: "studio",
      visibility: "private",
    })
    .returning({ id: projects.id });

  const [remix] = await db
    .insert(remixSessions)
    .values({
      projectId: project.id,
      ownerId,
      name: `Session · ${detail.name}`,
    })
    .returning({ id: remixSessions.id });

  await db.transaction(async (tx) => {
    const createdTracks = await tx.insert(remixTracks).values(bindable.map((entry, sortOrder) => ({
      remixSessionId: remix.id,
      stemAssetId: entry.stemId,
      name: entry.trackName,
      sortOrder,
      volume: (mixEdits.get(entry.sessionTrack.id) ?? entry.sessionTrack.stemMix)[entry.stemType] ?? 1,
    }))).returning({ id: remixTracks.id, sortOrder: remixTracks.sortOrder });
    const idBySortOrder = new Map(createdTracks.map((track) => [track.sortOrder, track.id]));
    await tx.insert(remixClips).values(bindable.map((entry, sortOrder) => ({
      remixTrackId: idBySortOrder.get(sortOrder)!,
      stemAssetId: entry.stemId,
      timelineStartMs: entry.timelineStartMs,
      sourceOffsetMs: entry.sourceOffsetMs,
      durationMs: entry.durationMs,
      gain: 1,
      fadeInMs: entry.fadeInMs,
      fadeOutMs: entry.fadeOutMs,
    })));
  });

  return {
    projectId: project.id,
    remixSessionId: remix.id,
    remixTrackCount: bindable.length,
    preservedSwapCount,
    preservedTransitionCount,
    transitionWarnings: transitionWarnings.length > 0 ? transitionWarnings : undefined,
    refused: refused.length > 0 ? refused : undefined,
  };
}

/** Analysis for the compatibility panel: BPM/key/beat grid per session track. */
export interface SessionTrackAnalysis {
  bpm: number | null;
  musicalKey: string | null;
  beatGridMs: number[] | null;
}

export async function sessionTrackAnalysis(ownerId: string, trackId: string): Promise<SessionTrackAnalysis | null> {
  const detail: TrackDetail | null = await getTrack(ownerId, trackId);
  if (detail === null) return null;
  const [sourceTrack] = await db
    .select({ sourceAssetId: tracks.sourceAssetId })
    .from(tracks)
    .where(eq(tracks.id, trackId))
    .limit(1);
  if (sourceTrack === undefined) return null;
  const [analysis] = await db
    .select({ bpm: sourceAnalyses.bpm, musicalKey: sourceAnalyses.musicalKey, beatGrid: sourceAnalyses.beatGrid })
    .from(sourceAnalyses)
    .where(and(eq(sourceAnalyses.sourceAssetId, sourceTrack.sourceAssetId), eq(sourceAnalyses.status, "complete")))
    .limit(1);
  if (analysis === undefined) return { bpm: null, musicalKey: null, beatGridMs: null };
  let beatGridMs: number[] | null = null;
  try {
    const parsed = JSON.parse(analysis.beatGrid ?? "null");
    if (Array.isArray(parsed)) beatGridMs = parsed.filter((beat) => Number.isSafeInteger(beat));
  } catch {
    beatGridMs = null;
  }
  return { bpm: analysis.bpm, musicalKey: analysis.musicalKey, beatGridMs };
}
