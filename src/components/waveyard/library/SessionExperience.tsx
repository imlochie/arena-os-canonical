"use client";

import type { TrackSummary } from "@/lib/waveyard/library/service";

import type { StudioHandoffResult } from "@/lib/waveyard/library/session-service";

import Link from "next/link";
import { laneDisplayName } from "@/lib/waveyard/separation/stem-display";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useStemTransport, type ChannelMeter, type MixerValues } from "@/lib/waveyard/useStemTransport";
import { useHardwareMediaKeys } from "@/lib/waveyard/stem2";
import Stem2Panel from "@/components/waveyard/stem2/Stem2Panel";
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
} from "@/lib/waveyard/library/session-logic";

// ---------------------------------------------------------------------------
// Types mirrored from the session API payload (server is the source of truth;
// these are the reading shapes, not a second domain model).
// ---------------------------------------------------------------------------

interface SessionTrackItem {
  id: string;
  position: number;
  track: { id: string; title: string; artist: string; durationSeconds: number };
  stems: Array<{ id: string; stemType: string; engine: string; model?: string | null }>;
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
  }>;
  createdAt: string;
  updatedAt: string;
}

type LibraryTrackOption = Pick<TrackSummary, "id" | "title" | "artist">;

type DeckApi = {
  itemId: string | null;
  transport: ReturnType<typeof useStemTransport>;
  /** Apply per-stem-TYPE volumes (the parent owns the mix semantics). */
  applyStemVolumes: (volumes: Record<string, number>) => void;
};

type TransitionIdentity = { fromDeck: 0 | 1; toDeck: 0 | 1; fromId: string; toId: string };
type FadePhase = "idle" | "starting" | "fading";

function formatClock(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return "0:00";
  const whole = Math.floor(seconds);
  return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, "0")}`;
}

// ---------------------------------------------------------------------------
// One physical deck. Keyed by role (never remounted per track), it loads
// whatever session track it is assigned and drives it through the canonical
// useStemTransport — the session layer composes the P2 primitive, it does not
// replace it.
// ---------------------------------------------------------------------------

/** Preserve the media element / Web Audio graph across donor changes. Only
 * this lane rejoins the deck clock after the new URL's real metadata arrives. */
function SessionStemAudio({ assetId, src, label, register, synchronizeSource, onEnded }: {
  assetId: string;
  src: string;
  label: string;
  register: ReturnType<typeof useStemTransport>["register"];
  synchronizeSource: ReturnType<typeof useStemTransport>["synchronizeSource"];
  onEnded: () => void;
}) {
  const previousSource = useRef(src);
  const mediaRef = useCallback((element: HTMLAudioElement | null) => register(assetId, element), [assetId, register]);
  useLayoutEffect(() => {
    if (previousSource.current === src) return;
    previousSource.current = src;
    return synchronizeSource(assetId);
  }, [assetId, src, synchronizeSource]);
  return <audio aria-label={label} ref={mediaRef} src={src} preload="auto" onEnded={onEnded} />;
}

function SessionDeck({
  deckIndex,
  item,
  active,
  startAt,
  swaps,
  onApi,
  onPlaying,
  onPosition,
  onEnded,
  testId,
}: {
  deckIndex: number;
  item: SessionTrackItem | null;
  active: boolean;
  /** Seconds to seek to when a NEW track is loaded into this deck. */
  startAt: number;
  /** Active stem swaps for this deck's item: stemType → donor asset id. */
  swaps: Record<string, string>;
  onApi: (deckIndex: number, api: DeckApi | null) => void;
  onPlaying: (deckIndex: number, playing: boolean) => void;
  onPosition: (deckIndex: number, seconds: number) => void;
  onEnded: (deckIndex: number) => void;
  testId: string;
}) {
  const assetIds = useMemo(() => item?.playback?.assetIds ?? [], [item?.playback]);
  const duration = item?.track.durationSeconds ?? 0;
  const transport = useStemTransport(assetIds, duration);

  const stemTypeByAsset = useMemo(() => {
    const map = new Map<string, string>();
    for (const stem of item?.stems ?? []) map.set(stem.id, stem.stemType);
    return map;
  }, [item?.stems]);

  const applyStemVolumes = useCallback(
    (volumes: Record<string, number>) => {
      const values: Record<string, MixerValues> = {};
      for (const assetId of assetIds) {
        values[assetId] = {
          volume: volumes[stemTypeByAsset.get(assetId) ?? "source"] ?? 1,
          pan: 0,
          muted: false,
          solo: false,
        };
      }
      transport.applyMix(values);
    },
    [assetIds, stemTypeByAsset, transport],
  );

  // Hand the deck's live api up to the session controller. The api object is
  // refreshed when the transport callbacks change (new track loaded).
  useEffect(() => {
    onApi(deckIndex, { itemId: item?.id ?? null, transport, applyStemVolumes });
    return () => onApi(deckIndex, null);
  }, [deckIndex, item?.id, transport, applyStemVolumes, onApi]);

  // Play state flows up as state so the parent never reads transport state
  // through a ref during render.
  useEffect(() => {
    onPlaying(deckIndex, transport.playing);
  }, [deckIndex, transport.playing, onPlaying]);

  useEffect(() => { onPosition(deckIndex, transport.position); }, [deckIndex, transport.position, onPosition]);

  // A fresh track loads at its assigned start position, at unity master.
  const startAtRef = useRef(startAt);
  useEffect(() => {
    startAtRef.current = startAt;
  }, [startAt]);
  const loadedItemId = useRef<string | null>(null);
  useEffect(() => {
    if (item === null) {
      loadedItemId.current = null;
      return;
    }
    if (loadedItemId.current === item.id) return;
    loadedItemId.current = item.id;
    transport.pause();
    transport.setMasterVolume(1);
    transport.seek(Math.max(0, Math.min(startAtRef.current, item.track.durationSeconds)));
    // eslint-disable-next-line react-hooks/exhaustive-deps -- run only when this deck's track changes
  }, [item?.id]);

  // Real meters while THIS deck is the audible, playing one.
  const [meters, setMeters] = useState<Record<string, ChannelMeter> | null>(null);
  useEffect(() => {
    if (!active || !transport.playing) {
      if (meters !== null) {
        const idleId = requestAnimationFrame(() => setMeters(null));
        return () => cancelAnimationFrame(idleId);
      }
      return;
    }
    let rafId = 0;
    const tick = () => {
      const snapshot = transport.readMeters();
      setMeters(snapshot.channels);
      rafId = requestAnimationFrame(tick);
    };
    rafId = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(rafId);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- meters poll bound to play state only
  }, [active, transport.playing]);

  const separated = item?.playback?.kind === "stems";

  return (
    <section
      className={`sess-deck${active ? " sess-deck-active" : ""}`}
      aria-label={active ? `Current deck · ${item?.track.title ?? "empty"}` : `Next deck · ${item?.track.title ?? "empty"}`}
      data-testid={testId}
    >
      {item === null ? (
        <p className="sess-deck-empty">
          This deck is free. Add another track to the session and it loads here.
        </p>
      ) : (
        <>
          {/* Real audio elements. A swapped layer's element plays the DONOR
              track's real stem asset while following this deck's clock. */}
          {assetIds.map((assetId) => {
            const stemType = stemTypeByAsset.get(assetId) ?? "source";
            const donorAssetId = swaps[stemType];
            const src = donorAssetId ?? assetId;
            return (
              <SessionStemAudio
                key={assetId}
                assetId={assetId}
                label={`${stemType} audio${donorAssetId ? " (swapped layer)" : ""}`}
                register={transport.register}
                synchronizeSource={transport.synchronizeSource}
                src={`/api/assets/${src}`}
                onEnded={() => onEnded(deckIndex)}
              />
            );
          })}
          <div className="sess-deck-head">
            <span className="eyebrow">{`Deck ${deckIndex === 0 ? "A" : "B"} · ${active ? "current" : "on deck"}`}</span>
            <h3>{item.track.title}</h3>
            <p className="sess-deck-sub">
              {item.track.artist || "Unknown artist"}
              {item.analysis?.bpm != null ? ` · ${Math.round(item.analysis.bpm)} BPM` : ""}
              {item.analysis?.musicalKey ? ` · ${item.analysis.musicalKey}` : ""}
              {item.analysis === null ? " · analysis pending" : ""}
            </p>
          </div>
          {transport.error !== null && <div role="alert"><p>{transport.error}</p>{!separated && <p>Browser codec support varies. <Link href={`/waveyard?convertTrack=${item.track.id}`}>Review browser-compatible conversion</Link> to explicitly create a compatible derivative. The original and saved session stay unchanged; choose any replacement yourself.</p>}</div>}
          <div className="sess-deck-progress" aria-hidden="true">
            <div className="sess-deck-progress-fill" style={{ width: `${duration > 0 ? Math.min(100, (transport.position / duration) * 100) : 0}%` }} />
          </div>
          <p className="sess-deck-time">
            {formatClock(transport.position)} / {formatClock(duration)}
            {!separated ? " · full source (not separated)" : ""}
          </p>
          <div className="sess-deck-stems">
            {(item.stems.length === 0 ? [{ id: "", stemType: "source", engine: "missing" }] : item.stems).map(
              (stem) => (
                <div key={stem.id || stem.stemType} className="sess-stem-row">
                  <span className="sess-stem-name">{stem.stemType}</span>
                  <span
                    className={`sess-stem-meter${meters?.[stem.id]?.peak ? " hot" : ""}`}
                    aria-hidden="true"
                  />
                  <span className="visually-hidden" aria-live="off">
                    {meters?.[stem.id] ? `peak ${meters[stem.id].peak.toFixed(2)}` : "silent"}
                  </span>
                </div>
              ),
            )}
          </div>
        </>
      )}
    </section>
  );
}

// ---------------------------------------------------------------------------
// The session experience: a controller above two physical decks.
// ---------------------------------------------------------------------------

export default function SessionExperience({ sessionId }: { sessionId: string }) {
  const [session, setSession] = useState<SessionDetail | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [library, setLibrary] = useState<LibraryTrackOption[]>([]);
  const [addTrackId, setAddTrackId] = useState("");
  const [status, setStatus] = useState<string | null>(null);
  const [saveState, setSaveState] = useState<"saved" | "saving" | "error">("saved");
  const [handoffConfirm, setHandoffConfirm] = useState(false);
  const [handoffBusy, setHandoffBusy] = useState(false);
  const handoffInFlight = useRef(false);
  const [handoff, setHandoff] = useState<StudioHandoffResult | null>(null);

  // Which session track id is current; the ACTIVE physical deck plays it,
  // the other physical deck pre-loads the next track.
  const [currentId, setCurrentId] = useState<string | null>(null);
  const [activeDeck, setActiveDeck] = useState<0 | 1>(0);
  const [phase, setPhase] = useState<FadePhase>("idle");
  const [mixes, setMixes] = useState<Record<string, Record<string, number>>>({});
  const [transitions, setTransitions] = useState<Record<string, TransitionConfig>>({});

  const activeDeckRef = useRef<0 | 1>(0);
  const transitionRequest = useRef(0);
  const startingRef = useRef(false);
  const startingIdentity = useRef<TransitionIdentity | null>(null);
  const decksRef = useRef<Array<DeckApi | null>>([null, null]);
  const fadeRef = useRef<{ raf: number; t0: number; fromDeck: 0 | 1; toDeck: 0 | 1; cfg: TransitionConfig; fromMix: Record<string, number>; fromId: string; toId: string } | null>(null);
  const completedCue = useRef<{ fromId: string; transition: TransitionConfig } | null>(null);
  const cueSave = useRef<Promise<boolean>>(Promise.resolve(true));
  const advancingRef = useRef(false);
  const [positionsByDeck, setPositionsByDeck] = useState<[number, number]>([0, 0]);
  const [playingByDeck, setPlayingByDeck] = useState<[boolean, boolean]>([false, false]);
  const sessionRef = useRef<SessionDetail | null>(null);
  const currentIdRef = useRef<string | null>(null);
  const activateDeck = useCallback((id: string, deck: 0 | 1) => {
    // Persistence callbacks in this same event must see the new identity,
    // not the previous render's current track/deck pair.
    currentIdRef.current = id;
    activeDeckRef.current = deck;
    setCurrentId(id);
    setActiveDeck(deck);
  }, []);
  // Mirrors for callbacks/effects only — never read during render.
  useEffect(() => {
    sessionRef.current = session;
  }, [session]);
  useEffect(() => {
    currentIdRef.current = currentId;
  }, [currentId]);

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
  const activeDeckIndex: 0 | 1 = activeDeck;
  const standbyDeckIndex: 0 | 1 = activeDeck === 0 ? 1 : 0;
  const currentTransition = currentItem ? transitions[currentItem.id] ?? currentItem.transition : null;

  // ------------------------------------------------------------------- load
  useEffect(() => {
    const timer = setTimeout(() => {
      void (async () => {
        const [sessionResponse, libraryResponse] = await Promise.all([
          fetch(`/api/library/sessions/${sessionId}`, { cache: "no-store" }),
          fetch("/api/library/tracks", { cache: "no-store" }),
        ]);
        if (sessionResponse.status === 404) {
          setLoadError("That session no longer exists.");
          return;
        }
        if (!sessionResponse.ok) {
          setLoadError("The session could not be loaded right now.");
          return;
        }
        const detail = (await sessionResponse.json()).session as SessionDetail;
        setSession(detail);
        // Restore the saved point: which track was current, and where.
        const restoredCurrent =
          detail.currentSessionTrackId !== null &&
          detail.tracks.some((item) => item.id === detail.currentSessionTrackId)
            ? detail.currentSessionTrackId
            : (detail.tracks[0]?.id ?? null);
        setCurrentId(restoredCurrent);
        const nextMixes: Record<string, Record<string, number>> = {};
        const nextTransitions: Record<string, TransitionConfig> = {};
        for (const item of detail.tracks) {
          nextMixes[item.id] = { ...item.stemMix };
          nextTransitions[item.id] = item.transition;
        }
        setMixes(nextMixes);
        setTransitions(nextTransitions);
        if (libraryResponse.ok) setLibrary(((await libraryResponse.json()).tracks ?? []) as LibraryTrackOption[]);
      })();
    }, 0);
    return () => clearTimeout(timer);
  }, [sessionId]);

  // Deck assignment: the active deck holds the current track; the standby
  // deck pre-loads the NEXT track so a transition is always one gesture away.
  const deckItems = useMemo<[SessionTrackItem | null, SessionTrackItem | null]>(
    () =>
      activeDeck === 0
        ? [currentItem, nextItem]
        : [nextItem, currentItem],
    [activeDeck, currentItem, nextItem],
  );

  // The saved restore position applies once, to the deck that loads the
  // saved track (startAtFor keys off the session's saved current-track id).
  const startAtFor = useCallback(
    (deckIndex: number): number => {
      const item = deckItems[deckIndex];
      if (item !== null && session !== null && item.id === session.currentSessionTrackId) {
        return session.positionSeconds;
      }
      return 0;
    },
    [deckItems, session],
  );

  // Active swaps, keyed by the CURRENT session track: stemType → donor asset.
  const activeSwaps = useMemo(() => {
    const map: Record<string, string> = {};
    if (session === null || currentItem === null) return map;
    for (const swap of session.swaps) {
      if (swap.sessionTrackId !== currentItem.id) continue;
      const donor = session.tracks.find((t) => t.track.id === swap.toTrackId);
      const donorStem = donor?.stems.find((s) => s.stemType === swap.stemType);
      if (donorStem) map[swap.stemType] = donorStem.id;
    }
    return map;
  }, [session, currentItem]);

  const handleDeckApi = useCallback((deckIndex: number, api: DeckApi | null) => {
    decksRef.current[deckIndex] = api;
  }, []);

  const handleDeckPlaying = useCallback((deckIndex: number, playing: boolean) => {
    setPlayingByDeck((prev) => {
      if (prev[deckIndex] === playing) return prev;
      const next: [boolean, boolean] = [prev[0], prev[1]];
      next[deckIndex] = playing;
      return next;
    });
  }, []);

  const handleDeckPosition = useCallback((index: number, seconds: number) => {
    setPositionsByDeck((previous) => previous[index] === seconds ? previous : index === 0 ? [seconds, previous[1]] : [previous[0], seconds]);
  }, []);

  // ------------------------------------------------------------ persistence
  const persistState = useCallback(async () => {
    const s = sessionRef.current;
    const id = currentIdRef.current;
    if (s === null) return;
    const deck = decksRef.current[activeDeckRef.current];
    const position = deck?.transport.currentPosition() ?? 0;
    setSaveState("saving");
    try {
      const response = await fetch(`/api/library/sessions/${s.id}/state`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ currentSessionTrackId: id, positionSeconds: position }),
      });
      setSaveState(response.ok ? "saved" : "error");
    } catch {
      setSaveState("error");
    }
  }, []);

  // Throttled save while playing + on unload. Live transport never waits on it.
  const persistStateRef = useRef(persistState);
  useEffect(() => {
    persistStateRef.current = persistState;
  }, [persistState]);
  useEffect(() => {
    const interval = window.setInterval(() => {
      void persistStateRef.current();
    }, 10000);
    const onUnload = () => void persistStateRef.current();
    window.addEventListener("beforeunload", onUnload);
    return () => {
      window.clearInterval(interval);
      window.removeEventListener("beforeunload", onUnload);
    };
  }, []);

  // Debounced per-track mix + transition persistence.
  useEffect(() => {
    if (session === null || currentItem === null) return;
    const timer = setTimeout(() => {
      void fetch(`/api/library/sessions/${session.id}/tracks/${currentItem.id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          stemMix: mixes[currentItem.id] ?? currentItem.stemMix,
          transition: transitions[currentItem.id] ?? currentItem.transition,
        }),
      });
    }, 600);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- debounce per current track's controls
  }, [session?.id, currentItem?.id, mixes, transitions]);

  // Apply the current mix to the active deck whenever it changes (and to the
  // standby deck so a transition fades in what you hear while setting it up).
  useEffect(() => {
    const activeApi = decksRef.current[activeDeckIndex];
    if (activeApi && currentItem) activeApi.applyStemVolumes(mixes[currentItem.id] ?? {});
  }, [mixes, currentItem, activeDeckIndex]);
  useEffect(() => {
    const standbyApi = decksRef.current[standbyDeckIndex];
    if (standbyApi && nextItem) standbyApi.applyStemVolumes(mixes[nextItem.id] ?? {});
  }, [mixes, nextItem, standbyDeckIndex]);

  // -------------------------------------------------------- transition core
  const abortTransition = useCallback((message: string) => {
    transitionRequest.current += 1;
    startingRef.current = false;
    startingIdentity.current = null;
    const fade = fadeRef.current;
    if (fade) {
      cancelAnimationFrame(fade.raf);
      decksRef.current[fade.fromDeck]?.applyStemVolumes(fade.fromMix);
    }
    fadeRef.current = null;
    for (const deck of decksRef.current) { deck?.transport.pause(); deck?.transport.setMasterVolume(1); }
    setPhase("idle");
    setStatus(message);
  }, []);

  const finishTransition = useCallback((cut?: TransitionIdentity, naturalCompletion = false) => {
    const fade = fadeRef.current;
    const completed = cut ?? fade;
    if (completed === null || completed === undefined || advancingRef.current) return;
    const toApi = decksRef.current[completed.toDeck];
    if (currentIdRef.current !== completed.fromId || toApi?.itemId !== completed.toId) return;
    advancingRef.current = true;
    const recorded = completedCue.current;
    completedCue.current = null;
    if (recorded && (cut || naturalCompletion)) {
      setTransitions((previous) => ({ ...previous, [recorded.fromId]: recorded.transition }));
      const sessionId = sessionRef.current?.id;
      if (sessionId) cueSave.current = fetch(`/api/library/sessions/${sessionId}/tracks/${recorded.fromId}`, {
        method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ transition: recorded.transition }),
      }).then((response) => { if (!response.ok) throw new Error("save rejected"); return true; }).catch(() => {
        setStatus("Playback advanced, but the completed transition could not be saved. Keep this session open and retry Send to Studio to save its visible cues."); return false;
      });
    } else if (recorded) {
      // A forced early finish truncates the envelope, rather than performing
      // the requested full ramp. Do not label it a captured linear fade.
      setTransitions((previous) => ({ ...previous, [recorded.fromId]: { ...recorded.transition, cue: undefined } }));
    }
    if (fade) cancelAnimationFrame(fade.raf);
    fadeRef.current = null;
    const fromApi = decksRef.current[completed.fromDeck];
    fromApi?.transport.pause();
    fromApi?.transport.setMasterVolume(1);
    toApi.transport.setMasterVolume(1);
    setPhase("idle");
    activateDeck(completed.toId, completed.toDeck);
    setStatus("Transition complete — the next track is now current.");
    void persistStateRef.current();
  }, [activateDeck]);

  const runFade = useCallback(
    (cfg: TransitionConfig, fromDeck: 0 | 1, toDeck: 0 | 1) => {
      const fromApi = decksRef.current[fromDeck];
      const toApi = decksRef.current[toDeck];
      const fromItem = deckItems[fromDeck];
      if (fromApi === null || toApi === null || fromItem === null) return;
      // Empty saved mix means unity for every audible layer, not an empty
      // envelope. Source-only tracks have no stem rows at all.
      const fromMix: Record<string, number> = {};
      for (const assetId of fromItem.playback?.assetIds ?? []) {
        const type = fromItem.stems.find((stem) => stem.id === assetId)?.stemType ?? "source";
        fromMix[type] = mixes[fromItem.id]?.[type] ?? 1;
      }
      const t0 = performance.now();
      const tick = () => {
        const fade = fadeRef.current;
        if (fade === null) return;
        const from = decksRef.current[fromDeck], to = decksRef.current[toDeck];
        if (from?.itemId !== fade.fromId || to?.itemId !== fade.toId || !from.transport.isPlaying() || !to.transport.isPlaying()) {
          abortTransition("Transition interrupted by unavailable or stopped audio. Press Play to recover the current track.");
          return;
        }
        const elapsed = (performance.now() - t0) / 1000;
        const env = crossfadeEnvelope(elapsed, cfg.crossfadeSeconds);
        const kept = new Set(cfg.keepStems);
        const scaled: Record<string, number> = {};
        for (const [type, volume] of Object.entries(fromMix)) {
          scaled[type] = kept.has(type) ? volume : volume * env.fromGain;
        }
        decksRef.current[fromDeck]?.applyStemVolumes(scaled);
        decksRef.current[toDeck]?.transport.setMasterVolume(env.toGain);
        if (env.done) {
          finishTransition(undefined, true);
          return;
        }
        fade.raf = requestAnimationFrame(tick);
      };
      fadeRef.current = { raf: 0, t0, fromDeck, toDeck, cfg, fromMix, fromId: fromItem.id, toId: deckItems[toDeck]!.id };
      fadeRef.current.raf = requestAnimationFrame(tick);
      setPhase("fading");
    },
    [deckItems, mixes, finishTransition, abortTransition],
  );

  const beginTransition = useCallback(async (ended = false) => {
    if (fadeRef.current || startingRef.current) return;
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
      setStatus("Add a second track to the session — the next deck is empty.");
      return;
    }
    const savedConfig = transitions[fromItem.id] ?? fromItem.transition;
    const cfg: TransitionConfig = ended ? { ...savedConfig, mode: "manual", crossfadeSeconds: 0 } : savedConfig;
    advancingRef.current = false;

    let startInCurrent = fromApi.transport.currentPosition();
    let incomingOffset = 0;
    if (cfg.mode === "beat" || cfg.mode === "bar") {
      const aligned = beatAlignedTransitionStart(
        fromItem.analysis?.beatGridMs ?? null,
        toItem.analysis?.beatGridMs ?? null,
        startInCurrent * 1000,
        cfg.mode,
      );
      if (!aligned.ok) {
        setStatus(aligned.reason);
        return;
      }
      startInCurrent = (aligned.startInCurrentMs ?? 0) / 1000;
      incomingOffset = (aligned.incomingOffsetMs ?? 0) / 1000;
      setStatus(`${aligned.reason} Fading ${cfg.crossfadeSeconds}s from ${formatClock(startInCurrent)}.`);
    } else if (cfg.mode === "meeting-point") {
      setStatus(
        "Meeting-point mode is stored in this session. V1 performs the crossfade from the current position — section-aware cueing arrives with deeper section evidence.",
      );
    } else {
      setStatus(`Manual crossfade: ${cfg.crossfadeSeconds}s from ${formatClock(startInCurrent)}.`);
    }

    const request = ++transitionRequest.current;
    startingRef.current = true;
    setPhase("starting");
    const identity = { fromDeck, toDeck, fromId: fromItem.id, toId: toItem.id };
    startingIdentity.current = identity;
    const stillCurrent = () => request === transitionRequest.current && currentIdRef.current === fromItem.id
      && decksRef.current[fromDeck]?.itemId === fromItem.id && decksRef.current[toDeck]?.itemId === toItem.id;
    try {
      if (!ended) {
        fromApi.transport.seek(startInCurrent);
        if (!await fromApi.transport.play()) throw new Error("The current track could not start. Check its audio and retry.");
      }
      if (!stillCurrent()) return;
      // Silence the incoming graph before it starts; a crossfade must not
      // briefly play full-volume incoming audio while its promises resolve.
      toApi.transport.setMasterVolume(cfg.crossfadeSeconds > 0 ? 0 : 1);
      toApi.transport.seek(incomingOffset);
      if (!await toApi.transport.play()) throw new Error("The next track could not start. Check its audio and retry.");
      if (!stillCurrent()) return;
      completedCue.current = { fromId: fromItem.id, transition: { ...cfg, keepStems: [...cfg.keepStems], cue: {
        toSessionTrackId: toItem.id, fromDeck, toDeck,
        fromSeconds: ended ? fromItem.track.durationSeconds : fromApi.transport.currentPosition(),
        incomingSeconds: toApi.transport.currentPosition(),
      } } };
      if (cfg.crossfadeSeconds <= 0) finishTransition(identity);
      else runFade(cfg, fromDeck, toDeck);
    } catch (error) {
      if (request === transitionRequest.current) {
        fromApi.transport.pause(); toApi.transport.pause();
        fromApi.transport.setMasterVolume(1); toApi.transport.setMasterVolume(1);
        setPhase("idle");
        setStatus(error instanceof Error ? error.message : "Transition failed. Retry playback.");
      }
    } finally {
      if (request === transitionRequest.current) { startingRef.current = false; startingIdentity.current = null; }
    }
  }, [activeDeck, standbyDeckIndex, deckItems, transitions, runFade, finishTransition]);

  const cancelTransition = useCallback(() => {
    transitionRequest.current += 1;
    if (startingRef.current) {
      abortTransition("Transition start cancelled. Press Play to resume the current track.");
      return;
    }
    const fade = fadeRef.current;
    if (fade === null) return;
    cancelAnimationFrame(fade.raf);
    const elapsed = (performance.now() - fade.t0) / 1000;
    const frozen = crossfadeCancel(elapsed, fade.cfg.crossfadeSeconds);
    const kept = new Set(fade.cfg.keepStems);
    const scaled: Record<string, number> = {};
    for (const [type, volume] of Object.entries(fade.fromMix)) {
      scaled[type] = kept.has(type) ? volume : volume * frozen.fromGain;
    }
    decksRef.current[fade.fromDeck]?.applyStemVolumes(scaled);
    decksRef.current[fade.toDeck]?.transport.setMasterVolume(frozen.toGain);
    fadeRef.current = null;
    setPhase("idle");
    setStatus("Transition frozen — both decks hold their levels. Pause stops both decks; Play recovers the current track.");
  }, [abortTransition]);

  const togglePlay = useCallback(async () => {
    if (phase !== "idle") {
      abortTransition("Transition paused. Press Play to recover the current track.");
      void persistStateRef.current();
      return;
    }
    const api = decksRef.current[activeDeck];
    if (api === null) return;
    if (api.transport.playing) {
      for (const deck of decksRef.current) deck?.transport.pause();
      void persistStateRef.current();
    } else {
      decksRef.current[activeDeck === 0 ? 1 : 0]?.transport.pause();
      api.transport.setMasterVolume(1);
      api.applyStemVolumes(mixes[currentIdRef.current ?? ""] ?? {});
      await api.transport.play();
    }
  }, [activeDeck, phase, abortTransition, mixes]);

  const handleDeckEnded = useCallback((deckIndex: number) => {
    if (phase !== "idle" || startingRef.current || deckIndex !== activeDeckRef.current) return;
    const s = sessionRef.current;
    if (!s) return;
    const decision = nextSessionTrack(s.tracks.map((item) => ({ id: item.id, trackId: item.track.id })), currentIdRef.current);
    if (decision.action === "play") void beginTransition(true);
    else { setStatus("End of session."); void persistStateRef.current(); }
  }, [phase, beginTransition]);

  // Queue changes must invalidate asynchronous starts/fades, not promote a
  // different asset when the requested deck was replaced while loading.
  useEffect(() => {
    if ((startingRef.current || fadeRef.current) && session?.tracks) {
      const identity = fadeRef.current ?? startingIdentity.current;
      if (identity && (deckItems[identity.fromDeck]?.id !== identity.fromId || deckItems[identity.toDeck]?.id !== identity.toId))
        abortTransition("Transition cancelled because its track changed. Press Play to recover.");
    }
  }, [deckItems, session?.tracks, abortTransition]);
  useEffect(() => () => {
    transitionRequest.current += 1;
    const fade = fadeRef.current;
    if (fade) cancelAnimationFrame(fade.raf);
  }, []);

  const seekCurrent = useCallback((seconds: number) => {
    if (phase !== "idle") abortTransition("Transition cancelled for seeking. Press Play to resume.");
    const index = activeDeckRef.current;
    const api = decksRef.current[index];
    api?.transport.seek(seconds);
    // Controlled range input must reflect this event immediately, before the
    // child's transport effect reports its next position to the parent.
    handleDeckPosition(index, api?.transport.currentPosition() ?? 0);
    void persistStateRef.current();
  }, [phase, abortTransition, handleDeckPosition]);
  const stopSession = useCallback(() => {
    abortTransition("Session stopped. Press Play to restart the current track.");
    for (const deck of decksRef.current) deck?.transport.stop();
    void persistStateRef.current();
  }, [abortTransition]);

  // ----------------------------------------------------------- queue edits
  const mutate = useCallback(async (input: RequestInfo, init: RequestInit, apply: (s: SessionDetail) => void) => {
    try {
      const response = await fetch(input, init);
      if (!response.ok) {
        const body = (await response.json().catch(() => null)) as { error?: string } | null;
        setStatus(body?.error ?? "The session change was rejected.");
        return;
      }
      const detail = (await response.json()).session as SessionDetail;
      const nextMixes = { ...mixes };
      const nextTransitions = { ...transitions };
      for (const item of detail.tracks) {
        if (!(item.id in nextMixes)) nextMixes[item.id] = { ...item.stemMix };
        if (!(item.id in nextTransitions)) nextTransitions[item.id] = item.transition;
      }
      setMixes(nextMixes);
      setTransitions(nextTransitions);
      setSession(detail);
      apply(detail);
    } catch {
      setStatus("The session change could not be saved.");
    }
  }, [mixes, transitions]);

  const addTrack = useCallback(() => {
    if (addTrackId === "" || session === null) return;
    void mutate(
      `/api/library/sessions/${session.id}/tracks`,
      { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ trackId: addTrackId }) },
      () => setStatus("Track added to the session."),
    );
    setAddTrackId("");
  }, [addTrackId, session, mutate]);

  const jumpTo = useCallback(
    (itemId: string) => {
      abortTransition("Changing the current track.");
      const api = decksRef.current[activeDeck];
      api?.transport.seek(0);
      activateDeck(itemId, activeDeck);
      setStatus("Jumped — the current deck now plays the selected track.");
      void persistStateRef.current();
    },
    [abortTransition, activeDeck, activateDeck],
  );

  const moveTrack = useCallback(
    (itemId: string, position: number) => {
      if (session === null) return;
      void mutate(
        `/api/library/sessions/${session.id}/tracks`,
        { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ sessionTrackId: itemId, position }) },
        () => undefined,
      );
    },
    [session, mutate],
  );

  const removeTrack = useCallback(
    (itemId: string) => {
      if (session === null) return;
      void mutate(
        `/api/library/sessions/${session.id}/tracks?sessionTrackId=${itemId}`,
        { method: "DELETE" },
        (detail) => {
          if (currentIdRef.current === itemId) {
            setCurrentId(detail.tracks[0]?.id ?? null);
          }
        },
      );
    },
    [session, mutate],
  );

  // ------------------------------------------------------------------ swaps
  const requestSwap = useCallback(
    (stemType: string) => {
      if (session === null || currentItem === null || nextItem === null) return;
      const validation = validateStemSwap(currentItem.stems, nextItem.stems, stemType);
      if (!validation.ok) {
        setStatus(validation.reason);
        return;
      }
      void mutate(
        `/api/library/sessions/${session.id}/swaps`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            sessionTrackId: currentItem.id,
            stemType,
            toTrackId: nextItem.track.id,
            atSeconds: decksRef.current[activeDeck]?.transport.position ?? 0,
          }),
        },
        () =>
          setStatus(
            `Swap saved: “${stemType}” from “${nextItem.track.title}” joins the deck clock when its audio is ready. A failed load is reported on the deck.`,
          ),
      );
    },
    [session, currentItem, nextItem, mutate, activeDeck],
  );

  const revertSwap = useCallback(
    (swapId: string) => {
      if (session === null) return;
      void mutate(
        `/api/library/sessions/${session.id}/swaps?swapId=${swapId}`,
        { method: "DELETE" },
        () => setStatus("Swap reverted — the original stem layer is back."),
      );
    },
    [session, mutate],
  );

  // -------------------------------------------------------- studio handoff
  const sendToStudio = useCallback((mode: "transitions" | "sequential" = "transitions") => {
    if (session === null || handoffInFlight.current) return;
    handoffInFlight.current = true;
    setHandoffBusy(true);
    void (async () => {
      try {
        await cueSave.current;
        const response = await fetch(`/api/library/sessions/${session.id}/studio-handoff`, {
          method: "POST", headers: { "content-type": "application/json" },
          body: JSON.stringify({ mode, trackEdits: session.tracks.map((item) => ({
            id: item.id, stemMix: mixes[item.id] ?? item.stemMix, transition: transitions[item.id] ?? item.transition,
          })) }),
        });
        if (!response.ok) {
          const body = (await response.json().catch(() => null)) as { error?: string } | null;
          setStatus(body?.error ?? "The Studio handoff failed.");
          return;
        }
        const result = (await response.json()).handoff as StudioHandoffResult;
        setHandoff(result);
        setHandoffConfirm(false);
        setStatus("Session sent to Studio as a derived arrangement — the sources are untouched.");
      } catch {
        setStatus("The Studio handoff could not be saved. Your listening session remains available; retry when the service recovers.");
      } finally {
        handoffInFlight.current = false;
        setHandoffBusy(false);
      }
    })();
  }, [session, mixes, transitions]);

  // ------------------------------------- hardware media keys (P4, standard path)
  // The same OS/hardware media commands as the player, driving the session's
  // EXISTING controls. The session engine stays authoritative.
  const previousItem = currentIndex > 0 ? session?.tracks[currentIndex - 1] ?? null : null;
  useHardwareMediaKeys({
    nowPlaying:
      currentItem === null
        ? null
        : {
            title: currentItem.track.title,
            artist: currentItem.track.artist,
            album: null,
            playing: playingByDeck[activeDeck],
          },
    handlers: {
      onPlayPause: () => void togglePlay(),
      onNext: () => {
        if (phase === "fading") finishTransition();
        else if (nextItem !== null) jumpTo(nextItem.id);
      },
      onPrevious: () => {
        if (previousItem !== null) jumpTo(previousItem.id);
      },
    },
  });

  // ---------------------------------------------------- compatibility panel
  const compatibility = useMemo(() => {
    if (currentItem === null || nextItem === null) return null;
    const tempo = tempoCompatibility(currentItem.analysis?.bpm ?? null, nextItem.analysis?.bpm ?? null);
    const key = keyCompatibility(currentItem.analysis?.musicalKey ?? null, nextItem.analysis?.musicalKey ?? null);
    const mode = currentTransition?.mode ?? "manual";
    // REAL / APPROXIMATE / UNAVAILABLE labels from the analyses that exist —
    // deterministic and tested in session-logic; never blurred.
    const evidence = compatibilityEvidence(currentItem.analysis, nextItem.analysis, mode);
    let alignment: { ok: boolean; label: string; reason: string } | null = null;
    if (mode === "beat" || mode === "bar") {
      const aligned = beatAlignedTransitionStart(
        currentItem.analysis?.beatGridMs ?? null,
        nextItem.analysis?.beatGridMs ?? null,
        0,
        mode,
      );
      alignment = { ok: aligned.ok, label: aligned.ok ? "Aligned start available" : "Alignment unavailable", reason: aligned.reason };
    } else if (mode === "meeting-point") {
      alignment = {
        ok: false,
        label: "Meeting-point mode",
        reason: "Stored in the session data; V1 crossfades from the current position.",
      };
    }
    return { tempo, key, alignment, evidence };
  }, [currentItem, nextItem, currentTransition]);

  // ---------------------------------------------------------------- render
  if (loadError !== null) {
    return (
      <section className="session-stage" aria-label="Session unavailable">
        <p className="sess-status">{loadError}</p>
        <Link className="button secondary" href="/waveyard/sessions">Back to sessions</Link>
      </section>
    );
  }
  if (session === null) {
    return (
      <section className="session-stage" aria-label="Loading session">
        <p className="sess-status">Loading session…</p>
      </section>
    );
  }

  const playing = playingByDeck[activeDeck];
  const mix = currentItem ? mixes[currentItem.id] ?? {} : {};
  const transition = currentTransition;
  const keepSet = new Set(transition?.keepStems ?? []);

  const setMixValue = (stemType: string, value: number) => {
    if (currentItem === null) return;
    setMixes((prev) => ({ ...prev, [currentItem.id]: { ...prev[currentItem.id], [stemType]: value } }));
  };
  const toggleKeep = (stemType: string) => {
    if (currentItem === null) return;
    setTransitions((prev) => {
      const cfg = prev[currentItem.id] ?? currentItem.transition;
      const kept = new Set(cfg.keepStems);
      if (kept.has(stemType)) kept.delete(stemType);
      else kept.add(stemType);
      return { ...prev, [currentItem.id]: { ...cfg, cue: undefined, keepStems: [...kept] } };
    });
  };
  const setTransition = (patch: Partial<TransitionConfig>) => {
    if (currentItem === null) return;
    setTransitions((prev) => {
      const cfg = prev[currentItem.id] ?? currentItem.transition;
      return { ...prev, [currentItem.id]: { ...cfg, cue: undefined, ...patch } };
    });
  };

  const mixControls = currentItem !== null && currentItem.stems.length > 0 && (
            <div className="sess-mix">
              <h4 className="library-panel-title">Stem mix — current track</h4>
              {currentItem.stems.map((stem) => {
                const swap = session.swaps.find(
                  (s) => s.sessionTrackId === currentItem.id && s.stemType === stem.stemType,
                );
                const swapReady = validateStemSwap(currentItem.stems, nextItem?.stems ?? [], stem.stemType);
                return (
                  <div key={stem.id} className="sess-mix-row">
                    <label className="sess-mix-label" htmlFor={`sess-mix-${stem.id}`}>
                      {laneDisplayName(stem, currentItem.stems)}
                      {swap !== undefined ? " (swapped)" : ""}
                    </label>
                    <input
                      id={`sess-mix-${stem.id}`}
                      type="range"
                      min={0}
                      max={2}
                      step={0.01}
                      value={mix[stem.stemType] ?? 1}
                      onChange={(event) => setMixValue(stem.stemType, Number(event.target.value))}
                    />
                    <span className="sess-mix-value">{(mix[stem.stemType] ?? 1).toFixed(2)}</span>
                    {nextItem !== null && (
                      <button
                        type="button"
                        className="button tiny"
                        onClick={() =>
                          swap !== undefined ? revertSwap(swap.id) : swapReady.ok ? requestSwap(stem.stemType) : setStatus(swapReady.reason)
                        }
                        title={swapReady.ok ? `Swap this layer with “${nextItem.track.title}”` : swapReady.reason}
                      >
                        {swap !== undefined ? "Revert" : "Swap"}
                      </button>
                    )}
                  </div>
                );
              })}
            </div>
          );

  return (
    <section className="session-stage" aria-label={`Session · ${session.name}`} data-testid="session-stage">
      <header className="sess-header">
        <div>
          <span className="eyebrow">Session</span>
          <h1>{session.name}</h1>
          <p className="sess-header-sub">
            {session.tracks.length} track{session.tracks.length === 1 ? "" : "s"}
            {` · restore point ${saveState === "saved" ? "saved" : saveState === "saving" ? "saving…" : "save failed"}`}
          </p>
        </div>
        <div className="sess-header-actions">
          <button type="button" className="button" onClick={() => void togglePlay()} data-testid="session-play">
            {playing ? "Pause" : "Play"}
          </button>
          <button type="button" className="button secondary" onClick={stopSession} data-testid="session-stop">Stop</button>
          <label>Position
            <input type="range" aria-label="Session position" min={0} max={currentItem?.track.durationSeconds ?? 0} step={0.1}
              value={positionsByDeck[activeDeck]} onChange={(event) => seekCurrent(Number(event.target.value))} />
          </label>
          <button type="button" className="button secondary" onClick={() => setHandoffConfirm(true)} disabled={handoffBusy} data-testid="session-handoff">
            Send to Studio
          </button>
          <Link className="button secondary" href="/waveyard/sessions">All sessions</Link>
        </div>
      </header>

      {status !== null && (
        <p className="sess-status" role="status" data-testid="session-status">
          {status}
        </p>
      )}
      {handoffConfirm && (
        <div role="dialog" aria-modal="false" aria-labelledby="studio-handoff-title" className="sess-handoff" data-testid="handoff-confirmation">
          <h3 id="studio-handoff-title">Create a Studio arrangement?</h3>
          <p>Completed transitions preserve physical deck/track identity, cue timing, source ranges, hard cuts, crossfades, held stems, saved levels and timed donor swaps. Play each transition once before using this option. Pauses, seeks, cancelled or forced-shortened fades and live mix gestures are not a performance recording; the source cursor remains a bookmark, not live playback. An explicit sequential edit is also available without transitions. Your session and original audio remain available.</p>
          <button type="button" className="button primary" onClick={() => sendToStudio("transitions")} disabled={handoffBusy} data-testid="handoff-transitions">{handoffBusy ? "Saving and creating…" : "Preserve completed transitions"}</button>
          <button type="button" className="button secondary" onClick={() => sendToStudio("sequential")} disabled={handoffBusy}>Create sequential Studio edit</button>
          <button type="button" className="button secondary" onClick={() => setHandoffConfirm(false)} disabled={handoffBusy}>Keep listening session</button>
        </div>
      )}
      {handoff !== null && (
        <p className="sess-handoff" role="status">
          Studio arrangement created with {handoff.remixTrackCount} remix track{handoff.remixTrackCount === 1 ? "" : "s"}
          {handoff.refused ? ` — Not included: ${handoff.refused}` : ""}
          {handoff.notice ? ` ${handoff.notice}` : ""}
          {" "}
          <Link href={`/waveyard/projects/${handoff.projectId}`}>Open it in the Studio</Link>.
        </p>
      )}

      <div className="sess-decks">
        {([0, 1] as const).map((index) => (
          <div key={index} className={`sess-deck-slot${index === activeDeck ? " sess-deck-slot-active" : ""}`} style={{ order: index === activeDeck ? 0 : 2 }}>
            <SessionDeck deckIndex={index} item={deckItems[index]} active={index === activeDeck}
              startAt={index === activeDeck ? startAtFor(index) : 0} swaps={index === activeDeck ? activeSwaps : {}}
              onApi={handleDeckApi} onPlaying={handleDeckPlaying} onPosition={handleDeckPosition} onEnded={handleDeckEnded}
              testId={index === activeDeck ? "session-deck-current" : "session-deck-next"} />
            {index === activeDeck ? mixControls : null}
          </div>
        ))}

        <div className="sess-transition" aria-label="Transition controls" style={{ order: 1 }}>
          <h4 className="library-panel-title">Transition into the next track</h4>
          {transition !== null && (
            <>
              <div className="sess-transition-row">
                <label htmlFor="sess-mode">Mode</label>
                <select
                  id="sess-mode"
                  value={transition.mode}
                  onChange={(event) => setTransition({ mode: event.target.value as TransitionMode })}
                >
                  <option value="manual">Manual crossfade</option>
                  <option value="beat">Beat-aligned</option>
                  <option value="bar">Bar-aligned</option>
                  <option value="meeting-point">Meeting point (stored)</option>
                </select>
              </div>
              <div className="sess-transition-row">
                <label htmlFor="sess-fade">Crossfade</label>
                <input
                  id="sess-fade"
                  type="range"
                  min={0}
                  max={15}
                  step={0.5}
                  value={transition.crossfadeSeconds}
                  onChange={(event) => setTransition({ crossfadeSeconds: Number(event.target.value) })}
                />
                <span>
                  {transition.crossfadeSeconds === 0 ? "hard cut" : `${transition.crossfadeSeconds.toFixed(1)}s`}
                </span>
              </div>
              {currentItem !== null && currentItem.stems.length > 0 && (
                <fieldset className="sess-keep">
                  <legend>Keep from current</legend>
                  {currentItem.stems.map((stem) => (
                    <label key={stem.id} className="sess-keep-option">
                      <input
                        type="checkbox"
                        checked={keepSet.has(stem.stemType)}
                        onChange={() => toggleKeep(stem.stemType)}
                      />
                      {stem.stemType}
                    </label>
                  ))}
                </fieldset>
              )}
              <div className="sess-transition-actions">
                {phase !== "idle" ? (
                  <>
                    <button type="button" className="button secondary" onClick={cancelTransition}>
                      {phase === "starting" ? "Cancel start" : "Freeze"}
                    </button>
                    <button type="button" className="button" disabled={phase === "starting"} onClick={() => finishTransition()}>
                      Finish now
                    </button>
                  </>
                ) : (
                  <button
                    type="button"
                    className="button"
                    onClick={() => void beginTransition()}
                    disabled={nextItem === null}
                    data-testid="session-transition"
                  >
                    Start transition
                  </button>
                )}
              </div>
            </>
          )}
          {compatibility !== null && (
            <div className="sess-compat" data-testid="session-compat">
              <h4 className="library-panel-title">Compatibility</h4>
              <p className={compatibility.tempo.compatible ? "sess-compat-ok" : "sess-compat-bad"}>
                <b className={`sess-evidence sess-evidence-${compatibility.evidence.tempo.level}`} title={compatibility.evidence.tempo.label}>
                  Tempo · {compatibility.evidence.tempo.level.toUpperCase()}
                </b>{" "}
                {compatibility.tempo.reason}
              </p>
              <p className={compatibility.key.compatible ? "sess-compat-ok" : "sess-compat-bad"}>
                <b className={`sess-evidence sess-evidence-${compatibility.evidence.key.level}`} title={compatibility.evidence.key.label}>
                  Key · {compatibility.evidence.key.level.toUpperCase()}
                </b>{" "}
                {compatibility.key.reason}
              </p>
              {compatibility.alignment !== null && compatibility.evidence.alignment !== null && (
                <p className={compatibility.alignment.ok ? "sess-compat-ok" : "sess-compat-bad"}>
                  <b
                    className={`sess-evidence sess-evidence-${compatibility.evidence.alignment.level}`}
                    title={compatibility.evidence.alignment.label}
                  >
                    Alignment · {compatibility.evidence.alignment.level.toUpperCase()}
                  </b>{" "}
                  {compatibility.alignment.reason}
                </p>
              )}
            </div>
          )}
        </div>


      </div>

      {/* P4: the real Stem2 hardware surface — output routing + honest caps.
          The session engine keeps playing through any output change. */}
      <Stem2Panel />

      <aside className="sess-queue" aria-label="Session tracks">
        <h4 className="library-panel-title">Session order</h4>
        <ol className="sess-queue-list">
          {session.tracks.map((item, index) => (
            <li
              key={item.id}
              className={`sess-queue-item${item.id === currentItem?.id ? " current" : ""}${item.id === nextItem?.id ? " next" : ""}`}
            >
              <button type="button" className="sess-queue-jump" onClick={() => jumpTo(item.id)}>
                <span className="sess-queue-pos">{index + 1}</span>
                <span>
                  {item.track.title}
                  <small>
                    {item.track.artist || "Unknown artist"}
                    {item.id === currentItem?.id ? " · current" : item.id === nextItem?.id ? " · next" : ""}
                  </small>
                </span>
              </button>
              <span className="sess-queue-actions">
                <button type="button" className="button tiny" aria-label={`Move ${item.track.title} earlier`} disabled={index === 0} onClick={() => moveTrack(item.id, index - 1)}>↑</button>
                <button type="button" className="button tiny" aria-label={`Move ${item.track.title} later`} disabled={index === session.tracks.length - 1} onClick={() => moveTrack(item.id, index + 1)}>↓</button>
                <button type="button" className="button tiny" aria-label={`Remove ${item.track.title}`} onClick={() => removeTrack(item.id)}>✕</button>
              </span>
            </li>
          ))}
        </ol>
        <div className="sess-queue-add">
          <label htmlFor="sess-add">Add a track from your library</label>
          <div className="sess-queue-add-row">
            <select id="sess-add" value={addTrackId} onChange={(event) => setAddTrackId(event.target.value)}>
              <option value="">Choose a track…</option>
              {library.map((option) => (
                <option key={option.id} value={option.id}>
                  {option.title} — {option.artist || "Unknown artist"}
                </option>
              ))}
            </select>
            <button type="button" className="button" onClick={addTrack} disabled={addTrackId === ""} data-testid="session-add-track">
              Add
            </button>
          </div>
        </div>
      </aside>
    </section>
  );
}
