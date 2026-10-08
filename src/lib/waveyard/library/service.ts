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

import { db } from "@/db";
import {
  playbackState,
  playlistItems,
  playlists,
  processingJobs,
  projects,
  queueItems,
  sourceAnalyses,
  sourceAssets,
  stemAssets,
  tracks,
} from "@/db/waveyardSchema";
import { checksumFile } from "@/lib/waveyard/audio";
import { ingestSourceFile } from "@/lib/waveyard/source-ingest";
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
  title: string;
  artist: string;
  album: string;
  durationSeconds: number;
  playCount: number;
  lastPlayedAt: string | null;
  addedAt: string;
  stemAvailability: StemAvailability;
  /** The existing container project — "Open in Studio" routes here. */
  studioProjectId: string;
}

export interface TrackStem {
  id: string;
  stemType: string;
  engine: string;
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

interface TrackRow {
  id: string;
  title: string;
  artist: string;
  album: string;
  durationSeconds: number;
  playCount: number;
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
      .select({ sourceAssetId: processingJobs.sourceAssetId, status: processingJobs.status })
      .from(processingJobs)
      .where(
        and(
          inArray(processingJobs.sourceAssetId, sourceAssetIds),
          eq(processingJobs.type, "separation"),
          inArray(processingJobs.status, ["queued", "running"]),
        ),
      ),
  ]);
  const pendingBySource = new Set(jobRows.map((row) => row.sourceAssetId));
  for (const id of sourceAssetIds) {
    const stems = stemRows.filter((row) => row.sourceAssetId === id);
    map.set(
      id,
      resolveStemAvailability({ stems, separationPending: pendingBySource.has(id) }),
    );
  }
  return map;
}

function toSummary(row: TrackRow, availability: StemAvailability): TrackSummary {
  return {
    id: row.id,
    title: row.title,
    artist: row.artist,
    album: row.album,
    durationSeconds: row.durationSeconds,
    playCount: row.playCount,
    lastPlayedAt: row.lastPlayedAt?.toISOString() ?? null,
    addedAt: row.createdAt.toISOString(),
    stemAvailability: availability,
    studioProjectId: row.projectId,
  };
}

async function summariesFor(rows: TrackRow[]): Promise<TrackSummary[]> {
  const availability = await availabilityBySource(rows.map((row) => row.sourceAssetId));
  return rows.map((row) => toSummary(row, availability.get(row.sourceAssetId) ?? resolveStemAvailability({ stems: [] })));
}

const trackSelection = {
  id: tracks.id,
  title: tracks.title,
  artist: tracks.artist,
  album: tracks.album,
  durationSeconds: tracks.durationSeconds,
  playCount: tracks.playCount,
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
}): Promise<AddTrackResult> {
  const checksum = await checksumFile(input.filePath);

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

  const ingest = await ingestSourceFile({
    projectId: container.id,
    filePath: input.filePath,
    filename: input.filename,
    mimeType: input.mimeType,
    model: input.model ?? process.env.SEPARATION_MODEL ?? "htdemucs",
    device: input.device ?? "auto",
    provenance: { method: "local-upload", title, artist, metadata: { intake: "waveyard-library" } },
  });

  const [row] = await db
    .insert(tracks)
    .values({
      ownerId: input.ownerId,
      title,
      artist,
      album: "",
      sourceAssetId: ingest.source.id,
      projectId: container.id,
      durationSeconds: ingest.source.durationSeconds,
    })
    .returning(trackSelection);
  const [summary] = await summariesFor([row]);
  return { track: summary, created: true, separationQueued: ingest.separationQueued };
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
    .select({ id: stemAssets.id, stemType: stemAssets.stemType, engine: stemAssets.engine })
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

  const availability = resolveStemAvailability({ stems: stemRows });
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
}): Promise<QueueItemPayload[]> {
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
  return queueTracks(input.ownerId);
}

async function resequenceQueue(ownerId: string, orderedIds: string[]): Promise<void> {
  await db.transaction(async (tx) => {
    for (const [index, id] of orderedIds.entries()) {
      await tx.update(queueItems).set({ position: index }).where(and(eq(queueItems.id, id), eq(queueItems.ownerId, ownerId)));
    }
  });
}

export async function removeQueueItem(ownerId: string, itemId: string): Promise<QueueItemPayload[]> {
  await db.delete(queueItems).where(and(eq(queueItems.id, itemId), eq(queueItems.ownerId, ownerId)));
  await resequenceQueue(ownerId, await remainingIds(ownerId));
  return queueTracks(ownerId);
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
): Promise<QueueItemPayload[]> {
  const ids = await remainingIds(ownerId);
  const from = ids.indexOf(itemId);
  if (from === -1) throw new QueueItemNotFoundError();
  const to = Math.min(Math.max(Math.trunc(position), 0), ids.length - 1);
  ids.splice(to, 0, ids.splice(from, 1)[0]);
  await resequenceQueue(ownerId, ids);
  return queueTracks(ownerId);
}

export async function clearQueue(ownerId: string): Promise<QueueItemPayload[]> {
  await db.delete(queueItems).where(eq(queueItems.ownerId, ownerId));
  return [];
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

async function resequencePlaylist(playlistId: string, orderedIds: string[]): Promise<void> {
  await db.transaction(async (tx) => {
    for (const [index, id] of orderedIds.entries()) {
      await tx.update(playlistItems).set({ position: index }).where(and(eq(playlistItems.id, id), eq(playlistItems.playlistId, playlistId)));
    }
  });
}

async function playlistItemIds(playlistId: string): Promise<string[]> {
  const rows = await db
    .select({ id: playlistItems.id })
    .from(playlistItems)
    .where(eq(playlistItems.playlistId, playlistId))
    .orderBy(asc(playlistItems.position));
  return rows.map((row) => row.id);
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

  const ids = await playlistItemIds(input.playlistId);
  const [item] = await db
    .insert(playlistItems)
    .values({ playlistId: input.playlistId, trackId: input.trackId, position: ids.length })
    .returning({ id: playlistItems.id });
  const ordered = [...ids, item.id];
  if (input.position !== undefined) {
    const to = Math.min(Math.max(Math.trunc(input.position), 0), ordered.length - 1);
    const from = ordered.length - 1;
    ordered.splice(to, 0, ordered.splice(from, 1)[0]);
  }
  await resequencePlaylist(input.playlistId, ordered);
  await touchPlaylist(input.playlistId);
  return playlistPayload(input.playlistId);
}

export async function removePlaylistItem(
  ownerId: string,
  playlistId: string,
  itemId: string,
): Promise<PlaylistDetail> {
  await ownedPlaylist(ownerId, playlistId);
  await db.delete(playlistItems).where(and(eq(playlistItems.id, itemId), eq(playlistItems.playlistId, playlistId)));
  await resequencePlaylist(playlistId, await playlistItemIds(playlistId));
  await touchPlaylist(playlistId);
  return playlistPayload(playlistId);
}

export async function movePlaylistItem(
  ownerId: string,
  playlistId: string,
  itemId: string,
  position: number,
): Promise<PlaylistDetail> {
  await ownedPlaylist(ownerId, playlistId);
  const ids = await playlistItemIds(playlistId);
  const from = ids.indexOf(itemId);
  if (from === -1) throw new QueueItemNotFoundError();
  const to = Math.min(Math.max(Math.trunc(position), 0), ids.length - 1);
  ids.splice(to, 0, ids.splice(from, 1)[0]);
  await resequencePlaylist(playlistId, ids);
  await touchPlaylist(playlistId);
  return playlistPayload(playlistId);
}

async function touchPlaylist(playlistId: string): Promise<void> {
  await db.update(playlists).set({ updatedAt: new Date() }).where(eq(playlists.id, playlistId));
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
