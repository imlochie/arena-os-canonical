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

import { randomUUID } from "node:crypto";
import { and, asc, count, desc, eq, inArray, ne } from "drizzle-orm";
import { extname } from "node:path";

import { db } from "@workspace/db";
import {
  currentBeatConfidence,
  currentBpmConfidence,
  currentKeyConfidence,
  isCurrentDesktopAnalysis,
} from "../types/analysis-provenance";
import { hasReliableMixingConfidence } from "../types/analysis-confidence";
import {
  listenSessionSwaps,
  listenSessions,
  listenSessionTracks,
  queueItems,
  projects,
  drumAnalyses,
  drumEvents,
  bassAnalyses,
  bassEvents,
  remixClips,
  remixSessions,
  remixTracks,
  sourceAssets,
  sourceAnalyses,
  sourceAcquisitions,
  sourceSectionAnalyses,
  sourceSections,
  stemAssets,
  tracks,
  vocalAnalyses,
  vocalActivityIntervals,
  vocalPhrases,
  waveformAssets,
  waveformJobs,
} from "@workspace/db/waveyardSchema";
import { requireUser } from "@workspace/arena/lib/waveyard/local-context";
import { checksumFile, probeAudio, sanitizedFilename } from "@workspace/arena/lib/waveyard/audio";
import { getStorage, privateObjectKey } from "../storage";
import { sourceObjectLockQuery } from "../source-object-lock";
import { desktopAnalysisIdempotencyKey, DESKTOP_ANALYSIS_ENGINE, DESKTOP_ANALYSIS_ENGINE_VERSION } from "../types/analysis-provenance";
import { enqueueSourceAnalysis, enqueueWaveform } from "../queue";
import { sourceSectionsAreValid, type SourceSection } from "../types/source-sections";
import { parsePassageFingerprint } from "../types/passage-compatibility";
import { hasReliableSessionDownbeatEvidence } from "../session-dj-controls";
import {
  LOCAL_VOCAL_ANALYSIS_ENGINE,
  LOCAL_VOCAL_ANALYSIS_ENGINE_VERSION,
  vocalAnalysisProvenanceReason,
} from "../types/vocal-analysis";
import {
  LOCAL_DRUM_ANALYSIS_ENGINE,
  LOCAL_DRUM_ANALYSIS_ENGINE_VERSION,
  drumAnalysisProvenanceReason,
  normaliseIsolatedDrumTempoEvidence,
  type IsolatedDrumTempoEvidence,
} from "../types/drum-analysis";
import {
  LOCAL_BASS_ANALYSIS_ENGINE,
  LOCAL_BASS_ANALYSIS_ENGINE_VERSION,
  bassAnalysisProvenanceReason,
} from "../types/bass-analysis";
import {
  measureStemGroove,
  type GrooveOnset,
  type StemGrooveEvidence,
} from "../types/stem-groove";
import { ensureLocalDrumTempoAnalysis } from "../drum-analysis";
import {
  normalizeStemMix,
  parseStemMix,
  serializeStemMix,
  withUnityDefaults,
  type StemMix,
} from "./model";
import {
  beatAlignedTransitionStart,
  completeInstrumentalBedDonorTrackId,
  defaultTransitionConfig,
  hasReliableLiveStemBeatEvidence,
  hasReliableLiveStemTempoEvidence,
  liveStemBeatOffsetSeconds,
  liveStemGrooveCorrection,
  liveStemTempoStretchRatio,
  normalizeTransitionConfig,
  resolveLiveDrumTempoMaster,
  selectLiveTempoAnalysis,
  validateStemSwap,
  type TransitionConfig,
  type LiveStemGrooveCorrection,
} from "./session-logic";
import {
  normalizeSessionKeyMode,
  resolveInstrumentalBedVocalCorrection,
  type SessionKeyMode,
  type SessionKeyShifts,
} from "./session-key-matching";
import { normaliseMusicalKey } from "../types/musical-key";
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
  keyMatchMode: SessionKeyMode;
  keyShifts: SessionKeyShifts;
  tracks: SessionTrackPayload[];
  swaps: SessionSwapPayload[];
  createdAt: string;
  updatedAt: string;
}

function parseSessionKeyShifts(
  serialized: string | null | undefined,
  tracks: Array<{ id: string; trackId: string }>,
): SessionKeyShifts {
  let parsed: unknown;
  try {
    parsed = JSON.parse(serialized ?? "{}");
  } catch {
    return {};
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return {};
  const trackBySessionId = new Map(tracks.map((track) => [track.id, track.trackId]));
  const shifts: SessionKeyShifts = {};
  for (const [sessionTrackId, value] of Object.entries(parsed)) {
    if (value === null || typeof value !== "object" || Array.isArray(value)) continue;
    const shift = value as { trackId?: unknown; semitones?: unknown };
    if (
      trackBySessionId.get(sessionTrackId) !== shift.trackId
      || typeof shift.trackId !== "string"
      || typeof shift.semitones !== "number"
      || !Number.isInteger(shift.semitones)
      || shift.semitones < -11
      || shift.semitones > 11
    ) continue;
    shifts[sessionTrackId] = { trackId: shift.trackId, semitones: shift.semitones };
  }
  return shifts;
}

function serializeSessionKeyShifts(
  shifts: SessionKeyShifts,
  tracks: Array<{ id: string; trackId: string }>,
): string {
  return JSON.stringify(parseSessionKeyShifts(JSON.stringify(shifts), tracks));
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
  donorEntryOffsetMs: number | null;
  grooveAnchorTrackId: string | null;
  grooveAnchorStemAssetId: string | null;
  /** Same-role persisted onset comparison for small live phase corrections. */
  grooveCorrection: LiveStemGrooveCorrection | null;
  createdAt: string;
  donorTrack: { id: string; title: string; durationSeconds: number; stems: TrackStem[]; analysis: SessionTrackAnalysis | null } | null;
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

function canonicalGrooveRole(stemType: string): "drums" | "bass" | null {
  if (stemType === "drums" || stemType === "percussion") return "drums";
  return stemType === "bass" ? "bass" : null;
}

async function currentStemGrooveEvidence(
  detail: TrackDetail,
  stemAssetId: string | null,
  role: "drums" | "bass",
  analysis: SessionTrackAnalysis | null,
): Promise<StemGrooveEvidence> {
  const unavailable = (reason: string): StemGrooveEvidence => ({ role, status: "unavailable", reason });
  if (stemAssetId === null || analysis === null) return unavailable("The exact saved stem or track analysis is unavailable.");
  const listedStem = detail.stems.find((stem) => stem.id === stemAssetId);
  if (!listedStem || listedStem.engine === "passthrough-unseparated"
    || canonicalGrooveRole(listedStem.stemType) !== role) {
    return unavailable("The saved stem identity does not match this musical role.");
  }
  const [source] = await db.select({
    id: sourceAssets.id,
    projectId: sourceAssets.projectId,
    checksumSha256: sourceAssets.checksumSha256,
  }).from(sourceAssets).where(and(
    eq(sourceAssets.id, detail.source.id),
    eq(sourceAssets.projectId, detail.studioProjectId),
  )).limit(1);
  if (!source?.checksumSha256) return unavailable("The current source checksum is unavailable.");
  const [stem] = await db.select({
    id: stemAssets.id,
    projectId: stemAssets.projectId,
    sourceAssetId: stemAssets.sourceAssetId,
    stemType: stemAssets.stemType,
    checksumSha256: stemAssets.checksumSha256,
  }).from(stemAssets).where(and(
    eq(stemAssets.id, stemAssetId),
    eq(stemAssets.sourceAssetId, source.id),
    eq(stemAssets.projectId, source.projectId),
  )).limit(1);
  if (!stem || canonicalGrooveRole(stem.stemType) !== role) {
    return unavailable("The exact stem row is missing or no longer belongs to the source.");
  }

  let events: GrooveOnset[];
  if (role === "drums") {
    const [row] = await db.select({
      id: drumAnalyses.id,
      projectId: drumAnalyses.projectId,
      sourceAssetId: drumAnalyses.sourceAssetId,
      stemAssetId: drumAnalyses.stemAssetId,
      sourceChecksumSha256: drumAnalyses.sourceChecksumSha256,
      stemChecksumSha256: drumAnalyses.stemChecksumSha256,
      status: drumAnalyses.status,
      analysisEngine: drumAnalyses.analysisEngine,
      analysisEngineVersion: drumAnalyses.analysisEngineVersion,
    }).from(drumAnalyses).where(and(
      eq(drumAnalyses.sourceAssetId, source.id),
      eq(drumAnalyses.stemAssetId, stem.id),
      eq(drumAnalyses.status, "complete"),
    )).limit(1);
    if (!row) return unavailable("No completed drum-onset analysis exists for this exact stem.");
    if (row.projectId !== source.projectId) return unavailable("Drum-onset analysis belongs to a different project.");
    const staleReason = drumAnalysisProvenanceReason({
      sourceAssetId: row.sourceAssetId,
      expectedSourceAssetId: source.id,
      stemAssetId: row.stemAssetId,
      expectedStemAssetId: stem.id,
      sourceChecksumSha256: row.sourceChecksumSha256,
      expectedSourceChecksumSha256: source.checksumSha256,
      stemChecksumSha256: row.stemChecksumSha256,
      expectedStemChecksumSha256: stem.checksumSha256,
      analysisEngine: row.analysisEngine,
      analysisEngineVersion: row.analysisEngineVersion,
    }, { engine: LOCAL_DRUM_ANALYSIS_ENGINE, version: LOCAL_DRUM_ANALYSIS_ENGINE_VERSION });
    if (staleReason !== null) return unavailable(`Drum-onset provenance is not current (${staleReason}).`);
    const rows = await db.select({
      timestampMs: drumEvents.timestampMs,
      strength: drumEvents.strength,
      confidence: drumEvents.confidence,
    }).from(drumEvents).where(eq(drumEvents.drumAnalysisId, row.id))
      .orderBy(asc(drumEvents.timestampMs)).limit(16_385);
    if (rows.length > 16_384) return unavailable("Drum-onset evidence exceeds the safe analysis bound.");
    events = rows;
  } else {
    const [row] = await db.select({
      id: bassAnalyses.id,
      projectId: bassAnalyses.projectId,
      sourceAssetId: bassAnalyses.sourceAssetId,
      stemAssetId: bassAnalyses.stemAssetId,
      sourceChecksumSha256: bassAnalyses.sourceChecksumSha256,
      stemChecksumSha256: bassAnalyses.stemChecksumSha256,
      status: bassAnalyses.status,
      analysisEngine: bassAnalyses.analysisEngine,
      analysisEngineVersion: bassAnalyses.analysisEngineVersion,
    }).from(bassAnalyses).where(and(
      eq(bassAnalyses.sourceAssetId, source.id),
      eq(bassAnalyses.stemAssetId, stem.id),
      eq(bassAnalyses.status, "complete"),
    )).limit(1);
    if (!row) return unavailable("No completed bass-attack analysis exists for this exact stem.");
    if (row.projectId !== source.projectId) return unavailable("Bass-attack analysis belongs to a different project.");
    const staleReason = bassAnalysisProvenanceReason({
      sourceAssetId: row.sourceAssetId,
      expectedSourceAssetId: source.id,
      stemAssetId: row.stemAssetId,
      expectedStemAssetId: stem.id,
      sourceChecksumSha256: row.sourceChecksumSha256,
      expectedSourceChecksumSha256: source.checksumSha256,
      stemChecksumSha256: row.stemChecksumSha256,
      expectedStemChecksumSha256: stem.checksumSha256,
      analysisEngine: row.analysisEngine,
      analysisEngineVersion: row.analysisEngineVersion,
    });
    if (staleReason !== null) return unavailable(`Bass-attack provenance is not current (${staleReason}).`);
    const rows = await db.select({
      timestampMs: bassEvents.timestampMs,
      strength: bassEvents.strength,
      confidence: bassEvents.confidence,
    }).from(bassEvents).where(eq(bassEvents.bassAnalysisId, row.id))
      .orderBy(asc(bassEvents.timestampMs)).limit(16_385);
    if (rows.length > 16_384) return unavailable("Bass-attack evidence exceeds the safe analysis bound.");
    events = rows;
  }

  const isolatedDrumGrid = role === "drums" ? analysis.isolatedDrumTempo : null;
  return measureStemGroove(
    role,
    events,
    isolatedDrumGrid?.beatGridMs ?? analysis.beatGridMs,
    isolatedDrumGrid?.beatConfidence ?? analysis.beatConfidence,
  );
}

async function liveSwapGrooveCorrection(input: {
  stemType: string;
  recipient: TrackDetail | null;
  recipientStemAssetId: string | null;
  recipientAnalysis: SessionTrackAnalysis | null;
  donor: TrackDetail | null;
  donorStemAssetId: string | null;
  donorAnalysis: SessionTrackAnalysis | null;
  atSeconds: number;
  evidenceCache: Map<string, Promise<StemGrooveEvidence>>;
}): Promise<LiveStemGrooveCorrection | null> {
  const role = canonicalGrooveRole(input.stemType);
  if (role === null) return null;
  const unavailable = (reason: string) => liveStemGrooveCorrection(
    { role, status: "unavailable", reason },
    { role, status: "unavailable", reason },
    { bedRatio: 1, donorRatio: 1, sourceOffsetMs: 0, entryMs: 0, endMs: 1 },
  );
  if (!input.recipient || !input.donor || !input.recipientAnalysis || !input.donorAnalysis
    || !Number.isFinite(input.atSeconds) || input.atSeconds < 0) {
    return unavailable("The live swap does not have complete recipient and donor analysis.");
  }
  const getEvidence = (detail: TrackDetail, stemAssetId: string | null, analysis: SessionTrackAnalysis | null) => {
    const key = `${detail.source.id}:${stemAssetId ?? "missing"}:${role}`;
    let result = input.evidenceCache.get(key);
    if (!result) {
      result = currentStemGrooveEvidence(detail, stemAssetId, role, analysis);
      input.evidenceCache.set(key, result);
    }
    return result;
  };
  const [recipientGroove, donorGroove] = await Promise.all([
    getEvidence(input.recipient, input.recipientStemAssetId, input.recipientAnalysis),
    getEvidence(input.donor, input.donorStemAssetId, input.donorAnalysis),
  ]);
  const selectTempo = (analysis: SessionTrackAnalysis) => selectLiveTempoAnalysis({
    bpm: analysis.bpm,
    bpmConfidence: analysis.bpmConfidence,
    beatConfidence: analysis.beatConfidence,
    beatGridMs: analysis.beatGridMs,
    isolatedDrumTempo: analysis.isolatedDrumTempo,
  });
  const recipientTempo = selectTempo(input.recipientAnalysis);
  const donorTempo = selectTempo(input.donorAnalysis);
  const timingEvidence = {
    recipientBpmConfidence: recipientTempo.bpmConfidence,
    donorBpmConfidence: donorTempo.bpmConfidence,
    recipientBeatConfidence: recipientTempo.beatConfidence,
    donorBeatConfidence: donorTempo.beatConfidence,
  };
  const ratio = liveStemTempoStretchRatio(recipientTempo.bpm, donorTempo.bpm, timingEvidence);
  if (ratio === null) return unavailable("No reliable tempo transform supports a live groove comparison.");
  const beatOffset = liveStemBeatOffsetSeconds(recipientTempo.beatGridMs, donorTempo.beatGridMs, ratio);
  if (beatOffset === null) return unavailable("A reliable recipient-to-donor beat phase is unavailable.");
  const entryMs = input.atSeconds * 1000;
  return liveStemGrooveCorrection(recipientGroove, donorGroove, {
    bedRatio: 1,
    donorRatio: ratio,
    sourceOffsetMs: entryMs + beatOffset * 1000,
    entryMs,
    endMs: entryMs + 16_000,
  });
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
  const keyShifts = parseSessionKeyShifts(session.keyShifts, trackRows);
  const sanitizedKeyShifts = JSON.stringify(keyShifts);
  if (sanitizedKeyShifts !== session.keyShifts) {
    // Compare-and-swap so pruning removed/replaced entries can never overwrite
    // a concurrent, newer key-mode save.
    await db.update(listenSessions)
      .set({ keyShifts: sanitizedKeyShifts })
      .where(and(
        eq(listenSessions.id, sessionId),
        eq(listenSessions.keyShifts, session.keyShifts),
      ));
  }
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
  const referencedTrackIds = new Set(swapRows.flatMap((row) => [
    row.toTrackId,
    row.grooveAnchorTrackId ?? row.fromTrackId,
  ]));
  for (const referencedTrackId of referencedTrackIds) {
    if (!details.has(referencedTrackId)) {
      const referenced = await getTrack(session.ownerId, referencedTrackId);
      if (referenced) details.set(referencedTrackId, referenced);
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
  const donorAnalyses = new Map<string, Promise<SessionTrackAnalysis | null>>();
  const analysisForDonor = (trackId: string) => {
    let analysis = donorAnalyses.get(trackId);
    if (!analysis) {
      analysis = sessionTrackAnalysis(session.ownerId, trackId);
      donorAnalyses.set(trackId, analysis);
    }
    return analysis;
  };
  const grooveEvidenceCache = new Map<string, Promise<StemGrooveEvidence>>();
  return {
    id: session.id,
    name: session.name,
    currentSessionTrackId: session.currentTrackId,
    positionSeconds: session.positionSeconds,
    keyMatchMode: normalizeSessionKeyMode(session.keyMatchMode),
    keyShifts,
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
    swaps: await Promise.all(swapRows.map(async (row) => {
      const recipientRow = trackRows.find((track) => track.id === row.sessionTrackId);
      const recipientDetail = recipientRow ? details.get(recipientRow.trackId) ?? null : null;
      const recipientAnalysis = recipientRow ? analyses.get(recipientRow.id) ?? null : null;
      const grooveAnchorTrackId = row.grooveAnchorTrackId ?? row.fromTrackId;
      const grooveAnchorStemAssetId = row.grooveAnchorStemAssetId ?? row.fromStemAssetId;
      const grooveAnchorDetail = details.get(grooveAnchorTrackId) ?? null;
      const grooveAnchorAnalysis = grooveAnchorTrackId === row.fromTrackId
        ? recipientAnalysis
        : await analysisForDonor(grooveAnchorTrackId);
      const donorDetail = details.get(row.toTrackId) ?? null;
      const donorAnalysis = donorDetail ? await analysisForDonor(row.toTrackId) : null;
      return {
        id: row.id,
        sessionTrackId: row.sessionTrackId,
        stemType: row.stemType,
        fromTrackId: row.fromTrackId,
        toTrackId: row.toTrackId,
        fromStemAssetId: row.fromStemAssetId,
        toStemAssetId: row.toStemAssetId,
        atSeconds: row.atSeconds,
        donorEntryOffsetMs: row.donorEntryOffsetMs,
        grooveAnchorTrackId: row.grooveAnchorTrackId,
        grooveAnchorStemAssetId: row.grooveAnchorStemAssetId,
        grooveCorrection: await liveSwapGrooveCorrection({
          stemType: row.stemType,
          recipient: grooveAnchorDetail ?? recipientDetail,
          recipientStemAssetId: grooveAnchorStemAssetId,
          recipientAnalysis: grooveAnchorAnalysis,
          donor: donorDetail,
          donorStemAssetId: row.toStemAssetId,
          donorAnalysis,
          atSeconds: row.atSeconds,
          evidenceCache: grooveEvidenceCache,
        }),
        createdAt: row.createdAt.toISOString(),
        donorTrack: donorDetail ? {
          id: row.toTrackId,
          title: donorDetail.title,
          durationSeconds: donorDetail.durationSeconds,
          stems: donorDetail.stems,
          analysis: donorAnalysis,
        } : null,
      };
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
  let restoreWork: {
    reanalysis: {
      id: string;
      projectId: string;
      sourceAssetId: string;
      analysisEngine: string;
      analysisEngineVersion: string;
    } | null;
    replacementWaveformJobId: string | null;
    obsoleteWaveformKeys: string[];
  } = { reanalysis: null, replacementWaveformJobId: null, obsoleteWaveformKeys: [] };
  try {
    restoreWork = await db.transaction(async (tx) => {
      let reanalysis: typeof restoreWork.reanalysis = null;
      let replacementWaveformJobId: string | null = null;
      const obsoleteWaveformKeys: string[] = [];
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

      // A byte-identical restore keeps its existing source-derived evidence.
      // A replacement with different bytes invalidates source analysis and
      // source waveforms only; retained stem files and their waveforms remain.
      if (current.checksumSha256 !== checksum) {
        const obsoleteWaveforms = await tx
          .select({ storageKey: waveformAssets.storageKey })
          .from(waveformAssets)
          .where(eq(waveformAssets.sourceAssetId, current.id));
        obsoleteWaveformKeys.push(...obsoleteWaveforms.map((asset) => asset.storageKey));
        await tx.delete(waveformAssets).where(eq(waveformAssets.sourceAssetId, current.id));

        await tx.update(waveformJobs).set({
          status: "cancelled",
          stage: "source-replaced",
          errorCode: "source_replaced",
          errorMessage: "The source audio changed before this waveform could be used.",
          completedAt: new Date(),
          updatedAt: new Date(),
        }).where(and(
          eq(waveformJobs.sourceAssetId, current.id),
          ne(waveformJobs.status, "complete"),
          ne(waveformJobs.status, "cancelled"),
        ));
        await tx.update(sourceSectionAnalyses).set({
          status: "cancelled",
          stage: "source-replaced",
          errorCode: "source_replaced",
          errorMessage: "The source audio changed before this structural analysis could be used.",
          completedAt: new Date(),
          updatedAt: new Date(),
        }).where(eq(sourceSectionAnalyses.sourceAssetId, current.id));
        await tx.delete(sourceSections).where(eq(sourceSections.sourceAssetId, current.id));

        const analysisValues = {
          status: "queued",
          stage: "queued",
          attempts: 0,
          idempotencyKey: desktopAnalysisIdempotencyKey(current.id),
          analysisEngine: DESKTOP_ANALYSIS_ENGINE,
          analysisEngineVersion: DESKTOP_ANALYSIS_ENGINE_VERSION,
          sourceChecksumSha256: checksum,
          bpm: null,
          bpmConfidence: null,
          musicalKey: null,
          keyConfidence: null,
          beatGrid: null,
          beatConfidence: null,
          downbeatGrid: null,
          downbeatConfidence: null,
          analysisError: null,
          errorCode: null,
          startedAt: null,
          analyzedAt: null,
          completedAt: null,
          updatedAt: new Date(),
        };
        const [analysis] = await tx
          .insert(sourceAnalyses)
          .values({
            projectId: entry.projectId,
            sourceAssetId: current.id,
            ...analysisValues,
          })
          .onConflictDoUpdate({
            target: sourceAnalyses.sourceAssetId,
            set: analysisValues,
          })
          .returning({
            id: sourceAnalyses.id,
            analysisEngine: sourceAnalyses.analysisEngine,
            analysisEngineVersion: sourceAnalyses.analysisEngineVersion,
          });
        reanalysis = {
          id: analysis.id,
          projectId: entry.projectId,
          sourceAssetId: current.id,
          analysisEngine: analysis.analysisEngine,
          analysisEngineVersion: analysis.analysisEngineVersion,
        };

        const [waveformJob] = await tx
          .insert(waveformJobs)
          .values({
            projectId: entry.projectId,
            sourceAssetId: current.id,
            status: "queued",
            stage: "queued",
            idempotencyKey: `waveform:source:${current.id}:restore:${checksum}:${randomUUID()}`,
          })
          .returning({ id: waveformJobs.id });
        replacementWaveformJobId = waveformJob.id;
      }
      return { reanalysis, replacementWaveformJobId, obsoleteWaveformKeys };
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
  for (const obsoleteKey of restoreWork.obsoleteWaveformKeys) {
    await storage.delete(obsoleteKey).catch(() => undefined);
  }
  const { reanalysis, replacementWaveformJobId } = restoreWork;
  if (replacementWaveformJobId !== null && reanalysis !== null) {
    try {
      await enqueueWaveform({
        waveformJobId: replacementWaveformJobId,
        projectId: reanalysis.projectId,
        sourceAssetId: reanalysis.sourceAssetId,
      });
    } catch (error) {
      await db.update(waveformJobs).set({
        status: "failed",
        stage: "queue-unavailable",
        errorCode: "queue_unavailable",
        errorMessage: error instanceof Error ? error.message.slice(0, 1000) : "Queue unavailable.",
        completedAt: new Date(),
        updatedAt: new Date(),
      }).where(eq(waveformJobs.id, replacementWaveformJobId));
      // Analysis is independent of waveform display. If waveform dispatch is
      // unavailable, still try to queue it directly; failures stay visible.
      try {
        await enqueueSourceAnalysis({
          sourceAnalysisId: reanalysis.id,
          projectId: reanalysis.projectId,
          sourceAssetId: reanalysis.sourceAssetId,
          analysisEngine: reanalysis.analysisEngine,
          analysisEngineVersion: reanalysis.analysisEngineVersion,
        });
      } catch (analysisError) {
        await db.update(sourceAnalyses).set({
          status: "failed",
          stage: "queue-unavailable",
          errorCode: "queue_unavailable",
          analysisError: analysisError instanceof Error
            ? analysisError.message.slice(0, 1000)
            : "Analysis queue unavailable.",
          completedAt: new Date(),
          updatedAt: new Date(),
        }).where(eq(sourceAnalyses.id, reanalysis.id));
      }
    }
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
  patch: { stemMix?: unknown; stemMixPatch?: unknown; transition?: unknown; playbackPreference?: unknown },
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
    if (patch.stemMixPatch !== undefined) {
      throw new Error("The stem mix cannot be both a full replacement and a per-stem patch.");
    }
    const mix = normalizeStemMix(patch.stemMix);
    if (Object.keys(mix).length === 0 && Object.keys(patch.stemMix ?? {}).length > 0) {
      throw new Error("The stem mix contained no valid stem levels.");
    }
    values.stemMix = serializeStemMix(mix);
  }
  let stemMixPatch: Record<string, number> | undefined;
  if (patch.stemMixPatch !== undefined) {
    const mix = normalizeStemMix(patch.stemMixPatch);
    if (Object.keys(mix).length === 0 && Object.keys(patch.stemMixPatch ?? {}).length > 0) {
      throw new Error("The stem mix patch contained no valid stem levels.");
    }
    stemMixPatch = mix;
  }
  if (patch.transition !== undefined) {
    const config = normalizeTransitionConfig(patch.transition);
    if (config === null) throw new Error("The transition configuration is invalid.");
    values.transition = JSON.stringify(config);
  }
  if (Object.keys(values).length > 0 || stemMixPatch !== undefined) {
    if (stemMixPatch !== undefined) {
      // Merge against the latest row under a lock, so two tabs cannot replace
      // each other's independent stem changes. Parsing in application code
      // also lets malformed legacy mixes recover as unity.
      await db.transaction(async (tx) => {
        const [latest] = await tx
          .select({ stemMix: listenSessionTracks.stemMix })
          .from(listenSessionTracks)
          .where(and(eq(listenSessionTracks.id, sessionTrackId), eq(listenSessionTracks.sessionId, sessionId)))
          .limit(1)
          .for("update");
        if (latest === undefined) throw new SessionTrackNotFoundError();
        const mergedMix = serializeStemMix({ ...parseStemMix(latest.stemMix), ...stemMixPatch });
        await tx.update(listenSessionTracks).set({
          ...values,
          stemMix: mergedMix,
        }).where(eq(listenSessionTracks.id, sessionTrackId));
      });
    } else {
      await db.update(listenSessionTracks).set(values).where(eq(listenSessionTracks.id, sessionTrackId));
    }
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
  keyMatchState?: { mode: SessionKeyMode; shifts: SessionKeyShifts },
): Promise<SessionDetailPayload> {
  await ownedSession(ownerId, sessionId);
  await db.transaction(async (tx) => {
    const trackRows = await tx
      .select({ id: listenSessionTracks.id, trackId: listenSessionTracks.trackId })
      .from(listenSessionTracks)
      .where(eq(listenSessionTracks.sessionId, sessionId))
      .for("update");
    const trackBySessionId = new Map(trackRows.map((row) => [row.id, row.trackId]));
    const validId = currentSessionTrackId !== null && trackBySessionId.has(currentSessionTrackId)
      ? currentSessionTrackId
      : null;
    await tx
      .update(listenSessions)
      .set({
        currentTrackId: validId,
        positionSeconds:
          Number.isFinite(positionSeconds) && positionSeconds > 0 ? Math.min(positionSeconds, 86_400) : 0,
        ...(keyMatchState === undefined ? {} : {
          keyMatchMode: normalizeSessionKeyMode(keyMatchState.mode),
          keyShifts: serializeSessionKeyShifts(keyMatchState.shifts, trackRows),
        }),
        updatedAt: new Date(),
      })
      .where(eq(listenSessions.id, sessionId));
  });
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
  donorEntryOffsetMs?: number | null;
  expectedSwapId?: string;
  toStemAssetId?: string | null;
  /** Restored only when a failed pending swap returns to the prior audible donor. */
  grooveAnchorTrackId?: string | null;
  grooveAnchorStemAssetId?: string | null;
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
  if (input.donorEntryOffsetMs != null) {
    if (input.stemType !== "vocals") {
      throw new StemSwapRefusedError("A donor entry point can only be set for a vocal swap.");
    }
    if (!Number.isSafeInteger(input.donorEntryOffsetMs)
      || input.donorEntryOffsetMs < 0
      || input.donorEntryOffsetMs >= Math.round(Math.min(donorDetail.durationSeconds, donorStem.durationSeconds) * 1000)) {
      throw new StemSwapRefusedError("The selected vocal entry point is outside the donor track.");
    }
  }
  let restoredGrooveAnchor: { trackId: string; stemAssetId: string } | null = null;
  if (input.grooveAnchorTrackId != null || input.grooveAnchorStemAssetId != null) {
    if (!input.expectedSwapId || !input.grooveAnchorTrackId || !input.grooveAnchorStemAssetId) {
      throw new StemSwapRefusedError("A groove anchor can only be restored as a complete guarded swap reference.");
    }
    const anchorTrack = await getTrack(input.ownerId, input.grooveAnchorTrackId);
    const anchorStem = anchorTrack?.stems.find((stem) =>
      stem.id === input.grooveAnchorStemAssetId
      && stem.stemType === input.stemType
      && stem.engine !== "passthrough-unseparated",
    );
    if (!anchorStem) {
      throw new StemSwapRefusedError("The guarded restore groove anchor is no longer available at its recorded version.");
    }
    restoredGrooveAnchor = { trackId: anchorTrack!.id, stemAssetId: anchorStem.id };
  }

  await db.transaction(async (tx) => {
    // All selections for a session serialize here, including guarded restores.
    // A failed B must never restore A over a newer explicit selection C.
    await tx.select({ id: listenSessions.id }).from(listenSessions)
      .where(eq(listenSessions.id, input.sessionId)).for("update");
    const [current] = await tx.select({
      id: listenSessionSwaps.id,
      toTrackId: listenSessionSwaps.toTrackId,
      toStemAssetId: listenSessionSwaps.toStemAssetId,
    }).from(listenSessionSwaps).where(and(
      eq(listenSessionSwaps.sessionId, input.sessionId),
      eq(listenSessionSwaps.sessionTrackId, input.sessionTrackId),
      eq(listenSessionSwaps.stemType, input.stemType),
    )).orderBy(desc(listenSessionSwaps.createdAt)).limit(1);
    if (input.expectedSwapId && current?.id !== input.expectedSwapId) return;
    const grooveAnchorTrackId = restoredGrooveAnchor?.trackId
      ?? (input.expectedSwapId ? sessionTrack.trackId : current?.toStemAssetId ? current.toTrackId : sessionTrack.trackId);
    const grooveAnchorStemAssetId = restoredGrooveAnchor?.stemAssetId
      ?? (input.expectedSwapId ? currentStem.id : current?.toStemAssetId ?? currentStem.id);
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
      donorEntryOffsetMs: input.donorEntryOffsetMs ?? null,
      grooveAnchorTrackId,
      grooveAnchorStemAssetId,
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
  appliedTransforms?: {
    tempoBpm: number | null;
    tempoReference: string | null;
    key: string | null;
    keyReference: string | null;
    tempoSyncedClipCount: number;
    keySyncedClipCount: number;
    note: string;
  };
  transitionWarnings?: Array<{ fromTitle: string; toTitle: string; reason: string }>;
  refused?: Array<{ title: string; reason: string }>;
}

export interface StudioHandoffTrackEdit {
  sessionTrackId: string;
  stemMix: unknown;
}

interface SessionStudioTransformPlan {
  sessionTrackId: string;
  tempoBpm: number | null;
  tempoConfidence: number | null;
  tempoBeatConfidence: number | null;
  tempoReference: string | null;
  key: string | null;
  keyConfidence: number | null;
  keyReference: string | null;
  keyMode: SessionKeyMode;
  tempoDecisionNote: string;
  keyDecisionNote: string;
}

function confidentAnalysisValue(value: number | null | undefined): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0.5;
}

function deriveSessionStudioTransformPlan(
  detail: SessionDetailPayload,
  sessionTrack: SessionTrackPayload,
): SessionStudioTransformPlan {
  const swaps = detail.swaps.filter((swap) => swap.sessionTrackId === sessionTrack.id);
  const drumSwap = swaps.find((swap) => swap.stemType === "drums");
  const drumAnalysis = drumSwap?.donorTrack?.analysis ?? null;
  const drumEvidence = {
    recipientBpmConfidence: sessionTrack.analysis?.bpmConfidence,
    donorBpmConfidence: drumAnalysis?.bpmConfidence,
    recipientBeatConfidence: sessionTrack.analysis?.beatConfidence,
    donorBeatConfidence: drumAnalysis?.beatConfidence,
  };
  const drumResolution = drumSwap
    ? resolveLiveDrumTempoMaster(sessionTrack.analysis?.bpm ?? null, drumAnalysis?.bpm ?? null, drumEvidence)
    : null;
  const currentTempoIsUsable = confidentAnalysisValue(sessionTrack.analysis?.bpmConfidence)
    && confidentAnalysisValue(sessionTrack.analysis?.beatConfidence)
    && Number.isFinite(sessionTrack.analysis?.bpm)
    && (sessionTrack.analysis?.bpm ?? 0) >= 40
    && (sessionTrack.analysis?.bpm ?? 0) <= 300;
  const donorDrumsAreMaster = drumResolution?.master === "donor-drums";
  const tempoBpm = donorDrumsAreMaster
    ? drumResolution.donorBpm
    : currentTempoIsUsable ? sessionTrack.analysis!.bpm : null;
  const tempoConfidence = donorDrumsAreMaster
    ? drumAnalysis?.bpmConfidence ?? null
    : currentTempoIsUsable ? sessionTrack.analysis?.bpmConfidence ?? null : null;
  const tempoBeatConfidence = donorDrumsAreMaster
    ? drumAnalysis?.beatConfidence ?? null
    : currentTempoIsUsable ? sessionTrack.analysis?.beatConfidence ?? null : null;
  const tempoReference = donorDrumsAreMaster
    ? drumSwap?.donorTrack?.title ?? "Donor drums"
    : tempoBpm !== null ? sessionTrack.track.title : null;
  const tempoDecisionNote = drumSwap
    ? drumResolution?.reason ?? "The current track remains the tempo reference."
    : currentTempoIsUsable
      ? "No donor drum swap is active; the current track remains the tempo reference."
      : "No reliable BPM and beat-grid pair was available; all layers stay at native timing. Studio's neutral 120 BPM grid default is not applied to the audio.";

  const completeBedTrackId = completeInstrumentalBedDonorTrackId(swaps.map((swap) => ({
    stemType: swap.stemType,
    donorTrackId: swap.toTrackId,
  })));
  const completeBedSwaps = completeBedTrackId
    ? ["drums", "bass", "other"].map((stemType) =>
      swaps.find((swap) => swap.stemType === stemType && swap.toTrackId === completeBedTrackId),
    )
    : [];
  const completeBedIsPinned = completeBedTrackId !== null
    && completeBedSwaps.length === 3
    && completeBedSwaps.every((swap) => {
      if (!swap?.toStemAssetId || swap.donorTrack?.id !== completeBedTrackId) return false;
      return swap.donorTrack.stems.some((stem) =>
        stem.id === swap.toStemAssetId
        && stem.stemType === swap.stemType
        && stem.engine !== "passthrough-unseparated",
      );
    });
  const hasInstrumentalSwap = swaps.some((swap) => ["drums", "bass", "other"].includes(swap.stemType));
  const currentTrackHasCompleteBed = !hasInstrumentalSwap
    && ["drums", "bass", "other"].every((stemType) => sessionTrack.stems.some((stem) =>
      stem.stemType === stemType && stem.engine !== "passthrough-unseparated",
    ));
  const bedSwap = completeBedIsPinned ? completeBedSwaps[0] : undefined;
  const bedAnalysis = bedSwap?.donorTrack?.analysis
    ?? (currentTrackHasCompleteBed ? sessionTrack.analysis : null);
  const bedReferenceTitle = bedSwap?.donorTrack?.title
    ?? (currentTrackHasCompleteBed ? sessionTrack.track.title : null);
  const key = bedAnalysis?.keyConfidence !== null && bedAnalysis?.keyConfidence !== undefined
    && bedAnalysis.keyConfidence >= 0.5
    ? normaliseMusicalKey(bedAnalysis.musicalKey)
    : null;
  const keyDecisionNote = key === null
    ? bedReferenceTitle && bedAnalysis?.musicalKey
      ? `${bedReferenceTitle} is the complete instrumental-bed reference, but its ${bedAnalysis.musicalKey} estimate is below the confidence threshold; vocals stay at source pitch.`
      : "No complete, confident instrumental-bed key reference was available; vocals stay at source pitch."
    : detail.keyMatchMode === "off" || detail.keyMatchMode === "preserve"
      ? `The complete bed provides ${key}, but ${detail.keyMatchMode} mode keeps vocals at source pitch.`
      : `${bedReferenceTitle ?? "The complete bed"} provides ${key}; only confidently analyzed vocal clips are transposed, while drums and other layers stay unchanged.`;
  return {
    sessionTrackId: sessionTrack.id,
    tempoBpm: tempoBpm ?? null,
    tempoConfidence: tempoConfidence ?? null,
    tempoBeatConfidence: tempoBeatConfidence ?? null,
    tempoReference,
    key,
    keyConfidence: key !== null ? bedAnalysis?.keyConfidence ?? null : null,
    keyReference: key !== null ? bedReferenceTitle ?? "Complete instrumental bed" : null,
    keyMode: detail.keyMatchMode,
    tempoDecisionNote,
    keyDecisionNote,
  };
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
  const transformTrack = selectedTracks.find((entry) => entry.id === detail.currentSessionTrackId)
    ?? (selectedTracks.length === 1 ? selectedTracks[0] : null);
  const transformPlan = transformTrack
    ? deriveSessionStudioTransformPlan(detail, transformTrack)
    : null;
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
    tempoSyncEnabled: boolean;
    keySyncEnabled: boolean;
  }> = [];
  const refused: Array<{ title: string; reason: string }> = [];
  const transitionWarnings: NonNullable<StudioHandoffResult["transitionWarnings"]> = [];
  const handoffStorage = getStorage();
  const stemObjectAvailability = new Map<string, boolean>();
  const donorAnalysisByTrack = new Map<string, Promise<SessionTrackAnalysis | null>>();
  let tempoSyncedClipCount = 0;
  let keySyncedClipCount = 0;
  const availableStemIds = async (stems: TrackStem[]): Promise<Set<string>> => {
    const ids = [...new Set(stems.map((stem) => stem.id))];
    const pendingIds = ids.filter((id) => !stemObjectAvailability.has(id));
    if (pendingIds.length > 0) {
      const rows = await db
        .select({ id: stemAssets.id, storageKey: stemAssets.storageKey })
        .from(stemAssets)
        .where(inArray(stemAssets.id, pendingIds));
      const rowById = new Map(rows.map((row) => [row.id, row]));
      await Promise.all(pendingIds.map(async (id) => {
        const row = rowById.get(id);
        stemObjectAvailability.set(id, row !== undefined && await handoffStorage.exists(row.storageKey));
      }));
    }
    return new Set(ids.filter((id) => stemObjectAvailability.get(id) === true));
  };
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
    const selectedStemAvailability = await availableStemIds(playableStems);
    const missingSelectedStems = playableStems.filter((stem) => !selectedStemAvailability.has(stem.id));
    if (missingSelectedStems.length > 0) {
      const names = missingSelectedStems.map((stem) => stem.stemType).join(", ");
      refused.push({
        title: sessionTrack.track.title,
        reason: `The ${names} stem ${missingSelectedStems.length === 1 ? "file is" : "files are"} missing from private storage; this entry was not sent to Studio.`,
      });
      continue;
    }
    const replacements = new Map<string, {
      stemId: string;
      donorTitle: string;
      donorTrackId: string;
      durationSeconds: number;
      donorEntryOffsetMs: number;
      analysis: SessionTrackAnalysis | null;
    }>();
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
      if (!(await availableStemIds([donorStem])).has(donorStem.id)) {
        invalidSwapReason = `The saved ${swap.stemType} live-swap audio from “${donorDetail.title}” is missing from private storage. Restore or re-separate the donor in the Library, then reapply the swap.`;
        break;
      }
      let donorAnalysis = donorAnalysisByTrack.get(donorDetail.id);
      if (!donorAnalysis) {
        donorAnalysis = sessionTrackAnalysis(ownerId, donorDetail.id);
        donorAnalysisByTrack.set(donorDetail.id, donorAnalysis);
      }
      replacements.set(swap.stemType, {
        stemId: donorStem.id,
        donorTitle: donorDetail.title,
        donorTrackId: donorDetail.id,
        durationSeconds: donorStem.durationSeconds,
        donorEntryOffsetMs: swap.donorEntryOffsetMs ?? 0,
        // `getTrack` only returns BPM/key. Use the checksum-validated session
        // analysis so the donor's beat, section and vocal evidence survives the
        // live-swap-to-Studio handoff rather than silently disappearing here.
        analysis: await donorAnalysis,
      });
    }
    if (invalidSwapReason !== null) {
      refused.push({ title: sessionTrack.track.title, reason: invalidSwapReason });
      continue;
    }
    const trackTransform = transformPlan?.sessionTrackId === sessionTrack.id ? transformPlan : null;
    const preparedStems = playableStems.map((stem) => {
      const replacement = replacements.get(stem.stemType);
      const stemDurationSeconds = Number.isFinite(replacement?.durationSeconds) && (replacement?.durationSeconds ?? 0) > 0
        ? replacement!.durationSeconds
        : Number.isFinite(stem.durationSeconds) && stem.durationSeconds > 0
          ? stem.durationSeconds
          : trackDetail.durationSeconds;
      const durationMs = Number.isFinite(stemDurationSeconds) && stemDurationSeconds > 0
        ? Math.round(stemDurationSeconds * 1000)
        : 0;
      const sourceOffsetMs = replacement?.donorEntryOffsetMs ?? 0;
      const analysis = replacement?.analysis ?? sessionTrack.analysis;
      const tempoEvidence = {
        recipientBpmConfidence: trackTransform?.tempoConfidence,
        donorBpmConfidence: analysis?.bpmConfidence,
        recipientBeatConfidence: trackTransform?.tempoBeatConfidence,
        donorBeatConfidence: analysis?.beatConfidence,
      };
      const proposedTempoRatio = trackTransform?.tempoBpm !== null && trackTransform?.tempoBpm !== undefined
        && analysis?.bpm !== null && analysis?.bpm !== undefined
        && hasReliableLiveStemTempoEvidence(tempoEvidence)
        ? liveStemTempoStretchRatio(analysis.bpm, trackTransform.tempoBpm, tempoEvidence)
        : null;
      const tempoSyncEnabled = proposedTempoRatio !== null
        && Math.abs(proposedTempoRatio - 1) > 0.0001;
      const tempoRatio = tempoSyncEnabled ? proposedTempoRatio : 1;
      const vocalKeyCorrection = trackTransform?.key !== null && trackTransform?.key !== undefined
        && stem.stemType === "vocals"
        ? resolveInstrumentalBedVocalCorrection(
          trackTransform.keyMode,
          trackTransform.key,
          trackTransform.keyConfidence,
          analysis?.musicalKey ?? null,
          analysis?.keyConfidence ?? null,
        )
        : null;
      const keySyncEnabled = vocalKeyCorrection?.applied === true
        && vocalKeyCorrection.semitones !== 0;
      const outputDurationMs = durationMs > sourceOffsetMs
        ? Math.floor((durationMs - sourceOffsetMs) / tempoRatio)
        : 0;
      return {
        stem,
        replacement,
        analysis,
        sourceOffsetMs,
        sourceDurationMs: durationMs,
        tempoRatio,
        outputDurationMs,
        tempoSyncEnabled,
        keySyncEnabled,
      };
    });
    const trackDurationMs = Math.max(
      0,
      ...preparedStems.map((prepared) => prepared.outputDurationMs),
      Number.isFinite(trackDetail.durationSeconds) && trackDetail.durationSeconds > 0 && preparedStems.length === 0
        ? Math.round(trackDetail.durationSeconds * 1000)
        : 0,
    );
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
    for (const prepared of preparedStems) {
      const { stem, replacement } = prepared;
      const clipSourceOffsetMs = sourceOffsetMs + prepared.sourceOffsetMs;
      const clipOutputDurationMs = prepared.sourceDurationMs > clipSourceOffsetMs
        ? Math.floor((prepared.sourceDurationMs - clipSourceOffsetMs) / prepared.tempoRatio)
        : 0;
      if (clipOutputDurationMs <= 0) {
        refused.push({ title: sessionTrack.track.title, reason: "Audio duration is unavailable for Studio placement." });
        continue;
      }
      const clipDurationMs = Math.min(
        clipOutputDurationMs,
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
        sourceOffsetMs: clipSourceOffsetMs,
        durationMs: clipDurationMs,
        fadeInMs: Math.min(fadeInMs, clipDurationMs),
        fadeOutMs: 0,
        tempoSyncEnabled: prepared.tempoSyncEnabled,
        keySyncEnabled: prepared.keySyncEnabled,
      });
      if (prepared.tempoSyncEnabled) tempoSyncedClipCount += 1;
      if (prepared.keySyncEnabled) keySyncedClipCount += 1;
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
  const effectiveTransformPlan = transformPlan !== null
    && bindable.some((entry) => entry.sessionTrack.id === transformPlan.sessionTrackId)
    ? transformPlan
    : null;

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
      tempoBpm: effectiveTransformPlan?.tempoBpm ?? 120,
      targetKey: effectiveTransformPlan?.key ?? null,
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
      tempoSyncEnabled: entry.tempoSyncEnabled,
      keySyncEnabled: entry.keySyncEnabled,
    })));
  });

  const appliedTransforms: NonNullable<StudioHandoffResult["appliedTransforms"]> = {
    tempoBpm: effectiveTransformPlan?.tempoBpm ?? null,
    tempoReference: effectiveTransformPlan?.tempoReference ?? null,
    key: effectiveTransformPlan?.key ?? null,
    keyReference: effectiveTransformPlan?.keyReference ?? null,
    tempoSyncedClipCount,
    keySyncedClipCount,
    note: effectiveTransformPlan === null
      ? "No valid current session entry was available as the single transform authority; clips remain at native timing and pitch."
      : [
        effectiveTransformPlan.tempoBpm === null
          ? effectiveTransformPlan.tempoDecisionNote
          : `Tempo target ${effectiveTransformPlan.tempoBpm.toFixed(2)} BPM follows ${effectiveTransformPlan.tempoReference ?? "the current track"}. ${effectiveTransformPlan.tempoDecisionNote} Clips without reliable BPM evidence remain native.`,
        effectiveTransformPlan.keyDecisionNote,
      ].join(" "),
  };

  return {
    projectId: project.id,
    remixSessionId: remix.id,
    remixTrackCount: bindable.length,
    preservedSwapCount,
    preservedTransitionCount,
    appliedTransforms,
    transitionWarnings: transitionWarnings.length > 0 ? transitionWarnings : undefined,
    refused: refused.length > 0 ? refused : undefined,
  };
}

/** Analysis for the compatibility panel: BPM/key/beat grid per session track. */
export interface SessionTrackAnalysis {
  bpm: number | null;
  bpmConfidence: number | null;
  beatConfidence: number | null;
  downbeatConfidence: number | null;
  keyConfidence: number | null;
  musicalKey: string | null;
  beatGridMs: number[] | null;
  downbeatGridMs: number[] | null;
  sections: SourceSection[] | null;
  /** Checksum-verified isolated-vocal activity starts; these are not lyric word boundaries. */
  vocalActivityStartsMs: { startMs: number; confidence: number }[] | null;
  /** Checksum-verified activity intervals; durations preserve where the backing has vocal space. */
  vocalActivityIntervals: { startMs: number; endMs: number; confidence: number }[] | null;
  /** Pitch-continuity phrase candidates; unvoiced consonants and lyric boundaries are not guaranteed. */
  voicedPhraseStartsMs: { startMs: number; confidence: number }[] | null;
  /** Full pitch-continuity runs; these are voiced-run extents, not lyric or word boundaries. */
  voicedPhraseIntervals: { startMs: number; endMs: number; confidence: number }[] | null;
  /** Exact-current isolated drum timing; null when the stem evidence is absent or untrusted. */
  isolatedDrumTempo: IsolatedDrumTempoEvidence | null;
  isolatedDrumTempoStatus: "not_applicable" | "queued" | "processing" | "complete" | "failed" | "unavailable";
}

type DrumTempoState = Pick<SessionTrackAnalysis, "isolatedDrumTempo" | "isolatedDrumTempoStatus">;

async function sessionDrumTempoState(
  detail: TrackDetail,
  source: { id: string; projectId: string; checksumSha256: string | null },
): Promise<DrumTempoState> {
  const drumStem = detail.stems.find((stem) =>
    (stem.stemType === "drums" || stem.stemType === "percussion")
    && stem.engine !== "passthrough-unseparated",
  );
  if (!drumStem || source.checksumSha256 === null) {
    return { isolatedDrumTempo: null, isolatedDrumTempoStatus: "not_applicable" };
  }
  const [stem] = await db.select({
    id: stemAssets.id,
    projectId: stemAssets.projectId,
    sourceAssetId: stemAssets.sourceAssetId,
    stemType: stemAssets.stemType,
    checksumSha256: stemAssets.checksumSha256,
    durationSeconds: stemAssets.durationSeconds,
  }).from(stemAssets).where(and(
    eq(stemAssets.id, drumStem.id),
    eq(stemAssets.sourceAssetId, source.id),
    eq(stemAssets.projectId, source.projectId),
  )).limit(1);
  if (!stem || (stem.stemType !== "drums" && stem.stemType !== "percussion")) {
    return { isolatedDrumTempo: null, isolatedDrumTempoStatus: "unavailable" };
  }

  const readCurrent = async (): Promise<DrumTempoState | null> => {
    const [row] = await db.select({
      id: drumAnalyses.id,
      sourceAssetId: drumAnalyses.sourceAssetId,
      stemAssetId: drumAnalyses.stemAssetId,
      sourceChecksumSha256: drumAnalyses.sourceChecksumSha256,
      stemChecksumSha256: drumAnalyses.stemChecksumSha256,
      currentStemChecksumSha256: stemAssets.checksumSha256,
      status: drumAnalyses.status,
      analysisEngine: drumAnalyses.analysisEngine,
      analysisEngineVersion: drumAnalyses.analysisEngineVersion,
      bpm: drumAnalyses.bpm,
      bpmConfidence: drumAnalyses.bpmConfidence,
      beatGrid: drumAnalyses.beatGrid,
      beatConfidence: drumAnalyses.beatConfidence,
    }).from(drumAnalyses).innerJoin(stemAssets, eq(drumAnalyses.stemAssetId, stemAssets.id)).where(and(
      eq(drumAnalyses.sourceAssetId, source.id),
      eq(drumAnalyses.stemAssetId, stem.id),
      eq(drumAnalyses.status, "complete"),
      eq(drumAnalyses.analysisEngine, LOCAL_DRUM_ANALYSIS_ENGINE),
      eq(drumAnalyses.analysisEngineVersion, LOCAL_DRUM_ANALYSIS_ENGINE_VERSION),
      eq(drumAnalyses.sourceChecksumSha256, source.checksumSha256!),
      eq(stemAssets.sourceAssetId, source.id),
      eq(stemAssets.checksumSha256, drumAnalyses.stemChecksumSha256),
    )).limit(1);
    if (!row) return null;
    const staleReason = drumAnalysisProvenanceReason({
      sourceAssetId: row.sourceAssetId,
      expectedSourceAssetId: source.id,
      stemAssetId: row.stemAssetId,
      expectedStemAssetId: stem.id,
      sourceChecksumSha256: row.sourceChecksumSha256,
      expectedSourceChecksumSha256: source.checksumSha256!,
      stemChecksumSha256: row.stemChecksumSha256,
      expectedStemChecksumSha256: row.currentStemChecksumSha256,
      analysisEngine: row.analysisEngine,
      analysisEngineVersion: row.analysisEngineVersion,
    }, { engine: LOCAL_DRUM_ANALYSIS_ENGINE, version: LOCAL_DRUM_ANALYSIS_ENGINE_VERSION });
    if (staleReason !== null) return null;
    const parsedGrid = (() => {
      if (row.beatGrid === null) return null;
      try { return JSON.parse(row.beatGrid); } catch { return null; }
    })();
    const measured = normaliseIsolatedDrumTempoEvidence({
      bpm: row.bpm,
      bpmConfidence: row.bpmConfidence,
      beatGrid: parsedGrid,
      beatConfidence: row.beatConfidence,
      durationMs: Math.round(Math.min(detail.durationSeconds, stem.durationSeconds) * 1000),
    });
    if (!measured) {
      return { isolatedDrumTempo: null, isolatedDrumTempoStatus: "complete" } satisfies DrumTempoState;
    }
    return {
      isolatedDrumTempo: {
        ...measured,
        stemAssetId: row.stemAssetId,
        sourceChecksumSha256: row.sourceChecksumSha256,
        stemChecksumSha256: row.stemChecksumSha256,
        analysisEngine: row.analysisEngine,
        analysisEngineVersion: row.analysisEngineVersion,
      } satisfies IsolatedDrumTempoEvidence,
      isolatedDrumTempoStatus: "complete",
    };
  };

  const currentState = await readCurrent();
  if (currentState) return currentState;

  try {
    const ensured = await ensureLocalDrumTempoAnalysis(
      { id: source.id, projectId: source.projectId, checksumSha256: source.checksumSha256 },
      stem,
    );
    const status = ensured.analysis?.status;
    return {
      isolatedDrumTempo: null,
      isolatedDrumTempoStatus: status === "queued" || status === "preparing" || status === "processing"
        ? status === "queued" ? "queued" : "processing"
        : status === "failed" || status === "cancelled" ? "failed" : "unavailable",
    };
  } catch {
    return { isolatedDrumTempo: null, isolatedDrumTempoStatus: "unavailable" };
  }
}

export async function sessionTrackAnalysis(ownerId: string, trackId: string): Promise<SessionTrackAnalysis | null> {
  const detail: TrackDetail | null = await getTrack(ownerId, trackId);
  if (detail === null) return null;
  const [sourceTrack] = await db
    .select({
      projectId: sourceAssets.projectId,
      sourceAssetId: tracks.sourceAssetId,
      checksumSha256: sourceAssets.checksumSha256,
    })
    .from(tracks)
    .leftJoin(sourceAssets, eq(sourceAssets.id, tracks.sourceAssetId))
    .where(eq(tracks.id, trackId))
    .limit(1);
  if (sourceTrack === undefined || sourceTrack.sourceAssetId === null || sourceTrack.projectId === null) return null;
  const drumTempoState = await sessionDrumTempoState(detail, {
    id: sourceTrack.sourceAssetId,
    projectId: sourceTrack.projectId,
    checksumSha256: sourceTrack.checksumSha256,
  });
  const [analysis] = await db
    .select({
      id: sourceAnalyses.id,
      bpm: sourceAnalyses.bpm,
      bpmConfidence: sourceAnalyses.bpmConfidence,
      beatConfidence: sourceAnalyses.beatConfidence,
      downbeatGrid: sourceAnalyses.downbeatGrid,
      downbeatConfidence: sourceAnalyses.downbeatConfidence,
      keyConfidence: sourceAnalyses.keyConfidence,
      analysisEngine: sourceAnalyses.analysisEngine,
      analysisEngineVersion: sourceAnalyses.analysisEngineVersion,
      musicalKey: sourceAnalyses.musicalKey,
      beatGrid: sourceAnalyses.beatGrid,
      sourceChecksumSha256: sourceAnalyses.sourceChecksumSha256,
    })
    .from(sourceAnalyses)
    .where(and(eq(sourceAnalyses.sourceAssetId, sourceTrack.sourceAssetId), eq(sourceAnalyses.status, "complete")))
    .limit(1);
  if (analysis === undefined) {
    return {
      bpm: null,
      bpmConfidence: null,
      beatConfidence: null,
      downbeatConfidence: null,
      keyConfidence: null,
      musicalKey: null,
      beatGridMs: null,
      downbeatGridMs: null,
      sections: null,
      vocalActivityStartsMs: null,
      vocalActivityIntervals: null,
      voicedPhraseStartsMs: null,
      voicedPhraseIntervals: null,
      ...drumTempoState,
    };
  }
  const analysisMatchesSource = sourceTrack.checksumSha256 !== null
    && analysis.sourceChecksumSha256 === sourceTrack.checksumSha256;
  if (!analysisMatchesSource) {
    return {
      bpm: null,
      bpmConfidence: null,
      beatConfidence: null,
      downbeatConfidence: null,
      keyConfidence: null,
      musicalKey: null,
      beatGridMs: null,
      downbeatGridMs: null,
      sections: null,
      vocalActivityStartsMs: null,
      vocalActivityIntervals: null,
      voicedPhraseStartsMs: null,
      voicedPhraseIntervals: null,
      ...drumTempoState,
    };
  }
  const analysisIsCurrent = isCurrentDesktopAnalysis(analysis);
  let beatGridMs: number[] | null = null;
  try {
    const parsed = JSON.parse(analysisIsCurrent ? analysis.beatGrid ?? "null" : "null");
    if (Array.isArray(parsed)) beatGridMs = parsed.filter((beat) => Number.isSafeInteger(beat));
  } catch {
    beatGridMs = null;
  }
  let downbeatGridMs: number[] | null = null;
  try {
    const parsed = JSON.parse(analysisIsCurrent ? analysis.downbeatGrid ?? "null" : "null");
    const beatIndices = Array.isArray(parsed)
      ? parsed.map((beat) => beatGridMs?.indexOf(beat) ?? -1)
      : [];
    if (
      Array.isArray(parsed)
      && parsed.length >= 2
      && beatIndices.every((index, offset) =>
        index >= 0 && (offset === 0 || index - beatIndices[offset - 1]! === 4),
      )
    ) downbeatGridMs = parsed;
  } catch {
    downbeatGridMs = null;
  }
  const measuredBeatConfidence = currentBeatConfidence(analysis);
  const downbeatConfidence = analysisIsCurrent
    && hasReliableMixingConfidence(measuredBeatConfidence)
    && measuredBeatConfidence !== null
    && typeof analysis.downbeatConfidence === "number"
    && Number.isFinite(analysis.downbeatConfidence)
    && analysis.downbeatConfidence >= 0
    && analysis.downbeatConfidence <= 1
    ? Math.min(analysis.downbeatConfidence, measuredBeatConfidence)
    : null;
  if (!hasReliableSessionDownbeatEvidence(downbeatConfidence, downbeatGridMs)) downbeatGridMs = null;

  let sections: SourceSection[] | null = null;
  if (
    beatGridMs !== null
    && sourceTrack.checksumSha256 !== null
    && analysis.sourceChecksumSha256 === sourceTrack.checksumSha256
  ) {
    const [sectionAnalysis] = await db
      .select({
        id: sourceSectionAnalyses.id,
        analysisEngine: sourceSectionAnalyses.analysisEngine,
        analysisEngineVersion: sourceSectionAnalyses.analysisEngineVersion,
      })
      .from(sourceSectionAnalyses)
      .where(and(
        eq(sourceSectionAnalyses.sourceAssetId, sourceTrack.sourceAssetId),
        eq(sourceSectionAnalyses.sourceAnalysisId, analysis.id),
        eq(sourceSectionAnalyses.sourceChecksumSha256, sourceTrack.checksumSha256),
        eq(sourceSectionAnalyses.status, "complete"),
      ))
      .limit(1);
    if (sectionAnalysis !== undefined) {
      const records = await db
        .select({
          id: sourceSections.id,
          sectionIndex: sourceSections.sectionIndex,
          startMs: sourceSections.startMs,
          endMs: sourceSections.endMs,
          startBeatIndex: sourceSections.startBeatIndex,
          endBeatIndex: sourceSections.endBeatIndex,
          startBar: sourceSections.startBar,
          endBar: sourceSections.endBar,
          label: sourceSections.label,
          labelConfidence: sourceSections.labelConfidence,
          structuralConfidence: sourceSections.structuralConfidence,
          analysisEngine: sourceSections.analysisEngine,
          analysisEngineVersion: sourceSections.analysisEngineVersion,
          sourceChecksumSha256: sourceSections.sourceChecksumSha256,
          passageFingerprint: sourceSections.passageFingerprint,
          sourceAssetId: sourceSections.sourceAssetId,
          sourceAnalysisId: sourceSections.sourceAnalysisId,
          sourceSectionAnalysisId: sourceSections.sourceSectionAnalysisId,
        })
        .from(sourceSections)
        .where(and(
          eq(sourceSections.sourceAssetId, sourceTrack.sourceAssetId),
          eq(sourceSections.sourceAnalysisId, analysis.id),
          eq(sourceSections.sourceSectionAnalysisId, sectionAnalysis.id),
          eq(sourceSections.sourceChecksumSha256, sourceTrack.checksumSha256),
        ))
        .orderBy(asc(sourceSections.sectionIndex));
      const provenanceMatches = records.length > 0 && records.every((record) =>
        typeof record.label === "string"
        && record.label.trim().length > 0
        && record.label.length <= 64
        && record.sourceAssetId === sourceTrack.sourceAssetId
        && record.sourceAnalysisId === analysis.id
        && record.sourceSectionAnalysisId === sectionAnalysis.id
        && record.sourceChecksumSha256 === sourceTrack.checksumSha256
        && record.analysisEngine === sectionAnalysis.analysisEngine
        && record.analysisEngineVersion === sectionAnalysis.analysisEngineVersion,
      );
      if (provenanceMatches) {
        const candidates: SourceSection[] = records.map((record) => ({
          id: record.id,
          sectionIndex: record.sectionIndex,
          startMs: record.startMs,
          endMs: record.endMs,
          startBeatIndex: record.startBeatIndex,
          endBeatIndex: record.endBeatIndex,
          startBar: record.startBar,
          endBar: record.endBar,
          label: record.label,
          labelConfidence: record.labelConfidence,
          structuralConfidence: record.structuralConfidence,
          analysisEngine: record.analysisEngine,
          analysisEngineVersion: record.analysisEngineVersion,
          sourceChecksumSha256: record.sourceChecksumSha256,
          passageFingerprint: parsePassageFingerprint(record.passageFingerprint, {
            sourceChecksumSha256: record.sourceChecksumSha256,
            startBeatIndex: record.startBeatIndex,
            endBeatIndex: record.endBeatIndex,
          }),
        }));
        if (sourceSectionsAreValid(candidates, beatGridMs, detail.durationSeconds * 1000)) sections = candidates;
      }
    }
  }
  let vocalActivityStartsMs: SessionTrackAnalysis["vocalActivityStartsMs"] = null;
  let vocalActivityIntervalData: SessionTrackAnalysis["vocalActivityIntervals"] = null;
  let voicedPhraseStartsMs: SessionTrackAnalysis["voicedPhraseStartsMs"] = null;
  let voicedPhraseIntervalData: SessionTrackAnalysis["voicedPhraseIntervals"] = null;
  const vocalStem = detail.stems.find((stem) => stem.stemType === "vocals"
    && stem.engine !== "passthrough-unseparated");
  if (vocalStem && sourceTrack.checksumSha256 !== null) {
    const [vocalAnalysis] = await db.select({
      id: vocalAnalyses.id,
      sourceAssetId: vocalAnalyses.sourceAssetId,
      stemAssetId: vocalAnalyses.stemAssetId,
      sourceChecksumSha256: vocalAnalyses.sourceChecksumSha256,
      stemChecksumSha256: vocalAnalyses.stemChecksumSha256,
      currentStemChecksumSha256: stemAssets.checksumSha256,
      analysisEngine: vocalAnalyses.analysisEngine,
      analysisEngineVersion: vocalAnalyses.analysisEngineVersion,
    }).from(vocalAnalyses).innerJoin(stemAssets, eq(vocalAnalyses.stemAssetId, stemAssets.id)).where(and(
      eq(vocalAnalyses.sourceAssetId, sourceTrack.sourceAssetId),
      eq(vocalAnalyses.stemAssetId, vocalStem.id),
      eq(vocalAnalyses.status, "complete"),
      eq(vocalAnalyses.analysisEngine, LOCAL_VOCAL_ANALYSIS_ENGINE),
      eq(vocalAnalyses.analysisEngineVersion, LOCAL_VOCAL_ANALYSIS_ENGINE_VERSION),
      eq(vocalAnalyses.sourceChecksumSha256, sourceTrack.checksumSha256),
      eq(stemAssets.sourceAssetId, sourceTrack.sourceAssetId),
      eq(stemAssets.stemType, "vocals"),
      eq(vocalAnalyses.stemChecksumSha256, stemAssets.checksumSha256),
    )).orderBy(desc(vocalAnalyses.createdAt)).limit(1);
    const provenanceReason = vocalAnalysis ? vocalAnalysisProvenanceReason({
        sourceAssetId: vocalAnalysis.sourceAssetId,
        expectedSourceAssetId: sourceTrack.sourceAssetId,
        stemAssetId: vocalAnalysis.stemAssetId,
        expectedStemAssetId: vocalStem.id,
        sourceChecksumSha256: vocalAnalysis.sourceChecksumSha256,
        expectedSourceChecksumSha256: sourceTrack.checksumSha256,
        stemChecksumSha256: vocalAnalysis.stemChecksumSha256,
        expectedStemChecksumSha256: vocalAnalysis.currentStemChecksumSha256,
        analysisEngine: vocalAnalysis.analysisEngine,
        analysisEngineVersion: vocalAnalysis.analysisEngineVersion,
    }, {
      engine: LOCAL_VOCAL_ANALYSIS_ENGINE,
      version: LOCAL_VOCAL_ANALYSIS_ENGINE_VERSION,
    }) : "source_stem_mismatch";
    if (vocalAnalysis && !provenanceReason) {
      const [activityRows, phraseRows] = await Promise.all([
        db.select({
          startMs: vocalActivityIntervals.startMs,
          endMs: vocalActivityIntervals.endMs,
          confidence: vocalActivityIntervals.confidence,
        }).from(vocalActivityIntervals)
          .where(eq(vocalActivityIntervals.vocalAnalysisId, vocalAnalysis.id))
          .orderBy(asc(vocalActivityIntervals.startMs))
          .limit(10_000),
        db.select({
          startMs: vocalPhrases.startMs,
          endMs: vocalPhrases.endMs,
          confidence: vocalPhrases.confidence,
        }).from(vocalPhrases)
          .where(eq(vocalPhrases.vocalAnalysisId, vocalAnalysis.id))
          .orderBy(asc(vocalPhrases.startMs))
          .limit(10_000),
      ]);
      const durationMs = Math.round(Math.min(detail.durationSeconds, vocalStem.durationSeconds) * 1000);
      const validIntervals = (rows: typeof activityRows) => rows.filter((row) =>
        Number.isSafeInteger(row.startMs)
        && Number.isSafeInteger(row.endMs)
        && row.startMs >= 0
        && row.endMs > row.startMs
        && row.endMs <= durationMs
        && Number.isFinite(row.confidence)
        && row.confidence >= 0
        && row.confidence <= 1,
      ).map(({ startMs, endMs, confidence }) => ({ startMs, endMs, confidence }));
      vocalActivityIntervalData = validIntervals(activityRows);
      voicedPhraseIntervalData = validIntervals(phraseRows);
      vocalActivityStartsMs = vocalActivityIntervalData.map(({ startMs, confidence }) => ({ startMs, confidence }));
      voicedPhraseStartsMs = voicedPhraseIntervalData.map(({ startMs, confidence }) => ({ startMs, confidence }));
    }
  }
  return {
    bpm: analysis.bpm,
    bpmConfidence: currentBpmConfidence(analysis),
    beatConfidence: measuredBeatConfidence,
    downbeatConfidence,
    keyConfidence: currentKeyConfidence(analysis),
    musicalKey: analysis.musicalKey,
    beatGridMs,
    downbeatGridMs,
    sections,
    vocalActivityStartsMs,
    vocalActivityIntervals: vocalActivityIntervalData,
    voicedPhraseStartsMs,
    voicedPhraseIntervals: voicedPhraseIntervalData,
    ...drumTempoState,
  };
}
