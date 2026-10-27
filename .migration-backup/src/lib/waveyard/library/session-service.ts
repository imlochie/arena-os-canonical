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

import { and, asc, count, desc, eq, inArray } from "drizzle-orm";

import { db } from "@/db";
import {
  listenSessionSwaps,
  listenSessions,
  listenSessionTracks,
  projects,
  remixSessions,
  remixTracks,
  sourceAnalyses,
  stemAssets,
  tracks,
} from "@/db/waveyardSchema";
import { requireUser } from "@/lib/waveyard/local-context";
import {
  normalizeStemMix,
  parseStemMix,
  serializeStemMix,
  type StemMix,
} from "./model";
import {
  defaultTransitionConfig,
  normalizeTransitionConfig,
  validateStemSwap,
  type TransitionConfig,
} from "./session-logic";
import { getTrack, type TrackDetail, type TrackStem, type TrackSummary } from "./service";

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

// ------------------------------------------------------------------ shapes

export interface SessionTrackPayload {
  id: string;
  position: number;
  track: TrackSummary;
  /** Real stems of the underlying track (empty if the track was deleted). */
  stems: TrackStem[];
  /** What a deck should load — stems when separated, source otherwise.
   * Null when the track was deleted (deck shows it honestly). */
  playback: { assetIds: string[]; kind: "stems" | "source" } | null;
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
  atSeconds: number;
  createdAt: string;
}

interface SessionTrackRow {
  id: string;
  trackId: string;
  position: number;
  stemMix: string;
  transition: string;
}

async function loadSessionTracks(sessionId: string): Promise<SessionTrackRow[]> {
  const rows = await db
    .select({
      id: listenSessionTracks.id,
      trackId: listenSessionTracks.trackId,
      position: listenSessionTracks.position,
      stemMix: listenSessionTracks.stemMix,
      transition: listenSessionTracks.transition,
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
        track: (detail as TrackSummary | null) ?? summaries.get(row.trackId) ?? failSummary(row.trackId),
        stems: detail?.stems ?? [],
        playback: detail?.playback ?? null,
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
      atSeconds: row.atSeconds,
      createdAt: row.createdAt.toISOString(),
    })),
    createdAt: session.createdAt.toISOString(),
    updatedAt: session.updatedAt.toISOString(),
  };
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
}): Promise<SessionDetailPayload> {
  await ownedSession(input.ownerId, input.sessionId);
  const [track] = await db
    .select({ id: tracks.id })
    .from(tracks)
    .where(and(eq(tracks.id, input.trackId), eq(tracks.ownerId, input.ownerId)))
    .limit(1);
  if (track === undefined) throw new TrackNotInLibraryError();

  const existing = await loadSessionTracks(input.sessionId);
  const [item] = await db
    .insert(listenSessionTracks)
    .values({
      sessionId: input.sessionId,
      trackId: input.trackId,
      position: existing.length,
      stemMix: "{}",
      transition: JSON.stringify(defaultTransitionConfig()),
    })
    .returning({ id: listenSessionTracks.id });
  let ordered = [...existing.map((row) => row.id), item.id];
  if (input.position !== undefined) {
    const to = Math.min(Math.max(Math.trunc(input.position), 0), ordered.length - 1);
    const from = ordered.length - 1;
    ordered.splice(to, 0, ordered.splice(from, 1)[0]);
  }
  await resequence(input.sessionId, ordered);
  await touchSession(input.sessionId);
  return sessionPayload(input.sessionId);
}

async function resequence(sessionId: string, orderedIds: string[]): Promise<void> {
  await db.transaction(async (tx) => {
    for (const [index, id] of orderedIds.entries()) {
      await tx
        .update(listenSessionTracks)
        .set({ position: index })
        .where(and(eq(listenSessionTracks.id, id), eq(listenSessionTracks.sessionId, sessionId)));
    }
  });
}

async function sessionTrackIds(sessionId: string): Promise<string[]> {
  const rows = await db
    .select({ id: listenSessionTracks.id })
    .from(listenSessionTracks)
    .where(eq(listenSessionTracks.sessionId, sessionId))
    .orderBy(asc(listenSessionTracks.position));
  return rows.map((row) => row.id);
}

export async function removeSessionTrack(ownerId: string, sessionId: string, sessionTrackId: string): Promise<SessionDetailPayload> {
  await ownedSession(ownerId, sessionId);
  await db
    .delete(listenSessionTracks)
    .where(and(eq(listenSessionTracks.id, sessionTrackId), eq(listenSessionTracks.sessionId, sessionId)));
  await resequence(sessionId, await sessionTrackIds(sessionId));
  await touchSession(sessionId);
  return sessionPayload(sessionId);
}

export async function moveSessionTrack(
  ownerId: string,
  sessionId: string,
  sessionTrackId: string,
  position: number,
): Promise<SessionDetailPayload> {
  await ownedSession(ownerId, sessionId);
  const ids = await sessionTrackIds(sessionId);
  const from = ids.indexOf(sessionTrackId);
  if (from === -1) throw new SessionTrackNotFoundError();
  const to = Math.min(Math.max(Math.trunc(position), 0), ids.length - 1);
  ids.splice(to, 0, ids.splice(from, 1)[0]);
  await resequence(sessionId, ids);
  await touchSession(sessionId);
  return sessionPayload(sessionId);
}

// ------------------------------------------------------- mix / transition

export async function updateSessionTrack(
  ownerId: string,
  sessionId: string,
  sessionTrackId: string,
  patch: { stemMix?: unknown; transition?: unknown },
): Promise<SessionDetailPayload> {
  await ownedSession(ownerId, sessionId);
  const [row] = await db
    .select({ id: listenSessionTracks.id })
    .from(listenSessionTracks)
    .where(and(eq(listenSessionTracks.id, sessionTrackId), eq(listenSessionTracks.sessionId, sessionId)))
    .limit(1);
  if (row === undefined) throw new SessionTrackNotFoundError();

  const values: Partial<{ stemMix: string; transition: string }> = {};
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

  const validation = validateStemSwap(currentDetail.stems, donorDetail.stems, input.stemType);
  if (!validation.ok) throw new StemSwapRefusedError(validation.reason);

  await db.insert(listenSessionSwaps).values({
    sessionId: input.sessionId,
    sessionTrackId: input.sessionTrackId,
    stemType: input.stemType,
    fromTrackId: sessionTrack.trackId,
    toTrackId: input.toTrackId,
    atSeconds: Number.isFinite(input.atSeconds) && input.atSeconds > 0 ? input.atSeconds : 0,
  });
  await touchSession(input.sessionId);
  return sessionPayload(input.sessionId);
}

export async function removeStemSwap(ownerId: string, sessionId: string, swapId: string): Promise<SessionDetailPayload> {
  await ownedSession(ownerId, sessionId);
  await db
    .delete(listenSessionSwaps)
    .where(and(eq(listenSessionSwaps.id, swapId), eq(listenSessionSwaps.sessionId, sessionId)));
  return sessionPayload(sessionId);
}

// --------------------------------------------------------- studio handoff

export interface StudioHandoffResult {
  projectId: string;
  remixSessionId: string;
  remixTrackCount: number;
  refused?: string;
}

/**
 * "Send to Studio": derive an explicit Studio object from the session — a
 * new studio project + remix session whose tracks REFERENCE the session
 * tracks' existing stem assets (no copies, no mutations). Tracks without any
 * stem asset (separation never ran AND no passthrough bridge) are refused
 * honestly by name, because a remix track requires real audio to bind.
 */
export async function sendSessionToStudio(ownerId: string, sessionId: string): Promise<StudioHandoffResult> {
  await requireUser();
  const detail = await sessionPayload(sessionId);
  await ownedSession(ownerId, sessionId);

  const bindable: Array<{ sessionTrack: SessionTrackPayload; stemId: string; stemType: string }> = [];
  const refused: string[] = [];
  for (const sessionTrack of detail.tracks) {
    const trackDetail = await getTrack(ownerId, sessionTrack.track.id);
    if (trackDetail === null || trackDetail.stems.length === 0) {
      refused.push(sessionTrack.track.title);
      continue;
    }
    // Prefer a real separated stem set; fall back to the passthrough stem.
    const real = trackDetail.stems.find((stem) => stem.engine !== "passthrough-unseparated");
    const passthrough = trackDetail.stems.find((stem) => stem.engine === "passthrough-unseparated");
    const stem = real ?? passthrough;
    if (stem === undefined) {
      refused.push(sessionTrack.track.title);
      continue;
    }
    bindable.push({ sessionTrack, stemId: stem.id, stemType: stem.stemType });
  }
  if (bindable.length === 0) {
    throw new StemSwapRefusedError(
      `No session track has audio the Studio can bind (needs separated stems or the full-source bridge): ${refused.join(", ")}.`,
    );
  }

  const [project] = await db
    .insert(projects)
    .values({
      ownerId,
      title: `Session · ${detail.name}`,
      description: `Derived from listening session “${detail.name}” (${detail.tracks.length} tracks). Original tracks and stems are referenced, never copied or modified.`,
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
    for (const [index, entry] of bindable.entries()) {
      await tx.insert(remixTracks).values({
        remixSessionId: remix.id,
        stemAssetId: entry.stemId,
        name: `${entry.sessionTrack.track.title} — ${entry.stemType}`,
        sortOrder: index,
        volume: entry.sessionTrack.stemMix[entry.stemType] ?? 1,
      });
    }
  });

  return { projectId: project.id, remixSessionId: remix.id, remixTrackCount: bindable.length, refused: refused.length > 0 ? refused.join(", ") : undefined };
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
