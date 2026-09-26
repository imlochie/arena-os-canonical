"use client";

import { splitClipAt } from "@/lib/arrangement";
import type { RemixClipInput } from "@/lib/remix";
import { snapTimelineMs, type MusicalTiming } from "@/lib/timing";
import type { Remix } from "./types";
import type { ClipSelection } from "./ArrangementTimeline";

function updateSelected(remix: Remix, selection: Exclude<ClipSelection, null>, update: (clip: RemixClipInput) => RemixClipInput) {
  return {
    ...remix,
    tracks: remix.tracks.map((track) => track.id !== selection.trackId ? track : {
      ...track,
      clips: track.clips.map((clip, index) => index === selection.clipIndex ? update(clip) : clip),
    }),
  };
}

export function ArrangementInspector({
  remix,
  selection,
  positionMs,
  timing,
  onChange,
  onSelection,
}: {
  remix: Remix;
  selection: ClipSelection;
  positionMs: number;
  timing: MusicalTiming;
  onChange: (transform: (current: Remix) => Remix) => void;
  onSelection: (selection: ClipSelection) => void;
}) {
  const track = selection ? remix.tracks.find((candidate) => candidate.id === selection.trackId) : undefined;
  const clip = track && selection ? track.clips[selection.clipIndex] : undefined;
  if (!track || !clip || !selection)
    return <aside className="clip-inspector"><h3>Arrangement inspector</h3><p>Select a clip to edit timing, source offset, gain, or fades.</p></aside>;
  const update = (change: (current: RemixClipInput) => RemixClipInput) => onChange((current) => updateSelected(current, selection, change));
  const maxFade = Math.max(0, clip.durationMs - clip.fadeOutMs);
  const splitAtPlayhead = () => {
    const split = splitClipAt(clip, snapTimelineMs(positionMs, timing));
    if (!split) return;
    onChange((current) => ({
      ...current,
      tracks: current.tracks.map((candidate) => candidate.id !== selection.trackId ? candidate : {
        ...candidate,
        clips: candidate.clips.flatMap((item, index) => index === selection.clipIndex ? [split.left, split.right] : [item]),
      }),
    }));
    onSelection({ trackId: selection.trackId, clipIndex: selection.clipIndex + 1 });
  };
  return <aside className="clip-inspector" aria-label="Arrangement inspector">
    <h3>Arrangement inspector</h3>
    <p><strong>{track.name}</strong> · clip {selection.clipIndex + 1}</p>
    <label>Timeline start (ms)<input type="number" min="0" value={clip.timelineStartMs} onChange={(event) => update((item) => ({ ...item, timelineStartMs: Math.max(0, Number(event.target.value) || 0) }))} /></label>
    <label>Duration (ms)<input type="number" min="1" value={clip.durationMs} onChange={(event) => update((item) => {
      const durationMs = Math.max(1, Number(event.target.value) || 1);
      const fadeOutMs = Math.min(item.fadeOutMs, durationMs);
      const fadeInMs = Math.min(item.fadeInMs, durationMs - fadeOutMs);
      return { ...item, durationMs, fadeInMs, fadeOutMs };
    })} /></label>
    <label>Source offset (ms)<input type="number" min="0" value={clip.sourceOffsetMs} onChange={(event) => update((item) => ({ ...item, sourceOffsetMs: Math.max(0, Number(event.target.value) || 0) }))} /></label>
    <label>Clip gain<input type="range" min="0" max="4" step="0.01" value={clip.gain} onChange={(event) => update((item) => ({ ...item, gain: Number(event.target.value) }))} /><output>{clip.gain.toFixed(2)}×</output></label>
    <label>Fade in (ms)<input type="number" min="0" max={maxFade} value={clip.fadeInMs} onChange={(event) => update((item) => ({ ...item, fadeInMs: Math.min(Math.max(0, Number(event.target.value) || 0), item.durationMs - item.fadeOutMs) }))} /></label>
    <label>Fade out (ms)<input type="number" min="0" max={Math.max(0, clip.durationMs - clip.fadeInMs)} value={clip.fadeOutMs} onChange={(event) => update((item) => ({ ...item, fadeOutMs: Math.min(Math.max(0, Number(event.target.value) || 0), item.durationMs - item.fadeInMs) }))} /></label>
    <div className="inspector-actions">
      <button className="button secondary" onClick={splitAtPlayhead}>Split at playhead</button>
      <button className="button secondary" onClick={() => onChange((current) => ({ ...current, tracks: current.tracks.map((candidate) => candidate.id !== selection.trackId ? candidate : { ...candidate, clips: [...candidate.clips, { ...clip, id: undefined, timelineStartMs: clip.timelineStartMs + clip.durationMs }] }) }))}>Duplicate clip</button>
      <button className="button danger" onClick={() => {
        onChange((current) => ({ ...current, tracks: current.tracks.map((candidate) => candidate.id !== selection.trackId ? candidate : { ...candidate, clips: candidate.clips.filter((_, index) => index !== selection.clipIndex) }) }));
        onSelection(null);
      }}>Delete clip</button>
    </div>
  </aside>;
}
