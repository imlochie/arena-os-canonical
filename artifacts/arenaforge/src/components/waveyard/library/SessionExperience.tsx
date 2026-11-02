"use client";

import Link from "@/routing/Link";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { LibraryTrackSummary } from "@workspace/api-client-react";
import {
  useStemTransport,
  normalizeSessionPlaybackRate,
  SESSION_PLAYBACK_RATE_MAX,
  SESSION_PLAYBACK_RATE_MIN,
  type ChannelMeter,
  type MixerValues,
} from "@workspace/arena/lib/waveyard/useStemTransport";
import { nextSessionBeatLoop, SESSION_DJ_LOOP_LENGTHS } from "@workspace/arena/lib/waveyard/session-dj-controls";
import { useHardwareMediaKeys } from "@workspace/arena/lib/waveyard/stem2";
import { isMultiPassSeparationPhase } from "@workspace/arena/lib/waveyard/library/model";
import Stem2Panel from "@/components/waveyard/stem2/Stem2Panel";
import CamelotWheel from "./CamelotWheel";
import LiveStemSwapPicker, {
  type LiveStemDonorOption,
  type LiveStemPreparationOption,
} from "./LiveStemSwapPicker";
import LocalSessionPairing from "./LocalSessionPairing";
import type { LocalRemoteCommand } from "./local-session-crypto";
import {
  automaticCueTiming,
  automaticTransitionCue,
  beatAlignedTransitionStart,
  compatibilityEvidence,
  crossfadeCancel,
  crossfadeEnvelope,
  keyCompatibility,
  liveStemTempoStretchRatio,
  nextSessionTrack,
  scaleCrossfadeStemVolumes,
  tempoCompatibility,
  validateStemSwap,
  type TransitionConfig,
  type TransitionMode,
} from "@workspace/arena/lib/waveyard/library/session-logic";
import {
  defaultPerformance,
  PERFORMANCE_MINIMUM_LEAD_SECONDS,
  nextPerformanceBoundary,
  performMix,
  performanceTick,
  type PerformanceAction,
  type PerformanceSettings,
  type PerformanceSnap,
} from "@workspace/arena/lib/waveyard/library/performance";
import {
  publishWaveyardQueueChange,
  publishWaveyardTransportChange,
  subscribeToWaveyardQueueChanges,
  subscribeToWaveyardResume,
  type WaveyardRemoteTransport,
} from "./queue-sync";

// ---------------------------------------------------------------------------
// Types mirrored from the session API payload.
// ---------------------------------------------------------------------------

interface SessionTrackItem {
  id: string;
  position: number;
  queueItemId: string | null;
  track: { id: string; title: string; artist: string; durationSeconds: number };
  sourceAssetId: string | null;
  stems: Array<{ id: string; stemType: string; engine: string; durationSeconds: number }>;
  playback: { assetIds: string[]; kind: "stems" | "source" } | null;
  playbackPreference: "source" | "stems" | null;
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
    fromStemAssetId: string | null;
    toStemAssetId: string | null;
    atSeconds: number;
    createdAt: string;
    donorTrack?: {
      id: string;
      title: string;
      stems: Array<{ id: string; stemType: string; durationSeconds: number }>;
    } | null;
  }>;
  createdAt: string;
  updatedAt: string;
}

function stemsPlaybackTarget(item: SessionTrackItem): SessionTrackItem | null {
  const stems = item.stems.filter((stem) => stem.engine !== "passthrough-unseparated");
  if (stems.length === 0) return null;
  return {
    ...item,
    playback: { kind: "stems", assetIds: stems.map((stem) => stem.id) },
    playbackPreference: "stems",
  };
}

interface PendingLiveSwap {
  swapId: string;
  sessionTrackId: string;
  stemType: string;
  donorTitle: string;
  savePending?: boolean;
  cancelRequested?: boolean;
  retryDonor: {
    id: string;
    title: string;
    stems?: SessionTrackItem["stems"];
    bpm?: number | null;
  };
  previousSwap?: SessionDetail["swaps"][number];
  failed?: boolean;
}

interface FailedLiveSwap {
  sessionTrackId: string;
  stemType: string;
  message: string;
  donor: PendingLiveSwap["retryDonor"];
}

interface SwapMutationScope {
  sessionTrackId: string;
  stemType: string;
}

interface PendingPerformance {
  itemId: string;
  deckIndex: 0 | 1;
  snap: PerformanceSnap;
  target: number;
  previous: number;
  actions: PerformanceAction[];
}

interface TemporaryIsolation {
  itemId: string;
  stemType: string;
  level: number;
}

type LibraryTrackOption = Pick<LibraryTrackSummary, "id" | "title" | "artist" | "analysis" | "stemAvailability">;

function getStudioTrackReadiness(item: SessionTrackItem, library: LibraryTrackOption[]) {
  const separatedStems = item.stems.filter((stem) => stem.engine !== "passthrough-unseparated");
  if (separatedStems.length > 0) {
    return { ready: true, canUseFullSource: false, label: `Ready · ${separatedStems.length} stems` };
  }
  if (item.stems.some((stem) => stem.engine === "passthrough-unseparated")) {
    return { ready: true, canUseFullSource: false, label: "Ready · full-source audio" };
  }

  const availability = library.find((track) => track.id === item.track.id)?.stemAvailability;
  if (availability?.status === "source-only") {
    return {
      ready: false,
      canUseFullSource: item.sourceAssetId !== null,
      label: item.sourceAssetId === null ? "Source unavailable" : "Full source only · not separated",
    };
  }
  if (availability?.status === "processing") {
    const finishing = availability.stage === "finalizing" || availability.progress?.percent === 100;
    const progress = availability.progress;
    const progressDetail = progress
      ? progress.phase && isMultiPassSeparationPhase(progress.phase)
        ? ` · ${progress.phase}`
        : ` · ${progress.percent}%${progress.phase ? ` · ${progress.phase}` : ""}`
      : "";
    const sourceLabel = item.sourceAssetId === null ? "" : " · full source available";
    const stageLabel = availability.stage === "queued"
      ? "Queued"
      : availability.stage === "preparing"
        ? "Preparing"
        : finishing
          ? "Finishing"
          : "Separating";
    return { ready: false, canUseFullSource: item.sourceAssetId !== null, label: `${stageLabel}${progressDetail}${sourceLabel}` };
  }
  if (availability?.status === "failed" || availability?.status === "rejected") {
    const sourceLabel = item.sourceAssetId === null ? " · retry in Library" : " · full source available";
    return { ready: false, canUseFullSource: item.sourceAssetId !== null, label: `Separation failed${sourceLabel}` };
  }
  if (availability?.status === "unavailable") {
    return {
      ready: false,
      canUseFullSource: item.sourceAssetId !== null,
      label: item.sourceAssetId === null ? "Source unavailable" : "No separated stems · full source available",
    };
  }
  if (availability?.status === "not-started") {
    return {
      ready: false,
      canUseFullSource: false,
      label: item.sourceAssetId === null ? "Source unavailable" : "Separation not started · open Library",
    };
  }
  if (item.sourceAssetId !== null) {
    return { ready: false, canUseFullSource: false, label: "Checking separation status…" };
  }
  return { ready: false, canUseFullSource: false, label: "Source unavailable" };
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
  itemId: string | null;
  transport: ReturnType<typeof useStemTransport>;
  hasStemChannels: boolean;
  applyStemVolumes: (volumes: Record<string, number>) => void;
  preloadStem: (recipientStemId: string, donorStemId: string, tempoStretchRatio: number, selectedAt?: number) => Promise<void>;
  preloadStemAsset: (url: string) => Promise<void>;
  prepareHandoff: (
    target: SessionTrackItem,
    volumes: Record<string, number>,
  ) => Promise<{ position: number; playing: boolean } | null>;
};

type FadePhase = "idle" | "fading";

const SAVE_INTERVAL_MS = 10_000;

function formatClock(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return "0:00";
  const whole = Math.floor(seconds);
  return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, "0")}`;
}

/** Numeric fader state is the audible mix and the value persisted as stemMix. */
function effectiveMix(item: SessionTrackItem | null, levels: Record<string, number> | undefined) {
  const out: Record<string, number> = {};
  if (item === null) return out;
  for (const stem of item.stems) {
    out[stem.stemType] = levels?.[stem.stemType] ?? 1;
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
  swapSelectionTimes,
  tempoStretchRatios,
  masterLevel,
  autoPlay,
  onAutoPlayed,
  levels,
  onLevel,
  performanceSettings,
  playbackRate,
  onPlaybackRateChange,
  pitchPreserving,
  pitchLockBusy,
  pitchLockMessage,
  onPitchPreservingChange,
  onPerformanceAction,
  onSnapChange,
  onInstantRestoreChange,
  onHoldStart,
  onHoldEnd,
  heldStem,
  pendingPerformanceLabel,
  onCancelPendingPerformance,
  performanceDisabled,
  onReset,
  stemExtra,
  openSwapPickerStem,
  onOpenSwapPicker,
  onLiveLayerReady,
  onLiveLayerFailed,
  liveSwapFailure,
  onRetryLiveSwap,
  onReturnToSource,
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
  swapSelectionTimes: Record<string, number>;
  tempoStretchRatios: Record<string, number>;
  masterLevel: number;
  autoPlay: boolean;
  onAutoPlayed: () => void;
  levels: Record<string, number>;
  onLevel: (stemType: string, value: number) => void;
  performanceSettings: PerformanceSettings;
  playbackRate: number;
  onPlaybackRateChange: (value: number) => void;
  pitchPreserving: boolean;
  pitchLockBusy: boolean;
  pitchLockMessage: string | null;
  onPitchPreservingChange: (enabled: boolean) => void;
  onPerformanceAction: (action: PerformanceAction) => void;
  onSnapChange: (snap: PerformanceSnap) => void;
  onInstantRestoreChange: (enabled: boolean) => void;
  onHoldStart: (stemType: string) => void;
  onHoldEnd: () => void;
  heldStem: string | null;
  pendingPerformanceLabel: string | null;
  onCancelPendingPerformance: () => void;
  performanceDisabled: boolean;
  onReset: () => void;
  stemExtra?: (stemType: string) => ReactNode;
  openSwapPickerStem?: string | null;
  onOpenSwapPicker?: (stemType: string) => void;
  onLiveLayerReady?: (sessionTrackId: string, stemType: string) => void;
  onLiveLayerFailed?: (sessionTrackId: string, stemType: string, message: string) => void;
  liveSwapFailure?: string | null;
  onRetryLiveSwap?: () => void;
  onReturnToSource?: () => void;
  onApi: (deckIndex: number, api: DeckApi | null) => void;
  onPlaying: (deckIndex: number, playing: boolean) => void;
  onProgress: (deckIndex: number, position: number) => void;
  onEnded: (deckIndex: number, itemId: string) => void;
}) {
  const assetIds = useMemo(() => item?.playback?.assetIds ?? [], [item?.playback]);
  const duration = item?.track.durationSeconds ?? 0;
  const quickPadLayout = item?.stems.length === 4
    && ["vocals", "drums", "bass", "other"].every((stemType) =>
      item.stems.some((stem) => stem.stemType === stemType),
    )
    ? "four"
    : "grid";
  const [handoffTarget, setHandoffTarget] = useState<SessionTrackItem | null>(null);
  const holdGestureRef = useRef<"pointer" | "keyboard" | null>(null);
  const suppressHoldClickRef = useRef(false);
  const stagingTarget = handoffTarget !== null
    && (handoffTarget.playback?.kind !== item?.playback?.kind
      || JSON.stringify(handoffTarget.playback?.assetIds) !== JSON.stringify(item?.playback?.assetIds))
    ? handoffTarget
    : null;
  const stagedIds = useMemo(
    () => stagingTarget?.playback?.assetIds ?? [],
    [stagingTarget?.playback],
  );
  const transportIds = useMemo(
    () => [...new Set([...assetIds, ...stagedIds])],
    [assetIds, stagedIds],
  );
  // Staged handoff audio must not be treated as a required live channel until
  // the replacement is ready. In particular, a failed donor load must not
  // pause the source that is currently audible.
  const transport = useStemTransport(transportIds, duration, assetIds);
  const [cuePosition, setCuePosition] = useState(0);
  const [selectedLoopBeats, setSelectedLoopBeats] = useState<number | null>(null);
  useEffect(() => {
    transport.setPlaybackRate(playbackRate);
  }, [playbackRate, transport.setPlaybackRate]);
  useEffect(() => {
    setCuePosition(0);
    setSelectedLoopBeats(null);
    transport.setLoop({ enabled: false, start: 0, end: 0 });
  }, [item?.id, transport.setLoop]);
  const selectBeatLoop = (beats: number) => {
    if (transport.loop.enabled && selectedLoopBeats === beats) {
      transport.setLoop({ ...transport.loop, enabled: false });
      setSelectedLoopBeats(null);
      return;
    }
    const range = nextSessionBeatLoop(item?.analysis?.beatGridMs, transport.position, beats);
    if (!range) return;
    transport.setLoop({ enabled: true, ...range });
    setSelectedLoopBeats(beats);
  };
  const mediaElements = useRef<Record<string, HTMLAudioElement | null>>({});
  const pendingHandoff = useRef<{
    target: SessionTrackItem;
    volumes: Record<string, number>;
    fromKind: "source" | "stems";
    resolve: (result: { position: number; playing: boolean } | null) => void;
    running: boolean;
  } | null>(null);
  const [mediaError, setMediaError] = useState<string | null>(null);
  const [loadingLayers, setLoadingLayers] = useState(false);
  const [swapRetry, setSwapRetry] = useState(0);

  const stemTypeByAsset = useMemo(() => {
    const map = new Map<string, string>();
    for (const stem of item?.stems ?? []) map.set(stem.id, stem.stemType);
    for (const stem of stagingTarget?.stems ?? []) map.set(stem.id, stem.stemType);
    return map;
  }, [item?.stems, stagingTarget?.stems]);

  const swapKey = JSON.stringify(assetIds.map((id) => {
    const stemType = stemTypeByAsset.get(id) ?? "source";
    const donor = swaps[stemType] ?? null;
    const selectedAt = donor === null ? null : swapSelectionTimes[stemType] ?? null;
    return [id, donor, donor === null ? 1 : tempoStretchRatios[stemType] ?? 1, selectedAt];
  }));
  useEffect(() => {
    let stale = false;
    const layers = JSON.parse(swapKey) as Array<[string, string | null, number, number | null]>;
    setLoadingLayers(layers.some(([, donor]) => donor !== null));
    const replacements = layers.map(([id, donor, tempoStretchRatio, selectedAt]) => {
      const stemType = stemTypeByAsset.get(id) ?? "source";
      return transport.replaceStem(id, donor ? `/api/assets/${donor}` : null, tempoStretchRatio, selectedAt ?? undefined).then((installed) => {
        if (!stale && installed !== false && donor !== null && item !== null) onLiveLayerReady?.(item.id, stemType);
      }).catch((error: unknown) => {
        if (!stale && donor !== null && item !== null) {
          // The engine returns false for cancellation. Any rejection here is a
          // real preparation failure; roll back only this pending stem.
          const message = error instanceof Error ? error.message : "Live stem loading failed.";
          onLiveLayerFailed?.(item.id, stemType, `${stemType} switch failed: ${message} The previous layer was kept.`);
        }
        throw error;
      });
    });
    // One rejected donor must not mark other preparations complete or cancel
    // their independent audio layers.
    void Promise.allSettled(replacements).then((results) => {
      if (stale) return;
      const failure = results.find((result) => result.status === "rejected");
      setMediaError(failure?.status === "rejected"
        ? `${failure.reason instanceof Error ? failure.reason.message : "Live stem loading failed."} The previous layer was kept.`
        : null);
      setLoadingLayers(false);
    });
    return () => { stale = true; };
  }, [swapKey, stemTypeByAsset, tempoStretchRatios, transport.replaceStem, onLiveLayerReady, onLiveLayerFailed, item?.id, swapRetry]);

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
  const prepareHandoff = useCallback(
    (target: SessionTrackItem, volumes: Record<string, number>) => {
      const targetIds = target.playback?.assetIds ?? [];
      const sourceToStems = item?.playback?.kind === "source"
        && target.playback?.kind === "stems"
        && target.stems.length > 0
        && targetIds.length === target.stems.length
        && target.stems.every((stem) => targetIds.includes(stem.id));
      const stemsToSource = item?.playback?.kind === "stems"
        && target.playback?.kind === "source"
        && target.sourceAssetId !== null
        && targetIds.length === 1
        && targetIds[0] === target.sourceAssetId;
      if (
        item === null
        || target.id !== item.id
        || (!sourceToStems && !stemsToSource)
        || pendingHandoff.current !== null
      ) return Promise.resolve(null);
      return new Promise<{ position: number; playing: boolean } | null>((resolve) => {
        pendingHandoff.current = { target, volumes, fromKind: item.playback?.kind ?? "source", resolve, running: false };
        setMediaError(null);
        setHandoffTarget(target);
      });
    },
    [item],
  );
  useEffect(() => {
    const request = pendingHandoff.current;
    if (request !== null && (
      item === null
      || item.id !== request.target.id
      || item.playback?.kind !== request.fromKind
    )) {
      pendingHandoff.current = null;
      setHandoffTarget(null);
      request.resolve(null);
      return;
    }
    if (
      handoffTarget !== null
      && item?.id === handoffTarget.id
      && item.playback?.kind === handoffTarget.playback?.kind
      && JSON.stringify(item.playback?.assetIds) === JSON.stringify(handoffTarget.playback?.assetIds)
    ) setHandoffTarget(null);
  }, [handoffTarget, item]);
  const finishHandoff = useCallback(async () => {
    const request = pendingHandoff.current;
    if (request === null || request.running) return;
    const targetIds = request.target.playback?.assetIds ?? [];
    const elements = targetIds.map((id) => mediaElements.current[id]);
    if (elements.some((element) => !element || element.readyState < HTMLMediaElement.HAVE_CURRENT_DATA)) return;
    const validElements = elements as HTMLAudioElement[];
    if (validElements.some((element) => !Number.isFinite(element.duration) || element.duration <= 0)) return;
    request.running = true;
    const anchor = assetIds
      .map((id) => mediaElements.current[id])
      .find((element) => element && !element.paused && !element.ended);
    const at = anchor?.currentTime ?? transport.position;
    try {
      transport.seek(at);
      transport.prepareChannels(targetIds);
      // Start the new layers at the recipient's clock while muted. Only after
      // all play promises resolve are the original and replacement gains
      // changed together, avoiding a gap or a doubled section.
      transport.applyMix(Object.fromEntries(targetIds.map((id) => [
        id,
        { volume: 0, pan: 0, muted: false, solo: false },
      ])));
      if (transport.playing) await transport.playChannels(targetIds, at);
      const targetMix: Record<string, MixerValues> = request.target.playback?.kind === "stems"
        ? Object.fromEntries(request.target.stems.map((stem) => [
          stem.id,
          { volume: request.volumes[stem.stemType] ?? 1, pan: 0, muted: false, solo: false },
        ]))
        : Object.fromEntries(targetIds.map((id) => [
          id,
          { volume: 1, pan: 0, muted: false, solo: false },
        ]));
      const handoffMix: Record<string, MixerValues> = {
        ...Object.fromEntries(assetIds.map((id) => [
          id,
          { volume: 0, pan: 0, muted: false, solo: false },
        ])),
        ...targetMix,
      };
      transport.applyMix(handoffMix);
      pendingHandoff.current = null;
      request.resolve({ position: at, playing: transport.playing });
    } catch {
      pendingHandoff.current = null;
      setHandoffTarget(null);
      setMediaError(request.target.playback?.kind === "source"
        ? "The full track could not be prepared. The current stem mix is still playing."
        : "The separated stems could not be prepared. The original track is still playing.");
      request.resolve(null);
    }
  }, [assetIds, transport]);
  useEffect(() => {
    void finishHandoff();
  }, [finishHandoff, stagingTarget]);

  useEffect(() => {
    onApi(deckIndex, {
      itemId: item?.id ?? null,
      transport,
      applyStemVolumes,
      preloadStem: (recipientStemId, donorStemId, ratio, selectedAt) =>
        transport.preloadStem(recipientStemId, `/api/assets/${donorStemId}`, ratio, selectedAt),
      preloadStemAsset: (url) => transport.preloadStemAsset(url),
      hasStemChannels: item?.playback?.kind === "stems" && (item?.stems ?? []).some((stem) => assetIds.includes(stem.id)),
      prepareHandoff,
    });
  }, [deckIndex, transport, item, applyStemVolumes, prepareHandoff, onApi]);
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
  const loadKey = item?.id ?? null;
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
  const anySolo = performanceSettings.isolatedStem !== null;
  const mixChanged = (item?.stems ?? []).some((stem) => Math.abs((levels[stem.stemType] ?? 1) - 1) > 0.001)
    || anySolo;

  return (
    <section
      className={`sess-deck wy-deck${active ? " sess-deck-active" : ""}`}
      style={{ order: active ? 1 : 3 }}
      aria-label={`Deck ${deckIndex === 0 ? "A" : "B"} · ${active ? "current" : "next"} · ${item?.track.title ?? "empty"}`}
      data-testid={`session-deck-${deckIndex === 0 ? "a" : "b"}`}
      data-role={active ? "current" : "next"}
    >
      {transportIds.map((assetId) => {
        const stemType = stemTypeByAsset.get(assetId) ?? "source";
        const donorAssetId = swaps[stemType];
        const isStaged = stagedIds.includes(assetId);
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
              if (isStaged) {
                void finishHandoff();
                return;
              }
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
            onCanPlay={() => { if (isStaged) void finishHandoff(); }}
            onError={() => {
              if (pendingHandoff.current?.target.playback?.assetIds.includes(assetId)) {
                const pending = pendingHandoff.current;
                pendingHandoff.current = null;
                setHandoffTarget(null);
                setMediaError(pending.target.playback?.kind === "source"
                  ? "The full track could not load. The current stem mix is still playing."
                  : "A separated stem could not load. The original track is still playing.");
                pending.resolve(null);
                return;
              }
              setMediaError("An audio asset could not load. Check the connection and try playback again.");
            }}
            onEnded={(event) => {
              // A shorter donor stem must not finish the entire recipient song.
              if (item !== null && event.currentTarget.currentTime >= duration - 0.1) onEnded(deckIndex, item.id);
            }}
          />
        );
      })}
      {loadingLayers && <p className="wy-deck-note" role="status">Preparing live layers — the current audio keeps playing.</p>}
      {stagingTarget?.playback?.kind === "source" && (
        <p className="wy-deck-note" role="status" data-testid="source-handoff-status">Preparing the full track — the stem mix keeps playing.</p>
      )}
      {liveSwapFailure && onRetryLiveSwap ? (
        <button type="button" className="sess-small-btn" onClick={onRetryLiveSwap}>Retry live stems</button>
      ) : mediaError && /previous layer|replacement stem|live stem loading/i.test(mediaError) && (
        <button type="button" className="sess-small-btn" onClick={() => setSwapRetry((n) => n + 1)}>Retry live stems</button>
      )}
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
          {(liveSwapFailure || mediaError || transport.error) && (
            <p role="alert" className="sess-status">{liveSwapFailure ?? mediaError ?? transport.error}</p>
          )}
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
          {active && (
            <div className="wy-session-speed">
              <span>Speed</span>
              <input
                type="range"
                aria-label="Session playback speed"
                aria-valuetext={`${playbackRate.toFixed(2)} times${item.analysis?.bpm == null ? "" : `, ${Math.round(item.analysis.bpm * playbackRate)} BPM`}; pitch ${pitchPreserving ? "preserved" : "follows speed"}`}
                min={SESSION_PLAYBACK_RATE_MIN}
                max={SESSION_PLAYBACK_RATE_MAX}
                step={0.01}
                value={playbackRate}
                onChange={(event) => onPlaybackRateChange(Number(event.target.value))}
                data-testid="session-playback-speed"
              />
              <output data-testid="session-speed-value">{playbackRate.toFixed(2)}×</output>
              <button
                type="button"
                aria-label="Reset playback speed to 1.00x"
                data-testid="session-speed-reset"
                disabled={Math.abs(playbackRate - 1) < 0.001}
                onClick={() => onPlaybackRateChange(1)}
              >
                Reset
              </button>
              <small>
                {item.analysis?.bpm == null
                  ? "Tempo analysis unavailable"
                  : `${Math.round(item.analysis.bpm * playbackRate)} BPM`}
                {` · pitch ${pitchPreserving ? "stays steady" : "follows speed"}`}
              </small>
              <button
                type="button"
                className={`wy-session-pitch-lock${pitchPreserving ? " is-active" : ""}`}
                aria-label="Keep pitch steady during speed changes"
                aria-pressed={pitchPreserving}
                disabled={pitchLockBusy}
                onClick={() => onPitchPreservingChange(!pitchPreserving)}
                data-testid="session-pitch-lock"
              >
                <span aria-hidden="true">{pitchPreserving ? "♫" : "♪"}</span>
                {pitchLockBusy ? "Switching…" : "Keep pitch"}
              </button>
              {pitchLockMessage && (
                <small role="status" data-testid="session-pitch-lock-message">{pitchLockMessage}</small>
              )}
            </div>
          )}
          {active && (
            <div className="wy-dj-controls" role="group" aria-label="DJ cue and loop controls">
              <div className="wy-dj-loop-buttons" role="group" aria-label="Beat loops">
                <span>Loop</span>
                {SESSION_DJ_LOOP_LENGTHS.map((beats) => {
                  const range = nextSessionBeatLoop(item.analysis?.beatGridMs, transport.position, beats);
                  return (
                    <button
                      key={beats}
                      type="button"
                      aria-pressed={transport.loop.enabled && selectedLoopBeats === beats}
                      aria-label={`Loop ${beats} ${beats === 1 ? "beat" : "beats"}`}
                      disabled={!range}
                      onClick={() => selectBeatLoop(beats)}
                      data-testid={`session-loop-${beats}`}
                    >
                      {beats}
                    </button>
                  );
                })}
                <button
                  type="button"
                  disabled={!transport.loop.enabled}
                  onClick={() => {
                    transport.setLoop({ ...transport.loop, enabled: false });
                    setSelectedLoopBeats(null);
                  }}
                  data-testid="session-loop-off"
                >
                  Off
                </button>
              </div>
              <button
                type="button"
                onClick={() => setCuePosition(transport.position)}
                aria-label={`Set cue at ${formatClock(transport.position)}`}
                data-testid="session-set-cue"
              >
                Set cue
              </button>
              <button
                type="button"
                onClick={() => transport.seek(cuePosition)}
                aria-label={`Jump to cue at ${formatClock(cuePosition)}`}
                data-testid="session-return-cue"
              >
                Cue {formatClock(cuePosition)}
              </button>
              <small>
                {item.analysis?.beatGridMs?.length
                  ? "Loops enter on the next analyzed beat."
                  : "Analyze this track to enable beat loops."}
              </small>
            </div>
          )}
          {!active && <p className="wy-deck-note">Seeking here only previews the cue; a beat/bar transition re-cues from the grid.</p>}
          {!separated ? (
            <p className="wy-deck-note">Full source — stem controls unlock once separation finishes.</p>
          ) : (
            <div className="wy-stems" role="group" aria-label={`${active ? "Current" : "Next"} deck stems`}>
              {active && item.playback?.kind === "stems" && item.sourceAssetId === null && (
                <p
                  className="wy-stem-toolbar"
                  role="status"
                  data-testid={`full-track-unavailable-${item.id}`}
                >
                  Original audio unavailable · stem playback and controls remain available
                </p>
              )}
              {active && item.sourceAssetId && onReturnToSource && (
                <div className="wy-stem-toolbar">
                  <span>Separated mix playing</span>
                  <button
                    type="button"
                    className="wy-stem-reset"
                    data-testid={`button-return-full-track-${item.id}`}
                    disabled={loadingLayers || stagingTarget !== null}
                    onClick={onReturnToSource}
                  >
                    Return to full track
                  </button>
                </div>
              )}
              {active && <p className="wy-deck-note wy-live-note">Live swaps stay on this song&rsquo;s clock · shorter layers loop; use the Camelot wheel to cue compatible tracks.</p>}
              {active && (
                <div className="wy-stem-pad-section">
                  <div className="wy-stem-pad-caption">
                    <strong>Quick isolate</strong>
                    <span>Tap a stem to hear it alone; restore all when ready.</span>
                  </div>
                  <div className="wy-stem-pad-grid" data-layout={quickPadLayout} role="group" aria-label="Quick stem isolation">
                    {item.stems.map((stem) => {
                      const isolated = performanceSettings.isolatedStem === stem.stemType;
                      return (
                        <div key={stem.id} className="wy-stem-pad-cell" data-stem-type={stem.stemType}>
                          <button
                            type="button"
                            className="wy-stem-pad"
                            data-testid={`quick-isolate-${stem.stemType}`}
                            aria-label={`Quick isolate ${stem.stemType}`}
                            aria-pressed={isolated}
                            disabled={performanceDisabled}
                            onClick={() => onPerformanceAction({ kind: "isolate", stem: stem.stemType })}
                          >
                            <span className="wy-stem-pad-glyph" aria-hidden="true">{stem.stemType.slice(0, 1).toUpperCase()}</span>
                            <span className="wy-stem-pad-name">{stem.stemType}</span>
                          </button>
                          <button
                            type="button"
                            className="wy-stem-pad-swap"
                            data-testid={`quick-open-live-swap-${stem.stemType}`}
                            aria-label={`Open source picker to swap ${stem.stemType}`}
                            aria-expanded={openSwapPickerStem === stem.stemType}
                            disabled={onOpenSwapPicker === undefined}
                            title={`Swap ${stem.stemType} from another track`}
                            onClick={() => onOpenSwapPicker?.(stem.stemType)}
                          >
                            <span aria-hidden="true">⇄</span>
                          </button>
                        </div>
                      );
                    })}
                    <button
                      type="button"
                      className="wy-stem-pad-reset"
                      data-testid="quick-restore-mix"
                      aria-label="Restore full stem mix"
                      disabled={performanceDisabled}
                      onClick={onReset}
                    >
                      <span aria-hidden="true">↻</span>
                      <small>ALL</small>
                    </button>
                  </div>
                </div>
              )}
              {active && (
                <div className="wy-performance-controls" role="group" aria-label="Live stem performance">
                  <label>
                    Snap
                    <select
                      aria-label="Snap stem changes"
                      value={performanceSettings.snap}
                      disabled={performanceDisabled}
                      onChange={(event) => onSnapChange(event.target.value as PerformanceSnap)}
                    >
                      <option value="off">Off</option>
                      <option value="quarter">¼ beat</option>
                      <option value="half">½ beat</option>
                      <option value="beat">Beat</option>
                      <option value="bar" disabled>Bar unavailable</option>
                    </select>
                  </label>
                  <label className="wy-performance-restore">
                    <input
                      type="checkbox"
                      aria-label="Instant Restore"
                      checked={performanceSettings.instantRestore}
                      disabled={performanceDisabled}
                      onChange={(event) => onInstantRestoreChange(event.target.checked)}
                    />
                    Instant restore
                  </label>
                  {pendingPerformanceLabel && (
                    <span className="wy-performance-pending" role="status">
                      {pendingPerformanceLabel}
                      <button type="button" onClick={onCancelPendingPerformance}>Cancel</button>
                    </span>
                  )}
                  {performanceSettings.snap === "bar" && (
                    <span className="wy-performance-note">Bar snap needs verified downbeat data.</span>
                  )}
                  <span className="wy-performance-note">Snaps use the analyzed source grid; they are not sample-locked.</span>
                </div>
              )}
              {mixChanged && (
                <div className="wy-stem-toolbar">
                  <span role="status">
                    {anySolo ? `Isolating ${performanceSettings.isolatedStem}` : "Stem levels adjusted"}
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
                const muted = level <= 0.0001;
                const solo = performanceSettings.isolatedStem === stem.stemType;
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
                    <button type="button" className={`wy-toggle${muted ? " on" : ""}`} disabled={performanceDisabled} aria-pressed={muted} aria-label={`Mute ${stem.stemType}`} onClick={() => onPerformanceAction({ kind: "mute", stem: stem.stemType })}>Mute</button>
                    <button type="button" className={`wy-toggle solo${solo ? " on" : ""}`} disabled={performanceDisabled} aria-pressed={solo} aria-label={`Isolate ${stem.stemType}`} onClick={() => onPerformanceAction({ kind: "isolate", stem: stem.stemType })}>Isolate</button>
                    {active && (
                      <button
                        type="button"
                        className={`wy-toggle wy-hold-toggle${heldStem === stem.stemType ? " on" : ""}`}
                        disabled={performanceDisabled}
                        aria-pressed={heldStem === stem.stemType}
                        aria-label={`Hold to isolate ${stem.stemType}`}
                        onPointerDown={(event) => {
                          event.preventDefault();
                          holdGestureRef.current = "pointer";
                          event.currentTarget.setPointerCapture(event.pointerId);
                          onHoldStart(stem.stemType);
                        }}
                        onPointerUp={() => {
                          holdGestureRef.current = null;
                          suppressHoldClickRef.current = true;
                          onHoldEnd();
                        }}
                        onPointerCancel={() => {
                          holdGestureRef.current = null;
                          onHoldEnd();
                        }}
                        onLostPointerCapture={() => onHoldEnd()}
                        onBlur={() => onHoldEnd()}
                        onKeyDown={(event) => {
                          if ((event.key === " " || event.key === "Enter") && !event.repeat) {
                            event.preventDefault();
                            holdGestureRef.current = "keyboard";
                            onHoldStart(stem.stemType);
                          }
                        }}
                        onKeyUp={(event) => {
                          if (event.key === " " || event.key === "Enter") {
                            event.preventDefault();
                            holdGestureRef.current = null;
                            suppressHoldClickRef.current = true;
                            onHoldEnd();
                          }
                        }}
                        onClick={() => {
                          if (suppressHoldClickRef.current) {
                            suppressHoldClickRef.current = false;
                            return;
                          }
                          if (holdGestureRef.current !== null) return;
                          onHoldStart(stem.stemType);
                          window.setTimeout(onHoldEnd, 350);
                        }}
                      >
                        Hold
                      </button>
                    )}
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
  const [preparingSeparationTrackIds, setPreparingSeparationTrackIds] = useState<Set<string>>(() => new Set());
  const [addTrackId, setAddTrackId] = useState("");
  const [status, setStatus] = useState<string | null>(null);
  const [movingTrack, setMovingTrack] = useState(false);
  const movingTrackRef = useRef(false);
  const [saveState, setSaveState] = useState<"saved" | "saving" | "error">("saved");
  const modeSavesRef = useRef(new Set<string>());
  const [modeSaves, setModeSaves] = useState<Set<string>>(() => new Set());
  const [mixSaveError, setMixSaveError] = useState(false);
  const [handoff, setHandoff] = useState<{
    projectId: string;
    remixTrackCount: number;
    preservedSwapCount?: number;
    preservedTransitionCount?: number;
    transitionWarnings?: Array<{ fromTitle: string; toTitle: string; reason: string }>;
    fullSourceCount?: number;
    refused?: Array<{ title: string; reason: string }>;
  } | null>(null);
  const [sendingToStudio, setSendingToStudio] = useState(false);
  const studioHandoffInFlight = useRef(false);
  const liveSwapWarmupsRef = useRef(new Map<string, Promise<void>>());
  const [studioTrackSelection, setStudioTrackSelection] = useState<{ sessionId: string; trackIds: string[] } | null>(null);
  const studioReadyTrackIds = useMemo(
    () => session?.tracks.filter((item) => getStudioTrackReadiness(item, library).ready).map((item) => item.id) ?? [],
    [session?.tracks, library],
  );
  const studioSelectableTrackIds = useMemo(
    () => session?.tracks.filter((item) => {
      const readiness = getStudioTrackReadiness(item, library);
      return readiness.ready || readiness.canUseFullSource;
    }).map((item) => item.id) ?? [],
    [session?.tracks, library],
  );
  const selectedStudioTrackIds = useMemo(() => {
    if (session === null) return [];
    if (studioTrackSelection?.sessionId !== session.id) return studioReadyTrackIds;
    const availableIds = new Set(studioSelectableTrackIds);
    return studioTrackSelection.trackIds.filter((id) => availableIds.has(id));
  }, [session?.id, studioReadyTrackIds, studioSelectableTrackIds, studioTrackSelection]);

  const [currentId, setCurrentId] = useState<string | null>(null);
  const [activeDeck, setActiveDeck] = useState<0 | 1>(0);
  const [phase, setPhase] = useState<FadePhase>("idle");
  const [savingSwapKeys, setSavingSwapKeys] = useState<Set<string>>(() => new Set());
  const savingSwap = savingSwapKeys.size > 0;
  const setSwapSaving = useCallback((sessionTrackId: string, stemType: string, saving: boolean) => {
    const key = `${sessionTrackId}:${stemType}`;
    setSavingSwapKeys((previous) => {
      if (previous.has(key) === saving) return previous;
      const next = new Set(previous);
      if (saving) next.add(key);
      else next.delete(key);
      return next;
    });
  }, []);
  const [pendingSwaps, setPendingSwaps] = useState<PendingLiveSwap[]>([]);
  const [failedLiveSwaps, setFailedLiveSwaps] = useState<FailedLiveSwap[]>([]);
  const [cancelledSwapIds, setCancelledSwapIds] = useState<Set<string>>(() => new Set());
  const pendingSwapRequestSequenceRef = useRef(0);
  const pendingSwapCancelRequestsRef = useRef(new Set<string>());
  const [swapSelectionTimes, setSwapSelectionTimes] = useState<Record<string, number>>({});
  const [openSwapStem, setOpenSwapStem] = useState<string | null>(null);
  const [mixes, setMixes] = useState<Record<string, Record<string, number>>>({});
  const [transitions, setTransitions] = useState<Record<string, TransitionConfig>>({});
  const [pendingPerformance, setPendingPerformance] = useState<PendingPerformance | null>(null);
  const [temporaryIsolation, setTemporaryIsolation] = useState<TemporaryIsolation | null>(null);
  const [masterLevel, setMasterLevel] = useState(1);
  const [playbackRate, setPlaybackRate] = useState(1);
  const [pitchPreserving, setPitchPreserving] = useState(false);
  const [pitchLockBusy, setPitchLockBusy] = useState(false);
  const [pitchLockMessage, setPitchLockMessage] = useState<string | null>(null);
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

  const changePitchPreserving = useCallback(async (enabled: boolean) => {
    if (pitchLockBusy || enabled === pitchPreserving) return;
    const previous = pitchPreserving;
    const active = decksRef.current[activeDeck];
    const standby = decksRef.current[activeDeck === 0 ? 1 : 0];
    setPitchLockBusy(true);
    setPitchLockMessage(null);
    try {
      if (!active) throw new Error("The active deck is not ready.");
      await active.transport.setPitchPreserving(enabled);
      if (standby) await standby.transport.setPitchPreserving(enabled);
      setPitchPreserving(enabled);
    } catch (error) {
      await Promise.all([
        active?.transport.setPitchPreserving(previous).catch(() => undefined),
        standby?.transport.setPitchPreserving(previous).catch(() => undefined),
      ]);
      setPitchLockMessage(error instanceof Error
        ? `${error.message} Playback was left running.`
        : "Pitch mode could not be changed. Playback was left running.");
    } finally {
      setPitchLockBusy(false);
    }
  }, [activeDeck, pitchLockBusy, pitchPreserving]);
  const pendingPerformanceRef = useRef<PendingPerformance | null>(null);
  const mixesRef = useRef(mixes);
  const transitionsRef = useRef(transitions);
  mixesRef.current = mixes;
  transitionsRef.current = transitions;
  const temporaryIsolationRef = useRef<TemporaryIsolation | null>(null);
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
  useEffect(() => {
    setOpenSwapStem(null);
  }, [currentItem?.id]);
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
          setStemsReady(Object.fromEntries(detail.tracks.flatMap((item) => {
            if (item.playbackPreference !== "source" || item.playback?.kind !== "source") return [];
            const target = stemsPlaybackTarget(item);
            return target === null ? [] : [[item.id, target]];
          })));
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
      if (cancelledSwapIds.has(swap.id)) continue;
      const donor = session.tracks.find((t) => t.track.id === swap.toTrackId);
      const donorStem = donor?.stems.find((s) => s.stemType === swap.stemType)
        ?? swap.donorTrack?.stems.find((s) => s.stemType === swap.stemType);
      if (donorStem) map[swap.stemType] = donorStem.id;
    }
    return map;
  }, [session, currentItem, cancelledSwapIds]);

  const activeSwapTempoStretchRatios = useMemo(() => {
    const ratios: Record<string, number> = {};
    if (session === null || currentItem === null) return ratios;
    for (const swap of session.swaps) {
      if (swap.sessionTrackId !== currentItem.id) continue;
      const donorBpm = session.tracks.find((item) => item.track.id === swap.toTrackId)?.analysis?.bpm
        ?? library.find((track) => track.id === swap.toTrackId)?.analysis?.bpm
        ?? null;
      const ratio = liveStemTempoStretchRatio(currentItem.analysis?.bpm ?? null, donorBpm);
      if (ratio !== null) ratios[swap.stemType] = ratio;
    }
    return ratios;
  }, [session, currentItem, library]);

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
      (previousReported === null ? playing : previousReported !== playing)
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
            stemMix: effectiveMix(item, mixes[item.id] ?? item.stemMix),
            transition: transitions[item.id] ?? item.transition,
          });
          const key = `${session.id}:${item.id}`;
          if (lastSentRef.current[key] === undefined) {
            // First sight of this item: what's on the server is the baseline.
            lastSentRef.current[key] = JSON.stringify({ stemMix: effectiveMix(item, item.stemMix), transition: item.transition });
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
  }, [session?.id, currentItem?.id, nextItem?.id, mixes, transitions]);

  // Apply effective mixes to the physical decks.
  const currentEffective = useMemo(() => effectiveMix(currentItem, currentItem ? mixes[currentItem.id] : undefined), [currentItem, mixes]);
  const nextEffective = useMemo(() => effectiveMix(nextItem, nextItem ? mixes[nextItem.id] : undefined), [nextItem, mixes]);
  const currentAudioMix = useMemo(() => {
    if (currentItem === null || temporaryIsolation?.itemId !== currentItem.id) return currentEffective;
    return Object.fromEntries(currentItem.stems.map((stem) => [
      stem.stemType,
      stem.stemType === temporaryIsolation.stemType ? temporaryIsolation.level : 0,
    ]));
  }, [currentItem, currentEffective, temporaryIsolation]);
  useEffect(() => {
    if (fadeRef.current !== null) return;
    decksRef.current[activeDeck]?.applyStemVolumes(currentAudioMix);
  }, [currentAudioMix, activeDeck, currentItem?.id]);
  useEffect(() => {
    decksRef.current[standbyDeckIndex]?.applyStemVolumes(nextEffective);
  }, [nextEffective, standbyDeckIndex, nextItem?.id]);

  const cancelPendingPerformance = useCallback((message?: string) => {
    if (pendingPerformanceRef.current !== null) {
      pendingPerformanceRef.current = null;
      setPendingPerformance(null);
    }
    if (message !== undefined) setStatus(message);
  }, []);

  const endTemporaryIsolation = useCallback(() => {
    if (temporaryIsolationRef.current === null) return;
    temporaryIsolationRef.current = null;
    setTemporaryIsolation(null);
  }, []);

  const setPerformanceForItem = useCallback((item: SessionTrackItem, patch: Partial<PerformanceSettings>) => {
    const currentConfig = transitionsRef.current[item.id] ?? item.transition;
    const performance = { ...(currentConfig.performance ?? defaultPerformance()), ...patch };
    const nextConfig = { ...currentConfig, performance };
    const nextTransitions = { ...transitionsRef.current, [item.id]: nextConfig };
    transitionsRef.current = nextTransitions;
    setTransitions(nextTransitions);
  }, []);

  const applyPerformanceActions = useCallback((
    item: SessionTrackItem,
    deckIndex: 0 | 1,
    actions: PerformanceAction[],
  ) => {
    const currentConfig = transitionsRef.current[item.id] ?? item.transition;
    let levels = effectiveMix(item, mixesRef.current[item.id] ?? item.stemMix);
    let settings = currentConfig.performance ?? defaultPerformance();
    for (const action of actions) {
      const result = performMix(levels, settings, action, item.stems.map((stem) => stem.stemType));
      levels = result.mix;
      settings = result.performance;
    }
    const nextMixes = { ...mixesRef.current, [item.id]: levels };
    mixesRef.current = nextMixes;
    setMixes(nextMixes);
    const nextTransitions = {
      ...transitionsRef.current,
      [item.id]: { ...currentConfig, performance: settings },
    };
    transitionsRef.current = nextTransitions;
    setTransitions(nextTransitions);
    decksRef.current[deckIndex]?.applyStemVolumes(levels);
    setStatus(null);
  }, []);

  const requestPerformance = useCallback((
    itemId: string,
    deckIndex: 0 | 1,
    action: PerformanceAction,
  ) => {
    const item = deckItems[deckIndex];
    if (item === null || item.id !== itemId || phase !== "idle") return;
    endTemporaryIsolation();
    const deck = decksRef.current[deckIndex];
    const settings = (transitionsRef.current[item.id] ?? item.transition).performance ?? defaultPerformance();
    const currentLevels = effectiveMix(item, mixesRef.current[item.id] ?? item.stemMix);
    const restoring = action.kind === "restore"
      || (action.kind === "isolate" && settings.isolatedStem === action.stem)
      || (action.kind === "mute" && (currentLevels[action.stem] ?? 1) <= 0.0001);
    const shouldSnap = deckIndex === activeDeck
      && item.id === currentIdRef.current
      && deck?.transport.playing === true
      && settings.snap !== "off"
      && !(restoring && settings.instantRestore);
    if (!shouldSnap) {
      cancelPendingPerformance();
      applyPerformanceActions(item, deckIndex, [action]);
      return;
    }

    const position = deck?.transport.currentPosition() ?? NaN;
    const target = nextPerformanceBoundary(
      position,
      item.analysis?.beatGridMs,
      settings.snap,
      undefined,
      PERFORMANCE_MINIMUM_LEAD_SECONDS,
    );
    if (target === null) {
      setStatus(settings.snap === "bar"
        ? "Bar snap unavailable: this track has no verified downbeat data. Choose Beat or Off."
        : "Beat snap unavailable: this track has no verified beat grid. Choose Off for immediate stem changes.");
      return;
    }
    const previous = pendingPerformanceRef.current;
    const actions = previous?.itemId === item.id && previous.deckIndex === deckIndex
      ? [...previous.actions, action]
      : [action];
    const pending: PendingPerformance = {
      itemId: item.id,
      deckIndex,
      snap: settings.snap,
      target: previous?.itemId === item.id && previous.deckIndex === deckIndex ? previous.target : target,
      previous: position,
      actions,
    };
    pendingPerformanceRef.current = pending;
    setPendingPerformance(pending);
    const targetAction = action.kind === "restore" ? "restore mix" : `${action.kind} ${action.stem}`;
    setStatus(`${targetAction} queued for the next ${settings.snap} boundary.`);
  }, [activeDeck, applyPerformanceActions, cancelPendingPerformance, deckItems, endTemporaryIsolation, phase]);

  const beginTemporaryIsolation = useCallback((itemId: string, stemType: string) => {
    if (phase !== "idle" || currentIdRef.current !== itemId || deckItems[activeDeck]?.id !== itemId) return;
    const item = deckItems[activeDeck];
    if (item === null || !item.stems.some((stem) => stem.stemType === stemType)) return;
    cancelPendingPerformance();
    const levels = effectiveMix(item, mixesRef.current[item.id] ?? item.stemMix);
    const settings = (transitionsRef.current[item.id] ?? item.transition).performance ?? defaultPerformance();
    const level = (levels[stemType] ?? 1) > 0 ? levels[stemType] : settings.recall[stemType] ?? 1;
    const temporary = { itemId, stemType, level: Math.max(0, Math.min(2, level)) };
    temporaryIsolationRef.current = temporary;
    setTemporaryIsolation(temporary);
  }, [activeDeck, cancelPendingPerformance, deckItems, phase]);

  useEffect(() => {
    const pending = pendingPerformance;
    if (pending === null) return;
    let frame = 0;
    const tick = () => {
      const live = pendingPerformanceRef.current;
      if (live === null) return;
      const item = sessionRef.current?.tracks.find((track) => track.id === live.itemId) ?? null;
      const deck = decksRef.current[live.deckIndex];
      const position = deck?.transport.currentPosition() ?? NaN;
      const valid = item !== null
        && currentIdRef.current === live.itemId
        && activeDeckRef.current === live.deckIndex
        && phase === "idle";
      const verdict = valid
        ? performanceTick(live.target, live.previous, position, deck?.transport.playing ?? false)
        : "cancel";
      live.previous = position;
      if (verdict === "wait") {
        frame = requestAnimationFrame(tick);
        return;
      }
      pendingPerformanceRef.current = null;
      setPendingPerformance(null);
      if (verdict === "apply" && item !== null) {
        applyPerformanceActions(item, live.deckIndex, live.actions);
      } else {
        setStatus("Pending stem changes cancelled: playback moved, paused, or missed the beat. Nothing was applied late.");
      }
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [applyPerformanceActions, pendingPerformance, phase]);

  useEffect(() => {
    if (temporaryIsolation === null) return;
    if (temporaryIsolation.itemId !== currentItem?.id || phase !== "idle") endTemporaryIsolation();
  }, [currentItem?.id, endTemporaryIsolation, phase, temporaryIsolation]);

  useEffect(() => {
    const interrupt = () => endTemporaryIsolation();
    const onVisibility = () => {
      if (document.visibilityState === "hidden") interrupt();
    };
    window.addEventListener("pointerup", interrupt);
    window.addEventListener("pointercancel", interrupt);
    window.addEventListener("blur", interrupt);
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      window.removeEventListener("pointerup", interrupt);
      window.removeEventListener("pointercancel", interrupt);
      window.removeEventListener("blur", interrupt);
      document.removeEventListener("visibilitychange", onVisibility);
      interrupt();
    };
  }, [endTemporaryIsolation]);

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
        const scaled = scaleCrossfadeStemVolumes(fromMix, cfg.keepStems, env.fromGain);
        const outgoing = decksRef.current[fromDeck];
        if (outgoing?.hasStemChannels) outgoing.applyStemVolumes(scaled);
        else outgoing?.transport.applyMasterVolumeRealtime(env.fromGain * masterRef.current);
        decksRef.current[toDeck]?.transport.applyMasterVolumeRealtime(env.toGain * masterRef.current);
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

  const beginTransition = useCallback(async (automaticCue?: { startInCurrentMs: number; incomingOffsetMs: number }) => {
    if (phase === "fading") return;
    cancelPendingPerformance("Pending stem changes cancelled because a transition started.");
    endTemporaryIsolation();
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
    let cfg = transitions[fromItem.id] ?? fromItem.transition;
    advancingRef.current = false;

    let startInCurrent = automaticCue ? fromApi.transport.currentPosition() : fromApi.transport.position;
    let incomingOffset = 0;
    if (automaticCue) {
      // The live clock has reached the cue: do not seek or recalculate the
      // next beat. Bound the fade when a clock callback arrives slightly late.
      incomingOffset = automaticCue.incomingOffsetMs / 1000;
      cfg = { ...cfg, crossfadeSeconds: Math.min(cfg.crossfadeSeconds, Math.max(0, fromItem.track.durationSeconds - startInCurrent)) };
      setStatus(`Automatic ${cfg.mode === "manual" ? "crossfade" : `${cfg.mode}-aligned fade`} from ${formatClock(automaticCue.startInCurrentMs / 1000)}.`);
    } else if (cfg.mode === "beat" || cfg.mode === "bar") {
      const aligned = beatAlignedTransitionStart(fromItem.analysis?.beatGridMs ?? null, toItem.analysis?.beatGridMs ?? null, startInCurrent * 1000, cfg.mode);
      if (!aligned.ok) {
        setStatus(aligned.reason);
        return;
      }
      startInCurrent = (aligned.startInCurrentMs ?? 0) / 1000;
      incomingOffset = (aligned.incomingOffsetMs ?? 0) / 1000;
      setStatus(`${aligned.reason} Fading ${cfg.crossfadeSeconds}s from ${formatClock(startInCurrent)}.`);
    } else {
      setStatus(`Crossfade ${cfg.crossfadeSeconds}s from ${formatClock(startInCurrent)}.`);
    }

    if (!automaticCue) {
      fromApi.transport.seek(startInCurrent);
      await fromApi.transport.play();
    }
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
    if (automaticCue) {
      cfg = { ...cfg, crossfadeSeconds: Math.min(cfg.crossfadeSeconds, Math.max(0, fromItem.track.durationSeconds - fromApi.transport.currentPosition())) };
    }
    runFade(cfg, fromDeck, toDeck, { ...currentEffective });
  }, [phase, activeDeck, standbyDeckIndex, deckItems, transitions, runFade, finishTransition, currentEffective, cancelPendingPerformance, endTemporaryIsolation]);

  const cancelTransition = useCallback(() => {
    const fade = fadeRef.current;
    if (fade === null) return;
    cancelAnimationFrame(fade.raf);
    const frozen = crossfadeCancel((performance.now() - fade.t0) / 1000, fade.cfg.crossfadeSeconds);
    const scaled = scaleCrossfadeStemVolumes(fade.fromMix, fade.cfg.keepStems, frozen.fromGain);
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
    cancelPendingPerformance("Pending stem changes cancelled by playback control.");
    endTemporaryIsolation();
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
  }, [activeDeck, phase, cancelTransition, persistState, sessionId, publishTransport, clearRemoteTransport, cancelPendingPerformance, endTemporaryIsolation]);

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
  const mutate = useCallback(async (
    input: RequestInfo,
    init: RequestInit,
    swapScope?: SwapMutationScope,
  ): Promise<SessionDetail | null> => {
    try {
      const response = await fetch(input, init);
      if (!response.ok) {
        const body = (await response.json().catch(() => null)) as { error?: string } | null;
        setStatus(body?.error ?? "The session change was rejected.");
        return null;
      }
      const detail = (await response.json()).session as SessionDetail;
      if (sessionRef.current !== null && sessionRef.current.id !== detail.id) return null;
      const current = sessionRef.current;
      const nextDetail = swapScope && current !== null
        ? {
          ...detail,
          // A swap changes one channel only. Keep the latest transport/track
          // state and merge only that channel so an older response cannot
          // erase a different stem's newer selection.
          tracks: current.tracks,
          currentSessionTrackId: current.currentSessionTrackId,
          positionSeconds: current.positionSeconds,
          swaps: [
            ...current.swaps.filter((swap) =>
              swap.sessionTrackId !== swapScope.sessionTrackId || swap.stemType !== swapScope.stemType,
            ),
            ...detail.swaps.filter((swap) =>
              swap.sessionTrackId === swapScope.sessionTrackId && swap.stemType === swapScope.stemType,
            ),
          ],
        }
        : detail;
      setMixes((prev) => {
        const next = { ...prev };
        for (const item of nextDetail.tracks) if (!(item.id in next)) next[item.id] = { ...item.stemMix };
        return next;
      });
      setTransitions((prev) => {
        const next = { ...prev };
        for (const item of nextDetail.tracks) if (!(item.id in next)) next[item.id] = item.transition;
        return next;
      });
      sessionRef.current = nextDetail;
      setSession(nextDetail);
      return nextDetail;
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
      autoCrossfadeStartedForRef.current = null;
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

  const setLibraryTrackAsNext = useCallback(async (trackId: string) => {
    const latest = sessionRef.current;
    if (latest === null) return;
    const existing = latest.tracks.find((item) => item.track.id === trackId);
    if (existing !== undefined) {
      await setSessionTrackAsNext(existing.id);
      return;
    }
    const currentPosition = latest.tracks.findIndex((item) => item.id === currentIdRef.current);
    const position = currentPosition < 0 ? 0 : currentPosition + 1;
    const previousIds = new Set(latest.tracks.map((item) => item.id));
    const detail = await mutate(`/api/library/sessions/${latest.id}/tracks`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ trackId, position }),
    });
    if (detail === null) return;
    const added = detail.tracks.find((item) => !previousIds.has(item.id) && item.track.id === trackId);
    if (added === undefined) {
      setStatus("The track was added, but could not be placed in the session.");
      return;
    }
    publishWaveyardQueueChange([latest.id]);
    setStatus(`Up next: ${added.track.title}.`);
  }, [mutate, setSessionTrackAsNext]);

  const moveTrack = useCallback(
    async (itemId: string, direction: -1 | 1) => {
      if (session === null || movingTrackRef.current) return;
      const item = session.tracks.find((entry) => entry.id === itemId);
      if (item === undefined) return;
      const sessionOnly = item.queueItemId === null;
      const candidates = sessionOnly ? session.tracks.filter((entry) => entry.queueItemId === null) : session.tracks;
      const target = candidates[candidates.findIndex((entry) => entry.id === itemId) + direction];
      if (target === undefined) return;
      movingTrackRef.current = true;
      setMovingTrack(true);
      try {
        const detail = await mutate(`/api/library/sessions/${session.id}/tracks`, {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ sessionTrackId: itemId, position: target.position, sessionOnly }),
        });
        if (detail !== null) publishWaveyardQueueChange([session.id]);
      } finally {
        movingTrackRef.current = false;
        setMovingTrack(false);
      }
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

  const warmLiveSwap = useCallback(
    (stemType: string, donor: { id: string; stems?: SessionTrackItem["stems"]; bpm?: number | null }) => {
      if (session === null || currentItem === null) return Promise.resolve();
      const recipientStemId = currentItem.stems.find((stem) => stem.stemType === stemType)?.id;
      if (!recipientStemId) return Promise.resolve();
      const key = `${activeDeck}:${currentItem.id}:${stemType}:${donor.id}`;
      const existing = liveSwapWarmupsRef.current.get(key);
      if (existing) return existing;

      const selectedAt = performance.now();
      const tempoStretchRatio = liveStemTempoStretchRatio(
        currentItem.analysis?.bpm ?? null,
        donor.bpm ?? null,
      ) ?? 1;
      let warming!: Promise<void>;
      warming = (async () => {
        let donorStem = donor.stems?.find((stem) => stem.stemType === stemType);
        if (!donorStem) {
          const response = await fetch(`/api/library/tracks/${donor.id}`, { cache: "no-store" });
          if (!response.ok) return;
          const body = await response.json() as { track?: { stems?: SessionTrackItem["stems"] } };
          donorStem = body.track?.stems?.find((stem) => stem.stemType === stemType);
        }
        if (!donorStem) return;
        await decksRef.current[activeDeck]?.preloadStem(recipientStemId, donorStem.id, tempoStretchRatio, selectedAt);
      })().catch(() => {
        // Warming is optional; the normal selection path still fetches and reports failures.
      }).finally(() => {
        if (liveSwapWarmupsRef.current.get(key) === warming) liveSwapWarmupsRef.current.delete(key);
      });
      liveSwapWarmupsRef.current.set(key, warming);
      return warming;
    },
    [activeDeck, currentItem, session],
  );

  const prefetchLiveSwapAsset = useCallback((stemType: string, donorId: string) => {
    if (session === null || currentItem === null) return;
    const sessionDonor = session.tracks.find((item) => item.track.id === donorId);
    const existingStem = sessionDonor?.stems.find((stem) => stem.stemType === stemType);
    const prefetch = (stemId: string) => {
      void decksRef.current[activeDeck]?.preloadStemAsset(`/api/assets/${stemId}`).catch(() => undefined);
    };
    if (existingStem) {
      prefetch(existingStem.id);
      return;
    }
    void fetch(`/api/library/tracks/${donorId}`, { cache: "no-store" })
      .then(async (response) => {
        if (!response.ok) return null;
        const body = await response.json() as { track?: { stems?: SessionTrackItem["stems"] } };
        return body.track?.stems?.find((stem) => stem.stemType === stemType)?.id ?? null;
      })
      .then((stemId) => { if (stemId) prefetch(stemId); })
      .catch(() => {
        // Prefetch is optional; selection still performs its normal fetch and reports failures.
      });
  }, [activeDeck, currentItem, session]);

  // ------------------------------------------------------------------ swaps
  const requestSwap = useCallback(
    async (stemType: string, donor: { id: string; title: string; stems?: SessionTrackItem["stems"]; bpm?: number | null }) => {
      if (session === null || currentItem === null) return;
      const selectedAt = performance.now();
      const localSwapId = `pending-${++pendingSwapRequestSequenceRef.current}`;
      const validation = donor.stems ? validateStemSwap(currentItem.stems, donor.stems, stemType) : null;
      if (validation && !validation.ok) {
        setStatus(validation.reason);
        return;
      }
      setFailedLiveSwaps((previous) => previous.filter(
        (failed) => failed.sessionTrackId !== currentItem.id || failed.stemType !== stemType,
      ));
      // Reuse any source warmed while the picker was open; swaps stay silent
      // until the persisted choice is committed and the audio graph replaces it.
      void warmLiveSwap(stemType, donor);
      setSwapSelectionTimes((previous) => ({
        ...previous,
        [`${currentItem.id}:${stemType}`]: selectedAt,
      }));
      const previousSwap = session.swaps.filter((swap) =>
        swap.sessionTrackId === currentItem.id && swap.stemType === stemType && !cancelledSwapIds.has(swap.id),
      ).at(-1);
      pendingSwapCancelRequestsRef.current.delete(localSwapId);
      setPendingSwaps((previous) => [
        ...previous.filter((pending) => !(pending.sessionTrackId === currentItem.id && pending.stemType === stemType)),
        {
          swapId: localSwapId,
          sessionTrackId: currentItem.id,
          stemType,
          donorTitle: donor.title,
          retryDonor: { id: donor.id, title: donor.title, stems: donor.stems, bpm: donor.bpm },
          previousSwap,
          savePending: true,
        },
      ]);
      setSwapSaving(currentItem.id, stemType, true);
      setStatus(`Saving ${stemType} source from “${donor.title}”… current playback continues.`);
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
        }, { sessionTrackId: currentItem.id, stemType });
        if (detail) {
          const savedSwap = [...detail.swaps].reverse().find((swap) =>
            swap.sessionTrackId === currentItem.id && swap.stemType === stemType && swap.toTrackId === donor.id,
          );
          if (savedSwap) {
            const cancelRequested = pendingSwapCancelRequestsRef.current.delete(localSwapId);
            setPendingSwaps((previous) => previous.map((pending) =>
              pending.swapId === localSwapId
                ? { ...pending, swapId: savedSwap.id, savePending: false, cancelRequested }
                : pending,
            ));
            if (cancelRequested) {
              setCancelledSwapIds((previous) => new Set([...previous, savedSwap.id]));
              for (const deck of decksRef.current) {
                if (deck?.itemId !== currentItem.id) continue;
                const stemId = currentItem.stems.find((stem) => stem.stemType === stemType)?.id;
                if (stemId) deck.transport.cancelPendingStem(stemId);
              }
              const removal = await mutate(
                `/api/library/sessions/${session.id}/swaps?swapId=${savedSwap.id}`,
                { method: "DELETE" },
                { sessionTrackId: currentItem.id, stemType },
              );
              if (removal) {
                setPendingSwaps((previous) => previous.filter((pending) => pending.swapId !== savedSwap.id));
                setCancelledSwapIds((previous) => {
                  const next = new Set(previous);
                  next.delete(savedSwap.id);
                  return next;
                });
                setStatus(`${stemType} switch cancelled; the previous audio continues.`);
              } else {
                setStatus(`The ${stemType} switch is stopped locally, but its saved choice could not be removed. Retry removing it before leaving.`);
              }
            } else {
              setStatus(`${stemType} source saved: “${donor.title}”. Playback continues while the layer loads.`);
            }
          } else {
            setPendingSwaps((previous) => previous.filter((pending) => pending.swapId !== localSwapId));
            setStatus(`${stemType} source saved, but the selected source could not be confirmed.`);
          }
        } else {
          setPendingSwaps((previous) => previous.filter((pending) => pending.swapId !== localSwapId));
          pendingSwapCancelRequestsRef.current.delete(localSwapId);
        }
      } finally {
        pendingSwapCancelRequestsRef.current.delete(localSwapId);
        setSwapSaving(currentItem.id, stemType, false);
      }
    },
    [session, currentItem, mutate, activeDeck, warmLiveSwap, cancelledSwapIds, setSwapSaving],
  );

  const revertSwap = useCallback(
    async (swapId: string, successMessage = "Original stem restored.", failed = false) => {
      if (session === null) return;
      const pending = pendingSwaps.find((swap) => swap.swapId === swapId);
      const savedSwap = session?.swaps.find((swap) => swap.id === swapId);
      if (pending?.savePending) {
        if (!pending.cancelRequested) {
          pendingSwapCancelRequestsRef.current.add(swapId);
          setPendingSwaps((previous) => previous.map((swap) =>
            swap.swapId === swapId ? { ...swap, cancelRequested: true } : swap,
          ));
          for (const deck of decksRef.current) {
            if (deck?.itemId !== pending.sessionTrackId) continue;
            const item = session.tracks.find((track) => track.id === pending.sessionTrackId);
            const stemId = item?.stems.find((stem) => stem.stemType === pending.stemType)?.id;
            if (stemId) deck.transport.cancelPendingStem(stemId);
          }
          setStatus(`${pending.stemType} switch cancellation queued; current playback continues.`);
        }
        return;
      }
      const targetSwap = pending ?? savedSwap;
      const previousSwap = (failed || pending?.failed) ? pending?.previousSwap : undefined;
      if (pending) {
        if (previousSwap) {
          // Keep the saved failed selection in place until its guarded restore
          // finishes. Filtering it out here would tell the engine to remove A,
          // even though A is still playing underneath the failed preparation.
          setPendingSwaps((previous) => previous.map((swap) =>
            swap.swapId === swapId ? { ...swap, failed: true } : swap,
          ));
        } else {
          setCancelledSwapIds((previous) => new Set([...previous, swapId]));
        }
        // Cancel locally before waiting for persistence. A late donor response
        // must not take over even if the delete request is slow or fails.
        for (const deck of decksRef.current) {
          if (deck?.itemId !== pending.sessionTrackId) continue;
          const item = session.tracks.find((track) => track.id === pending.sessionTrackId);
          const stemId = item?.stems.find((stem) => stem.stemType === pending.stemType)?.id;
          if (stemId) deck.transport.cancelPendingStem(stemId);
        }
        setStatus(successMessage);
      }
      if (targetSwap) setSwapSaving(targetSwap.sessionTrackId, targetSwap.stemType, true);
      try {
        const detail = previousSwap
          ? await mutate(`/api/library/sessions/${session.id}/swaps`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              sessionTrackId: previousSwap.sessionTrackId,
              stemType: previousSwap.stemType,
              toTrackId: previousSwap.toTrackId,
              toStemAssetId: previousSwap.toStemAssetId,
              atSeconds: previousSwap.atSeconds,
              expectedSwapId: swapId,
            }),
          }, { sessionTrackId: previousSwap.sessionTrackId, stemType: previousSwap.stemType })
          : await mutate(`/api/library/sessions/${session.id}/swaps?swapId=${swapId}`, { method: "DELETE" },
            targetSwap ? { sessionTrackId: targetSwap.sessionTrackId, stemType: targetSwap.stemType } : undefined);
        if (detail) {
          setPendingSwaps((previous) => previous.filter((pending) => pending.swapId !== swapId));
          const restored = !previousSwap || detail.swaps.some((swap) =>
            swap.sessionTrackId === previousSwap.sessionTrackId && swap.stemType === previousSwap.stemType &&
            swap.toTrackId === previousSwap.toTrackId && swap.toStemAssetId === previousSwap.toStemAssetId,
          );
          setStatus(restored ? successMessage : "The failed switch was superseded; the newer source selection was kept.");
        } else if (previousSwap) {
          setStatus("The previous audio is still playing, but its saved source could not be restored. Retry saving the previous source before leaving.");
        }
      } finally {
        if (targetSwap) setSwapSaving(targetSwap.sessionTrackId, targetSwap.stemType, false);
      }
    },
    [session, mutate, pendingSwaps, setSwapSaving],
  );

  const liveLayerFailureRef = useRef<(sessionTrackId: string, stemType: string, message: string) => void>(() => {});
  liveLayerFailureRef.current = (sessionTrackId, stemType, message) => {
    const pending = pendingSwaps.find((swap) => swap.sessionTrackId === sessionTrackId && swap.stemType === stemType);
    if (pending) {
      setFailedLiveSwaps((previous) => [
        ...previous.filter((failed) => failed.sessionTrackId !== sessionTrackId || failed.stemType !== stemType),
        { sessionTrackId, stemType, message, donor: pending.retryDonor },
      ]);
      void revertSwap(pending.swapId, message, true);
    }
  };
  const markLiveLayerFailed = useCallback((sessionTrackId: string, stemType: string, message: string) => {
    liveLayerFailureRef.current(sessionTrackId, stemType, message);
  }, []);

  const markLiveLayerReady = useCallback((sessionTrackId: string, stemType: string) => {
    setPendingSwaps((previous) => previous.filter(
      (pending) => pending.sessionTrackId !== sessionTrackId || pending.stemType !== stemType,
    ));
    setFailedLiveSwaps((previous) => previous.filter(
      (failed) => failed.sessionTrackId !== sessionTrackId || failed.stemType !== stemType,
    ));
    setSwapSelectionTimes((previous) => {
      const key = `${sessionTrackId}:${stemType}`;
      if (previous[key] === undefined) return previous;
      const next = { ...previous };
      delete next[key];
      return next;
    });
  }, []);

  const retryFailedLiveSwaps = useCallback(async (sessionTrackId: string) => {
    const failures = failedLiveSwaps.filter((failed) => failed.sessionTrackId === sessionTrackId);
    for (const failure of failures) await requestSwap(failure.stemType, failure.donor);
  }, [failedLiveSwaps, requestSwap]);

  useEffect(() => {
    const savedSwapIds = new Set(session?.swaps.map((swap) => swap.id) ?? []);
    setPendingSwaps((previous) => previous.filter((pending) =>
      pending.savePending || savedSwapIds.has(pending.swapId),
    ));
    setCancelledSwapIds((previous) => {
      const next = new Set([...previous].filter((id) => savedSwapIds.has(id)));
      return next.size === previous.size ? previous : next;
    });
  }, [session?.swaps]);

  // -------------------------------------------------------- studio handoff
  const sendToStudio = useCallback(() => {
    if (session === null || studioHandoffInFlight.current) return;
    if (selectedStudioTrackIds.length === 0) {
      setStatus("Select at least one session track to send to Studio.");
      return;
    }
    if (savingSwap) {
      setStatus("Wait for the selected live stem swap to finish saving before sending it to Studio.");
      return;
    }
    const selectedFullSourceEntries = session.tracks.filter((item) => {
      if (!selectedStudioTrackIds.includes(item.id)) return false;
      const readiness = getStudioTrackReadiness(item, library);
      return !readiness.ready && readiness.canUseFullSource;
    });
    studioHandoffInFlight.current = true;
    setSendingToStudio(true);
    setHandoff(null);
    setStatus(selectedFullSourceEntries.length > 0 ? "Preparing selected full-source audio for Studio…" : null);
    void (async () => {
      try {
        const fullSourceFailures: Array<{ title: string; reason: string }> = [];
        const failedFullSourceIds = new Set<string>();
        const preparedFullSourceIds: string[] = [];
        for (const item of selectedFullSourceEntries) {
          try {
            const bridgeResponse = await fetch("/api/stems/passthrough", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ sourceAssetId: item.sourceAssetId }),
            });
            const bridgeBody = (await bridgeResponse.json().catch(() => null)) as {
              error?: string;
              stem?: { engine?: string };
            } | null;
            if (bridgeResponse.ok) {
              preparedFullSourceIds.push(item.id);
              continue;
            }
            // Separation can finish between the session load and this click.
            // In that case the handoff service will use the now-available stems.
            if (bridgeResponse.status === 409 && bridgeBody?.error === "This source already has separated stems.") {
              continue;
            }
            failedFullSourceIds.add(item.id);
            fullSourceFailures.push({
              title: item.track.title,
              reason: bridgeBody?.error ?? "Full-source audio could not be prepared.",
            });
          } catch {
            failedFullSourceIds.add(item.id);
            fullSourceFailures.push({
              title: item.track.title,
              reason: "Full-source audio could not be prepared because the connection failed.",
            });
          }
        }
        const handoffTrackIds = selectedStudioTrackIds.filter((id) => !failedFullSourceIds.has(id));
        if (handoffTrackIds.length === 0) {
          setStatus(fullSourceFailures.map((item) => `${item.title}: ${item.reason}`).join("; ")
            || "No selected track could be prepared for Studio.");
          return;
        }
        const response = await fetch(`/api/library/sessions/${session.id}/studio-handoff`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            sessionTrackIds: handoffTrackIds,
            trackEdits: session.tracks
              .filter((item) => handoffTrackIds.includes(item.id))
              .map((item) => ({
                sessionTrackId: item.id,
                stemMix: effectiveMix(item, mixes[item.id] ?? item.stemMix),
              })),
          }),
        });
        if (!response.ok) {
          const body = (await response.json().catch(() => null)) as { error?: string } | null;
          const reason = body?.error ?? "The Studio handoff failed.";
          setStatus(fullSourceFailures.length > 0
            ? `${reason} ${fullSourceFailures.map((item) => `${item.title}: ${item.reason}`).join("; ")}`
            : reason);
          return;
        }
        const body = (await response.json()) as {
          handoff: {
            projectId: string;
            remixTrackCount: number;
            preservedSwapCount?: number;
            preservedTransitionCount?: number;
            transitionWarnings?: Array<{ fromTitle: string; toTitle: string; reason: string }>;
            refused?: Array<{ title: string; reason: string }>;
          };
        };
        const refused = [...(body.handoff.refused ?? []), ...fullSourceFailures];
        setHandoff({
          ...body.handoff,
          fullSourceCount: preparedFullSourceIds.length,
          refused: refused.length > 0 ? refused : undefined,
        });
        setStatus(preparedFullSourceIds.length > 0
          ? `Sent to Studio. ${preparedFullSourceIds.length} selected ${preparedFullSourceIds.length === 1 ? "entry uses" : "entries use"} full-source audio, not separated; source files remain untouched.`
          : "Sent to Studio as a derived arrangement — sources untouched.");
      } catch {
        setStatus("The Studio handoff could not be saved.");
      } finally {
        studioHandoffInFlight.current = false;
        setSendingToStudio(false);
      }
    })();
  }, [session, selectedStudioTrackIds, library, savingSwap, mixes]);

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
      /* The next queue update or tab resume will retry the refresh. */
    }
  }, [sessionId, deckItems]);

  useEffect(() => subscribeToWaveyardQueueChanges(({ affectedSessionIds, transport }) => {
    if (transport !== undefined) receiveRemoteTransport(transport);
    else if (affectedSessionIds.includes(sessionId)) void refreshSessionFromOtherTab();
  }), [sessionId, receiveRemoteTransport, refreshSessionFromOtherTab]);

  useEffect(() => subscribeToWaveyardResume(() => {
    void refreshSessionFromOtherTab();
  }), [refreshSessionFromOtherTab]);

  // Background refresh: picks up finished separations and new library tracks.
  // A deck that is AUDIBLE keeps its source until the user switches.
  const pending = session?.tracks.some((item) => item.playback?.kind !== "stems") ?? false;
  const sessionSeparationProgress = useMemo(() => {
    if (session === null) return [];
    return session.tracks.flatMap((item) => {
      if (item.playback?.kind !== "source") return [];
      const availability = library.find((track) => track.id === item.track.id)?.stemAvailability;
      if (availability?.status !== "processing") return [];
      return [{
        id: item.id,
        title: item.track.title,
        stage: availability.stage,
        progress: availability.progress,
      }];
    });
  }, [session, library]);
  const currentSourceAvailability = currentItem?.playback?.kind === "source"
    ? library.find((track) => track.id === currentItem.track.id)?.stemAvailability ?? null
    : null;
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
        const readyFromSavedSource: Record<string, SessionTrackItem> = {};
        const merged = fresh.tracks.map((item) => {
          if (item.playbackPreference === "source" && item.playback?.kind === "source") {
            const target = stemsPlaybackTarget(item);
            if (target !== null) readyFromSavedSource[item.id] = target;
          }
          const old = prev.tracks.find((t) => t.id === item.id);
          const changed = old !== undefined && old.playback?.kind !== item.playback?.kind;
          if (changed && audible.has(item.id)) {
            held[item.id] = readyFromSavedSource[item.id] ?? item;
            return old;
          }
          return item;
        });
        // Only replace state when something actually changed.
        const before = JSON.stringify(prev.tracks.map((t) => [t.id, t.playback?.kind, t.playbackPreference, t.stems.length, t.analysis?.bpm ?? null]));
        const after = JSON.stringify(merged.map((t) => [t.id, t.playback?.kind, t.playbackPreference, t.stems.length, t.analysis?.bpm ?? null]));
        if (before !== after || prev.tracks.length !== merged.length) {
          const next = { ...prev, tracks: merged, swaps: fresh.swaps };
          sessionRef.current = next;
          setSession(next);
        }
        const switchTargets: Record<string, SessionTrackItem> = {};
        for (const item of merged) {
          if (item.playback?.kind !== "source") continue;
          const target = item.playbackPreference === "source"
            ? stemsPlaybackTarget(item)
            : held[item.id]?.playback?.kind === "stems"
              ? held[item.id]
              : null;
          if (target !== null) switchTargets[item.id] = target;
        }
        setStemsReady((current) => {
          const signature = (targets: Record<string, SessionTrackItem>) => JSON.stringify(
            Object.entries(targets)
              .map(([key, item]) => [key, item.playback?.kind, item.playback?.assetIds])
              .sort(([left], [right]) => String(left).localeCompare(String(right))),
          );
          return signature(current) === signature(switchTargets) ? current : switchTargets;
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

  const switchToStems = useCallback(async (itemId: string) => {
    const ready = stemsReady[itemId];
    const s = sessionRef.current;
    if (ready === undefined || s === null) return;
    const deckIndex = deckItems[0]?.id === itemId ? 0 : deckItems[1]?.id === itemId ? 1 : -1;
    const api = deckIndex >= 0 ? decksRef.current[deckIndex] : null;
    if (api === null) {
      setStatus("Load this track onto a deck before switching to stems.");
      return;
    }
    setStatus(`Preparing separated stems for “${ready.track.title}”…`);
    const levels = effectiveMix(ready, mixes[itemId] ?? ready.stemMix);
    const prepared = await api.prepareHandoff(ready, levels);
    if (prepared === null) {
      setStatus("The separated stems could not be prepared. The original track keeps playing.");
      return;
    }
    const selected: SessionTrackItem = { ...ready, playbackPreference: "stems" };
    const next = { ...s, tracks: s.tracks.map((t) => (t.id === itemId ? selected : t)) };
    sessionRef.current = next;
    setSession(next);
    setStemsReady((current) => {
      const copy = { ...current };
      delete copy[itemId];
      return copy;
    });
    try {
      const response = await fetch(`/api/library/sessions/${s.id}/tracks/${itemId}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ playbackPreference: "stems" }),
      });
      if (!response.ok) throw new Error("The playback choice could not be saved.");
      setStatus(`Switched “${ready.track.title}” to stems at ${formatClock(prepared.position)} without interrupting playback.`);
    } catch {
      setStatus(`Switched “${ready.track.title}” to stems, but the choice could not be saved. Try switching again when the session is online.`);
    }
  }, [stemsReady, deckItems, mixes]);

  // Preparation changes only this entry, never the server's whole session
  // snapshot: replacing that snapshot could reload an unrelated audible deck.
  const chooseUpcomingMode = useCallback(async (itemId: string, preference: "source" | "stems") => {
    const s = sessionRef.current;
    const item = s?.tracks.find((track) => track.id === itemId);
    if (!s || !item || !item.sourceAssetId || !stemsPlaybackTarget(item)
      || itemId === currentIdRef.current || fadeRef.current !== null) return;
    const key = `${s.id}:${itemId}`;
    if (modeSavesRef.current.has(key)) return;
    modeSavesRef.current.add(key);
    setModeSaves(new Set(modeSavesRef.current));
    try {
      const response = await fetch(`/api/library/sessions/${s.id}/tracks/${itemId}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ playbackPreference: preference }),
      });
      if (!response.ok) throw new Error("The playback choice could not be saved.");
      const detail = (await response.json()).session as SessionDetail;
      const saved = detail.tracks.find((track) => track.id === itemId);
      if (!saved || saved.playbackPreference !== preference) throw new Error("The playback choice was not confirmed.");
      publishWaveyardQueueChange([s.id]);
      const latest = sessionRef.current;
      if (!latest || latest.id !== s.id || !latest.tracks.some((track) => track.id === itemId)) return;
      const protectedEntry = itemId === currentIdRef.current || fadeRef.current !== null
        || decksRef.current.some((deck, index) => deck?.transport.playing && deckItems[index]?.id === itemId);
      const next = { ...latest, tracks: latest.tracks.map((track) => track.id !== itemId ? track : {
        ...track,
        playbackPreference: saved.playbackPreference,
        ...(protectedEntry ? {} : { playback: saved.playback }),
      }) };
      sessionRef.current = next;
      setSession(next);
      if (!protectedEntry) {
        setStemsReady((previous) => {
          const targets = { ...previous };
          delete targets[itemId];
          if (preference === "source") {
            const target = stemsPlaybackTarget(saved);
            if (target) targets[itemId] = target;
          }
          return targets;
        });
      }
      setStatus(`${preference === "source" ? "Full track" : "Stems"} saved for “${item.track.title}”${protectedEntry ? " for its next load; current playback is unchanged" : ""}.`);
    } catch {
      if (sessionRef.current?.id === s.id) setStatus(`Could not save the playback mode for “${item.track.title}”. Try again; playback is unchanged.`);
    } finally {
      modeSavesRef.current.delete(key);
      setModeSaves(new Set(modeSavesRef.current));
    }
  }, [deckItems]);

  const returnToFullTrack = useCallback(async (itemId: string) => {
    const s = sessionRef.current;
    const item = s?.tracks.find((track) => track.id === itemId);
    if (s === null || item === undefined || item.playback?.kind !== "stems" || item.sourceAssetId === null) return;
    const deckIndex = deckItems[0]?.id === itemId ? 0 : deckItems[1]?.id === itemId ? 1 : -1;
    const api = deckIndex >= 0 ? decksRef.current[deckIndex] : null;
    if (api === null) {
      setStatus("Load this track onto a deck before returning to the full track.");
      return;
    }
    const sourceItem: SessionTrackItem = {
      ...item,
      playback: { kind: "source", assetIds: [item.sourceAssetId] },
      playbackPreference: "source",
    };
    setStatus(`Preparing the full track for “${item.track.title}”…`);
    const prepared = await api.prepareHandoff(sourceItem, {});
    if (prepared === null) {
      setStatus("The full track could not be prepared. The current stem mix keeps playing.");
      return;
    }
    const next = { ...s, tracks: s.tracks.map((track) => track.id === itemId ? sourceItem : track) };
    sessionRef.current = next;
    setSession(next);
    setStemsReady((current) => ({ ...current, [itemId]: item }));
    try {
      const response = await fetch(`/api/library/sessions/${s.id}/tracks/${itemId}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ playbackPreference: "source" }),
      });
      if (!response.ok) throw new Error("The playback choice could not be saved.");
      setStatus(`Returned to the full track at ${formatClock(prepared.position)} without interrupting playback.`);
    } catch {
      setStatus(`Returned to the full track at ${formatClock(prepared.position)}, but the choice could not be saved. Try switching again when the session is online.`);
    }
  }, [deckItems]);

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
    const cue = automaticTransitionCue(cfg, duration, currentItem.analysis?.beatGridMs ?? null, nextItem.analysis?.beatGridMs ?? null);
    const triggerMs = cue.startInCurrentMs ?? Math.max(0, duration - cfg.crossfadeSeconds) * 1000;
    if (autoCrossfadeStartedForRef.current === currentItem.id) {
      // Rearm only after a genuine rewind, not while the clock is still
      // approaching the duration-based fallback after a skipped aligned cue.
      if (currentPosition * 1000 >= triggerMs - 1000) return;
      autoCrossfadeStartedForRef.current = null;
    }
    const timing = automaticCueTiming(currentPosition * 1000, triggerMs);
    if (timing === "wait") return;
    autoCrossfadeStartedForRef.current = currentItem.id;
    if (!cue.ok || cue.startInCurrentMs === null || cue.incomingOffsetMs === null) {
      setStatus(`${cue.reason} Automatic fade skipped; the next track will start at the end.`);
      return;
    }
    if (cfg.mode !== "manual" && timing === "missed") {
      setStatus("The verified automatic fade cue was missed; the next track will start at the end.");
      return;
    }
    void beginTransition({ startInCurrentMs: cue.startInCurrentMs, incomingOffsetMs: cue.incomingOffsetMs });
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

  const setLevel = (itemId: string) => (stemType: string, value: number) => {
    cancelPendingPerformance("Pending stem changes cancelled by fader movement.");
    endTemporaryIsolation();
    const item = session.tracks.find((track) => track.id === itemId);
    let levels = { ...(mixesRef.current[itemId] ?? item?.stemMix ?? {}), [stemType]: value };
    if (item !== undefined) {
      const performance = (transitionsRef.current[itemId] ?? item.transition).performance ?? defaultPerformance();
      if (performance.isolatedStem !== null) {
        levels = {
          ...performMix(
            mixesRef.current[itemId] ?? item.stemMix,
            performance,
            { kind: "restore" },
            item.stems.map((stem) => stem.stemType),
          ).mix,
          [stemType]: value,
        };
      }
    }
    const nextMixes = { ...mixesRef.current, [itemId]: levels };
    mixesRef.current = nextMixes;
    setMixes(nextMixes);
    if (item !== undefined) setPerformanceForItem(item, { isolatedStem: null, beforeIsolation: null });
  };
  const resetMix = (item: SessionTrackItem) => {
    cancelPendingPerformance();
    endTemporaryIsolation();
    const levels = Object.fromEntries(item.stems.map((stem) => [stem.stemType, 1]));
    const nextMixes = { ...mixesRef.current, [item.id]: levels };
    mixesRef.current = nextMixes;
    setMixes(nextMixes);
    setPerformanceForItem(item, { recall: {}, isolatedStem: null, beforeIsolation: null });
    const deckIndex = deckItems[0]?.id === item.id ? 0 : deckItems[1]?.id === item.id ? 1 : -1;
    if (deckIndex >= 0) decksRef.current[deckIndex as 0 | 1]?.applyStemVolumes(levels);
  };
  const actionForItem = (itemId: string, deckIndex: 0 | 1) => (action: PerformanceAction) =>
    requestPerformance(itemId, deckIndex, action);
  const updateSnap = (item: SessionTrackItem, snap: PerformanceSnap) => {
    cancelPendingPerformance();
    setPerformanceForItem(item, { snap });
  };
  const setTransition = (patch: Partial<TransitionConfig>) => {
    if (currentItem === null) return;
    const current = transitionsRef.current[currentItem.id] ?? currentItem.transition;
    const nextTransitions = { ...transitionsRef.current, [currentItem.id]: { ...current, ...patch } };
    transitionsRef.current = nextTransitions;
    setTransitions(nextTransitions);
  };
  const toggleKeep = (stemType: string) => {
    if (currentItem === null) return;
    const kept = new Set(keepSet);
    if (kept.has(stemType)) kept.delete(stemType);
    else kept.add(stemType);
    setTransition({ keepStems: [...kept] });
  };
  const seekCurrent = (value: number) => {
    cancelPendingPerformance("Pending stem changes cancelled by seek.");
    endTemporaryIsolation();
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

  const handleLocalRemoteCommand = (command: LocalRemoteCommand) => {
    if (command.type === "toggle-play") {
      void togglePlay();
    } else if (command.type === "next") {
      if (phase === "fading") finishTransition();
      else if (nextItem !== null) jumpTo(nextItem.id, playingByDeck[activeDeck]);
    } else if (command.type === "previous") {
      if (previousItem !== null) jumpTo(previousItem.id, playingByDeck[activeDeck]);
    } else if (command.type === "select-track") {
      if (session?.tracks.some((item) => item.id === command.itemId)) {
        jumpTo(command.itemId, playingByDeck[activeDeck]);
      }
    } else if (command.type === "seek") {
      seekCurrent(Math.max(0, Math.min(duration, command.positionSeconds)));
    } else if (command.type === "set-stem-level") {
      if (currentItem?.stems.some((stem) => stem.stemType === command.stemType)) {
        setLevel(currentItem.id)(command.stemType, Math.max(0, Math.min(2, command.level)));
      }
    } else if (command.type === "isolate-stem") {
      if (currentItem?.stems.some((stem) => stem.stemType === command.stemType)) {
        requestPerformance(currentItem.id, activeDeck, { kind: "isolate", stem: command.stemType });
      }
    } else if (command.type === "restore-mix" && currentItem !== null) {
      requestPerformance(currentItem.id, activeDeck, { kind: "restore" });
    }
  };

  const startSessionTrackSeparation = async (trackId: string) => {
    const track = library.find((item) => item.id === trackId);
    if (track === undefined || preparingSeparationTrackIds.has(trackId) || track.stemAvailability.status === "processing") return;

    setPreparingSeparationTrackIds((previous) => new Set(previous).add(trackId));
    setStatus(null);
    const markProcessing = () => setLibrary((previous) => previous.map((item) => item.id === trackId
      ? {
          ...item,
          stemAvailability: {
            status: "processing",
            reason: "Stem separation is running — the current mix keeps playing until the stems are ready.",
          },
        }
      : item));
    const readBody = async (response: Response) =>
      await response.json().catch(() => ({})) as Record<string, unknown>;

    try {
      let response: Response;
      let body: Record<string, unknown>;
      if (track.stemAvailability.status === "failed" || track.stemAvailability.status === "rejected") {
        response = await fetch(`/api/jobs/${track.stemAvailability.retryJobId}/retry`, { method: "POST" });
        body = await readBody(response);
      } else {
        response = await fetch(`/api/library/tracks/${trackId}/separation`, { method: "POST" });
        body = await readBody(response);
        if (body.state === "previous-attempt" && typeof body.jobId === "string") {
          response = await fetch(`/api/jobs/${body.jobId}/retry`, { method: "POST" });
          body = await readBody(response);
        }
      }

      if (body.state === "separated") {
        const refresh = await fetch("/api/library/tracks", { cache: "no-store" });
        if (refresh.ok) {
          const latest = await refresh.json() as { tracks?: LibraryTrackOption[] };
          if (Array.isArray(latest.tracks)) setLibrary(latest.tracks);
        }
        setStatus(`${track.title}: stems are already available. Choose it from the ready sources.`);
        return;
      }
      if (response.ok || body.state === "queued" || body.state === "processing") {
        markProcessing();
        setStatus(`${track.title}: separation started. Keep listening; your current mix will not stop.`);
        return;
      }
      if (body.state === "failed" && typeof body.jobId === "string") {
        setLibrary((previous) => previous.map((item) => item.id === trackId
          ? {
              ...item,
              stemAvailability: {
                status: "rejected",
                reason: typeof body.error === "string" ? body.error : "The separation worker did not accept this job.",
                retryJobId: body.jobId as string,
              },
            }
          : item));
      }
      setStatus(`${track.title}: ${typeof body.error === "string" ? body.error : "Separation could not be started."}`);
    } catch {
      setStatus(`${track.title}: separation could not be started. Check the connection and try again.`);
    } finally {
      setPreparingSeparationTrackIds((previous) => {
        const next = new Set(previous);
        next.delete(trackId);
        return next;
      });
    }
  };

  const swapExtra = (stemType: string) => {
    if (currentItem === null) return null;
    const swap = session.swaps.filter((s) => s.sessionTrackId === currentItem.id && s.stemType === stemType).at(-1);
    const pendingSwap = pendingSwaps.find((pending) => pending.sessionTrackId === currentItem.id && pending.stemType === stemType);
    const donors = session.tracks.filter((item) =>
      item.track.id !== currentItem.track.id && validateStemSwap(currentItem.stems, item.stems, stemType).ok,
    );
    const selectedDonorBpm = swap === undefined ? null
      : session.tracks.find((item) => item.track.id === swap.toTrackId)?.analysis?.bpm
        ?? library.find((item) => item.id === swap.toTrackId)?.analysis?.bpm
        ?? null;
    const inSession = new Set(session.tracks.map((item) => item.track.id));
    const libraryDonors = library.filter((item) => !inSession.has(item.id) &&
      item.id !== currentItem.track.id &&
      item.stemAvailability?.status === "separated" &&
      item.stemAvailability.stemTypes.includes(stemType));
    const preparationCandidates: LiveStemPreparationOption[] = library.flatMap((item) => {
      if (item.id === currentItem.track.id) return [];
      const availability = item.stemAvailability;
      if (availability.status === "separated" || availability.status === "unavailable") return [];
      const progress = availability.status === "processing" ? availability.progress : undefined;
      const progressLabel = progress
        ? progress.phase && isMultiPassSeparationPhase(progress.phase)
          ? progress.phase
          : `${progress.percent}%`
        : undefined;
      return [{
        id: item.id,
        title: item.title,
        artist: item.artist,
        status: availability.status,
        ...(progressLabel !== undefined ? { progressLabel } : {}),
      }];
    });
    const candidates: LiveStemDonorOption[] = [
      ...donors.map((donor) => ({
        id: donor.track.id,
        title: donor.track.title,
        artist: donor.track.artist,
        bpm: donor.analysis?.bpm ?? null,
        musicalKey: donor.analysis?.musicalKey ?? null,
        collection: "session" as const,
      })),
      ...libraryDonors.map((donor) => ({
        id: donor.id,
        title: donor.title,
        artist: donor.artist,
        bpm: donor.analysis?.bpm ?? null,
        musicalKey: donor.analysis?.musicalKey ?? null,
        collection: "library" as const,
      })),
    ];
    const selectedDonor = session.tracks.find((item) => item.track.id === swap?.toTrackId);
    const selectedDonorTitle = selectedDonor?.track.title
      ?? library.find((item) => item.id === swap?.toTrackId)?.title
      ?? swap?.donorTrack?.title
      ?? null;
    const swapStatus = swap === undefined ? null
      : pendingSwap
        ? "Preparing live layer…"
        : activeSwapTempoStretchRatios[stemType] !== undefined
          ? "Tempo matched · pitch preserved"
          : selectedDonorBpm !== null
            ? `Native tempo · ${Math.round(selectedDonorBpm)} BPM`
            : "Tempo unavailable · native tempo";
    return (
      <LiveStemSwapPicker
        stemType={stemType}
        currentBpm={currentItem.analysis?.bpm ?? null}
        currentKey={currentItem.analysis?.musicalKey ?? null}
        candidates={candidates}
        preparationCandidates={preparationCandidates}
        preparingTrackIds={preparingSeparationTrackIds}
        selectedDonorId={swap?.toTrackId ?? null}
        selectedDonorTitle={selectedDonorTitle}
        swapStatus={swapStatus}
        isOpen={openSwapStem === stemType}
        pending={pendingSwap !== undefined}
        busy={savingSwapKeys.has(`${currentItem.id}:${stemType}`)}
        onToggle={() => setOpenSwapStem((current) => current === stemType ? null : stemType)}
        onClose={() => setOpenSwapStem(null)}
        onWarm={(donorId) => {
          const donor = donors.find((item) => item.track.id === donorId);
          if (donor) {
            void warmLiveSwap(stemType, {
              id: donor.track.id,
              stems: donor.stems,
              bpm: donor.analysis?.bpm ?? null,
            });
            return;
          }
          const source = libraryDonors.find((item) => item.id === donorId);
          if (source) void warmLiveSwap(stemType, { id: source.id, bpm: source.analysis?.bpm ?? null });
        }}
        onPrefetch={(donorId) => prefetchLiveSwapAsset(stemType, donorId)}
        onChoose={(donorId) => {
          const donor = donors.find((item) => item.track.id === donorId);
          if (donor) {
            void requestSwap(stemType, {
              id: donor.track.id,
              title: donor.track.title,
              stems: donor.stems,
              bpm: donor.analysis?.bpm ?? null,
            });
            return;
          }
          const source = libraryDonors.find((item) => item.id === donorId);
          if (source) void requestSwap(stemType, { id: source.id, title: source.title, bpm: source.analysis?.bpm ?? null });
        }}
        onPrepare={(trackId) => { void startSessionTrackSeparation(trackId); }}
        onRestore={() => {
          if (swap) void revertSwap(swap.id);
        }}
      />
    );
  };

  const deckProps = (deckIndex: 0 | 1) => {
    const item = deckItems[deckIndex];
    const isActive = deckIndex === activeDeck;
    const liveSwapFailures = failedLiveSwaps.filter((failure) => failure.sessionTrackId === item?.id);
    return {
      deckIndex,
      item,
      active: isActive,
      startAt: startAtFor(deckIndex),
      swaps: isActive ? activeSwaps : {},
      swapSelectionTimes: isActive && item !== null
        ? Object.fromEntries(item.stems.flatMap((stem) => {
          const selectedAt = swapSelectionTimes[`${item.id}:${stem.stemType}`];
          return selectedAt === undefined ? [] : [[stem.stemType, selectedAt]];
        }))
        : {},
      tempoStretchRatios: isActive ? activeSwapTempoStretchRatios : {},
      masterLevel,
      autoPlay: item !== null && autoPlayId === item.id && (isActive || resumeAt?.itemId === item.id),
      onAutoPlayed: () => {
        setAutoPlayId(null);
        setResumeAt(null);
      },
      levels: item ? mixes[item.id] ?? {} : {},
      onLevel: item ? setLevel(item.id) : () => undefined,
      performanceSettings: item
        ? transitions[item.id]?.performance ?? item.transition.performance ?? defaultPerformance()
        : defaultPerformance(),
      playbackRate,
      onPlaybackRateChange: (value: number) => setPlaybackRate(normalizeSessionPlaybackRate(value)),
      pitchPreserving,
      pitchLockBusy,
      pitchLockMessage: isActive ? pitchLockMessage : null,
      onPitchPreservingChange: changePitchPreserving,
      onPerformanceAction: item ? actionForItem(item.id, deckIndex) : () => undefined,
      onSnapChange: item ? (snap: PerformanceSnap) => updateSnap(item, snap) : () => undefined,
      onInstantRestoreChange: item
        ? (enabled: boolean) => setPerformanceForItem(item, { instantRestore: enabled })
        : () => undefined,
      onHoldStart: item && isActive
        ? (stemType: string) => beginTemporaryIsolation(item.id, stemType)
        : () => undefined,
      onHoldEnd: endTemporaryIsolation,
      heldStem: item !== null && temporaryIsolation?.itemId === item.id ? temporaryIsolation.stemType : null,
      pendingPerformanceLabel: item && pendingPerformance?.itemId === item.id && pendingPerformance.deckIndex === deckIndex
        ? `${pendingPerformance.actions.length} change${pendingPerformance.actions.length === 1 ? "" : "s"} queued · next ${pendingPerformance.snap}`
        : null,
      onCancelPendingPerformance: () => cancelPendingPerformance("Pending stem changes cancelled."),
      performanceDisabled: phase !== "idle",
      onReset: () => { if (item) resetMix(item); },
      stemExtra: isActive ? swapExtra : undefined,
      openSwapPickerStem: openSwapStem,
      onOpenSwapPicker: isActive ? (stemType: string) => setOpenSwapStem(stemType) : undefined,
      onLiveLayerReady: isActive ? markLiveLayerReady : undefined,
      onLiveLayerFailed: isActive ? markLiveLayerFailed : undefined,
      liveSwapFailure: isActive && liveSwapFailures.length > 0
        ? liveSwapFailures.map((failure) => failure.message).join(" ")
        : null,
      onRetryLiveSwap: isActive && item !== null && liveSwapFailures.length > 0
        ? () => { void retryFailedLiveSwaps(item.id); }
        : undefined,
      onReturnToSource: isActive && item?.playback?.kind === "stems" && item.sourceAssetId !== null
        ? () => void returnToFullTrack(item.id)
        : undefined,
      onApi: handleDeckApi,
      onPlaying: handleDeckPlaying,
      onProgress: handleDeckProgress,
      onEnded: handleDeckEnded,
    };
  };

  const localRemoteStems = currentItem === null
    ? []
    : (() => {
        const levels = effectiveMix(currentItem, mixes[currentItem.id] ?? currentItem.stemMix);
        const performance = transitions[currentItem.id]?.performance
          ?? currentItem.transition.performance
          ?? defaultPerformance();
        return currentItem.stems.map((stem) => ({
          stemType: stem.stemType,
          level: Math.max(0, Math.min(2, levels[stem.stemType] ?? 1)),
          isolated: performance.isolatedStem === stem.stemType,
        }));
      })();

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
        <LocalSessionPairing
          key={session.id}
          snapshot={{
            sessionName: session.name.slice(0, 120),
            trackId: currentItem?.id ?? null,
            title: currentItem?.track.title.slice(0, 120) ?? "",
            artist: currentItem?.track.artist.slice(0, 80) ?? "",
            nextTitle: nextItem?.track.title.slice(0, 120) ?? null,
            previousTitle: previousItem?.track.title.slice(0, 120) ?? null,
            queue: session.tracks.slice(
              Math.max(0, currentIndex - 1),
              Math.min(session.tracks.length, currentIndex + 9),
            ).map((item) => ({
              id: item.id,
              title: item.track.title.slice(0, 120),
              artist: item.track.artist.slice(0, 80),
              durationSeconds: item.track.durationSeconds,
            })),
            stems: localRemoteStems,
            positionSeconds: position,
            durationSeconds: duration,
            playing,
          }}
          onCommand={handleLocalRemoteCommand}
        />
        {variant === "compact" && (
          <Link className="wy-open" href={`/waveyard/session/${session.id}`}>Open mixer</Link>
        )}
      </div>

      {pendingSwaps.map((pending) => (
        <p key={pending.swapId} className="sess-status wy-ready" role="status" data-testid={`live-swap-pending-${pending.stemType}`}>
          {pending.failed
            ? `${pending.stemType} switch failed; the previous audio continues. Its saved source still needs restoring. `
            : pending.cancelRequested && pending.savePending
            ? `Stopping ${pending.stemType} switch to “${pending.donorTitle}”; current playback continues. `
            : pending.savePending
            ? `Saving ${pending.stemType} source from “${pending.donorTitle}”; current playback continues. `
            : cancelledSwapIds.has(pending.swapId)
            ? `${pending.stemType} switch stopped; current playback continues. `
            : `Preparing ${pending.stemType} from “${pending.donorTitle}”; current playback continues. `}
          <button
            type="button"
            className="button tiny"
            aria-label={pending.cancelRequested && pending.savePending
              ? `Wait for cancellation of ${pending.stemType} switch`
              : pending.failed
                ? `Retry saving previous ${pending.stemType} source`
                : cancelledSwapIds.has(pending.swapId)
                  ? `Retry removing ${pending.stemType} switch`
                  : `Cancel ${pending.stemType} switch to ${pending.donorTitle}`}
            data-testid={`cancel-live-stem-swap-${pending.swapId}`}
            disabled={pending.cancelRequested || (
              savingSwapKeys.has(`${pending.sessionTrackId}:${pending.stemType}`) && !pending.savePending
            )}
            onClick={() => void revertSwap(pending.swapId, `${pending.stemType} switch cancelled; the previous audio continues.`)}
          >
            {pending.cancelRequested && pending.savePending
              ? "Stopping…"
              : pending.savePending
                ? "Cancel switch"
                : savingSwapKeys.has(`${pending.sessionTrackId}:${pending.stemType}`)
              ? "Saving…"
              : pending.failed
                ? "Retry saving previous source"
                : cancelledSwapIds.has(pending.swapId)
                  ? "Retry removing switch"
                  : "Cancel switch"}
          </button>
        </p>
      ))}

      <div className="wy-full-only">
        {currentItem !== null &&
          (currentSourceAvailability?.status === "source-only" ||
            currentSourceAvailability?.status === "not-started" ||
            currentSourceAvailability?.status === "failed" ||
            currentSourceAvailability?.status === "rejected") && (
            <p className="sess-status wy-ready" role="status" data-testid={`session-separation-action-${currentItem.id}`}>
              {currentSourceAvailability.status === "failed" || currentSourceAvailability.status === "rejected"
                ? `Separation failed for “${currentItem.track.title}”. Retry here; playback keeps going.`
                : `“${currentItem.track.title}” is playing as full audio. Separate it here to unlock live stems.`}{" "}
              <button
                type="button"
                className="button tiny"
                aria-label={`${currentSourceAvailability.status === "failed" || currentSourceAvailability.status === "rejected" ? "Retry" : "Start"} separation for ${currentItem.track.title}`}
                data-testid={`button-start-session-separation-${currentItem.id}`}
                disabled={preparingSeparationTrackIds.has(currentItem.track.id)}
                onClick={() => void startSessionTrackSeparation(currentItem.track.id)}
              >
                {preparingSeparationTrackIds.has(currentItem.track.id)
                  ? "Starting…"
                  : currentSourceAvailability.status === "failed" || currentSourceAvailability.status === "rejected"
                    ? "Retry separation"
                    : "Separate stems"}
              </button>
            </p>
          )}
        {sessionSeparationProgress.map(({ id, title, stage, progress }) => {
          const progressDetail = progress
            ? progress.phase && isMultiPassSeparationPhase(progress.phase)
              ? ` · ${progress.phase}`
              : ` · ${progress.percent}%${progress.phase ? ` · ${progress.phase}` : ""}`
            : "";
          const label = progress
            ? `${stage === "finalizing" || progress.percent === 100 ? "Finishing" : "Separating"}${progressDetail}`
            : "Separating";
          return (
            <p key={id} className="sess-status" role="status" data-testid={`session-separation-progress-${id}`}>
              {label} “{title}”. The full source keeps playing while the stems finish.
            </p>
          );
        })}
        {Object.values(stemsReady).map((item) => (
          <p key={item.id} className="sess-status wy-ready" role="status">
            Stems are ready for “{item.track.title}”. It keeps playing the full source until you switch.{" "}
            <button type="button" className="button tiny" onClick={() => switchToStems(item.id)} data-testid={`button-switch-stems-${item.id}`}>Switch to stems</button>
          </p>
        ))}
        {status !== null && (
          <p className="sess-status" role="status" data-testid="session-status">
            {status}
            {currentItem?.playback?.kind === "stems"
              && currentItem.sourceAssetId !== null
              && /full track could not (?:load|be prepared)/i.test(status)
              && (
                <>
                  {" "}
                  <button
                    type="button"
                    className="button tiny"
                    data-testid={`button-retry-full-track-${currentItem.id}`}
                    onClick={() => void returnToFullTrack(currentItem.id)}
                  >
                    Retry full track
                  </button>
                </>
              )}
          </p>
        )}
        {loadError !== null && <p className="sess-status" role="alert">{loadError}</p>}
        {handoff !== null && (
          <p className="sess-handoff" role="status">
            Studio arrangement created with {handoff.remixTrackCount} remix track{handoff.remixTrackCount === 1 ? "" : "s"}
            {handoff.preservedSwapCount
              ? ` · ${handoff.preservedSwapCount} live stem swap${handoff.preservedSwapCount === 1 ? "" : "s"} carried over`
              : ""}
            {handoff.preservedTransitionCount
              ? ` · ${handoff.preservedTransitionCount} session crossfade${handoff.preservedTransitionCount === 1 ? "" : "s"} carried over`
              : ""}
            {handoff.transitionWarnings && handoff.transitionWarnings.length > 0
              ? ` — transition notes: ${handoff.transitionWarnings.map((item) => `${item.fromTitle} → ${item.toTitle}: ${item.reason}`).join("; ")}`
              : ""}
            {handoff.fullSourceCount
              ? ` · ${handoff.fullSourceCount} full-source session ${handoff.fullSourceCount === 1 ? "entry" : "entries"} (not separated)`
              : ""}
            {handoff.refused && handoff.refused.length > 0
              ? ` — not included: ${handoff.refused.map((item) => `${item.title} (${item.reason})`).join("; ")}.`
              : "."}{" "}
            <Link
              href={`/waveyard/projects/${handoff.projectId}?view=studio`}
              data-testid="link-open-studio"
            >
              Open in Studio
            </Link>
          </p>
        )}
        <fieldset className="sess-studio-picker" disabled={sendingToStudio}>
          <legend>Tracks to send to Studio</legend>
          <div className="sess-studio-picker-header">
            <span data-testid="studio-track-selection-count">
              {selectedStudioTrackIds.length} selected of {studioSelectableTrackIds.length} selectable {studioSelectableTrackIds.length === 1 ? "track" : "tracks"}
            </span>
            <div className="sess-studio-picker-actions">
              <button
                type="button"
                className="button tiny"
                disabled={currentItem === null || (
                  !getStudioTrackReadiness(currentItem, library).ready
                  && !getStudioTrackReadiness(currentItem, library).canUseFullSource
                )}
                onClick={() => {
                  if (currentItem === null) return;
                  setStudioTrackSelection({ sessionId: session.id, trackIds: [currentItem.id] });
                  setHandoff(null);
                  setStatus(null);
                }}
              >
                Current only
              </button>
              <button
                type="button"
                className="button tiny"
                disabled={selectedStudioTrackIds.length === 0}
                onClick={() => {
                  setStudioTrackSelection({ sessionId: session.id, trackIds: [] });
                  setHandoff(null);
                  setStatus(null);
                }}
              >
                Clear selection
              </button>
              <button
                type="button"
                className="button tiny"
                disabled={selectedStudioTrackIds.length === studioReadyTrackIds.length}
                onClick={() => {
                  setStudioTrackSelection({ sessionId: session.id, trackIds: studioReadyTrackIds });
                  setHandoff(null);
                  setStatus(null);
                }}
              >
                Select all ready
              </button>
            </div>
          </div>
          {session.tracks.some((item) => !getStudioTrackReadiness(item, library).ready) && (
            <p className="sess-status" data-testid="studio-unready-note">
              Separated stems are used when ready. Select a “full source available” entry to add its original audio as one Studio track, or{" "}
              <Link href="/waveyard">start or retry separation in the Library</Link>. Full-source entries require a separation job to have started.
            </p>
          )}
          <div className="sess-studio-picker-list">
            {session.tracks.map((item, index) => {
              const readiness = getStudioTrackReadiness(item, library);
              return (
                <label className="sess-studio-picker-option" key={item.id}>
                  <input
                    type="checkbox"
                    checked={selectedStudioTrackIds.includes(item.id)}
                    disabled={!readiness.ready && !readiness.canUseFullSource}
                    aria-label={`Include session entry ${index + 1}, ${item.track.title} by ${item.track.artist}, in Studio`}
                    aria-describedby={`studio-readiness-${item.id}`}
                    onChange={(event) => {
                      const checked = event.currentTarget.checked;
                      setStudioTrackSelection((previous) => {
                        const currentIds = previous?.sessionId === session.id
                            ? previous.trackIds.filter((id) => studioSelectableTrackIds.includes(id))
                          : studioReadyTrackIds;
                        return {
                          sessionId: session.id,
                          trackIds: checked
                            ? [...new Set([...currentIds, item.id])]
                            : currentIds.filter((id) => id !== item.id),
                        };
                      });
                      setHandoff(null);
                      setStatus(null);
                    }}
                  />
                  <span>
                    Entry {index + 1}: {item.track.title}
                    <small id={`studio-readiness-${item.id}`}>{item.track.artist} · {readiness.label}</small>
                  </span>
                </label>
              );
            })}
          </div>
        </fieldset>
        <div className="wy-drawer-actions sess-studio-action">
          <button
            type="button"
            className="button secondary"
            onClick={sendToStudio}
            disabled={selectedStudioTrackIds.length === 0 || sendingToStudio}
            data-testid="session-handoff"
          >
            {sendingToStudio
              ? "Creating Studio arrangement…"
              : `Create Studio arrangement with ${selectedStudioTrackIds.length} ${selectedStudioTrackIds.length === 1 ? "track" : "tracks"}`}
          </button>
        </div>

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
                libraryTracks={library
                  .filter((track) => !session.tracks.some((item) => item.track.id === track.id))
                  .map((track) => ({
                    id: track.id,
                    title: track.title,
                    artist: track.artist,
                    key: track.analysis?.musicalKey ?? null,
                  }))}
                disabled={phase === "fading"}
                onSetNext={setSessionTrackAsNext}
                onAddNext={setLibraryTrackAsNext}
              />
            )}
            <p className="wy-fine">Mute or isolate to lock a stem; hold to audition it briefly. Restore all returns every layer to full volume.</p>
          </div>
          <SessionDeck {...deckProps(1)} />
        </div>

        <details className="wy-drawer">
          <summary>Session order · {session.tracks.length}</summary>
          <p className="wy-fine">Playlist-only entries move between session-only slots. Saved queue entries stay in place.</p>
          <ol className="sess-queue-list">
            {session.tracks.map((item, index) => (
              <li key={item.id} className={`sess-queue-item${item.id === currentItem?.id ? " current" : ""}${item.id === nextItem?.id ? " next" : ""}`}>
                <button type="button" className="sess-queue-jump" onClick={() => jumpTo(item.id, playing)}>
                  <span className="sess-queue-pos">{index + 1}</span>
                  <span>
                    {item.track.title}
                    <small>{item.track.artist || "Unknown artist"}{item.id === currentItem?.id ? " · current" : item.id === nextItem?.id ? " · next" : ""}{item.queueItemId === null ? " · session only" : " · saved queue"}</small>
                  </span>
                </button>
                <span className="sess-queue-actions">
                  {item.id !== currentItem?.id && item.sourceAssetId !== null && stemsPlaybackTarget(item) !== null && (
                    <label className="sess-queue-mode">
                      <span>Playback</span>
                      <select
                        aria-label={`Playback mode for ${item.track.title}, entry ${index + 1}`}
                        data-testid={`session-playback-mode-${item.id}`}
                        value={item.playbackPreference ?? item.playback?.kind ?? "stems"}
                        disabled={phase === "fading" || modeSaves.has(`${session.id}:${item.id}`)}
                        aria-busy={modeSaves.has(`${session.id}:${item.id}`)}
                        onChange={(event) => void chooseUpcomingMode(item.id, event.target.value as "source" | "stems")}
                      >
                        <option value="source">Full track</option>
                        <option value="stems">Stems</option>
                      </select>
                    </label>
                  )}
                  <button type="button" className="button tiny" aria-label={`Move ${item.track.title} earlier`} disabled={movingTrack || !session.tracks.slice(0, index).some((entry) => item.queueItemId !== null || entry.queueItemId === null)} onClick={() => void moveTrack(item.id, -1)}>Up</button>
                  <button type="button" className="button tiny" aria-label={`Move ${item.track.title} later`} disabled={movingTrack || !session.tracks.slice(index + 1).some((entry) => item.queueItemId !== null || entry.queueItemId === null)} onClick={() => void moveTrack(item.id, 1)}>Down</button>
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
