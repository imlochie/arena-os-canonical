"use client";

/**
 * The P1 track player: real transport, real stems, honest availability.
 *
 * Deliberately minimal — the full-screen stem player is P2. What exists here
 * is the existing audio engine (useStemTransport) exposed through a listening
 * surface: play/pause/seek, master volume, per-stem volume/mute/solo via the
 * REAL Web Audio graph, honest stem availability, real play counting after a
 * listening threshold, and durable playback-state persistence (throttled).
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";

import { formatPlayClock, shouldCountPlay, STEM_CHANNEL_LABELS } from "@/lib/waveyard/library/model";
import { useStemTransport, type MixerValues } from "@/lib/waveyard/useStemTransport";

interface TrackDetail {
  id: string;
  title: string;
  artist: string;
  album: string;
  durationSeconds: number;
  playCount: number;
  stemAvailability: { status: string; stemCount?: number; reason?: string };
  studioProjectId: string;
  source: { id: string; originalFilename: string; codec: string; sampleRate: number; channels: number };
  stems: Array<{ id: string; stemType: string; engine: string }>;
  analysis: { status: string; bpm: number | null; musicalKey: string | null } | null;
  playback: { assetIds: string[]; kind: "stems" | "source" };
}

interface PlaylistSummary {
  id: string;
  name: string;
}

const SAVE_INTERVAL_MS = 10_000;

export function TrackPlayer({ trackId }: { trackId: string }) {
  const [track, setTrack] = useState<TrackDetail | null>(null);
  const [playlists, setPlaylists] = useState<PlaylistSummary[]>([]);
  const [mix, setMix] = useState<Record<string, MixerValues>>({});
  const [status, setStatus] = useState<string | null>(null);
  const countedRef = useRef(false);
  const mixRef = useRef<Record<string, MixerValues>>({});
  const positionRef = useRef(0);
  const playingRef = useRef(false);
  const masterRef = useRef(1);

  const assetIds = useMemo(() => track?.playback.assetIds ?? [], [track]);
  const transport = useStemTransport(assetIds, track?.durationSeconds ?? 0);
  // seek is a stable useCallback — safe as an effect dependency (the whole
  // transport object is a fresh literal every render).
  const seek = transport.seek;

  // Load the track, playlists, and any saved durable state for it.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const [trackResponse, playlistsResponse, stateResponse] = await Promise.all([
        fetch(`/api/library/tracks/${trackId}`, { cache: "no-store" }),
        fetch("/api/library/playlists", { cache: "no-store" }),
        fetch("/api/library/playback-state", { cache: "no-store" }),
      ]);
      if (cancelled) return;
      if (!trackResponse.ok) {
        setStatus("That track could not be found.");
        return;
      }
      const detail = (await trackResponse.json()).track as TrackDetail;
      setTrack(detail);
      if (playlistsResponse.ok) setPlaylists((await playlistsResponse.json()).playlists ?? []);

      // Restore a saved stem mix + position (durable state, real data).
      let savedMix: Record<string, number> = {};
      let savedPosition = 0;
      if (stateResponse.ok) {
        const state = (await stateResponse.json()).playbackState;
        if (state.currentTrackId === trackId) {
          savedMix = state.stemMix ?? {};
          savedPosition = state.positionSeconds ?? 0;
        }
      }
      const initial: Record<string, MixerValues> = {};
      for (const stem of detail.stems) {
        initial[stem.id] = {
          volume: savedMix[stem.stemType] ?? 1,
          pan: 0,
          muted: false,
          solo: false,
        };
      }
      setMix(initial);
      mixRef.current = initial;
      if (savedPosition > 0) seek(Math.min(savedPosition, detail.durationSeconds));
    })();
    return () => {
      cancelled = true;
    };
  }, [trackId, seek]);

  // Keep refs current for the throttled saver and the play counter.
  useEffect(() => {
    mixRef.current = mix;
  }, [mix]);
  useEffect(() => {
    positionRef.current = transport.position;
  }, [transport.position]);
  useEffect(() => {
    playingRef.current = transport.playing;
  }, [transport.playing]);
  useEffect(() => {
    masterRef.current = transport.masterVolume;
  }, [transport.masterVolume]);

  const persistState = useCallback(
    (playing: boolean) => {
      if (track === null) return;
      const stemMix: Record<string, number> = {};
      for (const stem of track.stems) {
        const values = mixRef.current[stem.id];
        if (values !== undefined) stemMix[stem.stemType] = values.volume;
      }
      void fetch("/api/library/playback-state", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          currentTrackId: track.id,
          positionSeconds: positionRef.current,
          stemMix,
          masterVolume: masterRef.current,
        }),
        keepalive: true,
      }).catch(() => {
        /* durable-state persistence is best-effort; playback never blocks on it */
      });
      void playing;
    },
    [track],
  );

  // Throttled durable-state saves while playing + on unmount.
  useEffect(() => {
    const interval = setInterval(() => {
      if (playingRef.current) persistState(true);
    }, SAVE_INTERVAL_MS);
    return () => {
      clearInterval(interval);
      persistState(false);
    };
  }, [persistState]);

  // Real play counting: once per visit, after genuine listening.
  useEffect(() => {
    if (track === null || countedRef.current) return;
    if (!shouldCountPlay(transport.position, track.durationSeconds)) return;
    countedRef.current = true;
    void fetch(`/api/library/tracks/${track.id}/played`, { method: "POST" }).catch(() => {
      /* counting is best-effort */
    });
  }, [transport.position, track]);

  const updateStem = useCallback(
    (assetId: string, patch: Partial<MixerValues>) => {
      setMix((current) => {
        const next = {
          ...current,
          [assetId]: { ...(current[assetId] ?? { volume: 1, pan: 0, muted: false, solo: false }), ...patch },
        };
        transport.applyMix(next);
        return next;
      });
    },
    [transport],
  );

  const togglePlay = useCallback(() => {
    if (transport.playing) {
      transport.pause();
      persistState(false);
    } else {
      void transport.play();
    }
  }, [transport, persistState]);

  const queueTrack = useCallback(async () => {
    const response = await fetch("/api/library/queue", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ trackId, at: "end" }),
    });
    setStatus(response.ok ? "Added to the queue." : "Could not add to the queue.");
  }, [trackId]);

  if (track === null) {
    return (
      <section className="player-shell" aria-label="Track player">
        <p className="empty">{status ?? "Loading…"}</p>
        <Link className="button secondary" href="/waveyard">Back to music</Link>
      </section>
    );
  }

  const availabilityNote =
    track.playback.kind === "stems"
      ? null
      : track.stemAvailability.status === "source-only" || track.stemAvailability.status === "unavailable"
        ? track.stemAvailability.reason ?? "Playing the full, unseparated source."
        : "Stems are separating in the background — playing the full source until they are ready.";

  return (
    <section className="player-shell" aria-label={`Player · ${track.title}`} data-testid="track-player">
      <header className="player-head">
        <div className="track-art big"><span>{(track.artist || track.title).slice(0, 1).toUpperCase()}</span></div>
        <div>
          <span className="eyebrow">Now playing</span>
          <h1>{track.title}</h1>
          <p>{track.artist || "Unknown artist"}{track.album ? ` · ${track.album}` : ""}</p>
          <p className="player-facts">
            {formatPlayClock(track.durationSeconds)}
            {track.analysis?.status === "complete" && track.analysis.bpm !== null ? ` · ${Math.round(track.analysis.bpm)} BPM` : ""}
            {track.analysis?.status === "complete" && track.analysis.musicalKey ? ` · ${track.analysis.musicalKey}` : ""}
            {` · ${track.source.codec} ${track.source.sampleRate / 1000}kHz`}
          </p>
        </div>
      </header>

      {availabilityNote !== null && <p className="player-note" role="note">{availabilityNote}</p>}

      {/* Real audio elements — the transport drives the actual Web Audio graph. */}
      {assetIds.map((assetId, index) => (
        <audio
          key={assetId}
          aria-label={track.playback.kind === "stems" ? `${track.stems[index]?.stemType ?? "stem"} audio` : "full track audio"}
          ref={(element) => transport.register(assetId, element)}
          src={`/api/assets/${assetId}`}
          preload="auto"
        />
      ))}

      <div className="player-transport">
        <button type="button" className="player-play" onClick={togglePlay} aria-pressed={transport.playing}>
          {transport.playing ? "❚❚" : "▶"}
        </button>
        <span className="player-clock">{formatPlayClock(transport.position)}</span>
        <input
          aria-label="Seek"
          type="range"
          min={0}
          max={Math.max(track.durationSeconds, 1)}
          step={0.5}
          value={Math.min(transport.position, track.durationSeconds)}
          onChange={(event) => transport.seek(Number(event.target.value))}
        />
        <span className="player-clock">{formatPlayClock(track.durationSeconds)}</span>
        <label className="player-master">
          <span>VOL</span>
          <input
            aria-label="Master volume"
            type="range"
            min={0}
            max={1}
            step={0.01}
            value={transport.masterVolume}
            onChange={(event) => transport.setMasterVolume(Number(event.target.value))}
          />
        </label>
      </div>
      {transport.error !== null && <p className="error" role="alert">{transport.error}</p>}

      {track.playback.kind === "stems" ? (
        <div className="player-stems" aria-label="Stem channels">
          {track.stems
            .filter((stem) => assetIds.includes(stem.id))
            .map((stem) => {
              const values = mix[stem.id] ?? { volume: 1, pan: 0, muted: false, solo: false };
              const label = STEM_CHANNEL_LABELS[stem.stemType] ?? stem.stemType;
              return (
                <div className="player-stem" key={stem.id} data-testid={`stem-${stem.stemType}`}>
                  <b>{label.toUpperCase()}</b>
                  <input
                    aria-label={`${label} volume`}
                    type="range"
                    min={0}
                    max={2}
                    step={0.01}
                    value={values.volume}
                    onChange={(event) => updateStem(stem.id, { volume: Number(event.target.value) })}
                  />
                  <button type="button" aria-pressed={values.muted} aria-label={`Mute ${label}`} className={values.muted ? "active" : ""} onClick={() => updateStem(stem.id, { muted: !values.muted })}>M</button>
                  <button type="button" aria-pressed={values.solo} aria-label={`Solo ${label}`} className={values.solo ? "active" : ""} onClick={() => updateStem(stem.id, { solo: !values.solo })}>S</button>
                </div>
              );
            })}
        </div>
      ) : (
        <div className="player-stems source-only" aria-label="Playback mode">
          <div className="player-stem"><b>FULL TRACK</b><small>stem controls appear once separation finishes</small></div>
        </div>
      )}

      <div className="player-actions">
        <button type="button" className="button" onClick={() => void queueTrack()}>+ Queue</button>
        {playlists.length > 0 && (
          <select
            aria-label="Add to playlist"
            className="track-playlist-select"
            defaultValue=""
            onChange={async (event) => {
              const playlistId = event.target.value;
              event.currentTarget.value = "";
              if (playlistId === "") return;
              const response = await fetch(`/api/library/playlists/${playlistId}/items`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ trackId: track.id }),
              });
              setStatus(response.ok ? "Added to the playlist." : "Could not add to the playlist.");
            }}
          >
            <option value="">+ Playlist…</option>
            {playlists.map((playlist) => (
              <option key={playlist.id} value={playlist.id}>{playlist.name}</option>
            ))}
          </select>
        )}
        <Link className="button secondary" href={`/waveyard/projects/${track.studioProjectId}`}>Open in Studio ↗</Link>
        <Link className="button secondary" href="/waveyard">Back to music</Link>
      </div>
      {status !== null && <p className="library-message" role="status">{status}</p>}
    </section>
  );
}
