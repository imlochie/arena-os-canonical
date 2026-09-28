"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { normaliseMusicalKey, SUPPORTED_MUSICAL_KEYS } from "@waveyard/types";
import { WaveformCanvas } from "./WaveformCanvas";
import { ArrangementTimeline, type ClipSelection } from "./studio/ArrangementTimeline";
import { ArrangementInspector } from "./studio/ArrangementInspector";
import { ClipInspector } from "./studio/ClipInspector";
import { StemMixer } from "./studio/StemMixer";
import { DrumAnalysisPanel } from "./studio/DrumAnalysisPanel";
import { HarmonyAnalysisPanel } from "./studio/HarmonyAnalysisPanel";
import { VocalAnalysisSummary } from "./studio/VocalAnalysisSummary";
import { SourceSectionMap } from "./studio/SourceSectionMap";
import { StudioTransport } from "./studio/StudioTransport";
import {
  remixState,
  sourceStemLabel,
  type Remix,
  type RemixVersionSummary,
  type Source,
  type SourceSection,
  type Stem,
} from "./studio/types";
import { useArrangementHistory } from "./studio/useArrangementHistory";
import { VersionHistory } from "./studio/VersionHistory";
import type { MixerValues } from "@/lib/useStemTransport";
import { useStemTransport } from "@/lib/useStemTransport";
import { useArrangementPreview } from "@/lib/useArrangementPreview";
import { snapTimelineMs, type GridDivision } from "@/lib/timing";

function controlsFor(stems: Stem[]) {
  return Object.fromEntries(stems.map((stem) => [stem.id, { volume: 1, pan: 0, muted: false, solo: false }])) as Record<string, MixerValues>;
}

function canHandleShortcut(target: EventTarget | null) {
  return !(target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement || target instanceof HTMLSelectElement || (target instanceof HTMLElement && target.isContentEditable));
}

export function StudioCore({ projectId, stems, sources, onDerivedAnalysisRequested }: { projectId: string; stems: Stem[]; sources: Source[]; onDerivedAnalysisRequested?: () => void }) {
  const ids = useMemo(() => stems.map((stem) => stem.id), [stems]);
  const duration = useMemo(() => Math.max(0, ...stems.map((stem) => stem.durationSeconds)), [stems]);
  const sourceDurationById = useMemo(() => new Map(stems.map((stem) => [stem.id, Math.round(stem.durationSeconds * 1000)])), [stems]);
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
  const [zoom, setZoom] = useState(80);
  const [remix, setRemix] = useState<Remix | null>(null);
  const [saveState, setSaveState] = useState<"saved" | "saving" | "unsaved" | "failed">("saved");
  const [versions, setVersions] = useState<RemixVersionSummary[]>([]);
  const arrangementHistory = useArrangementHistory();
  const { history, future, reset, record, undo: historyUndo, redo: historyRedo } = arrangementHistory;
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const transport = useStemTransport(ids, duration);
  const { setLoop, seek: seekTransport } = transport;
  const seekArrangementPosition = useCallback((milliseconds: number) => seekTransport(milliseconds / 1000), [seekTransport]);
  const arrangementPreview = useArrangementPreview(seekArrangementPosition);
  const sourceById = useMemo(
    () => new Map(sources.map((source) => [source.id, source])),
    [sources],
  );
  const sourceAssetIdByStemId = useMemo(() => new Map(stems.map((stem) => [stem.id, stem.sourceAssetId])), [stems]);
  const sourceBpmByStemId = useMemo(() => new Map(stems.map((stem) => {
    const analysis = sourceById.get(stem.sourceAssetId)?.analysis;
    const bpm = analysis?.bpm;
    return [stem.id, analysis?.status === "complete" && Number.isFinite(bpm) && bpm! >= 40 && bpm! <= 300 ? bpm! : null] as const;
  })), [sourceById, stems]);
  const sourceKeyByStemId = useMemo(() => new Map(stems.map((stem) => {
    const analysis = sourceById.get(stem.sourceAssetId)?.analysis;
    const key = analysis?.status === "complete" ? normaliseMusicalKey(analysis.musicalKey) : null;
    return [stem.id, key] as const;
  })), [sourceById, stems]);
  const sourceBeatByStemId = useMemo(() => new Map(stems.map((stem) => {
    const analysis = sourceById.get(stem.sourceAssetId)?.analysis;
    return [stem.id, {
      status: analysis?.status ?? "unavailable",
      beatGrid: analysis?.status === "complete" && Array.isArray(analysis.beatGrid) ? analysis.beatGrid : null,
      beatConfidence: analysis?.beatConfidence ?? null,
    }] as const;
  })), [sourceById, stems]);
  const sourceAlignmentByStemId = useMemo(() => new Map(stems.map((stem) => {
    const source = sourceById.get(stem.sourceAssetId);
    const analysis = source?.analysis;
    return [stem.id, {
      sourceAssetId: stem.sourceAssetId,
      sourceName: source?.originalFilename ?? "Unknown source",
      analysisStatus: analysis?.status ?? "unavailable",
      bpm: analysis?.status === "complete" ? analysis.bpm : null,
      musicalKey: analysis?.status === "complete" ? normaliseMusicalKey(analysis.musicalKey) : null,
      beatGrid: analysis?.status === "complete" && Array.isArray(analysis.beatGrid) ? analysis.beatGrid : null,
      beatConfidence: analysis?.beatConfidence ?? null,
      sectionAnalysisStatus: source?.sectionAnalysis?.status ?? null,
    }] as const;
  })), [sourceById, stems]);
  const selected = stems.find((stem) => stem.id === selectedId) ?? stems[0];
  const source = selected ? sourceById.get(selected.sourceAssetId) : undefined;
  const selectedSourceBpm = selected ? sourceBpmByStemId.get(selected.id) : null;
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

  useEffect(() => { transport.applyMix(mixerControls); }, [mixerControls, transport]);
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
  useEffect(() => () => { if (saveTimer.current) clearTimeout(saveTimer.current); }, []);

  const persist = useCallback(async (next: Remix) => {
    setSaveState("saving");
    const response = await fetch(`/api/remixes/${next.id}`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(remixState(next)) });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) { setSaveState("failed"); return; }
    setRemix({ ...body.remix, tracks: body.tracks });
    setSaveState("saved");
  }, []);
  const queuePersist = useCallback((next: Remix) => {
    setSaveState("unsaved");
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => void persist(next), 700);
  }, [persist]);

  const loadRemix = useCallback(async (id: string) => {
    const response = await fetch(`/api/remixes/${id}`, { cache: "no-store" });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) { setSaveState("failed"); return; }
    const next: Remix = { ...body.remix, tracks: body.tracks };
    setRemix(next);
    setClipSelection(null);
    setSelectedClipIds([]);
    reset();
    setControls(Object.fromEntries(next.tracks.map((track) => [track.stemAssetId, { volume: track.volume, pan: track.pan, muted: track.muted, solo: track.solo }])));
    setSaveState("saved");
    const versionResponse = await fetch(`/api/remixes/${id}/versions`, { cache: "no-store" });
    const versionBody = await versionResponse.json().catch(() => ({}));
    if (versionResponse.ok) setVersions(versionBody.versions ?? []);
  }, [reset]);

  useEffect(() => {
    let active = true;
    void fetch(`/api/projects/${projectId}/remixes`, { cache: "no-store" }).then(async (response) => {
      const body = await response.json().catch(() => ({}));
      if (active && response.ok && body.remixes?.[0]?.id) await loadRemix(body.remixes[0].id);
    }).catch(() => undefined);
    return () => { active = false; };
  }, [loadRemix, projectId]);

  const changeRemix = useCallback((transform: (current: Remix) => Remix) => {
    if (!remix) return;
    const next = transform(remix);
    record(remix);
    setRemix(next);
    queuePersist(next);
  }, [queuePersist, record, remix]);
  const previewTimeline = useCallback((next: Remix) => { setRemix(next); setSaveState("unsaved"); }, []);
  const commitTimeline = useCallback((before: Remix, after: Remix) => {
    record(before);
    setRemix(after);
    queuePersist(after);
  }, [queuePersist, record]);

  const updateControl = (id: string, patch: Partial<MixerValues>) => {
    setControls((current) => ({
      ...current,
      [id]: { ...(current[id] ?? { volume: 1, pan: 0, muted: false, solo: false }), ...patch },
    }));
    // This remains the source-stem inspection mixer. Arrangement tracks have independent controls in the timeline.
    changeRemix((current) => ({ ...current, tracks: current.tracks.map((track) => track.stemAssetId === id ? { ...track, ...patch } : track) }));
  };
  const requestSourceEvents = useCallback(async (sourceId: string) => {
    const response = await fetch(`/api/sources/${sourceId}/events`, { method: "POST" });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) return body.error ?? "Could not queue source event analysis.";
    return null;
  }, []);
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
    const versionId = versions.at(-1)?.id;
    if (!versionId) return "Save an immutable remix version before requesting MIDI export.";
    const response = await fetch(`/api/remix-versions/${versionId}/exports`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ format: "midi", midiKind: kind, sourceAssetId, stemAssetId }),
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) return body.error ?? "Could not queue MIDI export.";
    return null;
  }, [versions]);
  const createRemix = async () => {
    const response = await fetch(`/api/projects/${projectId}/remixes`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: "First arrangement" }) });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) { setSaveState("failed"); return; }
    await loadRemix(body.remix.id);
  };
  const duplicateTrack = async (sourceTrackId: string) => {
    if (!remix) return;
    const response = await fetch(`/api/remixes/${remix.id}/tracks`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ sourceTrackId }) });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) { setSaveState("failed"); return; }
    const next = { ...body.remix, tracks: body.tracks } as Remix;
    // Track creation is an explicit server-side operation; reset history so an
    // old PUT cannot accidentally reconcile away the newly duplicated track.
    reset();
    setRemix(next);
    setSaveState("saved");
  };
  const undo = useCallback(() => { if (!remix) return; const prior = historyUndo(remix); if (!prior) return; setRemix(prior); void persist(prior); }, [historyUndo, persist, remix]);
  const redo = useCallback(() => { if (!remix) return; const next = historyRedo(remix); if (!next) return; setRemix(next); void persist(next); }, [historyRedo, persist, remix]);
  const toggleStemPreview = useCallback(() => {
    arrangementPreview.stop();
    if (transport.playing) transport.pause();
    else void transport.play();
  }, [arrangementPreview, transport]);
  const toggleArrangementPreview = useCallback(() => {
    if (!remix) return;
    if (arrangementPreview.playing) { arrangementPreview.pause(); return; }
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
    setRemix({
      ...remix,
      tracks: remix.tracks.map((track) => track.id === targetTrack.id
        ? { ...track, clips: [...track.clips, ...generated] }
        : track),
    });
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
    const response = await fetch(`/api/remixes/${before.id}/automation`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ operation, ...payload }),
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) {
      setSaveState("failed");
      return body.error ?? "Could not apply the automation point edit.";
    }
    record(before);
    const removed = new Set<string>(body.removedPointIds ?? []);
    const point = body.point as { id?: string; remixTrackId: string; parameter: "volume" | "pan"; timelineMs: number; value: number } | undefined;
    let automation = before.automation.map((lane) => ({
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
    setRemix({ ...before, automation });
    setSaveState("saved");
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
    if (operation === "split" && Array.isArray(body.clips)) {
      const clips = body.clips as Remix["tracks"][number]["clips"];
      setRemix({
        ...remix,
        tracks: remix.tracks.map((track) => ({
          ...track,
          clips: track.clips.flatMap((clip) => clip.id === body.replacedClipId ? clips : [clip]),
        })),
      });
      const track = remix.tracks.find((candidate) => candidate.clips.some((clip) => clip.id === body.replacedClipId));
      if (track) {
        const priorIndex = track.clips.findIndex((clip) => clip.id === body.replacedClipId);
        setClipSelection({ trackId: track.id, clipIndex: priorIndex + 1 });
        setSelectedClipIds(clips[1]?.id ? [clips[1].id] : []);
      }
    } else if (body.clip) {
      const edited = body.clip as Remix["tracks"][number]["clips"][number];
      const isDuplicate = operation === "duplicate";
      setRemix({
        ...remix,
        tracks: remix.tracks.map((track) => ({
          ...track,
          clips: isDuplicate && track.clips.some((clip) => clip.id === clipId)
            ? [...track.clips, edited]
            : track.clips.map((clip) => clip.id === edited.id ? edited : clip),
        })),
      });
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
    setRemix({
      ...remix,
      tracks: remix.tracks.map((track) => ({
        ...track,
        clips: track.clips.map((clip) => clip.id === body.clip.id ? body.clip : clip),
      })),
    });
    setSaveState("saved");
    return null;
  }, [record, remix]);

  useEffect(() => {
    const keyboard = (event: KeyboardEvent) => {
      if (!remix || !canHandleShortcut(event.target)) return;
      const command = event.ctrlKey || event.metaKey;
      if (event.code === "Space") { event.preventDefault(); toggleStemPreview(); return; }
      if (command && event.key.toLowerCase() === "z") { event.preventDefault(); if (event.shiftKey) redo(); else undo(); return; }
      if (command && event.key.toLowerCase() === "y") { event.preventDefault(); redo(); return; }
      if (event.key.toLowerCase() !== "s" || !clipSelection) return;
      const track = remix.tracks.find((candidate) => candidate.id === clipSelection.trackId);
      const clip = track?.clips[clipSelection.clipIndex];
      if (!clip?.id) return;
      event.preventDefault();
      void editClip(clip.id, "split", { timelineMs: snapTimelineMs(transport.position * 1000, timing) });
    };
    window.addEventListener("keydown", keyboard);
    return () => window.removeEventListener("keydown", keyboard);
  }, [clipSelection, editClip, redo, remix, timing, toggleStemPreview, transport, undo]);

  return <section className="studio" aria-label="Waveyard Studio">
    <header className="studio-head"><div><span className="eyebrow">Studio core</span><h2>Real stems, one transport.</h2></div><div className={`save-state ${saveState}`}>{saveState === "saved" ? "Saved" : saveState === "saving" ? "Saving…" : saveState === "unsaved" ? "Unsaved changes" : "Save failed"}</div></header>
    <div className="main-waveform"><div className="waveform-label">{source ? `Source · ${source.originalFilename}` : "Selected stem"}</div><WaveformCanvas assetId={source?.id ?? selected.id} label="project waveform" position={transport.position} duration={duration} onSeek={(seconds) => transport.seek(snapTimelineMs(seconds * 1000, timing) / 1000)} /></div>
    {source && <SourceSectionMap source={source} onUseForSlice={(section) => setSlicePrefill({ sourceAssetId: source.id, startBeatIndex: section.startBeatIndex, endBeatIndex: section.endBeatIndex, token: `${section.id}:${Date.now()}` })} onArrangementAction={arrangeSection} onRequestEvents={() => requestSourceEvents(source.id)} />}
    {source && selected && <VocalAnalysisSummary stem={selected} editable onRequestAnalysis={() => requestVocalAnalysis(selected.id)} onExportMidi={selected.stemType === "vocals" ? () => requestMidiExport("vocal", source.id, selected.id) : undefined} />}
    {source && selected && <DrumAnalysisPanel stem={selected} source={source} onRequestAnalysis={() => requestDrumAnalysis(selected.id)} onExportMidi={selected.stemType === "drums" || selected.stemType === "percussion" ? () => requestMidiExport("drums", source.id, selected.id) : undefined} />}
    {source && <HarmonyAnalysisPanel source={source} onRequestAnalysis={() => requestHarmonyAnalysis(source.id)} onExportMidi={() => requestMidiExport("harmony", source.id)} />}
    <StudioTransport transport={transport} timing={timing} loopStartMs={remix?.loopStartMs ?? 0} loopEndMs={remix?.loopEndMs ?? null} arrangementPlaying={arrangementPreview.playing} arrangementError={arrangementPreview.error} onToggleStemPreview={toggleStemPreview} onToggleArrangement={toggleArrangementPreview} onMasterVolume={(volume) => { transport.setMasterVolume(volume); changeRemix((current) => ({ ...current, masterVolume: volume })); }} onLoopChange={(loopStartMs, loopEndMs) => { transport.setLoop({ enabled: loopEndMs !== null, start: loopStartMs / 1000, end: (loopEndMs ?? 0) / 1000 }); changeRemix((current) => ({ ...current, loopStartMs, loopEndMs })); }} />
    <section className="studio-grid"><StemMixer stems={stems} sources={sources} selectedId={selectedId} duration={duration} controls={mixerControls} transport={transport} onSelect={setSelectedId} onControl={updateControl} />{selected && <ClipInspector stem={selected} source={source} duration={duration} transport={transport} />}</section>
    <section className="remix-panel">
      <div className="panel-title"><div><span className="eyebrow">Non-destructive arrangement</span><h3>Remix timeline</h3></div>{!remix ? <button className="button" onClick={() => void createRemix()}>Create remix session</button> : <div className="remix-actions"><button className="button secondary" onClick={() => void createRemix()}>New remix session</button><button className="button secondary" disabled={!history.length} onClick={undo}>Undo</button><button className="button secondary" disabled={!future.length} onClick={redo}>Redo</button><button className="button secondary" onClick={() => void createVersion()}>Save version</button><button className="button" onClick={() => void persist(remix)}>Save now</button></div>}</div>
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
        <ArrangementTimeline remix={arrangementRemix ?? remix} duration={duration} positionMs={transport.position * 1000} timing={timing} zoom={zoom} selection={clipSelection} selectedClipIds={selectedClipIds} sourceDurationById={sourceDurationById} sourceBeatByStemId={sourceBeatByStemId} sourceBpmByStemId={sourceBpmByStemId} onSelection={setClipSelection} onSelectedClipIds={setSelectedClipIds} onPreview={previewTimeline} onCommit={commitTimeline} onBatchCommit={batchEditClips} onAutomationEdit={editAutomation} onChange={changeRemix} onSeek={(milliseconds) => transport.seek(milliseconds / 1000)} onDuplicateTrack={(trackId) => void duplicateTrack(trackId)} />
        <ArrangementInspector remix={arrangementRemix ?? remix} selection={clipSelection} positionMs={transport.position * 1000} timing={timing} sourceBpmByStemId={sourceBpmByStemId} sourceKeyByStemId={sourceKeyByStemId} sourceBeatByStemId={sourceBeatByStemId} sourceAssetIdByStemId={sourceAssetIdByStemId} sourceAlignmentByStemId={sourceAlignmentByStemId} comparisonSource={selected ? sourceAlignmentByStemId.get(selected.id) : null} slicePrefill={slicePrefill} onAlignBeat={alignClipBeat} onClipEdit={editClip} onAutomationEdit={(operation, payload) => editAutomation(remix, operation, payload)} onChange={changeRemix} onSelection={setClipSelection} onReload={() => void loadRemix(remix.id)} />
        <VersionHistory versions={versions} onRestore={(id) => void restoreVersion(id)} />
      </> : <p className="notice">Create a remix only after genuine separated stems exist. Waveyard will create tracks and clips that point to those existing assets.</p>}
    </section>
  </section>;
}
