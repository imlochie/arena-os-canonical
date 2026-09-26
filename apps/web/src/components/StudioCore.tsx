"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { WaveformCanvas } from "./WaveformCanvas";
import { ArrangementTimeline, type ClipSelection } from "./studio/ArrangementTimeline";
import { ArrangementInspector } from "./studio/ArrangementInspector";
import { ClipInspector } from "./studio/ClipInspector";
import { StemMixer } from "./studio/StemMixer";
import { StudioTransport } from "./studio/StudioTransport";
import {
  remixState,
  type Remix,
  type RemixVersionSummary,
  type Source,
  type Stem,
} from "./studio/types";
import { useArrangementHistory } from "./studio/useArrangementHistory";
import { VersionHistory } from "./studio/VersionHistory";
import { splitClipAt } from "@/lib/arrangement";
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

export function StudioCore({ projectId, stems, sources }: { projectId: string; stems: Stem[]; sources: Source[] }) {
  const ids = useMemo(() => stems.map((stem) => stem.id), [stems]);
  const duration = useMemo(() => Math.max(0, ...stems.map((stem) => stem.durationSeconds)), [stems]);
  const sourceDurationById = useMemo(() => new Map(stems.map((stem) => [stem.id, Math.round(stem.durationSeconds * 1000)])), [stems]);
  const [controls, setControls] = useState<Record<string, MixerValues>>(() => controlsFor(stems));
  const [selectedId, setSelectedId] = useState(stems[0]?.id ?? "");
  const [clipSelection, setClipSelection] = useState<ClipSelection>(null);
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
  const selected = stems.find((stem) => stem.id === selectedId) ?? stems[0];
  const source = sources[0];
  const timing = useMemo(() => remix ? {
    tempoBpm: remix.tempoBpm,
    timeSignatureNumerator: remix.timeSignatureNumerator,
    timeSignatureDenominator: remix.timeSignatureDenominator,
    gridDivision: remix.gridDivision,
    snapEnabled: remix.snapEnabled,
  } : { tempoBpm: 120, timeSignatureNumerator: 4, timeSignatureDenominator: 4, gridDivision: "beat" as GridDivision, snapEnabled: true }, [remix]);

  useEffect(() => { transport.applyMix(controls); }, [controls, transport]);
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
    setControls((current) => ({ ...current, [id]: { ...current[id], ...patch } }));
    // This remains the source-stem inspection mixer. Arrangement tracks have independent controls in the timeline.
    changeRemix((current) => ({ ...current, tracks: current.tracks.map((track) => track.stemAssetId === id ? { ...track, ...patch } : track) }));
  };
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
      const split = clip && splitClipAt(clip, snapTimelineMs(transport.position * 1000, timing));
      if (!split) return;
      event.preventDefault();
      changeRemix((current) => ({ ...current, tracks: current.tracks.map((candidate) => candidate.id !== clipSelection.trackId ? candidate : { ...candidate, clips: candidate.clips.flatMap((item, index) => index === clipSelection.clipIndex ? [split.left, split.right] : [item]) }) }));
      setClipSelection({ trackId: clipSelection.trackId, clipIndex: clipSelection.clipIndex + 1 });
    };
    window.addEventListener("keydown", keyboard);
    return () => window.removeEventListener("keydown", keyboard);
  }, [changeRemix, clipSelection, redo, remix, timing, toggleStemPreview, transport, undo]);

  return <section className="studio" aria-label="Waveyard Studio">
    <header className="studio-head"><div><span className="eyebrow">Studio core</span><h2>Real stems, one transport.</h2></div><div className={`save-state ${saveState}`}>{saveState === "saved" ? "Saved" : saveState === "saving" ? "Saving…" : saveState === "unsaved" ? "Unsaved changes" : "Save failed"}</div></header>
    <div className="main-waveform"><div className="waveform-label">{source ? `Source · ${source.originalFilename}` : "Selected stem"}</div><WaveformCanvas assetId={source?.id ?? selected.id} label="project waveform" position={transport.position} duration={duration} onSeek={(seconds) => transport.seek(snapTimelineMs(seconds * 1000, timing) / 1000)} /></div>
    <StudioTransport transport={transport} timing={timing} loopStartMs={remix?.loopStartMs ?? 0} loopEndMs={remix?.loopEndMs ?? null} arrangementPlaying={arrangementPreview.playing} arrangementError={arrangementPreview.error} onToggleStemPreview={toggleStemPreview} onToggleArrangement={toggleArrangementPreview} onMasterVolume={(volume) => { transport.setMasterVolume(volume); changeRemix((current) => ({ ...current, masterVolume: volume })); }} onLoopChange={(loopStartMs, loopEndMs) => { transport.setLoop({ enabled: loopEndMs !== null, start: loopStartMs / 1000, end: (loopEndMs ?? 0) / 1000 }); changeRemix((current) => ({ ...current, loopStartMs, loopEndMs })); }} />
    <section className="studio-grid"><StemMixer stems={stems} selectedId={selectedId} duration={duration} controls={controls} transport={transport} onSelect={setSelectedId} onControl={updateControl} />{selected && <ClipInspector stem={selected} source={source} duration={duration} transport={transport} />}</section>
    <section className="remix-panel">
      <div className="panel-title"><div><span className="eyebrow">Non-destructive arrangement</span><h3>Remix timeline</h3></div>{!remix ? <button className="button" onClick={() => void createRemix()}>Create remix session</button> : <div className="remix-actions"><button className="button secondary" disabled={!history.length} onClick={undo}>Undo</button><button className="button secondary" disabled={!future.length} onClick={redo}>Redo</button><button className="button secondary" onClick={() => void createVersion()}>Save version</button><button className="button" onClick={() => void persist(remix)}>Save now</button></div>}</div>
      {remix ? <>
        <div className="arrangement-settings" aria-label="Arrangement timing settings">
          <label>BPM <input aria-label="Tempo BPM" type="number" min="20" max="300" value={remix.tempoBpm} onChange={(event) => changeRemix((current) => ({ ...current, tempoBpm: Number(event.target.value) || 120 }))} /></label>
          <label>Beats/bar <input aria-label="Time signature numerator" type="number" min="1" max="12" value={remix.timeSignatureNumerator} onChange={(event) => changeRemix((current) => ({ ...current, timeSignatureNumerator: Number(event.target.value) || 4 }))} /></label>
          <label>Beat value <select aria-label="Time signature denominator" value={remix.timeSignatureDenominator} onChange={(event) => changeRemix((current) => ({ ...current, timeSignatureDenominator: Number(event.target.value) }))}>{[1, 2, 4, 8, 16].map((value) => <option value={value} key={value}>{value}</option>)}</select></label>
          <label>Grid <select aria-label="Grid division" value={remix.gridDivision} onChange={(event) => changeRemix((current) => ({ ...current, gridDivision: event.target.value as GridDivision }))}>{["bar", "beat", "half-beat", "quarter-note"].map((value) => <option value={value} key={value}>{value}</option>)}</select></label>
          <label><input aria-label="Snap enabled" type="checkbox" checked={remix.snapEnabled} onChange={(event) => changeRemix((current) => ({ ...current, snapEnabled: event.target.checked }))} /> Snap</label>
          <label>Zoom <input aria-label="Timeline zoom" type="range" min="40" max="180" step="10" value={zoom} onChange={(event) => setZoom(Number(event.target.value))} /></label>
        </div>
        <ArrangementTimeline remix={remix} duration={duration} positionMs={transport.position * 1000} timing={timing} zoom={zoom} selection={clipSelection} sourceDurationById={sourceDurationById} onSelection={setClipSelection} onPreview={previewTimeline} onCommit={commitTimeline} onChange={changeRemix} onSeek={(milliseconds) => transport.seek(milliseconds / 1000)} onDuplicateTrack={(trackId) => void duplicateTrack(trackId)} />
        <ArrangementInspector remix={remix} selection={clipSelection} positionMs={transport.position * 1000} timing={timing} onChange={changeRemix} onSelection={setClipSelection} />
        <VersionHistory versions={versions} onRestore={(id) => void restoreVersion(id)} />
      </> : <p className="notice">Create a remix only after genuine separated stems exist. Waveyard will create tracks and clips that point to those existing assets.</p>}
    </section>
  </section>;
}
