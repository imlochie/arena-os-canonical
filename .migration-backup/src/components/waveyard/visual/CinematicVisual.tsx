"use client";

import { useEffect, useMemo, useState, type CSSProperties } from "react";
import { CINEMATIC_VISUAL_PRESETS, deriveCinematicVisualScene, motionPolicy, type CinematicVisualPreset, type WaveyardVisualState } from "@/lib/waveyard/types";
import type { MixerValues } from "@/lib/waveyard/useStemTransport";
import type { Source, Stem } from "../studio/types";

type Transport = {
  playing: boolean;
  position: number;
  error: string | null;
  play: () => Promise<void>;
  pause: () => void;
};

function sourceInitials(source?: Source) {
  return source?.originalFilename.split(/[\s._-]+/).filter(Boolean).slice(0, 2).map((word) => word[0]?.toUpperCase()).join("") || "W";
}

function readablePreset(preset: CinematicVisualPreset) {
  return preset[0].toUpperCase() + preset.slice(1);
}

export function CinematicVisual({
  source, stems, controls, transport, visualState, reducedMotion, preset, metadataVisible, fullscreen,
  onPreset, onToggleMetadata, onToggleFullscreen, onOpenStudio,
}: {
  source?: Source;
  stems: Stem[];
  controls: Record<string, MixerValues>;
  transport: Transport;
  visualState: WaveyardVisualState;
  reducedMotion: boolean;
  preset: CinematicVisualPreset;
  metadataVisible: boolean;
  fullscreen: boolean;
  onPreset: (preset: CinematicVisualPreset) => void;
  onToggleMetadata: () => void;
  onToggleFullscreen: () => void;
  onOpenStudio: () => void;
}) {
  const scene = useMemo(() => deriveCinematicVisualScene({ visualState, preset, reducedMotion }), [preset, reducedMotion, visualState]);
  const section = source?.sections?.find((candidate) => candidate.id === visualState.sectionId);
  const [overlaysVisible, setOverlaysVisible] = useState(true);
  const [interaction, setInteraction] = useState(0);
  const policy = motionPolicy(reducedMotion);
  useEffect(() => {
    if (!transport.playing || reducedMotion) return;
    const timer = window.setTimeout(() => setOverlaysVisible(false), policy.overlayDelayMs);
    return () => window.clearTimeout(timer);
  }, [interaction, policy.overlayDelayMs, reducedMotion, transport.playing]);
  const controlsVisible = !transport.playing || reducedMotion || overlaysVisible;
  const reveal = () => {
    if (!overlaysVisible) setOverlaysVisible(true);
    setInteraction((count) => count + 1);
  };
  const playLabel = transport.playing ? "Pause" : "Play";
  const activeStems = stems.filter((stem) => (visualState.stemIntensity[stem.id] ?? 0) > 0);
  const style = {
    "--visual-energy": scene.energy,
    "--visual-scale": scene.scale,
    "--visual-rotation": `${scene.rotationDeg}deg`,
    "--visual-accent": scene.accentOpacity,
    "--visual-motion": `${policy.transitionMs}ms`,
  } as CSSProperties;
  return <section
    className={`cinematic-visual ${fullscreen ? "fullscreen" : ""}`}
    data-testid="cinematic-visual"
    data-preset={preset}
    data-overlays={controlsVisible ? "visible" : "hidden"}
    data-reduced-motion={reducedMotion ? "true" : "false"}
    aria-label="Waveyard visual presentation"
    tabIndex={0}
    style={style}
    onPointerMove={reveal}
    onKeyDown={reveal}
  >
    <div className="visual-recording-frame">
      <div className="visual-atmosphere" aria-hidden="true"><i /><i /><i /></div>
      <div className="visual-artwork" aria-label={`${source?.originalFilename ?? "Waveyard"} visual artwork`}>
        <span>{sourceInitials(source)}</span><small>WAVEYARD</small>
      </div>
      <div className="visual-stem-radar" aria-label={`${scene.activeStemCount} active stems`}>
        {stems.map((stem) => {
          const intensity = visualState.stemIntensity[stem.id] ?? 0;
          const control = controls[stem.id];
          return <i key={stem.id} data-stem={stem.stemType} data-muted={intensity === 0 ? "true" : "false"} style={{ "--stem-energy": intensity } as CSSProperties} title={`${stem.stemType}${control?.muted ? " muted" : ""}`} />;
        })}
      </div>
      <div className="visual-corner visual-corner-top" aria-live="polite">
        {metadataVisible && <><span className="eyebrow">{transport.playing ? "Live transport" : "Still frame"}</span><b>{source?.originalFilename ?? "Preparing source"}</b><small>{source?.analysis?.status === "complete" ? `${source.analysis.bpm?.toFixed(1) ?? "—"} BPM · ${source.analysis.musicalKey ?? "Key unavailable"}` : "Analysis unavailable"}</small></>}
      </div>
      <div className="visual-corner visual-corner-bottom">
        {metadataVisible && <><span>{section ? `Section ${section.sectionIndex + 1}` : "Source overview"}</span><b>{Math.round(visualState.sectionProgress * 100)}%</b><small>{activeStems.length ? `${activeStems.length} stem${activeStems.length === 1 ? "" : "s"} in focus` : "No audible stems"}</small></>}
      </div>
      <div className="visual-overlay-controls" aria-label="Visual presentation controls">
        <div className="visual-preset-control" role="group" aria-label="Visual preset">
          {CINEMATIC_VISUAL_PRESETS.map((option) => <button key={option} type="button" aria-pressed={option === preset} onClick={() => { reveal(); onPreset(option); }}>{readablePreset(option)}</button>)}
        </div>
        <div className="visual-actions">
          <button type="button" className="visual-play" onClick={() => { reveal(); transport.playing ? transport.pause() : void transport.play(); }} aria-label={`${playLabel} transport`}>{transport.playing ? "Ⅱ" : "▶"}</button>
          <button type="button" onClick={() => { reveal(); onToggleMetadata(); }} aria-pressed={metadataVisible}>Info</button>
          <button type="button" onClick={() => { reveal(); onToggleFullscreen(); }}>{fullscreen ? "Exit fullscreen" : "Fullscreen"}</button>
          <button type="button" onClick={onOpenStudio}>Studio</button>
        </div>
      </div>
    </div>
  </section>;
}
