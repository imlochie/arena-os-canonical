"use client";

import { useState } from "react";
import {
  beatGridAvailability,
  nearestBeat,
  semitoneShift,
  snapSourceWindowToBeats,
  tempoRatioForBpm,
} from "@waveyard/types";
import { splitClipAt } from "@/lib/arrangement";
import type { RemixClipInput } from "@/lib/remix";
import { barMs, beatMs, snapTimelineMs, type MusicalTiming } from "@/lib/timing";
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
  sourceBpmByStemId,
  sourceKeyByStemId,
  sourceBeatByStemId,
  onReload,
}: {
  remix: Remix;
  selection: ClipSelection;
  positionMs: number;
  timing: MusicalTiming;
  onChange: (transform: (current: Remix) => Remix) => void;
  onSelection: (selection: ClipSelection) => void;
  sourceBpmByStemId?: Map<string, number | null>;
  sourceKeyByStemId?: Map<string, string | null>;
  sourceBeatByStemId?: Map<string, { status: string; beatGrid: number[] | null; beatConfidence: number | null }>;
  onReload: () => void;
}) {
  const [startBeatIndex, setStartBeatIndex] = useState(0);
  const [endBeatIndex, setEndBeatIndex] = useState(1);
  const [repetitions, setRepetitions] = useState(4);
  const [actionError, setActionError] = useState("");
  const track = selection ? remix.tracks.find((candidate) => candidate.id === selection.trackId) : undefined;
  const clip = track && selection ? track.clips[selection.clipIndex] : undefined;
  if (!track || !clip || !selection)
    return <aside className="clip-inspector"><h3>Arrangement inspector</h3><p>Select a clip to edit timing, source offset, gain, fades, or export-only tempo sync.</p></aside>;
  const update = (change: (current: RemixClipInput) => RemixClipInput) => onChange((current) => updateSelected(current, selection, change));
  const maxFade = Math.max(0, clip.durationMs - clip.fadeOutMs);
  const sourceBpm = sourceBpmByStemId?.get(clip.stemAssetId) ?? null;
  const usableBpm = Number.isFinite(sourceBpm) && sourceBpm! >= 40 && sourceBpm! <= 300;
  const tempoRatio = usableBpm ? remix.tempoBpm / sourceBpm! : null;
  const sourceKey = sourceKeyByStemId?.get(clip.stemAssetId) ?? null;
  const keyShift = sourceKey && remix.targetKey ? semitoneShift(sourceKey, remix.targetKey) : null;
  const beatInfo = sourceBeatByStemId?.get(clip.stemAssetId);
  const beatState = beatGridAvailability(beatInfo?.status, beatInfo?.beatGrid, beatInfo?.beatConfidence);
  const sourceRatio = clip.tempoSyncEnabled
    ? tempoRatioForBpm(remix.tempoBpm, sourceBpm ?? Number.NaN)
    : 1;
  const selectedSourceDurationMs = endBeatIndex > startBeatIndex
    ? Math.max(0, (beatInfo?.beatGrid?.[endBeatIndex] ?? 0) - (beatInfo?.beatGrid?.[startBeatIndex] ?? 0))
    : 0;
  const selectedTimelineDurationMs = sourceRatio ? Math.round(selectedSourceDurationMs / sourceRatio) : 0;
  const snapSourceOffset = (item: RemixClipInput, sourceOffsetMs: number) => {
    const snapped = item.beatSnapEnabled && beatState !== "unavailable"
      ? nearestBeat(sourceOffsetMs, beatInfo?.beatGrid)
      : null;
    return { ...item, sourceOffsetMs: snapped ?? sourceOffsetMs };
  };
  const snapSourceWindow = (item: RemixClipInput, durationMs: number) => {
    const snapped = item.beatSnapEnabled && beatState !== "unavailable" && sourceRatio
      ? snapSourceWindowToBeats(item.sourceOffsetMs, durationMs, beatInfo?.beatGrid, sourceRatio)
      : null;
    if (!snapped) return { ...item, durationMs };
    const fadeOutMs = Math.min(item.fadeOutMs, snapped.durationMs);
    return {
      ...item,
      ...snapped,
      fadeOutMs,
      fadeInMs: Math.min(item.fadeInMs, snapped.durationMs - fadeOutMs),
    };
  };
  const createBeatSlice = async () => {
    if (!clip.id) { setActionError("Save this clip before creating a slice."); return; }
    setActionError("");
    const response = await fetch(`/api/remixes/${remix.id}/clips/slice`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ clipId: clip.id, startBeatIndex, endBeatIndex }),
    });
    if (!response.ok) { setActionError((await response.json().catch(() => ({}))).error ?? "Could not create slice."); return; }
    onReload();
  };
  const createBeatLoop = async () => {
    if (!clip.id) { setActionError("Save this clip before creating a loop."); return; }
    setActionError("");
    const response = await fetch(`/api/remixes/${remix.id}/clips/loop`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ clipId: clip.id, repetitions }),
    });
    if (!response.ok) { setActionError((await response.json().catch(() => ({}))).error ?? "Could not create loop."); return; }
    onReload();
  };
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
      return snapSourceWindow({ ...item, fadeInMs, fadeOutMs }, durationMs);
    })} /></label>
    <label>Source offset (ms)<input type="number" min="0" value={clip.sourceOffsetMs} onChange={(event) => update((item) => snapSourceOffset(item, Math.max(0, Number(event.target.value) || 0)))} /></label>
    <label>Clip gain<input type="range" min="0" max="4" step="0.01" value={clip.gain} onChange={(event) => update((item) => ({ ...item, gain: Number(event.target.value) }))} /><output>{clip.gain.toFixed(2)}×</output></label>
    <fieldset className="tempo-sync"><legend>Tempo sync</legend>
      <label><input aria-label="Tempo sync" type="checkbox" checked={clip.tempoSyncEnabled} onChange={(event) => update((item) => ({ ...item, tempoSyncEnabled: event.target.checked }))} /> {clip.tempoSyncEnabled ? "Sync to remix BPM" : "Off"}</label>
      {usableBpm
        ? (clip.tempoSyncEnabled && <p>Source {sourceBpm!.toFixed(2)} BPM → remix {remix.tempoBpm.toFixed(2)} BPM · ratio {tempoRatio!.toFixed(4)}. Export-only; arrangement preview uses original audio.</p>)
        : <p>Source tempo unavailable. {clip.tempoSyncEnabled ? "Export will fail until this source has complete BPM analysis." : "Tempo sync cannot be rendered until BPM analysis completes."}</p>}
    </fieldset>
    <fieldset className="key-sync"><legend>Key Sync</legend>
      <label><input aria-label="Key sync" type="checkbox" checked={clip.keySyncEnabled} onChange={(event) => update((item) => ({ ...item, keySyncEnabled: event.target.checked }))} /> {clip.keySyncEnabled ? "Sync to remix key" : "Off"}</label>
      {sourceKey && remix.targetKey && keyShift !== null
        ? (clip.keySyncEnabled && <p>Source {sourceKey} → remix {remix.targetKey} · {keyShift >= 0 ? "+" : ""}{keyShift} semitones. Export-only; arrangement preview uses original audio.</p>)
        : <p>{!sourceKey ? "Source key unavailable." : "Target remix key unavailable."} {clip.keySyncEnabled ? "Export will fail until complete key analysis and a target key are available." : "Key sync cannot be rendered until both are available."}</p>}
    </fieldset>
    <fieldset className="beat-snap"><legend>Beat Snap</legend>
      <label><input aria-label="Beat snap" type="checkbox" checked={clip.beatSnapEnabled} onChange={(event) => update((item) => {
        const enabled = event.target.checked;
        const snapped = enabled && beatState !== "unavailable"
          ? nearestBeat(item.sourceOffsetMs, beatInfo?.beatGrid)
          : null;
        return { ...item, beatSnapEnabled: enabled, sourceOffsetMs: snapped ?? item.sourceOffsetMs };
      })} /> {clip.beatSnapEnabled ? "Source Beats" : "Off"}</label>
      {beatState === "unavailable"
        ? <p>Beat grid analysis is not available for this source. Free positioning remains available.</p>
        : <p>Beat grid {beatState === "low-confidence" ? "available with low confidence" : "available"} · {beatInfo!.beatGrid!.length} beats · confidence {beatInfo!.beatConfidence === null ? "unknown" : beatInfo!.beatConfidence.toFixed(2)}. Source beat alignment: {clip.sourceOffsetMs} ms. Source offset and trim boundaries resolve to analyzed beats{clip.tempoSyncEnabled ? " using the existing tempo ratio" : ""}.</p>}
    </fieldset>
    <fieldset className="beat-slice"><legend>Slice</legend>
      {beatState === "unavailable" ? <p>Beat slicing unavailable. Use freehand trimming instead.</p> : <>
        <label>Start beat <select aria-label="Slice start beat" value={startBeatIndex} onChange={(event) => setStartBeatIndex(Number(event.target.value))}>{beatInfo!.beatGrid!.map((beat, index) => <option key={index} value={index}>Beat {index + 1} · {beat} ms</option>)}</select></label>
        <label>End beat <select aria-label="Slice end beat" value={endBeatIndex} onChange={(event) => setEndBeatIndex(Number(event.target.value))}>{beatInfo!.beatGrid!.map((beat, index) => <option key={index} value={index} disabled={index <= startBeatIndex}>Beat {index + 1} · {beat} ms</option>)}</select></label>
        <p>Source beats {startBeatIndex + 1}–{endBeatIndex + 1} · {Math.max(0, endBeatIndex - startBeatIndex)} intervals · {selectedSourceDurationMs} ms source / {selectedTimelineDurationMs} ms timeline · {(selectedTimelineDurationMs / beatMs(timing)).toFixed(2)} beats · {(selectedTimelineDurationMs / barMs(timing)).toFixed(2)} bars.</p>
        <button className="button secondary" disabled={!clip.id || endBeatIndex <= startBeatIndex} onClick={() => void createBeatSlice()}>Create Slice</button>
      </>}
    </fieldset>
    <fieldset className="beat-loop"><legend>Loop</legend>
      <label>Add repeats <input aria-label="Loop repetitions" type="number" min="1" max="64" value={repetitions} onChange={(event) => setRepetitions(Math.max(1, Math.min(64, Number(event.target.value) || 1)))} /></label>
      <p>Creates independent clips after this region; each remains individually editable.</p>
      <button className="button secondary" disabled={!clip.id || !clip.beatSnapEnabled} onClick={() => void createBeatLoop()}>Create Loop</button>
    </fieldset>
    {actionError && <p className="notice">{actionError}</p>}
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
