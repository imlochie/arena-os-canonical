"use client";

import Link from "@/routing/Link";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useStemTransport, type ChannelMeter, type MixerValues } from "@workspace/arena/lib/waveyard/useStemTransport";
import { useHardwareMediaKeys } from "@workspace/arena/lib/waveyard/stem2";
import Stem2Panel from "@/components/waveyard/stem2/Stem2Panel";
import CamelotWheel from "./CamelotWheel";
import {
  beatAlignedTransitionStart,
  compatibilityEvidence,
  crossfadeCancel,
  crossfadeEnvelope,
  keyCompatibility,
  nextSessionTrack,
  tempoCompatibility,
  validateStemSwap,
  type TransitionConfig,
  type TransitionMode,
} from "@workspace/arena/lib/waveyard/library/session-logic";
import {
  publishWaveyardQueueChange,
  publishWaveyardTransportChange,
  subscribeToWaveyardQueueChanges,
  type WaveyardRemoteTransport,
} from "./queue-sync";

// ---------------------------------------------------------------------------
// Types mirrored from the session API payload.
// ---------------------------------------------------------------------------

interface SessionTrackItem {
  id: string;
  position: number;
  track: { id: string; title: string; artist: string; durationSeconds: number };
  stems: Array<{ id: string; stemType: string; engine: string }>;
  playback: { assetIds: string[]; kind: "stems" | "source" } | null;
  stemMix: Record<string, number>;
  transition: TransitionConfig;
  analysis: { bpm: number | null; musicalKey: string | null; beatGridMs: number[] | null } | null;
}

interface SessionDetail {
  id: string;
  name: string;
  currentSessionTrackId: string | null;
  positionSeconds: number;
  tracks: SessionTrackItem[];
  swaps: Array<{
    id: string;
    sessionTrackId: string;
    stemType: string;
    fromTrackId: string;
    toTrackId: string;
    atSeconds: number;
    createdAt: string;
    donorTrack?: { id: string; title: string; stems: Array<{ id: string; stemType: string }> } | null;
  }>;
  createdAt: string;
  updatedAt: string;
}

interface LibraryTrackOption {
  id: string;
  title: string;
  artist: string;
  stemAvailability?: { status: "separated" | "source-only" | "processing" | "unavailable" };
}

export type HostCommandKind = "play" | "load" | "next" | "enqueue" | "refresh";
export interface HostCommand {
  seq: number;
  kind: HostCommandKind;
  trackId: string;
  trackIds?: string[];
  queueItemIds?: string[];
}

type DeckApi = {
  transport: ReturnType<typeof useStemTransport>;
  hasStemChannels: boolean;
  applyStemVolumes: (volumes: Record<string, number>) => void;
};

type FadePhase = "idle" | "fading";
type StemFlags = { muted: string[]; solo: string[] };

const SAVE_INTERVAL_MS = 10_000;

function formatClock(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return "0:00";
  const whole = Math.floor(seconds);
  return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, "0")}`;
}

/** Level × mute × solo → the gain actually applied (and the value persisted as stemMix). */
function effectiveMix(item: SessionTrackItem | null, levels: Record<string, number> | undefined, flags: StemFlags | undefined) {
  const out: Record<string, number> = {};
  if (item === null) return out;
  const solo = flags?.solo ?? [];
  const muted = flags?.muted ?? [];
  for (const stem of item.stems) {
    let value = levels?.[stem.stemType] ?? 1;
    if (muted.includes(stem.stemType) || (solo.length > 0 && !solo.includes(stem.stemType))) value = 0;
    out[stem.stemType] = value;
  }
  return out;
}

// ---------------------------------------------------------------------------
// One physical deck. Rendered at a FIXED JSX position by deck index, so a
// role change (current ↔ next) never remounts audio elements or the graph.
// ---------------------------------------------------------------------------

function SessionDeck({
  deckIndex,
  item,
  active,
  startAt,
  swaps,
  masterLevel,
  autoPlay,
  onAutoPlayed,
  levels,
  flags,
  onLevel,
  onFlag,
  onReset,
  stemExtra,
  onApi,
  onPlaying,
  onProgress,
  onEnded,
}: {
  deckIndex: 0 | 1;
  item: SessionTrackItem | null;
  active: boolean;
  startAt: number;
  swaps: Record<string, string>;
  masterLevel: number;
  autoPlay: boolean;
  onAutoPlayed: () => void;
  levels: Record<string, number>;
  flags: StemFlags;
  onLevel: (stemType: string, value: number) => void;
  onFlag: (stemType: string, flag: "muted" | "solo") => void;
  onReset: () => void;
  stemExtra?: (stemType: string) => ReactNode;
  onApi: (deckIndex: number, api: DeckApi | null) => void;
  onPlaying: (deckIndex: number, playing: boolean) => void;
  onProgress: (deckIndex: number, position: number) => void;
  onEnded: (deckIndex: number, itemId: string) => void;
}) {
  const assetIds = useMemo(() => item?.playback?.assetIds ?? [], [item?.playback]);
  const duration = item?.track.durationSeconds ?? 0;
  const transport = useStemTransport(assetIds, duration);
  const mediaElements = useRef<Record<string, HTMLAudioElement | null>>({});
  const [mediaError, setMediaError] = useState<string | null>(null);
  const [loadingLayers, setLoadingLayers] = useState(false);
  const [swapRetry, setSwapRetry] = useState(0);

  const stemTypeByAsset = useMemo(() => {
    const map = new Map<string, string>();
    for (const stem of item?.stems ?? []) map.set(stem.id, stem.stemType);
    return map;
  }, [item?.stems]);

  const swapKey = JSON.stringify(assetIds.map((id) => [id, swaps[stemTypeByAsset.get(id) ?? "source"] ?? null]));
  useEffect(() => {
    let stale = false;
    const layers = JSON.parse(swapKey) as Array<[string, string | null]>;
    setLoadingLayers(layers.some(([, donor]) => donor !== null));
    void Promise.all(layers.map(([id, donor]) => transport.replaceStem(id, donor ? `/api/assets/${donor}` : null)))
      .then(() => { if (!stale) setMediaError(null); })
      .catch((error: unknown) => {
        if (!stale) setMediaError(`${error instanceof Error ? error.message : "Live stem loading failed."} The previous layer was kept.`);
      })
      .finally(() => { if (!stale) setLoadingLayers(false); });
    return () => { stale = true; };
  }, [swapKey, transport.replaceStem, swapRetry]);

  const applyStemVolumes = useCallback(
    (volumes: Record<string, number>) => {
      const values: Record<string, MixerValues> = {};
      for (const stem of item?.stems ?? []) {
        values[stem.id] = { volume: volumes[stem.stemType] ?? 1, pan: 0, muted: false, solo: false };
      }
      transport.applyMix(values);
    },
    [item?.stems, transport],
  );

  useEffect(() => {
    onApi(deckIndex, {
      transport,
      applyStemVolumes,
      hasStemChannels: item?.playback?.kind === "stems" && (item?.stems ?? []).some((stem) => assetIds.includes(stem.id)),
    });
  }, [deckIndex, transport, applyStemVolumes, onApi]);
  useEffect(() => () => onApi(deckIndex, null), [deckIndex, onApi]);

  useEffect(() => {
    onPlaying(deckIndex, transport.playing);
  }, [deckIndex, transport.playing, onPlaying]);
  useEffect(() => {
    onProgress(deckIndex, transport.position);
  }, [deckIndex, transport.position, onProgress]);

  const startAtRef = useRef(startAt);
  startAtRef.current = startAt;
  const masterRef = useRef(masterLevel);
  masterRef.current = masterLevel;
  const autoPlayRef = useRef(autoPlay);
  autoPlayRef.current = autoPlay;
  const onAutoPlayedRef = useRef(onAutoPlayed);
  onAutoPlayedRef.current = onAutoPlayed;

  const loadedItemId = useRef<string | null>(null);
  const loadKey = item === null ? null : `${item.id}:${assetIds.join(",")}`;
  useEffect(() => {
    if (item === null) {
      loadedItemId.current = null;
      return;
    }
    if (loadedItemId.current === loadKey) return;
    loadedItemId.current = loadKey;
    transport.pause();
    transport.setMasterVolume(masterRef.current);
    transport.seek(Math.max(0, Math.min(startAtRef.current, item.track.durationSeconds)));
    if (autoPlayRef.current) {
      onAutoPlayedRef.current();
      void transport.play();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- run only when this deck's track or its asset set changes
  }, [loadKey]);

  // Real meters while this deck is playing (both decks during a fade).
  const [meters, setMeters] = useState<Record<string, ChannelMeter> | null>(null);
  useEffect(() => {
    if (!transport.playing) {
      const idleId = requestAnimationFrame(() => setMeters(null));
      return () => cancelAnimationFrame(idleId);
    }
    let rafId = 0;
    let last = 0;
    const tick = (now: number) => {
      if (now - last > 60) {
        last = now;
        setMeters(transport.readMeters().channels);
      }
      rafId = requestAnimationFrame(tick);
    };
    rafId = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(rafId);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- readMeters is stable; bind to play state
  }, [transport.playing]);

  const separated = item?.playback?.kind === "stems" && (item?.stems.length ?? 0) > 0;
  const anySolo = flags.solo.length > 0;
  const mixChanged = (item?.stems ?? []).some((stem) => Math.abs((levels[stem.stemType] ?? 1) - 1) > 0.001)
    || flags.muted.length > 0
    || anySolo;

  return (
    <section
      className={`sess-deck wy-deck${active ? " sess-deck-active" : ""}`}
      style={{ order: active ? 1 : 3 }}
      aria-label={`Deck ${deckIndex === 0 ? "A" : "B"} · ${active ? "current" : "next"} · ${item?.track.title ?? "empty"}`}
      data-testid={`session-deck-${deckIndex === 0 ? "a" : "b"}`}
      data-role={active ? "current" : "next"}
    >
      {assetIds.map((assetId) => {
        const stemType = stemTypeByAsset.get(assetId) ?? "source";
        const donorAssetId = swaps[stemType];
        return (
          <audio
            key={assetId}
            aria-label={`${stemType} audio${donorAssetId ? " (swapped layer)" : ""}`}
            ref={(element) => {
              mediaElements.current[assetId] = element;
              transport.register(assetId, element);
            }}
            src={`/api/assets/${assetId}`}
            preload="auto"
            onLoadedMetadata={(event) => {
              // Replacing a playing element's src (Swap/Undo) resets its
              // clock and pauses it. Join the running deck, not donor time 0.
              const element = event.currentTarget;
              const anchor = Object.values(mediaElements.current).find(
                (peer) => peer && peer !== element && !peer.paused && !peer.ended,
              );
              const at = anchor?.currentTime ?? transport.position;
              element.currentTime = Math.min(at, Math.max(0, element.duration - 0.01));
              if (transport.playing && !element.ended) {
                void element.play().then(() => setMediaError(null)).catch(() => {
                  setMediaError("The replacement stem could not resume. Pause and play to retry.");
                });
              }
            }}
            onError={() => setMediaError("An audio asset could not load. Check the connection and try playback again.")}
            onEnded={(event) => {
              // A shorter donor stem must not finish the entire recipient song.
              if (item !== null && event.currentTarget.currentTime >= duration - 0.1) onEnded(deckIndex, item.id);
            }}
          />
        );
      })}
      {loadingLayers && <p className="wy-deck-note" role="status">Preparing live layers — the current audio keeps playing.</p>}
      {mediaError && <button type="button" className="sess-small-btn" onClick={() => setSwapRetry((n) => n + 1)}>Retry live stems</button>}
      {item === null ? (
        <div className="wy-deck-empty">
          <span className="eyebrow">{`Deck ${deckIndex === 0 ? "A" : "B"} · ${active ? "current" : "next"}`}</span>
          <p>{active ? "Nothing loaded." : "Free. Press Next on a song in the library to line it up here."}</p>
        </div>
      ) : (
        <>
          <div className="sess-deck-head">
            <span className="eyebrow">{`Deck ${deckIndex === 0 ? "A" : "B"} · ${active ? "current" : "next"}`}</span>
            <h3>{item.track.title}</h3>
            <p className="sess-deck-sub">
              {item.track.artist || "Unknown artist"}
              {item.analysis?.bpm != null ? ` · ${Math.round(item.analysis.bpm)} BPM` : ""}
              {item.analysis?.musicalKey ? ` · ${item.analysis.musicalKey}` : ""}
              {item.analysis === null ? " · analysis pending" : ""}
            </p>
          </div>
          {(transport.error || mediaError) && <p role="alert" className="sess-status">{mediaError ?? transport.error}</p>}
          <div className="wy-deck-seek">
            <span>{formatClock(transport.position)}</span>
            <input
              type="range"
              aria-label={`Seek ${active ? "current" : "next"} deck`}
              min={0}
              max={Math.max(duration, 1)}
              step={0.5}
              value={Math.min(transport.position, duration)}
              onChange={(event) => transport.seek(Number(event.target.value))}
              data-testid={`seek-deck-${deckIndex}`}
            />
            <span>{formatClock(duration)}</span>
          </div>
          {!active && <p className="wy-deck-note">Seeking here only previews the cue; a beat/bar transition re-cues from the grid.</p>}
          {!separated ? (
            <p className="wy-deck-note">Full source — stem controls unlock once separation finishes.</p>
          ) : (
            <div className="wy-stems" role="group" aria-label={`${active ? "Current" : "Next"} deck stems`}>
              {active && <p className="wy-deck-note wy-live-note">Live swaps stay on this song&rsquo;s clock · shorter layers loop; use the Camelot wheel to cue compatible tracks.</p>}
              {mixChanged && (
                <div className="wy-stem-toolbar">
                  <span role="status">
                    {anySolo ? `Isolating ${flags.solo.join(", ")}` : flags.muted.length > 0 ? `Muted ${flags.muted.join(", ")}` : "Stem levels adjusted"}
                  </span>
                  <button
                    type="button"
                    className="wy-stem-reset"
                    aria-label={`Restore all ${active ? "current" : "next"} stems`}
                    onClick={onReset}
                  >
                    Restore all
                  </button>
                </div>
              )}
              {item.stems.map((stem) => {
                const level = levels[stem.stemType] ?? 1;
                const muted = flags.muted.includes(stem.stemType);
                const solo = flags.solo.includes(stem.stemType);
                const silent = muted || (anySolo && !solo);
                const peak = meters?.[stem.id]?.peak ?? 0;
                return (
                  <div key={stem.id} className={`wy-stem wy-stem-${stem.stemType}${silent ? " silent" : ""}`}>
                    <span className="wy-stem-name">{stem.stemType}{swaps[stem.stemType] ? " · swapped" : ""}</span>
                    <span className="wy-stem-meter" aria-hidden="true">
                      <i style={{ transform: `scaleX(${Math.min(1, peak)})` }} />
                    </span>
                    <input
                      type="range"
                      min={0}
                      max={2}
                      step={0.01}
                      value={level}
                      aria-label={`${stem.stemType} level, ${active ? "current" : "next"} deck`}
                      onChange={(event) => onLevel(stem.stemType, Number(event.target.value))}
                    />
                    <span className="wy-stem-value">{level.toFixed(2)}</span>
                    <button type="button" className={`wy-toggle${muted ? " on" : ""}`} aria-pressed={muted} aria-label={`Mute ${stem.stemType}`} onClick={() => onFlag(stem.stemType, "muted")}>Mute</button>
                    <button type="button" className={`wy-toggle solo${solo ? " on" : ""}`} aria-pressed={solo} aria-label={`Isolate ${stem.stemType}`} onClick={() => onFlag(stem.stemType, "solo")}>Isolate</button>
                    {stemExtra?.(stem.stemType)}
                  </div>
                );
              })}
            </div>
          )}
        </>
      )}
    </section>
  );
}

// ---------------------------------------------------------------------------
// The session controller above two physical decks.
// ---------------------------------------------------------------------------

export default function SessionExperience({
  sessionId,
  variant = "full",
  command = null,
  onMissing,
}: {
  sessionId: string;
  variant?: "full" | "compact";
  command?: HostCommand | null;
  onMissing?: () => void;
}) {
  const [session, setSession] = useState<SessionDetail | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [library, setLibrary] = useState<LibraryTrackOption[]>([]);
  const [addTrackId, setAddTrackId] = useState("");
  const [status, setStatus] = useState<string | null>(null);
  const [saveState, setSaveState] = useState<"saved" | "saving" | "error">("saved");
  const [mixSaveError, setMixSaveError] = useState(false);
  const [handoff, setHandoff] = useState<{ projectId: string; remixTrackCount: number; refused?: Array<{ title: string; reason: string }> } | null>(null);

  const [currentId, setCurrentId] = useState<string | null>(null);
  const [activeDeck, setActiveDeck] = useState<0 | 1>(0);
  const [phase, setPhase] = useState<FadePhase>("idle");
  const [savingSwap, setSavingSwap] = useState(false);
  const [mixes, setMixes] = useState<Record<string, Record<string, number>>>({});
  const [flags, setFlags] = useState<Record<string, StemFlags>>({});
  const [transitions, setTransitions] = useState<Record<string, TransitionConfig>>({});
  const [masterLevel, setMasterLevel] = useState(1);
  const [autoPlayId, setAutoPlayId] = useState<string | null>(null);
  const [autoCrossfadeEnabled, setAutoCrossfadeEnabled] = useState(() => {
    try {
      return typeof window !== "undefined" && window.localStorage.getItem("waveyard:auto-crossfade") === "on";
    } catch {
      return false;
    }
  });
  const [positions, setPositions] = useState<[number, number]>([0, 0]);
  const [remoteTransport, setRemoteTransport] = useState<WaveyardRemoteTransport | null>(null);
  /** Items whose stems finished while their source was audible: held until the user switches. */
  const [stemsReady, setStemsReady] = useState<Record<string, SessionTrackItem>>({});
  const [resumeAt, setResumeAt] = useState<{ itemId: string; seconds: number } | null>(null);

  const decksRef = useRef<Array<DeckApi | null>>([null, null]);
  const fadeRef = useRef<{ raf: number; t0: number; fromDeck: 0 | 1; toDeck: 0 | 1; cfg: TransitionConfig; fromMix: Record<string, number> } | null>(null);
  const advancingRef = useRef(false);
  const [playingByDeck, setPlayingByDeck] = useState<[boolean, boolean]>([false, false]);
  const sessionRef = useRef<SessionDetail | null>(null);
  const currentIdRef = useRef<string | null>(null);
  const autoCrossfadeStartedForRef = useRef<string | null>(null);
  const activeDeckRef = useRef<0 | 1>(0);
  const masterRef = useRef(1);
  const playingRef = useRef(false);
  const remoteTransportRef = useRef<WaveyardRemoteTransport | null>(null);
  const transportOrderRef = useRef<{
    clock: number;
    sender: string;
    priority: "control" | "heartbeat";
    updatedAt: number;
  } | null>(null);
  const applyingRemoteTransportRef = useRef(false);
  const remoteApplyTimerRef = useRef<number | null>(null);
  const lastProgressBroadcastAtRef = useRef(0);
  const lastReportedPlayingRef = useRef<[boolean | null, boolean | null]>([null, null]);
  useEffect(() => { sessionRef.current = session; }, [session]);
  useEffect(() => { currentIdRef.current = currentId; }, [currentId]);
  useEffect(() => { activeDeckRef.current = activeDeck; }, [activeDeck]);
  useEffect(() => { masterRef.current = masterLevel; }, [masterLevel]);
  useEffect(() => { playingRef.current = playingByDeck[activeDeck]; }, [playingByDeck, activeDeck]);
  useEffect(() => {
    try {
      window.localStorage.setItem("waveyard:auto-crossfade", autoCrossfadeEnabled ? "on" : "off");
    } catch {
      // The control remains usable for this session when browser storage is unavailable.
    }
  }, [autoCrossfadeEnabled]);

  const currentIndex = useMemo(() => {
    if (session === null) return -1;
    if (currentId !== null) {
      const idx = session.tracks.findIndex((item) => item.id === currentId);
      if (idx !== -1) return idx;
    }
    return session.tracks.length > 0 ? 0 : -1;
  }, [session, currentId]);

  const currentItem = currentIndex >= 0 ? session?.tracks[currentIndex] ?? null : null;
  const nextItem = currentIndex >= 0 ? session?.tracks[currentIndex + 1] ?? null : null;
  const previousItem = currentIndex > 0 ? session?.tracks[currentIndex - 1] ?? null : null;
  const standbyDeckIndex: 0 | 1 = activeDeck === 0 ? 1 : 0;
  const currentTransition = currentItem ? transitions[currentItem.id] ?? currentItem.transition : null;

  // ------------------------------------------------------------ persistence
  const persistState = useCallback(async (override?: { id?: string | null; position?: number }) => {
    const s = sessionRef.current;
    if (s === null) return;
    const id = override?.id !== undefined ? override.id : currentIdRef.current;
    const raw = override?.position ?? decksRef.current[activeDeckRef.current]?.transport.position ?? 0;
    setSaveState("saving");
    try {
      const response = await fetch(`/api/library/sessions/${s.id}/state`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ currentSessionTrackId: id, positionSeconds: Math.max(0, Number.isFinite(raw) ? raw : 0) }),
        keepalive: true,
      });
      setSaveState(response.ok ? "saved" : "error");
    } catch {
      setSaveState("error");
    }
  }, []);

  // ------------------------------------------------------------------- load
  useEffect(() => {
    let cancelled = false;
    const timer = setTimeout(() => {
      void (async () => {
        setLoadError(null);
        try {
          const [sessionResponse, libraryResponse] = await Promise.all([
            fetch(`/api/library/sessions/${sessionId}`, { cache: "no-store" }),
            fetch("/api/library/tracks", { cache: "no-store" }),
          ]);
          if (cancelled) return;
          if (sessionResponse.status === 404) {
            setLoadError("That session no longer exists.");
            onMissing?.();
            return;
          }
          if (!sessionResponse.ok) {
            setLoadError("The session could not be loaded right now.");
            return;
          }
          const detail = (await sessionResponse.json()).session as SessionDetail;
          if (cancelled) return;
          const restoredCurrent =
            detail.currentSessionTrackId !== null && detail.tracks.some((item) => item.id === detail.currentSessionTrackId)
              ? detail.currentSessionTrackId
              : (detail.tracks[0]?.id ?? null);
          const nextMixes: Record<string, Record<string, number>> = {};
          const nextTransitions: Record<string, TransitionConfig> = {};
          for (const item of detail.tracks) {
            nextMixes[item.id] = { ...item.stemMix };
            nextTransitions[item.id] = item.transition;
          }
          currentIdRef.current = restoredCurrent;
          sessionRef.current = detail;
          setMixes(nextMixes);
          setFlags({});
          setStemsReady({});
          setTransitions(nextTransitions);
          setCurrentId(restoredCurrent);
          setSession(detail);
          if (libraryResponse.ok) {
            const tracks = ((await libraryResponse.json()).tracks ?? []) as LibraryTrackOption[];
            if (!cancelled) setLibrary(tracks);
          }
        } catch {
          if (!cancelled) setLoadError("The session could not be loaded — check the connection and retry.");
        }
      })();
    }, 0);
    return () => {
      cancelled = true;
      clearTimeout(timer);
      // Leaving this session (switch or unmount): save where we were.
      if (sessionRef.current?.id === sessionId) void persistState();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- reload per session id only
  }, [sessionId]);

  const [reloadNonce, setReloadNonce] = useState(0);
  useEffect(() => {
    if (reloadNonce === 0) return;
    const timer = setTimeout(() => {
      void (async () => {
        try {
          const response = await fetch(`/api/library/sessions/${sessionId}`, { cache: "no-store" });
          if (!response.ok) throw new Error();
          const detail = (await response.json()).session as SessionDetail;
          if (detail.id !== sessionId) return;
          sessionRef.current = detail;
          setSession(detail);
          setLoadError(null);
        } catch {
          setLoadError("Still unreachable. Try again in a moment.");
        }
      })();
    }, 0);
    return () => clearTimeout(timer);
  }, [reloadNonce, sessionId]);

  // Interval save while playing, plus pause/pagehide/hidden saves.
  useEffect(() => {
    const interval = window.setInterval(() => {
      if (playingRef.current) void persistState();
    }, SAVE_INTERVAL_MS);
    const onHide = () => void persistState();
    const onVisibility = () => {
      if (document.visibilityState === "hidden") void persistState();
    };
    window.addEventListener("pagehide", onHide);
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      window.clearInterval(interval);
      window.removeEventListener("pagehide", onHide);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [persistState]);

  // Deck assignment: stable deck index identity; only items move between decks.
  const deckItems = useMemo<[SessionTrackItem | null, SessionTrackItem | null]>(
    () => (activeDeck === 0 ? [currentItem, nextItem] : [nextItem, currentItem]),
    [activeDeck, currentItem, nextItem],
  );

  const startAtFor = (deckIndex: 0 | 1): number => {
    const item = deckItems[deckIndex];
    if (item !== null && resumeAt !== null && resumeAt.itemId === item.id) return resumeAt.seconds;
    if (item !== null && session !== null && item.id === session.currentSessionTrackId && deckIndex === activeDeck) {
      return session.positionSeconds;
    }
    return 0;
  };

  const activeSwaps = useMemo(() => {
    const map: Record<string, string> = {};
    if (session === null || currentItem === null) return map;
    for (const swap of session.swaps) {
      if (swap.sessionTrackId !== currentItem.id) continue;
      const donor = session.tracks.find((t) => t.track.id === swap.toTrackId);
      const donorStem = donor?.stems.find((s) => s.stemType === swap.stemType)
        ?? swap.donorTrack?.stems.find((s) => s.stemType === swap.stemType);
      if (donorStem) map[swap.stemType] = donorStem.id;
    }
    return map;
  }, [session, currentItem]);

  const publishTransport = useCallback((snapshot: {
    trackId: string | null;
    positionSeconds: number;
    playing: boolean;
    action: "state" | "seek";
    priority?: "control" | "heartbeat";
  }) => {
    if (applyingRemoteTransportRef.current) return null;
    const published = publishWaveyardTransportChange({
      sessionId,
      ...snapshot,
      priority: snapshot.priority ?? "control",
    });
    if (published !== null && published.priority === "control") {
      transportOrderRef.current = {
        clock: published.clock,
        sender: published.sender,
        priority: published.priority,
        updatedAt: published.updatedAt,
      };
    }
    return published;
  }, [sessionId]);

  const clearRemoteTransport = useCallback(() => {
    remoteTransportRef.current = null;
    setRemoteTransport(null);
  }, []);

  const handleDeckApi = useCallback((deckIndex: number, api: DeckApi | null) => {
    decksRef.current[deckIndex] = api;
  }, []);
  const handleDeckPlaying = useCallback((deckIndex: number, playing: boolean) => {
    const previousReported = lastReportedPlayingRef.current[deckIndex];
    lastReportedPlayingRef.current[deckIndex] = playing;
    setPlayingByDeck((prev) => {
      if (prev[deckIndex] === playing) return prev;
      const next: [boolean, boolean] = [prev[0], prev[1]];
      next[deckIndex] = playing;
      return next;
    });
    if (
      previousReported !== null
      && previousReported !== playing
      && deckIndex === activeDeckRef.current
      && !applyingRemoteTransportRef.current
    ) {
      clearRemoteTransport();
      publishTransport({
        trackId: currentIdRef.current,
        positionSeconds: decksRef.current[deckIndex]?.transport.position ?? 0,
        playing,
        action: "state",
      });
    }
  }, [clearRemoteTransport, publishTransport]);
  const handleDeckProgress = useCallback((deckIndex: number, position: number) => {
    setPositions((prev) => {
      if (Math.abs(prev[deckIndex] - position) < 0.25) return prev;
      const next: [number, number] = [prev[0], prev[1]];
      next[deckIndex] = position;
      return next;
    });
    const api = decksRef.current[deckIndex];
    const now = Date.now();
    if (
      deckIndex === activeDeckRef.current
      && api?.transport.playing
      && !applyingRemoteTransportRef.current
      && now - lastProgressBroadcastAtRef.current >= 900
    ) {
      lastProgressBroadcastAtRef.current = now;
      clearRemoteTransport();
      publishTransport({ trackId: currentIdRef.current, positionSeconds: position, playing: true, action: "state", priority: "heartbeat" });
    }
  }, [clearRemoteTransport, publishTransport]);

  // Debounced mix + transition persistence for BOTH loaded items.
  const lastSentRef = useRef<Record<string, string>>({});
  useEffect(() => {
    if (session === null) return;
    const items = [currentItem, nextItem].filter((item): item is SessionTrackItem => item !== null);
    const timer = setTimeout(() => {
      void (async () => {
        let failed = false;
        for (const item of items) {
          const body = JSON.stringify({
            stemMix: effectiveMix(item, mixes[item.id] ?? item.stemMix, flags[item.id]),
            transition: transitions[item.id] ?? item.transition,
          });
          const key = `${session.id}:${item.id}`;
          if (lastSentRef.current[key] === undefined) {
            // First sight of this item: what's on the server is the baseline.
            lastSentRef.current[key] = JSON.stringify({ stemMix: effectiveMix(item, item.stemMix, undefined), transition: item.transition });
          }
          if (lastSentRef.current[key] === body) continue;
          try {
            const response = await fetch(`/api/library/sessions/${session.id}/tracks/${item.id}`, {
              method: "PATCH",
              headers: { "content-type": "application/json" },
              body,
            });
            if (response.ok) lastSentRef.current[key] = body;
            else failed = true;
          } catch {
            failed = true;
          }
        }
        setMixSaveError(failed);
      })();
    }, 600);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- debounce on control changes for the loaded pair
  }, [session?.id, currentItem?.id, nextItem?.id, mixes, flags, transitions]);

  // Apply effective mixes to the physical decks.
  const currentEffective = useMemo(() => effectiveMix(currentItem, currentItem ? mixes[currentItem.id] : undefined, currentItem ? flags[currentItem.id] : undefined), [currentItem, mixes, flags]);
  const nextEffective = useMemo(() => effectiveMix(nextItem, nextItem ? mixes[nextItem.id] : undefined, nextItem ? flags[nextItem.id] : undefined), [nextItem, mixes, flags]);
  useEffect(() => {
    if (fadeRef.current !== null) return;
    decksRef.current[activeDeck]?.applyStemVolumes(currentEffective);
  }, [currentEffective, activeDeck, currentItem?.id]);
  useEffect(() => {
    decksRef.current[standbyDeckIndex]?.applyStemVolumes(nextEffective);
  }, [nextEffective, standbyDeckIndex, nextItem?.id]);

  // Master level drives both decks outside a fade (the fade multiplies by it).
  useEffect(() => {
    if (fadeRef.current !== null) return;
    decksRef.current[0]?.transport.setMasterVolume(masterLevel);
    decksRef.current[1]?.transport.setMasterVolume(masterLevel);
  }, [masterLevel]);

  // -------------------------------------------------------- transition core
  const finishTransition = useCallback(() => {
    const fade = fadeRef.current;
    if (fade === null || advancingRef.current) return;
    advancingRef.current = true;
    cancelAnimationFrame(fade.raf);
    fadeRef.current = null;
    const fromApi = decksRef.current[fade.fromDeck];
    const toApi = decksRef.current[fade.toDeck];
    fromApi?.transport.pause();
    fromApi?.transport.setMasterVolume(masterRef.current);
    toApi?.transport.setMasterVolume(masterRef.current);
    setPhase("idle");
    const s = sessionRef.current;
    if (s !== null) {
      const decision = nextSessionTrack(
        s.tracks.map((item) => ({ id: item.id, trackId: item.track.id })),
        currentIdRef.current,
      );
      if (decision.action === "play") {
        currentIdRef.current = decision.sessionTrackId;
        activeDeckRef.current = fade.toDeck;
        setCurrentId(decision.sessionTrackId);
        setActiveDeck(fade.toDeck);
        clearRemoteTransport();
        publishTransport({
          trackId: decision.sessionTrackId,
          positionSeconds: toApi?.transport.position ?? 0,
          playing: true,
          action: "state",
        });
      }
    }
    setStatus("Transition complete.");
    void persistState();
  }, [persistState, clearRemoteTransport, publishTransport]);

  const runFade = useCallback(
    (cfg: TransitionConfig, fromDeck: 0 | 1, toDeck: 0 | 1, fromMix: Record<string, number>) => {
      const t0 = performance.now();
      const tick = () => {
        const fade = fadeRef.current;
        if (fade === null) return;
        const env = crossfadeEnvelope((performance.now() - t0) / 1000, cfg.crossfadeSeconds);
        const kept = new Set(cfg.keepStems);
        const scaled: Record<string, number> = {};
        for (const [type, volume] of Object.entries(fromMix)) scaled[type] = kept.has(type) ? volume : volume * env.fromGain;
        const outgoing = decksRef.current[fromDeck];
        if (outgoing?.hasStemChannels) outgoing.applyStemVolumes(scaled);
        else outgoing?.transport.setMasterVolume(env.fromGain * masterRef.current);
        decksRef.current[toDeck]?.transport.setMasterVolume(env.toGain * masterRef.current);
        if (env.done) {
          finishTransition();
          return;
        }
        fade.raf = requestAnimationFrame(tick);
      };
      fadeRef.current = { raf: 0, t0, fromDeck, toDeck, cfg, fromMix };
      fadeRef.current.raf = requestAnimationFrame(tick);
      setPhase("fading");
    },
    [finishTransition],
  );

  const beginTransition = useCallback(async () => {
    if (phase === "fading") return;
    const fromDeck = activeDeck;
    const toDeck = standbyDeckIndex;
    const fromApi = decksRef.current[fromDeck];
    const toApi = decksRef.current[toDeck];
    const fromItem = deckItems[fromDeck];
    const toItem = deckItems[toDeck];
    if (fromApi === null || fromItem === null) {
      setStatus("Nothing is loaded in the current deck.");
      return;
    }
    if (toApi === null || toItem === null) {
      setStatus("The next deck is empty — press Next on a song in the library.");
      return;
    }
    const cfg = transitions[fromItem.id] ?? fromItem.transition;
    advancingRef.current = false;

    let startInCurrent = fromApi.transport.position;
    let incomingOffset = 0;
    if (cfg.mode === "beat" || cfg.mode === "bar") {
      const aligned = beatAlignedTransitionStart(fromItem.analysis?.beatGridMs ?? null, toItem.analysis?.beatGridMs ?? null, startInCurrent * 1000, cfg.mode);
      if (!aligned.ok) {
        setStatus(aligned.reason);
        return;
      }
      startInCurrent = (aligned.startInCurrentMs ?? 0) / 1000;
      incomingOffset = (aligned.incomingOffsetMs ?? 0) / 1000;
      setStatus(`${aligned.reason} Fading ${cfg.crossfadeSeconds}s from ${formatClock(startInCurrent)}.`);
    } else if (cfg.mode === "meeting-point") {
      setStatus("Meeting-point is stored; V1 crossfades from the current position.");
    } else {
      setStatus(`Crossfade ${cfg.crossfadeSeconds}s from ${formatClock(startInCurrent)}.`);
    }

    fromApi.transport.seek(startInCurrent);
    await fromApi.transport.play();
    toApi.transport.seek(incomingOffset);
    if (cfg.crossfadeSeconds <= 0) {
      toApi.transport.setMasterVolume(masterRef.current);
      await toApi.transport.play();
      fromApi.transport.pause();
      fadeRef.current = { raf: 0, t0: performance.now(), fromDeck, toDeck, cfg, fromMix: {} };
      finishTransition();
      return;
    }
    toApi.transport.setMasterVolume(0);
    await toApi.transport.play();
    runFade(cfg, fromDeck, toDeck, { ...currentEffective });
  }, [phase, activeDeck, standbyDeckIndex, deckItems, transitions, runFade, finishTransition, currentEffective]);

  const cancelTransition = useCallback(() => {
    const fade = fadeRef.current;
    if (fade === null) return;
    cancelAnimationFrame(fade.raf);
    const frozen = crossfadeCancel((performance.now() - fade.t0) / 1000, fade.cfg.crossfadeSeconds);
    const kept = new Set(fade.cfg.keepStems);
    const scaled: Record<string, number> = {};
    for (const [type, volume] of Object.entries(fade.fromMix)) scaled[type] = kept.has(type) ? volume : volume * frozen.fromGain;
    const outgoing = decksRef.current[fade.fromDeck];
    if (outgoing?.hasStemChannels) outgoing.applyStemVolumes(scaled);
    else outgoing?.transport.setMasterVolume(frozen.fromGain * masterRef.current);
    decksRef.current[fade.toDeck]?.transport.setMasterVolume(frozen.toGain * masterRef.current);
    fadeRef.current = null;
    setPhase("idle");
    setStatus("Transition frozen — both decks hold their levels.");
  }, []);

  const abortTransition = useCallback((message: string) => {
    const fade = fadeRef.current;
    if (fade === null) return;
    cancelAnimationFrame(fade.raf);
    const outgoing = decksRef.current[fade.fromDeck];
    const incoming = decksRef.current[fade.toDeck];
    incoming?.transport.pause();
    incoming?.transport.setMasterVolume(masterRef.current);
    outgoing?.transport.setMasterVolume(masterRef.current);
    if (outgoing?.hasStemChannels) outgoing.applyStemVolumes(currentEffective);
    fadeRef.current = null;
    advancingRef.current = false;
    setPhase("idle");
    setStatus(message);
  }, [currentEffective]);

  const togglePlay = useCallback(async () => {
    if (phase === "fading") cancelTransition();
    const api = decksRef.current[activeDeck];
    if (api === null) return;
    const remote = remoteTransportRef.current;
    if (!api.transport.playing && remote?.sessionId === sessionId && remote.playing) {
      const paused = publishTransport({
        trackId: remote.trackId,
        positionSeconds: remote.positionSeconds,
        playing: false,
        action: "state",
      });
      if (paused !== null) {
        remoteTransportRef.current = paused;
        setRemoteTransport(paused);
      }
      return;
    }
    if (api.transport.playing) {
      clearRemoteTransport();
      api.transport.pause();
      void persistState();
    } else {
      clearRemoteTransport();
      await api.transport.play();
    }
  }, [activeDeck, phase, cancelTransition, persistState, sessionId, publishTransport, clearRemoteTransport]);

  const handleDeckEnded = useCallback(
    (deckIndex: number, itemId: string) => {
      // Each stem element fires ended; only the first, for the current item, counts.
      if (fadeRef.current !== null || itemId !== currentIdRef.current || deckIndex !== activeDeckRef.current) return;
      decksRef.current[deckIndex]?.transport.pause();
      const s = sessionRef.current;
      if (s === null) return;
      const decision = nextSessionTrack(s.tracks.map((item) => ({ id: item.id, trackId: item.track.id })), currentIdRef.current);
      if (decision.action === "play") {
        const toDeck: 0 | 1 = deckIndex === 0 ? 1 : 0;
        currentIdRef.current = decision.sessionTrackId;
        activeDeckRef.current = toDeck;
        setCurrentId(decision.sessionTrackId);
        setActiveDeck(toDeck);
        const toApi = decksRef.current[toDeck];
        if (toApi) {
          toApi.transport.setMasterVolume(masterRef.current);
          void toApi.transport.play();
        }
        clearRemoteTransport();
        publishTransport({
          trackId: decision.sessionTrackId,
          positionSeconds: toApi?.transport.position ?? 0,
          playing: true,
          action: "state",
        });
        setStatus("Track finished — the next deck took over.");
        void persistState({ id: decision.sessionTrackId, position: 0 });
      } else {
        setStatus(decision.reason === "empty-session" ? "This session has no tracks yet." : "End of session.");
        void persistState();
      }
    },
    [persistState, clearRemoteTransport, publishTransport],
  );

  // ----------------------------------------------------------- queue edits
  const mutate = useCallback(async (input: RequestInfo, init: RequestInit): Promise<SessionDetail | null> => {
    try {
      const response = await fetch(input, init);
      if (!response.ok) {
        const body = (await response.json().catch(() => null)) as { error?: string } | null;
        setStatus(body?.error ?? "The session change was rejected.");
        return null;
      }
      const detail = (await response.json()).session as SessionDetail;
      if (sessionRef.current !== null && sessionRef.current.id !== detail.id) return null;
      setMixes((prev) => {
        const next = { ...prev };
        for (const item of detail.tracks) if (!(item.id in next)) next[item.id] = { ...item.stemMix };
        return next;
      });
      setTransitions((prev) => {
        const next = { ...prev };
        for (const item of detail.tracks) if (!(item.id in next)) next[item.id] = item.transition;
        return next;
      });
      sessionRef.current = detail;
      setSession(detail);
      return detail;
    } catch {
      setStatus("The session change could not be saved — network error.");
      return null;
    }
  }, []);

  const jumpTo = useCallback(
    (itemId: string, autoplay = false) => {
      if (fadeRef.current !== null) cancelTransition();
      const api = decksRef.current[activeDeckRef.current];
      if (itemId === currentIdRef.current) {
        if (autoplay && api && !api.transport.playing) {
          clearRemoteTransport();
          void api.transport.play();
        }
        return;
      }
      api?.transport.pause();
      currentIdRef.current = itemId;
      setAutoPlayId(autoplay ? itemId : null);
      setCurrentId(itemId);
      clearRemoteTransport();
      publishTransport({ trackId: itemId, positionSeconds: 0, playing: autoplay, action: "state" });
      void persistState({ id: itemId, position: 0 });
    },
    [cancelTransition, persistState, clearRemoteTransport, publishTransport],
  );

  const receiveRemoteTransport = useCallback((incoming: WaveyardRemoteTransport) => {
    if (incoming.sessionId !== sessionId) return;
    const previous = transportOrderRef.current;
    if (incoming.priority === "heartbeat") {
      if (previous && (
        incoming.sender !== previous.sender
        || incoming.clock !== previous.clock
        || incoming.updatedAt <= previous.updatedAt
      )) return;
    } else if (previous && (
      incoming.clock < previous.clock
      || (incoming.clock === previous.clock
        && previous.priority === "control"
        && incoming.sender <= previous.sender)
    )) return;
    transportOrderRef.current = {
      clock: incoming.clock,
      sender: incoming.sender,
      priority: incoming.priority,
      updatedAt: incoming.updatedAt,
    };
    remoteTransportRef.current = incoming;
    setRemoteTransport(incoming);
    if (fadeRef.current !== null) abortTransition("The other Waveyard tab changed playback.");

    const matchingDeck = incoming.trackId === null
      ? activeDeckRef.current
      : deckItems[0]?.id === incoming.trackId
        ? 0
        : deckItems[1]?.id === incoming.trackId
          ? 1
          : activeDeckRef.current;
    const api = decksRef.current[matchingDeck];
    const sameTrack = incoming.trackId === currentIdRef.current;
    const preservePlayingSeek = incoming.action === "seek" && incoming.playing && sameTrack && api?.transport.playing;
    applyingRemoteTransportRef.current = true;
    if (!preservePlayingSeek) api?.transport.pause();
    if (sameTrack && incoming.trackId !== null) api?.transport.seek(incoming.positionSeconds);
    if (remoteApplyTimerRef.current !== null) window.clearTimeout(remoteApplyTimerRef.current);
    remoteApplyTimerRef.current = window.setTimeout(() => {
      applyingRemoteTransportRef.current = false;
      remoteApplyTimerRef.current = null;
    }, 300);

    activeDeckRef.current = matchingDeck;
    setActiveDeck(matchingDeck);
    currentIdRef.current = incoming.trackId;
    setCurrentId(incoming.trackId);
    setAutoPlayId(null);
    setPositions((previousPositions) => {
      const next: [number, number] = [previousPositions[0], previousPositions[1]];
      next[matchingDeck] = incoming.positionSeconds;
      return next;
    });
    if (!incoming.playing) void persistState({ id: incoming.trackId, position: incoming.positionSeconds });
  }, [sessionId, deckItems, abortTransition, persistState]);

  useEffect(() => {
    if (remoteTransport === null || remoteTransport.sessionId !== sessionId) return;
    const deckIndex = activeDeck;
    if (remoteTransport.trackId !== null && deckItems[deckIndex]?.id !== remoteTransport.trackId) return;
    const api = decksRef.current[deckIndex];
    if (api === null) return;
    const preservePlayingSeek = remoteTransport.action === "seek"
      && remoteTransport.playing
      && api.transport.playing;
    applyingRemoteTransportRef.current = true;
    if (!preservePlayingSeek) api.transport.pause();
    if (remoteTransport.trackId !== null) api.transport.seek(remoteTransport.positionSeconds);
    if (remoteApplyTimerRef.current !== null) window.clearTimeout(remoteApplyTimerRef.current);
    remoteApplyTimerRef.current = window.setTimeout(() => {
      applyingRemoteTransportRef.current = false;
      remoteApplyTimerRef.current = null;
    }, 300);
    return () => {
      if (remoteApplyTimerRef.current !== null) window.clearTimeout(remoteApplyTimerRef.current);
      remoteApplyTimerRef.current = null;
      applyingRemoteTransportRef.current = false;
    };
  }, [remoteTransport, sessionId, activeDeck, deckItems]);

  // Commands from the library (play now / load / line up next).
  const lastCommandRef = useRef(0);
  useEffect(() => {
    if (command === null || command.seq === lastCommandRef.current || session === null || session.id !== sessionId) return;
    lastCommandRef.current = command.seq;
    void (async () => {
      let s = sessionRef.current;
      if (s === null) return;
      if (command.kind === "refresh") {
        const previousCurrentId = currentIdRef.current;
        const previousIndex = s.tracks.findIndex((item) => item.id === previousCurrentId);
        const previousNextId = previousIndex >= 0 ? s.tracks[previousIndex + 1]?.id ?? null : null;
        const wasPlaying = playingRef.current;
        try {
          const response = await fetch(`/api/library/sessions/${s.id}`, { cache: "no-store" });
          if (!response.ok) throw new Error(`HTTP ${response.status}`);
          const detail = (await response.json()).session as SessionDetail;
          if (sessionRef.current?.id !== detail.id) return;
          const currentRetained = previousCurrentId === null || detail.tracks.some((item) => item.id === previousCurrentId);
          const nextRetained = previousNextId === null || detail.tracks.some((item) => item.id === previousNextId);
          const wasFading = fadeRef.current !== null;
          const removedCurrent = previousCurrentId !== null && !currentRetained;
          const removedNext = previousNextId !== null && !nextRetained;
          if (wasFading && (removedCurrent || removedNext)) {
            abortTransition(removedCurrent
              ? "The current song was removed; switching to a remaining song."
              : "The mix target was removed; current playback continues.");
          }

          const liveIds = new Set(detail.tracks.map((item) => item.id));
          setMixes((prev) => Object.fromEntries(Object.entries(prev).filter(([id]) => liveIds.has(id))));
          setTransitions((prev) => Object.fromEntries(Object.entries(prev).filter(([id]) => liveIds.has(id))));
          setStemsReady((prev) => Object.fromEntries(Object.entries(prev).filter(([id]) => liveIds.has(id))));
          setFlags((prev) => Object.fromEntries(Object.entries(prev).filter(([id]) => liveIds.has(id))));
          sessionRef.current = detail;
          setSession(detail);

          if (previousCurrentId === null || currentRetained) {
            if (!(wasFading && removedNext)) {
              setStatus("Saved queue changes are reflected in the listening order.");
            }
            return;
          }
          const fallbackIndex = Math.min(Math.max(previousIndex, 0), detail.tracks.length - 1);
          const fallbackId = detail.tracks[fallbackIndex]?.id ?? null;
          if (fallbackId !== null) {
            jumpTo(fallbackId, wasPlaying);
            setStatus(wasPlaying ? "Removed the current song; playing the next remaining song." : "Removed the current song from the listening order.");
          } else {
            if (fadeRef.current !== null) cancelTransition();
            decksRef.current.forEach((api) => api?.transport.pause());
            currentIdRef.current = null;
            setCurrentId(null);
            setAutoPlayId(null);
            clearRemoteTransport();
            publishTransport({ trackId: null, positionSeconds: 0, playing: false, action: "state" });
            void persistState({ id: null, position: 0 });
            setStatus("The listening order is empty.");
          }
        } catch {
          setStatus("The saved queue changed, but the listening order could not be refreshed.");
        }
        return;
      }
      if (command.kind === "enqueue") {
        const ids = command.trackIds?.length ? command.trackIds : [command.trackId];
        const startFirst = s.tracks.length === 0 && currentIdRef.current === null;
        let firstAdded: string | null = null;
        for (const [index, trackId] of ids.entries()) {
          const latest = sessionRef.current;
          if (latest === null) return;
          const queueItemId = command.queueItemIds?.[index];
          const detail = await mutate(`/api/library/sessions/${latest.id}/tracks`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              trackId,
              position: latest.tracks.length,
              ...(queueItemId === undefined ? {} : { queueItemId }),
            }),
          });
          if (detail === null) return;
          s = detail;
          if (firstAdded === null) {
            firstAdded = detail.tracks.at(-1)?.id ?? null;
          }
        }
        if (startFirst && firstAdded !== null) jumpTo(firstAdded, true);
        setStatus(`${ids.length} song${ids.length === 1 ? "" : "s"} added to the listening order.`);
        return;
      }
      const curIdx = s.tracks.findIndex((item) => item.id === currentIdRef.current);
      const existing = s.tracks.find((item) => item.track.id === command.trackId) ?? null;
      const insertAt = curIdx >= 0 ? curIdx + 1 : s.tracks.length;
      if (command.kind === "next") {
        if (existing !== null && existing.id === currentIdRef.current) {
          setStatus("That song is already playing.");
          return;
        }
        const existingIdx = existing ? s.tracks.indexOf(existing) : -1;
        const detail = existing
          ? await mutate(`/api/library/sessions/${s.id}/tracks`, {
              method: "PATCH",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ sessionTrackId: existing.id, position: existingIdx < curIdx ? curIdx : insertAt }),
            })
          : await mutate(`/api/library/sessions/${s.id}/tracks`, {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ trackId: command.trackId, position: insertAt }),
            });
        if (detail !== null) {
          const title = detail.tracks.find((item) => item.track.id === command.trackId)?.track.title ?? "Track";
          setStatus(`Up next: ${title}.`);
        }
        return;
      }
      let target = existing?.id ?? null;
      if (target === null) {
        const before = new Set(s.tracks.map((item) => item.id));
        const detail = await mutate(`/api/library/sessions/${s.id}/tracks`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ trackId: command.trackId, position: insertAt }),
        });
        if (detail === null) return;
        target = detail.tracks.find((item) => !before.has(item.id) && item.track.id === command.trackId)?.id ?? null;
      }
      if (target !== null) jumpTo(target, command.kind === "play");
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- process each command once, after load
  }, [command, session, sessionId]);

  const addTrack = useCallback(() => {
    if (addTrackId === "" || session === null) return;
    void mutate(`/api/library/sessions/${session.id}/tracks`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ trackId: addTrackId }),
    }).then((detail) => detail && setStatus("Added to the end of the session."));
    setAddTrackId("");
  }, [addTrackId, session, mutate]);

  const setSessionTrackAsNext = useCallback(async (itemId: string) => {
    if (session === null || itemId === currentIdRef.current) return;
    const currentPosition = session.tracks.findIndex((item) => item.id === currentIdRef.current);
    const targetPosition = session.tracks.findIndex((item) => item.id === itemId);
    if (targetPosition < 0) return;
    const position = currentPosition < 0
      ? 0
      : targetPosition < currentPosition
        ? currentPosition
        : currentPosition + 1;
    const detail = await mutate(`/api/library/sessions/${session.id}/tracks`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sessionTrackId: itemId, position }),
    });
    if (detail === null) return;
    const title = detail.tracks.find((item) => item.id === itemId)?.track.title ?? "Track";
    publishWaveyardQueueChange([session.id]);
    setStatus(`Up next: ${title}.`);
  }, [session, mutate]);

  const moveTrack = useCallback(
    (itemId: string, position: number) => {
      if (session === null) return;
      void mutate(`/api/library/sessions/${session.id}/tracks`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ sessionTrackId: itemId, position }),
      });
    },
    [session, mutate],
  );

  const removeTrack = useCallback(
    (itemId: string) => {
      if (session === null) return;
      const previousIndex = session.tracks.findIndex((item) => item.id === itemId);
      const wasPlaying = playingRef.current;
      void mutate(`/api/library/sessions/${session.id}/tracks?sessionTrackId=${itemId}`, { method: "DELETE" }).then((detail) => {
        if (detail === null) return;
        publishWaveyardQueueChange([session.id]);
        if (currentIdRef.current !== itemId) return;
        const fallbackIndex = Math.min(Math.max(previousIndex, 0), detail.tracks.length - 1);
        const fallback = detail.tracks[fallbackIndex]?.id ?? null;
        if (fallback !== null) jumpTo(fallback, wasPlaying);
        else {
          decksRef.current.forEach((api) => api?.transport.pause());
          currentIdRef.current = null;
          setCurrentId(null);
          setAutoPlayId(null);
          void persistState({ id: null, position: 0 });
        }
      });
    },
    [session, mutate, jumpTo, persistState, clearRemoteTransport, publishTransport],
  );

  // ------------------------------------------------------------------ swaps
  const requestSwap = useCallback(
    async (stemType: string, donor: { id: string; title: string; stems?: SessionTrackItem["stems"] }) => {
      if (session === null || currentItem === null) return;
      const validation = donor.stems ? validateStemSwap(currentItem.stems, donor.stems, stemType) : null;
      if (validation && !validation.ok) {
        setStatus(validation.reason);
        return;
      }
      setSavingSwap(true);
      try {
        const detail = await mutate(`/api/library/sessions/${session.id}/swaps`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            sessionTrackId: currentItem.id,
            stemType,
            toTrackId: donor.id,
            atSeconds: decksRef.current[activeDeck]?.transport.position ?? 0,
          }),
        });
        if (detail) setStatus(`${stemType} source saved: “${donor.title}”.`);
      } finally {
        setSavingSwap(false);
      }
    },
    [session, currentItem, mutate, activeDeck],
  );

  const revertSwap = useCallback(
    async (swapId: string) => {
      if (session === null) return;
      setSavingSwap(true);
      try {
        const detail = await mutate(`/api/library/sessions/${session.id}/swaps?swapId=${swapId}`, { method: "DELETE" });
        if (detail) setStatus("Original stem restored.");
      } finally {
        setSavingSwap(false);
      }
    },
    [session, mutate],
  );

  // -------------------------------------------------------- studio handoff
  const sendToStudio = useCallback(() => {
    if (session === null) return;
    void (async () => {
      try {
        const response = await fetch(`/api/library/sessions/${session.id}/studio-handoff`, { method: "POST" });
        if (!response.ok) {
          const body = (await response.json().catch(() => null)) as { error?: string } | null;
          setStatus(body?.error ?? "The Studio handoff failed.");
          return;
        }
        setHandoff((await response.json()).handoff);
        setStatus("Sent to Studio as a derived arrangement — sources untouched.");
      } catch {
        setStatus("The Studio handoff could not be saved.");
      }
    })();
  }, [session]);

  // ------------------------------------- hardware media keys
  useHardwareMediaKeys({
    nowPlaying:
      currentItem === null
        ? null
        : { title: currentItem.track.title, artist: currentItem.track.artist, album: null, playing: playingByDeck[activeDeck] },
    handlers: {
      onPlayPause: () => void togglePlay(),
      onNext: () => {
        if (phase === "fading") finishTransition();
        else if (nextItem !== null) jumpTo(nextItem.id, playingByDeck[activeDeck]);
      },
      onPrevious: () => {
        if (previousItem !== null) jumpTo(previousItem.id, playingByDeck[activeDeck]);
      },
    },
  });

  const refreshSessionFromOtherTab = useCallback(async () => {
    try {
      const response = await fetch(`/api/library/sessions/${sessionId}`, { cache: "no-store" });
      if (!response.ok) return;
      const fresh = (await response.json()).session as SessionDetail;
      const previous = sessionRef.current;
      if (previous === null || previous.id !== sessionId) return;
      const audible = new Set<string>();
      for (const [index, deck] of decksRef.current.entries()) {
        const item = deckItems[index as 0 | 1];
        if (deck?.transport.playing && item) audible.add(item.id);
      }
      const merged = fresh.tracks.map((item) => {
        const old = previous.tracks.find((candidate) => candidate.id === item.id);
        return old && old.playback?.kind !== item.playback?.kind && audible.has(item.id) ? old : item;
      });
      const next = { ...previous, ...fresh, tracks: merged };
      sessionRef.current = next;
      setSession(next);
    } catch {
      /* The next queue or transport update will retry the refresh. */
    }
  }, [sessionId, deckItems]);

  useEffect(() => subscribeToWaveyardQueueChanges(({ affectedSessionIds, transport }) => {
    if (transport !== undefined) receiveRemoteTransport(transport);
    else if (affectedSessionIds.includes(sessionId)) void refreshSessionFromOtherTab();
  }), [sessionId, receiveRemoteTransport, refreshSessionFromOtherTab]);

  // Background refresh: picks up finished separations and new library tracks.
  // A deck that is AUDIBLE keeps its source until the user switches.
  const pending = session?.tracks.some((item) => item.playback?.kind !== "stems") ?? false;
  useEffect(() => {
    if (session === null) return;
    let cancelled = false;
    const id = session.id;
    const tick = async () => {
      try {
        const [sessionResponse, libraryResponse] = await Promise.all([
          pending ? fetch(`/api/library/sessions/${id}`, { cache: "no-store" }) : Promise.resolve(null),
          fetch("/api/library/tracks", { cache: "no-store" }),
        ]);
        if (cancelled || sessionRef.current?.id !== id) return;
        if (libraryResponse.ok) {
          const tracks = ((await libraryResponse.json()).tracks ?? []) as LibraryTrackOption[];
          if (!cancelled) setLibrary(tracks);
        }
        if (sessionResponse === null || !sessionResponse.ok) return;
        const fresh = (await sessionResponse.json()).session as SessionDetail;
        const prev = sessionRef.current;
        if (cancelled || prev === null || prev.id !== id) return;
        const audible = new Set<string>();
        for (const [index, deck] of decksRef.current.entries()) {
          const deckItem = deckItems[index as 0 | 1];
          if (deck?.transport.playing && deckItem) audible.add(deckItem.id);
        }
        const held: Record<string, SessionTrackItem> = {};
        const merged = fresh.tracks.map((item) => {
          const old = prev.tracks.find((t) => t.id === item.id);
          const changed = old !== undefined && old.playback?.kind !== item.playback?.kind;
          if (changed && audible.has(item.id)) {
            held[item.id] = item;
            return old;
          }
          return item;
        });
        // Only replace state when something actually changed.
        const before = JSON.stringify(prev.tracks.map((t) => [t.id, t.playback?.kind, t.stems.length, t.analysis?.bpm ?? null]));
        const after = JSON.stringify(merged.map((t) => [t.id, t.playback?.kind, t.stems.length, t.analysis?.bpm ?? null]));
        if (before !== after || prev.tracks.length !== merged.length) {
          const next = { ...prev, tracks: merged, swaps: fresh.swaps };
          sessionRef.current = next;
          setSession(next);
        }
        setStemsReady((current) => {
          const keys = Object.keys(held);
          if (keys.length === Object.keys(current).length && keys.every((k) => k in current)) return current;
          return { ...current, ...held };
        });
      } catch {
        /* polling is opportunistic; the next tick retries */
      }
    };
    const interval = window.setInterval(() => void tick(), pending ? 8000 : 30000);
    return () => {
      cancelled = true;
      window.clearInterval(interval);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- interval per session + pending state
  }, [session?.id, pending]);

  const switchToStems = useCallback((itemId: string) => {
    const ready = stemsReady[itemId];
    const s = sessionRef.current;
    if (ready === undefined || s === null) return;
    const deckIndex = deckItems[0]?.id === itemId ? 0 : deckItems[1]?.id === itemId ? 1 : -1;
    const api = deckIndex >= 0 ? decksRef.current[deckIndex] : null;
    const wasPlaying = api?.transport.playing ?? false;
    const at = api?.transport.position ?? 0;
    setResumeAt({ itemId, seconds: at });
    setAutoPlayId(wasPlaying ? itemId : null);
    const next = { ...s, tracks: s.tracks.map((t) => (t.id === itemId ? ready : t)) };
    sessionRef.current = next;
    setSession(next);
    setStemsReady((current) => {
      const copy = { ...current };
      delete copy[itemId];
      return copy;
    });
    setStatus(`Switched “${ready.track.title}” to stems at ${formatClock(at)} — expect a brief reload gap.`);
  }, [stemsReady, deckItems]);

  const compatibility = useMemo(() => {
    if (currentItem === null || nextItem === null) return null;
    const tempo = tempoCompatibility(currentItem.analysis?.bpm ?? null, nextItem.analysis?.bpm ?? null);
    const key = keyCompatibility(currentItem.analysis?.musicalKey ?? null, nextItem.analysis?.musicalKey ?? null);
    const mode = currentTransition?.mode ?? "manual";
    const evidence = compatibilityEvidence(currentItem.analysis, nextItem.analysis, mode);
    let alignment: { ok: boolean; reason: string } | null = null;
    if (mode === "beat" || mode === "bar") {
      const aligned = beatAlignedTransitionStart(currentItem.analysis?.beatGridMs ?? null, nextItem.analysis?.beatGridMs ?? null, 0, mode);
      alignment = { ok: aligned.ok, reason: aligned.reason };
    } else if (mode === "meeting-point") {
      alignment = { ok: false, reason: "Stored; V1 crossfades from the current position." };
    }
    return { tempo, key, alignment, evidence };
  }, [currentItem, nextItem, currentTransition]);

  // Start the selected fade early enough to reach its transition cue and finish
  // before the current song ends. The same transition core powers manual mixes.
  useEffect(() => {
    if (!autoCrossfadeEnabled || phase === "fading" || !playingByDeck[activeDeck] || currentItem === null || nextItem === null) return;
    const fromApi = decksRef.current[activeDeck];
    const toDeck: 0 | 1 = activeDeck === 0 ? 1 : 0;
    if (fromApi === null || decksRef.current[toDeck] === null) return;

    const cfg = transitions[currentItem.id] ?? currentItem.transition;
    if (cfg.crossfadeSeconds <= 0) return;
    const currentPosition = fromApi.transport.position;
    const duration = currentItem.track.durationSeconds;
    if (autoCrossfadeStartedForRef.current === currentItem.id) {
      if (currentPosition >= duration - cfg.crossfadeSeconds - 1) return;
      autoCrossfadeStartedForRef.current = null;
    }

    let alignmentLeadSeconds = 0;
    if (cfg.mode === "beat" || cfg.mode === "bar") {
      const aligned = beatAlignedTransitionStart(
        currentItem.analysis?.beatGridMs ?? null,
        nextItem.analysis?.beatGridMs ?? null,
        currentPosition * 1000,
        cfg.mode,
      );
      if (aligned.ok && aligned.startInCurrentMs !== null) {
        alignmentLeadSeconds = Math.max(0, aligned.startInCurrentMs / 1000 - currentPosition);
      }
    }
    const remaining = duration - currentPosition;
    if (remaining > cfg.crossfadeSeconds + alignmentLeadSeconds + 0.35) return;

    autoCrossfadeStartedForRef.current = currentItem.id;
    void beginTransition();
  }, [
    autoCrossfadeEnabled, phase, playingByDeck, activeDeck, currentItem, nextItem,
    transitions, beginTransition, positions,
  ]);

  // ---------------------------------------------------------------- render
  if (loadError !== null && session === null) {
    if (variant === "compact") return null;
    return (
      <section className="wy-workspace wy-workspace-empty" aria-label="Session unavailable">
        <p className="sess-status" role="alert">{loadError}</p>
        <button type="button" className="button secondary" onClick={() => setReloadNonce((n) => n + 1)}>Retry</button>
      </section>
    );
  }
  if (session === null) {
    if (variant === "compact") return null;
    return (
      <section className="wy-workspace wy-workspace-empty" aria-label="Loading session">
        <div className="wy-skeleton" /><div className="wy-skeleton short" />
      </section>
    );
  }

  const remoteMatchesCurrent = remoteTransport?.sessionId === session.id
    && (remoteTransport.trackId === null || remoteTransport.trackId === currentItem?.id);
  const playing = remoteMatchesCurrent ? remoteTransport.playing : playingByDeck[activeDeck];
  const position = remoteMatchesCurrent ? remoteTransport.positionSeconds : positions[activeDeck];
  const duration = currentItem?.track.durationSeconds ?? 0;
  const transition = currentTransition;
  const keepSet = new Set(transition?.keepStems ?? []);
  const emptyFlags: StemFlags = { muted: [], solo: [] };

  const setLevel = (itemId: string) => (stemType: string, value: number) =>
    setMixes((prev) => ({ ...prev, [itemId]: { ...prev[itemId], [stemType]: value } }));
  const toggleFlag = (itemId: string) => (stemType: string, flag: "muted" | "solo") =>
    setFlags((prev) => {
      const cur = prev[itemId] ?? { muted: [], solo: [] };
      const list = cur[flag].includes(stemType) ? cur[flag].filter((s) => s !== stemType) : [...cur[flag], stemType];
      return { ...prev, [itemId]: { ...cur, [flag]: list } };
    });
  const setTransition = (patch: Partial<TransitionConfig>) => {
    if (currentItem === null) return;
    setTransitions((prev) => ({ ...prev, [currentItem.id]: { ...(prev[currentItem.id] ?? currentItem.transition), ...patch } }));
  };
  const toggleKeep = (stemType: string) => {
    if (currentItem === null) return;
    const kept = new Set(keepSet);
    if (kept.has(stemType)) kept.delete(stemType);
    else kept.add(stemType);
    setTransition({ keepStems: [...kept] });
  };
  const seekCurrent = (value: number) => {
    const api = decksRef.current[activeDeck];
    const remote = remoteTransportRef.current;
    const usingRemoteState = remote?.sessionId === sessionId && !api?.transport.playing;
    const trackId = usingRemoteState ? remote.trackId : currentItem?.id ?? null;
    const shouldRemainPlaying = usingRemoteState ? remote.playing : (api?.transport.playing ?? false);
    api?.transport.seek(value);
    setPositions((prev) => activeDeck === 0 ? [value, prev[1]] : [prev[0], value]);
    setStatus(null);
    const published = publishTransport({
      trackId,
      positionSeconds: value,
      playing: shouldRemainPlaying,
      action: "seek",
    });
    if (usingRemoteState && published !== null) {
      remoteTransportRef.current = published;
      setRemoteTransport(published);
    } else {
      clearRemoteTransport();
    }
    if (!shouldRemainPlaying) void persistState({ id: trackId, position: value });
  };

  const swapExtra = (stemType: string) => {
    if (currentItem === null) return null;
    const swap = session.swaps.filter((s) => s.sessionTrackId === currentItem.id && s.stemType === stemType).at(-1);
    const donors = session.tracks.filter((item) =>
      item.track.id !== currentItem.track.id && validateStemSwap(currentItem.stems, item.stems, stemType).ok,
    );
    const inSession = new Set(session.tracks.map((item) => item.track.id));
    const libraryDonors = library.filter((item) => !inSession.has(item.id) &&
      item.id !== currentItem.track.id && item.stemAvailability?.status === "separated");
    return (
      <div className="wy-stem-source-control">
        <span>Live source</span>
        <select
          className="wy-stem-source"
          aria-label={`${stemType} source`}
          value={swap?.toTrackId ?? ""}
          disabled={savingSwap || (donors.length === 0 && libraryDonors.length === 0)}
          title="Choose a separated song in your library as a live stem source"
          onChange={(event) => {
            const donor = donors.find((item) => item.track.id === event.target.value);
            if (donor) requestSwap(stemType, { id: donor.track.id, title: donor.track.title, stems: donor.stems });
            else {
              const source = libraryDonors.find((item) => item.id === event.target.value);
              if (source) requestSwap(stemType, { id: source.id, title: source.title });
              else if (!event.target.value && swap) revertSwap(swap.id);
            }
          }}
        >
          <option value="">Original</option>
          {donors.map((donor) => <option key={donor.id} value={donor.track.id}>{donor.track.title}</option>)}
          {libraryDonors.map((donor) => <option key={donor.id} value={donor.id}>{donor.title}</option>)}
        </select>
        {donors.length === 0 && libraryDonors.length === 0 && <small>Separate another track to swap in a layer.</small>}
      </div>
    );
  };

  const deckProps = (deckIndex: 0 | 1) => {
    const item = deckItems[deckIndex];
    const isActive = deckIndex === activeDeck;
    return {
      deckIndex,
      item,
      active: isActive,
      startAt: startAtFor(deckIndex),
      swaps: isActive ? activeSwaps : {},
      masterLevel,
      autoPlay: item !== null && autoPlayId === item.id && (isActive || resumeAt?.itemId === item.id),
      onAutoPlayed: () => {
        setAutoPlayId(null);
        setResumeAt(null);
      },
      levels: item ? mixes[item.id] ?? {} : {},
      flags: item ? flags[item.id] ?? emptyFlags : emptyFlags,
      onLevel: item ? setLevel(item.id) : () => undefined,
      onFlag: item ? toggleFlag(item.id) : () => undefined,
      onReset: () => {
        if (!item) return;
        setMixes((prev) => ({
          ...prev,
          [item.id]: Object.fromEntries(item.stems.map((stem) => [stem.stemType, 1])),
        }));
        setFlags((prev) => ({ ...prev, [item.id]: { muted: [], solo: [] } }));
      },
      stemExtra: isActive ? swapExtra : undefined,
      onApi: handleDeckApi,
      onPlaying: handleDeckPlaying,
      onProgress: handleDeckProgress,
      onEnded: handleDeckEnded,
    };
  };

  const saveLabel =
    saveState === "error" || mixSaveError ? "Not saved" : saveState === "saving" ? "Saving…" : "Saved";

  return (
    <section className={`wy-workspace wy-${variant}`} aria-label={`Listening · ${session.name}`} data-testid="listening-workspace">
      <div className="wy-transport" role="group" aria-label="Transport">
        <div className="wy-now">
          <span className="eyebrow">{phase === "fading" ? "Mixing" : playing ? "Playing" : "Paused"} · {session.name}</span>
          <b>{currentItem?.track.title ?? "Nothing loaded"}</b>
          <small>
            {currentItem?.track.artist || (currentItem ? "Unknown artist" : "")}
            {nextItem ? ` · next: ${nextItem.track.title}` : ""}
          </small>
        </div>
        <div className="wy-buttons">
          <button type="button" className="wy-icon" aria-label="Previous track" disabled={previousItem === null} onClick={() => previousItem && jumpTo(previousItem.id, playing)}>
            <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 5h2v14H6zM20 5v14L9 12z" /></svg>
          </button>
          <button type="button" className="wy-play" aria-label={playing ? "Pause" : "Play"} aria-pressed={playing} disabled={currentItem === null} onClick={() => void togglePlay()} data-testid="session-play">
            {playing ? (
              <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 5h4v14H6zM14 5h4v14h-4z" /></svg>
            ) : (
              <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 4v16l13-8z" /></svg>
            )}
          </button>
          {phase === "fading" ? (
            <button type="button" className="wy-mixbtn" onClick={finishTransition}>Finish</button>
          ) : (
            <button type="button" className="wy-mixbtn" disabled={nextItem === null} onClick={() => void beginTransition()} data-testid="session-transition" title={nextItem ? `Mix into “${nextItem.track.title}”` : "No next track"}>
              Mix next
            </button>
          )}
        </div>
        <div className="wy-seek">
          <span>{formatClock(position)}</span>
          <input type="range" aria-label="Seek current track" min={0} max={Math.max(duration, 1)} step={0.5} value={Math.min(position, duration)} disabled={currentItem === null} onChange={(event) => seekCurrent(Number(event.target.value))} onKeyDown={(event) => {
            if (event.key === "Home" || event.key === "End") {
              event.preventDefault();
              seekCurrent(event.key === "Home" ? 0 : duration);
            }
          }} />
          <span>{formatClock(duration)}</span>
        </div>
        <label className="wy-master">
          <span>Master</span>
          <input type="range" aria-label="Master volume" min={0} max={1} step={0.01} value={masterLevel} onChange={(event) => setMasterLevel(Number(event.target.value))} />
        </label>
        <button
          type="button"
          className={`wy-save ${saveLabel === "Not saved" ? "bad" : ""}`}
          onClick={() => { setMixSaveError(false); lastSentRef.current = {}; void persistState(); }}
          title={saveLabel === "Not saved" ? "Saving failed — click to retry" : "Position and mixes are saved to this session"}
          data-testid="status-save"
        >
          {saveLabel === "Not saved" ? "Not saved · retry" : saveLabel}
        </button>
        {variant === "compact" && (
          <Link className="wy-open" href={`/waveyard/session/${session.id}`}>Open mixer</Link>
        )}
      </div>

      <div className="wy-full-only">
        {Object.values(stemsReady).map((item) => (
          <p key={item.id} className="sess-status wy-ready" role="status">
            Stems are ready for “{item.track.title}”. It keeps playing the full source until you switch.{" "}
            <button type="button" className="button tiny" onClick={() => switchToStems(item.id)} data-testid={`button-switch-stems-${item.id}`}>Switch to stems</button>
          </p>
        ))}
        {status !== null && <p className="sess-status" role="status" data-testid="session-status">{status}</p>}
        {loadError !== null && <p className="sess-status" role="alert">{loadError}</p>}
        {handoff !== null && (
          <p className="sess-handoff" role="status">
            Studio arrangement created with {handoff.remixTrackCount} remix track{handoff.remixTrackCount === 1 ? "" : "s"}
            {handoff.refused && handoff.refused.length > 0 ? ` — ${handoff.refused.length} refused.` : "."}{" "}
            <Link href={`/waveyard/create?project=${handoff.projectId}`}>Open in Studio</Link>
          </p>
        )}

        <div className="wy-decks">
          <SessionDeck {...deckProps(0)} />
          <div className="sess-transition wy-transition" style={{ order: 2 }} aria-label="Transition">
            <span className="eyebrow">Transition</span>
            {transition !== null && (
              <>
                <div className="sess-transition-row">
                  <label htmlFor="sess-mode">Mode</label>
                  <select id="sess-mode" value={transition.mode} onChange={(event) => setTransition({ mode: event.target.value as TransitionMode })}>
                    <option value="manual">Crossfade</option>
                    <option value="beat">Beat-aligned</option>
                    <option value="bar">Bar-aligned</option>
                    <option value="meeting-point">Meeting point (stored)</option>
                  </select>
                </div>
                <div className="sess-transition-row">
                  <label htmlFor="sess-fade">Length</label>
                  <input id="sess-fade" type="range" min={0} max={15} step={0.5} value={transition.crossfadeSeconds} onChange={(event) => setTransition({ crossfadeSeconds: Number(event.target.value) })} />
                  <span>{transition.crossfadeSeconds === 0 ? "cut" : `${transition.crossfadeSeconds.toFixed(1)}s`}</span>
                </div>
                <label className="sess-keep-option" title="Uses the selected transition mode and length at the end of each song.">
                  <input
                    type="checkbox"
                    data-testid="session-auto-crossfade"
                    checked={autoCrossfadeEnabled}
                    onChange={(event) => setAutoCrossfadeEnabled(event.target.checked)}
                  />
                  Auto-crossfade queued songs
                </label>
                {currentItem !== null && currentItem.stems.length > 0 && (
                  <fieldset className="sess-keep">
                    <legend>Keep from current</legend>
                    {currentItem.stems.map((stem) => (
                      <label key={stem.id} className="sess-keep-option">
                        <input type="checkbox" checked={keepSet.has(stem.stemType)} onChange={() => toggleKeep(stem.stemType)} />
                        {stem.stemType}
                      </label>
                    ))}
                  </fieldset>
                )}
                {phase === "fading" && (
                  <button type="button" className="button secondary" onClick={cancelTransition}>Freeze</button>
                )}
              </>
            )}
            {compatibility !== null && (
              <div className="sess-compat" data-testid="session-compat">
                <p className={compatibility.tempo.compatible ? "sess-compat-ok" : "sess-compat-bad"}>
                  <b className={`sess-evidence sess-evidence-${compatibility.evidence.tempo.level}`}>Tempo · {compatibility.evidence.tempo.level.toUpperCase()}</b> {compatibility.tempo.reason}
                </p>
                <p className={compatibility.key.compatible ? "sess-compat-ok" : "sess-compat-bad"}>
                  <b className={`sess-evidence sess-evidence-${compatibility.evidence.key.level}`}>Key · {compatibility.evidence.key.level.toUpperCase()}</b> {compatibility.key.reason}
                </p>
                {compatibility.alignment !== null && compatibility.evidence.alignment !== null && (
                  <p className={compatibility.alignment.ok ? "sess-compat-ok" : "sess-compat-bad"}>
                    <b className={`sess-evidence sess-evidence-${compatibility.evidence.alignment.level}`}>Alignment · {compatibility.evidence.alignment.level.toUpperCase()}</b> {compatibility.alignment.reason}
                  </p>
                )}
              </div>
            )}
            {currentItem !== null && (
              <CamelotWheel
                key={currentItem.id}
                currentTrackId={currentItem.id}
                currentKey={currentItem.analysis?.musicalKey ?? null}
                nextTrackId={nextItem?.id ?? null}
                nextKey={nextItem?.analysis?.musicalKey ?? null}
                tracks={session.tracks.map((item) => ({
                  id: item.id,
                  title: item.track.title,
                  artist: item.track.artist,
                  key: item.analysis?.musicalKey ?? null,
                }))}
                disabled={phase === "fading"}
                onSetNext={setSessionTrackAsNext}
              />
            )}
            <p className="wy-fine">Mute or isolate a stem to audition it. Restore all returns every layer to the full mix.</p>
          </div>
          <SessionDeck {...deckProps(1)} />
        </div>

        <details className="wy-drawer">
          <summary>Session order · {session.tracks.length}</summary>
          <ol className="sess-queue-list">
            {session.tracks.map((item, index) => (
              <li key={item.id} className={`sess-queue-item${item.id === currentItem?.id ? " current" : ""}${item.id === nextItem?.id ? " next" : ""}`}>
                <button type="button" className="sess-queue-jump" onClick={() => jumpTo(item.id, playing)}>
                  <span className="sess-queue-pos">{index + 1}</span>
                  <span>
                    {item.track.title}
                    <small>{item.track.artist || "Unknown artist"}{item.id === currentItem?.id ? " · current" : item.id === nextItem?.id ? " · next" : ""}</small>
                  </span>
                </button>
                <span className="sess-queue-actions">
                  <button type="button" className="button tiny" aria-label={`Move ${item.track.title} earlier`} disabled={index === 0} onClick={() => moveTrack(item.id, index - 1)}>Up</button>
                  <button type="button" className="button tiny" aria-label={`Move ${item.track.title} later`} disabled={index === session.tracks.length - 1} onClick={() => moveTrack(item.id, index + 1)}>Down</button>
                  <button type="button" className="button tiny" aria-label={`Remove ${item.track.title}`} onClick={() => removeTrack(item.id)}>Remove</button>
                </span>
              </li>
            ))}
          </ol>
          <div className="sess-queue-add-row">
            <label htmlFor="sess-add" className="visually-hidden">Add a track to the end</label>
            <select id="sess-add" value={addTrackId} onChange={(event) => setAddTrackId(event.target.value)}>
              <option value="">Add to end…</option>
              {library.map((option) => (
                <option key={option.id} value={option.id}>{option.title} — {option.artist || "Unknown artist"}</option>
              ))}
            </select>
            <button type="button" className="button" onClick={addTrack} disabled={addTrackId === ""} data-testid="session-add-track">Add</button>
          </div>
          <div className="wy-drawer-actions">
            <button type="button" className="button secondary" onClick={sendToStudio} data-testid="session-handoff">Send to Studio</button>
            <Link className="button secondary" href="/waveyard/sessions">All sessions</Link>
          </div>
        </details>

        <details className="wy-drawer">
          <summary>Output and hardware</summary>
          <Stem2Panel />
        </details>
      </div>
    </section>
  );
}
