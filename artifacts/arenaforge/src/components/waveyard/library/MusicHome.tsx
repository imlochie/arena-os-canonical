"use client";

/**
 * Waveyard HOME — the music-platform surface (docs/waveyard-evolution-plan.md).
 *
 * The first interaction is SELECTING MUSIC, not creating a production
 * project: library, search, recently played, playlists, queue, and an explicit
 * Studio section for the deeper layer (which keeps its own entry points).
 * Everything renders from real persisted data — no catalogue fabrication.
 */

import { FormEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "@/routing/Link";
import { useListeningHost } from "@/components/waveyard/listening/ListeningHost";
import { ConnectedLibraries } from "../studio/ConnectedLibraries";
import StemEngineSetup from "./StemEngineSetup";
import { ConversionWorkbench } from "./ConversionWorkbench";
import { publishWaveyardQueueChange, subscribeToWaveyardQueueChanges } from "./queue-sync";

import {
  formatPlayClock,
  isMultiPassSeparationPhase,
} from "@workspace/arena/lib/waveyard/library/model";
import type { LibraryTrackSeparationStartResponse } from "@workspace/api-client-react";
import {
  SMART_RULE_FIELDS,
  SMART_RULE_OPS,
  evaluateCollection,
  type CollectionTrack,
  type SmartCollection,
  type SmartRuleField,
  type SmartRuleOp,
} from "@workspace/arena/lib/waveyard/library/collections";

const AUDIO_ACCEPT = "audio/wav,audio/mpeg,audio/flac,audio/mp4,audio/aac,audio/ogg,.wav,.mp3,.flac,.m4a,.aac,.ogg";
const MAX_PARALLEL_LIBRARY_UPLOAD_BYTES = 64 * 1024 * 1024;
const APPLE_BACKUP_SERVICES = ["apple"] as const;

interface TrackSummary {
  id: string;
  sourceAssetId?: string | null;
  title: string;
  artist: string;
  album: string;
  durationSeconds: number;
  playCount: number;
  rating: number;
  labels: string[];
  lastPlayedAt: string | null;
  addedAt: string;
  stemAvailability: {
    status: string;
    stemCount?: number;
    reason?: string;
    retryJobId?: string;
    stage?: string;
    progress?: { percent: number; phase?: string };
  };
  studioProjectId: string;
}

interface RetryableLibraryUpload {
  file: File;
  reason: string;
}

function uploadFileIdentity(file: File): string {
  return `${file.name}\u0000${file.size}\u0000${file.lastModified}`;
}

function formatAudioBackupBytes(bytes: number): string {
  if (bytes < 1024 ** 2) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  return `${(bytes / 1024 ** 3).toFixed(2)} GB`;
}

interface PlaylistSummary {
  id: string;
  name: string;
  trackCount: number;
}

interface PlaylistDetail {
  id: string;
  name: string;
  items: Array<{ id: string; position: number; track: TrackSummary }>;
}

interface QueueItem {
  id: string;
  position: number;
  track: TrackSummary;
}

function StemBadge({ availability }: { availability: TrackSummary["stemAvailability"] }) {
  const progress = availability.status === "processing" ? availability.progress : undefined;
  const phase = progress?.phase ? ` · ${progress.phase}` : "";
  const progressDetail = progress
    ? progress.phase && isMultiPassSeparationPhase(progress.phase)
      ? progress.phase
      : `${progress.percent}%${phase}`
    : "";
  const finishing = availability.status === "processing" &&
    (availability.stage === "finalizing" || progress?.percent === 100);
  const stageLabel = availability.stage === "queued"
    ? "QUEUED"
    : availability.stage === "preparing"
      ? "PREPARING…"
      : availability.stage === "running"
        ? "STARTING…"
        : availability.stage === "finalizing"
          ? "FINISHING…"
          : "SEPARATING…";
  const label = progress
    ? `${finishing ? "FINISHING" : "SEPARATING"} · ${progressDetail}`
    :
    availability.status === "separated" ? `${availability.stemCount} STEMS`
    : availability.status === "source-only" ? "SOURCE"
    : availability.status === "processing" ? stageLabel
    : availability.status === "rejected" ? "SEPARATION REJECTED"
    : availability.status === "failed" ? "SEPARATION FAILED"
    : availability.status === "not-started" ? "NOT STARTED"
    : "NO STEMS";
  return (
    <span
      className={`stem-badge ${availability.status}`}
      title={availability.reason ?? "Separated stems are ready."}
      aria-label={progress ? `Stem separation ${progressDetail}` : label}
    >
      {label}
    </span>
  );
}

function TrackRow({
  track,
  onQueue,
  onPlay,
  onNext,
  playlists,
  onAddToPlaylist,
  onRate,
  onLabels,
  onStartSeparation,
  onRetrySeparation,
  audioBackupSelected,
  onToggleAudioBackup,
  starting,
  retrying,
}: {
  track: TrackSummary;
  onPlay: (track: TrackSummary) => void;
  onNext: (track: TrackSummary) => void;
  onQueue: (track: TrackSummary) => void;
  playlists: PlaylistSummary[];
  onAddToPlaylist: (playlistId: string, track: TrackSummary) => void;
  onRate: (track: TrackSummary, rating: number) => void;
  onLabels: (track: TrackSummary, labels: string[]) => void;
  onStartSeparation: (track: TrackSummary) => void;
  onRetrySeparation: (track: TrackSummary) => void;
  audioBackupSelected: boolean;
  onToggleAudioBackup: (track: TrackSummary) => void;
  starting: boolean;
  retrying: boolean;
}) {
  const [addingLabel, setAddingLabel] = useState(false);
  const [labelDraft, setLabelDraft] = useState("");
  const submitLabel = (event: FormEvent) => {
    event.preventDefault();
    const value = labelDraft.trim();
    if (value !== "") onLabels(track, [...track.labels, value]);
    setLabelDraft("");
    setAddingLabel(false);
  };
  return (
    <article className="track-row" data-testid="library-track">
      <Link className="track-art" href={`/waveyard/play/${track.id}`} aria-label={`Play ${track.title}`}>
        <span>{(track.artist || track.title || "?").slice(0, 1).toUpperCase()}</span>
      </Link>
      <div className="track-meta">
        <Link className="track-title" href={`/waveyard/play/${track.id}`}>{track.title}</Link>
        <span className="track-sub">
          {track.artist || "Unknown artist"}
          {track.album ? ` · ${track.album}` : ""}
        </span>
        <span className="track-rating" aria-label={`Rating: ${track.rating} of 5`}>
          {[1, 2, 3, 4, 5].map((star) => (
            <button
              key={star}
              type="button"
              className={star <= track.rating ? "star filled" : "star"}
              aria-label={`${track.rating === star ? "Clear" : "Rate"} ${track.title}: ${star} star${star === 1 ? "" : "s"}`}
              onClick={() => onRate(track, track.rating === star ? 0 : star)}
            >
              {star <= track.rating ? "★" : "☆"}
            </button>
          ))}
        </span>
        {(track.labels.length > 0 || addingLabel) && (
          <span className="track-labels">
            {track.labels.map((label) => (
              <span key={label} className="label-chip">
                {label}
                <button
                  type="button"
                  aria-label={`Remove label ${label} from ${track.title}`}
                  onClick={() => onLabels(track, track.labels.filter((existing) => existing !== label))}
                >
                  ×
                </button>
              </span>
            ))}
          </span>
        )}
        {addingLabel ? (
          <form className="label-add" onSubmit={submitLabel}>
            <input
              autoFocus
              aria-label={`Add label to ${track.title}`}
              value={labelDraft}
              maxLength={64}
              placeholder="Label…"
              onChange={(event) => setLabelDraft(event.target.value)}
            />
            <button type="submit" className="button secondary">Add</button>
            <button type="button" className="button secondary" onClick={() => { setAddingLabel(false); setLabelDraft(""); }}>Cancel</button>
          </form>
        ) : (
          <button type="button" className="label-add-toggle" aria-label={`Add label to ${track.title}`} onClick={() => setAddingLabel(true)}>
            + label
          </button>
        )}
      </div>
      <StemBadge availability={track.stemAvailability} />
      <span className="track-duration">{formatPlayClock(track.durationSeconds)}</span>
      <div className="track-actions">
        {track.sourceAssetId && (
          <label className="track-backup-choice">
            <input
              type="checkbox"
              aria-label={`Include ${track.title} in audio backup`}
              checked={audioBackupSelected}
              onChange={() => onToggleAudioBackup(track)}
            />
            <span>Backup</span>
          </label>
        )}
        <button type="button" className="button" onClick={() => onPlay(track)} data-testid={`button-play-${track.id}`}>Play</button>
        <button type="button" className="button secondary" onClick={() => onNext(track)} title="Line up on the next deck" data-testid={`button-next-${track.id}`}>Next</button>
        <button type="button" className="button secondary" title="Add to the saved queue and the live listening order" onClick={() => onQueue(track)}>+ Queue</button>
        {track.sourceAssetId && (
          <a
            className="button secondary"
            href={`/api/assets/${encodeURIComponent(track.sourceAssetId)}?download=1`}
            aria-label={`Download original audio for ${track.title}`}
            title="Download the exact original audio file stored in your private library"
          >
            Download original
          </a>
        )}
        {track.stemAvailability.status === "not-started" && (
          <button
            type="button"
            className="button secondary"
            aria-label={`Start separation for ${track.title}`}
            data-testid={`button-start-separation-${track.id}`}
            disabled={starting}
            onClick={() => onStartSeparation(track)}
          >
            {starting ? "Starting…" : "Start separation"}
          </button>
        )}
        {(track.stemAvailability.status === "rejected" || track.stemAvailability.status === "failed") && (
          <button
            type="button"
            className="button secondary"
            aria-label={`Retry separation for ${track.title}`}
            disabled={retrying}
            onClick={() => onRetrySeparation(track)}
          >
            {retrying ? "Retrying…" : "Retry separation"}
          </button>
        )}
        {playlists.length > 0 && (
          <select
            aria-label={`Add ${track.title} to a playlist`}
            className="track-playlist-select"
            defaultValue=""
            onChange={(event) => {
              if (event.target.value !== "") onAddToPlaylist(event.target.value, track);
              event.currentTarget.value = "";
            }}
          >
            <option value="">+ Playlist…</option>
            {playlists.map((playlist) => (
              <option key={playlist.id} value={playlist.id}>{playlist.name}</option>
            ))}
          </select>
        )}
        <Link className="button secondary" href={`/waveyard/projects/${track.studioProjectId}?view=studio`}>
          Studio ↗
        </Link>
      </div>
    </article>
  );
}

export function MusicHome() {
  const [tracks, setTracks] = useState<TrackSummary[]>([]);
  const [playback, setPlayback] = useState<{ currentTrackId: string | null; positionSeconds: number } | null>(null);
  const [playlists, setPlaylists] = useState<PlaylistSummary[]>([]);
  const [openPlaylist, setOpenPlaylist] = useState<PlaylistDetail | null>(null);
  const [playlistRenameId, setPlaylistRenameId] = useState<string | null>(null);
  const [playlistNameDraft, setPlaylistNameDraft] = useState("");
  const [renamingPlaylistId, setRenamingPlaylistId] = useState<string | null>(null);
  const [playlistDeleteConfirmId, setPlaylistDeleteConfirmId] = useState<string | null>(null);
  const [deletingPlaylistId, setDeletingPlaylistId] = useState<string | null>(null);
  const [queue, setQueue] = useState<QueueItem[]>([]);
  const [search, setSearch] = useState("");
  const [importUrl, setImportUrl] = useState("");
  const [adding, setAdding] = useState(false);
  const [uploadProgress, setUploadProgress] = useState<{ completed: number; total: number } | null>(null);
  const [retryableUploads, setRetryableUploads] = useState<RetryableLibraryUpload[]>([]);
  const uploadInFlight = useRef(false);
  const [message, setMessage] = useState<string | null>(null);
  const [queueErrorMessage, setQueueErrorMessage] = useState<string | null>(null);
  const [playlistMessage, setPlaylistMessage] = useState<string | null>(null);
  const [newPlaylistName, setNewPlaylistName] = useState("");
  const [collections, setCollections] = useState<SmartCollection[]>([]);
  const [activeCollectionId, setActiveCollectionId] = useState<string | null>(null);
  const [newCollectionName, setNewCollectionName] = useState("");
  const [ruleField, setRuleField] = useState<SmartRuleField>("label");
  const [ruleOp, setRuleOp] = useState<SmartRuleOp>("is");
  const [ruleValue, setRuleValue] = useState("");
  /** Library clock for addedDaysAgo rules — set during refresh (never read
   * impurely during render); day granularity makes short staleness moot. */
  const [libraryClockMs, setLibraryClockMs] = useState(0);
  const host = useListeningHost();
  const [loaded, setLoaded] = useState(false);
  const [refreshWarning, setRefreshWarning] = useState<string | null>(null);
  const [trackLoadFailed, setTrackLoadFailed] = useState(false);
  const [dragActive, setDragActive] = useState(false);
  const [dropBusy, setDropBusy] = useState<string | null>(null);
  const [busySeparationTrackIds, setBusySeparationTrackIds] = useState<Set<string>>(() => new Set());
  const [selectedAudioBackupIds, setSelectedAudioBackupIds] = useState<Set<string>>(() => new Set());
  const [audioBackupBusy, setAudioBackupBusy] = useState(false);
  const [audioBackupMessage, setAudioBackupMessage] = useState<string | null>(null);
  const [streamingBackupsOpen, setStreamingBackupsOpen] = useState(false);
  const streamingBackupsRef = useRef<HTMLDetailsElement | null>(null);
  const dragDepth = useRef(0);
  const reloadTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const trackRequestVersion = useRef(0);
  const refreshRequestVersion = useRef(0);
  const activeTrackSearchController = useRef<AbortController | null>(null);

  const refresh = useCallback(async (query: string) => {
    activeTrackSearchController.current?.abort();
    activeTrackSearchController.current = null;
    const refreshRequestId = ++refreshRequestVersion.current;
    const trackRequestId = ++trackRequestVersion.current;
    const getJson = async (url: string) => {
      try {
        const response = await fetch(url, { cache: "no-store" });
        if (!response.ok) return null;
        return await response.json();
      } catch {
        return null;
      }
    };
    const tracksPromise = getJson(
      `/api/library/tracks${query.trim() ? `?q=${encodeURIComponent(query.trim())}` : ""}`,
    ).then((tracksData) => {
      if (trackRequestId !== trackRequestVersion.current) return;
      if (Array.isArray(tracksData?.tracks)) {
        setTracks(tracksData.tracks);
        setTrackLoadFailed(false);
      } else {
        setTrackLoadFailed(true);
      }
      setLibraryClockMs(Date.now());
      setLoaded(true);
    });

    const playbackPromise = getJson("/api/library/playback-state").then((data) => {
      if (refreshRequestId === refreshRequestVersion.current && data?.playbackState) {
        const state = data.playbackState;
        setPlayback({ currentTrackId: state.currentTrackId, positionSeconds: state.positionSeconds });
      }
      return data;
    });
    const playlistsPromise = getJson("/api/library/playlists").then((data) => {
      if (refreshRequestId === refreshRequestVersion.current && Array.isArray(data?.playlists)) {
        setPlaylists(data.playlists);
      }
      return data;
    });
    const queuePromise = getJson("/api/library/queue").then((data) => {
      if (refreshRequestId === refreshRequestVersion.current && Array.isArray(data?.queue)) {
        setQueue(data.queue);
      }
      return data;
    });
    const collectionsPromise = getJson("/api/library/collections").then((data) => {
      if (refreshRequestId === refreshRequestVersion.current && Array.isArray(data?.collections)) {
        setCollections(data.collections);
      }
      return data;
    });

    void Promise.all([
      playbackPromise,
      playlistsPromise,
      queuePromise,
      collectionsPromise,
    ]).then(([playbackData, playlistsData, queueData, collectionsData]) => {
      if (refreshRequestId !== refreshRequestVersion.current) return;
      const optionalDataFailed = !playbackData?.playbackState
        || !Array.isArray(playlistsData?.playlists)
        || !Array.isArray(queueData?.queue)
        || !Array.isArray(collectionsData?.collections);
      setRefreshWarning(
        optionalDataFailed
          ? "Some library details could not be refreshed. The last good track list is kept."
          : null,
      );
    });

    await tracksPromise;
  }, []);

  useEffect(() => {
    // Initial load deferred to a timer callback (repo lint pattern: no
    // synchronous setState chains from the effect body).
    const timer = setTimeout(() => {
      void refresh("").catch(() => {
        setLoaded(true);
        setMessage("Your library could not be loaded — check the connection and reload.");
      });
    }, 0);
    return () => clearTimeout(timer);
  }, [refresh]);

  useEffect(() => {
    const reloadQueue = () => {
      void fetch("/api/library/queue", { cache: "no-store" }).then(async (response) => {
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        setQueue((await response.json()).queue ?? []);
      }).catch(() => setMessage("The saved queue could not be refreshed."));
    };
    return subscribeToWaveyardQueueChanges(({ affectedSessionIds }) => {
      reloadQueue();
      host.refreshSession(affectedSessionIds);
    });
  }, [host]);

  // Debounced live search over real persisted metadata.
  useEffect(() => {
    if (reloadTimer.current !== null) clearTimeout(reloadTimer.current);
    const requestId = ++trackRequestVersion.current;
    const controller = new AbortController();
    activeTrackSearchController.current = controller;
    reloadTimer.current = setTimeout(() => {
      if (controller.signal.aborted || requestId !== trackRequestVersion.current) return;
      void (async () => {
        try {
          const response = await fetch(
            `/api/library/tracks${search.trim() ? `?q=${encodeURIComponent(search.trim())}` : ""}`,
            { cache: "no-store", signal: controller.signal },
          );
          if (!response.ok) throw new Error(`Track search failed with HTTP ${response.status}`);
          const data = await response.json();
          if (requestId !== trackRequestVersion.current) return;
          if (!Array.isArray(data?.tracks)) throw new Error("Track search returned an invalid result");
          setTracks(data.tracks);
          setTrackLoadFailed(false);
          setLibraryClockMs(Date.now());
          setLoaded(true);
        } catch {
          if (!controller.signal.aborted && requestId === trackRequestVersion.current) {
            setTrackLoadFailed(true);
            setLoaded(true);
          }
        } finally {
          if (activeTrackSearchController.current === controller) {
            activeTrackSearchController.current = null;
          }
        }
      })();
    }, 250);
    return () => {
      if (reloadTimer.current !== null) clearTimeout(reloadTimer.current);
      if (activeTrackSearchController.current === controller) {
        activeTrackSearchController.current = null;
      }
      controller.abort();
    };
  }, [search]);

  const importFromUrl = useCallback(
    async (url: string) => {
      const trimmed = url.trim();
      if (!trimmed || adding) return;
      setAdding(true);
      setMessage(null);
      try {
        const response = await fetch("/api/library/ingest", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ url: trimmed }),
        });
        const body = await response.json().catch(() => ({}));
        if (response.ok) {
          setMessage(
            body.created === false
              ? typeof body.track?.id === "string"
                ? "Already in your library — opening it in the live mixer."
                : "Already in your library — nothing imported."
              : "Imported through yt-dlp. Stems separate in the background.",
          );
          setImportUrl("");
          if (typeof body.track?.id === "string") void host.sendTrack(body.track.id, "play");
        } else {
          setMessage(`Import failed — ${body.error ?? `HTTP ${response.status}`}`);
        }
      } catch {
        setMessage("Import failed — network error.");
      } finally {
        setAdding(false);
        await refresh(search).catch(() => setMessage("Library could not refresh — check the connection."));
      }
    },
    [adding, refresh, search, host],
  );

  const addMusic = useCallback(
    async (files: FileList | File[] | null): Promise<string[]> => {
      if (files === null || files.length === 0 || uploadInFlight.current) return [];
      const filesToAdd = Array.from(files);
      uploadInFlight.current = true;
      setAdding(true);
      setMessage(null);
      const failures: Array<{ file: File; reason: string; retryable: boolean }> = [];
      const failuresByIndex: Array<{ file: File; reason: string; retryable: boolean } | undefined> = [];
      const trackIdsByIndex: Array<string | undefined> = [];
      const createdByIndex = Array.from({ length: filesToAdd.length }, () => false);
      const separationQueuedByIndex = Array.from({ length: filesToAdd.length }, () => true);
      let nextFileIndex = 0;
      let completedUploads = 0;
      const uploadConcurrency = filesToAdd.some((file) => file.size > MAX_PARALLEL_LIBRARY_UPLOAD_BYTES)
        ? 1
        : Math.min(2, filesToAdd.length);
      setUploadProgress({ completed: 0, total: filesToAdd.length });
      try {
        const uploadNextFile = async () => {
          while (true) {
            const index = nextFileIndex++;
            const file = filesToAdd[index];
            if (!file) return;
            try {
              const payload = new FormData();
              payload.set("file", file);
              const response = await fetch("/api/library/tracks", { method: "POST", body: payload });
              const body = await response.json().catch(() => ({}));
              if (!response.ok) {
                failuresByIndex[index] = {
                  file,
                  reason: body.error ?? `HTTP ${response.status}`,
                  retryable: response.status === 408 || response.status === 429 || response.status >= 500,
                };
              } else {
                if (typeof body.track?.id === "string") trackIdsByIndex[index] = body.track.id;
                createdByIndex[index] = body.created !== false;
                separationQueuedByIndex[index] = body.separationQueued !== false;
              }
            } catch (error) {
              failuresByIndex[index] = {
                file,
                reason: error instanceof Error ? error.message : "Network error",
                retryable: true,
              };
            } finally {
              completedUploads += 1;
              setUploadProgress({ completed: completedUploads, total: filesToAdd.length });
            }
          }
        };
        await Promise.all(
          Array.from({ length: uploadConcurrency }, () => uploadNextFile()),
        );
        for (const failure of failuresByIndex) {
          if (failure !== undefined) failures.push(failure);
        }
        const trackIds = trackIdsByIndex.filter((id): id is string => id !== undefined);
        const added = createdByIndex.filter(Boolean).length;
        const separationUnavailable = createdByIndex.some((created, index) => created && !separationQueuedByIndex[index]);
        const attemptedKeys = new Set(filesToAdd.map(uploadFileIdentity));
        setRetryableUploads((previous) => {
          const next = new Map<string, RetryableLibraryUpload>(
            previous
              .filter(({ file }) => !attemptedKeys.has(uploadFileIdentity(file)))
              .map((entry) => [uploadFileIdentity(entry.file), entry] as const),
          );
          for (const failure of failures) {
            if (failure.retryable) {
              next.set(uploadFileIdentity(failure.file), { file: failure.file, reason: failure.reason });
            }
          }
          return [...next.values()];
        });
        setMessage(
          failures.length > 0
            ? `Added ${added}; ${failures.length} failed — ${failures[0].file.name}: ${failures[0].reason}`
            : separationUnavailable
              ? `Added ${added} track${added === 1 ? "" : "s"}, but the stem worker did not accept the separation job.`
            : added > 0
              ? `Added ${added} track${added === 1 ? "" : "s"} to your library. Stems separate in the background.`
              : trackIds.length > 0
                ? "That audio is already in your library — loading it in the live mixer."
                : "That audio is already in your library.",
        );
        await refresh(search).catch(() => setMessage((current) =>
          `${current ? `${current} ` : ""}The library could not refresh; reload to see saved tracks.`,
        ));
        if (trackIds.length > 0) void host.sendTrack(trackIds[0], "play");
        return trackIds;
      } finally {
        setUploadProgress(null);
        uploadInFlight.current = false;
        setAdding(false);
      }
    },
    [refresh, host, search],
  );

  /** Dropped files use the exact same music ingest path as the Add Music button. */
  const dropIntoLibrary = useCallback(
    async (files: FileList | File[]) => {
      const audio = Array.from(files).filter(
        (file) => file.type.startsWith("audio/") || /\.(wav|mp3|flac|m4a|aac|ogg)$/i.test(file.name),
      );
      if (audio.length === 0) {
        setMessage("That file is not audio — drop an MP3, WAV, FLAC, M4A, AAC, or OGG.");
        return;
      }
      if (adding) {
        setMessage("Finish the current import before dropping more audio.");
        return;
      }
      setDropBusy(audio.map((file) => file.name).join(", "));
      setMessage(null);
      try {
        await addMusic(audio);
      } finally {
        setDropBusy(null);
      }
    },
    [addMusic, adding],
  );

  // Keep stem badges honest while separation runs in the background.
  const anyProcessing = tracks.some((track) => track.stemAvailability.status === "processing");
  useEffect(() => {
    if (!anyProcessing) return;
    const interval = window.setInterval(() => {
      void (async () => {
        try {
          const response = await fetch(`/api/library/tracks${search.trim() ? `?q=${encodeURIComponent(search.trim())}` : ""}`, { cache: "no-store" });
          if (response.ok) setTracks((await response.json()).tracks ?? []);
        } catch {
          /* next tick retries */
        }
      })();
    }, 3000);
    return () => window.clearInterval(interval);
  }, [anyProcessing, search]);

  const playTrack = useCallback((track: TrackSummary) => void host.sendTrack(track.id, "play"), [host]);
  const nextTrack = useCallback((track: TrackSummary) => void host.sendTrack(track.id, "next"), [host]);

  const onQueue = useCallback(async (track: TrackSummary) => {
    const response = await fetch("/api/library/queue", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ trackId: track.id, at: "end", currentTrackId: playback?.currentTrackId ?? null }),
    });
    if (!response.ok) {
      setMessage(`${track.title} could not be added to the saved queue.`);
      return;
    }
    const result = await response.json();
    setQueue(result.queue ?? []);
    publishWaveyardQueueChange();
    if (typeof result.addedQueueItemId !== "string") {
      setMessage(`${track.title} was saved, but its listening entry could not be linked.`);
      return;
    }

    const addedToListening = await host.enqueueTracks([track.id], [result.addedQueueItemId]);
    if (!addedToListening) {
      const rollback = await fetch(`/api/library/queue/${result.addedQueueItemId}`, { method: "DELETE" });
      if (rollback.ok) {
        setQueue((await rollback.json()).queue ?? []);
        publishWaveyardQueueChange();
      }
      setMessage("The song could not be added to the listening order.");
      return;
    }
    setMessage(`${track.title} added to the listening order.`);
  }, [playback, host]);

  const enqueuePlaylist = useCallback(async (playlist: PlaylistDetail) => {
    setPlaylistMessage(null);
    if (playlist.items.length === 0) {
      setMessage("This playlist is empty.");
      return;
    }
    const added = await host.enqueueTracks(playlist.items.map((item) => item.track.id));
    if (added) setMessage(`${playlist.items.length} songs from ${playlist.name} added to the listening order.`);
    else setMessage(`Could not add ${playlist.name} to the listening order.`);
  }, [host]);

  const rateTrack = useCallback(async (track: TrackSummary, rating: number) => {
    const response = await fetch(`/api/library/tracks/${track.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ rating }),
    });
    if (response.ok) {
      const { track: updated } = (await response.json()) as { track: { rating: number } };
      setTracks((previous) => previous.map((existing) => (existing.id === track.id ? { ...existing, rating: updated.rating } : existing)));
    } else {
      setMessage("Could not save that rating.");
    }
  }, []);

  const setTrackLabels = useCallback(async (track: TrackSummary, labels: string[]) => {
    const response = await fetch(`/api/library/tracks/${track.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ labels }),
    });
    if (response.ok) {
      const { track: updated } = (await response.json()) as { track: { labels: string[] } };
      setTracks((previous) => previous.map((existing) => (existing.id === track.id ? { ...existing, labels: updated.labels } : existing)));
    } else {
      setMessage("Could not save those labels.");
    }
  }, []);

  const startSeparation = useCallback(async (track: TrackSummary) => {
    if (busySeparationTrackIds.has(track.id)) return;
    setBusySeparationTrackIds((previous) => new Set(previous).add(track.id));
    setMessage(null);
    try {
      const response = await fetch(`/api/library/tracks/${track.id}/separation`, { method: "POST" });
      const body = await response.json().catch(() => ({})) as Partial<LibraryTrackSeparationStartResponse> & { error?: string };
      if (body.state === "queued" || body.state === "processing") {
        setTracks((previous) => previous.map((existing) => existing.id === track.id
          ? {
              ...existing,
              stemAvailability: {
                status: "processing",
                reason: "Stem separation is running — playback uses the full source until it completes.",
              },
            }
          : existing));
        setMessage(body.state === "queued"
          ? `${track.title}: separation started. You can keep listening while it runs.`
          : `${track.title}: separation is already running.`);
        return;
      }
      if (body.state === "separated") {
        await refresh(search);
        setMessage(`${track.title}: stems are already available.`);
        return;
      }
      const retryJobId = body.jobId;
      if (body.state === "failed" && typeof retryJobId === "string") {
        setTracks((previous) => previous.map((existing) => existing.id === track.id
          ? {
              ...existing,
              stemAvailability: {
                status: "rejected" as const,
                reason: body.error ?? "The stem worker did not accept this job.",
                retryJobId,
              },
            }
          : existing));
        setMessage(`${track.title}: ${body.error ?? "Separation could not be queued."}`);
        return;
      }
      if (body.state === "previous-attempt") await refresh(search);
      setMessage(`${track.title}: ${body.error ?? "Separation could not be started."}`);
    } catch {
      setMessage(`${track.title}: separation could not be started — check the connection.`);
    } finally {
      setBusySeparationTrackIds((previous) => {
        const next = new Set(previous);
        next.delete(track.id);
        return next;
      });
    }
  }, [busySeparationTrackIds, refresh, search]);

  const retrySeparation = useCallback(async (track: TrackSummary) => {
    const jobId = track.stemAvailability.retryJobId;
    if (!jobId || busySeparationTrackIds.has(track.id)) return;
    setBusySeparationTrackIds((previous) => new Set(previous).add(track.id));
    setMessage(null);
    try {
      const response = await fetch(`/api/jobs/${jobId}/retry`, { method: "POST" });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) {
        setMessage(`${track.title}: ${body.error ?? "Separation retry could not be started."}`);
        return;
      }
      setTracks((previous) => previous.map((existing) => existing.id === track.id
        ? {
            ...existing,
            stemAvailability: {
              status: "processing",
              reason: "Stem separation is still running — playback uses the full source until it completes.",
            },
          }
        : existing));
      setMessage(`${track.title}: separation retry started.`);
    } catch {
      setMessage(`${track.title}: separation retry could not be started — check the connection.`);
    } finally {
      setBusySeparationTrackIds((previous) => {
        const next = new Set(previous);
        next.delete(track.id);
        return next;
      });
    }
  }, [busySeparationTrackIds]);

  const collectionTrack = useCallback((track: TrackSummary): CollectionTrack => ({
    id: track.id,
    title: track.title,
    artist: track.artist,
    addedAtMs: Date.parse(track.addedAt),
    playCount: track.playCount,
    durationSeconds: track.durationSeconds,
    rating: track.rating,
    labels: track.labels,
  }), []);

  const activeCollection = collections.find((collection) => collection.id === activeCollectionId) ?? null;
  const visibleTracks = useMemo(() => {
    if (activeCollection === null) return tracks;
    return tracks.filter((track) => evaluateCollection(collectionTrack(track), activeCollection, libraryClockMs));
  }, [tracks, activeCollection, collectionTrack, libraryClockMs]);
  const visibleAudioTracks = useMemo(
    () => visibleTracks.filter((track) => track.sourceAssetId != null),
    [visibleTracks],
  );

  const toggleAudioBackupTrack = useCallback((track: TrackSummary) => {
    if (track.sourceAssetId == null) return;
    setSelectedAudioBackupIds((current) => {
      const next = new Set(current);
      if (next.has(track.id)) next.delete(track.id);
      else next.add(track.id);
      return next;
    });
    setAudioBackupMessage(null);
  }, []);

  const selectVisibleAudioTracks = useCallback(() => {
    if (visibleAudioTracks.length > 100) {
      setAudioBackupMessage("A backup can contain at most 100 tracks. Search or choose tracks individually to make smaller batches.");
      return;
    }
    setSelectedAudioBackupIds(new Set(visibleAudioTracks.map((track) => track.id)));
    setAudioBackupMessage(null);
  }, [visibleAudioTracks]);

  const downloadAudioBackup = useCallback(async () => {
    const ids = Array.from(selectedAudioBackupIds);
    if (ids.length === 0) {
      setAudioBackupMessage("Select at least one track with a stored original audio file.");
      return;
    }
    if (ids.length > 100) {
      setAudioBackupMessage("A backup can contain at most 100 tracks. Remove some selections and retry.");
      return;
    }

    const downloadUrl = new URL("/api/library/audio-backup", window.location.origin);
    downloadUrl.searchParams.set("ids", ids.join(","));
    const preflightUrl = new URL(downloadUrl);
    preflightUrl.searchParams.set("preflight", "1");
    setAudioBackupBusy(true);
    setAudioBackupMessage(null);
    try {
      const response = await fetch(preflightUrl, { cache: "no-store" });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) {
        setAudioBackupMessage(typeof body.error === "string" ? body.error : "The selected audio could not be backed up.");
        return;
      }
      const count = typeof body.audioFiles === "number" ? body.audioFiles : ids.length;
      const bytes = typeof body.totalBytes === "number" ? body.totalBytes : 0;
      setAudioBackupMessage(
        `Starting a ZIP of ${count} exact original file${count === 1 ? "" : "s"} (${formatAudioBackupBytes(bytes)}) with a CSV manifest. Apple Music subscription audio is not included.`,
      );
      window.location.assign(downloadUrl.toString());
    } catch {
      setAudioBackupMessage("Could not prepare the audio backup. Check the connection and retry.");
    } finally {
      setAudioBackupBusy(false);
    }
  }, [selectedAudioBackupIds]);

  const collectionCounts = useMemo(() => {
    const counts = new Map<string, number>();
    for (const collection of collections) {
      counts.set(collection.id, tracks.filter((track) => evaluateCollection(collectionTrack(track), collection, libraryClockMs)).length);
    }
    return counts;
  }, [tracks, collections, collectionTrack, libraryClockMs]);

  const createCollection = async (event: FormEvent) => {
    event.preventDefault();
    const name = newCollectionName.trim();
    if (name === "") return;
    const response = await fetch("/api/library/collections", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name,
        match: "all",
        rules: ruleValue.trim() === "" ? [] : [{ field: ruleField, op: ruleOp, value: ruleValue.trim() }],
      }),
    });
    if (response.ok) {
      const { collection } = (await response.json()) as { collection: SmartCollection };
      setCollections((previous) => [...previous, collection]);
      setNewCollectionName("");
      setRuleValue("");
    } else {
      setMessage("Could not create that collection.");
    }
  };

  const removeCollection = async (collectionId: string) => {
    const response = await fetch(`/api/library/collections/${collectionId}`, { method: "DELETE" });
    if (response.ok) {
      setCollections((previous) => previous.filter((collection) => collection.id !== collectionId));
      setActiveCollectionId((current) => (current === collectionId ? null : current));
    } else {
      setMessage("Could not delete that collection.");
    }
  };

  const createPlaylist = useCallback(async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const name = newPlaylistName.trim();
    if (name === "") return;
    try {
      const response = await fetch("/api/library/playlists", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name }),
      });
      if (!response.ok) {
        setPlaylistMessage("Could not create the playlist. Try again.");
        return;
      }
      const created = (await response.json()).playlist as PlaylistSummary;
      setPlaylists((previous) => [...previous.filter((playlist) => playlist.id !== created.id), created]);
      setOpenPlaylist({ ...created, items: [] });
      setNewPlaylistName("");
      setPlaylistMessage(null);
    } catch {
      setPlaylistMessage("Could not create the playlist. Check the connection and try again.");
    }
  }, [newPlaylistName]);

  const openPlaylistDetail = useCallback(async (playlistId: string) => {
    if (openPlaylist?.id === playlistId) {
      setOpenPlaylist(null);
      setPlaylistRenameId(null);
      setPlaylistDeleteConfirmId(null);
      return;
    }
    setPlaylistRenameId(null);
    setPlaylistDeleteConfirmId(null);
    try {
      const response = await fetch(`/api/library/playlists/${playlistId}`, { cache: "no-store" });
      if (!response.ok) {
        setPlaylistMessage("Could not open this playlist. Try again.");
        return;
      }
      setOpenPlaylist((await response.json()).playlist);
      setPlaylistMessage(null);
    } catch {
      setPlaylistMessage("Could not open this playlist. Check the connection and try again.");
    }
  }, [openPlaylist]);

  const renamePlaylist = useCallback(async (event: FormEvent<HTMLFormElement>, playlistId: string) => {
    event.preventDefault();
    const name = playlistNameDraft.trim();
    if (name === "") return;
    setRenamingPlaylistId(playlistId);
    try {
      const response = await fetch(`/api/library/playlists/${playlistId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name }),
      });
      if (!response.ok) {
        setPlaylistMessage("Could not rename this playlist. Try again.");
        return;
      }
      const summary = (await response.json()).playlist as PlaylistSummary;
      setPlaylists((previous) => previous.map((playlist) => playlist.id === playlistId ? summary : playlist));
      setOpenPlaylist((current) => current?.id === playlistId
        ? { ...current, name: summary.name }
        : current);
      setPlaylistRenameId(null);
      setPlaylistNameDraft("");
      setPlaylistMessage(null);
    } catch {
      setPlaylistMessage("Could not rename this playlist. Check the connection and try again.");
    } finally {
      setRenamingPlaylistId(null);
    }
  }, [playlistNameDraft]);

  const deletePlaylist = useCallback(async (playlistId: string) => {
    setDeletingPlaylistId(playlistId);
    try {
      const response = await fetch(`/api/library/playlists/${playlistId}`, { method: "DELETE" });
      if (!response.ok) {
        setPlaylistMessage("Could not delete this playlist. Try again.");
        return;
      }
      setPlaylists((previous) => previous.filter((playlist) => playlist.id !== playlistId));
      setOpenPlaylist((current) => current?.id === playlistId ? null : current);
      setPlaylistRenameId(null);
      setPlaylistNameDraft("");
      setPlaylistDeleteConfirmId(null);
      setPlaylistMessage(null);
    } catch {
      setPlaylistMessage("Could not delete this playlist. Check the connection and try again.");
    } finally {
      setDeletingPlaylistId(null);
    }
  }, []);

  const onAddToPlaylist = useCallback(async (playlistId: string, track: TrackSummary) => {
    try {
      const response = await fetch(`/api/library/playlists/${playlistId}/items`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ trackId: track.id }),
      });
      if (!response.ok) {
        setMessage(`Could not add ${track.title} to the playlist. Try again.`);
        return;
      }
      const detail = (await response.json()).playlist as PlaylistDetail;
      setOpenPlaylist(detail);
      setPlaylists((previous) => previous.map((playlist) => playlist.id === detail.id
        ? { ...playlist, trackCount: detail.items.length }
        : playlist));
      setPlaylistMessage(null);
      setMessage(`${track.title} added to ${detail.name}.`);
    } catch {
      setMessage(`Could not add ${track.title} to the playlist. Check the connection and try again.`);
    }
  }, []);

  const removePlaylistItem = useCallback(async (playlistId: string, itemId: string) => {
    try {
      const response = await fetch(`/api/library/playlists/${playlistId}/items?itemId=${itemId}`, { method: "DELETE" });
      if (!response.ok) {
        setPlaylistMessage("Could not remove that track from the playlist. Try again.");
        return;
      }
      const detail = (await response.json()).playlist as PlaylistDetail;
      setOpenPlaylist(detail);
      setPlaylists((previous) => previous.map((playlist) => playlist.id === detail.id
        ? { ...playlist, trackCount: detail.items.length }
        : playlist));
      setPlaylistMessage(null);
    } catch {
      setPlaylistMessage("Could not remove that track from the playlist. Check the connection and try again.");
    }
  }, []);

  const movePlaylistItem = useCallback(async (playlistId: string, itemId: string, position: number) => {
    try {
      const response = await fetch(`/api/library/playlists/${playlistId}/items`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ itemId, position }),
      });
      if (!response.ok) {
        setPlaylistMessage("Could not update the playlist order. Try again.");
        return;
      }
      setOpenPlaylist((await response.json()).playlist);
      setPlaylistMessage(null);
    } catch {
      setPlaylistMessage("Could not update the playlist order. Check the connection and try again.");
    }
  }, []);

  const removeQueueItem = useCallback(async (itemId: string) => {
    try {
      const response = await fetch(`/api/library/queue/${itemId}`, { method: "DELETE" });
      if (!response.ok) {
        setQueueErrorMessage("Could not remove this track from the saved queue. Try again.");
        return;
      }
      const result = await response.json();
      setQueue(result.queue ?? []);
      setQueueErrorMessage(null);
      host.refreshSession(result.affectedSessionIds ?? []);
      publishWaveyardQueueChange(result.affectedSessionIds ?? []);
    } catch {
      setQueueErrorMessage("Could not remove this track from the saved queue. Check the connection and try again.");
    }
  }, [host]);

  const clearQueue = useCallback(async () => {
    try {
      const response = await fetch("/api/library/queue", { method: "DELETE" });
      if (!response.ok) {
        setQueueErrorMessage("Could not clear the saved queue. Try again.");
        return;
      }
      const result = await response.json();
      setQueue(result.queue ?? []);
      setQueueErrorMessage(null);
      host.refreshSession(result.affectedSessionIds ?? []);
      publishWaveyardQueueChange(result.affectedSessionIds ?? []);
    } catch {
      setQueueErrorMessage("Could not clear the saved queue. Check the connection and try again.");
    }
  }, [host]);

  const moveQueueItem = useCallback(async (itemId: string, position: number) => {
    try {
      const response = await fetch(`/api/library/queue/${itemId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ position, sessionId: host.sessionId ?? undefined }),
      });
      if (!response.ok) {
        setQueueErrorMessage("Could not update the saved queue order. Try again.");
        return;
      }
      const result = await response.json();
      setQueue(result.queue ?? []);
      setQueueErrorMessage(null);
      host.refreshSession(result.affectedSessionIds ?? []);
      publishWaveyardQueueChange(result.affectedSessionIds ?? []);
    } catch {
      setQueueErrorMessage("Could not update the saved queue order. Check the connection and try again.");
    }
  }, [host]);

  const recentlyPlayed = useMemo(
    () =>
      [...tracks]
        .filter((track) => track.lastPlayedAt !== null)
        .sort((a, b) => (a.lastPlayedAt! < b.lastPlayedAt! ? 1 : -1))
        .slice(0, 8),
    [tracks],
  );

  const continueTrack = useMemo(
    () => (playback !== null && playback.positionSeconds > 5 ? tracks.find((track) => track.id === playback.currentTrackId) ?? null : null),
    [playback, tracks],
  );

  return (
    <>
      <div
        className={`music-home-surface ${dragActive ? "drop-active" : ""}`}
        onDragEnter={(event) => {
          if (Array.from(event.dataTransfer.types).includes("Files")) {
            dragDepth.current += 1;
            setDragActive(true);
          }
        }}
        onDragOver={(event) => {
          if (Array.from(event.dataTransfer.types).includes("Files")) event.preventDefault();
        }}
        onDragLeave={() => {
          dragDepth.current = Math.max(0, dragDepth.current - 1);
          if (dragDepth.current === 0) setDragActive(false);
        }}
        onDrop={(event) => {
          event.preventDefault();
          dragDepth.current = 0;
          setDragActive(false);
          void dropIntoLibrary(event.dataTransfer.files);
        }}
      >
      <section className="library-hero" aria-label="Your music">
        <div>
          <h1>Your library</h1>
          <div className="library-backup-shortcut">
            <button
              type="button"
              className="button secondary"
              aria-controls="apple-music-metadata-backup"
              aria-expanded={streamingBackupsOpen}
              onClick={() => {
                setStreamingBackupsOpen(true);
                requestAnimationFrame(() => {
                  const details = streamingBackupsRef.current;
                  details?.scrollIntoView({ behavior: "smooth", block: "start" });
                  details?.querySelector("summary")?.focus({ preventScroll: true });
                });
              }}
            >
              Apple Music catalog backup
            </button>
            <small>Metadata only; local-file audio ZIP stays separate.</small>
          </div>
          <label className="add-music" id="waveyard-add-music">
            <input
              aria-label="Add music files"
              type="file"
              multiple
              accept={AUDIO_ACCEPT}
              disabled={adding}
              onChange={(event) => {
                void addMusic(event.target.files);
                event.currentTarget.value = "";
              }}
            />
            <b>{adding ? "ADDING…" : "+ ADD MUSIC"}</b>
            <small>MP3 · WAV · FLAC · M4A · AAC · OGG</small>
          </label>
          {uploadProgress && (
            <p className="library-message" role="status" aria-live="polite" data-testid="library-upload-progress">
              Adding {uploadProgress.total} file{uploadProgress.total === 1 ? "" : "s"} · {uploadProgress.completed} of {uploadProgress.total} complete
            </p>
          )}
          <StemEngineSetup />
          <details className="library-url-import">
          <summary>Import from a link</summary>
          <div className="add-music" style={{ display: "flex", gap: 8, marginTop: 8, padding: "10px 14px" }}>
            <input
              aria-label="Import from URL with yt-dlp"
              className="library-search"
              style={{ flex: 1, minWidth: 0 }}
              placeholder="…or paste a URL — yt-dlp imports it (personal use)"
              value={importUrl}
              disabled={adding}
              onChange={(event) => setImportUrl(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") void importFromUrl(importUrl);
              }}
            />
            <button
              type="button"
              disabled={adding || !importUrl.trim()}
              onClick={() => void importFromUrl(importUrl)}
              style={{
                borderRadius: 10,
                border: "1px solid rgba(255,255,255,0.15)",
                padding: "6px 14px",
                color: "white",
                fontWeight: 700,
                fontSize: 12,
                background: adding ? "transparent" : "rgba(124,58,237,0.35)",
                cursor: adding ? "default" : "pointer",
              }}
            >
              IMPORT
            </button>
          </div>
          </details>
          {message && (
            <p className="library-message" role="status" data-testid="library-action-message">
              {message}
              {host.sessionId !== null && (
                <a className="library-message-link" href="#waveyard-live-mixer">Open live mixer</a>
              )}
            </p>
          )}
          {refreshWarning && (
            <div className="library-message" role="status" data-testid="library-refresh-warning">
              <span>{refreshWarning}</span>
              <button type="button" className="button tiny" onClick={() => void refresh(search)}>
                Retry library refresh
              </button>
            </div>
          )}
          {retryableUploads.length > 0 && (
            <div className="library-message" role="status" data-testid="failed-library-uploads">
              <p>
                {retryableUploads.length} upload{retryableUploads.length === 1 ? "" : "s"} did not finish.
                The selected files are still available in this tab; retry without choosing them again.
              </p>
              <ul style={{ margin: "6px 0", paddingLeft: 18 }}>
                {retryableUploads.map(({ file, reason }) => (
                  <li key={uploadFileIdentity(file)}>{file.name} — {reason}</li>
                ))}
              </ul>
              <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                <button
                  type="button"
                  className="button tiny"
                  disabled={adding}
                  onClick={() => void addMusic(retryableUploads.map(({ file }) => file))}
                >
                  {adding
                    ? "Retrying uploads…"
                    : `Retry ${retryableUploads.length} failed upload${retryableUploads.length === 1 ? "" : "s"}`}
                </button>
                <button
                  type="button"
                  className="button tiny"
                  disabled={adding}
                  onClick={() => setRetryableUploads([])}
                >
                  Dismiss
                </button>
              </div>
            </div>
          )}
        </div>
        <div className="library-side">
          <input
            aria-label="Search your music"
            className="library-search"
            placeholder="Search title, artist, album…"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
          />
          {continueTrack !== null && (
            <Link className="continue-chip" href={`/waveyard/play/${continueTrack.id}`}>
              <span className="eyebrow">Continue</span>
              <b>{continueTrack.title}</b>
              <small>{formatPlayClock(playback?.positionSeconds ?? 0)} in</small>
            </Link>
          )}
          {queue.length > 0 && <div className="queue-panel">
            <div className="library-panel-title">
              <h2>Saved queue</h2>
              {queue.length > 0 && <button type="button" className="button secondary" onClick={() => void clearQueue()}>Clear</button>}
            </div>
            {queueErrorMessage !== null && (
              <p className="library-message" role="alert" data-testid="queue-mutation-error">{queueErrorMessage}</p>
            )}
            {queue.length === 0 ? (
              <p className="empty">Nothing queued. Add tracks with + Queue.</p>
            ) : (
              <ol className="queue-list">
                {queue.map((item, index) => (
                  <li key={item.id}>
                    <Link href={`/waveyard/play/${item.track.id}`}>{item.track.title}</Link>
                    <button
                      type="button"
                      aria-label={`Move ${item.track.title} up from position ${index + 1}`}
                      disabled={index === 0}
                      onClick={() => void moveQueueItem(item.id, index - 1)}
                    >↑</button>
                    <button
                      type="button"
                      aria-label={`Move ${item.track.title} down from position ${index + 1}`}
                      disabled={index === queue.length - 1}
                      onClick={() => void moveQueueItem(item.id, index + 1)}
                    >↓</button>
                    <button type="button" aria-label={`Remove ${item.track.title} from queue`} onClick={() => void removeQueueItem(item.id)}>×</button>
                  </li>
                ))}
              </ol>
            )}
          </div>}
        </div>
      </section>

      {recentlyPlayed.length > 0 && (
        <section className="recently-played" aria-label="Recently played">
          <div className="library-panel-title"><h2>Recently played</h2></div>
          <div className="recent-row">
            {recentlyPlayed.map((track) => (
              <Link key={track.id} className="recent-chip" href={`/waveyard/play/${track.id}`}>
                <span>{(track.artist || track.title).slice(0, 1).toUpperCase()}</span>
                <b>{track.title}</b>
                <small>{track.artist || "Unknown artist"}</small>
              </Link>
            ))}
          </div>
        </section>
      )}

      <section className="library-main" aria-label="Your library">
        <div className="library-panel-title">
          <h2>
            {activeCollection
              ? `Collection · ${activeCollection.name}`
              : search.trim() !== ""
                ? `Search · “${search.trim()}”`
                : "Library"}
          </h2>
          <span>
            {activeCollection ? (
              <button type="button" className="button secondary" onClick={() => setActiveCollectionId(null)}>Show all</button>
            ) : null}
            {visibleTracks.length} track{visibleTracks.length === 1 ? "" : "s"}
          </span>
        </div>
        <section className="library-audio-backup" aria-label="Audio file backup">
          <div>
            <strong>Back up local audio</strong>
            <p>Select tracks to download their exact stored originals in a ZIP with a CSV manifest.</p>
          </div>
          <div className="library-audio-backup-actions">
            <button
              type="button"
              className="button secondary"
              onClick={selectVisibleAudioTracks}
              disabled={visibleAudioTracks.length === 0 || visibleAudioTracks.length > 100}
              title={visibleAudioTracks.length > 100 ? "Select a smaller set or search first." : undefined}
            >
              Select visible originals ({visibleAudioTracks.length})
            </button>
            <button
              type="button"
              className="button secondary"
              onClick={() => { setSelectedAudioBackupIds(new Set()); setAudioBackupMessage(null); }}
              disabled={selectedAudioBackupIds.size === 0 || audioBackupBusy}
            >
              Clear
            </button>
            <button
              type="button"
              className="button"
              onClick={() => void downloadAudioBackup()}
              disabled={selectedAudioBackupIds.size === 0 || selectedAudioBackupIds.size > 100 || audioBackupBusy}
            >
              {audioBackupBusy ? "Preparing…" : `Download audio ZIP (${selectedAudioBackupIds.size})`}
            </button>
          </div>
          <small>Up to 100 tracks / 2 GiB per ZIP. This includes only original audio files stored in Waveyard—not Apple Music subscription streams.</small>
          {audioBackupMessage !== null && <p className="library-message" role="status" aria-live="polite">{audioBackupMessage}</p>}
        </section>
        <ConversionWorkbench
          tracks={visibleAudioTracks}
          onConverted={() => { void refresh(search); }}
        />
        <details
          className="library-streaming-backups"
          id="apple-music-metadata-backup"
          ref={streamingBackupsRef}
          open={streamingBackupsOpen}
          onToggle={(event) => setStreamingBackupsOpen(event.currentTarget.open)}
        >
          <summary>Apple Music metadata snapshots (CSV, XML, JSON)</summary>
          <p className="library-backup-note">
            Import a CSV, XML or JSON library metadata snapshot, then download it as CSV or JSON. This backs up track and playlist metadata only—not protected Apple Music subscription audio. Use the separate “Back up local audio” controls above for exact originals stored in Waveyard.
          </p>
          {streamingBackupsOpen && (
            <ConnectedLibraries
              projectId=""
              allowedServices={APPLE_BACKUP_SERVICES}
              dispatchEnabled={false}
            />
          )}
        </details>
        {loaded && trackLoadFailed && (
          <div className="library-message" role="alert" data-testid="track-load-failure">
            <span>
              {tracks.length === 0
                ? "Your tracks could not be loaded."
                : "Track refresh failed; showing the last loaded list."}
            </span>
            <button type="button" className="button tiny" onClick={() => void refresh(search)}>
              Retry track refresh
            </button>
          </div>
        )}
        {!loaded && tracks.length === 0 ? (
          <p className="empty" role="status">Loading your library…</p>
        ) : loaded && tracks.length === 0 && !trackLoadFailed ? (
          search.trim() !== "" ? (
            <p className="empty">Nothing matches that search.</p>
          ) : (
            <div className="first-run" aria-label="Welcome to Waveyard">
              <p className="empty">Your library is empty — add music to begin.</p>
            </div>
          )
        ) : (
          <div className="track-list">
            {visibleTracks.map((track) => (
              <TrackRow
                key={track.id}
                track={track}
                onQueue={onQueue}
                onPlay={playTrack}
                onNext={nextTrack}
                playlists={playlists}
                onAddToPlaylist={onAddToPlaylist}
                onRate={rateTrack}
                onLabels={setTrackLabels}
                onStartSeparation={startSeparation}
                onRetrySeparation={retrySeparation}
                audioBackupSelected={selectedAudioBackupIds.has(track.id)}
                onToggleAudioBackup={toggleAudioBackupTrack}
                starting={busySeparationTrackIds.has(track.id) && track.stemAvailability.status === "not-started"}
                retrying={busySeparationTrackIds.has(track.id) && (track.stemAvailability.status === "rejected" || track.stemAvailability.status === "failed")}
              />
            ))}
          </div>
        )}
      </section>

      <section className="playlists-panel" aria-label="Playlists">
        <div className="library-panel-title"><h2>Playlists</h2><span>{playlists.length}</span></div>
        {playlistMessage !== null && (
          <p className="library-message" role="alert" data-testid="playlist-mutation-error">{playlistMessage}</p>
        )}
        <form className="playlist-create" onSubmit={createPlaylist}>
          <input
            aria-label="New playlist name"
            value={newPlaylistName}
            maxLength={160}
            placeholder="New playlist…"
            onChange={(event) => setNewPlaylistName(event.target.value)}
          />
          <button className="button" type="submit" disabled={newPlaylistName.trim() === ""}>Create</button>
        </form>
        {playlists.length === 0 ? (
          <p className="empty">No playlists yet.</p>
        ) : (
          <ul className="playlist-list">
            {playlists.map((playlist) => (
              <li key={playlist.id} className={openPlaylist?.id === playlist.id ? "open" : ""}>
                <button
                  type="button"
                  className="playlist-row"
                  data-testid={`playlist-row-${playlist.id}`}
                  onClick={() => void openPlaylistDetail(playlist.id)}
                >
                  <b>{playlist.name}</b>
                  <small>{playlist.trackCount} track{playlist.trackCount === 1 ? "" : "s"}</small>
                </button>
                {openPlaylist?.id === playlist.id && (
                  <>
                    <button type="button" className="button secondary" disabled={openPlaylist.items.length === 0}
                      onClick={() => void enqueuePlaylist(openPlaylist)} data-testid={`playlist-live-${playlist.id}`}>
                      Add playlist to listening order
                    </button>
                    {playlistRenameId === playlist.id ? (
                      <form className="playlist-rename-form" onSubmit={(event) => void renamePlaylist(event, playlist.id)}>
                        <input
                          aria-label={`New name for ${playlist.name}`}
                          value={playlistNameDraft}
                          maxLength={160}
                          onChange={(event) => setPlaylistNameDraft(event.target.value)}
                        />
                        <button type="submit" className="button secondary" disabled={renamingPlaylistId === playlist.id || playlistNameDraft.trim() === ""}>
                          {renamingPlaylistId === playlist.id ? "Saving…" : "Save name"}
                        </button>
                        <button
                          type="button"
                          className="button secondary"
                          aria-label={`Cancel rename ${playlist.name}`}
                          disabled={renamingPlaylistId === playlist.id}
                          onClick={() => {
                            setPlaylistRenameId(null);
                            setPlaylistNameDraft("");
                          }}
                        >
                          Cancel
                        </button>
                      </form>
                    ) : (
                      <button
                        type="button"
                        className="button secondary playlist-rename-action"
                        aria-label={`Rename playlist ${playlist.name}`}
                        disabled={deletingPlaylistId === playlist.id}
                        onClick={() => {
                          setPlaylistMessage(null);
                          setPlaylistDeleteConfirmId(null);
                          setPlaylistNameDraft(playlist.name);
                          setPlaylistRenameId(playlist.id);
                        }}
                      >
                        Rename playlist
                      </button>
                    )}
                    <button
                      type="button"
                      className="button secondary playlist-delete-action"
                      aria-label={`Delete playlist ${playlist.name}`}
                      disabled={deletingPlaylistId === playlist.id}
                      onClick={() => {
                        setPlaylistMessage(null);
                        setPlaylistRenameId(null);
                        setPlaylistNameDraft("");
                        setPlaylistDeleteConfirmId(playlist.id);
                      }}
                    >
                      Delete playlist
                    </button>
                    {playlistDeleteConfirmId === playlist.id && (
                      <div className="playlist-delete-confirm" role="group" aria-label={`Confirm delete ${playlist.name}`}>
                        <p>Delete “{playlist.name}”? The tracks stay in your library; only this playlist and its order are removed.</p>
                        <button
                          type="button"
                          className="button"
                          aria-label={`Confirm delete ${playlist.name}`}
                          disabled={deletingPlaylistId === playlist.id}
                          onClick={() => void deletePlaylist(playlist.id)}
                        >
                          {deletingPlaylistId === playlist.id ? "Deleting…" : "Confirm delete"}
                        </button>
                        <button
                          type="button"
                          className="button secondary"
                          aria-label={`Cancel delete ${playlist.name}`}
                          disabled={deletingPlaylistId === playlist.id}
                          onClick={() => setPlaylistDeleteConfirmId(null)}
                        >
                          Cancel
                        </button>
                      </div>
                    )}
                    <ol className="playlist-items">
                      {openPlaylist.items.map((item, index) => (
                        <li key={item.id}>
                          <Link href={`/waveyard/play/${item.track.id}`}>{item.track.title}</Link>
                          <span className="playlist-item-actions">
                            <button type="button" aria-label="Move up" disabled={index === 0} onClick={() => void movePlaylistItem(playlist.id, item.id, index - 1)}>↑</button>
                            <button type="button" aria-label="Move down" disabled={index === openPlaylist.items.length - 1} onClick={() => void movePlaylistItem(playlist.id, item.id, index + 1)}>↓</button>
                            <button type="button" aria-label={`Remove ${item.track.title}`} onClick={() => void removePlaylistItem(playlist.id, item.id)}>×</button>
                          </span>
                        </li>
                      ))}
                      {openPlaylist.items.length === 0 && <li className="empty">Empty playlist.</li>}
                    </ol>
                  </>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="collections-panel" aria-label="Smart collections">
        <div className="library-panel-title"><h2>Smart collections</h2><span>{collections.length}</span></div>
        <form className="collection-create" onSubmit={createCollection}>
          <input
            aria-label="New collection name"
            value={newCollectionName}
            maxLength={64}
            placeholder="New collection…"
            onChange={(event) => setNewCollectionName(event.target.value)}
          />
          <select aria-label="Rule field" value={ruleField} onChange={(event) => setRuleField(event.target.value as SmartRuleField)}>
            {SMART_RULE_FIELDS.map((field) => (
              <option key={field} value={field}>{field}</option>
            ))}
          </select>
          <select aria-label="Rule operator" value={ruleOp} onChange={(event) => setRuleOp(event.target.value as SmartRuleOp)}>
            {SMART_RULE_OPS.map((op) => (
              <option key={op} value={op}>{op}</option>
            ))}
          </select>
          <input
            aria-label="Rule value"
            value={ruleValue}
            maxLength={64}
            placeholder="value"
            onChange={(event) => setRuleValue(event.target.value)}
          />
          <button className="button" type="submit" disabled={newCollectionName.trim() === ""}>Create</button>
        </form>
        {collections.length === 0 ? (
          <p className="empty">No smart collections yet. One rule is enough — e.g. rating ≥ 4.</p>
        ) : (
          <ul className="collection-list">
            {collections.map((collection) => (
              <li key={collection.id}>
                <button
                  type="button"
                  className={activeCollectionId === collection.id ? "playlist-row active" : "playlist-row"}
                  onClick={() => setActiveCollectionId((current) => (current === collection.id ? null : collection.id))}
                >
                  <b>{collection.name}</b>
                  <small>
                    {collection.rules.length === 0
                      ? "all tracks"
                      : `${collection.match} · ${collection.rules.map((rule) => `${rule.field} ${rule.op} ${rule.value}`).join(" / ")}`}
                    {" · "}
                    {collectionCounts.get(collection.id) ?? 0} track{(collectionCounts.get(collection.id) ?? 0) === 1 ? "" : "s"}
                  </small>
                </button>
                <button
                  type="button"
                  aria-label={`Delete collection ${collection.name}`}
                  className="collection-delete"
                  onClick={() => void removeCollection(collection.id)}
                >
                  ×
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>

      </div>
      {dragActive && (
        <div className="drop-overlay" role="status" aria-live="polite">
          <b>{dropBusy !== null ? `Adding ${dropBusy}…` : "Drop to separate"}</b>
          <small>Track import and separation start through the same library workflow.</small>
        </div>
      )}
      </>
  );
}
