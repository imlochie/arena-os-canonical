"use client";

/**
 * Clip inspector — metadata PLUS the real clip editor. Gain, fades, split,
 * duplicate, delete all go through persisted operations (clips/edit route
 * or the remix PUT), never React-only state.
 */

import { useEffect, useState } from "react";

import { WaveformCanvas } from "../WaveformCanvas";
import type { useStemTransport } from "@/lib/waveyard/useStemTransport";
import { bytes, clock, sourceStemLabel, type Remix, type Source, type Stem } from "./types";
import { SourceAnalysisSummary } from "./SourceAnalysisSummary";

type Transport = ReturnType<typeof useStemTransport>;
type Clip = Remix["tracks"][number]["clips"][number];

function PreciseClipRange({ clip, sourceDurationMs, onApply }: { clip: Clip; sourceDurationMs: number; onApply: (id: string, patch: Partial<Pick<Clip, "timelineStartMs" | "sourceOffsetMs" | "durationMs">>) => void }) {
  const [geometry, setGeometry] = useState({ timelineStartMs: String(clip.timelineStartMs), sourceOffsetMs: String(clip.sourceOffsetMs), durationMs: String(clip.durationMs) });
  const [rangeError, setRangeError] = useState("");
  function applyGeometry(event: React.FormEvent) {
    event.preventDefault();
    const patch = { timelineStartMs: Number(geometry.timelineStartMs), sourceOffsetMs: Number(geometry.sourceOffsetMs), durationMs: Number(geometry.durationMs) };
    if (Object.values(geometry).some(value => !value.trim()) || Object.values(patch).some(value => !Number.isSafeInteger(value) || value < 0 || value > 86400000) || patch.durationMs < 1) { setRangeError("Enter whole milliseconds: position/offset 0–86400000 and duration 1–86400000. Nothing was applied."); return; }
    if (!clip.tempoSyncEnabled && patch.sourceOffsetMs + patch.durationMs > Math.round(sourceDurationMs)) { setRangeError("Source range exceeds this stem. Nothing was applied."); return; }
    if ((clip.fadeInMs ?? 0) + (clip.fadeOutMs ?? 0) > patch.durationMs) { setRangeError("Shorten the existing fades before shortening this range. Nothing was applied."); return; }
    setRangeError(""); onApply(String(clip.id ?? ""), patch);
  }
  return (<form onSubmit={applyGeometry} aria-label="Precise clip range">
                <label>Timeline position (ms)<input aria-label="Clip timeline position (ms)" type="number" min="0" max="86400000" step="1" required value={geometry.timelineStartMs} onChange={event => setGeometry(current => ({ ...current, timelineStartMs: event.target.value }))} /></label>
                <label>Source offset (ms)<input aria-label="Clip source offset (ms)" type="number" min="0" max="86400000" step="1" required value={geometry.sourceOffsetMs} onChange={event => setGeometry(current => ({ ...current, sourceOffsetMs: event.target.value }))} /></label>
                <label>Duration (ms)<input aria-label="Clip duration (ms)" type="number" min="1" max="86400000" step="1" required value={geometry.durationMs} onChange={event => setGeometry(current => ({ ...current, durationMs: event.target.value }))} /></label>
                <button type="submit" className="button secondary">Apply precise range</button>
                <p className="muted">Exact milliseconds (no grid snap). One undo step; sync-aware ranges are verified on save. Shorten fades explicitly rather than losing them.</p>
                {rangeError && <p role="alert">{rangeError}</p>}
              </form>);
}

export function ClipInspector({
  stem,
  source,
  duration,
  transport,
  remix,
  activeClipId,
  onClipPatch,
  onSplitClip,
  onDuplicateClip,
  onDeleteClip,
}: {
  stem: Stem;
  source?: Source;
  duration: number;
  transport: Transport;
  remix: Remix | null;
  /** Clip currently selected in the arrangement timeline (kept in sync). */
  activeClipId?: string | null;
  /** Persisted clip property update (gain / fades) via the remix PUT path. */
  onClipPatch: (clipId: string, patch: Partial<Pick<Clip, "gain" | "fadeInMs" | "fadeOutMs" | "timelineStartMs" | "sourceOffsetMs" | "durationMs">>) => void;
  onSplitClip: (clipId: string, positionMs: number) => void;
  onDuplicateClip: (clipId: string) => void;
  onDeleteClip: (clipId: string) => void;
}) {
  const label = sourceStemLabel(source, stem.stemType);
  const track = remix?.tracks.find((candidate) => candidate.stemAssetId === stem.id);
  const clips = track?.clips ?? [];
  const [selectedClipId, setSelectedClipId] = useState<string | null>(null);
  // The inspector follows the timeline selection — it can never silently edit
  // a different clip than the one the user sees highlighted.
  useEffect(() => {
    if (activeClipId != null && clips.some((clip) => clip.id === activeClipId)) {
      setSelectedClipId(activeClipId);
    }
  }, [activeClipId, clips]);
  const selectedClip = clips.find((clip) => clip.id === selectedClipId) ?? clips[0] ?? null;

  return (
    <aside className="inspector">
      <span className="eyebrow">Selected stem</span>
      <h3>{label}</h3>
      <WaveformCanvas
        assetId={stem.id}
        label={`${label} inspector waveform`}
        compact
        position={transport.position}
        duration={duration}
        onSeek={transport.seek}
      />
      <dl>
        <dt>Source</dt>
        <dd>{source?.originalFilename ?? "Unavailable source metadata"}</dd>
        <dt>Duration</dt>
        <dd>{clock(stem.durationSeconds)}</dd>
        <dt>Format</dt>
        <dd>
          {stem.format.toUpperCase()} · {stem.codec}
        </dd>
        <dt>Audio</dt>
        <dd>
          {stem.sampleRate} Hz · {stem.channels} ch
        </dd>
        <dt>Size</dt>
        <dd>{bytes(stem.fileSizeBytes)}</dd>
        <dt>Checksum</dt>
        <dd className="checksum">{stem.checksumSha256}</dd>
        <dt>Model</dt>
        <dd>
          {stem.model} · {stem.modelVersion}
        </dd>
      </dl>

      {clips.length > 0 && (
        <section className="clip-editor" aria-label="Clip editor" data-testid="clip-editor">
          <span className="eyebrow">Clips on this track ({clips.length})</span>
          <select
            aria-label="Select clip"
            value={selectedClip?.id ?? ""}
            onChange={(event) => setSelectedClipId(event.target.value)}
          >
            {clips.map((clip, index) => (
              <option key={clip.id ?? index} value={clip.id ?? ""}>
                Clip {index + 1} · {clock((clip.timelineStartMs ?? 0) / 1000)} · {clip.durationMs} ms
              </option>
            ))}
          </select>
          {selectedClip !== null && (
            <div className="clip-controls">
              <PreciseClipRange key={`${selectedClip.id}:${selectedClip.timelineStartMs}:${selectedClip.sourceOffsetMs}:${selectedClip.durationMs}`} clip={selectedClip} sourceDurationMs={stem.durationSeconds * 1000} onApply={onClipPatch} />
              <label>
                clip gain ×
                <input
                  aria-label="Clip gain"
                  type="range" min="0" max="4" step="0.05"
                  value={selectedClip.gain ?? 1}
                  onChange={(event) => onClipPatch(String(selectedClip.id ?? ""), { gain: Number(event.target.value) })}
                />
                <output>{(selectedClip.gain ?? 1).toFixed(2)}</output>
              </label>
              <label>
                fade in ms
                <input
                  aria-label="Clip fade in"
                  type="range" min="0" max={Math.min(4000, selectedClip.durationMs)} step="10"
                  value={Math.min(selectedClip.fadeInMs ?? 0, selectedClip.durationMs)}
                  onChange={(event) => onClipPatch(String(selectedClip.id ?? ""), { fadeInMs: Number(event.target.value) })}
                />
                <output>{selectedClip.fadeInMs ?? 0}</output>
              </label>
              <label>
                fade out ms
                <input
                  aria-label="Clip fade out"
                  type="range" min="0" max={Math.min(4000, selectedClip.durationMs)} step="10"
                  value={Math.min(selectedClip.fadeOutMs ?? 0, selectedClip.durationMs)}
                  onChange={(event) => onClipPatch(String(selectedClip.id ?? ""), { fadeOutMs: Number(event.target.value) })}
                />
                <output>{selectedClip.fadeOutMs ?? 0}</output>
              </label>
              <div className="clip-actions">
                <button
                  className="button secondary"
                  onClick={() => onSplitClip(String(selectedClip.id ?? ""), Math.round(transport.position * 1000))}
                  title="Split this clip at the playhead"
                >Split at playhead</button>
                <button className="button secondary" onClick={() => onDuplicateClip(String(selectedClip.id ?? ""))}>Duplicate</button>
                <button className="button danger" onClick={() => onDeleteClip(String(selectedClip.id ?? ""))}>Delete</button>
              </div>
              <p className="muted">
                Position {clock((selectedClip.timelineStartMs ?? 0) / 1000)} · length {selectedClip.durationMs} ms ·
                source offset {selectedClip.sourceOffsetMs ?? 0} ms
              </p>
            </div>
          )}
        </section>
      )}

      {source && <SourceAnalysisSummary source={source} compact />}
      <a className="button secondary" href={`/api/assets/${stem.id}?download=1`}>
        Download stem
      </a>
      {source && (
        <a className="download-source" href={`/api/assets/${source.id}?download=1`}>
          Download original source
        </a>
      )}
    </aside>
  );
}
