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
import Link from "next/link";

import { formatPlayClock } from "@/lib/waveyard/library/model";
import {
  SMART_RULE_FIELDS,
  SMART_RULE_OPS,
  evaluateCollection,
  type CollectionTrack,
  type SmartCollection,
  type SmartRuleField,
  type SmartRuleOp,
} from "@/lib/waveyard/library/collections";

const AUDIO_ACCEPT = "audio/wav,audio/mpeg,audio/flac,audio/mp4,audio/aac,audio/ogg,.wav,.mp3,.flac,.m4a,.aac,.ogg";

interface TrackSummary {
  id: string;
  title: string;
  artist: string;
  album: string;
  durationSeconds: number;
  playCount: number;
  rating: number;
  labels: string[];
  lastPlayedAt: string | null;
  addedAt: string;
  stemAvailability: { status: string; stemCount?: number; reason?: string };
  studioProjectId: string;
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

interface StudioProject {
  id: string;
  title: string;
  updatedAt: string;
}

interface SessionSummary {
  id: string;
  name: string;
  trackCount: number;
  updatedAt: string;
}

function StemBadge({ availability }: { availability: TrackSummary["stemAvailability"] }) {
  const label =
    availability.status === "separated" ? `${availability.stemCount} STEMS`
    : availability.status === "source-only" ? "SOURCE"
    : availability.status === "processing" ? "SEPARATING…"
    : "NO STEMS";
  return (
    <span
      className={`stem-badge ${availability.status}`}
      title={availability.reason ?? "Separated stems are ready."}
    >
      {label}
    </span>
  );
}

function TrackRow({
  track,
  onQueue,
  playlists,
  onAddToPlaylist,
  onRate,
  onLabels,
}: {
  track: TrackSummary;
  onQueue: (track: TrackSummary) => void;
  playlists: PlaylistSummary[];
  onAddToPlaylist: (playlistId: string, track: TrackSummary) => void;
  onRate: (track: TrackSummary, rating: number) => void;
  onLabels: (track: TrackSummary, labels: string[]) => void;
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
        <Link className="button" href={`/waveyard/play/${track.id}`}>Play</Link>
        <button type="button" className="button secondary" onClick={() => onQueue(track)}>+ Queue</button>
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
        <Link className="button secondary" href={`/waveyard/projects/${track.studioProjectId}`}>Studio ↗</Link>
      </div>
    </article>
  );
}

export function MusicHome() {
  const [tracks, setTracks] = useState<TrackSummary[]>([]);
  const [playback, setPlayback] = useState<{ currentTrackId: string | null; positionSeconds: number } | null>(null);
  const [playlists, setPlaylists] = useState<PlaylistSummary[]>([]);
  const [openPlaylist, setOpenPlaylist] = useState<PlaylistDetail | null>(null);
  const [queue, setQueue] = useState<QueueItem[]>([]);
  const [studioProjects, setStudioProjects] = useState<StudioProject[]>([]);
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [search, setSearch] = useState("");
  const [adding, setAdding] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
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
  const [loaded, setLoaded] = useState(false);
  const reloadTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const refresh = useCallback(async (query: string) => {
    const [tracksResponse, playbackResponse, playlistsResponse, queueResponse, projectsResponse, sessionsResponse, collectionsResponse] =
      await Promise.all([
        fetch(`/api/library/tracks${query.trim() ? `?q=${encodeURIComponent(query.trim())}` : ""}`, { cache: "no-store" }),
        fetch("/api/library/playback-state", { cache: "no-store" }),
        fetch("/api/library/playlists", { cache: "no-store" }),
        fetch("/api/library/queue", { cache: "no-store" }),
        fetch("/api/waveyard/projects", { cache: "no-store" }),
        fetch("/api/library/sessions", { cache: "no-store" }),
        fetch("/api/library/collections", { cache: "no-store" }),
      ]);
    if (tracksResponse.ok) setTracks((await tracksResponse.json()).tracks ?? []);
    if (playbackResponse.ok) {
      const state = (await playbackResponse.json()).playbackState;
      setPlayback({ currentTrackId: state.currentTrackId, positionSeconds: state.positionSeconds });
    }
    if (playlistsResponse.ok) setPlaylists((await playlistsResponse.json()).playlists ?? []);
    if (queueResponse.ok) setQueue((await queueResponse.json()).queue ?? []);
    if (collectionsResponse.ok) setCollections((await collectionsResponse.json()).collections ?? []);
    setLibraryClockMs(Date.now());
    if (projectsResponse.ok) setStudioProjects((await projectsResponse.json()).projects ?? []);
    if (sessionsResponse.ok) setSessions((await sessionsResponse.json()).sessions ?? []);
    setLoaded(true);
  }, []);

  useEffect(() => {
    // Initial load deferred to a timer callback (repo lint pattern: no
    // synchronous setState chains from the effect body).
    const timer = setTimeout(() => {
      void refresh("");
    }, 0);
    return () => clearTimeout(timer);
  }, [refresh]);

  // Debounced live search over real persisted metadata.
  useEffect(() => {
    if (reloadTimer.current !== null) clearTimeout(reloadTimer.current);
    reloadTimer.current = setTimeout(() => {
      void (async () => {
        const response = await fetch(`/api/library/tracks${search.trim() ? `?q=${encodeURIComponent(search.trim())}` : ""}`, { cache: "no-store" });
        if (response.ok) setTracks((await response.json()).tracks ?? []);
      })();
    }, 250);
    return () => {
      if (reloadTimer.current !== null) clearTimeout(reloadTimer.current);
    };
  }, [search]);

  const addMusic = useCallback(
    async (files: FileList | null) => {
      if (files === null || files.length === 0) return;
      setAdding(true);
      setMessage(null);
      const failures: string[] = [];
      let added = 0;
      for (const file of Array.from(files)) {
        const payload = new FormData();
        payload.set("file", file);
        const response = await fetch("/api/library/tracks", { method: "POST", body: payload });
        if (response.ok) {
          const body = await response.json().catch(() => ({}));
          if (body.created !== false) added += 1;
        } else {
          failures.push(`${file.name}: ${(await response.json().catch(() => ({}))).error ?? "could not add"}`);
        }
      }
      setAdding(false);
      setMessage(
        failures.length > 0
          ? `Added ${added}; ${failures.length} failed — ${failures[0]}`
          : added > 0
            ? `Added ${added} track${added === 1 ? "" : "s"} to your library. Stems separate in the background.`
            : "That audio is already in your library.",
      );
      await refresh(search);
    },
    [refresh, search],
  );

  const onQueue = useCallback(async (track: TrackSummary) => {
    const response = await fetch("/api/library/queue", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ trackId: track.id, at: "end", currentTrackId: playback?.currentTrackId ?? null }),
    });
    if (response.ok) setQueue((await response.json()).queue ?? []);
  }, [playback]);

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
    const response = await fetch("/api/library/playlists", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name }),
    });
    if (response.ok) {
      setNewPlaylistName("");
      const listResponse = await fetch("/api/library/playlists", { cache: "no-store" });
      if (listResponse.ok) setPlaylists((await listResponse.json()).playlists ?? []);
    }
  }, [newPlaylistName]);

  const openPlaylistDetail = useCallback(async (playlistId: string) => {
    if (openPlaylist?.id === playlistId) {
      setOpenPlaylist(null);
      return;
    }
    const response = await fetch(`/api/library/playlists/${playlistId}`, { cache: "no-store" });
    if (response.ok) setOpenPlaylist((await response.json()).playlist);
  }, [openPlaylist]);

  const onAddToPlaylist = useCallback(async (playlistId: string, track: TrackSummary) => {
    const response = await fetch(`/api/library/playlists/${playlistId}/items`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ trackId: track.id }),
    });
    if (response.ok) {
      const detail = (await response.json()).playlist as PlaylistDetail;
      setOpenPlaylist(detail);
      const listResponse = await fetch("/api/library/playlists", { cache: "no-store" });
      if (listResponse.ok) setPlaylists((await listResponse.json()).playlists ?? []);
    }
  }, []);

  const removePlaylistItem = useCallback(async (playlistId: string, itemId: string) => {
    const response = await fetch(`/api/library/playlists/${playlistId}/items?itemId=${itemId}`, { method: "DELETE" });
    if (response.ok) {
      const detail = (await response.json()).playlist as PlaylistDetail;
      setOpenPlaylist(detail);
      const listResponse = await fetch("/api/library/playlists", { cache: "no-store" });
      if (listResponse.ok) setPlaylists((await listResponse.json()).playlists ?? []);
    }
  }, []);

  const movePlaylistItem = useCallback(async (playlistId: string, itemId: string, position: number) => {
    const response = await fetch(`/api/library/playlists/${playlistId}/items`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ itemId, position }),
    });
    if (response.ok) setOpenPlaylist((await response.json()).playlist);
  }, []);

  const removeQueueItem = useCallback(async (itemId: string) => {
    const response = await fetch(`/api/library/queue/${itemId}`, { method: "DELETE" });
    if (response.ok) setQueue((await response.json()).queue ?? []);
  }, []);

  const clearQueue = useCallback(async () => {
    const response = await fetch("/api/library/queue", { method: "DELETE" });
    if (response.ok) setQueue([]);
  }, []);

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
      <section className="library-hero" aria-label="Your music">
        <div>
          <span className="eyebrow">Your music, stem-aware</span>
          <h1>Listen first.</h1>
          <p>
            Add audio you own or are authorized to use. Waveyard separates it into stems, understands it, and keeps the
            studio one click deeper — but up here, it&rsquo;s just your music.
          </p>
          <label className="add-music">
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
            <small>MP3 · WAV · FLAC · M4A · AAC · OGG — local and private</small>
          </label>
          {message && <p className="library-message" role="status">{message}</p>}
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
          <div className="queue-panel">
            <div className="library-panel-title">
              <h2>Queue</h2>
              {queue.length > 0 && <button type="button" className="button secondary" onClick={() => void clearQueue()}>Clear</button>}
            </div>
            {queue.length === 0 ? (
              <p className="empty">Nothing queued. Add tracks with + Queue.</p>
            ) : (
              <ol className="queue-list">
                {queue.map((item) => (
                  <li key={item.id}>
                    <Link href={`/waveyard/play/${item.track.id}`}>{item.track.title}</Link>
                    <button type="button" aria-label={`Remove ${item.track.title} from queue`} onClick={() => void removeQueueItem(item.id)}>×</button>
                  </li>
                ))}
              </ol>
            )}
          </div>
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
        {loaded && tracks.length === 0 ? (
          search.trim() !== "" ? (
            <p className="empty">Nothing matches that search.</p>
          ) : (
            <div className="first-run" aria-label="Welcome to Waveyard">
              <p className="empty">Your library is empty — add music to begin.</p>
              <ol>
                <li>
                  <b>Add music you own or are authorized to use.</b> Files stay on this machine — nothing is uploaded,
                  and there is no demo catalogue.
                </li>
                <li>
                  <b>Tracks become stem-aware.</b> When separation runs, Waveyard splits them into stems — vocals,
                  drums, bass, melody — that you can mute, solo and rebalance live. When separation can&rsquo;t run,
                  the track plays as its full source and says so.
                </li>
                <li>
                  <b>Play, queue and build playlists.</b> The studio — arrangement, cleanup, mastering, exports — is
                  one click deeper, and never changes your originals.
                </li>
                <li>
                  <b>Perform with sessions.</b> Line up several songs, crossfade between them with live stem control,
                  and route the result to Stem2 hardware when you have one.
                </li>
              </ol>
            </div>
          )
        ) : (
          <div className="track-list">
            {visibleTracks.map((track) => (
              <TrackRow
                key={track.id}
                track={track}
                onQueue={onQueue}
                playlists={playlists}
                onAddToPlaylist={onAddToPlaylist}
                onRate={rateTrack}
                onLabels={setTrackLabels}
              />
            ))}
          </div>
        )}
      </section>

      <section className="playlists-panel" aria-label="Playlists">
        <div className="library-panel-title"><h2>Playlists</h2><span>{playlists.length}</span></div>
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
                <button type="button" className="playlist-row" onClick={() => void openPlaylistDetail(playlist.id)}>
                  <b>{playlist.name}</b>
                  <small>{playlist.trackCount} track{playlist.trackCount === 1 ? "" : "s"}</small>
                </button>
                {openPlaylist?.id === playlist.id && (
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

      <section className="sessions-panel" aria-label="Sessions">
        <div className="library-panel-title">
          <h2>Sessions</h2>
          <Link className="button secondary" href="/waveyard/sessions">New session</Link>
        </div>
        {sessions.length === 0 ? (
          <p className="empty">
            No sessions yet. A session lines up songs to play as one set — start one from{" "}
            <Link href="/waveyard/sessions">Sessions</Link>, or take a playing track into one from its player.
          </p>
        ) : (
          <ul className="sessions-list">
            {sessions.slice(0, 6).map((session) => (
              <li key={session.id}>
                <Link href={`/waveyard/session/${session.id}`}>
                  <b>{session.name}</b>
                  <small>
                    {session.trackCount} track{session.trackCount === 1 ? "" : "s"} · updated{" "}
                    {new Date(session.updatedAt).toLocaleDateString()}
                  </small>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="studio-panel" aria-label="Studio projects">
        <div className="library-panel-title">
          <h2>Studio</h2>
          <Link className="button secondary" href="/waveyard/create">New studio project</Link>
        </div>
        {studioProjects.length === 0 ? (
          <p className="empty">No studio projects yet. The studio is where deep arrangement, cleanup, mastering and exports live.</p>
        ) : (
          <ul className="studio-list">
            {studioProjects.map((project) => (
              <li key={project.id}>
                <Link href={`/waveyard/projects/${project.id}`}>{project.title}</Link>
              </li>
            ))}
          </ul>
        )}
    </section>
      </>
  );
}
