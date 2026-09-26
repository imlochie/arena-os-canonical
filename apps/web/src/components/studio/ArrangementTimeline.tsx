"use client";

import { useMemo, useRef } from "react";
import { moveClip, trimClipLeft, trimClipRight } from "@/lib/arrangement";
import { effectiveMuted, type RemixClipInput } from "@/lib/remix";
import { barMs, beatMs, formatMusicalPosition, snapTimelineMs, type MusicalTiming } from "@/lib/timing";
import { clock, type Remix } from "./types";

export type ClipSelection = { trackId: string; clipIndex: number } | null;
type DragMode = "move" | "trim-left" | "trim-right";
type DragState = {
  mode: DragMode;
  trackId: string;
  clipIndex: number;
  original: Remix;
  clip: RemixClipInput;
  sourceDurationMs: number;
  startX: number;
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
  sourceDurationById,
  onSelection,
  onPreview,
  onCommit,
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
  sourceDurationById: Map<string, number>;
  onSelection: (selection: ClipSelection) => void;
  onPreview: (next: Remix) => void;
  onCommit: (before: Remix, after: Remix) => void;
  onChange: (transform: (current: Remix) => Remix) => void;
  onSeek: (milliseconds: number) => void;
  onDuplicateTrack: (trackId: string) => void;
}) {
  const drag = useRef<DragState | null>(null);
  const draft = useRef<Remix | null>(null);
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
  ) => {
    event.preventDefault();
    event.stopPropagation();
    const sourceDurationMs = sourceDurationById.get(clip.stemAssetId) ?? clip.sourceOffsetMs + clip.durationMs;
    event.currentTarget.setPointerCapture(event.pointerId);
    drag.current = { mode, trackId, clipIndex, original: remix, clip, sourceDurationMs, startX: event.clientX };
    draft.current = remix;
    onSelection({ trackId, clipIndex });
  };

  const updateDrag = (event: React.PointerEvent<HTMLElement>) => {
    const active = drag.current;
    if (!active) return;
    const deltaMs = ((event.clientX - active.startX) / zoom) * 1000;
    let nextClip: RemixClipInput;
    if (active.mode === "move")
      nextClip = moveClip(active.clip, snapTimelineMs(active.clip.timelineStartMs + deltaMs, timing));
    else if (active.mode === "trim-left")
      nextClip = trimClipLeft(active.clip, snapTimelineMs(active.clip.timelineStartMs + deltaMs, timing), active.sourceDurationMs);
    else
      nextClip = trimClipRight(active.clip, snapTimelineMs(active.clip.timelineStartMs + active.clip.durationMs + deltaMs, timing), active.sourceDurationMs);
    const next = replaceClip(active.original, active.trackId, active.clipIndex, nextClip);
    draft.current = next;
    onPreview(next);
  };

  const endDrag = () => {
    const active = drag.current;
    if (active && draft.current) onCommit(active.original, draft.current);
    drag.current = null;
    draft.current = null;
  };

  return (
    <>
      <div className="timeline-toolbar">
        <span className="snap-indicator">{timing.snapEnabled ? `Snap: ${timing.gridDivision}` : "Snap: off"}</span>
        <span>{formatMusicalPosition(positionMs, timing)}</span>
      </div>
      <div className="timeline-axis">
        0s <span>{clock(timelineEndMs / 1000)}</span>
        <em>{timing.tempoBpm} BPM · {timing.timeSignatureNumerator}/{timing.timeSignatureDenominator} · {timing.gridDivision}</em>
      </div>
      <div className="timeline-scroll">
        <div className="timeline timeline-direct" style={{ width: timelineWidth }}>
          <div className="timeline-grid" aria-hidden="true">
            {Array.from({ length: bars + 1 }, (_, index) => <i className="bar-line" key={`bar-${index}`} style={{ left: `${(index * barMs(timing) / 1000) * zoom}px` }} />)}
            {Array.from({ length: beats + 1 }, (_, index) => <i className="beat-line" key={`beat-${index}`} style={{ left: `${(index * beatMs(timing) / 1000) * zoom}px` }} />)}
          </div>
          <div className="timeline-playhead" style={{ left: `${(positionMs / 1000) * zoom}px` }} aria-hidden="true" />
          {remix.tracks.map((track) => (
            <div className="timeline-track" key={track.id}>
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
                  <button className="button secondary" onClick={() => onDuplicateTrack(track.id)}>Duplicate track</button>
                </div>
              </header>
              <div
                className="clip-lane"
                onPointerDown={(event) => {
                  if (event.target === event.currentTarget) onSeek(snapTimelineMs(((event.nativeEvent.offsetX / zoom) * 1000), timing));
                }}
              >
                {track.clips.map((clip, index) => {
                  const selected = selection?.trackId === track.id && selection.clipIndex === index;
                  return <article
                    className={`clip ${selected ? "selected" : ""}`}
                    key={`${clip.id ?? "new"}-${index}`}
                    style={{ left: `${(clip.timelineStartMs / 1000) * zoom}px`, width: `${Math.max(18, (clip.durationMs / 1000) * zoom)}px` }}
                    onPointerDown={(event) => beginDrag(event, "move", track.id, index, clip)}
                    onPointerMove={updateDrag}
                    onPointerUp={endDrag}
                    onPointerCancel={endDrag}
                  >
                    <span className="trim-handle trim-left" aria-label="Trim clip left" onPointerDown={(event) => beginDrag(event, "trim-left", track.id, index, clip)} />
                    <b>{index + 1}</b>
                    <label className="legacy-clip-start">Start<input aria-label={`${track.name} clip ${index + 1} start`} type="number" min="0" step="0.01" value={clip.timelineStartMs / 1000} onPointerDown={(event) => event.stopPropagation()} onChange={(event) => onChange((current) => replaceClip(current, track.id, index, { ...clip, timelineStartMs: Math.max(0, Number(event.target.value) || 0) * 1000 }))} /></label>
                    <span className="clip-label">{Math.round(clip.durationMs / 1000)}s</span>
                    <span className="trim-handle trim-right" aria-label="Trim clip right" onPointerDown={(event) => beginDrag(event, "trim-right", track.id, index, clip)} />
                  </article>;
                })}
              </div>
            </div>
          ))}
        </div>
      </div>
    </>
  );
}
