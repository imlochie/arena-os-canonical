"use client";

import Link from "@/routing/Link";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { LibraryTrackSummary } from "@workspace/api-client-react";
import {
  useStemTransport,
  normalizeSessionPlaybackRate,
  supportsLiveKeyMatching,
  supportsSessionPitchModes,
  SESSION_PLAYBACK_RATE_MAX,
  SESSION_PLAYBACK_RATE_MIN,
  type ChannelMeter,
  type MixerValues,
  SessionAudioAssetPool,
  type SessionAudioMediaLease,
} from "@workspace/arena/lib/waveyard/useStemTransport";
import {
  hasReliableSessionBeatEvidence,
  nextSessionBeatLoop,
  SESSION_DJ_LOOP_LENGTHS,
} from "@workspace/arena/lib/waveyard/session-dj-controls";
import { useHardwareMediaKeys } from "@workspace/arena/lib/waveyard/stem2";
import { isMultiPassSeparationPhase, normalizeStemMix } from "@workspace/arena/lib/waveyard/library/model";
import {
  localStorageSessionSaveJournal,
  sessionSavePatchAgainstPending,
  sessionSavePatchForTrack,
  SessionSaveQueue,
} from "@workspace/arena/lib/waveyard/library/session-save-queue";
import Stem2Panel from "@/components/waveyard/stem2/Stem2Panel";
import CamelotWheel from "./CamelotWheel";
import SessionKeyMatchingControls from "./SessionKeyMatchingControls";
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
  hasReliableLiveStemBeatEvidence,
  hasReliableLiveStemTempoEvidence,
  isHalfDoubleTempoPair,
  keyCompatibilityEvidence,
  liveStemTempoStretchRatio,
  liveStemBeatOffsetSeconds,
  liveStemSectionOffsetSeconds,
  nextSessionTrack,
  scaleCrossfadeStemVolumes,
  tempoCompatibility,
  validateStemSwap,
  normalizeTransitionConfig,
  type TransitionConfig,
  type TransitionMode,
} from "@workspace/arena/lib/waveyard/library/session-logic";
import {
  resolveSessionKeyMatch,
  resolveLiveStemKeyCorrection,
  shiftMusicalKey,
  type SessionKeyMode,
  type SessionKeyShifts,
} from "@workspace/arena/lib/waveyard/library/session-key-matching";
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
  publishWaveyardLibraryTrackChange,
  publishWaveyardQueueChange,
  publishWaveyardTransportChange,
  subscribeToWaveyardQueueChanges,
  subscribeToWaveyardResume,
  type WaveyardRemoteTransport,
} from "./queue-sync";

// ---------------------------------------------------------------------------
// Types mirrored from the session API payload.
// ---------------------------------------------------------------------------

const SESSION_MASTER_LEVEL_STORAGE_KEY = "waveyard:session-master-level:v1";

function readStoredSessionMasterLevel(): number {
  if (typeof window === "undefined") return 1;
  try {
    const stored = window.localStorage.getItem(SESSION_MASTER_LEVEL_STORAGE_KEY);
    if (stored === null) return 1;
    const value = Number(stored);
    return Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : 1;
  } catch {
    return 1;
  }
}

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
  analysis: {
    bpm: number | null;
    bpmConfidence: number | null;
    beatConfidence: number | null;
    keyConfidence: number | null;
    musicalKey: string | null;
    beatGridMs: number[] | null;
    sections: Array<{
      sectionIndex: number;
      startMs: number;
      endMs: number;
      startBeatIndex: number;
      endBeatIndex: number;
      label: string;
      labelConfidence: number;
      structuralConfidence: number;
    }> | null;
  } | null;
}

interface SessionDetail {
  id: string;
  name: string;
  currentSessionTrackId: string | null;
  positionSeconds: number;
  keyMatchMode?: SessionKeyMode;
  keyShifts?: SessionKeyShifts;
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
      analysis?: SessionTrackItem["analysis"];
    } | null;
  }>;
  createdAt: string;
  updatedAt: string;
}

function savedKeyShiftFor(item: SessionTrackItem | null, shifts: SessionKeyShifts): number {
  if (item === null) return 0;
  const saved = shifts[item.id];
  return saved?.trackId === item.track.id ? saved.semitones : 0;
}

function keyShiftsForTracks(shifts: SessionKeyShifts, tracks: SessionTrackItem[]): SessionKeyShifts {
  const tracksById = new Map(tracks.map((item) => [item.id, item.track.id]));
  return Object.fromEntries(Object.entries(shifts).filter(([sessionTrackId, shift]) =>
    tracksById.get(sessionTrackId) === shift.trackId));
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
  requestSequence: number;
  selectedAt: number;
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
    bpmConfidence?: number | null;
    beatConfidence?: number | null;
  };
  previousSwap?: SessionDetail["swaps"][number];
  failed?: boolean;
}

interface FailedLiveSwap {
  sessionTrackId: string;
  stemType: string;
  selectedAt: number;
  message: string;
  donor: PendingLiveSwap["retryDonor"];
}

interface SwapMutationScope {
  sessionId: string;
  sessionTrackId: string;
  stemType: string;
  requestSequence?: number;
}

function swapMutationKey(scope: SwapMutationScope) {
  return `${scope.sessionId}:${scope.sessionTrackId}:${scope.stemType}`;
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

function getPersistedSwapSetup(
  session: SessionDetail | null,
  item: SessionTrackItem | null,
  library: LibraryTrackOption[],
  cancelledSwapIds: Set<string>,
  keyMode: SessionKeyMode,
  deckSemitones: number,
) {
  const swaps: Record<string, string> = {};
  const tempoStretchRatios: Record<string, number> = {};
  const beatOffsets: Record<string, number> = {};
  const sectionPositionMatches: Record<string, boolean> = {};
  const keyCorrections: Record<string, number> = {};
  const keyMatchStatuses: Record<string, string> = {};
  if (session === null || item === null) {
    return { swaps, tempoStretchRatios, beatOffsets, sectionPositionMatches, keyCorrections, keyMatchStatuses };
  }

  for (const swap of session.swaps) {
    if (swap.sessionTrackId !== item.id || cancelledSwapIds.has(swap.id)) continue;
    const donor = session.tracks.find((track) => track.track.id === swap.toTrackId);
    const donorStem = donor?.stems.find((stem) => stem.stemType === swap.stemType)
      ?? swap.donorTrack?.stems.find((stem) => stem.stemType === swap.stemType);
    if (donorStem) swaps[swap.stemType] = donorStem.id;

    const libraryDonorAnalysis = library.find((track) => track.id === swap.toTrackId)?.analysis ?? null;
    const donorAnalysis = donor?.analysis ?? swap.donorTrack?.analysis ?? null;
    const donorBpm = donorAnalysis?.bpm ?? libraryDonorAnalysis?.bpm ?? null;
    const tempoEvidence = {
      recipientBpmConfidence: item.analysis?.bpmConfidence,
      donorBpmConfidence: donorAnalysis?.bpmConfidence ?? libraryDonorAnalysis?.bpmConfidence,
      recipientBeatConfidence: item.analysis?.beatConfidence,
      donorBeatConfidence: donorAnalysis?.beatConfidence ?? libraryDonorAnalysis?.beatConfidence,
    };
    const reliableTempoEvidence = hasReliableLiveStemTempoEvidence(tempoEvidence);
    const reliableBeatEvidence = hasReliableLiveStemBeatEvidence(tempoEvidence);
    const ratio = liveStemTempoStretchRatio(item.analysis?.bpm ?? null, donorBpm, tempoEvidence);
    if (ratio !== null) tempoStretchRatios[swap.stemType] = ratio;
    const sectionOffset = ratio === null || !reliableBeatEvidence ? null : liveStemSectionOffsetSeconds(
      item.analysis?.sections,
      donorAnalysis?.sections,
      swap.atSeconds,
      ratio,
    );
    const beatOffset = ratio === null || !reliableBeatEvidence ? null : liveStemBeatOffsetSeconds(
      item.analysis?.beatGridMs,
      donorAnalysis?.beatGridMs,
      ratio,
    );
    const offset = sectionOffset ?? beatOffset;
    if (offset !== null) beatOffsets[swap.stemType] = offset;
    if (sectionOffset !== null) sectionPositionMatches[swap.stemType] = true;
    const donorKey = donor?.analysis?.musicalKey ?? swap.donorTrack?.analysis?.musicalKey
      ?? library.find((track) => track.id === swap.toTrackId)?.analysis?.musicalKey;
    const donorKeyConfidence = donor?.analysis?.keyConfidence ?? swap.donorTrack?.analysis?.keyConfidence
      ?? libraryDonorAnalysis?.keyConfidence;
    const leadKey = shiftMusicalKey(item.analysis?.musicalKey, deckSemitones);
    const keyEvidence = keyCompatibilityEvidence(
      leadKey,
      item.analysis?.keyConfidence,
      donorKey ?? null,
      donorKeyConfidence,
    );
    const keyEvidenceConfident = keyEvidence.confidenceLevel === "confident";
    const match = keyEvidenceConfident
      ? resolveSessionKeyMatch(keyMode, leadKey, donorKey)
      : { targetKey: null, semitones: null };
    const correction = keyEvidenceConfident
      ? resolveLiveStemKeyCorrection(keyMode, item.analysis?.musicalKey, donorKey, deckSemitones, swap.stemType)
      : null;
    if (correction !== null) keyCorrections[swap.stemType] = correction;
    const matchedMode = match.targetKey?.split(" ")[1];
    const leadMode = leadKey?.split(" ")[1];
    const modeDiffers = keyMode === "match" && matchedMode !== undefined && leadMode !== undefined
      && matchedMode !== leadMode;
    keyMatchStatuses[swap.stemType] = swap.stemType === "drums"
      ? "Drum pitch preserved"
      : keyMode === "preserve" || keyMode === "off"
        ? "Donor pitch preserved"
        : match.semitones === null
          ? keyEvidence.confidenceLevel === "tentative"
            ? "Key uncertain · donor pitch preserved"
            : "Key confidence unavailable · donor pitch preserved"
          : modeDiffers
            ? "Tonic matched · mode preserved"
            : match.semitones === 0
            ? "Key already aligned"
            : keyMode === "camelot" ? "Camelot-compatible key matched" : "Key matched to lead";
  }
  return { swaps, tempoStretchRatios, beatOffsets, sectionPositionMatches, keyCorrections, keyMatchStatuses };
}

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
  outputGroup,
  item,
  active,
  startAt,
  swaps,
  swapSelectionTimes,
  tempoStretchRatios,
  beatOffsets,
  keyCorrections,
  masterLevel,
  autoPlay,
  onAutoPlayed,
  levels,
  onLevel,
  performanceSettings,
  playbackRate,
  onPlaybackRateChange,
  pitchModesAvailable,
  pitchPreserving,
  pitchLockBusy,
  pitchLockMessage,
  onPitchPreservingChange,
  keyShiftSemitones,
  onKeyShiftFailure,
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
  onAttachOriginalAudio,
  attachingOriginalAudio,
  onApi,
  onPlaying,
  onProgress,
  onEnded,
  audioAssetPool,
}: {
  deckIndex: 0 | 1;
  outputGroup: string;
  item: SessionTrackItem | null;
  active: boolean;
  startAt: number;
  swaps: Record<string, string>;
  swapSelectionTimes: Record<string, number>;
  tempoStretchRatios: Record<string, number>;
  beatOffsets: Record<string, number>;
  keyCorrections: Record<string, number>;
  masterLevel: number;
  autoPlay: boolean;
  onAutoPlayed: () => void;
  levels: Record<string, number>;
  onLevel: (stemType: string, value: number) => void;
  performanceSettings: PerformanceSettings;
  playbackRate: number;
  onPlaybackRateChange: (value: number) => void;
  pitchModesAvailable: boolean;
  pitchPreserving: boolean;
  pitchLockBusy: boolean;
  pitchLockMessage: string | null;
  onPitchPreservingChange: (enabled: boolean) => void;
  keyShiftSemitones: number;
  onKeyShiftFailure: (itemId: string | null, message: string) => void;
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
  onLiveLayerReady?: (sessionTrackId: string, stemType: string, selectedAt: number | null) => void;
  onLiveLayerFailed?: (sessionTrackId: string, stemType: string, message: string, selectedAt: number | null) => void;
  liveSwapFailure?: string | null;
  onRetryLiveSwap?: () => void;
  onReturnToSource?: () => void;
  onAttachOriginalAudio?: (file: File) => void;
  attachingOriginalAudio?: boolean;
  onApi: (deckIndex: number, api: DeckApi | null) => void;
  onPlaying: (deckIndex: number, playing: boolean) => void;
  onProgress: (deckIndex: number, position: number) => void;
  onEnded: (deckIndex: number, itemId: string) => void;
  audioAssetPool: SessionAudioAssetPool;
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
  const transport = useStemTransport(transportIds, duration, assetIds, outputGroup, audioAssetPool);
  const [cuePosition, setCuePosition] = useState(0);
  const [selectedLoopBeats, setSelectedLoopBeats] = useState<number | null>(null);
  useEffect(() => {
    transport.setPlaybackRate(playbackRate);
  }, [playbackRate, transport.setPlaybackRate]);
  useEffect(() => {
    let stale = false;
    const applyKeyShift = async () => {
      try {
        if (keyShiftSemitones !== 0 && assetIds.length > 0) transport.prepareChannels(assetIds);
        await transport.setKeyShiftSemitones(keyShiftSemitones);
      } catch (error) {
        if (!stale) onKeyShiftFailure(
          item?.id ?? null,
          error instanceof Error ? error.message : "Live key matching could not be applied.",
        );
      }
    };
    void applyKeyShift();
    return () => { stale = true; };
  }, [assetIds, item?.id, keyShiftSemitones, onKeyShiftFailure, transport.prepareChannels, transport.setKeyShiftSemitones]);
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
    const range = nextSessionBeatLoop(
      item?.analysis?.beatGridMs,
      transport.position,
      beats,
      item?.analysis?.beatConfidence,
    );
    if (!range) return;
    transport.setLoop({ enabled: true, ...range });
    setSelectedLoopBeats(beats);
  };
  const mediaElements = useRef<Record<string, HTMLAudioElement | null>>({});
  const mediaAssetLeases = useRef(new Map<string, SessionAudioMediaLease>());
  const [, setMediaAssetSourceRevision] = useState(0);
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

  const activeRef = useRef(active);
  activeRef.current = active;
  useEffect(() => {
    const wantedIds = new Set(transportIds);
    for (const [id, lease] of mediaAssetLeases.current) {
      if (wantedIds.has(id)) continue;
      lease.release();
      mediaAssetLeases.current.delete(id);
    }

    const controller = new AbortController();
    let stale = false;
    const shouldShare = activeRef.current
      ? stagedIds
      : transportIds;
    const acquire = (id: string, replace = false) => {
      if (!replace && mediaAssetLeases.current.has(id)) return;
      void audioAssetPool.acquireMediaUrl(`/api/assets/${id}`, controller.signal).then((lease) => {
        if (stale || !wantedIds.has(id)) {
          lease.release();
          return;
        }
        // Replace only prepared/standby media. The audible deck retains its
        // current lease even if a donor decoder rejects those same bytes.
        if (replace && activeRef.current && !stagedIds.includes(id)) {
          lease.release();
          return;
        }
        mediaAssetLeases.current.get(id)?.release();
        mediaAssetLeases.current.set(id, lease);
        setMediaAssetSourceRevision((revision) => revision + 1);
      }).catch((error: unknown) => {
        if (stale || (error instanceof DOMException && error.name === "AbortError")) return;
        setMediaError(error instanceof Error
          ? error.message
          : "Session audio could not be prepared.");
      });
    };
    for (const id of shouldShare) acquire(id);
    const unsubscribe = audioAssetPool.subscribeToReplacement((url) => {
      for (const id of shouldShare) {
        if (url === `/api/assets/${id}` && (!activeRef.current || stagedIds.includes(id))) acquire(id, true);
      }
    });
    return () => {
      stale = true;
      unsubscribe();
      controller.abort();
    };
  }, [audioAssetPool, stagedIds, transportIds]);
  useEffect(() => () => {
    for (const lease of mediaAssetLeases.current.values()) lease.release();
    mediaAssetLeases.current.clear();
  }, [audioAssetPool]);

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
    return [id, donor, donor === null ? 1 : tempoStretchRatios[stemType] ?? 1, selectedAt, beatOffsets[stemType] ?? 0, keyCorrections[stemType] ?? 0];
  }));
  useEffect(() => {
    let stale = false;
    const layers = JSON.parse(swapKey) as Array<[string, string | null, number, number | null, number, number]>;
    setLoadingLayers(layers.some(([, donor]) => donor !== null));
    const replacements = layers.map(([id, donor, tempoStretchRatio, selectedAt, beatOffset, keyCorrection]) => {
      const stemType = stemTypeByAsset.get(id) ?? "source";
      return transport.replaceStem(id, donor ? `/api/assets/${donor}` : null, tempoStretchRatio, selectedAt ?? undefined, beatOffset, keyCorrection).then((installed) => {
        if (!stale && installed !== false && donor !== null && item !== null) {
          onLiveLayerReady?.(item.id, stemType, selectedAt);
        }
      }).catch((error: unknown) => {
        if (!stale && donor !== null && item !== null) {
          // The engine returns false for cancellation. Any rejection here is a
          // real preparation failure; roll back only this pending stem.
          const message = error instanceof Error ? error.message : "Live stem loading failed.";
          onLiveLayerFailed?.(item.id, stemType, `${stemType} switch failed: ${message} The previous layer was kept.`, selectedAt);
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
        const mediaLease = mediaAssetLeases.current.get(assetId);
        const src = mediaLease?.src ?? (active && !isStaged ? `/api/assets/${assetId}` : undefined);
        return (
          <audio
            key={assetId}
            aria-label={`${stemType} audio${donorAssetId ? " (swapped layer)" : ""}`}
            data-waveyard-asset-url={`/api/assets/${assetId}`}
            ref={(element) => {
              mediaElements.current[assetId] = element;
              transport.register(assetId, element);
            }}
            src={src}
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
                aria-valuetext={`${playbackRate.toFixed(2)} times${item.analysis?.bpm == null ? "" : `, ${Math.round(item.analysis.bpm * playbackRate)} BPM`}; ${pitchModesAvailable ? (pitchPreserving ? "pitch preserved" : "pitch follows speed") : "pitch mode unavailable"}`}
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
                {` · ${pitchModesAvailable ? (pitchPreserving ? "pitch stays steady" : "pitch follows speed") : "pitch control unavailable in this browser"}`}
              </small>
              {pitchModesAvailable && <button
                type="button"
                className={`wy-session-pitch-lock${pitchPreserving ? " is-active" : ""}`}
                aria-label={pitchPreserving
                  ? "Pitch locked; switch to pitch follows speed"
                  : "Pitch follows speed; enable pitch lock"}
                aria-pressed={pitchPreserving}
                disabled={pitchLockBusy}
                onClick={() => onPitchPreservingChange(!pitchPreserving)}
                data-testid="session-pitch-lock"
              >
                <span aria-hidden="true">{pitchPreserving ? "♫" : "♪"}</span>
                {pitchLockBusy ? "Switching…" : pitchPreserving ? "Pitch locked" : "Pitch follows speed"}
              </button>}
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
                  const range = nextSessionBeatLoop(
                    item.analysis?.beatGridMs,
                    transport.position,
                    beats,
                    item.analysis?.beatConfidence,
                  );
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
                {hasReliableSessionBeatEvidence(item.analysis?.beatConfidence)
                  ? "Loops enter on the next measured beat."
                  : item.analysis?.beatGridMs?.length
                    ? "Beat evidence is low confidence; beat loops are disabled."
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
                <div className="wy-stem-toolbar sess-source-restore">
                  <p
                    role="status"
                    data-testid={`full-track-unavailable-${item.id}`}
                  >
                    Original audio unavailable · stem playback and controls remain available
                  </p>
                  {onAttachOriginalAudio && (
                    <label className="sess-source-restore-picker">
                      <span>{attachingOriginalAudio ? "Attaching…" : "Attach original audio"}</span>
                      <input
                        type="file"
                        accept=".wav,.mp3,.flac,.m4a,.aac,.ogg,audio/wav,audio/mpeg,audio/flac,audio/mp4,audio/aac,audio/ogg"
                        aria-label={`Attach original audio for ${item.track.title}`}
                        data-testid={`input-attach-original-audio-${item.id}`}
                        disabled={attachingOriginalAudio}
                        onChange={(event) => {
                          const file = event.currentTarget.files?.[0];
                          event.currentTarget.value = "";
                          if (file) onAttachOriginalAudio(file);
                        }}
                      />
                    </label>
                  )}
                  <small>Choose a local audio file you own or are authorized to use.</small>
                </div>
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
                            className={`wy-stem-pad-swap${swaps[stem.stemType] ? " has-donor" : ""}`}
                            data-testid={`quick-open-live-swap-${stem.stemType}`}
                            data-live-swap-anchor={stem.stemType}
                            aria-label={`${swaps[stem.stemType] ? "Change" : "Choose"} live donor for ${stem.stemType}`}
                            aria-expanded={openSwapPickerStem === stem.stemType}
                            aria-controls={`live-swap-picker-${stem.stemType}`}
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
                      aria-label="Restore all stem levels and isolation"
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
                      <option value="quarter" disabled={!hasReliableSessionBeatEvidence(item.analysis?.beatConfidence)}>¼ beat</option>
                      <option value="half" disabled={!hasReliableSessionBeatEvidence(item.analysis?.beatConfidence)}>½ beat</option>
                      <option value="beat" disabled={!hasReliableSessionBeatEvidence(item.analysis?.beatConfidence)}>Beat</option>
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
                  {performanceSettings.snap !== "off" && !hasReliableSessionBeatEvidence(item.analysis?.beatConfidence) && (
                    <span className="wy-performance-note">Snap needs a beat grid with measured confidence of at least 0.50.</span>
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
  const audioAssetPool = useMemo(() => new SessionAudioAssetPool(), [sessionId]);
  useEffect(() => () => audioAssetPool.dispose(), [audioAssetPool]);
  const [session, setSession] = useState<SessionDetail | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [library, setLibrary] = useState<LibraryTrackOption[]>([]);
  const [preparingSeparationTrackIds, setPreparingSeparationTrackIds] = useState<Set<string>>(() => new Set());
  const [restoringOriginalTrackId, setRestoringOriginalTrackId] = useState<string | null>(null);
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
  const [warmingLiveSwap, setWarmingLiveSwap] = useState<{
    key: string;
    sessionTrackId: string;
    stemType: string;
    donorId: string;
  } | null>(null);
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
  const pendingLiveSwapRef = useRef(new Map<string, PendingLiveSwap>());
  const [failedLiveSwaps, setFailedLiveSwaps] = useState<FailedLiveSwap[]>([]);
  const [cancelledSwapIds, setCancelledSwapIds] = useState<Set<string>>(() => new Set());
  const pendingSwapRequestSequenceRef = useRef(0);
  const swapMutationRequestVersionsRef = useRef(new Map<string, number>());
  const pendingSwapCancelRequestsRef = useRef(new Set<string>());
  const [openSwapStem, setOpenSwapStem] = useState<string | null>(null);
  const [mixes, setMixes] = useState<Record<string, Record<string, number>>>({});
  const [transitions, setTransitions] = useState<Record<string, TransitionConfig>>({});
  const [pendingPerformance, setPendingPerformance] = useState<PendingPerformance | null>(null);
  const [temporaryIsolation, setTemporaryIsolation] = useState<TemporaryIsolation | null>(null);
  const [masterLevel, setMasterLevel] = useState(readStoredSessionMasterLevel);
  const [playbackRate, setPlaybackRate] = useState(1);
  const playbackRateRef = useRef(playbackRate);
  const [pitchModesAvailable] = useState(() => supportsSessionPitchModes());
  const [liveKeyMatchingAvailable] = useState(() => supportsLiveKeyMatching());
  const [pitchPreserving, setPitchPreserving] = useState(false);
  const pitchPreservingRef = useRef(pitchPreserving);
  const [pitchLockBusy, setPitchLockBusy] = useState(false);
  const [pitchLockMessage, setPitchLockMessage] = useState<string | null>(null);
  const [keyMode, setKeyMode] = useState<SessionKeyMode>("off");
  const [keyShiftByTrack, setKeyShiftByTrack] = useState<SessionKeyShifts>({});
  const [keyMatchBusy, setKeyMatchBusy] = useState(false);
  const [keyMatchError, setKeyMatchError] = useState<string | null>(null);
  useEffect(() => {
    setKeyMode("off");
    setKeyShiftByTrack({});
    setKeyMatchBusy(false);
    setKeyMatchError(null);
  }, [sessionId]);
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

  const reportKeyShiftFailure = useCallback((_itemId: string | null, message: string) => {
    setKeyMatchError(`${message} The current mix and playhead were kept.`);
  }, []);
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
  // All session GET paths share one order; committed edits invalidate older GETs.
  const sessionRequestVersion = useRef(0);
  const currentIdRef = useRef<string | null>(null);
  const autoCrossfadeStartedForRef = useRef<{
    trackId: string;
    nextTrackId: string;
    cueMs: number;
    requestId: number;
  } | null>(null);
  const automaticTransitionRequestIdRef = useRef(0);
  const pendingAutomaticTransitionRef = useRef<{
    requestId: number;
    trackId: string;
    nextTrackId: string;
    toDeck: 0 | 1;
  } | null>(null);
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
  const validKeyShifts = useMemo(
    () => keyShiftsForTracks(keyShiftByTrack, session?.tracks ?? []),
    [keyShiftByTrack, session?.tracks],
  );
  useEffect(() => {
    if (!session) return;
    setKeyShiftByTrack((previous) => keyShiftsForTracks(previous, session.tracks));
  }, [session?.tracks]);
  useEffect(() => {
    setOpenSwapStem(null);
  }, [currentItem?.id]);
  const nextItem = currentIndex >= 0 ? session?.tracks[currentIndex + 1] ?? null : null;
  const previousItem = currentIndex > 0 ? session?.tracks[currentIndex - 1] ?? null : null;
  const standbyDeckIndex: 0 | 1 = activeDeck === 0 ? 1 : 0;
  const currentTransition = currentItem ? transitions[currentItem.id] ?? currentItem.transition : null;

  // ------------------------------------------------------------ persistence
  const persistState = useCallback(async (override?: {
    id?: string | null;
    position?: number;
    keyMatchMode?: SessionKeyMode;
    keyShifts?: SessionKeyShifts;
  }) => {
    const s = sessionRef.current;
    if (s === null) return;
    const id = override?.id !== undefined ? override.id : currentIdRef.current;
    const raw = override?.position ?? decksRef.current[activeDeckRef.current]?.transport.position ?? 0;
    setSaveState("saving");
    try {
      const response = await fetch(`/api/library/sessions/${s.id}/state`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          currentSessionTrackId: id,
          positionSeconds: Math.max(0, Number.isFinite(raw) ? raw : 0),
          keyMatchMode: override?.keyMatchMode ?? keyMode,
          keyShifts: keyShiftsForTracks(override?.keyShifts ?? keyShiftByTrack, s.tracks),
        }),
        keepalive: true,
      });
      setSaveState(response.ok ? "saved" : "error");
    } catch {
      setSaveState("error");
    }
  }, [keyMode, keyShiftByTrack]);

  // ------------------------------------------------------------------- load
  const [reloadNonce, setReloadNonce] = useState(0);
  useEffect(() => {
    let cancelled = false;
    const timer = setTimeout(() => {
      void (async () => {
        setLoadError(null);
        const requestId = ++sessionRequestVersion.current;
        try {
          const [sessionResponse, libraryResponse] = await Promise.all([
            fetch(`/api/library/sessions/${sessionId}`, { cache: "no-store" }),
            fetch("/api/library/tracks", { cache: "no-store" }),
          ]);
          if (cancelled || requestId !== sessionRequestVersion.current) return;
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
          if (cancelled || requestId !== sessionRequestVersion.current) return;
          const restoredCurrent =
            detail.currentSessionTrackId !== null && detail.tracks.some((item) => item.id === detail.currentSessionTrackId)
              ? detail.currentSessionTrackId
              : (detail.tracks[0]?.id ?? null);
          const nextMixes: Record<string, Record<string, number>> = {};
          const nextTransitions: Record<string, TransitionConfig> = {};
          let restoredPatches: Array<[string, string]> = [];
          if (typeof window !== "undefined") {
            try {
              restoredPatches = localStorageSessionSaveJournal(
                window.localStorage,
                `arena:waveyard:session-saves:${detail.id}`,
              ).read();
            } catch { /* Storage may be unavailable; server state remains usable. */ }
          }
          for (const item of detail.tracks) {
            const patch = sessionSavePatchForTrack(restoredPatches, detail.id, item.id);
            const allowedStemTypes = new Set(item.stems.map((stem) => stem.stemType));
            const restoredMix = normalizeStemMix(patch?.stemMixPatch);
            nextMixes[item.id] = {
              ...item.stemMix,
              ...Object.fromEntries(Object.entries(restoredMix).filter(([stemType]) => allowedStemTypes.has(stemType))),
            };
            nextTransitions[item.id] = normalizeTransitionConfig(patch?.transition) ?? item.transition;
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
          setKeyMode(detail.keyMatchMode ?? "off");
          setKeyShiftByTrack(detail.keyShifts ?? {});
          setSession(detail);
          if (libraryResponse.ok) {
            const tracks = ((await libraryResponse.json()).tracks ?? []) as LibraryTrackOption[];
            if (!cancelled) setLibrary(tracks);
          }
        } catch {
          if (!cancelled && requestId === sessionRequestVersion.current) setLoadError("The session could not be loaded — check the connection and retry.");
        }
      })();
    }, 0);
    return () => {
      cancelled = true;
      ++sessionRequestVersion.current;
      clearTimeout(timer);
      // Leaving this session (switch or unmount): save where we were.
      if (sessionRef.current?.id === sessionId) void persistState();
    };
    // Retry uses the same initialization path so a session switch cannot race
    // a second loader that skips restoring the current track and saved mixes.
    // eslint-disable-next-line react-hooks/exhaustive-deps -- reload per session id or explicit retry only
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

  const currentKeyShift = savedKeyShiftFor(currentItem, validKeyShifts);
  const leadEffectiveKey = currentItem
    ? shiftMusicalKey(currentItem.analysis?.musicalKey, currentKeyShift)
    : null;
  const resolvedNextKeyMatch = nextItem
    ? resolveSessionKeyMatch(keyMode, leadEffectiveKey, nextItem.analysis?.musicalKey)
    : {
        semitones: null,
        sourceKey: null,
        targetKey: null,
        reason: "Choose a next track to calculate a key match.",
      };
  const nextKeyEvidence = nextItem
    ? keyCompatibilityEvidence(
        leadEffectiveKey,
        currentItem?.analysis?.keyConfidence,
        nextItem.analysis?.musicalKey ?? null,
        nextItem.analysis?.keyConfidence,
      )
    : null;
  const nextKeyMatch = nextItem
    && (keyMode === "camelot" || keyMode === "match")
    && nextKeyEvidence?.confidenceLevel !== "confident"
    ? {
        ...resolvedNextKeyMatch,
        semitones: null,
        targetKey: null,
        reason: "Key analysis confidence is too low for automatic pitch correction; preserve source pitch.",
      }
    : resolvedNextKeyMatch;
  const nextKeyShift = nextKeyMatch.semitones ?? 0;
  const currentSwapSetup = useMemo(
    () => getPersistedSwapSetup(session, currentItem, library, cancelledSwapIds, keyMode, currentKeyShift),
    [session, currentItem, library, cancelledSwapIds, keyMode, currentKeyShift],
  );
  const nextSwapSetup = useMemo(
    () => getPersistedSwapSetup(session, nextItem, library, cancelledSwapIds, keyMode, nextKeyShift),
    [session, nextItem, library, cancelledSwapIds, keyMode, nextKeyShift],
  );
  useEffect(() => {
    if (!nextItem || nextKeyMatch.semitones === null) return;
    if (
      validKeyShifts[nextItem.id]?.trackId === nextItem.track.id
      && validKeyShifts[nextItem.id]?.semitones === nextKeyMatch.semitones
    ) return;
    const shifts = {
      ...validKeyShifts,
      [nextItem.id]: { trackId: nextItem.track.id, semitones: nextKeyMatch.semitones },
    };
    setKeyShiftByTrack(shifts);
    void persistState({
      id: currentIdRef.current,
      position: decksRef.current[activeDeckRef.current]?.transport.position ?? session?.positionSeconds ?? 0,
      keyShifts: shifts,
    });
  }, [validKeyShifts, nextItem, nextKeyMatch.semitones, persistState, session]);
  const changeKeyMatchingMode = useCallback(async (requestedMode: SessionKeyMode) => {
    if (keyMatchBusy) return;
    if (!currentItem || !nextItem) {
      setKeyMatchError("Choose a current and next track before changing key modes.");
      return;
    }
    const matchingMode = requestedMode === "camelot" || requestedMode === "match";
    const requestedEvidence = keyCompatibilityEvidence(
      leadEffectiveKey,
      currentItem.analysis?.keyConfidence,
      nextItem.analysis?.musicalKey ?? null,
      nextItem.analysis?.keyConfidence,
    );
    const requestedMatch = resolveSessionKeyMatch(
      requestedMode,
      leadEffectiveKey,
      nextItem.analysis?.musicalKey,
    );
    if (matchingMode && (
      !liveKeyMatchingAvailable
      || requestedMatch.semitones === null
      || requestedEvidence.confidenceLevel !== "confident"
    )) {
      setKeyMatchError(!liveKeyMatchingAvailable
        ? "Live key matching needs AudioWorklet support in a secure browser context."
        : requestedEvidence.confidenceLevel !== "confident"
          ? "Key matching needs confident analysis for both tracks; no pitch shift was applied."
          : requestedMatch.reason);
      return;
    }

    const otherDeck = activeDeck === 0 ? 1 : 0;
    const previousShifts = [
      { deck: activeDeck, item: currentItem, semitones: savedKeyShiftFor(currentItem, keyShiftByTrack) },
      { deck: otherDeck, item: nextItem, semitones: savedKeyShiftFor(nextItem, keyShiftByTrack) },
    ] as const;
    const shifts: SessionKeyShifts = {
      [currentItem.id]: { trackId: currentItem.track.id, semitones: 0 },
      [nextItem.id]: { trackId: nextItem.track.id, semitones: requestedMatch.semitones ?? 0 },
    };
    const requestedShifts = [
      { deck: activeDeck, item: currentItem, semitones: 0 },
      { deck: otherDeck, item: nextItem, semitones: requestedMatch.semitones ?? 0 },
    ] as const;
    setKeyMatchBusy(true);
    setKeyMatchError(null);
    try {
      for (const request of requestedShifts) {
        const api = decksRef.current[request.deck];
        if (!api || api.itemId !== request.item.id) {
          throw new Error("A session deck is changing tracks. Try the key mode again in a moment.");
        }
        const assetIds = request.item.playback?.assetIds ?? [];
        if (request.semitones !== 0 && assetIds.length > 0) api.transport.prepareChannels(assetIds);
        await api.transport.setKeyShiftSemitones(request.semitones);
      }
      setKeyShiftByTrack(shifts);
      setKeyMode(requestedMode);
      void persistState({ keyMatchMode: requestedMode, keyShifts: shifts });
    } catch (error) {
      await Promise.all(previousShifts.map(async (previous) => {
        const api = decksRef.current[previous.deck];
        if (api?.itemId === previous.item.id) {
          await api.transport.setKeyShiftSemitones(previous.semitones).catch(() => undefined);
        }
      }));
      setKeyMatchError(`${error instanceof Error ? error.message : "Live key matching failed."} The previous mix and playhead were kept.`);
    } finally {
      setKeyMatchBusy(false);
    }
  }, [activeDeck, currentItem, keyMatchBusy, keyShiftByTrack, leadEffectiveKey, liveKeyMatchingAvailable, nextItem, persistState]);
  const activeSwaps = currentSwapSetup.swaps;
  const activeSwapTempoStretchRatios = currentSwapSetup.tempoStretchRatios;

  const publishTransport = useCallback((snapshot: {
    trackId: string | null;
    positionSeconds: number;
    playing: boolean;
    action: "state" | "seek" | "speed" | "pitch";
    playbackRate?: number;
    pitchPreserving?: boolean;
    priority?: "control" | "heartbeat";
  }) => {
    // Speed and pitch are direct user controls even while a passive remote
    // snapshot is applying its playhead. Suppressing either command makes the
    // mirror's control appear to change briefly before the owner resets it.
    if (applyingRemoteTransportRef.current && snapshot.action !== "speed" && snapshot.action !== "pitch") return null;
    const published = publishWaveyardTransportChange({
      sessionId,
      ...snapshot,
      playbackRate: snapshot.playbackRate ?? playbackRateRef.current,
      pitchPreserving: snapshot.pitchPreserving ?? pitchPreservingRef.current,
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

  const changePlaybackRate = useCallback((value: number) => {
    const rate = normalizeSessionPlaybackRate(value);
    if (Math.abs(rate - playbackRateRef.current) < 0.001) return;
    playbackRateRef.current = rate;
    setPlaybackRate(rate);
    for (const deck of decksRef.current) deck?.transport.setPlaybackRate(rate);

    const activeApi = decksRef.current[activeDeckRef.current];
    const remote = remoteTransportRef.current;
    const useRemoteState = activeApi?.transport.playing !== true && remote?.sessionId === sessionId;
    publishTransport({
      trackId: useRemoteState ? remote.trackId : currentIdRef.current,
      positionSeconds: useRemoteState
        ? remote.positionSeconds
        : activeApi?.transport.position ?? 0,
      playing: useRemoteState ? remote.playing : activeApi?.transport.playing ?? false,
      action: "speed",
      playbackRate: rate,
    });
  }, [publishTransport, sessionId]);

  const changePitchPreserving = useCallback(async (enabled: boolean) => {
    if (pitchLockBusy || !pitchModesAvailable || enabled === pitchPreservingRef.current) return;
    const previous = pitchPreservingRef.current;
    const active = decksRef.current[activeDeck];
    const standby = decksRef.current[activeDeck === 0 ? 1 : 0];
    setPitchLockBusy(true);
    setPitchLockMessage(null);
    try {
      if (!active) throw new Error("The active deck is not ready.");
      await active.transport.setPitchPreserving(enabled);
      if (standby) await standby.transport.setPitchPreserving(enabled);
      pitchPreservingRef.current = enabled;
      setPitchPreserving(enabled);
      const remote = remoteTransportRef.current;
      const activeApi = decksRef.current[activeDeckRef.current];
      const useRemoteState = activeApi?.transport.playing !== true && remote?.sessionId === sessionId;
      publishTransport({
        trackId: useRemoteState ? remote.trackId : currentIdRef.current,
        positionSeconds: useRemoteState
          ? remote.positionSeconds
          : activeApi?.transport.position ?? 0,
        playing: useRemoteState ? remote.playing : activeApi?.transport.playing ?? false,
        action: "pitch",
        pitchPreserving: enabled,
      });
    } catch (error) {
      await Promise.all([
        active?.transport.setPitchPreserving(previous).catch(() => undefined),
        standby?.transport.setPitchPreserving(previous).catch(() => undefined),
      ]);
      pitchPreservingRef.current = previous;
      setPitchLockMessage(error instanceof Error
        ? `${error.message} Playback was left running.`
        : "Pitch mode could not be changed. Playback was left running.");
    } finally {
      setPitchLockBusy(false);
    }
  }, [activeDeck, pitchLockBusy, pitchModesAvailable, publishTransport, sessionId]);

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
  const lastSentRef = useRef<Record<string, {
    stemMix: Record<string, number>;
    transitionJson: string;
  }>>({});
  const saveQueueRef = useRef<SessionSaveQueue | null>(null);
  useEffect(() => {
    if (session === null) return;
    let journal;
    if (typeof window !== "undefined") {
      try {
        journal = localStorageSessionSaveJournal(window.localStorage, `arena:waveyard:session-saves:${session.id}`);
      } catch {
        journal = undefined;
      }
    }
    const queue = new SessionSaveQueue(async (url, body) => {
      const response = await fetch(url, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body,
      });
      if (!response.ok) throw new Error(`Session save failed (${response.status}).`);
      const match = /^\/api\/library\/sessions\/([^/]+)\/tracks\/([^/]+)$/.exec(url);
      if (!match) return;
      const saved = lastSentRef.current[`${match[1]}:${match[2]}`];
      if (!saved) return;
      const patch = JSON.parse(body) as { stemMixPatch?: Record<string, number>; transition?: TransitionConfig };
      lastSentRef.current[`${match[1]}:${match[2]}`] = {
        stemMix: { ...saved.stemMix, ...patch.stemMixPatch },
        transitionJson: patch.transition === undefined ? saved.transitionJson : JSON.stringify(patch.transition),
      };
    }, (status) => setMixSaveError(status === "error"), 600, journal);
    saveQueueRef.current = queue;
    const flushPendingOnExit = () => { void queue.flush(); };
    window.addEventListener("pagehide", flushPendingOnExit);
    return () => {
      window.removeEventListener("pagehide", flushPendingOnExit);
      void queue.flush();
      if (saveQueueRef.current === queue) saveQueueRef.current = null;
    };
  }, [session?.id]);
  useEffect(() => {
    if (session === null) return;
    const items = [currentItem, nextItem].filter((item): item is SessionTrackItem => item !== null);
    const timer = setTimeout(() => {
      void (async () => {
        for (const item of items) {
          const key = `${session.id}:${item.id}`;
          if (lastSentRef.current[key] === undefined) {
            // First sight of this item: what's on the server is the baseline.
            lastSentRef.current[key] = {
              stemMix: effectiveMix(item, item.stemMix),
              transitionJson: JSON.stringify(item.transition),
            };
          }
          const mix = effectiveMix(item, mixes[item.id] ?? item.stemMix);
          const transition = transitions[item.id] ?? item.transition;
          const transitionJson = JSON.stringify(transition);
          const saved = lastSentRef.current[key];
          if (saved === undefined) continue;
          const url = `/api/library/sessions/${session.id}/tracks/${item.id}`;
          const pendingWrites = saveQueueRef.current?.pendingWrites(url) ?? {};
          const body = sessionSavePatchAgainstPending(saved, { stemMix: mix, transitionJson }, pendingWrites);
          if (body === null) continue;
          saveQueueRef.current?.enqueue(url, body);
        }
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
    const wantsSnap = deckIndex === activeDeck
      && item.id === currentIdRef.current
      && deck?.transport.playing === true
      && settings.snap !== "off";
    const beatEvidenceReliable = hasReliableSessionBeatEvidence(item.analysis?.beatConfidence);
    const shouldSnap = wantsSnap
      && beatEvidenceReliable
      && !(restoring && settings.instantRestore);
    if (!shouldSnap) {
      cancelPendingPerformance();
      applyPerformanceActions(item, deckIndex, [action]);
      if (wantsSnap && !beatEvidenceReliable) {
        setStatus("Beat snap unavailable: this track’s measured beat confidence is low. The stem change was applied immediately.");
      }
      return;
    }

    const position = deck?.transport.currentPosition() ?? NaN;
    let target = nextPerformanceBoundary(
      position,
      item.analysis?.beatGridMs,
      settings.snap,
      undefined,
      PERFORMANCE_MINIMUM_LEAD_SECONDS,
    );
    if (target === null && settings.snap === "bar") {
      target = nextPerformanceBoundary(
        position,
        item.analysis?.beatGridMs,
        "beat",
        undefined,
        PERFORMANCE_MINIMUM_LEAD_SECONDS,
      );
      if (target !== null) setStatus("No verified bar boundary is available; using the next verified beat.");
    }
    if (target === null) {
      cancelPendingPerformance();
      applyPerformanceActions(item, deckIndex, [action]);
      setStatus(settings.snap === "bar"
        ? "No verified bar or beat boundary is available; applied immediately."
        : "No upcoming verified beat is available; applied immediately.");
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
    try {
      window.localStorage.setItem(SESSION_MASTER_LEVEL_STORAGE_KEY, String(masterLevel));
    } catch {
      // Audio remains usable when browser storage is unavailable.
    }
  }, [masterLevel]);
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

  const beginTransition = useCallback(async (automaticCue?: {
    startInCurrentMs: number;
    incomingOffsetMs: number;
    nextTrackId: string;
    requestId: number;
  }) => {
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
    if (toApi.itemId !== toItem.id) {
      setStatus("The next song is still loading. The current song keeps playing.");
      return;
    }
    const latestNextId = () => {
      const latest = sessionRef.current;
      const currentIndex = latest?.tracks.findIndex((item) => item.id === fromItem.id) ?? -1;
      return currentIndex >= 0 ? latest?.tracks[currentIndex + 1]?.id ?? null : null;
    };
    if (automaticCue && (
      currentIdRef.current !== fromItem.id
      || toItem.id !== automaticCue.nextTrackId
      || latestNextId() !== automaticCue.nextTrackId
    )) return;
    let cfg = transitions[fromItem.id] ?? fromItem.transition;
    advancingRef.current = false;
    if (automaticCue) {
      pendingAutomaticTransitionRef.current = {
        requestId: automaticCue.requestId,
        trackId: fromItem.id,
        nextTrackId: automaticCue.nextTrackId,
        toDeck,
      };
    }

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
    try {
      await toApi.transport.play();
    } catch (error) {
      if (!automaticCue) throw error;
      if (pendingAutomaticTransitionRef.current?.requestId === automaticCue.requestId) {
        pendingAutomaticTransitionRef.current = null;
        toApi.transport.setMasterVolume(masterRef.current);
      }
      return;
    }
    if (automaticCue) {
      const pending = pendingAutomaticTransitionRef.current;
      const stillSelected = currentIdRef.current === fromItem.id
        && latestNextId() === automaticCue.nextTrackId
        && pending?.requestId === automaticCue.requestId
        && pending.nextTrackId === automaticCue.nextTrackId;
      if (!stillSelected) {
        if (pending?.requestId === automaticCue.requestId) {
          toApi.transport.pause();
          toApi.transport.setMasterVolume(masterRef.current);
          pendingAutomaticTransitionRef.current = null;
        }
        return;
      }
      pendingAutomaticTransitionRef.current = null;
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
    const isCurrentSwapMutation = () =>
      swapScope?.requestSequence === undefined ||
      swapMutationRequestVersionsRef.current.get(swapMutationKey(swapScope)) === swapScope.requestSequence;
    try {
      const response = await fetch(input, init);
      if (!response.ok) {
        const body = (await response.json().catch(() => null)) as { error?: string; session?: SessionDetail } | null;
        if (!isCurrentSwapMutation()) return null;
        if (response.status === 409 && body?.session && sessionRef.current?.id === body.session.id) {
          // Only replace ordering/membership. A rejected move must not reset
          // this tab's live transport, mix, or audible playback selection.
          const current = sessionRef.current;
          const previous = new Map(current.tracks.map((item) => [item.id, item]));
          const next = {
            ...current,
            tracks: body.session.tracks.map((item) => {
              const old = previous.get(item.id);
              return old ? { ...old, position: item.position, queueItemId: item.queueItemId } : item;
            }),
          };
          ++sessionRequestVersion.current;
          sessionRef.current = next;
          setSession(next);
        }
        setStatus(body?.error ?? "The session change was rejected.");
        return null;
      }
      const detail = (await response.json()).session as SessionDetail;
      if (sessionRef.current !== null && sessionRef.current.id !== detail.id) return null;
      // A slower response for an earlier choice must not replace the session's
      // current donor or trigger another audio-graph swap.
      if (!isCurrentSwapMutation()) return detail;
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
      ++sessionRequestVersion.current;
      sessionRef.current = nextDetail;
      setSession(nextDetail);
      if (swapScope) publishWaveyardQueueChange([detail.id]);
      return nextDetail;
    } catch {
      if (isCurrentSwapMutation()) setStatus("The session change could not be saved — network error.");
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

  const remotePitchApplyRef = useRef(Promise.resolve());
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
    if (incoming.pitchPreserving !== undefined) {
      const enabled = incoming.pitchPreserving;
      remotePitchApplyRef.current = remotePitchApplyRef.current.then(async () => {
        const previousMode = pitchPreservingRef.current;
        if (enabled !== previousMode) {
          setPitchLockBusy(true);
          setPitchLockMessage(null);
          try {
            const decks = decksRef.current.filter((deck): deck is DeckApi => deck !== null);
            await Promise.all(decks.map((deck) => deck.transport.setPitchPreserving(enabled)));
            pitchPreservingRef.current = enabled;
            setPitchPreserving(enabled);
          } catch (error) {
            await Promise.all(decksRef.current.map((deck) =>
              deck?.transport.setPitchPreserving(previousMode).catch(() => undefined),
            ));
            setPitchLockMessage(error instanceof Error
              ? `${error.message} Playback was left running.`
              : "Pitch mode could not be changed. Playback was left running.");
          } finally {
            setPitchLockBusy(false);
          }
        }
        if (incoming.action === "pitch") {
          const activeApi = decksRef.current[activeDeckRef.current];
          if (activeApi?.transport.playing) {
            publishTransport({
              trackId: currentIdRef.current,
              positionSeconds: activeApi.transport.position,
              playing: true,
              action: "pitch",
              pitchPreserving: pitchPreservingRef.current,
            });
          }
        }
      }).catch(() => undefined);
    }
    if (incoming.playbackRate !== undefined) {
      const rate = normalizeSessionPlaybackRate(incoming.playbackRate);
      playbackRateRef.current = rate;
      setPlaybackRate(rate);
      for (const deck of decksRef.current) deck?.transport.setPlaybackRate(rate);
    }
    if (incoming.action === "speed" || incoming.action === "pitch") {
      // A mirror can change speed without moving the active owner's playhead.
      const activeApi = decksRef.current[activeDeckRef.current];
      if (incoming.action === "speed" && activeApi?.transport.playing && incoming.playbackRate !== undefined) {
        publishTransport({
          trackId: currentIdRef.current,
          positionSeconds: activeApi.transport.position,
          playing: true,
          action: "speed",
          playbackRate: playbackRateRef.current,
        });
      }
      return;
    }
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
  }, [sessionId, deckItems, abortTransition, persistState, publishTransport]);

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
        const requestId = ++sessionRequestVersion.current;
        try {
          const response = await fetch(`/api/library/sessions/${s.id}`, { cache: "no-store" });
          if (!response.ok) throw new Error(`HTTP ${response.status}`);
          const detail = (await response.json()).session as SessionDetail;
          if (requestId !== sessionRequestVersion.current || sessionRef.current?.id !== detail.id) return;
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
          if (requestId === sessionRequestVersion.current) setStatus("The saved queue changed, but the listening order could not be refreshed.");
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
              body: JSON.stringify({ sessionTrackId: existing.id, position: existingIdx < curIdx ? curIdx : insertAt, expectedOrder: s.tracks.map((item) => item.id) }),
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
      body: JSON.stringify({ sessionTrackId: itemId, position, expectedOrder: session.tracks.map((item) => item.id) }),
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
          body: JSON.stringify({ sessionTrackId: itemId, position: target.position, sessionOnly, expectedOrder: session.tracks.map((entry) => entry.id) }),
        });
        if (detail !== null) {
          publishWaveyardQueueChange([session.id]);
          setStatus("Session order updated.");
        }
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
        saveQueueRef.current?.forget(`/api/library/sessions/${session.id}/tracks/${itemId}`);
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
    (stemType: string, donor: {
      id: string;
      stems?: SessionTrackItem["stems"];
      bpm?: number | null;
      bpmConfidence?: number | null;
      beatConfidence?: number | null;
    }) => {
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
        {
          recipientBpmConfidence: currentItem.analysis?.bpmConfidence,
          donorBpmConfidence: donor.bpmConfidence,
          recipientBeatConfidence: currentItem.analysis?.beatConfidence,
          donorBeatConfidence: donor.beatConfidence,
        },
      ) ?? 1;
      setWarmingLiveSwap({
        key,
        sessionTrackId: currentItem.id,
        stemType,
        donorId: donor.id,
      });
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
        setWarmingLiveSwap((current) => current?.key === key ? null : current);
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
    async (stemType: string, donor: {
      id: string;
      title: string;
      stems?: SessionTrackItem["stems"];
      bpm?: number | null;
      bpmConfidence?: number | null;
      beatConfidence?: number | null;
    }) => {
      if (session === null || currentItem === null) return;
      const validation = donor.stems ? validateStemSwap(currentItem.stems, donor.stems, stemType) : null;
      if (validation && !validation.ok) {
        setStatus(validation.reason);
        return;
      }
      const selectedAt = performance.now();
      const requestSequence = ++pendingSwapRequestSequenceRef.current;
      const localSwapId = `pending-${requestSequence}`;
      const scope: SwapMutationScope = {
        sessionId: session.id,
        sessionTrackId: currentItem.id,
        stemType,
        requestSequence,
      };
      swapMutationRequestVersionsRef.current.set(swapMutationKey(scope), requestSequence);
      setFailedLiveSwaps((previous) => previous.filter(
        (failed) => failed.sessionTrackId !== currentItem.id || failed.stemType !== stemType,
      ));
      // Reuse any source warmed while the picker was open; swaps stay silent
      // until the persisted choice is committed and the audio graph replaces it.
      void warmLiveSwap(stemType, donor);
      const previousSwap = session.swaps.filter((swap) =>
        swap.sessionTrackId === currentItem.id && swap.stemType === stemType && !cancelledSwapIds.has(swap.id),
      ).at(-1);
      pendingSwapCancelRequestsRef.current.delete(localSwapId);
      const pendingChoice: PendingLiveSwap = {
        swapId: localSwapId,
        requestSequence,
        selectedAt,
        sessionTrackId: currentItem.id,
        stemType,
        donorTitle: donor.title,
        retryDonor: {
          id: donor.id,
          title: donor.title,
          stems: donor.stems,
          bpm: donor.bpm,
          bpmConfidence: donor.bpmConfidence,
          beatConfidence: donor.beatConfidence,
        },
        previousSwap,
        savePending: true,
      };
      pendingLiveSwapRef.current.set(swapMutationKey(scope), pendingChoice);
      setPendingSwaps((previous) => [
        ...previous.filter((pending) => !(pending.sessionTrackId === currentItem.id && pending.stemType === stemType)),
        pendingChoice,
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
        }, scope);
        if (detail) {
          const savedSwap = [...detail.swaps].reverse().find((swap) =>
            swap.sessionTrackId === currentItem.id && swap.stemType === stemType && swap.toTrackId === donor.id,
          );
          const cancelRequested = pendingSwapCancelRequestsRef.current.delete(localSwapId);
          const isLatestChoice = swapMutationRequestVersionsRef.current.get(swapMutationKey(scope)) === requestSequence;
          if (!isLatestChoice && !cancelRequested) return;
          if (savedSwap) {
            if (isLatestChoice) {
              const savedChoice = {
                ...pendingChoice,
                swapId: savedSwap.id,
                savePending: false,
                cancelRequested,
              };
              pendingLiveSwapRef.current.set(swapMutationKey(scope), savedChoice);
              setPendingSwaps((previous) => previous.map((pending) =>
                pending.swapId === localSwapId ? savedChoice : pending,
              ));
            }
            if (cancelRequested) {
              if (isLatestChoice) {
                setCancelledSwapIds((previous) => new Set([...previous, savedSwap.id]));
                for (const deck of decksRef.current) {
                  if (deck?.itemId !== currentItem.id) continue;
                  const stemId = currentItem.stems.find((stem) => stem.stemType === stemType)?.id;
                  if (stemId) deck.transport.cancelPendingStem(stemId);
                }
              }
              const removal = await mutate(
                `/api/library/sessions/${session.id}/swaps?swapId=${savedSwap.id}`,
                { method: "DELETE" },
                scope,
              );
              if (removal && isLatestChoice) {
                pendingLiveSwapRef.current.delete(swapMutationKey(scope));
                setPendingSwaps((previous) => previous.filter((pending) => pending.swapId !== savedSwap.id));
                setCancelledSwapIds((previous) => {
                  const next = new Set(previous);
                  next.delete(savedSwap.id);
                  return next;
                });
                setStatus(`${stemType} switch cancelled; the previous audio continues.`);
              } else if (!removal && isLatestChoice) {
                setStatus(`The ${stemType} switch is stopped locally, but its saved choice could not be removed. Retry removing it before leaving.`);
              }
            } else if (isLatestChoice) {
              setStatus(`${stemType} source saved: “${donor.title}”. Playback continues while the layer loads.`);
            }
          } else if (isLatestChoice) {
            pendingLiveSwapRef.current.delete(swapMutationKey(scope));
            setPendingSwaps((previous) => previous.filter((pending) => pending.swapId !== localSwapId));
            setStatus(`${stemType} source saved, but the selected source could not be confirmed.`);
          }
        } else {
          if (swapMutationRequestVersionsRef.current.get(swapMutationKey(scope)) === requestSequence) {
            pendingLiveSwapRef.current.delete(swapMutationKey(scope));
          }
          setPendingSwaps((previous) => previous.filter((pending) => pending.swapId !== localSwapId));
          if (swapMutationRequestVersionsRef.current.get(swapMutationKey(scope)) === requestSequence) {
            pendingSwapCancelRequestsRef.current.delete(localSwapId);
          }
        }
      } finally {
        pendingSwapCancelRequestsRef.current.delete(localSwapId);
        if (swapMutationRequestVersionsRef.current.get(swapMutationKey(scope)) === requestSequence) {
          setSwapSaving(currentItem.id, stemType, false);
        }
      }
    },
    [session, currentItem, mutate, activeDeck, warmLiveSwap, cancelledSwapIds, setSwapSaving],
  );

  const revertSwap = useCallback(
    async (swapId: string, successMessage = "Original stem restored.", failed = false) => {
      const currentSession = sessionRef.current?.id === session?.id
        ? sessionRef.current
        : session;
      if (currentSession === null) {
        setStatus("The session is unavailable; the failed stem change could not be restored.");
        return;
      }
      const pending = [...pendingLiveSwapRef.current.values()].find((swap) => swap.swapId === swapId)
        ?? pendingSwaps.find((swap) => swap.swapId === swapId);
      const savedSwap = currentSession.swaps.find((swap) => swap.id === swapId);
      const savedPendingSwap = pending && currentSession.swaps.find((swap) =>
        swap.sessionTrackId === pending.sessionTrackId &&
        swap.stemType === pending.stemType &&
        swap.toTrackId === pending.retryDonor.id,
      );
      const persistedSwap = savedSwap ?? savedPendingSwap;
      const targetSwap = pending ?? persistedSwap;
      if (!targetSwap) {
        setStatus("This failed stem change could not be matched to the saved session. The current saved choice was left unchanged.");
        return;
      }
      const persistedSwapId = persistedSwap?.id ?? swapId;
      const scopeKey = swapMutationKey({
        sessionId: currentSession.id,
        sessionTrackId: targetSwap.sessionTrackId,
        stemType: targetSwap.stemType,
      });
      const requestSequence = pending?.requestSequence ?? ++pendingSwapRequestSequenceRef.current;
      if (pending && swapMutationRequestVersionsRef.current.get(scopeKey) !== requestSequence) {
        setStatus("A newer stem choice is active; the older failure was ignored.");
        return;
      }
      if (!pending) swapMutationRequestVersionsRef.current.set(scopeKey, requestSequence);
      const scope: SwapMutationScope = {
        sessionId: currentSession.id,
        sessionTrackId: targetSwap.sessionTrackId,
        stemType: targetSwap.stemType,
        requestSequence,
      };
      if (pending?.savePending && !persistedSwap) {
        if (!pending.cancelRequested) {
          pendingSwapCancelRequestsRef.current.add(swapId);
          pendingLiveSwapRef.current.set(scopeKey, { ...pending, cancelRequested: true });
          setPendingSwaps((previous) => previous.map((swap) =>
            swap.swapId === swapId ? { ...swap, cancelRequested: true } : swap,
          ));
          for (const deck of decksRef.current) {
            if (deck?.itemId !== pending.sessionTrackId) continue;
            const item = currentSession.tracks.find((track) => track.id === pending.sessionTrackId);
            const stemId = item?.stems.find((stem) => stem.stemType === pending.stemType)?.id;
            if (stemId) deck.transport.cancelPendingStem(stemId);
          }
          setStatus(`${pending.stemType} switch cancellation queued; current playback continues.`);
        }
        return;
      }
      if (pending?.savePending && persistedSwap) {
        // The session response can render before requestSwap gets a chance to
        // replace its local pending id with the server id. A failure in that
        // small window must recover the committed selection, not cancel it.
        const savedChoice = { ...pending, swapId: persistedSwap.id, savePending: false };
        pendingLiveSwapRef.current.set(scopeKey, savedChoice);
        setPendingSwaps((previous) => previous.map((swap) =>
          swap.swapId === swapId ? savedChoice : swap,
        ));
      }
      const previousSwap = (failed || pending?.failed) ? pending?.previousSwap : undefined;
      if (pending) {
        if (previousSwap) {
          // Keep the saved failed selection in place until its guarded restore
          // finishes. Filtering it out here would tell the engine to remove A,
          // even though A is still playing underneath the failed preparation.
          if (pending) pendingLiveSwapRef.current.set(scopeKey, { ...pending, failed: true });
          setPendingSwaps((previous) => previous.map((swap) =>
            swap.swapId === swapId ? { ...swap, failed: true } : swap,
          ));
        } else {
          setCancelledSwapIds((previous) => new Set([...previous, persistedSwapId]));
        }
        // Cancel locally before waiting for persistence. A late donor response
        // must not take over even if the delete request is slow or fails.
        for (const deck of decksRef.current) {
          if (deck?.itemId !== pending.sessionTrackId) continue;
          const item = currentSession.tracks.find((track) => track.id === pending.sessionTrackId);
          const stemId = item?.stems.find((stem) => stem.stemType === pending.stemType)?.id;
          if (stemId) deck.transport.cancelPendingStem(stemId);
        }
        setStatus(successMessage);
      }
      setSwapSaving(targetSwap.sessionTrackId, targetSwap.stemType, true);
      try {
        const detail = previousSwap
          ? await mutate(`/api/library/sessions/${currentSession.id}/swaps`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              sessionTrackId: previousSwap.sessionTrackId,
              stemType: previousSwap.stemType,
              toTrackId: previousSwap.toTrackId,
              toStemAssetId: previousSwap.toStemAssetId,
              atSeconds: previousSwap.atSeconds,
              expectedSwapId: persistedSwapId,
            }),
          }, scope)
          : await mutate(`/api/library/sessions/${currentSession.id}/swaps?swapId=${persistedSwapId}`, { method: "DELETE" },
            scope);
        const isLatestChoice = swapMutationRequestVersionsRef.current.get(scopeKey) === requestSequence;
        if (detail && isLatestChoice) {
          if (pendingLiveSwapRef.current.get(scopeKey)?.selectedAt === pending?.selectedAt) {
            pendingLiveSwapRef.current.delete(scopeKey);
          }
          setPendingSwaps((previous) => previous.filter((pending) =>
            pending.swapId !== swapId && pending.swapId !== persistedSwapId,
          ));
          const restored = !previousSwap || detail.swaps.some((swap) =>
            swap.sessionTrackId === previousSwap.sessionTrackId && swap.stemType === previousSwap.stemType &&
            swap.toTrackId === previousSwap.toTrackId && swap.toStemAssetId === previousSwap.toStemAssetId,
          );
          setStatus(restored ? successMessage : "The failed switch was superseded; the newer source selection was kept.");
        } else if (!detail && isLatestChoice && previousSwap) {
          setStatus("The previous audio is still playing, but its saved source could not be restored. Retry saving the previous source before leaving.");
        }
      } finally {
        if (swapMutationRequestVersionsRef.current.get(scopeKey) === requestSequence) {
          setSwapSaving(targetSwap.sessionTrackId, targetSwap.stemType, false);
        }
      }
    },
    [session, mutate, pendingSwaps, setSwapSaving],
  );

  const liveLayerFailureRef = useRef<(sessionTrackId: string, stemType: string, message: string, selectedAt: number | null) => void>(() => {});
  liveLayerFailureRef.current = (sessionTrackId, stemType, message, selectedAt) => {
    const scopeKey = session
      ? swapMutationKey({ sessionId: session.id, sessionTrackId, stemType })
      : null;
    const currentPending = scopeKey ? pendingLiveSwapRef.current.get(scopeKey) : undefined;
    const pending = currentPending?.selectedAt === selectedAt
      ? currentPending
      : pendingSwaps.find((swap) =>
        swap.sessionTrackId === sessionTrackId && swap.stemType === stemType && swap.selectedAt === selectedAt,
      );
    if (pending) {
      setFailedLiveSwaps((previous) => [
        ...previous.filter((failed) => failed.sessionTrackId !== sessionTrackId || failed.stemType !== stemType),
        { sessionTrackId, stemType, selectedAt: pending.selectedAt, message, donor: pending.retryDonor },
      ]);
      void revertSwap(pending.swapId, message, true);
    }
  };
  const markLiveLayerFailed = useCallback((sessionTrackId: string, stemType: string, message: string, selectedAt: number | null) => {
    liveLayerFailureRef.current(sessionTrackId, stemType, message, selectedAt);
  }, []);

  const markLiveLayerReady = useCallback((sessionTrackId: string, stemType: string, selectedAt: number | null) => {
    const activeSessionId = sessionRef.current?.id;
    if (activeSessionId) {
      const key = swapMutationKey({ sessionId: activeSessionId, sessionTrackId, stemType });
      if (pendingLiveSwapRef.current.get(key)?.selectedAt === selectedAt) {
        pendingLiveSwapRef.current.delete(key);
      }
    }
    setPendingSwaps((previous) => previous.filter(
      (pending) => pending.sessionTrackId !== sessionTrackId || pending.stemType !== stemType || pending.selectedAt !== selectedAt,
    ));
    setFailedLiveSwaps((previous) => previous.filter(
      (failed) => failed.sessionTrackId !== sessionTrackId || failed.stemType !== stemType ||
        failed.selectedAt !== selectedAt,
    ));
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
    if (sessionRef.current?.id !== sessionId) return;
    const requestId = ++sessionRequestVersion.current;
    try {
      const response = await fetch(`/api/library/sessions/${sessionId}`, { cache: "no-store" });
      if (!response.ok) return;
      const fresh = (await response.json()).session as SessionDetail;
      if (requestId !== sessionRequestVersion.current || fresh.id !== sessionId) return;
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
      const requestId = pending ? ++sessionRequestVersion.current : null;
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
        if (cancelled || requestId !== sessionRequestVersion.current || prev === null || prev.id !== id) return;
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
        const before = JSON.stringify(prev.tracks.map((t) => [
          t.id,
          t.sourceAssetId,
          t.playback?.kind,
          t.playbackPreference,
          t.stems.map((stem) => stem.id),
          t.analysis?.bpm ?? null,
        ]));
        const after = JSON.stringify(merged.map((t) => [
          t.id,
          t.sourceAssetId,
          t.playback?.kind,
          t.playbackPreference,
          t.stems.map((stem) => stem.id),
          t.analysis?.bpm ?? null,
        ]));
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

  const attachOriginalAudio = useCallback(async (itemId: string, file: File) => {
    const activeSession = sessionRef.current;
    if (activeSession === null || restoringOriginalTrackId !== null) return;
    const item = activeSession.tracks.find((track) => track.id === itemId);
    if (item === undefined || item.sourceAssetId !== null || item.stems.length === 0) return;
    const form = new FormData();
    form.append("file", file);
    setRestoringOriginalTrackId(itemId);
    setStatus(`Attaching an original for “${item.track.title}”…`);
    try {
      const response = await fetch(`/api/library/sessions/${activeSession.id}/tracks/${itemId}/source`, {
        method: "POST",
        body: form,
      });
      const body = await response.json().catch(() => null) as {
        error?: unknown;
        session?: SessionDetail;
      } | null;
      if (!response.ok) {
        throw new Error(typeof body?.error === "string" ? body.error : "The original audio could not be attached.");
      }
      const restored = body?.session?.tracks.find((track) => track.id === itemId);
      if (restored?.sourceAssetId == null) throw new Error("The replacement was uploaded, but the session could not confirm it.");
      const latest = sessionRef.current;
      if (latest?.id === activeSession.id) {
        const next = {
          ...latest,
          tracks: latest.tracks.map((track) => track.id === itemId
            ? { ...track, sourceAssetId: restored.sourceAssetId }
            : track),
        };
        sessionRef.current = next;
        setSession(next);
      }
      setStatus(`Original audio attached for “${item.track.title}”. The stem mix and session position are unchanged; use Return to full track when ready.`);
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "The original audio could not be attached.");
    } finally {
      setRestoringOriginalTrackId(null);
    }
  }, [restoringOriginalTrackId]);

  const compatibility = useMemo(() => {
    if (currentItem === null || nextItem === null) return null;
    const tempo = tempoCompatibility(currentItem.analysis?.bpm ?? null, nextItem.analysis?.bpm ?? null);
    const key = keyCompatibilityEvidence(
      currentItem.analysis?.musicalKey ?? null,
      currentItem.analysis?.keyConfidence,
      nextItem.analysis?.musicalKey ?? null,
      nextItem.analysis?.keyConfidence,
    );
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
    const pending = pendingAutomaticTransitionRef.current;
    if (pending === null
      || (pending.trackId === currentItem?.id && pending.nextTrackId === nextItem?.id)) return;
    const standby = decksRef.current[pending.toDeck];
    standby?.transport.pause();
    standby?.transport.setMasterVolume(masterRef.current);
    pendingAutomaticTransitionRef.current = null;
  }, [currentItem?.id, nextItem?.id]);

  useEffect(() => {
    if (!autoCrossfadeEnabled || phase === "fading" || !playingByDeck[activeDeck] || currentItem === null) return;
    const pending = pendingAutomaticTransitionRef.current;
    if (pending !== null
      && (pending.trackId !== currentItem.id || pending.nextTrackId !== nextItem?.id)) {
      const standby = decksRef.current[pending.toDeck];
      standby?.transport.pause();
      standby?.transport.setMasterVolume(masterRef.current);
      pendingAutomaticTransitionRef.current = null;
    }
    if (nextItem === null) return;
    const fromApi = decksRef.current[activeDeck];
    const toDeck: 0 | 1 = activeDeck === 0 ? 1 : 0;
    const toApi = decksRef.current[toDeck];
    if (fromApi === null || toApi === null || toApi.itemId !== nextItem.id) return;

    const cfg = transitions[currentItem.id] ?? currentItem.transition;
    if (cfg.crossfadeSeconds <= 0) return;
    const currentPosition = fromApi.transport.currentPosition();
    const duration = currentItem.track.durationSeconds;
    const cue = automaticTransitionCue(cfg, duration, currentItem.analysis?.beatGridMs ?? null, nextItem.analysis?.beatGridMs ?? null);
    const triggerMs = cue.startInCurrentMs ?? Math.max(0, duration - cfg.crossfadeSeconds) * 1000;
    const attempted = autoCrossfadeStartedForRef.current;
    if (attempted !== null && (attempted.trackId !== currentItem.id || attempted.nextTrackId !== nextItem.id)) {
      autoCrossfadeStartedForRef.current = null;
    }
    const currentAttempt = autoCrossfadeStartedForRef.current;
    if (currentAttempt?.trackId === currentItem.id && currentAttempt.nextTrackId === nextItem.id) {
      // Rearm only after a genuine rewind, not while the clock is still
      // approaching the fallback after a skipped cue. Changing settings must
      // not move this threshold and make forward playback look like a rewind.
      if (currentPosition * 1000 >= currentAttempt.cueMs - 1000) return;
      autoCrossfadeStartedForRef.current = null;
    }
    const timing = automaticCueTiming(currentPosition * 1000, triggerMs);
    if (timing === "wait") return;
    const requestId = ++automaticTransitionRequestIdRef.current;
    autoCrossfadeStartedForRef.current = { trackId: currentItem.id, nextTrackId: nextItem.id, cueMs: triggerMs, requestId };
    if (!cue.ok || cue.startInCurrentMs === null || cue.incomingOffsetMs === null) {
      setStatus(`${cue.reason} Automatic fade skipped; the next track will start at the end.`);
      return;
    }
    if (cfg.mode !== "manual" && timing === "missed") {
      setStatus("The verified automatic fade cue was missed; the next track will start at the end.");
      return;
    }
    void beginTransition({
      startInCurrentMs: cue.startInCurrentMs,
      incomingOffsetMs: cue.incomingOffsetMs,
      nextTrackId: nextItem.id,
      requestId,
    });
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
    if (item !== undefined) {
      const performance = (transitionsRef.current[itemId] ?? item.transition).performance;
      if (performance?.isolatedStem != null || performance?.beforeIsolation != null) {
        setPerformanceForItem(item, { isolatedStem: null, beforeIsolation: null });
      }
    }
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
    publishWaveyardLibraryTrackChange([trackId]);
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
        publishWaveyardLibraryTrackChange([trackId]);
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
        publishWaveyardLibraryTrackChange([trackId]);
      }
      setStatus(`${track.title}: ${typeof body.error === "string" ? body.error : "Separation could not be started."}`);
    } catch {
      setStatus(`${track.title}: separation could not be started. Check the connection and try again.`);
      void fetch("/api/library/tracks", { cache: "no-store" }).then(async (refresh) => {
        if (!refresh.ok) return;
        const latest = await refresh.json() as { tracks?: LibraryTrackOption[] };
        if (Array.isArray(latest.tracks)) setLibrary(latest.tracks);
      }).catch(() => undefined);
      publishWaveyardLibraryTrackChange([trackId]);
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
    const selectedDonorAnalysis = swap === undefined ? null
      : session.tracks.find((item) => item.track.id === swap.toTrackId)?.analysis
        ?? swap.donorTrack?.analysis
        ?? library.find((item) => item.id === swap.toTrackId)?.analysis
        ?? null;
    const selectedDonorBpm = selectedDonorAnalysis?.bpm ?? null;
    const tempoEvidence = {
      recipientBpmConfidence: currentItem.analysis?.bpmConfidence,
      donorBpmConfidence: selectedDonorAnalysis?.bpmConfidence,
      recipientBeatConfidence: currentItem.analysis?.beatConfidence,
      donorBeatConfidence: selectedDonorAnalysis?.beatConfidence,
    };
    const reliableTempoEvidence = hasReliableLiveStemTempoEvidence(tempoEvidence);
    const reliableBeatEvidence = hasReliableLiveStemBeatEvidence(tempoEvidence);
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
        bpmConfidence: donor.analysis?.bpmConfidence ?? null,
        beatConfidence: donor.analysis?.beatConfidence ?? null,
        musicalKey: donor.analysis?.musicalKey ?? null,
        keyConfidence: donor.analysis?.keyConfidence ?? null,
        collection: "session" as const,
      })),
      ...libraryDonors.map((donor) => ({
        id: donor.id,
        title: donor.title,
        artist: donor.artist,
        bpm: donor.analysis?.bpm ?? null,
        bpmConfidence: donor.analysis?.bpmConfidence ?? null,
        beatConfidence: donor.analysis?.beatConfidence ?? null,
        musicalKey: donor.analysis?.musicalKey ?? null,
        keyConfidence: donor.analysis?.keyConfidence ?? null,
        collection: "library" as const,
      })),
    ];
    const selectedDonor = session.tracks.find((item) => item.track.id === swap?.toTrackId);
    const selectedDonorTitle = selectedDonor?.track.title
      ?? library.find((item) => item.id === swap?.toTrackId)?.title
      ?? swap?.donorTrack?.title
      ?? null;
    const recipientBpm = currentItem.analysis?.bpm ?? null;
    const lowTempoConfidence = recipientBpm !== null && selectedDonorBpm !== null && !reliableTempoEvidence;
    const lowBeatConfidence = recipientBpm !== null && selectedDonorBpm !== null
      && reliableTempoEvidence && !reliableBeatEvidence;
    const halfDoubleTempo = reliableTempoEvidence && isHalfDoubleTempoPair(recipientBpm, selectedDonorBpm);
    const unsafeTempoGap = reliableTempoEvidence && recipientBpm !== null && selectedDonorBpm !== null
      && !halfDoubleTempo && liveStemTempoStretchRatio(recipientBpm, selectedDonorBpm) === null;
    const tempoStatus = swap === undefined ? null
      : pendingSwap
        ? "Preparing live layer…"
        : lowTempoConfidence
          ? "Low tempo confidence · native pace; no beat sync"
        : halfDoubleTempo
          ? `Half/double-time · donor pace retained${lowBeatConfidence ? " · no beat sync" : ""}`
          : unsafeTempoGap
            ? `Tempo gap too wide · native ${Math.round(selectedDonorBpm!)} BPM`
        : lowBeatConfidence
          ? "Beat sync unavailable · analysis confidence is low"
        : activeSwapTempoStretchRatios[stemType] !== undefined
          ? currentSwapSetup.beatOffsets[stemType] !== undefined
            ? currentSwapSetup.sectionPositionMatches[stemType]
              ? "Tempo matched · pitch preserved · section position matched"
              : "Tempo matched · pitch preserved · beat phase aligned"
            : "Tempo matched · pitch preserved · beat alignment unavailable"
          : selectedDonorBpm !== null
            ? `Native tempo · ${Math.round(selectedDonorBpm)} BPM`
            : "Tempo unavailable · native tempo";
    const keyMatchStatus = currentSwapSetup.keyMatchStatuses[stemType];
    const swapStatus = tempoStatus === null ? null
      : keyMatchStatus ? `${tempoStatus} · ${keyMatchStatus}` : tempoStatus;
    return (
      <LiveStemSwapPicker
        stemType={stemType}
        currentBpm={currentItem.analysis?.bpm ?? null}
        currentBpmConfidence={currentItem.analysis?.bpmConfidence ?? null}
        currentBeatConfidence={currentItem.analysis?.beatConfidence ?? null}
        currentKey={currentItem.analysis?.musicalKey ?? null}
        currentKeyConfidence={currentItem.analysis?.keyConfidence ?? null}
        candidates={candidates}
        preparationCandidates={preparationCandidates}
        preparingTrackIds={preparingSeparationTrackIds}
        selectedDonorId={swap?.toTrackId ?? null}
        selectedDonorTitle={selectedDonorTitle}
        warmingDonorId={warmingLiveSwap?.sessionTrackId === currentItem.id && warmingLiveSwap.stemType === stemType
          ? warmingLiveSwap.donorId
          : null}
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
              bpmConfidence: donor.analysis?.bpmConfidence ?? null,
              beatConfidence: donor.analysis?.beatConfidence ?? null,
            });
            return;
          }
          const source = libraryDonors.find((item) => item.id === donorId);
          if (source) void warmLiveSwap(stemType, {
            id: source.id,
            bpm: source.analysis?.bpm ?? null,
            bpmConfidence: source.analysis?.bpmConfidence ?? null,
            beatConfidence: source.analysis?.beatConfidence ?? null,
          });
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
              bpmConfidence: donor.analysis?.bpmConfidence ?? null,
              beatConfidence: donor.analysis?.beatConfidence ?? null,
            });
            return;
          }
          const source = libraryDonors.find((item) => item.id === donorId);
          if (source) void requestSwap(stemType, {
            id: source.id,
            title: source.title,
            bpm: source.analysis?.bpm ?? null,
            bpmConfidence: source.analysis?.bpmConfidence ?? null,
            beatConfidence: source.analysis?.beatConfidence ?? null,
          });
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
    const swapSetup = isActive ? currentSwapSetup : nextSwapSetup;
    const liveSwapFailures = failedLiveSwaps.filter((failure) => failure.sessionTrackId === item?.id);
    return {
      deckIndex,
      outputGroup: `session:${session.id}`,
      audioAssetPool,
      item,
      active: isActive,
      startAt: startAtFor(deckIndex),
      swaps: swapSetup.swaps,
      swapSelectionTimes: item !== null && session !== null
        ? Object.fromEntries(item.stems.flatMap((stem) => {
          const pending = pendingLiveSwapRef.current.get(swapMutationKey({
            sessionId: session.id,
            sessionTrackId: item.id,
            stemType: stem.stemType,
          }));
          const savedSwap = session.swaps.find((swap) =>
            swap.sessionTrackId === item.id && swap.stemType === stem.stemType,
          );
          return pending && savedSwap?.toTrackId === pending.retryDonor.id
            ? [[stem.stemType, pending.selectedAt]]
            : [];
        }))
        : {},
      tempoStretchRatios: swapSetup.tempoStretchRatios,
      beatOffsets: swapSetup.beatOffsets,
      keyCorrections: swapSetup.keyCorrections,
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
      onPlaybackRateChange: changePlaybackRate,
      pitchModesAvailable,
      pitchPreserving,
      pitchLockBusy,
      pitchLockMessage: isActive ? pitchLockMessage : null,
      onPitchPreservingChange: changePitchPreserving,
      keyShiftSemitones: item?.id === currentItem?.id
        ? currentKeyShift
        : item?.id === nextItem?.id
          ? nextKeyShift
          : savedKeyShiftFor(item, keyShiftByTrack),
      onKeyShiftFailure: reportKeyShiftFailure,
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
      onAttachOriginalAudio: isActive && item?.playback?.kind === "stems" && item.sourceAssetId === null
        ? (file: File) => void attachOriginalAudio(item.id, file)
        : undefined,
      attachingOriginalAudio: item !== null && restoringOriginalTrackId === item.id,
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
  const compactStemItem = variant === "compact" && currentItem?.playback?.kind === "stems"
    ? currentItem
    : null;
  const compactPerformance = compactStemItem === null
    ? defaultPerformance()
    : transitions[compactStemItem.id]?.performance
      ?? compactStemItem.transition.performance
      ?? defaultPerformance();
  const compactStemLevels: Record<string, number> = compactStemItem === null
    ? {}
    : effectiveMix(compactStemItem, mixes[compactStemItem.id] ?? compactStemItem.stemMix);

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
        <span data-testid="session-peak-protection" title="Combined stereo output has a 0.98 sample-peak ceiling and 5 ms lookahead. Saved stem levels are unchanged.">
          Peak protection on
        </span>
        <button
          type="button"
          className={`wy-save ${saveLabel === "Not saved" ? "bad" : ""}`}
          onClick={() => { setMixSaveError(false); lastSentRef.current = {}; void saveQueueRef.current?.flush(true); void persistState(); }}
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
      {compactStemItem !== null && compactStemItem.stems.length > 0 && (
        <section className="wy-compact-stems" aria-label="Compact stem controls" data-testid="compact-stem-controls">
          {compactStemItem.sourceAssetId === null && (
            <p role="status" data-testid={`compact-full-track-unavailable-${compactStemItem.id}`}>
              Original audio unavailable · stem playback and controls remain available
            </p>
          )}
          <div className="wy-compact-stem-levels" role="group" aria-label="Stem volume controls">
            {compactStemItem.stems.map((stem) => {
              const level = Math.max(0, Math.min(2, compactStemLevels[stem.stemType] ?? 1));
              return (
                <label key={stem.id} className="wy-compact-stem-level">
                  <span>{stem.stemType}</span>
                  <output data-testid={`compact-level-value-${stem.stemType}`}>{level.toFixed(2)}</output>
                  <input
                    type="range"
                    min={0}
                    max={2}
                    step={0.01}
                    value={level}
                    aria-label={`${stem.stemType} volume`}
                    aria-valuetext={`${Math.round(level * 100)} percent`}
                    data-testid={`compact-level-${stem.stemType}`}
                    disabled={phase !== "idle"}
                    onChange={(event) => setLevel(compactStemItem.id)(stem.stemType, Number(event.currentTarget.value))}
                  />
                </label>
              );
            })}
          </div>
          <div className="wy-compact-stem-actions" role="group" aria-label="Quick stem isolation">
            {compactStemItem.stems.map((stem) => (
              <button
                key={stem.id}
                type="button"
                aria-label={`Isolate ${stem.stemType}`}
                aria-pressed={compactPerformance.isolatedStem === stem.stemType}
                data-testid={`compact-isolate-${stem.stemType}`}
                disabled={phase !== "idle"}
                onClick={() => requestPerformance(compactStemItem.id, activeDeck, { kind: "isolate", stem: stem.stemType })}
              >
                {stem.stemType}
              </button>
            ))}
            <button
              type="button"
              aria-label="Restore all stems"
              data-testid="compact-restore-stems"
              disabled={phase !== "idle"}
              onClick={() => requestPerformance(compactStemItem.id, activeDeck, { kind: "restore" })}
            >
              Restore
            </button>
          </div>
        </section>
      )}

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
            {status.startsWith("No selected session entry can be opened in Studio.")
              && (
                <>
                  {" "}
                  <Link href="/waveyard" data-testid="link-studio-handoff-recovery">
                    Open Library to restore or separate audio
                  </Link>
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
                {phase === "fading" && (
                  <small className="sess-transition-note" data-testid="session-fade-change-note" role="status">
                    This fade keeps its starting settings. Changes save with this track.
                  </small>
                )}
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
                <p className={compatibility.evidence.tempo.level === "real"
                  ? compatibility.tempo.compatible ? "sess-compat-ok" : "sess-compat-bad"
                  : compatibility.evidence.tempo.level === "approximate" ? "sess-compat-uncertain" : "sess-compat-bad"}>
                  <b className={`sess-evidence sess-evidence-${compatibility.evidence.tempo.level}`}>Tempo · {compatibility.evidence.tempo.level.toUpperCase()}</b>{" "}
                  {compatibility.evidence.tempo.level === "real" ? compatibility.tempo.reason : compatibility.evidence.tempo.label}
                </p>
                <p className={compatibility.evidence.key.level === "real"
                  ? compatibility.key.compatible ? "sess-compat-ok" : "sess-compat-bad"
                  : "sess-compat-uncertain"}>
                  <b className={`sess-evidence sess-evidence-${compatibility.evidence.key.level}`}>Key · {compatibility.evidence.key.level.toUpperCase()}</b>{" "}
                  {compatibility.evidence.key.level === "real" ? compatibility.key.reason : compatibility.evidence.key.label}
                </p>
                {compatibility.alignment !== null && compatibility.evidence.alignment !== null && (
                  <p className={compatibility.evidence.alignment.level === "real"
                    ? compatibility.alignment.ok ? "sess-compat-ok" : "sess-compat-bad"
                    : compatibility.evidence.alignment.level === "approximate" ? "sess-compat-uncertain" : "sess-compat-bad"}>
                    <b className={`sess-evidence sess-evidence-${compatibility.evidence.alignment.level}`}>Alignment · {compatibility.evidence.alignment.level.toUpperCase()}</b> {compatibility.alignment.reason}
                  </p>
                )}
              </div>
            )}
            {currentItem !== null && (
              <SessionKeyMatchingControls
                mode={keyMode}
                leadKey={leadEffectiveKey}
                complementKey={nextKeyMatch.sourceKey}
                match={nextKeyMatch}
                hasComplement={nextItem !== null}
                supported={liveKeyMatchingAvailable}
                busy={keyMatchBusy}
                error={keyMatchError}
                onChange={(mode) => { void changeKeyMatchingMode(mode); }}
              />
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
