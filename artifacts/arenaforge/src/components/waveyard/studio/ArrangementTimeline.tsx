"use client";

import { useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import { evaluateAutomation, snapSourceWindowToBeats, tempoRatioForBpm, type AutomationParameter, type AutomationPoint } from "@workspace/arena/lib/waveyard/types";
import { moveClip, trimClipLeft, trimClipRight } from "@workspace/arena/lib/waveyard/arrangement";
import { anchoredClipRange, clipRangeSelection, orderedClipIds, toggleClipSelection, trackClipSelection } from "@workspace/arena/lib/waveyard/clip-selection";
import { effectiveMuted, type RemixClipInput } from "@workspace/arena/lib/waveyard/remix";
import { barMs, beatMs, formatMusicalPosition, snapIncrementMs, snapTimelineMs, type MusicalTiming } from "@workspace/arena/lib/waveyard/timing";
import { clock, type Remix } from "./types";
import { AutomationEditor, type AutomationTarget } from "./AutomationEditor";

export type ClipSelection = { trackId: string; clipIndex: number } | null;
type DragMode = "move" | "trim-left" | "trim-right";
type AutomationDragState = {
  point: AutomationPoint;
  remixTrackId: string;
  parameter: AutomationParameter;
  lane: DOMRect;
  moved: boolean;
  timelineMs: number;
  value: number;
};
type DragState = {
  mode: DragMode;
  trackId: string;
  clipIndex: number;
  original: Remix;
  clip: RemixClipInput;
  sourceDurationMs: number;
  tempoRatio: number;
  clipIds: string[];
  lastTimelineDeltaMs: number;
  startX: number;
};
type LanePointerStart = {
  pointerId: number;
  x: number;
  y: number;
  lane: HTMLElement;
};

function replaceClip(remix: Remix, trackId: string, clipIndex: number, clip: RemixClipInput) {
  return {
    ...remix,
    tracks: remix.tracks.map((track) =>
      track.id === trackId
        ? { ...track, clips: track.clips.map((item, index) => index === clipIndex ? clip : item) }
        : track,
    ),
  };
}

export function ArrangementTimeline({
  remix,
  duration,
  positionMs,
  timing,
  zoom,
  selection,
  selectedClipIds,
  sourceDurationById,
  sourceBeatByStemId,
  sourceBpmByStemId,
  onSelection,
  onSelectedClipIds,
  onPreview,
  onCommit,
  onBatchCommit,
  onAutomationEdit,
  onChange,
  onSeek,
  onDuplicateTrack,
}: {
  remix: Remix;
  duration: number;
  positionMs: number;
  timing: MusicalTiming;
  zoom: number;
  selection: ClipSelection;
  selectedClipIds: string[];
  sourceDurationById: Map<string, number>;
  sourceBeatByStemId: Map<string, { status: string; beatGrid: number[] | null; beatConfidence: number | null }>;
  sourceBpmByStemId: Map<string, number | null>;
  onSelection: (selection: ClipSelection) => void;
  onSelectedClipIds: (clipIds: string[]) => void;
  onPreview: (next: Remix) => void;
  onCommit: (before: Remix, after: Remix) => void;
  onBatchCommit: (before: Remix, clipIds: string[], operation: "move" | "nudge" | "duplicate" | "delete", payload?: Record<string, unknown>) => Promise<string | null>;
  onAutomationEdit: (before: Remix, operation: "upsert" | "delete", payload: Record<string, unknown>) => Promise<string | null>;
  onChange: (transform: (current: Remix) => Remix) => void;
  onSeek: (milliseconds: number) => void;
  onDuplicateTrack: (trackId: string) => void;
}) {
  const drag = useRef<DragState | null>(null);
  const draft = useRef<Remix | null>(null);
  const lanePointerStart = useRef<LanePointerStart | null>(null);
  const automationDrag = useRef<AutomationDragState | null>(null);
  const [selectedAutomationPointId, setSelectedAutomationPointId] = useState<string | null>(null);
  const [automationTarget, setAutomationTarget] = useState<AutomationTarget>({ trackId: remix.tracks[0]?.id ?? "", parameter: "volume", timelineMs: null });
  const automationEditorRef = useRef<HTMLDivElement>(null);
  const timelineRef = useRef<HTMLDivElement>(null);
  const focusedClip = useRef<{ element: HTMLElement; trackId: string; index: number } | null>(null);
  const rangeAnchor = useRef<string | null>(null);
  const navigating = useRef(false);
  const batchBusy = useRef(false);
  const [editMessage, setEditMessage] = useState("");
  const keyboardHelpId = useId();
  const keyboardStepMs = timing.snapEnabled ? snapIncrementMs(timing) : 10;

  const focusAt = (trackIndex: number, clipIndex: number | null) => {
    const track = timelineRef.current?.querySelector<HTMLElement>(`[data-timeline-track-index="${trackIndex}"]`);
    const target = clipIndex === null
      ? track?.querySelector<HTMLElement>(".clip-lane")
      : track?.querySelector<HTMLElement>(`.clip[data-clip-index="${clipIndex}"]`);
    navigating.current = true;
    try {
      target?.focus({ preventScroll: true });
    } finally {
      navigating.current = false;
    }
    target?.scrollIntoView({ block: "nearest", inline: "nearest" });
  };
  useLayoutEffect(() => {
    const previous = focusedClip.current;
    // Deleting/splitting the focused clip must not drop keyboard users onto
    // the page body. Do not steal focus from an inspector or toolbar control.
    if (!previous || previous.element.isConnected || document.activeElement !== document.body) return;
    const trackIndex = remix.tracks.findIndex((track) => track.id === previous.trackId);
    const track = remix.tracks[Math.max(0, trackIndex)];
    if (!track) return;
    const index = selection?.trackId === track.id ? selection.clipIndex : previous.index;
    focusAt(Math.max(0, trackIndex), track.clips.length ? Math.min(index, track.clips.length - 1) : null);
  }, [remix, selection]);
  useLayoutEffect(() => {
    // Undo/reload can remove duplicated clips without a batch-delete response.
    // Do not announce or submit IDs that no longer belong to this arrangement.
    const ids = new Set(orderedClipIds(remix.tracks));
    const remaining = selectedClipIds.filter((id) => ids.has(id));
    if (remaining.length !== selectedClipIds.length) onSelectedClipIds(remaining);
    if (rangeAnchor.current && !ids.has(rangeAnchor.current)) rangeAnchor.current = null;
  }, [remix, selectedClipIds, onSelectedClipIds]);

  const selectClip = (trackId: string, index: number, element?: HTMLElement) => {
    const clip = remix.tracks.find((track) => track.id === trackId)?.clips[index];
    if (element) focusedClip.current = { element, trackId, index };
    onSelection({ trackId, clipIndex: index });
    onSelectedClipIds(clip?.id ? [clip.id] : []);
    rangeAnchor.current = clip?.id ?? null;
  };
  const navigate = (event: React.KeyboardEvent<HTMLElement>, trackIndex: number, clipIndex: number | null) => {
    if (event.altKey || event.ctrlKey || event.metaKey) return;
    const track = remix.tracks[trackIndex];
    if (!track) return;
    if (event.shiftKey && event.key === " " && clipIndex !== null) {
      const id = track.clips[clipIndex]?.id;
      if (!id) return;
      event.preventDefault();
      event.stopPropagation();
      onSelectedClipIds(toggleClipSelection(selectedClipIds, id));
      rangeAnchor.current = id;
      return;
    }
    if (event.key === "Enter" || event.key === " ") {
      if (event.shiftKey) return;
      event.preventDefault();
      event.stopPropagation();
      if (clipIndex === null) {
        focusAt(trackIndex, track.clips.length ? 0 : null);
        if (track.clips.length) selectClip(track.id, 0);
      }
      else selectClip(track.id, clipIndex, event.currentTarget);
      return;
    }
    if (!["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home", "End"].includes(event.key)) return;
    event.preventDefault();
    event.stopPropagation();
    let targetTrack = trackIndex;
    let targetClip: number | null = clipIndex;
    if (event.key === "ArrowUp" || event.key === "ArrowDown") {
      const nextTrack = Math.max(0, Math.min(remix.tracks.length - 1, trackIndex + (event.key === "ArrowDown" ? 1 : -1)));
      const clips = remix.tracks[nextTrack].clips;
      targetTrack = nextTrack;
      targetClip = clips.length ? Math.min(clipIndex ?? 0, clips.length - 1) : null;
    } else {
      const order = track.clips.map((clip, index) => ({ index, start: clip.timelineStartMs }))
        .sort((a, b) => a.start - b.start || a.index - b.index);
      const current = order.findIndex((clip) => clip.index === clipIndex);
      const next = event.key === "Home" ? 0 : event.key === "End" ? order.length - 1
        : Math.max(0, Math.min(order.length - 1, current + (event.key === "ArrowRight" ? 1 : -1)));
      targetClip = order[next]?.index ?? null;
    }
    const currentId = clipIndex === null ? null : track.clips[clipIndex]?.id;
    const targetId = targetClip === null ? null : remix.tracks[targetTrack].clips[targetClip]?.id;
    if (event.shiftKey) {
      const order = orderedClipIds(remix.tracks);
      if (!rangeAnchor.current || !order.includes(rangeAnchor.current))
        rangeAnchor.current = currentId ?? targetId ?? null;
      if (targetId && rangeAnchor.current)
        onSelectedClipIds(anchoredClipRange(order, rangeAnchor.current, targetId));
    } else {
      // Navigation moves focus, not membership. Space replaces the selection;
      // Shift+Space can therefore compose arbitrary selections across lanes.
      rangeAnchor.current = targetId ?? null;
    }
    focusAt(targetTrack, targetClip);
  };
  const timelineEndMs = useMemo(
    () => Math.max(
      duration * 1000,
      ...remix.tracks.flatMap((track) => track.clips.map((clip) => clip.timelineStartMs + clip.durationMs)),
    ),
  [duration, remix.tracks]);
  const timelineWidth = Math.max(720, (timelineEndMs / 1000 + 2) * zoom);
  const bars = Math.ceil(timelineEndMs / barMs(timing));
  const beats = Math.ceil(timelineEndMs / beatMs(timing));

  const beginDrag = (
    event: React.PointerEvent<HTMLElement>,
    mode: DragMode,
    trackId: string,
    clipIndex: number,
    clip: RemixClipInput,
    touchMove = false,
  ) => {
    event.stopPropagation();
    const clipId = clip.id;
    if (!clipId) return;
    rangeAnchor.current = clipId;
    // Touching a clip body selects it, while leaving horizontal movement to
    // the scrollable timeline. The dedicated move control starts a drag.
    if (event.pointerType === "touch" && mode === "move" && !touchMove) {
      onSelectedClipIds([clipId]);
      onSelection({ trackId, clipIndex });
      return;
    }
    event.preventDefault();
    // Modifier clicks never create a persisted group; they only compose the
    // current UI selection. Shift creates a same-track range, while command /
    // control adds or removes compatible clips on any owned remix track.
    if (event.shiftKey) {
      const first = selection?.trackId === trackId ? selection.clipIndex : clipIndex;
      const trackClipIds = remix.tracks.find((track) => track.id === trackId)?.clips
        .map((item) => item.id)
        .filter((id): id is string => Boolean(id)) ?? [clipId];
      const range = clipRangeSelection(trackClipIds, first, clipIndex);
      onSelectedClipIds(range);
      onSelection({ trackId, clipIndex });
      return;
    }
    if (event.metaKey || event.ctrlKey) {
      const next = toggleClipSelection(selectedClipIds, clipId);
      onSelectedClipIds(next);
      onSelection(next.length ? { trackId, clipIndex } : null);
      return;
    }
    const sourceDurationMs = sourceDurationById.get(clip.stemAssetId) ?? clip.sourceOffsetMs + clip.durationMs;
    const sourceBpm = sourceBpmByStemId.get(clip.stemAssetId) ?? null;
    const tempoRatio = clip.tempoSyncEnabled
      ? (tempoRatioForBpm(timing.tempoBpm, sourceBpm ?? Number.NaN) ?? 1)
      : 1;
    const clipIds = mode === "move" && selectedClipIds.includes(clipId) ? selectedClipIds : [clipId];
    event.currentTarget.setPointerCapture(event.pointerId);
    drag.current = { mode, trackId, clipIndex, original: remix, clip, sourceDurationMs, tempoRatio, clipIds, lastTimelineDeltaMs: 0, startX: event.clientX };
    draft.current = remix;
    onSelectedClipIds(clipIds);
    onSelection({ trackId, clipIndex });
  };

  const resolveSourceBeatWindow = (clip: RemixClipInput) => {
    if (!clip.beatSnapEnabled) return clip;
    const beat = sourceBeatByStemId.get(clip.stemAssetId);
    const sourceBpm = sourceBpmByStemId.get(clip.stemAssetId) ?? null;
    const ratio = clip.tempoSyncEnabled
      ? tempoRatioForBpm(timing.tempoBpm, sourceBpm ?? Number.NaN)
      : 1;
    const snapped = ratio && beat?.status === "complete"
      ? snapSourceWindowToBeats(clip.sourceOffsetMs, clip.durationMs, beat.beatGrid, ratio)
      : null;
    if (!snapped) return clip;
    const fadeOutMs = Math.min(clip.fadeOutMs, snapped.durationMs);
    return { ...clip, ...snapped, fadeOutMs, fadeInMs: Math.min(clip.fadeInMs, snapped.durationMs - fadeOutMs) };
  };

  const updateDrag = (event: React.PointerEvent<HTMLElement>) => {
    const active = drag.current;
    if (!active) return;
    const deltaMs = ((event.clientX - active.startX) / zoom) * 1000;
    let next: Remix;
    if (active.mode === "move") {
      const snappedAnchor = snapTimelineMs(active.clip.timelineStartMs + deltaMs, timing);
      const actualDelta = snappedAnchor - active.clip.timelineStartMs;
      active.lastTimelineDeltaMs = actualDelta;
      next = {
        ...active.original,
        tracks: active.original.tracks.map((track) => ({
          ...track,
          clips: track.clips.map((item) => active.clipIds.includes(item.id ?? "")
            ? moveClip(item, item.timelineStartMs + actualDelta)
            : item),
        })),
      };
    } else {
      const nextClip = active.mode === "trim-left"
        ? resolveSourceBeatWindow(trimClipLeft(active.clip, snapTimelineMs(active.clip.timelineStartMs + deltaMs, timing), active.sourceDurationMs, active.tempoRatio))
        : resolveSourceBeatWindow(trimClipRight(active.clip, snapTimelineMs(active.clip.timelineStartMs + active.clip.durationMs + deltaMs, timing), active.sourceDurationMs, active.tempoRatio));
      next = replaceClip(active.original, active.trackId, active.clipIndex, nextClip);
    }
    draft.current = next;
    onPreview(next);
  };

  const endDrag = () => {
    const active = drag.current;
    if (active && draft.current) {
      if (active.mode === "move" && active.lastTimelineDeltaMs !== 0)
        void onBatchCommit(active.original, active.clipIds, "move", { timelineDeltaMs: active.lastTimelineDeltaMs });
      else if (active.mode !== "move") onCommit(active.original, draft.current);
      else onPreview(active.original);
    }
    drag.current = null;
    draft.current = null;
  };
  const cancelDrag = () => {
    const active = drag.current;
    if (active) onPreview(active.original);
    drag.current = null;
    draft.current = null;
  };
  const seekLaneOnTap = (event: React.PointerEvent<HTMLDivElement>) => {
    const start = lanePointerStart.current;
    if (!start || start.pointerId !== event.pointerId) return;
    lanePointerStart.current = null;
    if (Math.hypot(event.clientX - start.x, event.clientY - start.y) > 8) return;
    const bounds = start.lane.getBoundingClientRect();
    onSeek(snapTimelineMs(((event.clientX - bounds.left) / zoom) * 1000, timing));
  };
  const runGroup = (operation: "move" | "nudge" | "duplicate" | "delete", payload: Record<string, unknown> = {}, ids = selectedClipIds) => {
    if (!ids.length || batchBusy.current) return;
    batchBusy.current = true;
    setEditMessage("Saving clip edit…");
    void onBatchCommit(remix, ids, operation, payload)
      .then((error) => setEditMessage(error ?? (operation === "delete" ? "Selected clips deleted." : "Clip edit saved.")))
      .catch((error: unknown) => setEditMessage(error instanceof Error ? error.message : "Could not save the clip edit."))
      .finally(() => { batchBusy.current = false; });
  };
  const moveByKeyboard = (event: React.KeyboardEvent<HTMLElement>, clip: RemixClipInput) => {
    if (event.ctrlKey || event.metaKey || event.shiftKey) return;
    if (!clip.id || !["ArrowLeft", "ArrowRight"].includes(event.key)) return;
    event.preventDefault();
    event.stopPropagation();
    const ids = selectedClipIds;
    if (!ids.length) return;
    const earliest = Math.min(...remix.tracks.flatMap((track) => track.clips)
      .filter((candidate) => ids.includes(candidate.id ?? "")).map((candidate) => candidate.timelineStartMs));
    const target = snapTimelineMs(clip.timelineStartMs + (event.key === "ArrowLeft" ? -1 : 1) * keyboardStepMs, timing);
    const delta = Math.max(-earliest, target - clip.timelineStartMs);
    if (delta !== 0) runGroup("move", { timelineDeltaMs: delta }, ids);
  };
  const trimByKeyboard = (event: React.KeyboardEvent<HTMLElement>, trackId: string, index: number, side: "left" | "right") => {
    if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
    if (!["ArrowLeft", "ArrowRight", "Enter", " "].includes(event.key)) return;
    event.preventDefault();
    event.stopPropagation();
    if (event.key === "Enter" || event.key === " ") return;
    const clip = remix.tracks.find((track) => track.id === trackId)!.clips[index];
    const delta = (event.key === "ArrowLeft" ? -1 : 1) * keyboardStepMs;
    const sourceDurationMs = sourceDurationById.get(clip.stemAssetId) ?? clip.sourceOffsetMs + clip.durationMs;
    const ratio = clip.tempoSyncEnabled ? tempoRatioForBpm(timing.tempoBpm, sourceBpmByStemId.get(clip.stemAssetId) ?? Number.NaN) ?? 1 : 1;
    const next = resolveSourceBeatWindow(side === "left"
      ? trimClipLeft(clip, clip.timelineStartMs + delta, sourceDurationMs, ratio)
      : trimClipRight(clip, clip.timelineStartMs + clip.durationMs + delta, sourceDurationMs, ratio));
    if (next.timelineStartMs === clip.timelineStartMs && next.sourceOffsetMs === clip.sourceOffsetMs
      && next.durationMs === clip.durationMs && next.fadeInMs === clip.fadeInMs && next.fadeOutMs === clip.fadeOutMs) return;
    onCommit(remix, replaceClip(remix, trackId, index, next));
  };
  const automationPosition = (parameter: AutomationParameter, value: number) => parameter === "volume"
    ? Math.max(0, Math.min(1, value / 2))
    : Math.max(0, Math.min(1, (value + 1) / 2));
  const automationAtPointer = (active: AutomationDragState, event: React.PointerEvent<HTMLElement>) => {
    const timelineMs = Math.max(0, Math.min(86_400_000, Math.round(((event.clientX - active.lane.left) / zoom) * 1000)));
    const normalised = Math.max(0, Math.min(1, 1 - ((event.clientY - active.lane.top) / active.lane.height)));
    const value = active.parameter === "volume" ? Number((normalised * 2).toFixed(3)) : Number((normalised * 2 - 1).toFixed(3));
    return { timelineMs, value };
  };
  const beginAutomationDrag = (
    event: React.PointerEvent<HTMLElement>,
    remixTrackId: string,
    parameter: AutomationParameter,
    point: AutomationPoint,
  ) => {
    event.preventDefault();
    event.stopPropagation();
    const lane = event.currentTarget.parentElement?.getBoundingClientRect();
    if (!lane) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    automationDrag.current = { point, remixTrackId, parameter, lane, moved: false, timelineMs: point.timelineMs, value: point.value };
    setSelectedAutomationPointId(point.id ?? `${remixTrackId}:${parameter}:${point.timelineMs}`);
  };
  const moveAutomationDrag = (event: React.PointerEvent<HTMLElement>) => {
    const active = automationDrag.current;
    if (!active) return;
    active.moved = true;
    Object.assign(active, automationAtPointer(active, event));
  };
  const endAutomationDrag = () => {
    const active = automationDrag.current;
    if (active?.moved)
      void onAutomationEdit(remix, "upsert", {
        remixTrackId: active.remixTrackId,
        parameter: active.parameter,
        pointId: active.point.id,
        timelineMs: active.timelineMs,
        value: active.value,
      });
    automationDrag.current = null;
  };

  return (
    <>
      <p className="timeline-keyboard-help" id={keyboardHelpId}>Arrow keys move focus · Shift + Arrow/Home/End selects a range in lane order, then start-time order · Shift + Space toggles a clip · Space selects only this clip · Alt + Left/Right moves · Tab to a trim handle, then Left/Right resizes · Delete removes selected clips</p>
      <div className="timeline-toolbar">
        <span className="snap-indicator">{timing.snapEnabled ? `Snap: ${timing.gridDivision}` : "Snap: off"}</span>
        <span>{formatMusicalPosition(positionMs, timing)}</span>
        <span className="multi-clip-actions" aria-label="Selected clip actions">{selectedClipIds.length ? `${selectedClipIds.length} selected` : "Select clips"}<button className="button secondary" disabled={!selectedClipIds.length} onClick={() => runGroup("nudge", { amount: "1ms", direction: "back" })}>Nudge −</button><button className="button secondary" disabled={!selectedClipIds.length} onClick={() => runGroup("nudge", { amount: "1ms", direction: "forward" })}>Nudge +</button><button className="button secondary" disabled={!selectedClipIds.length} onClick={() => runGroup("duplicate")}>Duplicate</button><button className="button danger" disabled={!selectedClipIds.length} onClick={() => runGroup("delete")}>Delete</button></span>
      </div>
      <span className="timeline-selection-status" role="status" aria-live="polite" aria-atomic="true">{selectedClipIds.length} {selectedClipIds.length === 1 ? "clip selected" : "clips selected"}</span>
      <span className="timeline-edit-status" role="status">{editMessage}</span>
      <div ref={automationEditorRef}>
        <AutomationEditor key={remix.id} remix={remix} positionMs={positionMs} target={automationTarget} onTarget={setAutomationTarget} onEdit={onAutomationEdit} />
      </div>
      <div className="timeline-axis">
        0s <span>{clock(timelineEndMs / 1000)}</span>
        <em>{timing.tempoBpm} BPM · {timing.timeSignatureNumerator}/{timing.timeSignatureDenominator} · {timing.gridDivision}</em>
      </div>
      <div className="timeline-scroll" ref={timelineRef} role="region" aria-label="Arrangement timeline" aria-describedby={keyboardHelpId} tabIndex={0} onKeyDown={(event) => {
        if (event.target === event.currentTarget && !event.altKey && !event.ctrlKey && !event.metaKey && !event.shiftKey && ["Enter", "ArrowDown"].includes(event.key)) {
          event.preventDefault();
          focusAt(0, remix.tracks[0]?.clips.length ? 0 : null);
          if (remix.tracks[0]?.clips.length) selectClip(remix.tracks[0].id, 0);
        }
      }}>
        <div className="timeline timeline-direct" style={{ width: timelineWidth }}>
          <div className="timeline-grid" aria-hidden="true">
            {Array.from({ length: bars + 1 }, (_, index) => <i className="bar-line" key={`bar-${index}`} style={{ left: `${(index * barMs(timing) / 1000) * zoom}px` }} />)}
            {Array.from({ length: beats + 1 }, (_, index) => <i className="beat-line" key={`beat-${index}`} style={{ left: `${(index * beatMs(timing) / 1000) * zoom}px` }} />)}
          </div>
          <div className="timeline-playhead" style={{ left: `${(positionMs / 1000) * zoom}px` }} aria-hidden="true" />
          {remix.tracks.map((track, trackIndex) => (
            <div className="timeline-track" key={track.id} data-timeline-track-index={trackIndex}>
              <header>
                <div>
                  <b>{track.name}</b>
                  <small>{effectiveMuted({ muted: track.muted, solo: track.solo }, remix.tracks.some((candidate) => candidate.solo)) ? "Muted by mixer state" : "Audible"}</small>
                </div>
                <div className="timeline-track-controls">
                  <label>Vol <input aria-label={`${track.name} arrangement volume`} type="range" min="0" max="2" step="0.01" value={track.volume} onChange={(event) => onChange((current) => ({ ...current, tracks: current.tracks.map((candidate) => candidate.id === track.id ? { ...candidate, volume: Number(event.target.value) } : candidate) }))} /></label>
                  <label>Pan <input aria-label={`${track.name} arrangement pan`} type="range" min="-1" max="1" step="0.01" value={track.pan} onChange={(event) => onChange((current) => ({ ...current, tracks: current.tracks.map((candidate) => candidate.id === track.id ? { ...candidate, pan: Number(event.target.value) } : candidate) }))} /></label>
                  <button className={`toggle ${track.muted ? "on" : ""}`} onClick={() => onChange((current) => ({ ...current, tracks: current.tracks.map((candidate) => candidate.id === track.id ? { ...candidate, muted: !candidate.muted } : candidate) }))}>M</button>
                  <button className={`toggle ${track.solo ? "on" : ""}`} onClick={() => onChange((current) => ({ ...current, tracks: current.tracks.map((candidate) => candidate.id === track.id ? { ...candidate, solo: !candidate.solo } : candidate) }))}>S</button>
                  <button className="button secondary" onClick={() => {
                    const ids = trackClipSelection(track.clips.map((clip) => clip.id).filter((id): id is string => Boolean(id)));
                    onSelectedClipIds(ids);
                    onSelection(ids.length ? { trackId: track.id, clipIndex: 0 } : null);
                  }}>Select track</button>
                  <button className="button secondary" onClick={() => onDuplicateTrack(track.id)}>Duplicate track</button>
                </div>
              </header>
              <div
                className="clip-lane"
                tabIndex={0}
                role="group"
                aria-label={`${track.name} clip lane`}
                aria-describedby={keyboardHelpId}
                onKeyDown={(event) => { if (event.target === event.currentTarget) navigate(event, trackIndex, null); }}
                onPointerDown={(event) => {
                  if (event.target !== event.currentTarget) return;
                  lanePointerStart.current = {
                    pointerId: event.pointerId,
                    x: event.clientX,
                    y: event.clientY,
                    lane: event.currentTarget,
                  };
                }}
                onPointerMove={(event) => {
                  const start = lanePointerStart.current;
                  if (start?.pointerId === event.pointerId && Math.hypot(event.clientX - start.x, event.clientY - start.y) > 8)
                    lanePointerStart.current = null;
                }}
                onPointerUp={seekLaneOnTap}
                onPointerCancel={() => { lanePointerStart.current = null; }}
              >
                {track.clips.map((clip, index) => {
                  const groupSelected = Boolean(clip.id && selectedClipIds.includes(clip.id));
                  return <article
                    className={`clip ${groupSelected ? "selected multi-selected" : ""}`}
                    key={clip.id ?? `new-${index}`}
                    data-clip-index={index}
                    tabIndex={0}
                    role="group"
                    aria-label={`${track.name} clip ${index + 1}${groupSelected ? ", selected" : ""}`}
                    aria-describedby={keyboardHelpId}
                    onFocus={(event) => {
                      if (event.target === event.currentTarget || (event.target as HTMLElement).closest(".trim-handle,.clip-move-handle")) {
                        focusedClip.current = { element: event.currentTarget, trackId: track.id, index };
                        if (!navigating.current) rangeAnchor.current = clip.id ?? null;
                        onSelection({ trackId: track.id, clipIndex: index });
                      }
                    }}
                    onKeyDown={(event) => {
                      if (event.target !== event.currentTarget) return;
                      if (event.altKey && !event.ctrlKey && !event.metaKey) moveByKeyboard(event, clip);
                      else if (event.key === "Delete" && !event.shiftKey && !event.ctrlKey && !event.metaKey && clip.id) {
                        event.preventDefault();
                        event.stopPropagation();
                        runGroup("delete");
                      } else navigate(event, trackIndex, index);
                    }}
                    style={{ left: `${(clip.timelineStartMs / 1000) * zoom}px`, width: `${Math.max(18, (clip.durationMs / 1000) * zoom)}px` }}
                    onPointerDown={(event) => beginDrag(event, "move", track.id, index, clip)}
                    onPointerMove={updateDrag}
                    onPointerUp={endDrag}
                    onPointerCancel={cancelDrag}
                  >
                    <span className="trim-handle trim-left" role="button" tabIndex={0} aria-label={`Trim ${track.name} clip ${index + 1} left`} aria-describedby={keyboardHelpId} onKeyDown={(event) => trimByKeyboard(event, track.id, index, "left")} onPointerDown={(event) => beginDrag(event, "trim-left", track.id, index, clip)} onPointerMove={updateDrag} onPointerUp={endDrag} onPointerCancel={cancelDrag} />
                    <b>{index + 1}</b>
                    <label className="legacy-clip-start">Start<input aria-label={`${track.name} clip ${index + 1} start`} type="number" min="0" step="0.01" value={clip.timelineStartMs / 1000} onPointerDown={(event) => event.stopPropagation()} onChange={(event) => onChange((current) => {
                      const value = Math.max(0, Number(event.target.value) || 0) * 1000;
                      return replaceClip(current, track.id, index, { ...clip, timelineStartMs: clip.beatSnapEnabled ? snapTimelineMs(value, timing) : value });
                    })} /></label>
                    <span className="clip-label">{Math.round(clip.durationMs / 1000)}s</span>
                    <button type="button" className="clip-move-handle" aria-label={`Move ${track.name} clip ${index + 1}`} aria-describedby={keyboardHelpId} onKeyDown={(event) => moveByKeyboard(event, clip)} onPointerDown={(event) => beginDrag(event, "move", track.id, index, clip, true)} onPointerMove={updateDrag} onPointerUp={endDrag} onPointerCancel={cancelDrag}>↔</button>
                    <span className="trim-handle trim-right" role="button" tabIndex={0} aria-label={`Trim ${track.name} clip ${index + 1} right`} aria-describedby={keyboardHelpId} onKeyDown={(event) => trimByKeyboard(event, track.id, index, "right")} onPointerDown={(event) => beginDrag(event, "trim-right", track.id, index, clip)} onPointerMove={updateDrag} onPointerUp={endDrag} onPointerCancel={cancelDrag} />
                  </article>;
                })}
                <div className="automation-lane-stack" aria-label={`${track.name} automation lanes`}>
                  {(["volume", "pan"] as const).map((parameter) => {
                    const lane = remix.automation.find((item) => item.remixTrackId === track.id && item.parameter === parameter);
                    const points = lane?.points ?? [];
                    const defaultValue = parameter === "volume" ? track.volume : track.pan;
                    return <div
                      className={`automation-lane ${parameter}`}
                      key={parameter}
                      onPointerDown={(event) => {
                        if (event.target !== event.currentTarget) return;
                        const rect = event.currentTarget.getBoundingClientRect();
                        const timelineMs = Math.max(0, Math.min(86_400_000, Math.round(((event.clientX - rect.left) / zoom) * 1000)));
                        void onAutomationEdit(remix, "upsert", { remixTrackId: track.id, parameter, timelineMs, value: defaultValue });
                      }}
                    >
                      <span>{parameter === "volume" ? "VOL" : "PAN"}</span>
                      {points.map((point) => {
                        const key = point.id ?? `${track.id}:${parameter}:${point.timelineMs}`;
                        return <button
                          type="button"
                          className={`automation-point ${selectedAutomationPointId === key ? "selected" : ""}`}
                          aria-label={`${track.name} ${parameter} point at ${point.timelineMs} milliseconds`}
                          aria-pressed={automationTarget.trackId === track.id && automationTarget.parameter === parameter && automationTarget.timelineMs === point.timelineMs}
                          key={key}
                          style={{ left: `${(point.timelineMs / 1000) * zoom}px`, bottom: `${automationPosition(parameter, point.value) * 100}%` }}
                          onPointerDown={(event) => beginAutomationDrag(event, track.id, parameter, point)}
                          onPointerMove={moveAutomationDrag}
                          onPointerUp={endAutomationDrag}
                          onPointerCancel={endAutomationDrag}
                          onClick={() => {
                            setSelectedAutomationPointId(key);
                            setAutomationTarget({ trackId: track.id, parameter, timelineMs: point.timelineMs });
                            automationEditorRef.current?.querySelector<HTMLInputElement>('input[type="number"]')?.focus();
                          }}
                          onContextMenu={(event) => {
                            event.preventDefault();
                            event.stopPropagation();
                            if (point.id) void onAutomationEdit(remix, "delete", { remixTrackId: track.id, parameter, pointId: point.id });
                          }}
                        />;
                      })}
                    </div>;
                  })}
                </div>
              </div>
            </div>
          ))}
        </div>
      </div>
    </>
  );
}
