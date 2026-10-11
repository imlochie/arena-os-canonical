"use client";

/**
 * The P2 Waveyard player — the core listening experience.
 *
 * Everything real comes from the EXISTING engine:
 *  - useStemTransport: the actual Web Audio graph (per-stem gain/mute/solo,
 *    master, analysers, loop, seek) — consumed, not rewritten;
 *  - WaveformCanvas: the existing waveform component (real peaks, playhead,
 *    click-seek, honest loading/unavailable states);
 *  - the P1 library APIs: tracks, queue, playlists, playback state.
 *
 * Advancement/repeat/shuffle/play-count rules live in player-logic.ts (pure,
 * tested). Meters poll the real AnalyserNode taps only while audio flows —
 * no simulated movement anywhere. Honest stem states: a source-only track
 * explains why stem controls are unavailable instead of faking four stems.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";

import { formatPlayClock, STEM_CHANNEL_LABELS } from "@/lib/waveyard/library/model";
import {
  SEEK_STEP_SECONDS,
  isTextEntryTarget,
  meterDb,
  meterLevel,
  nextTrackFromQueue,
  previousTrackFromQueue,
  shouldRecordPlay,
  type QueueEntry,
  type RepeatMode,
} from "@/lib/waveyard/library/player-logic";
import { useStemTransport, type ChannelMeter, type MixerValues } from "@/lib/waveyard/useStemTransport";
import { useHardwareMediaKeys } from "@/lib/waveyard/stem2";
import Stem2Panel from "@/components/waveyard/stem2/Stem2Panel";
import { WaveformCanvas } from "@/components/waveyard/WaveformCanvas";

interface TrackDetail {
  id: string;
  title: string;
  artist: string;
  album: string;
  durationSeconds: number;
  playCount: number;
  stemAvailability: { status: string; stemCount?: number; reason?: string };
  studioProjectId: string;
  source: { id: string; originalFilename: string; codec: string; sampleRate: number; channels: number; bitrate: number | null };
  stems: Array<{ id: string; stemType: string; engine: string }>;
  analysis: { status: string; bpm: number | null; musicalKey: string | null } | null;
  playback: { assetIds: string[]; kind: "stems" | "source" };
}

interface PlaylistSummary {
  id: string;
  name: string;
}

interface QueueItem {
  id: string;
  position: number;
  track: { id: string; title: string; artist: string };
}

const SAVE_INTERVAL_MS = 10_000;

export function TrackPlayer({ trackId }: { trackId: string }) {
  const router = useRouter();

  const [track, setTrack] = useState<TrackDetail | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [playlists, setPlaylists] = useState<PlaylistSummary[]>([]);
  const [queue, setQueue] = useState<QueueItem[]>([]);
  const [queueOpen, setQueueOpen] = useState(false);
  const [mix, setMix] = useState<Record<string, MixerValues>>({});
  const [meters, setMeters] = useState<Record<string, ChannelMeter> | null>(null);
  const [masterMeter, setMasterMeter] = useState<ChannelMeter | null>(null);
  const [repeat, setRepeat] = useState<RepeatMode>("off");
  const [shuffle, setShuffle] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [startingSession, setStartingSession] = useState(false);

  const countedRef = useRef(false);
  const mixRef = useRef<Record<string, MixerValues>>({});
  const positionRef = useRef(0);
  const playingRef = useRef(false);
  const masterRef = useRef(1);
  const repeatRef = useRef<RepeatMode>("off");
  const shuffleRef = useRef(false);
  const queueRef = useRef<QueueItem[]>([]);
  const trackRef = useRef<TrackDetail | null>(null);
  const advancingRef = useRef(false);

  const assetIds = useMemo(() => track?.playback.assetIds ?? [], [track]);
  const duration = track?.durationSeconds ?? 0;
  const transport = useStemTransport(assetIds, duration);
  const seek = transport.seek;

  // ---------------------------------------------------------------- loading
  useEffect(() => {
    const timer = setTimeout(() => {
      void (async () => {
        const [trackResponse, playlistsResponse, queueResponse, stateResponse] = await Promise.all([
          fetch(`/api/library/tracks/${trackId}`, { cache: "no-store" }),
          fetch("/api/library/playlists", { cache: "no-store" }),
          fetch("/api/library/queue", { cache: "no-store" }),
          fetch("/api/library/playback-state", { cache: "no-store" }),
        ]);
        if (trackResponse.status === 404) {
          setLoadError("That track is not in your library — it may have been removed.");
          return;
        }
        if (!trackResponse.ok) {
          setLoadError("The track could not be loaded right now.");
          return;
        }
        const detail = (await trackResponse.json()).track as TrackDetail;
        setTrack(detail);
        trackRef.current = detail;
        if (playlistsResponse.ok) setPlaylists((await playlistsResponse.json()).playlists ?? []);
        if (queueResponse.ok) {
          const loaded = (await queueResponse.json()).queue ?? [];
          setQueue(loaded);
          queueRef.current = loaded;
        }

        // Restore durable state for THIS track (position, stem mix, volume,
        // repeat, shuffle) — real persisted values only.
        if (stateResponse.ok) {
          const state = (await stateResponse.json()).playbackState;
          const savedMix = state.currentTrackId === trackId ? state.stemMix ?? {} : {};
          const savedPosition = state.currentTrackId === trackId ? state.positionSeconds ?? 0 : 0;
          const initial: Record<string, MixerValues> = {};
          for (const stem of detail.stems) {
            initial[stem.id] = { volume: savedMix[stem.stemType] ?? 1, pan: 0, muted: false, solo: false };
          }
          setMix(initial);
          mixRef.current = initial;
          transport.applyMix(initial);
          if (savedPosition > 0) seek(Math.min(savedPosition, detail.durationSeconds));
          setRepeat(state.repeatMode ?? "off");
          repeatRef.current = state.repeatMode ?? "off";
          setShuffle(state.shuffle === true);
          shuffleRef.current = state.shuffle === true;
          transport.setMasterVolume(typeof state.masterVolume === "number" ? state.masterVolume : 1);
        }

        // Auto-advance navigations (?autoplay=1) continue playback; the
        // browser allows it because the user already interacted.
        if (new URLSearchParams(window.location.search).get("autoplay") === "1") {
          void transport.play();
        }
      })();
    }, 0);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- one-shot per track; transport functions are stable callbacks
  }, [trackId]);

  // Keep refs current for stable callbacks (throttled saver, end handling).
  useEffect(() => { mixRef.current = mix; }, [mix]);
  useEffect(() => { positionRef.current = transport.position; }, [transport.position]);
  useEffect(() => { playingRef.current = transport.playing; }, [transport.playing]);
  useEffect(() => { masterRef.current = transport.masterVolume; }, [transport.masterVolume]);
  useEffect(() => { repeatRef.current = repeat; }, [repeat]);
  useEffect(() => { shuffleRef.current = shuffle; }, [shuffle]);
  useEffect(() => { queueRef.current = queue; }, [queue]);

  // Repeat-one is the ENGINE's native loop (seamless, clock-driven, survives
  // background tabs via the onEnded fallback below). Off/all disable it.
  useEffect(() => {
    if (track === null) return;
    transport.setLoop(
      repeat === "one" && duration > 0
        ? { enabled: true, start: 0, end: duration }
        : { enabled: false, start: 0, end: 0 },
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps -- setLoop is a stable setState; re-run on mode/duration changes
  }, [repeat, duration, track === null]);

  // ------------------------------------------------------------ persistence
  const persistState = useCallback((includeMode: boolean) => {
    const current = trackRef.current;
    if (current === null) return;
    const stemMix: Record<string, number> = {};
    for (const stem of current.stems) {
      const values = mixRef.current[stem.id];
      if (values !== undefined) stemMix[stem.stemType] = values.volume;
    }
    void fetch("/api/library/playback-state", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        currentTrackId: current.id,
        positionSeconds: positionRef.current,
        stemMix,
        masterVolume: masterRef.current,
        ...(includeMode ? { repeatMode: repeatRef.current, shuffle: shuffleRef.current } : {}),
      }),
      keepalive: true,
    }).catch(() => {
      /* durable-state persistence is best-effort; playback never blocks on it */
    });
  }, []);

  useEffect(() => {
    const interval = setInterval(() => {
      if (playingRef.current) persistState(false);
    }, SAVE_INTERVAL_MS);
    return () => {
      clearInterval(interval);
      persistState(false);
    };
  }, [persistState]);

  // ------------------------------------------------------------- play count
  useEffect(() => {
    if (track === null) return;
    if (!shouldRecordPlay(countedRef.current, transport.position, track.durationSeconds)) return;
    countedRef.current = true;
    void fetch(`/api/library/tracks/${track.id}/played`, { method: "POST" }).catch(() => {
      /* counting is best-effort */
    });
  }, [transport.position, track]);

  // ----------------------------------------------------------------- meters
  // Real AnalyserNode taps, polled ONLY while audio flows (the studio's
  // proven rAF pattern). Zeros when stopped — never simulated movement.
  useEffect(() => {
    if (!transport.playing) {
      // Drop the bars to zero one frame after stopping (async by design —
      // no synchronous setState chains from the effect body).
      const idleId = requestAnimationFrame(() => {
        setMeters(null);
        setMasterMeter(null);
      });
      return () => cancelAnimationFrame(idleId);
    }
    let rafId = 0;
    let lastUpdate = 0;
    const tick = (now: number) => {
      if (now - lastUpdate > 50) {
        lastUpdate = now;
        const snapshot = transport.readMeters();
        setMeters(snapshot.channels);
        setMasterMeter(snapshot.master);
      }
      rafId = requestAnimationFrame(tick);
    };
    rafId = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(rafId);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- readMeters is a stable callback; re-bind on play state only
  }, [transport.playing]);

  // ------------------------------------------------------------ advancement
  const goToTrack = useCallback(
    (nextTrackId: string) => {
      persistState(false);
      router.push(`/waveyard/play/${nextTrackId}?autoplay=1`);
    },
    [persistState, router],
  );

  /** Natural end of the audio (fires once, on the anchor element only). */
  const handleEnded = useCallback(() => {
    if (repeatRef.current === "one") {
      // Background-tab fallback: the clock loop normally replays seamlessly.
      seek(0);
      setTimeout(() => void transport.play(), 60);
      return;
    }
    if (advancingRef.current) return;
    advancingRef.current = true;
    void (async () => {
      // Decide from the PERSISTED queue (single source of truth), fetched fresh.
      const response = await fetch("/api/library/queue", { cache: "no-store" }).catch(() => null);
      const fresh: QueueEntry[] = response !== null && response.ok
        ? ((await response.json()).queue ?? []).map((item: QueueItem) => ({ id: item.id, trackId: item.track.id }))
        : queueRef.current.map((item) => ({ id: item.id, trackId: item.track.id }));
      const decision = nextTrackFromQueue(fresh, trackRef.current?.id ?? null, repeatRef.current, shuffleRef.current);
      if (decision.action === "play") {
        persistState(false);
        router.push(`/waveyard/play/${decision.trackId}?autoplay=1`);
      } else {
        // End of queue: keep durable state at the final position.
        persistState(false);
      }
      advancingRef.current = false;
    })();
  }, [persistState, router, seek, transport]);

  const skipNext = useCallback(() => {
    const entries = queueRef.current.map((item) => ({ id: item.id, trackId: item.track.id }));
    const decision = nextTrackFromQueue(entries, trackRef.current?.id ?? null, repeatRef.current === "one" ? "off" : repeatRef.current, shuffleRef.current);
    if (decision.action === "play") goToTrack(decision.trackId);
  }, [goToTrack]);

  const skipPrevious = useCallback(() => {
    const entries = queueRef.current.map((item) => ({ id: item.id, trackId: item.track.id }));
    const previous = previousTrackFromQueue(entries, trackRef.current?.id ?? null);
    if (previous !== null) goToTrack(previous);
  }, [goToTrack]);

  // ------------------------------------------- LISTEN → PERFORM (P5 bridge)
  // Take the playing track into a session: create the session, add THIS
  // track, open the session surface. Existing APIs only; playback stops here
  // and continues as a session (the session engine takes over — there is
  // only one playback engine, never two running at once).
  const playAsSession = useCallback(() => {
    if (startingSession || track === null) return;
    setStartingSession(true);
    void (async () => {
      try {
        const created = await fetch("/api/library/sessions", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ name: track.title }),
        });
        if (!created.ok) {
          setStatus("The session could not be created.");
          return;
        }
        const session = (await created.json()).session as { id: string };
        const added = await fetch(`/api/library/sessions/${session.id}/tracks`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ trackId: track.id }),
        });
        if (!added.ok) {
          setStatus("The track could not be added to the new session.");
          return;
        }
        transport.pause();
        router.push(`/waveyard/session/${session.id}`);
      } catch {
        setStatus("The session could not be created.");
      } finally {
        setStartingSession(false);
      }
    })();
  }, [startingSession, track, transport, router]);

  // ------------------------------------- hardware media keys (P4, standard path)
  // OS/hardware play-pause/skip commands (keyboards, Bluetooth speakers that
  // send standard media commands) drive the SAME controls as the on-screen
  // buttons. Whether a given device's buttons emit these commands is verified
  // on hardware — never claimed here.
  useHardwareMediaKeys({
    nowPlaying:
      track === null
        ? null
        : {
            title: track.title,
            artist: track.artist,
            album: track.album || null,
            playing: transport.playing,
          },
    handlers: {
      onPlayPause: () => {
        if (transport.playing) transport.pause();
        else void transport.play();
      },
      onNext: skipNext,
      onPrevious: skipPrevious,
    },
  });

  // ------------------------------------------------------------- keyboard
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.defaultPrevented || isTextEntryTarget(event.target)) return;
      if (event.code === "Space") {
        event.preventDefault();
        if (transport.playing) transport.pause();
        else void transport.play();
      } else if (event.key === "ArrowRight") {
        event.preventDefault();
        seek(positionRef.current + SEEK_STEP_SECONDS);
      } else if (event.key === "ArrowLeft") {
        event.preventDefault();
        seek(Math.max(0, positionRef.current - SEEK_STEP_SECONDS));
      } else if (event.key === "n") {
        skipNext();
      } else if (event.key === "p") {
        skipPrevious();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- transport controls are stable; skip callbacks keep their own refs
  }, [transport.playing, seek, skipNext, skipPrevious]);

  // ------------------------------------------------------------ stem mix UI
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

  const changeRepeat = useCallback(() => {
    setRepeat((current) => (current === "off" ? "all" : current === "all" ? "one" : "off"));
    setStatus(null);
    // Mode changes persist immediately (durable, cheap).
    setTimeout(() => persistState(true), 0);
  }, [persistState]);

  const changeShuffle = useCallback(() => {
    setShuffle((current) => !current);
    setTimeout(() => persistState(true), 0);
  }, [persistState]);

  // ------------------------------------------------------------ queue panel
  const refreshQueue = useCallback(async () => {
    const response = await fetch("/api/library/queue", { cache: "no-store" });
    if (response.ok) {
      const loaded = (await response.json()).queue ?? [];
      setQueue(loaded);
      queueRef.current = loaded;
    }
  }, []);

  const queueAction = useCallback(async (input: RequestInfo, init: RequestInit) => {
    const response = await fetch(input, init);
    if (response.ok) {
      const loaded = (await response.json()).queue ?? [];
      setQueue(loaded);
      queueRef.current = loaded;
    }
  }, []);

  const playNow = useCallback(
    async (itemId: string, targetTrackId: string) => {
      await queueAction(`/api/library/queue/${itemId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ position: 0 }),
      }).catch(() => undefined);
      goToTrack(targetTrackId);
    },
    [goToTrack, queueAction],
  );

  const addToQueue = useCallback(async () => {
    const response = await fetch("/api/library/queue", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ trackId, at: "end" }),
    });
    if (response.ok) {
      await refreshQueue();
      setStatus("Added to the queue.");
    } else {
      setStatus("Could not add to the queue.");
    }
  }, [refreshQueue, trackId]);

  // ----------------------------------------------------------------- render
  if (loadError !== null) {
    return (
      <section className="player-shell" aria-label="Track player">
        <p className="player-note" role="alert">{loadError}</p>
        <div className="player-actions">
          <Link className="button" href="/waveyard">Back to music</Link>
        </div>
      </section>
    );
  }

  if (track === null) {
    return (
      <section className="player-shell" aria-label="Track player">
        <p className="empty">Loading…</p>
      </section>
    );
  }

  const separated = track.playback.kind === "stems";
  const playableStems = track.stems.filter((stem) => assetIds.includes(stem.id));
  const stemChannels = separated
    ? playableStems.map((stem) => ({
        assetId: stem.id,
        stemType: stem.stemType,
        label: STEM_CHANNEL_LABELS[stem.stemType] ?? stem.stemType[0]?.toUpperCase() + stem.stemType.slice(1),
      }))
    : ["vocals", "drums", "bass", "other"].map((stemType) => ({
        assetId: "",
        stemType,
        label: STEM_CHANNEL_LABELS[stemType] ?? stemType,
      }));

  const currentQueueIndex = queue.findIndex((item) => item.track.id === track.id);
  const upcoming = currentQueueIndex >= 0 ? queue.slice(currentQueueIndex + 1) : queue;
  const hasPrevious = previousTrackFromQueue(queue.map((item) => ({ id: item.id, trackId: item.track.id })), track.id) !== null;
  const hasNext = upcoming.length > 0 || repeat === "all";

  const availabilityNote = separated
    ? null
    : track.stemAvailability.status === "processing"
      ? "Stems are separating in the background — playing the full source until they are ready."
      : track.stemAvailability.reason ?? "Playing the full, unseparated source.";

  return (
    <section className="player-shell p2" aria-label={`Player · ${track.title}`} data-testid="track-player">
      {/* Real audio elements — the transport drives the actual Web Audio graph. */}
      {assetIds.map((assetId, index) => (
        <audio
          key={assetId}
          aria-label={separated ? `${track.stems[index]?.stemType ?? "stem"} audio` : "full track audio"}
          ref={(element) => transport.register(assetId, element)}
          src={`/api/assets/${assetId}`}
          preload="auto"
          onEnded={index === 0 ? handleEnded : undefined}
        />
      ))}

      <header className="player-head">
        <div className="track-art big" aria-hidden="true"><span>{(track.artist || track.title).slice(0, 1).toUpperCase()}</span></div>
        <div className="wplayer-identity">
          <span className="eyebrow">Now playing</span>
          <h1>{track.title}</h1>
          <p className="player-sub">{track.artist || "Unknown artist"}{track.album ? ` · ${track.album}` : ""}</p>
          <p className="player-facts">
            {formatPlayClock(track.durationSeconds)}
            {track.analysis?.status === "complete" && track.analysis.bpm !== null ? ` · ${Math.round(track.analysis.bpm)} BPM` : ""}
            {track.analysis?.status === "complete" && track.analysis.musicalKey ? ` · ${track.analysis.musicalKey}` : ""}
            {` · ${track.source.codec.toUpperCase()} ${Math.round(track.source.sampleRate / 100) / 10}kHz`}
            {separated ? ` · ${track.stemAvailability.stemCount} stems` : ""}
          </p>
          {track.analysis !== null && track.analysis.status !== "complete" && (
            <p className="player-facts dim">Analysis still processing — tempo and key appear when it completes.</p>
          )}
        </div>
      </header>

      {availabilityNote !== null && <p className="player-note" role="note">{availabilityNote}</p>}
      {transport.error !== null && <p className="error" role="alert">{transport.error}</p>}

      {/* THE FOUR DOMINANT STEMS — real gain, real meters, honest states. */}
      <div className={`stem-deck ${separated ? "" : "source-only"}`} aria-label="Stem channels">
        {stemChannels.map((channel) => {
          const values = mix[channel.assetId] ?? { volume: 1, pan: 0, muted: false, solo: false };
          const meter = meters !== null ? meters[channel.assetId] : undefined;
          const anySolo = Object.values(mix).some((entry) => entry.solo);
          const active = separated && !(values.muted || (anySolo && !values.solo));
          return (
            <div
              key={channel.stemType}
              className={`stem-deck-channel ${active ? "active" : ""} ${meter?.clipped ? "clipping" : ""}`}
              data-testid={`stem-deck-${channel.stemType}`}
            >
              <b>{channel.label.toUpperCase()}</b>
              <div
                className="stem-meter"
                role="meter"
                aria-label={`${channel.label} level`}
                aria-valuenow={Math.round(meterLevel(meter) * 100)}
                aria-valuemin={0}
                aria-valuemax={100}
              >
                <span style={{ height: `${Math.round(meterLevel(meter) * 100)}%` }} />
              </div>
              <input
                aria-label={`${channel.label} volume`}
                type="range"
                min={0}
                max={2}
                step={0.01}
                value={values.volume}
                disabled={!separated}
                onChange={(event) => updateStem(channel.assetId, { volume: Number(event.target.value) })}
              />
              <div className="stem-deck-buttons">
                <button type="button" aria-pressed={values.muted} aria-label={`Mute ${channel.label}`} disabled={!separated} className={values.muted ? "active" : ""} onClick={() => updateStem(channel.assetId, { muted: !values.muted })}>MUTE</button>
                <button type="button" aria-pressed={values.solo} aria-label={`Isolate ${channel.label}`} disabled={!separated} className={values.solo ? "active" : ""} onClick={() => updateStem(channel.assetId, { solo: !values.solo })}>SOLO</button>
              </div>
              <small className="stem-db">{separated ? meterDb(meter) : "—"}</small>
            </div>
          );
        })}
      </div>

      <WaveformCanvas
        assetId={track.source.id}
        label={track.title}
        position={transport.position}
        duration={track.durationSeconds}
        onSeek={seek}
      />

      <div className="wplayer-transport">
        <button type="button" className="player-skip" aria-label="Previous track" disabled={!hasPrevious} onClick={skipPrevious}>◀◀</button>
        <button type="button" className="wplayer-play" onClick={() => (transport.playing ? transport.pause() : void transport.play())} aria-pressed={transport.playing}>
          {transport.playing ? "❚❚" : "▶"}
        </button>
        <button type="button" className="player-skip" aria-label="Next track" disabled={!hasNext} onClick={skipNext}>▶▶</button>
        <span className="player-clock">{formatPlayClock(transport.position)}</span>
        <input
          aria-label="Seek"
          type="range"
          min={0}
          max={Math.max(track.durationSeconds, 1)}
          step={0.5}
          value={Math.min(transport.position, track.durationSeconds)}
          onChange={(event) => seek(Number(event.target.value))}
        />
        <span className="player-clock">{formatPlayClock(track.durationSeconds)}</span>
        <div
          className="stem-meter master"
          role="meter"
          aria-label="Master level"
          aria-valuenow={Math.round(meterLevel(masterMeter ?? undefined) * 100)}
          aria-valuemin={0}
          aria-valuemax={100}
        >
          <span style={{ height: `${Math.round(meterLevel(masterMeter ?? undefined) * 100)}%` }} />
        </div>
        <button type="button" className={`player-mode ${repeat !== "off" ? "active" : ""}`} aria-pressed={repeat !== "off"} aria-label={`Repeat ${repeat}`} onClick={changeRepeat} title={`Repeat: ${repeat}`}>
          {repeat === "one" ? "↻¹" : "↻"}
        </button>
        <button type="button" className={`player-mode ${shuffle ? "active" : ""}`} aria-pressed={shuffle} aria-label="Shuffle" onClick={changeShuffle}>⤨</button>
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
        <button type="button" className={`player-mode ${queueOpen ? "active" : ""}`} aria-pressed={queueOpen} onClick={() => setQueueOpen((open) => !open)}>QUEUE {queue.length > 0 ? `(${queue.length})` : ""}</button>
      </div>

      <div className="player-actions">
        <button type="button" className="button" onClick={() => void addToQueue()}>+ Queue</button>
        <button type="button" className="button secondary" onClick={playAsSession} disabled={startingSession} title="Create a session starting with this track">
          {startingSession ? "Starting…" : "Play as session"}
        </button>
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

      {queueOpen && (
        <aside className="queue-drawer" aria-label="Play queue">
          <div className="library-panel-title">
            <h2>Queue</h2>
            {queue.length > 0 && (
              <button type="button" className="button secondary" onClick={() => void queueAction("/api/library/queue", { method: "DELETE" })}>Clear</button>
            )}
          </div>
          {queue.length === 0 ? (
            <p className="empty">The queue is empty — playback stops at the end of this track.</p>
          ) : (
            <ol className="queue-drawer-list">
              {queue.map((item, index) => (
                <li key={item.id} className={item.track.id === track.id ? "current" : ""}>
                  <button type="button" className="queue-drawer-play" aria-label={`Play ${item.track.title} now`} onClick={() => void playNow(item.id, item.track.id)}>▶</button>
                  <span className="queue-drawer-title">{item.track.title}<small>{item.track.artist || "Unknown artist"}</small></span>
                  <span className="playlist-item-actions">
                    <button type="button" aria-label="Move up" disabled={index === 0} onClick={() => void queueAction(`/api/library/queue/${item.id}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ position: index - 1 }) })}>↑</button>
                    <button type="button" aria-label="Move down" disabled={index === queue.length - 1} onClick={() => void queueAction(`/api/library/queue/${item.id}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ position: index + 1 }) })}>↓</button>
                    <button type="button" aria-label={`Remove ${item.track.title}`} onClick={() => void queueAction(`/api/library/queue/${item.id}`, { method: "DELETE" })}>×</button>
                  </span>
                </li>
              ))}
            </ol>
          )}
          {upcoming.length > 0 && (
            <p className="player-facts dim">Next up: {upcoming[0].track.title}</p>
          )}
        </aside>
      )}

      {/* P4: the real Stem2 hardware surface — output routing + honest caps. */}
      <Stem2Panel />
    </section>
  );
}
