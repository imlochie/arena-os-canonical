/**
 * Waveyard listening-layer service (docs/waveyard-evolution-plan.md P1).
 *
 * Real persistence for TRACKS / QUEUE / PLAYLISTS / PLAYBACK STATE on top of
 * the EXISTING source/stem/analysis infrastructure:
 *
 *  - intake wraps `ingestSourceFile` (the same probe → checksum → private
 *    storage → source_assets + jobs path the studio uses) inside an
 *    auto-created library container project (wy_projects.kind='library');
 *  - a Track REFERENCES a source asset — audio is never duplicated, and
 *    re-adding the same file is idempotent (checksum dedupe);
 *  - queue and playlists are lightweight ordered relations over tracks;
 *  - playback state persists only durable transport state (live meters,
 *    positions etc. stay client-side);
 *  - "Open in Studio" is the container project itself — the same musical
 *    object, no copies.
 *
 * Every function is owner-scoped (single-owner local app today, but the
 * scoping is real so multi-user never leaks).
 */

import { and, asc, desc, eq, ilike, inArray, isNull, or, sql } from "drizzle-orm";

import { db, pool } from "@workspace/db";
import {
  listenSessions,
  listenSessionTracks,
  playbackState,
  playlistItems,
  playlists,
  PROCESSING_JOB_TERMINAL_STATUSES,
  processingJobs,
  projects,
  queueItems,
  smartCollections,
  sourceAnalyses,
  sourceAssets,
  stemAssets,
  tracks,
} from "@workspace/db/waveyardSchema";
import { checksumFile } from "@workspace/arena/lib/waveyard/audio";
import {
  normalizeLabels,
  normalizeRating,
  normaliseSmartRules,
  parseSmartRules,
  type SmartCollection,
} from "./collections";
import { ingestSourceFile } from "@workspace/arena/lib/waveyard/source-ingest"
import { defaultSeparationModel } from "@workspace/arena/lib/waveyard/separation/selection";
import { startSeparationJob, type ProcessingJobRow, type StartSeparationDeps } from "../separation/claim";
import {
  deriveTrackMetadata,
  libraryContainerProjectName,
  normalizeStemMix,
  parseStemMix,
  resolveStemAvailability,
  serializeStemMix,
  type StemAvailability,
  type StemMix,
} from "./model";

// ---------------------------------------------------------------- track views

export interface TrackSummary {
  id: string;
  /** Private source asset ID used by the owner's original-file download action. */
  sourceAssetId: string | null;
  title: string;
  artist: string;
  album: string;
  durationSeconds: number;
  playCount: number;
  /** Star rating 0 (unrated) .. 5. */
  rating: number;
  /** Curated labels (normalised, ordered as stored). */
  labels: string[];
  lastPlayedAt: string | null;
  addedAt: string;
  stemAvailability: StemAvailability;
  /** Tempo/key data used by the live mixer when available. */
  analysis?: TrackAnalysis | null;
  /** The existing container project — "Open in Studio" routes here. */
  studioProjectId: string;
}

export interface TrackStem {
  id: string;
  stemType: string;
  engine: string;
  durationSeconds: number;
}

export interface TrackAnalysis {
  status: string;
  bpm: number | null;
  musicalKey: string | null;
}

export interface TrackDetail extends TrackSummary {
  source: {
    id: string;
    originalFilename: string;
    codec: string;
    sampleRate: number;
    channels: number;
    bitrate: number | null;
  };
  stems: TrackStem[];
  analysis: TrackAnalysis | null;
  /** What the player should load. Stems when separated (any count), the
   * source asset itself otherwise — honest, always real audio. */
  playback: { assetIds: string[]; kind: "stems" | "source" };
}

export type StartTrackSeparationResult =
  | { outcome: "not-found" }
  | { outcome: "already-separated"; stemCount: number }
  | { outcome: "already-active"; job: ProcessingJobRow | null }
  | { outcome: "previous-attempt"; job: ProcessingJobRow }
  | { outcome: "queued"; job: ProcessingJobRow }
  | { outcome: "not-queued"; job: ProcessingJobRow; reason: string };

interface TrackRow {
  id: string;
  title: string;
  artist: string;
  album: string;
  durationSeconds: number;
  playCount: number;
  rating: number;
  labels: string | null;
  lastPlayedAt: Date | null;
  createdAt: Date;
  projectId: string;
  sourceAssetId: string;
}

/** Compute honest stem availability for many tracks in two queries. */
async function availabilityBySource(
  sourceAssetIds: string[],
): Promise<Map<string, StemAvailability>> {
  const map = new Map<string, StemAvailability>();
  if (sourceAssetIds.length === 0) return map;
  const [stemRows, jobRows] = await Promise.all([
    db
      .select({ sourceAssetId: stemAssets.sourceAssetId, stemType: stemAssets.stemType, engine: stemAssets.engine })
      .from(stemAssets)
      .where(inArray(stemAssets.sourceAssetId, sourceAssetIds)),
    db
      .select({
        id: processingJobs.id,
        sourceAssetId: processingJobs.sourceAssetId,
        status: processingJobs.status,
        stage: processingJobs.stage,
        errorCode: processingJobs.errorCode,
        metadata: processingJobs.metadata,
      })
      .from(processingJobs)
      .where(
        and(
          inArray(processingJobs.sourceAssetId, sourceAssetIds),
          eq(processingJobs.type, "separation"),
        ),
      )
      .orderBy(desc(processingJobs.updatedAt), desc(processingJobs.createdAt)),
  ]);
  const pendingBySource = new Set(
    jobRows
      .filter((row) => ["queued", "preparing", "running", "processing", "finalizing"].includes(row.status))
      .map((row) => row.sourceAssetId),
  );
  const latestJobBySource = new Map<string, (typeof jobRows)[number]>();
  for (const job of jobRows) {
    if (!latestJobBySource.has(job.sourceAssetId)) latestJobBySource.set(job.sourceAssetId, job);
  }
  for (const id of sourceAssetIds) {
    const stems = stemRows.filter((row) => row.sourceAssetId === id);
    map.set(
      id,
      resolveStemAvailability({
        stems,
        separationPending: pendingBySource.has(id),
        separationJob: latestJobBySource.get(id),
      }),
    );
  }
  return map;
}

function toSummary(row: TrackRow, availability: StemAvailability): TrackSummary {
  return {
    id: row.id,
    sourceAssetId: row.sourceAssetId,
    title: row.title,
    artist: row.artist,
    album: row.album,
    durationSeconds: row.durationSeconds,
    playCount: row.playCount,
    rating: row.rating,
    labels: parseStoredLabels(row.labels),
    lastPlayedAt: row.lastPlayedAt?.toISOString() ?? null,
    addedAt: row.createdAt.toISOString(),
    stemAvailability: availability,
    studioProjectId: row.projectId,
  };
}

/** Stored labels column → normalised label list (corrupt JSON reads as none). */
function parseStoredLabels(raw: string | null): string[] {
  if (raw === null || raw.trim() === "") return [];
  try {
    return normalizeLabels(JSON.parse(raw));
  } catch {
    return [];
  }
}

async function summariesFor(rows: TrackRow[]): Promise<TrackSummary[]> {
  const sourceAssetIds = rows.map((row) => row.sourceAssetId);
  const [availability, analyses] = await Promise.all([
    availabilityBySource(sourceAssetIds),
    analysisBySource(sourceAssetIds),
  ]);
  return rows.map((row) => ({
    ...toSummary(row, availability.get(row.sourceAssetId) ?? resolveStemAvailability({ stems: [] })),
    analysis: analyses.get(row.sourceAssetId) ?? null,
  }));
}

async function analysisBySource(sourceAssetIds: string[]): Promise<Map<string, TrackAnalysis>> {
  const uniqueIds = [...new Set(sourceAssetIds)];
  if (uniqueIds.length === 0) return new Map();
  const rows = await db
    .select({
      sourceAssetId: sourceAnalyses.sourceAssetId,
      status: sourceAnalyses.status,
      bpm: sourceAnalyses.bpm,
      musicalKey: sourceAnalyses.musicalKey,
    })
    .from(sourceAnalyses)
    .where(inArray(sourceAnalyses.sourceAssetId, uniqueIds));
  return new Map(rows.map((row) => [
    row.sourceAssetId,
    { status: row.status, bpm: row.bpm, musicalKey: row.musicalKey },
  ]));
}

const trackSelection = {
  id: tracks.id,
  title: tracks.title,
  artist: tracks.artist,
  album: tracks.album,
  durationSeconds: tracks.durationSeconds,
  playCount: tracks.playCount,
  rating: tracks.rating,
  labels: tracks.labels,
  lastPlayedAt: tracks.lastPlayedAt,
  createdAt: tracks.createdAt,
  projectId: tracks.projectId,
  sourceAssetId: tracks.sourceAssetId,
};

// -------------------------------------------------------------------- intake

export interface AddTrackResult {
  track: TrackSummary;
  /** False when an identical file (same checksum) was already in the
   * library — the existing track is returned and NO new audio stored. */
  created: boolean;
  /** Honest enqueue state from the shared intake path. */
  separationQueued: boolean;
}

/**
 * Serialize library intake for the same owner and audio content across API
 * processes. The lock is session-scoped because ingestion uses the shared DB
 * pool and must not hold an open transaction while writing files/enqueuing.
 */
async function withLibraryUploadLock<T>(
  ownerId: string,
  checksum: string,
  operation: () => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  const lockKey = `waveyard-library-upload:${ownerId}:${checksum}`;
  let locked = false;
  try {
    await client.query("SELECT pg_advisory_lock(hashtextextended($1, 0))", [lockKey]);
    locked = true;
    return await operation();
  } finally {
    try {
      if (locked) {
        await client.query("SELECT pg_advisory_unlock(hashtextextended($1, 0))", [lockKey]);
      }
    } finally {
      client.release();
    }
  }
}

/**
 * Add an audio FILE as MUSIC: create (or reuse) the library container
 * project, run the existing source-intake pipeline (probe, checksum, private
 * storage, separation/waveform jobs), and create the listening Track.
 *
 * Idempotent per file content: a second add of the same bytes returns the
 * existing track without storing anything.
 */
export async function addTrackFromAudioFile(input: {
  ownerId: string;
  filePath: string;
  filename: string;
  mimeType: string;
  model?: string;
  device?: "auto" | "cpu" | "cuda";
  title?: string;
  artist?: string;
  album?: string;
  prepareSeparation?: boolean;
}): Promise<AddTrackResult> {
  const checksum = await checksumFile(input.filePath);

  return withLibraryUploadLock(input.ownerId, checksum, async () => {
    const [existing] = await db
      .select(trackSelection)
      .from(tracks)
      .innerJoin(sourceAssets, eq(tracks.sourceAssetId, sourceAssets.id))
      .where(and(eq(tracks.ownerId, input.ownerId), eq(sourceAssets.checksumSha256, checksum)))
      .orderBy(desc(tracks.createdAt))
      .limit(1);
    if (existing !== undefined) {
      const [summary] = await summariesFor([existing]);
      return { track: summary, created: false, separationQueued: false };
    }

    const derived = deriveTrackMetadata(input.filename);
    const title = (input.title ?? "").trim() || derived.title;
    const artist = (input.artist ?? "").trim() || derived.artist;

    // A previous request may have completed source/job creation but lost its
    // client before it inserted the library track. Reuse that committed intake
    // rather than storing the same audio and scheduling another job.
    const [orphanedIntake] = await db
      .select({ source: sourceAssets, projectId: projects.id })
      .from(sourceAssets)
      .innerJoin(projects, eq(sourceAssets.projectId, projects.id))
      .where(and(
        eq(projects.ownerId, input.ownerId),
        eq(projects.kind, "library"),
        eq(sourceAssets.checksumSha256, checksum),
      ))
      .orderBy(asc(sourceAssets.createdAt))
      .limit(1);

    if (orphanedIntake !== undefined) {
      const [row] = await db
        .insert(tracks)
        .values({
          ownerId: input.ownerId,
          sourceChecksumSha256: checksum,
          title,
          artist,
          album: input.album ?? "",
          sourceAssetId: orphanedIntake.source.id,
          projectId: orphanedIntake.projectId,
          durationSeconds: orphanedIntake.source.durationSeconds,
        })
        .returning(trackSelection);
      const [summary] = await summariesFor([row]);
      const [activeSeparation] = await db
        .select({ id: processingJobs.id })
        .from(processingJobs)
        .where(and(
          eq(processingJobs.sourceAssetId, orphanedIntake.source.id),
          eq(processingJobs.type, "separation"),
          inArray(processingJobs.status, ["queued", "running"]),
        ))
        .limit(1);
      return { track: summary, created: true, separationQueued: activeSeparation !== undefined };
    }

    const [container] = await db
      .insert(projects)
      .values({
        ownerId: input.ownerId,
        title: libraryContainerProjectName(title),
        description: "Waveyard library container — created automatically when this track was added as music.",
        kind: "library",
        visibility: "private",
      })
      .returning({ id: projects.id });

    const ingestInput = {
      projectId: container.id,
      filePath: input.filePath,
      filename: input.filename,
      mimeType: input.mimeType,
      model: input.model ?? defaultSeparationModel(),
      device: input.device ?? "auto",
      provenance: { method: "local-upload" as const, title, artist, metadata: { intake: "waveyard-library" } },
    };
    const ingest = input.prepareSeparation === false
      ? await ingestSourceFile({ ...ingestInput, prepareProcessing: false })
      : await ingestSourceFile({ ...ingestInput, prepareProcessing: true });

    const [row] = await db
      .insert(tracks)
      .values({
        ownerId: input.ownerId,
        sourceChecksumSha256: checksum,
        title,
        artist,
        album: input.album ?? "",
        sourceAssetId: ingest.source.id,
        projectId: container.id,
        durationSeconds: ingest.source.durationSeconds,
      })
      .returning(trackSelection);
    const [summary] = await summariesFor([row]);
    return { track: summary, created: true, separationQueued: ingest.separationQueued };
  });
}

// ------------------------------------------------------------- track reading

export async function listTracks(input: {
  ownerId: string;
  search?: string;
  limit?: number;
}): Promise<TrackSummary[]> {
  const search = (input.search ?? "").trim().replace(/\s+/g, " ");
  const limit = Math.min(Math.max(input.limit ?? 200, 1), 500);
  const rows = search
    ? await db
        .select(trackSelection)
        .from(tracks)
        .where(
          and(
            eq(tracks.ownerId, input.ownerId),
            or(
              ilike(tracks.title, `%${search}%`),
              ilike(tracks.artist, `%${search}%`),
              ilike(tracks.album, `%${search}%`),
            ),
          ),
        )
        .orderBy(desc(tracks.createdAt))
        .limit(limit)
    : await db
        .select(trackSelection)
        .from(tracks)
        .where(eq(tracks.ownerId, input.ownerId))
        .orderBy(desc(tracks.createdAt))
        .limit(limit);
  return summariesFor(rows);
}

export async function listRecentlyPlayed(ownerId: string, limit = 12): Promise<TrackSummary[]> {
  const rows = await db
    .select(trackSelection)
    .from(tracks)
    .where(and(eq(tracks.ownerId, ownerId), sql`${tracks.lastPlayedAt} is not null`))
    .orderBy(desc(tracks.lastPlayedAt))
    .limit(Math.min(Math.max(limit, 1), 100));
  return summariesFor(rows);
}

export async function getTrack(ownerId: string, trackId: string): Promise<TrackDetail | null> {
  const [row] = await db
    .select(trackSelection)
    .from(tracks)
    .where(and(eq(tracks.id, trackId), eq(tracks.ownerId, ownerId)))
    .limit(1);
  if (row === undefined) return null;

  const [source] = await db.select().from(sourceAssets).where(eq(sourceAssets.id, row.sourceAssetId)).limit(1);
  if (source === undefined) return null;

  const stemRows = await db
    .select({
      id: stemAssets.id,
      stemType: stemAssets.stemType,
      engine: stemAssets.engine,
      durationSeconds: stemAssets.durationSeconds,
    })
    .from(stemAssets)
    .where(eq(stemAssets.sourceAssetId, row.sourceAssetId));

  const [analysis] = await db
    .select({
      status: sourceAnalyses.status,
      bpm: sourceAnalyses.bpm,
      musicalKey: sourceAnalyses.musicalKey,
    })
    .from(sourceAnalyses)
    .where(eq(sourceAnalyses.sourceAssetId, row.sourceAssetId))
    .limit(1);

  const [latestJob] = await db
    .select({
      id: processingJobs.id,
      status: processingJobs.status,
      stage: processingJobs.stage,
      errorCode: processingJobs.errorCode,
      metadata: processingJobs.metadata,
    })
    .from(processingJobs)
    .where(and(eq(processingJobs.sourceAssetId, row.sourceAssetId), eq(processingJobs.type, "separation")))
    .orderBy(desc(processingJobs.updatedAt), desc(processingJobs.createdAt))
    .limit(1);
  const availability = resolveStemAvailability({
    stems: stemRows,
    separationPending: latestJob !== undefined && ["queued", "preparing", "running", "processing", "finalizing"].includes(latestJob.status),
    separationJob: latestJob,
  });
  const realStems = stemRows.filter((stem) => stem.engine !== "passthrough-unseparated");
  const passthrough = stemRows.find((stem) => stem.engine === "passthrough-unseparated");
  const playback =
    realStems.length > 0
      ? { assetIds: realStems.map((stem) => stem.id), kind: "stems" as const }
      : { assetIds: [passthrough?.id ?? source.id], kind: "source" as const };

  return {
    ...toSummary(row, availability),
    source: {
      id: source.id,
      originalFilename: source.originalFilename,
      codec: source.codec,
      sampleRate: source.sampleRate,
      channels: source.channels,
      bitrate: source.bitrate,
    },
    stems: stemRows,
    analysis: analysis ?? null,
    playback,
  };
}

/**
 * Start the normal separation pipeline for a library track that has never
 * had a separation job. The claim helper makes duplicate clicks idempotent
 * and records queue refusal as a retryable failure instead of leaving a
 * queued row with no worker.
 */
export async function startSeparationForTrack(
  ownerId: string,
  trackId: string,
  deps?: StartSeparationDeps,
): Promise<StartTrackSeparationResult> {
  const [track] = await db
    .select({ projectId: tracks.projectId, sourceAssetId: tracks.sourceAssetId })
    .from(tracks)
    .where(and(eq(tracks.ownerId, ownerId), eq(tracks.id, trackId)))
    .limit(1);
  if (!track) return { outcome: "not-found" };

  const [stemRows, previousJobs] = await Promise.all([
    db
      .select({ engine: stemAssets.engine })
      .from(stemAssets)
      .where(eq(stemAssets.sourceAssetId, track.sourceAssetId)),
    db
      .select()
      .from(processingJobs)
      .where(and(
        eq(processingJobs.sourceAssetId, track.sourceAssetId),
        eq(processingJobs.type, "separation"),
      ))
      .orderBy(desc(processingJobs.updatedAt), desc(processingJobs.createdAt))
      .limit(1),
  ]);

  const realStemCount = stemRows.filter((stem) => stem.engine !== "passthrough-unseparated").length;
  if (realStemCount > 0) return { outcome: "already-separated", stemCount: realStemCount };

  const previousJob = previousJobs[0];
  if (previousJob && !PROCESSING_JOB_TERMINAL_STATUSES.includes(previousJob.status as typeof PROCESSING_JOB_TERMINAL_STATUSES[number])) {
    return { outcome: "already-active", job: previousJob };
  }
  if (previousJob && previousJob.status !== "cancelled") {
    return { outcome: "previous-attempt", job: previousJob };
  }

  const model = defaultSeparationModel();
  const started = await startSeparationJob(
    db,
    {
      projectId: track.projectId,
      sourceAssetId: track.sourceAssetId,
      type: "separation",
      status: "queued",
      stage: "queued",
      idempotencyKey: `separation:${track.sourceAssetId}:${model}`,
      model,
      requestedDevice: "auto",
      metadata: JSON.stringify({ intake: "waveyard-library", trigger: "direct-start" }),
    },
    (job) => ({
      processingJobId: job.id,
      projectId: track.projectId,
      sourceAssetId: track.sourceAssetId,
      model,
      requestedDevice: "auto",
    }),
    deps,
  );

  if (started.outcome === "active") return { outcome: "already-active", job: started.active };
  if (started.outcome === "not-queued") {
    return { outcome: "not-queued", job: started.job, reason: started.reason };
  }
  return { outcome: "queued", job: started.job };
}

// ------------------------------------------------------- play count + state

export async function recordPlay(
  ownerId: string,
  trackId: string,
): Promise<TrackSummary | null> {
  const [updated] = await db
    .update(tracks)
    .set({ playCount: sql`${tracks.playCount} + 1`, lastPlayedAt: new Date() })
    .where(and(eq(tracks.id, trackId), eq(tracks.ownerId, ownerId)))
    .returning(trackSelection);
  if (updated === undefined) return null;
  await savePlaybackState(ownerId, { currentTrackId: trackId });
  const [summary] = await summariesFor([updated]);
  return summary;
}

export interface PlaybackStatePayload {
  currentTrackId: string | null;
  positionSeconds: number;
  stemMix: StemMix;
  masterVolume: number;
  repeatMode: "off" | "all" | "one";
  shuffle: boolean;
  updatedAt: string;
}

export async function getPlaybackState(ownerId: string): Promise<PlaybackStatePayload> {
  const [row] = await db.select().from(playbackState).where(eq(playbackState.ownerId, ownerId)).limit(1);
  if (row === undefined) {
    return {
      currentTrackId: null,
      positionSeconds: 0,
      stemMix: {},
      masterVolume: 1,
      repeatMode: "off",
      shuffle: false,
      updatedAt: new Date(0).toISOString(),
    };
  }
  return {
    currentTrackId: row.currentTrackId,
    positionSeconds: row.positionSeconds,
    stemMix: parseStemMix(row.stemMix),
    masterVolume: row.masterVolume,
    repeatMode: (["off", "all", "one"] as const).includes(row.repeatMode as "off")
      ? (row.repeatMode as "off" | "all" | "one")
      : "off",
    shuffle: row.shuffle,
    updatedAt: row.updatedAt.toISOString(),
  };
}

export async function savePlaybackState(
  ownerId: string,
  patch: {
    currentTrackId?: string | null;
    positionSeconds?: number;
    stemMix?: StemMix;
    masterVolume?: number;
    repeatMode?: "off" | "all" | "one";
    shuffle?: boolean;
  },
): Promise<PlaybackStatePayload> {
  const values = {
    ownerId,
    currentTrackId: patch.currentTrackId ?? null,
    positionSeconds:
      typeof patch.positionSeconds === "number" && Number.isFinite(patch.positionSeconds)
        ? Math.max(0, patch.positionSeconds)
        : 0,
    stemMix: serializeStemMix(patch.stemMix !== undefined ? normalizeStemMix(patch.stemMix) : {}),
    masterVolume:
      typeof patch.masterVolume === "number" && Number.isFinite(patch.masterVolume)
        ? Math.min(1.5, Math.max(0, patch.masterVolume))
        : 1,
    repeatMode: patch.repeatMode ?? "off",
    shuffle: patch.shuffle === true,
    updatedAt: new Date(),
  };
  if (values.currentTrackId !== null) {
    // Never persist a pointer to a track this owner does not have.
    const [owned] = await db
      .select({ id: tracks.id })
      .from(tracks)
      .where(and(eq(tracks.id, values.currentTrackId), eq(tracks.ownerId, ownerId)))
      .limit(1);
    if (owned === undefined) values.currentTrackId = null;
  }
  await db
    .insert(playbackState)
    .values(values)
    .onConflictDoUpdate({
      target: playbackState.ownerId,
      set: {
        currentTrackId: values.currentTrackId,
        positionSeconds: values.positionSeconds,
        stemMix: values.stemMix,
        masterVolume: values.masterVolume,
        repeatMode: values.repeatMode,
        shuffle: values.shuffle,
        updatedAt: values.updatedAt,
      },
    });
  return getPlaybackState(ownerId);
}

// -------------------------------------------------------------------- queue

export interface QueueItemPayload {
  id: string;
  position: number;
  track: TrackSummary;
}

export interface QueueEditPayload {
  queue: QueueItemPayload[];
  affectedSessionIds: string[];
}

export interface QueueAddPayload {
  queue: QueueItemPayload[];
  addedQueueItemId: string;
}

async function queueTracks(ownerId: string): Promise<QueueItemPayload[]> {
  const rows = await db
    .select({ item: queueItems, track: trackSelection })
    .from(queueItems)
    .innerJoin(tracks, eq(queueItems.trackId, tracks.id))
    .where(eq(queueItems.ownerId, ownerId))
    .orderBy(asc(queueItems.position));
  const summaries = await summariesFor(rows.map((row) => row.track));
  return rows.map((row, index) => ({
    id: row.item.id,
    position: index,
    track: summaries[index],
  }));
}

export async function listQueue(ownerId: string): Promise<QueueItemPayload[]> {
  return queueTracks(ownerId);
}

/** Add a track to the queue — at the end, or "next" (right after the
 * currently playing track; at the head when nothing relevant is queued). */
export async function addToQueue(input: {
  ownerId: string;
  trackId: string;
  at?: "end" | "next";
  /** The currently playing track (positions "next" right after it). */
  currentTrackId?: string | null;
}): Promise<QueueAddPayload> {
  const [track] = await db
    .select({ id: tracks.id })
    .from(tracks)
    .where(and(eq(tracks.id, input.trackId), eq(tracks.ownerId, input.ownerId)))
    .limit(1);
  if (track === undefined) throw new TrackNotFoundError();

  const rows = await db
    .select({ id: queueItems.id, trackId: queueItems.trackId })
    .from(queueItems)
    .where(eq(queueItems.ownerId, input.ownerId))
    .orderBy(asc(queueItems.position));

  const [item] = await db
    .insert(queueItems)
    .values({ ownerId: input.ownerId, trackId: input.trackId, position: rows.length })
    .returning({ id: queueItems.id });

  let orderedIds = [...rows.map((row) => row.id), item.id];
  if ((input.at ?? "end") === "next") {
    orderedIds = orderedIds.filter((id) => id !== item.id);
    let insertAt = 0;
    if (input.currentTrackId !== undefined && input.currentTrackId !== null) {
      const currentIndex = rows.findIndex((row) => row.trackId === input.currentTrackId);
      if (currentIndex >= 0) insertAt = currentIndex + 1;
    }
    orderedIds.splice(insertAt, 0, item.id);
  }
  await resequenceQueue(input.ownerId, orderedIds);
  return { queue: await queueTracks(input.ownerId), addedQueueItemId: item.id };
}

async function resequenceQueue(ownerId: string, orderedIds: string[]): Promise<void> {
  await db.transaction(async (tx) => {
    for (const [index, id] of orderedIds.entries()) {
      await tx.update(queueItems).set({ position: index }).where(and(eq(queueItems.id, id), eq(queueItems.ownerId, ownerId)));
    }
  });
}

async function resequenceSessionsAfterQueueEdit(sessionIds: string[]): Promise<void> {
  for (const sessionId of sessionIds) {
    const rows = await db
      .select({ id: listenSessionTracks.id })
      .from(listenSessionTracks)
      .where(eq(listenSessionTracks.sessionId, sessionId))
      .orderBy(asc(listenSessionTracks.position));
    await db.transaction(async (tx) => {
      for (const [position, row] of rows.entries()) {
        await tx.update(listenSessionTracks).set({ position }).where(eq(listenSessionTracks.id, row.id));
      }
    });
  }
}

async function linkedQueueEntries(ownerId: string, queueIds?: string[]) {
  const rows = await db
    .select({ sessionId: listenSessionTracks.sessionId, sessionTrackId: listenSessionTracks.id })
    .from(queueItems)
    .innerJoin(listenSessionTracks, eq(listenSessionTracks.queueItemId, queueItems.id))
    .where(queueIds === undefined
      ? eq(queueItems.ownerId, ownerId)
      : and(eq(queueItems.ownerId, ownerId), inArray(queueItems.id, queueIds)));
  return rows;
}

async function deleteSavedQueueItems(ownerId: string, itemIds?: string[]): Promise<string[]> {
  const rows = await linkedQueueEntries(ownerId, itemIds);
  const sessionIds = [...new Set(rows.map((row) => row.sessionId))];
  const now = new Date();
  await db.transaction(async (tx) => {
    if (sessionIds.length > 0) {
      await tx.update(listenSessions)
        .set({ updatedAt: now })
        .where(and(eq(listenSessions.ownerId, ownerId), inArray(listenSessions.id, sessionIds)));
      await tx.update(listenSessions)
        .set({ currentTrackId: null, positionSeconds: 0, updatedAt: now })
        .where(and(
          eq(listenSessions.ownerId, ownerId),
          inArray(listenSessions.currentTrackId, rows.map((row) => row.sessionTrackId)),
        ));
    }
    await tx.delete(queueItems).where(itemIds === undefined
      ? eq(queueItems.ownerId, ownerId)
      : and(eq(queueItems.ownerId, ownerId), inArray(queueItems.id, itemIds)));
  });
  await resequenceSessionsAfterQueueEdit(sessionIds);
  return sessionIds;
}

export async function removeQueueItem(ownerId: string, itemId: string): Promise<QueueEditPayload> {
  const affectedSessionIds = await deleteSavedQueueItems(ownerId, [itemId]);
  await resequenceQueue(ownerId, await remainingIds(ownerId));
  return { queue: await queueTracks(ownerId), affectedSessionIds };
}

async function remainingIds(ownerId: string): Promise<string[]> {
  const rows = await db
    .select({ id: queueItems.id })
    .from(queueItems)
    .where(eq(queueItems.ownerId, ownerId))
    .orderBy(asc(queueItems.position));
  return rows.map((row) => row.id);
}

export async function moveQueueItem(
  ownerId: string,
  itemId: string,
  position: number,
  sessionId?: string,
): Promise<QueueEditPayload> {
  const ids = await remainingIds(ownerId);
  const from = ids.indexOf(itemId);
  if (from === -1) throw new QueueItemNotFoundError();
  const to = Math.min(Math.max(Math.trunc(position), 0), ids.length - 1);
  ids.splice(to, 0, ids.splice(from, 1)[0]);
  const affectedSessionIds: string[] = [];

  await db.transaction(async (tx) => {
    for (const [index, id] of ids.entries()) {
      await tx.update(queueItems)
        .set({ position: index })
        .where(and(eq(queueItems.id, id), eq(queueItems.ownerId, ownerId)));
    }

    if (sessionId === undefined) return;
    const [ownedSession] = await tx
      .select({ id: listenSessions.id })
      .from(listenSessions)
      .where(and(eq(listenSessions.id, sessionId), eq(listenSessions.ownerId, ownerId)))
      .limit(1);
    if (ownedSession === undefined) throw new QueueSessionNotFoundError();

    const sessionRows = await tx
      .select({ id: listenSessionTracks.id, queueItemId: listenSessionTracks.queueItemId })
      .from(listenSessionTracks)
      .where(eq(listenSessionTracks.sessionId, sessionId))
      .orderBy(asc(listenSessionTracks.position));
    const queueRank = new Map(ids.map((id, index) => [id, index]));
    const linkedRows = sessionRows
      .filter((row) => row.queueItemId !== null && queueRank.has(row.queueItemId))
      .sort((a, b) => queueRank.get(a.queueItemId!)! - queueRank.get(b.queueItemId!)!);
    if (linkedRows.length < 2) return;

    // Reorder only the session positions occupied by saved-queue entries.
    // Direct playlist/session additions keep their positions and relative order.
    const reorderedIds = sessionRows.map((row) => row.id);
    const linkedPositions = sessionRows
      .map((row, index) => row.queueItemId !== null && queueRank.has(row.queueItemId) ? index : -1)
      .filter((index) => index >= 0);
    linkedPositions.forEach((position, index) => {
      reorderedIds[position] = linkedRows[index].id;
    });
    if (reorderedIds.every((id, index) => id === sessionRows[index].id)) return;

    for (const [position, id] of reorderedIds.entries()) {
      await tx.update(listenSessionTracks)
        .set({ position })
        .where(and(eq(listenSessionTracks.id, id), eq(listenSessionTracks.sessionId, sessionId)));
    }
    await tx.update(listenSessions)
      .set({ updatedAt: new Date() })
      .where(and(eq(listenSessions.id, sessionId), eq(listenSessions.ownerId, ownerId)));
    affectedSessionIds.push(sessionId);
  });

  return { queue: await queueTracks(ownerId), affectedSessionIds };
}

export async function clearQueue(ownerId: string): Promise<QueueEditPayload> {
  const affectedSessionIds = await deleteSavedQueueItems(ownerId);
  return { queue: [], affectedSessionIds };
}

// ---------------------------------------------------------------- playlists

export interface PlaylistSummary {
  id: string;
  name: string;
  trackCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface PlaylistItemPayload {
  id: string;
  position: number;
  track: TrackSummary;
}

export interface PlaylistDetail {
  id: string;
  name: string;
  items: PlaylistItemPayload[];
}

export class TrackNotFoundError extends Error {
  constructor() {
    super("Track not found.");
  }
}

export class QueueItemNotFoundError extends Error {
  constructor() {
    super("Queue item not found.");
  }
}

export class QueueSessionNotFoundError extends Error {
  constructor() {
    super("Listening session not found.");
  }
}

export class PlaylistNotFoundError extends Error {
  constructor() {
    super("Playlist not found.");
  }
}

export async function createPlaylist(ownerId: string, name: string): Promise<PlaylistSummary> {
  const [row] = await db
    .insert(playlists)
    .values({ ownerId, name })
    .returning();
  return { id: row.id, name: row.name, trackCount: 0, createdAt: row.createdAt.toISOString(), updatedAt: row.updatedAt.toISOString() };
}

export async function listPlaylists(ownerId: string): Promise<PlaylistSummary[]> {
  const rows = await db
    .select({
      id: playlists.id,
      name: playlists.name,
      createdAt: playlists.createdAt,
      updatedAt: playlists.updatedAt,
      trackCount: sql<number>`cast(count(${playlistItems.id}) as int)`,
    })
    .from(playlists)
    .leftJoin(playlistItems, eq(playlistItems.playlistId, playlists.id))
    .where(eq(playlists.ownerId, ownerId))
    .groupBy(playlists.id)
    .orderBy(desc(playlists.updatedAt));
  return rows.map((row) => ({
    id: row.id,
    name: row.name,
    trackCount: row.trackCount,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  }));
}

async function ownedPlaylist(ownerId: string, playlistId: string) {
  const [row] = await db
    .select({ id: playlists.id })
    .from(playlists)
    .where(and(eq(playlists.id, playlistId), eq(playlists.ownerId, ownerId)))
    .limit(1);
  if (row === undefined) throw new PlaylistNotFoundError();
  return row;
}

async function playlistPayload(playlistId: string): Promise<PlaylistDetail> {
  const rows = await db
    .select({ item: playlistItems, track: trackSelection })
    .from(playlistItems)
    .innerJoin(tracks, eq(playlistItems.trackId, tracks.id))
    .where(eq(playlistItems.playlistId, playlistId))
    .orderBy(asc(playlistItems.position));
  const [playlist] = await db.select().from(playlists).where(eq(playlists.id, playlistId)).limit(1);
  const summaries = await summariesFor(rows.map((row) => row.track));
  return {
    id: playlistId,
    name: playlist?.name ?? "",
    items: rows.map((row, index) => ({ id: row.item.id, position: index, track: summaries[index] })),
  };
}

export async function getPlaylist(ownerId: string, playlistId: string): Promise<PlaylistDetail> {
  await ownedPlaylist(ownerId, playlistId);
  return playlistPayload(playlistId);
}

export async function renamePlaylist(ownerId: string, playlistId: string, name: string): Promise<PlaylistSummary> {
  await ownedPlaylist(ownerId, playlistId);
  const [row] = await db
    .update(playlists)
    .set({ name, updatedAt: new Date() })
    .where(eq(playlists.id, playlistId))
    .returning();
  const count = await playlistTrackCount(playlistId);
  return { id: row.id, name: row.name, trackCount: count, createdAt: row.createdAt.toISOString(), updatedAt: row.updatedAt.toISOString() };
}

async function playlistTrackCount(playlistId: string): Promise<number> {
  const [row] = await db
    .select({ count: sql<number>`cast(count(*) as int)` })
    .from(playlistItems)
    .where(eq(playlistItems.playlistId, playlistId));
  return row?.count ?? 0;
}

export async function deletePlaylist(ownerId: string, playlistId: string): Promise<void> {
  await ownedPlaylist(ownerId, playlistId);
  await db.delete(playlists).where(eq(playlists.id, playlistId));
}

export async function addTrackToPlaylist(input: {
  ownerId: string;
  playlistId: string;
  trackId: string;
  position?: number;
}): Promise<PlaylistDetail> {
  await ownedPlaylist(input.ownerId, input.playlistId);
  const [track] = await db
    .select({ id: tracks.id })
    .from(tracks)
    .where(and(eq(tracks.id, input.trackId), eq(tracks.ownerId, input.ownerId)))
    .limit(1);
  if (track === undefined) throw new TrackNotFoundError();

  await db.transaction(async (tx) => {
    const rows = await tx
      .select({ id: playlistItems.id })
      .from(playlistItems)
      .where(eq(playlistItems.playlistId, input.playlistId))
      .orderBy(asc(playlistItems.position));
    const [item] = await tx
      .insert(playlistItems)
      .values({ playlistId: input.playlistId, trackId: input.trackId, position: rows.length })
      .returning({ id: playlistItems.id });
    const ordered = [...rows.map((row) => row.id), item.id];
    if (input.position !== undefined) {
      const to = Math.min(Math.max(Math.trunc(input.position), 0), ordered.length - 1);
      const from = ordered.length - 1;
      ordered.splice(to, 0, ordered.splice(from, 1)[0]);
    }
    for (const [index, id] of ordered.entries()) {
      await tx.update(playlistItems).set({ position: index }).where(and(eq(playlistItems.id, id), eq(playlistItems.playlistId, input.playlistId)));
    }
    await tx.update(playlists).set({ updatedAt: new Date() }).where(eq(playlists.id, input.playlistId));
  });
  return playlistPayload(input.playlistId);
}

export async function removePlaylistItem(
  ownerId: string,
  playlistId: string,
  itemId: string,
): Promise<PlaylistDetail> {
  await ownedPlaylist(ownerId, playlistId);
  await db.transaction(async (tx) => {
    await tx.delete(playlistItems).where(and(eq(playlistItems.id, itemId), eq(playlistItems.playlistId, playlistId)));
    const rows = await tx
      .select({ id: playlistItems.id })
      .from(playlistItems)
      .where(eq(playlistItems.playlistId, playlistId))
      .orderBy(asc(playlistItems.position));
    for (const [index, row] of rows.entries()) {
      await tx.update(playlistItems).set({ position: index }).where(and(eq(playlistItems.id, row.id), eq(playlistItems.playlistId, playlistId)));
    }
    await tx.update(playlists).set({ updatedAt: new Date() }).where(eq(playlists.id, playlistId));
  });
  return playlistPayload(playlistId);
}

export async function movePlaylistItem(
  ownerId: string,
  playlistId: string,
  itemId: string,
  position: number,
): Promise<PlaylistDetail> {
  await ownedPlaylist(ownerId, playlistId);
  await db.transaction(async (tx) => {
    const rows = await tx
      .select({ id: playlistItems.id })
      .from(playlistItems)
      .where(eq(playlistItems.playlistId, playlistId))
      .orderBy(asc(playlistItems.position));
    const ids = rows.map((row) => row.id);
    const from = ids.indexOf(itemId);
    if (from === -1) throw new QueueItemNotFoundError();
    const to = Math.min(Math.max(Math.trunc(position), 0), ids.length - 1);
    ids.splice(to, 0, ids.splice(from, 1)[0]);
    for (const [index, id] of ids.entries()) {
      await tx.update(playlistItems).set({ position: index }).where(and(eq(playlistItems.id, id), eq(playlistItems.playlistId, playlistId)));
    }
    await tx.update(playlists).set({ updatedAt: new Date() }).where(eq(playlists.id, playlistId));
  });
  return playlistPayload(playlistId);
}

// ------------------------------------------------------------ studio listing

/**
 * Studio-facing project listing: production projects only. Library container
 * projects (kind='library') are implementation details of tracks and must
 * never appear here ("Open in Studio" still routes to them directly by id).
 */
export async function listStudioProjects(ownerId: string) {
  return db
    .select()
    .from(projects)
    .where(and(eq(projects.ownerId, ownerId), or(isNull(projects.kind), eq(projects.kind, "studio"))))
    .orderBy(desc(projects.updatedAt))
    .limit(50);
}

// ------------------------------------------------- track curation (HOME)

export type TrackCuration = { id: string; rating: number; labels: string[] };

/**
 * Update a track's rating and/or labels. Rating normalises to 0..5; labels
 * are normalised (trim/dedupe/cap) before storage. Returns the persisted
 * curation, or null when the track does not exist for this owner.
 */
export async function updateTrackCuration(
  ownerId: string,
  trackId: string,
  patch: { rating?: unknown; labels?: unknown },
): Promise<TrackCuration | null> {
  const values: Partial<{ rating: number; labels: string; updatedAt: Date }> = {};
  if (patch.rating !== undefined) values.rating = normalizeRating(patch.rating);
  if (patch.labels !== undefined) {
    if (!Array.isArray(patch.labels)) return null;
    values.labels = JSON.stringify(normalizeLabels(patch.labels));
  }
  if (Object.keys(values).length === 0) return null;
  values.updatedAt = new Date();
  const [row] = await db
    .update(tracks)
    .set(values)
    .where(and(eq(tracks.id, trackId), eq(tracks.ownerId, ownerId)))
    .returning();
  if (!row) return null;
  return { id: row.id, rating: row.rating, labels: parseStoredLabels(row.labels) };
}

// ------------------------------------------------- smart collections (HOME)

type SmartCollectionRow = typeof smartCollections.$inferSelect;

function collectionFromRow(row: SmartCollectionRow): SmartCollection | null {
  const rules = parseSmartRules(row.rulesJson);
  if (rules === null) return null; // corrupt row — readers skip it
  const match = row.match === "any" ? "any" : "all";
  return { id: row.id, name: row.name, match, rules };
}

export async function listSmartCollections(ownerId: string): Promise<SmartCollection[]> {
  const rows = await db
    .select()
    .from(smartCollections)
    .where(eq(smartCollections.ownerId, ownerId))
    .orderBy(asc(smartCollections.createdAt));
  return rows.map(collectionFromRow).filter((c): c is SmartCollection => c !== null);
}

export async function createSmartCollection(
  ownerId: string,
  input: { name: string; match: "all" | "any"; rules: unknown },
): Promise<SmartCollection | null> {
  const rules = normaliseSmartRules(input.rules);
  if (rules === null) return null;
  if (input.match !== "all" && input.match !== "any") return null;
  const [row] = await db
    .insert(smartCollections)
    .values({
      ownerId,
      name: input.name,
      match: input.match,
      rulesJson: JSON.stringify(rules),
    })
    .returning();
  return row ? collectionFromRow(row) : null;
}

export async function updateSmartCollection(
  ownerId: string,
  collectionId: string,
  patch: { name?: string; match?: "all" | "any"; rules?: unknown },
): Promise<SmartCollection | null> {
  const values: Partial<{ name: string; match: string; rulesJson: string; updatedAt: Date }> = {};
  if (patch.name !== undefined) values.name = patch.name;
  if (patch.match !== undefined) {
    if (patch.match !== "all" && patch.match !== "any") return null;
    values.match = patch.match;
  }
  if (patch.rules !== undefined) {
    const rules = normaliseSmartRules(patch.rules);
    if (rules === null) return null;
    values.rulesJson = JSON.stringify(rules);
  }
  if (Object.keys(values).length === 0) return null;
  values.updatedAt = new Date();
  const [row] = await db
    .update(smartCollections)
    .set(values)
    .where(and(eq(smartCollections.id, collectionId), eq(smartCollections.ownerId, ownerId)))
    .returning();
  return row ? collectionFromRow(row) : null;
}

export async function deleteSmartCollection(ownerId: string, collectionId: string): Promise<boolean> {
  const rows = await db
    .delete(smartCollections)
    .where(and(eq(smartCollections.id, collectionId), eq(smartCollections.ownerId, ownerId)))
    .returning({ id: smartCollections.id });
  return rows.length > 0;
}
