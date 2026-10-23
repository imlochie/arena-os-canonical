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

import { sessionPlacements, sessionVolumePoints } from "./session-arrangement";
import { MAX_REMIX_TRACKS, MAX_REMIX_CLIPS_PER_TRACK } from "../remix";
import { db } from "@/db";
import {
  listenSessionSwaps,
  listenSessions,
  listenSessionTracks,
  projects,
  remixSessions,
  remixClips,
  remixAutomationPoints,
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
import { getTrack, type TrackDetail, type TrackStem, type TrackSummary, type AssetSelection } from "./service";

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
  banks: TrackDetail["banks"];
  selectionRequired: string | null;
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
  fromStemAssetId: string | null;
  toStemAssetId: string | null;
  id: string;
  sessionTrackId: string;
  stemType: string;
  fromTrackId: string;
  toTrackId: string;
  atSeconds: number;
  createdAt: string;
}

interface SessionTrackRow {
  assetSelection: string | null;
  id: string;
  trackId: string;
  position: number;
  stemMix: string;
  transition: string;
}

async function loadSessionTracks(sessionId: string): Promise<SessionTrackRow[]> {
  const rows = await db
    .select({
      assetSelection: listenSessionTracks.assetSelection,
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
    const parsed = row.assetSelection ? safeParse(row.assetSelection) as Partial<AssetSelection> | null : null;
    const selection: AssetSelection | undefined = row.assetSelection === null ? undefined : parsed && Array.isArray(parsed.assetIds) && parsed.assetIds.every(id => typeof id === "string") && (parsed.kind === "source" || parsed.kind === "stems") ? parsed as AssetSelection : {assetIds:[],kind:"stems"};
    const detail = await getTrack(session.ownerId, row.trackId, selection);
    if (detail !== null) details.set(row.id, detail);
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
      const detail = details.get(row.id) ?? null;
      const selectionRequired = row.assetSelection === null ? "This legacy or unresolved item needs an explicit bank/source choice. Saved levels and cues are preserved." : detail?.selectionRequired ?? null;
      const legacySwap = swapRows.some(swap => swap.sessionTrackId === row.id && (!swap.toStemAssetId || !swap.fromStemAssetId));
      const reason = legacySwap ? "A legacy swap has no exact asset identity. Remove and reselect that swap explicitly; its ledger is preserved." : selectionRequired;
      return {
        banks: detail?.banks ?? [],
        selectionRequired: reason,
        id: row.id,
        position: row.position,
        track: (detail as TrackSummary | null) ?? summaries.get(row.trackId) ?? failSummary(row.trackId),
        stems: selectionRequired ? [] : detail?.stems ?? [],
        playback: reason ? null : detail?.playback ?? null,
        stemMix: parseStemMix(row.stemMix),
        transition: normalizeTransitionConfig(safeParse(row.transition)) ?? defaultTransitionConfig(),
        analysis: analyses.get(row.id) ?? null,
      };
    }),
    swaps: swapRows.map((row) => ({
      fromStemAssetId: row.fromStemAssetId,
      toStemAssetId: row.toStemAssetId,
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
  bankId?: string;
  position?: number;
  /** Optional operation identity: retry one insertion, while intentional repeats
   * without this identity retain the established live-set semantics. */
  operationId?: string;
}): Promise<SessionDetailPayload> {
  await db.transaction(async tx => {
    const [session] = await tx.select().from(listenSessions).where(and(eq(listenSessions.id, input.sessionId), eq(listenSessions.ownerId, input.ownerId))).for("update");
    if (!session) throw new SessionNotFoundError();
    const [track] = await tx.select({ id: tracks.id }).from(tracks).where(and(eq(tracks.id, input.trackId), eq(tracks.ownerId, input.ownerId)));
    if (!track) throw new TrackNotInLibraryError();
    if (input.operationId) {
      const [previous] = await tx.select().from(listenSessionTracks).where(eq(listenSessionTracks.id, input.operationId));
      if (previous) {
        if (previous.sessionId !== input.sessionId || previous.trackId !== input.trackId) throw new StemSwapRefusedError("Session insertion identity belongs to a different item; no substitution allowed.");
        return;
      }
    }
    const selected = await getTrack(input.ownerId, input.trackId, input.bankId ? { bankId: input.bankId } : undefined);
    if (input.bankId && selected?.selectionRequired) throw new StemSwapRefusedError(selected.selectionRequired);
    const assetSelection = selected && !selected.selectionRequired ? JSON.stringify(selected.playback) : null;
    const existing = await tx.select({ id: listenSessionTracks.id }).from(listenSessionTracks).where(eq(listenSessionTracks.sessionId, input.sessionId)).orderBy(asc(listenSessionTracks.position));
    const [item] = await tx.insert(listenSessionTracks).values({ id: input.operationId, sessionId: input.sessionId, trackId: input.trackId, assetSelection, position: existing.length, stemMix: "{}", transition: JSON.stringify(defaultTransitionConfig()) }).returning({ id: listenSessionTracks.id });
    const ordered = [...existing.map(row => row.id), item.id];
    if (input.position !== undefined) {
      const to = Math.min(Math.max(Math.trunc(input.position), 0), ordered.length - 1);
      ordered.splice(to, 0, ordered.splice(ordered.length - 1, 1)[0]);
    }
    for (const [position, id] of ordered.entries()) await tx.update(listenSessionTracks).set({ position }).where(eq(listenSessionTracks.id, id));
    await tx.update(listenSessions).set({ updatedAt: new Date() }).where(eq(listenSessions.id, input.sessionId));
  });
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
  patch: { stemMix?: unknown; transition?: unknown; bankId?: string | null },
): Promise<SessionDetailPayload> {
  await ownedSession(ownerId, sessionId);
  const [row] = await db
    .select({ id: listenSessionTracks.id, trackId: listenSessionTracks.trackId })
    .from(listenSessionTracks)
    .where(and(eq(listenSessionTracks.id, sessionTrackId), eq(listenSessionTracks.sessionId, sessionId)))
    .limit(1);
  if (row === undefined) throw new SessionTrackNotFoundError();

  const values: Partial<{ stemMix: string; transition: string; assetSelection: string }> = {};
  if (patch.bankId !== undefined) {
    const selected = await getTrack(ownerId, row.trackId, patch.bankId === null ? undefined : { bankId: patch.bankId });
    if (!selected) throw new TrackNotInLibraryError();
    if (patch.bankId === null) {
      values.assetSelection = JSON.stringify({ kind: "source", assetIds: [selected.source.id] });
    } else {
      if (selected.selectionRequired) throw new StemSwapRefusedError(selected.selectionRequired);
      values.assetSelection = JSON.stringify(selected.playback);
    }
    const swaps = await db.select().from(listenSessionSwaps).where(eq(listenSessionSwaps.sessionTrackId, sessionTrackId));
    if (swaps.length) throw new StemSwapRefusedError("Remove the saved swaps explicitly before changing this item's bank; no swaps or cues were discarded.");
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
  toStemAssetId?: string;
  fromStemAssetId?: string;
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

  const payload = await sessionPayload(input.sessionId);
  const currentDetail = payload.tracks.find(item => item.id === input.sessionTrackId);
  if (currentDetail?.selectionRequired) throw new StemSwapRefusedError(currentDetail.selectionRequired);
  const donorDetail = await getTrack(input.ownerId, input.toTrackId);
  const candidates = donorDetail?.banks.flatMap(bank => bank.stems).filter(stem => stem.stemType === input.stemType && (!input.toStemAssetId || stem.id === input.toStemAssetId)) ?? [];
  const donorStem = candidates.length === 1 ? candidates[0] : undefined;
  if (!donorStem) throw new StemSwapRefusedError("Choose the exact donor stem asset from one published bank; no substitute was selected.");
  if (!currentDetail || !donorDetail) throw new TrackNotInLibraryError();

  const validation = validateStemSwap(currentDetail.stems, [donorStem], input.stemType);
  if (!validation.ok) throw new StemSwapRefusedError(validation.reason);

  await db.transaction(async tx => {
    // Preserve the existing provenance/Studio ranges. The last acknowledged
    // selection per category is active, including an explicit return to A.
    // This is not a complete recording/replay of performed gestures.
    const [member] = await tx.select({ id: listenSessionTracks.id, assetSelection: listenSessionTracks.assetSelection }).from(listenSessionTracks)
      .where(and(eq(listenSessionTracks.id, input.sessionTrackId), eq(listenSessionTracks.sessionId, input.sessionId))).for("update");
    if (!member) throw new SessionTrackNotFoundError();
    let lockedAssets: unknown = null;
    try { lockedAssets = member.assetSelection ? JSON.parse(member.assetSelection).assetIds : null; } catch { /* Invalid saved identity is refused below, never guessed. */ }
    if (input.fromStemAssetId && (currentDetail.stems.find(stem => stem.stemType === input.stemType)?.id !== input.fromStemAssetId || (member.assetSelection && (!Array.isArray(lockedAssets) || !lockedAssets.includes(input.fromStemAssetId))))) throw new StemSwapRefusedError("The target source bank changed. The old selection was not saved; reopen the current bank and choose again.");
    await tx.insert(listenSessionSwaps).values({
      sessionId: input.sessionId,
      sessionTrackId: input.sessionTrackId,
      stemType: input.stemType,
      fromStemAssetId: currentDetail.stems.find(stem => stem.stemType === input.stemType)!.id,
      toStemAssetId: donorStem.id,
      fromTrackId: sessionTrack.trackId,
      toTrackId: input.toTrackId,
      atSeconds: Number.isFinite(input.atSeconds) && input.atSeconds > 0 ? input.atSeconds : 0,
    });
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
  notice: string;
}

/**
 * "Send to Studio": derive an explicit Studio object from the session — a
 * new studio project + remix session whose tracks REFERENCE the session
 * tracks' existing stem assets (no copies, no mutations). Tracks without any
 * stem asset (separation never ran AND no passthrough bridge) are refused
 * honestly by name, because a remix track requires real audio to bind.
 */
export type StudioHandoffTrackEdit = { id: string; stemMix: StemMix; transition: TransitionConfig };

export async function sendSessionToStudio(ownerId: string, sessionId: string, trackEdits: StudioHandoffTrackEdit[] = [], mode: "sequential" | "transitions" = "sequential"): Promise<StudioHandoffResult> {
  await requireUser();
  await ownedSession(ownerId, sessionId);
  const detail = await sessionPayload(sessionId);
  if (detail.tracks.some(item => item.selectionRequired)) throw new StemSwapRefusedError("Resolve each bank or legacy swap selection before exporting. Existing work is unchanged.");
  // Capture the visible controls with the handoff, not a possibly stale
  // 600ms-debounced database state. Validate the whole snapshot before writes.
  const seen = new Set<string>();
  for (const edit of trackEdits) {
    const item = detail.tracks.find((track) => track.id === edit.id);
    const transition = normalizeTransitionConfig(edit.transition);
    const stemMix = normalizeStemMix(edit.stemMix);
    if (!item || seen.has(edit.id) || !transition || Object.keys(stemMix).length !== Object.keys(edit.stemMix).length)
      throw new StemSwapRefusedError("The handoff edit snapshot is invalid or no longer belongs to this session. Reload and try again.");
    seen.add(edit.id);
    item.stemMix = stemMix;
    item.transition = transition;
  }

  const refused: string[] = [];
  const lanes: Array<{
    stemAssetId: string; name: string; volume: number;
    points?: Array<{ timelineMs: number; value: number }>;
    clips: Array<{ stemAssetId: string; timelineStartMs: number; sourceOffsetMs: number; durationMs: number }>;
  }> = [];
  let placements: ReturnType<typeof sessionPlacements> | undefined;
  if (mode === "transitions") {
    try { placements = sessionPlacements(detail.tracks.map((item) => ({ id: item.id, durationSeconds: item.track.durationSeconds, transition: item.transition }))); }
    catch (error) { throw new StemSwapRefusedError(error instanceof Error ? error.message : "Invalid completed transitions."); }
  }
  let timelineMs = 0;
  for (const [itemIndex, item] of detail.tracks.entries()) {
    const placement = placements?.[itemIndex];
    if (placement) timelineMs = placement.timelineStartMs;
    const separated = item.stems.filter((stem) => stem.engine !== "passthrough-unseparated");
    const selected = separated.length ? separated : item.stems.filter((stem) => stem.engine === "passthrough-unseparated").slice(0, 1);
    if (!selected.length) {
      refused.push(`“${item.track.title}” has no stems or explicit unseparated-source bridge.`);
      continue;
    }
    const durationMs = placement?.sourceEndMs ?? Math.floor(item.track.durationSeconds * 1000);
    const sourceStartMs = placement?.sourceStartMs ?? 0;
    if (durationMs <= 0) {
      refused.push(`“${item.track.title}” has no usable duration.`);
      continue;
    }
    if (timelineMs + durationMs > 86_400_000) throw new StemSwapRefusedError("This arrangement exceeds Studio’s 24-hour timeline limit. Send a shorter session. Nothing was created.");
    const itemLanes: typeof lanes = [];
    let invalid: string | undefined;
    for (const stem of selected) {
      const swaps = detail.swaps.filter((swap) => swap.sessionTrackId === item.id && swap.stemType === stem.stemType)
        .sort((a, b) => a.atSeconds - b.atSeconds);
      const changes = [{ at: 0, stemAssetId: stem.id }];
      for (const swap of swaps) {
        const donor = await getTrack(ownerId, swap.toTrackId);
        const donorStem = donor?.banks.flatMap(bank => bank.stems).find(candidate => candidate.id === swap.toStemAssetId && candidate.stemType === stem.stemType);
        if (!donorStem) { invalid = `a saved ${stem.stemType} swap donor is unavailable`; break; }
        const at = Math.round(swap.atSeconds * 1000);
        if (at < durationMs) changes.push({ at, stemAssetId: donorStem.id });
      }
      if (invalid) break;
      const clips = changes.flatMap((change, index) => {
        const end = changes[index + 1]?.at ?? durationMs;
        const start = Math.max(sourceStartMs, change.at);
        return end > start ? [{ stemAssetId: change.stemAssetId, timelineStartMs: timelineMs + start - sourceStartMs, sourceOffsetMs: start, durationMs: end - start }] : [];
      });
      if (clips.length > MAX_REMIX_CLIPS_PER_TRACK) throw new StemSwapRefusedError(`A stem lane exceeds Studio’s ${MAX_REMIX_CLIPS_PER_TRACK}-clip limit. Use a session with fewer swaps. Nothing was created.`);
      const assets = await db.select().from(stemAssets).where(inArray(stemAssets.id, [...new Set(clips.map((clip) => clip.stemAssetId))]));
      if (clips.some((clip) => {
        const asset = assets.find((candidate) => candidate.id === clip.stemAssetId);
        return !asset || !Number.isFinite(asset.durationSeconds) || clip.sourceOffsetMs + clip.durationMs > asset.durationSeconds * 1000;
      })) { invalid = `a saved stem or swap is missing or shorter than its timeline range`; break; }
      itemLanes.push({ stemAssetId: stem.id, name: `${item.track.title} — ${stem.stemType}`, volume: item.stemMix[stem.stemType] ?? 1, clips, ...(placement ? { points: sessionVolumePoints(placement, stem.stemType, item.stemMix[stem.stemType] ?? 1) } : {}) });
    }
    if (invalid) { refused.push(`“${item.track.title}”: ${invalid}.`); continue; }
    lanes.push(...itemLanes);
    timelineMs += durationMs;
  }
  if (mode === "transitions" && refused.length) throw new StemSwapRefusedError(`Cannot preserve this arrangement: ${refused.join(" ")} Nothing was created; repair the unavailable audio or explicitly choose a sequential edit.`);
  if (!lanes.length) throw new StemSwapRefusedError(
    `No session track can be sent to Studio. ${refused.join(" ")} Original sources are untouched.`,
  );
  // This is the existing arrangement persistence limit, not a silent truncation.
  if (lanes.length > MAX_REMIX_TRACKS) throw new StemSwapRefusedError(
    `This session needs ${lanes.length} stem lanes; Studio currently supports ${MAX_REMIX_TRACKS}. Send a smaller session. Nothing was created.`,
  );
  const { project, remix } = await db.transaction(async (tx) => {
    for (const id of seen) {
      const item = detail.tracks.find((track) => track.id === id)!;
      await tx.update(listenSessionTracks).set({ stemMix: serializeStemMix(item.stemMix), transition: JSON.stringify(item.transition) })
        .where(and(eq(listenSessionTracks.id, id), eq(listenSessionTracks.sessionId, sessionId)));
    }
    if (seen.size) await tx.update(listenSessions).set({ updatedAt: new Date() }).where(eq(listenSessions.id, sessionId));
    const [project] = await tx.insert(projects).values({
      ownerId, title: `Session — ${detail.name}`, kind: "studio",
      description: mode === "transitions"
        ? `Derived from listening session “${detail.name}” (${sessionId}). Completed transition cues, source ranges, saved mixes and donor swaps preserved with remix clips/automation. Provenance: ${JSON.stringify({ sessionId, cursor: { sessionTrackId: detail.currentSessionTrackId, positionSeconds: detail.positionSeconds }, transitions: detail.tracks.map((item) => ({ sessionTrackId: item.id, trackId: item.track.id, transition: item.transition })) })}. Cursor is a source-session bookmark, not an instruction to start playback. Original audio is referenced, not copied.`
        : `Derived from listening session “${detail.name}” (${sessionId}). Sequential-v1 clips preserve stem levels and timed swaps; live transition timing and crossfades are not recorded. Original audio is referenced, not copied.`,
    }).returning();
    const [remix] = await tx.insert(remixSessions).values({ projectId: project.id, ownerId, name: detail.name }).returning();
    for (const [sortOrder, lane] of lanes.entries()) {
      const [track] = await tx.insert(remixTracks).values({
        remixSessionId: remix.id, stemAssetId: lane.stemAssetId, name: lane.name, volume: lane.volume, sortOrder,
      }).returning();
      await tx.insert(remixClips).values(lane.clips.map((clip) => ({ ...clip, remixTrackId: track.id, gain: 1 })));
      if (lane.points?.length) await tx.insert(remixAutomationPoints).values(lane.points.map((point) => ({ ...point, remixSessionId: remix.id, remixTrackId: track.id, parameter: "volume" })));
    }
    return { project, remix };
  });
  return {
    projectId: project.id, remixSessionId: remix.id, remixTrackCount: lanes.length,
    notice: (mode === "transitions" ? "Completed transitions, source ranges, stem levels and timed donor swaps are preserved as Studio clips and volume automation. The source cursor is retained as provenance, not live playback. Pauses, seeks, cancelled/forced-shortened fades and mix gestures are not a performance recording." : "Created a sequential arrangement with saved stem levels and timed swaps. Live transition triggers, crossfades and the playback cursor are not recorded into this arrangement; edit transitions in Studio. Original sources and the listening session are unchanged.") + " Full-length endpoints use Studio’s integer-millisecond grid, rounding down by less than 1 ms to stay within the decoded asset. Original stem files retain every sample.",
    ...(refused.length ? { refused: refused.join(" ") } : {}),
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
