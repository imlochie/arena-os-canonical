"use client";

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from "react";
import { artworkEnvironment, compactMusicAnalysisLabel, deriveVisualState, motionPolicy, normaliseMusicalKey, SUPPORTED_MUSICAL_KEYS, trustedAnalysisBeatGrid, trustedAnalysisBpm, trustedAnalysisKey, type AutomaticRemixCompatibilityReport, type AutomaticRemixVariant, type CinematicVisualPreset, type MusicalMeetingPoint } from "@workspace/arena/lib/waveyard/types";
import { WaveformCanvas } from "./WaveformCanvas";
import { LivingPlayer, MiniPlayer } from "./player/LivingPlayer";
import { CinematicVisual } from "./visual/CinematicVisual";
import { AutomaticRemixPrompt } from "./remix/AutomaticRemixPrompt";
import { AutomaticRemixEvidence } from "./remix/AutomaticRemixEvidence";
import { ArrangementTimeline, type ClipSelection } from "./studio/ArrangementTimeline";
import { ArrangementInspector } from "./studio/ArrangementInspector";
import { ClipInspector } from "./studio/ClipInspector";
import { MixerConsole } from "./studio/MixerConsole";
import { CleanupStudio } from "./studio/CleanupStudio";
import { AIStudio } from "./studio/AIStudio";
import { SoundDesignStudio } from "./studio/SoundDesignStudio";
import { MasterStudio } from "./studio/MasterStudio";
import type { InsertChain } from "@workspace/arena/lib/waveyard/mixer/inserts";
import type { RemixClipInput } from "@workspace/arena/lib/waveyard/remix";
import {
  bindChopSequencerClipToTimeline,
  CHOP_SEQUENCER_TRACK_NAME,
  retimeChopSequencerTracks,
} from "@workspace/arena/lib/waveyard/studio/vocal-chops";
import { GeneratedLayers } from "./studio/GeneratedLayers";
import { VocalChops } from "./studio/VocalChops";
import { MashupStudio } from "./studio/MashupStudio";
import { StemPlayerDeck } from "./studio/StemPlayerDeck";
import { VisualizerStudio } from "./studio/VisualizerStudio";
import { CompareAB } from "./studio/CompareAB";
import { ConnectedLibraries } from "./studio/ConnectedLibraries";
import { DrumAnalysisPanel } from "./studio/DrumAnalysisPanel";
import { HarmonyAnalysisPanel } from "./studio/HarmonyAnalysisPanel";
import { VocalAnalysisSummary } from "./studio/VocalAnalysisSummary";
import { SourceSectionMap } from "./studio/SourceSectionMap";
import { MeetingPointsPanel } from "./studio/MeetingPointsPanel";
import { ExtendedArrangementPanel } from "./studio/ExtendedArrangementPanel";
import { SourcePool } from "./studio/SourcePool";
import { MultiSourcePlacementPanel } from "./studio/MultiSourcePlacementPanel";
import { ProjectMusicalWorld } from "./studio/ProjectMusicalWorld";
import { StudioTransport } from "./studio/StudioTransport";
import {
  remixState,
  sourceStemLabel,
  type Remix,
  type RemixVersionSummary,
  type AutomaticRemixGenerationSummary,
  type Source,
  type SourceSection,
  type Stem,
} from "./studio/types";
import { remixFromResponse } from "./studio/remix-response";
import {
  clearStudioRecoveryDraft,
  discardStudioRecoveryDraft,
  readStudioRecoveryDraft,
  studioRecoveryDraftIsStale,
  writeStudioRecoveryDraft,
} from "./studio/recovery-draft";
import { useArrangementHistory } from "./studio/useArrangementHistory";
import { VersionHistory } from "./studio/VersionHistory";
import type { MixerValues } from "@workspace/arena/lib/waveyard/useStemTransport";
import { useStemTransport } from "@workspace/arena/lib/waveyard/useStemTransport";
import { useArrangementPreview } from "@workspace/arena/lib/waveyard/useArrangementPreview";
import { snapTimelineMs, type GridDivision } from "@workspace/arena/lib/waveyard/timing";
import { useReducedMotion } from "@workspace/arena/lib/waveyard/useReducedMotion";

function controlsFor(stems: Stem[]) {
  return Object.fromEntries(stems.map((stem) => [stem.id, { volume: 1, pan: 0, muted: false, solo: false }])) as Record<string, MixerValues>;
}

function canHandleShortcut(target: EventTarget | null) {
  return !(target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement || target instanceof HTMLSelectElement || (target instanceof HTMLElement && target.isContentEditable));
}

function navigateViewTabs(event: ReactKeyboardEvent<HTMLElement>) {
  if (event.altKey || event.ctrlKey || event.metaKey || !["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
  const target = event.target instanceof HTMLElement ? event.target : null;
  if (target?.getAttribute("role") !== "tab") return;
  const list = target.closest(".presentation-nav,.studio-tabs");
  if (!list) return;
  const tabs = [...list.querySelectorAll<HTMLButtonElement>("button[role='tab']:not(:disabled)")];
  const index = tabs.indexOf(target as HTMLButtonElement);
  if (index < 0) return;
  event.preventDefault();
  event.stopPropagation();
  const next = event.key === "Home" ? 0 : event.key === "End" ? tabs.length - 1
    : (index + (event.key === "ArrowRight" ? 1 : -1) + tabs.length) % tabs.length;
  tabs[next]?.focus();
  tabs[next]?.click();
}

type StudioTab = "edit" | "analyze" | "showcase";
const STUDIO_TAB_LABEL = { edit: "Edit", analyze: "Analyze", showcase: "Showcase" } as const;
const STUDIO_TAB_BLURB = {
  edit: "Arrange clips, mix stems, save versions.",
  analyze: "Sections, meeting points, vocals, drums, harmony, AI tools.",
  showcase: "Stem deck, visualizer, A/B — the shareable face.",
} as const;

function StudioDisclosure({ title, children }: { title: string; children: ReactNode }) {
  const [open, setOpen] = useState(false);
  return (
    <details className="studio-disclosure" onToggle={(event) => setOpen(event.currentTarget.open)}>
      <summary>{title}</summary>
      {open && <div className="studio-disclosure-body">{children}</div>}
    </details>
  );
}

export function StudioCore({ editorId, projectId, remixSessionId, stems, sources, initialPresentation, onDerivedAnalysisRequested, onRetryWaveformJob }: { editorId?: string; projectId: string; remixSessionId?: string | null; stems: Stem[]; sources: Source[]; initialPresentation?: "studio"; onDerivedAnalysisRequested?: () => void; onRetryWaveformJob?: (jobId: string) => Promise<{ ok: boolean; message?: string }> }) {
  const ids = useMemo(() => stems.map((stem) => stem.id), [stems]);
  const duration = useMemo(() => Math.max(0, ...stems.map((stem) => stem.durationSeconds)), [stems]);
  const sourceDurationById = useMemo(() => new Map(stems.map((stem) => [stem.id, Math.round(stem.durationSeconds * 1000)])), [stems]);
  const previewAssets = useMemo(
    () => stems.map(({ id, durationSeconds, sampleRate, channels, fileSizeBytes, codec }) => ({
      id, durationSeconds, sampleRate, channels, fileSizeBytes, codec,
    })),
    [stems],
  );
  const [controls, setControls] = useState<Record<string, MixerValues>>(() => controlsFor(stems));
  const [selectedId, setSelectedId] = useState(stems[0]?.id ?? "");
  // Project polling can add a completed source while Studio is open. Derive a
  // complete mixer view so untouched newly validated stems stay audible without
  // synchronously resetting the editor's existing mixer intent.
  const mixerControls = useMemo(
    () => ({ ...controlsFor(stems), ...controls }),
    [controls, stems],
  );
  const [clipSelection, setClipSelection] = useState<ClipSelection>(null);
  // UI-only selection. RemixClip IDs remain the only persisted arrangement primitive.
  const [selectedClipIds, setSelectedClipIds] = useState<string[]>([]);
  const [slicePrefill, setSlicePrefill] = useState<{ sourceAssetId: string; startBeatIndex: number; endBeatIndex: number; token: string } | null>(null);
  const [selectedSourceSectionId, setSelectedSourceSectionId] = useState<string | null>(null);
  const [zoom, setZoom] = useState(80);
  const [remix, setRemix] = useState<Remix | null>(null);
  const [recoveryDraft, setRecoveryDraft] = useState<Remix | null>(null);
  const [recoveryDraftConflicts, setRecoveryDraftConflicts] = useState(false);
  const [localDraftUnavailable, setLocalDraftUnavailable] = useState(false);
  const arrangementDuration = useMemo(() => {
    const latestClipEndMs = Math.max(
      0,
      ...(remix?.tracks.flatMap((track) =>
        track.clips.map((clip) => clip.timelineStartMs + clip.durationMs),
      ) ?? []),
    );
    return Math.max(duration, latestClipEndMs / 1000);
  }, [duration, remix]);
  // Save now can be clicked immediately after an input event, before React has
  // committed its render. Keep the most recently edited arrangement available
  // to that explicit persistence boundary.
  const remixRef = useRef<Remix | null>(null);
  const serverVersionRef = useRef<number | null>(null);
  const [saveState, setSaveState] = useState<"saved" | "saving" | "unsaved" | "failed">("saved");
  const [saveConflict, setSaveConflict] = useState(false);
  const [versions, setVersions] = useState<RemixVersionSummary[]>([]);
  const [creatingRemixSession, setCreatingRemixSession] = useState(false);
  const [buildingAutomaticRemix, setBuildingAutomaticRemix] = useState<AutomaticRemixVariant | null>(null);
  const [automaticRemixMessage, setAutomaticRemixMessage] = useState<string | null>(null);
  const [automaticGeneration, setAutomaticGeneration] = useState<AutomaticRemixGenerationSummary | null>(null);
  const [automaticCompatibilityReport, setAutomaticCompatibilityReport] = useState<AutomaticRemixCompatibilityReport | null>(null);
  const [meetingPoints, setMeetingPoints] = useState<MusicalMeetingPoint[]>([]);
  const [meetingContext, setMeetingContext] = useState<{ stemAssetId: string; sourceSectionId: string } | null>(null);
  const [meetingMessage, setMeetingMessage] = useState<string | null>(null);
  const [acceptingMeetingPoint, setAcceptingMeetingPoint] = useState<string | null>(null);
  // Presentation is browser-only observation over the same project, selection,
  // transport, and persisted remix state. It never forks musical authority.
  const [presentation, setPresentation] = useState<"studio" | "play" | "visual">(initialPresentation ?? "play");
  /** Progressive disclosure inside the Studio presentation (vision Principle
   *  3): Edit / Analyze / Showcase. Panels genuinely unmount per tab; the
   *  audio graph (useStemTransport) and mixer state live in StudioCore, so
   *  switching tabs never stops playback. The Play and Visual presentations
   *  above remain the listener-facing faces. */
  const [studioTab, setStudioTab] = useState<StudioTab>("edit");
  const studioElement = useRef<HTMLElement>(null);
  const previousView = useRef({ presentation, studioTab });
  useLayoutEffect(() => {
    const previous = previousView.current;
    previousView.current = { presentation, studioTab };
    if (previous.presentation === presentation && previous.studioTab === studioTab) return;
    // In-view "Open Studio"/mini-player controls unmount during a switch.
    // Restore focus only if it was lost; persistent tab buttons keep theirs.
    if (document.activeElement !== document.body) return;
    const selector = previous.presentation !== presentation
      ? ".presentation-nav [aria-selected='true']"
      : ".studio-tabs [aria-selected='true']";
    const target = studioElement.current?.querySelector<HTMLButtonElement>(selector);
    target?.focus({ preventScroll: true });
    target?.scrollIntoView({ block: "center" });
  }, [presentation, studioTab]);
  // Visual preferences are browser-only presentation choices; they never
  // mutate the project, RemixVersion, or transport's musical state.
  const [visualPreset, setVisualPreset] = useState<CinematicVisualPreset>("halo");
  const [visualMetadataVisible, setVisualMetadataVisible] = useState(true);
  const [playerFullscreen, setPlayerFullscreen] = useState(false);
  const [visualFullscreen, setVisualFullscreen] = useState(false);
  const reducedMotion = useReducedMotion();
  const arrangementHistory = useArrangementHistory();
  const { history, future, reset, record, undo: historyUndo, redo: historyRedo } = arrangementHistory;
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const saveQueue = useRef<Promise<void>>(Promise.resolve());
  const saveRevision = useRef(0);
  const mountedRef = useRef(false);
  const dirtyRef = useRef(false);
  const transport = useStemTransport(ids, duration);
  const { setLoop, seek: seekTransport } = transport;
  const seekArrangementPosition = useCallback((milliseconds: number) => seekTransport(milliseconds / 1000), [seekTransport]);
  const arrangementPreview = useArrangementPreview(seekArrangementPosition, previewAssets);
  const sourceById = useMemo(
    () => new Map(sources.map((source) => [source.id, source])),
    [sources],
  );
  const sourceAssetIdByStemId = useMemo(() => new Map(stems.map((stem) => [stem.id, stem.sourceAssetId])), [stems]);
  const sourceBpmByStemId = useMemo(() => new Map(stems.map((stem) => {
    const analysis = sourceById.get(stem.sourceAssetId)?.analysis;
    return [stem.id, analysis?.status === "complete" ? trustedAnalysisBpm(analysis.bpm, analysis.bpmConfidence) : null] as const;
  })), [sourceById, stems]);
  const sourceKeyByStemId = useMemo(() => new Map(stems.map((stem) => {
    const analysis = sourceById.get(stem.sourceAssetId)?.analysis;
    const key = analysis?.status === "complete"
      ? normaliseMusicalKey(trustedAnalysisKey(analysis.musicalKey, analysis.keyConfidence))
      : null;
    return [stem.id, key] as const;
  })), [sourceById, stems]);
  const sourceBeatByStemId = useMemo(() => new Map(stems.map((stem) => {
    const analysis = sourceById.get(stem.sourceAssetId)?.analysis;
    const beatGrid = analysis?.status === "complete"
      ? trustedAnalysisBeatGrid(analysis.beatGrid, analysis.bpmConfidence, analysis.beatConfidence)
      : null;
    return [stem.id, {
      status: analysis?.status ?? "unavailable",
      beatGrid,
      beatConfidence: beatGrid ? analysis?.beatConfidence ?? null : null,
    }] as const;
  })), [sourceById, stems]);
  const sourceAlignmentByStemId = useMemo(() => new Map(stems.map((stem) => {
    const source = sourceById.get(stem.sourceAssetId);
    const analysis = source?.analysis;
    const bpm = analysis?.status === "complete" ? trustedAnalysisBpm(analysis.bpm, analysis.bpmConfidence) : null;
    const musicalKey = analysis?.status === "complete"
      ? normaliseMusicalKey(trustedAnalysisKey(analysis.musicalKey, analysis.keyConfidence))
      : null;
    const beatGrid = analysis?.status === "complete"
      ? trustedAnalysisBeatGrid(analysis.beatGrid, analysis.bpmConfidence, analysis.beatConfidence)
      : null;
    return [stem.id, {
      sourceAssetId: stem.sourceAssetId,
      sourceName: source?.originalFilename ?? "Unknown source",
      analysisStatus: analysis?.status ?? "unavailable",
      bpm,
      musicalKey,
      beatGrid,
      beatConfidence: beatGrid ? analysis?.beatConfidence ?? null : null,
      sectionAnalysisStatus: source?.sectionAnalysis?.status ?? null,
    }] as const;
  })), [sourceById, stems]);
  const selected = stems.find((stem) => stem.id === selectedId) ?? stems[0];
  const source = selected ? sourceById.get(selected.sourceAssetId) : undefined;
  const selectedSourceBpm = selected ? sourceBpmByStemId.get(selected.id) : null;
  const extensionAnchorClipId = clipSelection && remix
    ? remix.tracks.find((track) => track.id === clipSelection.trackId)?.clips[clipSelection.clipIndex]?.id ?? null
    : null;
  // Play and Visual observe one position source. When an arrangement exists,
  // they reuse the established arrangement audition to hear the persisted clips;
  // otherwise they retain the original stem transport.
  const observedTransportPlaying = remix ? arrangementPreview.playing : transport.playing;
  const presentationTransport = useMemo(() => ({
    playing: observedTransportPlaying,
    position: transport.position,
    error: remix ? arrangementPreview.error : transport.error,
    play: async () => {
      if (!remix) return transport.play();
      transport.pause();
      return arrangementPreview.play(remix, transport.position * 1000);
    },
    pause: () => {
      if (remix) arrangementPreview.pause();
      else transport.pause();
    },
    seek: (seconds: number) => {
      if (remix && arrangementPreview.playing) arrangementPreview.pause();
      transport.seek(seconds);
    },
  }), [arrangementPreview, observedTransportPlaying, remix, transport]);
  // Track labels are a presentation concern for old sessions too. This makes
  // them source-qualified without writing back to pre-existing records.
  const arrangementRemix = useMemo(() => remix && ({
    ...remix,
    tracks: remix.tracks.map((track) => {
      const trackStem = stems.find((stem) => stem.id === track.stemAssetId);
      return trackStem
        ? { ...track, name: sourceStemLabel(sourceById.get(trackStem.sourceAssetId), trackStem.stemType) }
        : track;
    }),
  }), [remix, sourceById, stems]);
  const timing = useMemo(() => remix ? {
    tempoBpm: remix.tempoBpm,
    timeSignatureNumerator: remix.timeSignatureNumerator,
    timeSignatureDenominator: remix.timeSignatureDenominator,
    gridDivision: remix.gridDivision,
    snapEnabled: remix.snapEnabled,
  } : { tempoBpm: 120, timeSignatureNumerator: 4, timeSignatureDenominator: 4, gridDivision: "beat" as GridDivision, snapEnabled: true }, [remix]);
  const visualState = useMemo(() => deriveVisualState({
    positionMs: Math.round(transport.position * 1000), durationMs: Math.round(duration * 1000), playing: observedTransportPlaying,
    bpm: source?.analysis?.status === "complete" ? source.analysis.bpm : null,
    beatGridMs: source?.analysis?.status === "complete" ? source.analysis.beatGrid : null,
    sections: source?.sections ?? [],
    stems: stems.map((stem) => ({ id: stem.id, ...(mixerControls[stem.id] ?? { volume: 1, muted: false, solo: false }) })),
    reducedMotion,
  }), [duration, mixerControls, observedTransportPlaying, reducedMotion, source, stems, transport.position]);
  const visualMotion = motionPolicy(reducedMotion);
  const environment = artworkEnvironment(`${source?.checksumSha256 ?? projectId}:${source?.originalFilename ?? "waveyard"}`);

  useEffect(() => { transport.applyMix(mixerControls); }, [mixerControls, transport]);
  // Insert chains are canonical remix state; the live graph follows them.
  const chainsByStem = useMemo(() => {
    const record: Record<string, InsertChain> = {};
    for (const track of remix?.tracks ?? []) record[track.stemAssetId] = track.inserts ?? [];
    return record;
  }, [remix]);
  useEffect(() => {
    if (!remix) return;
    transport.applyInserts(chainsByStem, remix.masterInserts ?? []);
  }, [chainsByStem, remix, transport]);
  useEffect(() => { remixRef.current = remix; }, [remix]);
  useEffect(() => { if (remix) transport.setMasterVolume(remix.masterVolume); }, [remix, transport]);
  const loopStartMs = remix?.loopStartMs ?? 0;
  const loopEndMs = remix?.loopEndMs ?? null;
  useEffect(() => {
    setLoop({
      enabled: loopEndMs !== null,
      start: loopStartMs / 1000,
      end: (loopEndMs ?? 0) / 1000,
    });
  }, [loopEndMs, loopStartMs, setLoop]);
  useEffect(() => {
    const escape = (event: KeyboardEvent) => { if (event.key === "Escape") { setPlayerFullscreen(false); setVisualFullscreen(false); } };
    window.addEventListener("keydown", escape);
    return () => window.removeEventListener("keydown", escape);
  }, []);
  useEffect(() => {
    const warnBeforeUnload = (event: BeforeUnloadEvent) => {
      if (!dirtyRef.current) return;
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", warnBeforeUnload);
    return () => window.removeEventListener("beforeunload", warnBeforeUnload);
  }, []);

  const persist = useCallback((next = remixRef.current): Promise<void> => {
    if (!next) return Promise.resolve();
    const revision = saveRevision.current;
    const save = async () => {
      if (remixRef.current?.id !== next.id || revision !== saveRevision.current) return;
      if (mountedRef.current) setSaveState("saving");
      let response: Response;
      try {
        response = await fetch(`/api/remixes/${next.id}`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            ...remixState(next),
            expectedVersion: serverVersionRef.current ?? next.version,
          }),
        });
      } catch {
        if (mountedRef.current && remixRef.current?.id === next.id) {
          setSaveState(revision === saveRevision.current ? "failed" : "unsaved");
        }
        return;
      }
      const body = await response.json().catch(() => ({}));
      if (!response.ok) {
        if (response.status === 409 && body.code === "REMIX_VERSION_CONFLICT") {
          const current = remixRef.current;
          if (current?.id === next.id) {
            setLocalDraftUnavailable(!writeStudioRecoveryDraft(
              projectId,
              current,
              serverVersionRef.current ?? current.version,
            ));
          }
          if (mountedRef.current) setSaveConflict(true);
        }
        if (mountedRef.current && remixRef.current?.id === next.id) {
          setSaveState(revision === saveRevision.current ? "failed" : "unsaved");
        }
        return;
      }
      if (remixRef.current?.id !== next.id) return;
      const persisted = remixFromResponse(body);
      serverVersionRef.current = persisted.version;
      if (revision !== saveRevision.current) {
        const latest = remixRef.current;
        if (latest?.id === next.id) {
          const latestWithVersion = { ...latest, version: persisted.version };
          remixRef.current = latestWithVersion;
          if (mountedRef.current) setRemix(latestWithVersion);
        }
        if (mountedRef.current) setSaveState("unsaved");
        return;
      }
      clearStudioRecoveryDraft(projectId, next);
      dirtyRef.current = false;
      remixRef.current = persisted;
      setSaveConflict(false);
      if (mountedRef.current) {
        setRemix(persisted);
        setRecoveryDraft(null);
        setRecoveryDraftConflicts(false);
        setLocalDraftUnavailable(false);
        setSaveState("saved");
      }
    };
    const queuedSave = saveQueue.current.then(save, save);
    saveQueue.current = queuedSave.then(() => undefined, () => undefined);
    return queuedSave;
  }, [projectId]);
  const queuePersist = useCallback((next: Remix) => {
    dirtyRef.current = true;
    setRecoveryDraft(null);
    setLocalDraftUnavailable(!writeStudioRecoveryDraft(
      projectId,
      next,
      serverVersionRef.current ?? next.version,
    ));
    setSaveState("unsaved");
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => {
      saveTimer.current = null;
      void persist(next);
    }, 700);
  }, [persist, projectId]);
  const saveNow = useCallback(() => {
    // An explicit save supersedes the debounce snapshot, which may otherwise
    // write an older whole-arrangement payload after this request.
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = null;
    void persist();
  }, [persist]);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      if (!saveTimer.current) return;
      clearTimeout(saveTimer.current);
      saveTimer.current = null;
      // An in-app route change should not discard an edit still inside the
      // debounce window. Queue the latest arrangement before unmount completes.
      void persist(remixRef.current);
    };
  }, [persist]);

  const loadRemix = useCallback(async (id: string): Promise<boolean> => {
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = null;
    saveRevision.current += 1;
    try {
      const response = await fetch(`/api/remixes/${id}`, { cache: "no-store" });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) { setSaveState("failed"); return false; }
      const next = remixFromResponse(body);
      remixRef.current = next;
      serverVersionRef.current = next.version;
      setRemix(next);
      dirtyRef.current = false;
      setLocalDraftUnavailable(false);
      const draft = readStudioRecoveryDraft(projectId, next);
      setRecoveryDraft(draft);
      setRecoveryDraftConflicts(Boolean(draft && studioRecoveryDraftIsStale(projectId, next)));
      setAutomaticGeneration(body.generation ?? null);
      setAutomaticCompatibilityReport(body.generation?.compatibility ?? null);
      setClipSelection(null);
      setSelectedClipIds([]);
      reset();
      setControls(Object.fromEntries(next.tracks.map((track) => [track.stemAssetId, { volume: track.volume, pan: track.pan, muted: track.muted, solo: track.solo, phaseInvert: track.phaseInverted === true }])));
      setSaveState("saved");
      try {
        const versionResponse = await fetch(`/api/remixes/${id}/versions`, { cache: "no-store" });
        const versionBody = await versionResponse.json().catch(() => ({}));
        if (versionResponse.ok) setVersions(versionBody.versions ?? []);
      } catch {
        // Version history is optional; the arrangement remains usable.
      }
      return true;
    } catch {
      setSaveState("failed");
      return false;
    }
  }, [projectId, reset]);

  const restoreRecoveryDraft = useCallback(() => {
    if (!recoveryDraft) return;
    const draft = {
      ...recoveryDraft,
      version: remix?.id === recoveryDraft.id ? remix.version : recoveryDraft.version,
    };
    remixRef.current = draft;
    reset();
    setRemix(draft);
    setRecoveryDraft(null);
    setRecoveryDraftConflicts(false);
    setSaveConflict(false);
    queuePersist(draft);
  }, [queuePersist, recoveryDraft, remix, reset]);

  const discardRecoveryDraft = useCallback(() => {
    if (!remix) return;
    discardStudioRecoveryDraft(projectId, remix.id);
    setRecoveryDraft(null);
    setRecoveryDraftConflicts(false);
  }, [projectId, remix]);

  const reloadLatestKeepingDraft = useCallback(async () => {
    const draft = remixRef.current;
    if (!draft) return;
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = null;
    const revision = ++saveRevision.current;
    await saveQueue.current;
    if (revision !== saveRevision.current || remixRef.current?.id !== draft.id) return;
    const draftStored = writeStudioRecoveryDraft(
      projectId,
      draft,
      serverVersionRef.current ?? draft.version,
    );
    setLocalDraftUnavailable(!draftStored);
    try {
      const response = await fetch(`/api/remixes/${draft.id}`, { cache: "no-store" });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) {
        setSaveState("failed");
        return;
      }
      if (revision !== saveRevision.current || remixRef.current?.id !== draft.id) return;
      const latest = remixFromResponse(body);
      setRecoveryDraft(draft);
      setRecoveryDraftConflicts(true);
      remixRef.current = latest;
      serverVersionRef.current = latest.version;
      dirtyRef.current = !draftStored;
      setRemix(latest);
      setSaveConflict(false);
      setSaveState("saved");
    } catch {
      setSaveState("failed");
    }
  }, [projectId]);

  useEffect(() => {
    let active = true;
    void (async () => {
      // A completed automatic build publishes this ordinary RemixSession ID on
      // the project build. Follow that durable handoff when it arrives after
      // Studio has mounted instead of leaving the editor on its initial empty
      // remix-list response.
      let id = remixSessionId;
      if (!id) {
        const response = await fetch(`/api/waveyard/projects/${projectId}/remixes`, {
          cache: "no-store",
        });
        const body = await response.json().catch(() => ({}));
        id = response.ok ? body.remixes?.[0]?.id : undefined;
      }
      if (active && id) await loadRemix(id);
    })().catch(() => undefined);
    return () => { active = false; };
  }, [loadRemix, projectId, remixSessionId]);

  const changeRemix = useCallback((transform: (current: Remix) => Remix): Remix | null => {
    const current = remixRef.current;
    if (!current) return null;
    const transformed = transform(current);
    const next = transformed.tempoBpm === current.tempoBpm
      ? transformed
      : {
          ...transformed,
          tracks: retimeChopSequencerTracks(
            transformed.tracks,
            current.tempoBpm,
            transformed.tempoBpm,
          ),
        };
    remixRef.current = next;
    saveRevision.current += 1;
    record(current);
    setRemix(next);
    queuePersist(next);
    return next;
  }, [queuePersist, record]);
  const previewTimeline = useCallback((next: Remix) => { setRemix(next); setSaveState("unsaved"); }, []);
  const commitTimeline = useCallback((before: Remix, after: Remix) => {
    const previousClipById = new Map(before.tracks.flatMap((track) =>
      track.clips.flatMap((clip) => clip.id ? [[clip.id, clip] as const] : []),
    ));
    const committed = {
      ...after,
      tracks: after.tracks.map((track) => track.name !== CHOP_SEQUENCER_TRACK_NAME
        ? track
        : {
            ...track,
            clips: track.clips.map((clip) => {
              const previous = clip.id ? previousClipById.get(clip.id) : undefined;
              return previous?.timelineStartMs === clip.timelineStartMs
                ? clip
                : bindChopSequencerClipToTimeline(clip, track.name, after.tempoBpm);
            }),
          }),
    };
    remixRef.current = committed;
    saveRevision.current += 1;
    record(before);
    setRemix(committed);
    queuePersist(committed);
  }, [queuePersist, record]);

  const patchClip = (clipId: string, patch: Partial<{ gain: number; fadeInMs: number; fadeOutMs: number }>) => {
    changeRemix((current) => ({
      ...current,
      tracks: current.tracks.map((track) => ({
        ...track,
        clips: track.clips.map((clip) => clip.id === clipId ? { ...clip, ...patch } : clip),
      })),
    }));
  };
  const splitClip = (clipId: string, positionMs: number) => {
    void editClip(clipId, "split", { timelineMs: positionMs });
  };
  const duplicateClip = (clipId: string) => {
    void editClip(clipId, "duplicate", {});
  };
  const deleteClip = (clipId: string) => {
    if (!remix) return;
    void batchEditClips(remix, [clipId], "delete");
  };
  const updateInserts = (id: string, chain: InsertChain) => {
    changeRemix((current) => ({
      ...current,
      tracks: current.tracks.map((track) => track.stemAssetId === id ? { ...track, inserts: chain } : track),
    }));
  };
  const updateMasterInserts = (chain: InsertChain) => {
    changeRemix((current) => ({ ...current, masterInserts: chain }));
  };
  const updateControl = (id: string, patch: Partial<MixerValues>) => {
    setControls((current) => ({
      ...current,
      [id]: { ...(current[id] ?? { volume: 1, pan: 0, muted: false, solo: false }), ...patch },
    }));
    // Persisted track patch: phaseInvert (live control name) maps to the persisted
    // phaseInverted column; monoMonitor is monitor-only and deliberately NOT persisted.
    const { monoMonitor: _monitorOnly, phaseInvert, ...persistable } = patch;
    const trackPatch = { ...persistable, ...(phaseInvert !== undefined ? { phaseInverted: phaseInvert } : {}) };
    // This remains the source-stem inspection mixer. Arrangement tracks have independent controls in the timeline.
    const nextRemix = changeRemix((current) => ({ ...current, tracks: current.tracks.map((track) => track.stemAssetId === id ? { ...track, ...trackPatch } : track) }));
    if (patch.muted !== undefined && nextRemix && (arrangementPreview.playing || arrangementPreview.pending)) {
      void arrangementPreview.play(nextRemix, transport.position * 1000);
    }
  };
  const requestSourceEvents = useCallback(async (sourceId: string) => {
    const response = await fetch(`/api/sources/${sourceId}/events`, { method: "POST" });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) return body.error ?? "Could not queue source event analysis.";
    onDerivedAnalysisRequested?.();
    return null;
  }, [onDerivedAnalysisRequested]);
  const requestDrumAnalysis = useCallback(async (stemId: string) => {
    const response = await fetch(`/api/stems/${stemId}/drum-analysis`, { method: "POST" });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) return body.error ?? "Could not queue drum analysis.";
    onDerivedAnalysisRequested?.();
    return null;
  }, [onDerivedAnalysisRequested]);
  const requestVocalAnalysis = useCallback(async (stemId: string) => {
    const response = await fetch(`/api/stems/${stemId}/vocal-analysis`, { method: "POST" });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) return body.error ?? "Could not queue vocal analysis.";
    onDerivedAnalysisRequested?.();
    return null;
  }, [onDerivedAnalysisRequested]);
  const requestHarmonyAnalysis = useCallback(async (sourceId: string) => {
    const response = await fetch(`/api/sources/${sourceId}/harmony-analysis`, { method: "POST" });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) return body.error ?? "Could not queue harmony analysis.";
    onDerivedAnalysisRequested?.();
    return null;
  }, [onDerivedAnalysisRequested]);
  const requestMidiExport = useCallback(async (
    kind: "vocal" | "drums" | "harmony",
    sourceAssetId: string,
    stemAssetId?: string,
  ) => {
    // Instant path (feature-utilisation: the synchronous MIDI route): the
    // analysis already exists → download the Standard MIDI File right now.
    if (stemAssetId !== undefined) {
      const direct = await fetch(`/api/waveyard/projects/${projectId}/midi/${stemAssetId}?kind=${kind}`);
      if (direct.ok) {
        const blob = await direct.blob();
        const url = URL.createObjectURL(blob);
        const anchor = document.createElement("a");
        anchor.href = url;
        anchor.download = `${kind}-${stemAssetId}.mid`;
        document.body.appendChild(anchor);
        anchor.click();
        anchor.remove();
        URL.revokeObjectURL(url);
        return "MIDI file downloaded.";
      }
    }
    // Queued path: an immutable remix version is exported through the worker.
    const versionId = versions.at(-1)?.id;
    if (!versionId) return "Run the analysis first (or save an immutable remix version), then export MIDI again.";
    const response = await fetch(`/api/remix-versions/${versionId}/exports`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ format: "midi", midiKind: kind, sourceAssetId, stemAssetId }),
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) return body.error ?? "Could not queue MIDI export.";
    return "MIDI export queued — it lands in your exports when the worker finishes.";
  }, [projectId, versions]);
  const createRemix = async () => {
    if (creatingRemixSession || buildingAutomaticRemix !== null) return;
    setCreatingRemixSession(true);
    setAutomaticRemixMessage(null);
    try {
      const response = await fetch(`/api/waveyard/projects/${projectId}/remixes`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "First arrangement" }),
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok || typeof body.remix?.id !== "string") {
        setSaveState("failed");
        setAutomaticRemixMessage(body.error ?? "The blank arrangement could not be started.");
        return;
      }
      if (!await loadRemix(body.remix.id)) {
        setAutomaticRemixMessage("The blank arrangement was created, but Studio could not open it. Refresh the page to try again.");
      }
    } catch {
      setSaveState("failed");
      setAutomaticRemixMessage("The blank arrangement request could not reach the server. Your source audio is unchanged; check your connection and try again.");
    } finally {
      setCreatingRemixSession(false);
    }
  };
  const createAutomaticRemix = async (variant: AutomaticRemixVariant) => {
    if (creatingRemixSession || buildingAutomaticRemix !== null) return;
    setBuildingAutomaticRemix(variant);
    setAutomaticRemixMessage(null);
    setAutomaticCompatibilityReport(null);
    try {
      const response = await fetch(`/api/waveyard/projects/${projectId}/automatic-remixes`, {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ variant }),
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok || typeof body.remix?.id !== "string") {
        setAutomaticCompatibilityReport(body.compatibility ?? null);
        setAutomaticRemixMessage(body.error ?? "Waveyard could not build an automatic arrangement yet.");
        return;
      }
      setAutomaticCompatibilityReport(body.plan?.compatibility ?? null);
      if (!await loadRemix(body.remix.id)) {
        setAutomaticRemixMessage("The arrangement was created, but Studio could not open it. Refresh the page to try again.");
        return;
      }
      const notices = Array.isArray(body.plan?.notices) ? body.plan.notices : [];
      setAutomaticRemixMessage(notices[0] ?? `${variant === "hybrid" ? "Hybrid" : "Original"} starting point is ready to play.`);
    } catch {
      setAutomaticRemixMessage("The automatic arrangement request could not reach the server. Your source audio is unchanged; check your connection and try again.");
    } finally {
      setBuildingAutomaticRemix(null);
    }
  };
  const findMeetingPoints = async (section: SourceSection) => {
    if (!remix || !selected) return "Create or open an arrangement before asking where this material fits.";
    setMeetingMessage(null); setMeetingPoints([]); setMeetingContext({ stemAssetId: selected.id, sourceSectionId: section.id });
    const response = await fetch(`/api/remixes/${remix.id}/meeting-points`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ stemAssetId: selected.id, sourceSectionId: section.id }),
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) { setMeetingMessage(body.error ?? "Could not find verified placement recommendations."); return body.error ?? "Could not find verified placement recommendations."; }
    const points = Array.isArray(body.points) ? body.points as MusicalMeetingPoint[] : [];
    setMeetingPoints(points);
    setMeetingMessage(points.length ? `${points.length} descriptive placement recommendation${points.length === 1 ? "" : "s"} found.` : "No conservative placement is available for this selected region yet.");
    return null;
  };
  const acceptMeetingPoint = async (point: MusicalMeetingPoint) => {
    if (!remix || !meetingContext) return;
    setAcceptingMeetingPoint(point.id); setMeetingMessage(null);
    const response = await fetch(`/api/remixes/${remix.id}/meeting-points`, {
      method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ meetingPointId: point.id, ...meetingContext }),
    });
    const body = await response.json().catch(() => ({}));
    setAcceptingMeetingPoint(null);
    if (!response.ok) { setMeetingMessage(body.error ?? "Could not add this placement."); return; }
    await loadRemix(remix.id);
    setMeetingPoints([]); setMeetingMessage("Added as one ordinary arrangement clip. You can refine it in Studio.");
  };
  const duplicateTrack = async (sourceTrackId: string) => {
    if (!remix) return;
    const response = await fetch(`/api/remixes/${remix.id}/tracks`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ sourceTrackId }) });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) { setSaveState("failed"); return; }
    const next = remixFromResponse(body);
    // Track creation is an explicit server-side operation; reset history so an
    // old PUT cannot accidentally reconcile away the newly duplicated track.
    reset();
    remixRef.current = next;
    serverVersionRef.current = next.version;
    setRemix(next);
    setSaveState("saved");
  };
  const saveChopSequence = useCallback(async (stemAssetId: string, clips: RemixClipInput[]) => {
    let current = remixRef.current;
    if (!current) return "Open a Studio arrangement before adding a chop pattern.";

    let sequenceTrack = current.tracks.find((track) =>
      track.name === CHOP_SEQUENCER_TRACK_NAME && track.stemAssetId === stemAssetId,
    );
    if (!sequenceTrack && clips.length > 0) {
      const sessionId = current.id;
      if (dirtyRef.current) {
        if (saveTimer.current) clearTimeout(saveTimer.current);
        saveTimer.current = null;
        await persist(current);
        if (dirtyRef.current) return "Save the current arrangement before adding a chop track.";
        current = remixRef.current;
        if (!current || current.id !== sessionId) return "The active Studio session changed. Reopen the chop sequencer and try again.";
      }

      const existingTrackIds = new Set(current.tracks.map((track) => track.id));
      const response = await fetch(`/api/remixes/${sessionId}/tracks`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ stemAssetId, name: CHOP_SEQUENCER_TRACK_NAME }),
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) {
        setSaveState("failed");
        return body.error ?? "A chop track could not be added to the arrangement.";
      }
      const serverState = remixFromResponse(body);
      const latest = remixRef.current;
      if (!latest || latest.id !== sessionId) return "The active Studio session changed. Reopen the chop sequencer and try again.";
      const addedTrack = serverState.tracks.find((track) =>
        !existingTrackIds.has(track.id) && track.stemAssetId === stemAssetId,
      );
      if (!addedTrack) return "The new chop track was not returned by the arrangement.";

      current = {
        ...latest,
        version: serverState.version,
        tracks: [...latest.tracks, { ...addedTrack, name: CHOP_SEQUENCER_TRACK_NAME, clips: [] }],
      };
      serverVersionRef.current = serverState.version;
      reset();
      remixRef.current = current;
      setRemix(current);
      sequenceTrack = current.tracks[current.tracks.length - 1];
    }

    if (!sequenceTrack) return null;
    const next: Remix = {
      ...current,
      tracks: current.tracks.map((track) =>
        track.id === sequenceTrack!.id ? { ...track, clips } : track,
      ),
    };
    saveRevision.current += 1;
    record(current);
    remixRef.current = next;
    setRemix(next);
    queuePersist(next);
    if (arrangementPreview.playing || arrangementPreview.pending)
      void arrangementPreview.play(next, transport.position * 1000);
    return null;
  }, [arrangementPreview, persist, queuePersist, record, reset, transport.position]);
  const undo = useCallback(() => {
    if (!remix) return;
    const prior = historyUndo(remix);
    if (!prior) return;
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = null;
    saveRevision.current += 1;
    remixRef.current = prior;
    setSaveState("unsaved");
    setRemix(prior);
    void persist(prior);
  }, [historyUndo, persist, remix]);
  const redo = useCallback(() => {
    if (!remix) return;
    const next = historyRedo(remix);
    if (!next) return;
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = null;
    saveRevision.current += 1;
    remixRef.current = next;
    setSaveState("unsaved");
    setRemix(next);
    void persist(next);
  }, [historyRedo, persist, remix]);
  const toggleStemPreview = useCallback(() => {
    arrangementPreview.stop();
    if (transport.playing) transport.pause();
    else void transport.play();
  }, [arrangementPreview, transport]);
  const toggleArrangementPreview = useCallback(() => {
    if (!remix) return;
    if (arrangementPreview.playing || arrangementPreview.pending) { arrangementPreview.pause(); return; }
    transport.pause();
    void arrangementPreview.play(remix, transport.position * 1000);
  }, [arrangementPreview, remix, transport]);
  const createVersion = async () => {
    if (!remix) return;
    const name = window.prompt("Name this remix version", `Version ${versions.length + 1}`)?.trim();
    if (!name) return;
    const response = await fetch(`/api/remixes/${remix.id}/versions`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name }) });
    const body = await response.json().catch(() => ({}));
    if (response.ok) setVersions((current) => [...current, body.version]); else setSaveState("failed");
  };
  const restoreVersion = async (versionId: string) => {
    if (!remix || !window.confirm("Restore this saved remix version?")) return;
    const response = await fetch(`/api/remixes/${remix.id}/versions/${versionId}/restore`, { method: "POST" });
    if (response.ok) await loadRemix(remix.id); else setSaveState("failed");
  };
  const arrangeSection = useCallback(async (
    section: SourceSection,
    action: "add" | "insert" | "loop",
    repetitions: number,
  ) => {
    if (!remix || !selected) return "Create a remix session before arranging a source section.";
    const selectedTrack = clipSelection
      ? remix.tracks.find((track) => track.id === clipSelection.trackId && track.stemAssetId === selected.id)
      : undefined;
    const targetTrack = selectedTrack ?? remix.tracks.find((track) => track.stemAssetId === selected.id);
    if (!targetTrack) return "This source stem is not available in the current remix.";
    const contextClip = clipSelection
      ? remix.tracks.find((track) => track.id === clipSelection.trackId)?.clips[clipSelection.clipIndex]
      : undefined;
    const response = await fetch(`/api/remixes/${remix.id}/clips/from-section`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        sectionId: section.id,
        stemAssetId: selected.id,
        remixTrackId: targetTrack.id,
        contextClipId: contextClip?.id,
        action,
        timelineStartMs: Math.round(transport.position * 1000),
        repetitions,
      }),
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) return body.error ?? "Could not add the selected section to the arrangement.";
    const generated = (body.clips ?? []) as Remix["tracks"][number]["clips"];
    if (!generated.length) return "The section action created no clips.";
    // This one server mutation is one history entry, even when it generated a
    // loop. Undo/redo continue to use the ordinary canonical arrangement state.
    record(remix);
    const next = {
      ...remix,
      version: typeof body.version === "number" ? body.version : remix.version,
      tracks: remix.tracks.map((track) => track.id === targetTrack.id
        ? { ...track, clips: [...track.clips, ...generated] }
        : track),
    };
    remixRef.current = next;
    if (typeof body.version === "number") serverVersionRef.current = body.version;
    setRemix(next);
    setClipSelection({ trackId: targetTrack.id, clipIndex: targetTrack.clips.length });
    setSaveState("saved");
    return null;
  }, [clipSelection, record, remix, selected, transport.position]);
  const batchEditClips = useCallback(async (
    before: Remix,
    clipIds: string[],
    operation: "move" | "nudge" | "duplicate" | "delete",
    payload: Record<string, unknown> = {},
  ) => {
    const response = await fetch(`/api/remixes/${before.id}/clips/batch-edit`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ clipIds, operation, ...payload }),
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) {
      setRemix(before);
      setSaveState("failed");
      return body.error ?? "Could not apply the group clip edit.";
    }
    // A persisted group operation deliberately records just one snapshot.
    record(before);
    const returned = (body.clips ?? []) as Remix["tracks"][number]["clips"];
    const next = {
      ...before,
      version: typeof body.version === "number" ? body.version : before.version,
      tracks: before.tracks.map((track) => {
        if (operation === "delete")
          return { ...track, clips: track.clips.filter((clip) => !clipIds.includes(clip.id ?? "")) };
        if (operation === "duplicate") {
          const additions = returned.filter((_, index) => {
            const sourceId = clipIds[index];
            return track.clips.some((clip) => clip.id === sourceId);
          });
          return { ...track, clips: [...track.clips, ...additions] };
        }
        return {
          ...track,
          clips: track.clips.map((clip) => returned.find((updated) => updated.id === clip.id) ?? clip),
        };
      }),
    };
    remixRef.current = next;
    if (typeof body.version === "number") serverVersionRef.current = body.version;
    setRemix(next);
    if (operation === "delete") {
      setSelectedClipIds([]);
      setClipSelection(null);
    } else if (operation === "duplicate") {
      setSelectedClipIds(returned.map((clip) => clip.id).filter((clipId): clipId is string => Boolean(clipId)));
    }
    setSaveState("saved");
    return null;
  }, [record]);

  const editAutomation = useCallback(async (
    before: Remix,
    operation: "upsert" | "delete",
    payload: Record<string, unknown>,
  ) => {
    const sessionId = before.id;
    const saveRevisionAtStart = saveRevision.current;
    const response = await fetch(`/api/remixes/${before.id}/automation`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ operation, ...payload }),
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) {
      if (remixRef.current?.id === sessionId) setSaveState("failed");
      return body.error ?? "Could not apply the automation point edit.";
    }
    const current = remixRef.current;
    // The response belongs to the session that started the request. Do not
    // write it into a newly selected session if the user switched while waiting.
    if (!current || current.id !== sessionId) return null;
    if (typeof body.version === "number") serverVersionRef.current = body.version;
    // Other controls can change while the endpoint is pending. Record and
    // reconcile from that latest state so undo removes only this automation
    // edit and retains those intervening changes.
    record(current);
    const removed = new Set<string>(body.removedPointIds ?? []);
    const point = body.point as { id?: string; remixTrackId: string; parameter: "volume" | "pan"; timelineMs: number; value: number } | undefined;
    let automation = current.automation.map((lane) => ({
      ...lane,
      points: lane.points.filter((item) => !item.id || !removed.has(item.id)),
    }));
    if (point) {
      const laneIndex = automation.findIndex((lane) => lane.remixTrackId === point.remixTrackId && lane.parameter === point.parameter);
      const pointValue = { id: point.id, timelineMs: point.timelineMs, value: point.value };
      if (laneIndex >= 0) {
        const lane = automation[laneIndex];
        automation = automation.map((item, index) => index === laneIndex ? {
          ...item,
          points: [...item.points.filter((itemPoint) => itemPoint.id !== point.id && itemPoint.timelineMs !== point.timelineMs), pointValue]
            .sort((left, right) => left.timelineMs - right.timelineMs),
        } : item);
      } else {
        automation = [...automation, { remixTrackId: point.remixTrackId, parameter: point.parameter, points: [pointValue] }];
      }
    }
    const next = {
      ...current,
      version: typeof body.version === "number" ? body.version : current.version,
      automation,
    };
    remixRef.current = next;
    setRemix(next);
    if (saveRevision.current === saveRevisionAtStart && !saveTimer.current) setSaveState("saved");
    return null;
  }, [record]);

  const editClip = useCallback(async (
    clipId: string,
    operation: "move" | "nudge" | "trim-left" | "trim-right" | "slip" | "duplicate" | "split",
    payload: Record<string, unknown>,
  ) => {
    if (!remix) return "Create a remix session before editing clips.";
    const response = await fetch(`/api/remixes/${remix.id}/clips/edit`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ clipId, operation, ...payload }),
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) return body.error ?? "Could not apply the clip edit.";
    // Each successful endpoint call is exactly one persisted clip operation and
    // receives one ordinary arrangement-history snapshot.
    record(remix);
    if (typeof body.version === "number") serverVersionRef.current = body.version;
    if (operation === "split" && Array.isArray(body.clips)) {
      const clips = body.clips as Remix["tracks"][number]["clips"];
      const next = {
        ...remix,
        version: typeof body.version === "number" ? body.version : remix.version,
        tracks: remix.tracks.map((track) => ({
          ...track,
          clips: track.clips.flatMap((clip) => clip.id === body.replacedClipId ? clips : [clip]),
        })),
      };
      remixRef.current = next;
      setRemix(next);
      const track = remix.tracks.find((candidate) => candidate.clips.some((clip) => clip.id === body.replacedClipId));
      if (track) {
        const priorIndex = track.clips.findIndex((clip) => clip.id === body.replacedClipId);
        setClipSelection({ trackId: track.id, clipIndex: priorIndex + 1 });
        setSelectedClipIds(clips[1]?.id ? [clips[1].id] : []);
      }
    } else if (body.clip) {
      const edited = body.clip as Remix["tracks"][number]["clips"][number];
      const isDuplicate = operation === "duplicate";
      const next = {
        ...remix,
        version: typeof body.version === "number" ? body.version : remix.version,
        tracks: remix.tracks.map((track) => ({
          ...track,
          clips: isDuplicate && track.clips.some((clip) => clip.id === clipId)
            ? [...track.clips, edited]
            : track.clips.map((clip) => clip.id === edited.id ? edited : clip),
        })),
      };
      remixRef.current = next;
      setRemix(next);
      if (isDuplicate) {
        const track = remix.tracks.find((candidate) => candidate.clips.some((clip) => clip.id === clipId));
        if (track) setClipSelection({ trackId: track.id, clipIndex: track.clips.length });
        if (edited.id) setSelectedClipIds([edited.id]);
      }
    }
    setSaveState("saved");
    return null;
  }, [record, remix]);

  const alignClipBeat = useCallback(async (
    clipId: string,
    sourceBeatIndex: number,
    timelineTargetMs: number,
  ) => {
    if (!remix) return "Create a remix session before aligning source beats.";
    const response = await fetch(`/api/remixes/${remix.id}/clips/align-beat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ clipId, sourceBeatIndex, timelineTargetMs }),
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) return body.error ?? "Could not align the selected source beat.";
    if (!body.clip) return "The alignment action returned no clip.";
    // This single persisted timeline edit is one ordinary arrangement history
    // entry; source offset and all transform intent remain untouched.
    record(remix);
    const next = {
      ...remix,
      version: typeof body.version === "number" ? body.version : remix.version,
      tracks: remix.tracks.map((track) => ({
        ...track,
        clips: track.clips.map((clip) => clip.id === body.clip.id ? body.clip : clip),
      })),
    };
    remixRef.current = next;
    if (typeof body.version === "number") serverVersionRef.current = body.version;
    setRemix(next);
    setSaveState("saved");
    return null;
  }, [record, remix]);

  useEffect(() => {
    const keyboard = (event: KeyboardEvent) => {
      if (event.defaultPrevented || !remix || !canHandleShortcut(event.target)) return;
      const command = event.ctrlKey || event.metaKey;
      if (event.code === "Space") {
        if (command || event.altKey || event.shiftKey) return;
        if (event.target instanceof HTMLElement && event.target.closest("button,a,[role='button']")) return;
        event.preventDefault(); toggleStemPreview(); return;
      }
      if (command && event.key.toLowerCase() === "z") { event.preventDefault(); if (event.shiftKey) redo(); else undo(); return; }
      if (command && event.key.toLowerCase() === "y") { event.preventDefault(); redo(); return; }
      if (command || event.altKey || event.key.toLowerCase() !== "s" || !clipSelection) return;
      const track = remix.tracks.find((candidate) => candidate.id === clipSelection.trackId);
      const clip = track?.clips[clipSelection.clipIndex];
      if (!clip?.id) return;
      event.preventDefault();
      void editClip(clip.id, "split", { timelineMs: snapTimelineMs(transport.position * 1000, timing) });
    };
    window.addEventListener("keydown", keyboard);
    return () => window.removeEventListener("keydown", keyboard);
  }, [clipSelection, editClip, redo, remix, timing, toggleStemPreview, transport, undo]);

  const remixCreationBusy = creatingRemixSession || buildingAutomaticRemix !== null;
  return <section
    ref={studioElement}
    onKeyDown={navigateViewTabs}
    id={editorId}
    tabIndex={editorId ? -1 : undefined}
    className={`studio waveyard-surface mode-${presentation}`}
    data-presentation={presentation}
    data-playing={observedTransportPlaying ? "true" : "false"}
    data-reduced-motion={reducedMotion ? "true" : "false"}
    aria-label="Waveyard Studio"
    style={{ "--art-hue": environment.hue, "--art-accent-hue": environment.accentHue, "--art-shadow-hue": environment.shadowHue, "--beat-pulse": visualState.beatPulse, "--bar-pulse": visualState.barPulse, "--motion-ms": `${visualMotion.transitionMs}ms` } as CSSProperties}
  >
    {/* Media belongs to the shared transport, not a presentation or focus tab.
        Keeping the same elements mounted preserves clocks and native sources. */}
    <div hidden aria-hidden="true">
      {stems.map((stem) => <audio key={stem.id}
        aria-label={`${sourceStemLabel(sourceById.get(stem.sourceAssetId), stem.stemType)} audio`}
        ref={(element) => transport.register(stem.id, element)}
        src={`/api/assets/${stem.id}`} preload="auto" />)}
    </div>
    <header className="studio-head"><div><span className="eyebrow">{presentation === "studio" ? "Studio" : presentation === "play" ? "Play" : "Visual"} · one musical state</span><h2>{presentation === "studio" ? "Real stems, one transport." : presentation === "play" ? "Music in motion." : "Music, made visible."}</h2></div><div className="presentation-nav" role="tablist" aria-label="Waveyard presentation mode"><button type="button" role="tab" aria-selected={presentation === "play"} data-testid="waveyard-mode-play" className={presentation === "play" ? "active" : ""} onClick={() => { setPresentation("play"); setPlayerFullscreen(false); setVisualFullscreen(false); }}>Play</button><button type="button" role="tab" aria-selected={presentation === "studio"} data-testid="waveyard-mode-studio" className={presentation === "studio" ? "active" : ""} onClick={() => { setPresentation("studio"); setPlayerFullscreen(false); setVisualFullscreen(false); }}>Studio</button><button type="button" role="tab" aria-selected={presentation === "visual"} data-testid="waveyard-mode-visual" className={presentation === "visual" ? "active" : ""} onClick={() => { setPresentation("visual"); setPlayerFullscreen(false); }}>Visual</button></div><div className={`save-state ${saveState}`}>{saveState === "saved" ? "Saved" : saveState === "saving" ? "Saving…" : saveState === "unsaved" ? "Unsaved changes" : "Save failed"}</div></header>
    {saveConflict && (
      <p className="notice" role="alert">
        Another Studio tab saved newer changes first. Your edits are still here and were not saved.
        <button type="button" className="button" onClick={() => void reloadLatestKeepingDraft()}>
          Load latest and keep my draft
        </button>
      </p>
    )}
    {!saveConflict && (saveState !== "saved" || localDraftUnavailable) && (
      <p className="notice" role="status">
        {localDraftUnavailable
          ? "Browser storage is unavailable. Keep Studio open until the save finishes; a closing-page request cannot be guaranteed."
          : "A recovery draft is stored in this browser. Closing can interrupt the server save; return to this project to restore the draft."}
      </p>
    )}
    {recoveryDraft && (
      <div className="notice" role="alert">
        <p><strong>Unsaved local Studio draft.</strong> {recoveryDraftConflicts
          ? "This draft was preserved after another tab saved newer changes. Restoring it will replace the latest arrangement."
          : "This browser has edits that were not confirmed by the server."}</p>
        <button type="button" className="button" onClick={restoreRecoveryDraft}>
          {recoveryDraftConflicts ? "Restore draft and replace latest" : "Restore local draft"}
        </button>
        <button type="button" className="button" onClick={discardRecoveryDraft}>Discard local draft</button>
      </div>
    )}
    {presentation === "play" ? <>
      {!remix && <AutomaticRemixPrompt building={buildingAutomaticRemix} message={automaticRemixMessage} compatibility={automaticCompatibilityReport} onBuild={createAutomaticRemix} />}
      {remix && (automaticRemixMessage || automaticGeneration) && <>
        <p className="automatic-remix-banner" role="status">{automaticRemixMessage ?? `Automatic ${automaticGeneration?.variant ?? "original"} arrangement · verified sections, tempo, and key remain explainable in Studio.`}</p>
        <AutomaticRemixEvidence report={automaticCompatibilityReport ?? automaticGeneration?.compatibility} />
      </>}
      <LivingPlayer
      source={source}
      stems={stems}
      selectedId={selected?.id ?? ""}
      controls={mixerControls}
      duration={duration}
      transport={presentationTransport}
      visualState={visualState}
      onSelectStem={setSelectedId}
      onControl={updateControl}
      onOpenStudio={() => setPresentation("studio")}
      fullscreen={playerFullscreen}
      onToggleFullscreen={() => setPlayerFullscreen((current) => !current)}
      onRetryWaveformJob={onRetryWaveformJob}
    />
    </> : presentation === "visual" ? <CinematicVisual
      source={source}
      stems={stems}
      controls={mixerControls}
      transport={presentationTransport}
      visualState={visualState}
      reducedMotion={reducedMotion}
      preset={visualPreset}
      metadataVisible={visualMetadataVisible}
      fullscreen={visualFullscreen}
      onPreset={setVisualPreset}
      onToggleMetadata={() => setVisualMetadataVisible((current) => !current)}
      onToggleFullscreen={() => setVisualFullscreen((current) => !current)}
      onOpenStudio={() => { setPresentation("studio"); setVisualFullscreen(false); }}
    /> : <>
    <div className="studio-tabs" role="tablist" aria-label="Studio focus">
      {(["edit", "analyze", "showcase"] as const).map((tab) => (
        <button key={tab} type="button" role="tab" aria-selected={studioTab === tab} className={`tab-chip ${studioTab === tab ? "on" : ""}`} onClick={() => setStudioTab(tab)}>{STUDIO_TAB_LABEL[tab]}</button>
      ))}
      <small className="tab-hint">{STUDIO_TAB_BLURB[studioTab]}</small>
    </div>
    <section id="remix-timeline" className="remix-panel">
      <div className="panel-title">
        <div><span className="eyebrow">Non-destructive arrangement</span><h3>Remix timeline</h3></div>
        {!remix ? (
          <div className="remix-actions">
            <button type="button" className="button" disabled={remixCreationBusy} onClick={() => void createAutomaticRemix("original")}>
              {buildingAutomaticRemix ? "Building automatic arrangement…" : "Build automatic arrangement"}
            </button>
            <button type="button" className="button secondary" disabled={remixCreationBusy} onClick={() => void createRemix()}>
              {creatingRemixSession ? "Starting arrangement…" : "Start blank arrangement"}
            </button>
          </div>
        ) : (
          <div className="remix-actions">
            <button type="button" className="button secondary" disabled={remixCreationBusy} onClick={() => void createRemix()}>
              {creatingRemixSession ? "Starting arrangement…" : "New remix session"}
            </button>
            <button className="button secondary" disabled={!history.length} onClick={undo}>Undo</button>
            <button className="button secondary" disabled={!future.length} onClick={redo}>Redo</button>
            <button className="button secondary" onClick={() => void createVersion()}>Save version</button>
            <button className="button" onClick={saveNow}>Save now</button>
          </div>
        )}
      </div>
      {automaticRemixMessage && <p className="automatic-remix-banner" role="status">{automaticRemixMessage}</p>}
      {remix ? <>
        <div className="arrangement-settings" aria-label="Arrangement timing settings">
          <label>BPM <input aria-label="Tempo BPM" type="number" min="20" max="300" value={remix.tempoBpm} onChange={(event) => changeRemix((current) => ({ ...current, tempoBpm: Number(event.target.value) || 120 }))} /></label>
          <button className="button secondary" disabled={!selectedSourceBpm} title={selectedSourceBpm ? `Use ${selectedSourceBpm.toFixed(2)} BPM from the selected source` : "Selected source has no complete BPM analysis"} onClick={() => selectedSourceBpm && changeRemix((current) => ({ ...current, tempoBpm: selectedSourceBpm }))}>Use source BPM</button>
          <label>Target key <select aria-label="Target remix key" value={remix.targetKey ?? ""} onChange={(event) => changeRemix((current) => ({ ...current, targetKey: event.target.value || null }))}><option value="">No target key</option>{SUPPORTED_MUSICAL_KEYS.map((key) => <option key={key} value={key}>{key}</option>)}</select></label>
          <label>Beats/bar <input aria-label="Time signature numerator" type="number" min="1" max="12" value={remix.timeSignatureNumerator} onChange={(event) => changeRemix((current) => ({ ...current, timeSignatureNumerator: Number(event.target.value) || 4 }))} /></label>
          <label>Beat value <select aria-label="Time signature denominator" value={remix.timeSignatureDenominator} onChange={(event) => changeRemix((current) => ({ ...current, timeSignatureDenominator: Number(event.target.value) }))}>{[1, 2, 4, 8, 16].map((value) => <option value={value} key={value}>{value}</option>)}</select></label>
          <label>Grid <select aria-label="Grid division" value={remix.gridDivision} onChange={(event) => changeRemix((current) => ({ ...current, gridDivision: event.target.value as GridDivision }))}>{["bar", "beat", "half-beat", "quarter-note"].map((value) => <option value={value} key={value}>{value}</option>)}</select></label>
          <label><input aria-label="Snap enabled" type="checkbox" checked={remix.snapEnabled} onChange={(event) => changeRemix((current) => ({ ...current, snapEnabled: event.target.checked }))} /> Snap</label>
          <label>Zoom <input aria-label="Timeline zoom" type="range" min="40" max="180" step="10" value={zoom} onChange={(event) => setZoom(Number(event.target.value))} /></label>
        </div>
        <ArrangementTimeline remix={arrangementRemix ?? remix} duration={arrangementDuration} positionMs={transport.position * 1000} timing={timing} zoom={zoom} selection={clipSelection} selectedClipIds={selectedClipIds} sourceDurationById={sourceDurationById} sourceBeatByStemId={sourceBeatByStemId} sourceBpmByStemId={sourceBpmByStemId} onSelection={setClipSelection} onSelectedClipIds={setSelectedClipIds} onPreview={previewTimeline} onCommit={commitTimeline} onBatchCommit={batchEditClips} onAutomationEdit={editAutomation} onChange={changeRemix} onSeek={(milliseconds) => transport.seek(milliseconds / 1000)} onDuplicateTrack={(trackId) => void duplicateTrack(trackId)} />
        <ArrangementInspector remix={arrangementRemix ?? remix} selection={clipSelection} positionMs={transport.position * 1000} timing={timing} sourceBpmByStemId={sourceBpmByStemId} sourceKeyByStemId={sourceKeyByStemId} sourceBeatByStemId={sourceBeatByStemId} sourceAssetIdByStemId={sourceAssetIdByStemId} sourceAlignmentByStemId={sourceAlignmentByStemId} comparisonSource={selected ? sourceAlignmentByStemId.get(selected.id) : null} slicePrefill={slicePrefill} onAlignBeat={alignClipBeat} onClipEdit={editClip} onAutomationEdit={(operation, payload) => editAutomation(remix, operation, payload)} onChange={changeRemix} onSelection={setClipSelection} onReload={() => void loadRemix(remix.id)} />
        <VersionHistory versions={versions} onRestore={(id) => void restoreVersion(id)} />
      </> : <p className="notice">Create a remix only after genuine separated stems exist. Waveyard will create tracks and clips that point to those existing assets.</p>}
    </section>
    <StudioTransport
      transport={transport}
      timing={timing}
      loopStartMs={remix?.loopStartMs ?? 0}
      loopEndMs={remix?.loopEndMs ?? null}
      hasArrangement={remix !== null}
      arrangementPlaying={arrangementPreview.playing}
      arrangementPending={arrangementPreview.pending}
      arrangementError={arrangementPreview.error}
      onToggleStemPreview={toggleStemPreview}
      onToggleArrangement={toggleArrangementPreview}
      onStop={() => {
        arrangementPreview.stop();
        transport.stop();
      }}
      onSeek={(seconds) => {
        transport.seek(seconds);
        if (arrangementPreview.playing || arrangementPreview.pending) arrangementPreview.seek(seconds * 1000);
      }}
      onMasterVolume={(volume) => {
        transport.setMasterVolume(volume);
        changeRemix((current) => ({ ...current, masterVolume: volume }));
      }}
      onLoopChange={(loopStartMs, loopEndMs) => {
        transport.setLoop({
          enabled: loopEndMs !== null,
          start: loopStartMs / 1000,
          end: (loopEndMs ?? 0) / 1000,
        });
        changeRemix((current) => ({ ...current, loopStartMs, loopEndMs }));
      }}
    />
    {/* Stem selection stays available across modes; optional source tools mount only when requested. */}
    <SourcePool sources={sources} stems={stems} selectedStemId={selectedId} onSelectStem={(stemId) => { setSelectedId(stemId); setSelectedSourceSectionId(null); }} />
    {studioTab === "edit" && <>
      <StudioDisclosure title="Bring in another audio source">
        <ConnectedLibraries projectId={projectId} />
      </StudioDisclosure>
      {remix && (
        <StudioDisclosure title="Advanced arrangement tools">
          <ProjectMusicalWorld remix={remix} stems={stems} />
          <ExtendedArrangementPanel
            remixId={remix.id}
            anchorClipId={extensionAnchorClipId}
            onApplied={async () => { await loadRemix(remix.id); }}
          />
          <MultiSourcePlacementPanel
            remixId={remix.id}
            anchorClipId={extensionAnchorClipId}
            stemAssetId={selected?.id ?? ""}
            sourceSectionId={selectedSourceSectionId}
            onApplied={async () => { await loadRemix(remix.id); }}
          />
        </StudioDisclosure>
      )}
      <div className="main-waveform"><div className="waveform-label">{source ? `Source · ${source.originalFilename}` : "Selected stem"}</div><WaveformCanvas assetId={source?.id ?? selected.id} label="project waveform" position={transport.position} duration={duration} onSeek={(seconds) => transport.seek(snapTimelineMs(seconds * 1000, timing) / 1000)} onRetryJob={onRetryWaveformJob} /></div>
      <section className="studio-grid"><MixerConsole stems={stems} sources={sources} selectedId={selectedId} duration={duration} controls={mixerControls} transport={transport} onSelect={setSelectedId} onControl={updateControl} inserts={chainsByStem} onInserts={updateInserts} masterInserts={remix?.masterInserts ?? []} onMasterInserts={updateMasterInserts} />{selected && <ClipInspector stem={selected} source={source} duration={duration} transport={transport} remix={remix} activeClipId={selectedClipIds.length === 1 ? selectedClipIds[0] : null} onClipPatch={patchClip} onSplitClip={splitClip} onDuplicateClip={duplicateClip} onDeleteClip={deleteClip} />}</section>
      <StudioDisclosure title="Sound design">
        <SoundDesignStudio projectId={projectId} />
      </StudioDisclosure>
      {remix && (
        <StudioDisclosure title="Vocal chops & beat pads">
          <VocalChops
            projectId={projectId}
            canEdit
            sequencerTracks={remix.tracks}
            sequencerBpm={remix.tempoBpm}
            onSaveSequence={saveChopSequence}
          />
        </StudioDisclosure>
      )}
      <StudioDisclosure title="Mastering">
        <MasterStudio projectId={projectId} sourceAudioUrl={sources.length > 0 ? `/api/assets/${sources[0].id}` : null} />
      </StudioDisclosure>
      <StudioDisclosure title="Audio cleanup">
        <CleanupStudio projectId={projectId} />
      </StudioDisclosure>
    </>}
    {studioTab === "analyze" && <>
      {source?.linkedFromLibrary && <p className="notice">Linked library audio. Mix and arrange it here; source analysis stays with the original project.</p>}
      {source && !source.linkedFromLibrary && <SourceSectionMap source={source} onUseForSlice={(section) => { setStudioTab("edit"); setSelectedSourceSectionId(section.id); setSlicePrefill({ sourceAssetId: source.id, startBeatIndex: section.startBeatIndex, endBeatIndex: section.endBeatIndex, token: `${section.id}:${Date.now()}` }); }} onArrangementAction={arrangeSection} onFindMeetingPoints={findMeetingPoints} onRequestEvents={() => requestSourceEvents(source.id)} />}
      <MeetingPointsPanel points={meetingPoints} busyId={acceptingMeetingPoint} message={meetingMessage} onAccept={async (point) => { setStudioTab("edit"); await acceptMeetingPoint(point); }} />
      {source && !source.linkedFromLibrary && selected && <VocalAnalysisSummary stem={selected} editable onRequestAnalysis={() => requestVocalAnalysis(selected.id)} onExportMidi={selected.stemType === "vocals" ? () => requestMidiExport("vocal", source.id, selected.id) : undefined} />}
      {source && !source.linkedFromLibrary && selected && <DrumAnalysisPanel stem={selected} source={source} onRequestAnalysis={() => requestDrumAnalysis(selected.id)} onExportMidi={selected.stemType === "drums" || selected.stemType === "percussion" ? () => requestMidiExport("drums", source.id, selected.id) : undefined} />}
      {source && !source.linkedFromLibrary && <HarmonyAnalysisPanel source={source} onRequestAnalysis={() => requestHarmonyAnalysis(source.id)} onExportMidi={() => requestMidiExport("harmony", source.id, selected.id)} />}
      <AIStudio projectId={projectId} />
      <GeneratedLayers projectId={projectId} canEdit />
      <MashupStudio projectId={projectId} sources={sources} canEdit />
    </>}
    {studioTab === "showcase" && <>
      <VisualizerStudio projectId={projectId} stems={stems} sources={sources} transport={transport} onControl={updateControl} />
      <CompareAB projectId={projectId} sources={sources} stems={stems} transport={transport} />
      <StemPlayerDeck projectId={projectId} stems={stems} sources={sources} duration={duration} controls={mixerControls} transport={transport} onControl={updateControl} />
    </>}
    <MiniPlayer source={source} duration={duration} transport={presentationTransport} onOpenPlay={() => setPresentation("play")} />
    </>}
  </section>;
}
