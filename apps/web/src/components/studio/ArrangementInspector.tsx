"use client";

import { useState } from "react";
import {
  beatGridAvailability,
  clipTempoRatio,
  crossSourceAlignmentState,
  nearestBeat,
  projectSourceBeatToRemixMs,
  semitoneShift,
  snapSourceWindowToBeats,
  tempoRatioForBpm,
} from "@waveyard/types";
import type { RemixClipInput } from "@/lib/remix";
import { barMs, beatMs, formatMusicalPosition, snapTimelineMs, type MusicalTiming } from "@/lib/timing";
import type { Remix, SourceAlignmentInfo } from "./types";
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
  sourceAssetIdByStemId,
  sourceAlignmentByStemId,
  comparisonSource,
  slicePrefill,
  onAlignBeat,
  onClipEdit,
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
  sourceAssetIdByStemId?: Map<string, string>;
  sourceAlignmentByStemId?: Map<string, SourceAlignmentInfo>;
  comparisonSource?: SourceAlignmentInfo | null;
  slicePrefill?: { sourceAssetId: string; startBeatIndex: number; endBeatIndex: number; token: string } | null;
  onAlignBeat?: (clipId: string, sourceBeatIndex: number, timelineTargetMs: number) => Promise<string | null>;
  onClipEdit?: (clipId: string, operation: "move" | "nudge" | "trim-left" | "trim-right" | "slip" | "duplicate" | "split", payload: Record<string, unknown>) => Promise<string | null>;
  onReload: () => void;
}) {
  const [enteredStartBeatIndex, setStartBeatIndex] = useState(0);
  const [enteredEndBeatIndex, setEndBeatIndex] = useState(1);
  const [dismissedPrefill, setDismissedPrefill] = useState<string | null>(null);
  const [repetitions, setRepetitions] = useState(4);
  const [actionError, setActionError] = useState("");
  const [alignBeatIndex, setAlignBeatIndex] = useState(0);
  const [alignmentMessage, setAlignmentMessage] = useState("");
  const [aligning, setAligning] = useState(false);
  const [editAmountMs, setEditAmountMs] = useState(100);
  const [moveSnap, setMoveSnap] = useState<"free" | "beat" | "bar">("free");
  const [editing, setEditing] = useState(false);
  const track = selection ? remix.tracks.find((candidate) => candidate.id === selection.trackId) : undefined;
  const clip = track && selection ? track.clips[selection.clipIndex] : undefined;
  const prefillKey = slicePrefill ? `${slicePrefill.sourceAssetId}:${slicePrefill.startBeatIndex}:${slicePrefill.endBeatIndex}:${slicePrefill.token}` : null;
  const prefillMatches = Boolean(
    clip && slicePrefill && sourceAssetIdByStemId?.get(clip.stemAssetId) === slicePrefill.sourceAssetId
    && sourceBeatByStemId?.get(clip.stemAssetId)?.beatGrid
    && slicePrefill.startBeatIndex >= 0
    && slicePrefill.endBeatIndex < sourceBeatByStemId!.get(clip.stemAssetId)!.beatGrid!.length
    && slicePrefill.endBeatIndex > slicePrefill.startBeatIndex,
  );
  // Prefill is derived at render time, not a second clip/slicing state. Editing
  // either select explicitly takes control back to its existing local values.
  const startBeatIndex = prefillMatches && dismissedPrefill !== prefillKey ? slicePrefill!.startBeatIndex : enteredStartBeatIndex;
  const endBeatIndex = prefillMatches && dismissedPrefill !== prefillKey ? slicePrefill!.endBeatIndex : enteredEndBeatIndex;
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
  const sourceAlignment = sourceAlignmentByStemId?.get(clip.stemAssetId);
  const clipTempoRatioValue = clipTempoRatio(clip.tempoSyncEnabled, sourceAlignment?.bpm, remix.tempoBpm);
  const sourceConsumedMs = clipTempoRatioValue
    ? Math.ceil(clip.durationMs * clipTempoRatioValue)
    : 0;
  const alignableBeatIndices = (sourceAlignment?.beatGrid ?? []).flatMap((beat, index) =>
    beat >= clip.sourceOffsetMs && beat <= clip.sourceOffsetMs + sourceConsumedMs ? [index] : [],
  );
  const selectedAlignBeatIndex = alignableBeatIndices.includes(alignBeatIndex)
    ? alignBeatIndex
    : (alignableBeatIndices[0] ?? null);
  const projectedSourceBeats = clip.tempoSyncEnabled && sourceAlignment?.beatGrid
    ? alignableBeatIndices.slice(0, 16).map((index) => ({
      index,
      timelineMs: projectSourceBeatToRemixMs({
        sourceBeatMs: sourceAlignment.beatGrid![index],
        sourceOffsetMs: clip.sourceOffsetMs,
        timelineStartMs: clip.timelineStartMs,
        sourceBpm: sourceAlignment.bpm,
        remixBpm: remix.tempoBpm,
        tempoSyncEnabled: true,
      }),
    }))
    : [];
  const alignmentState = crossSourceAlignmentState({
    analysisComplete: sourceAlignment?.analysisStatus === "complete",
    beatGridAvailable: Boolean(sourceAlignment?.beatGrid?.length),
    tempoSyncEnabled: clip.tempoSyncEnabled,
    keySyncEnabled: clip.keySyncEnabled,
    beatSnapEnabled: clip.beatSnapEnabled,
  });
  const sourceKeyShift = sourceAlignment?.musicalKey && remix.targetKey
    ? semitoneShift(sourceAlignment.musicalKey, remix.targetKey)
    : null;
  const comparisonKeyShift = comparisonSource?.musicalKey && remix.targetKey
    ? semitoneShift(comparisonSource.musicalKey, remix.targetKey)
    : null;
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
  const alignBeatToPlayhead = async () => {
    if (!clip.id || selectedAlignBeatIndex === null || !onAlignBeat) return;
    setAligning(true);
    setAlignmentMessage("");
    const message = await onAlignBeat(clip.id, selectedAlignBeatIndex, Math.round(positionMs));
    setAligning(false);
    setAlignmentMessage(message ?? `Source beat ${selectedAlignBeatIndex + 1} aligned to ${formatMusicalPosition(positionMs, timing)}.`);
  };
  const applyClipEdit = async (
    operation: "move" | "nudge" | "trim-left" | "trim-right" | "slip" | "duplicate" | "split",
    payload: Record<string, unknown>,
  ) => {
    if (!clip.id || !onClipEdit || editing) return;
    setEditing(true);
    setActionError("");
    const message = await onClipEdit(clip.id, operation, payload);
    setEditing(false);
    if (message) setActionError(message);
  };
  const splitAtPlayhead = () => void applyClipEdit("split", { timelineMs: snapTimelineMs(positionMs, timing) });
  return <aside className="clip-inspector" aria-label="Arrangement inspector">
    <h3>Arrangement inspector</h3>
    <p><strong>{track.name}</strong> · clip {selection.clipIndex + 1}</p>
    <fieldset className="clip-edit-tools"><legend>Position · source · edit</legend>
      <div className="clip-edit-row"><label>Move snap <select aria-label="Clip move snap" value={moveSnap} onChange={(event) => setMoveSnap(event.target.value as "free" | "beat" | "bar")}><option value="free">Free</option><option value="beat">Beat</option><option value="bar">Bar</option></select></label><button className="button secondary" disabled={!clip.id || editing} onClick={() => void applyClipEdit("move", { timelineStartMs: positionMs, snapMode: moveSnap })}>Move to playhead</button></div>
      <div className="clip-edit-row"><span>Nudge</span>{(["1ms", "10ms", "beat", "bar"] as const).map((amount) => <span className="nudge-pair" key={amount}><button className="button secondary" aria-label={`Nudge ${amount} backward`} disabled={!clip.id || editing} onClick={() => void applyClipEdit("nudge", { amount, direction: "back" })}>−</button><button className="button secondary" aria-label={`Nudge ${amount} forward`} disabled={!clip.id || editing} onClick={() => void applyClipEdit("nudge", { amount, direction: "forward" })}>+ {amount}</button></span>)}</div>
      <div className="clip-edit-row"><label>Edit ms <input aria-label="Clip edit amount" type="number" min="1" value={editAmountMs} onChange={(event) => setEditAmountMs(Math.max(1, Number(event.target.value) || 1))} /></label><button className="button secondary" disabled={!clip.id || editing} onClick={() => void applyClipEdit("trim-left", { timelineDeltaMs: editAmountMs })}>Trim left</button><button className="button secondary" disabled={!clip.id || editing} onClick={() => void applyClipEdit("trim-right", { timelineDeltaMs: -editAmountMs })}>Trim right</button><button className="button secondary" disabled={!clip.id || editing} onClick={() => void applyClipEdit("slip", { sourceOffsetMs: clip.sourceOffsetMs + editAmountMs })}>Slip source +</button><button className="button secondary" disabled={!clip.id || editing || clip.sourceOffsetMs < editAmountMs} onClick={() => void applyClipEdit("slip", { sourceOffsetMs: clip.sourceOffsetMs - editAmountMs })}>Slip source −</button></div>
      <p>Timeline moves snap only at the timeline start. Trims and slips keep this ordinary clip&apos;s immutable source window within its source bounds.</p>
    </fieldset>
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
    {sourceAlignment && <fieldset className="cross-source-alignment"><legend>Cross-source alignment</legend>
      <p><b>{sourceAlignment.sourceName}</b> · <span className={`alignment-state ${alignmentState}`}>{alignmentState.replaceAll("-", " ")}</span></p>
      <dl>
        <dt>Source BPM</dt><dd>{sourceAlignment.bpm?.toFixed(1) ?? "Unknown"}</dd>
        <dt>Remix BPM</dt><dd>{remix.tempoBpm.toFixed(1)}</dd>
        <dt>Tempo ratio</dt><dd>{clipTempoRatioValue?.toFixed(4) ?? "Unavailable"}</dd>
        <dt>Source key</dt><dd>{sourceAlignment.musicalKey ?? "Unknown"}</dd>
        <dt>Remix key</dt><dd>{remix.targetKey ?? "None"}</dd>
        <dt>Key shift</dt><dd>{sourceKeyShift === null ? "Unavailable" : `${sourceKeyShift >= 0 ? "+" : ""}${sourceKeyShift}`}</dd>
        <dt>Beat grid</dt><dd>{sourceAlignment.beatGrid?.length ? "Available" : "Unavailable"}</dd>
        <dt>Sections</dt><dd>{sourceAlignment.sectionAnalysisStatus === "complete" ? "Available" : "Unavailable"}</dd>
        <dt>Timeline anchor</dt><dd>{formatMusicalPosition(clip.timelineStartMs, timing)}</dd>
      </dl>
      {comparisonSource && comparisonSource.sourceAssetId !== sourceAlignment.sourceAssetId && <div className="source-comparison">
        <b>Compared sources</b>
        <p>{comparisonSource.sourceName}: {comparisonSource.bpm?.toFixed(1) ?? "Unknown"} BPM · {comparisonSource.musicalKey ?? "Unknown key"}<br />
        {sourceAlignment.sourceName}: {sourceAlignment.bpm?.toFixed(1) ?? "Unknown"} BPM · {sourceAlignment.musicalKey ?? "Unknown key"}<br />
        Remix: {remix.tempoBpm.toFixed(1)} BPM · {remix.targetKey ?? "No target key"}</p>
        <small>BPM transform required: {comparisonSource.bpm !== sourceAlignment.bpm ? "yes" : "no"} · Key transform required: {comparisonKeyShift !== null && comparisonKeyShift !== 0 ? "yes" : "no"} · Beat grids: {comparisonSource.beatGrid?.length && sourceAlignment.beatGrid?.length ? "available" : "unavailable"}</small>
      </div>}
      {projectedSourceBeats.length > 0 && <div className="projected-beat-markers" aria-label="Projected source beats">
        <span>Projected source beats</span>
        <div>{projectedSourceBeats.map(({ index, timelineMs }) => <i key={index} title={timelineMs === null ? "Unavailable" : `${formatMusicalPosition(timelineMs, timing)} · ${timelineMs} ms`}>{index + 1}</i>)}</div>
      </div>}
      {selectedAlignBeatIndex === null
        ? <p className="notice">No authoritative source beat falls inside this clip&apos;s current source window.</p>
        : <div className="align-beat-controls"><label>Source beat <select aria-label="Align source beat" value={selectedAlignBeatIndex} onChange={(event) => setAlignBeatIndex(Number(event.target.value))}>{alignableBeatIndices.map((index) => <option key={index} value={index}>Beat {index + 1} · {sourceAlignment.beatGrid![index]} ms</option>)}</select></label><button className="button secondary" disabled={!clip.id || !onAlignBeat || aligning} onClick={() => void alignBeatToPlayhead()}>{aligning ? "Aligning…" : "Align Beat to Playhead"}</button></div>}
      {alignmentMessage && <p className="notice">{alignmentMessage}</p>}
    </fieldset>}
    <fieldset className="beat-slice"><legend>Slice</legend>
      {beatState === "unavailable" ? <p>Beat slicing unavailable. Use freehand trimming instead.</p> : <>
        {prefillMatches && <p className="notice">Selected source section is using beats {startBeatIndex}–{endBeatIndex}. Section actions create ordinary clips from this same canonical slice range.</p>}
        <label>Start beat <select aria-label="Slice start beat" value={startBeatIndex} onChange={(event) => { setDismissedPrefill(prefillKey); setStartBeatIndex(Number(event.target.value)); }}>{beatInfo!.beatGrid!.map((beat, index) => <option key={index} value={index}>Beat {index + 1} · {beat} ms</option>)}</select></label>
        <label>End beat <select aria-label="Slice end beat" value={endBeatIndex} onChange={(event) => { setDismissedPrefill(prefillKey); setEndBeatIndex(Number(event.target.value)); }}>{beatInfo!.beatGrid!.map((beat, index) => <option key={index} value={index} disabled={index <= startBeatIndex}>Beat {index + 1} · {beat} ms</option>)}</select></label>
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
      <button className="button secondary" disabled={!clip.id || editing} onClick={splitAtPlayhead}>Split at playhead</button>
      <button className="button secondary" disabled={!clip.id || editing} onClick={() => void applyClipEdit("duplicate", {})}>Duplicate clip</button>
      <button className="button danger" onClick={() => {
        onChange((current) => ({ ...current, tracks: current.tracks.map((candidate) => candidate.id !== selection.trackId ? candidate : { ...candidate, clips: candidate.clips.filter((_, index) => index !== selection.clipIndex) }) }));
        onSelection(null);
      }}>Delete clip</button>
    </div>
  </aside>;
}
