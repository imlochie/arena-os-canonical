"use client";

import { useEffect, useState, type CSSProperties } from "react";
import { WaveformCanvas } from "../WaveformCanvas";
import type { WaveyardVisualState } from "@/lib/waveyard/types";
import type { MixerValues } from "@/lib/waveyard/useStemTransport";
import type { Source, Stem } from "../studio/types";
import { derivePlayerPhase, formatPlayerTime, playerPhaseLabel, sectionWidths } from "./player-state";

const stemOrder = ["vocals", "melody", "other", "bass", "drums", "percussion"];

function stemDisplay(stem: Stem) {
  if (stem.stemType === "other") return "Melody";
  return `${stem.stemType[0]?.toUpperCase() ?? ""}${stem.stemType.slice(1)}`;
}

function currentSection(source: Source | undefined, visualState: WaveyardVisualState) {
  return source?.sections?.find((section) => section.id === visualState.sectionId) ?? null;
}

type Transport = {
  playing: boolean;
  position: number;
  error: string | null;
  play: () => Promise<void>;
  pause: () => void;
  seek: (seconds: number) => void;
};

export function ArtworkHero({ title, seed, compact = false }: { title: string; seed: string; compact?: boolean }) {
  const letters = title.split(/[\s._-]+/).filter(Boolean).slice(0, 2).map((item) => item[0]?.toUpperCase()).join("") || "W";
  return <div className={`artwork-hero ${compact ? "compact" : ""}`} data-artwork-seed={seed} aria-label={`${title} artwork environment`}>
    <div className="artwork-grain" aria-hidden="true" />
    <span>{letters}</span><small>WAVEYARD</small>
  </div>;
}

export function PlayerTimeline({ source, duration, position, onSeek }: { source?: Source; duration: number; position: number; onSeek: (seconds: number) => void }) {
  const sections = source?.sections ?? [];
  const widths = sectionWidths(sections, duration);
  return <section className="player-timeline" aria-label="Playback timeline">
    <div className="player-timeline-head"><span>{formatPlayerTime(position)}</span><span>{formatPlayerTime(duration)}</span></div>
    <div className="player-section-strip" aria-label="Detected source sections">
      {widths.length ? widths.map((section, index) => <i key={sections[index]?.id ?? index} style={{ width: `${Math.max(3, section.widthPercent)}%` }} title={`Section ${(sections[index]?.sectionIndex ?? index) + 1}`} />) : <i className="unknown" />}
    </div>
    {source ? <WaveformCanvas assetId={source.id} label={`${source.originalFilename} player waveform`} position={position} duration={duration} onSeek={onSeek} /> : <div className="waveform-empty">Audio source is loading.</div>}
  </section>;
}

export function LivingPlayer({
  source, stems, selectedId, controls, duration, transport, visualState, onSelectStem, onControl, onOpenStudio, fullscreen, onToggleFullscreen,
}: {
  source?: Source;
  stems: Stem[];
  selectedId: string;
  controls: Record<string, MixerValues>;
  duration: number;
  transport: Transport;
  visualState: WaveyardVisualState;
  onSelectStem: (id: string) => void;
  onControl: (id: string, patch: Partial<MixerValues>) => void;
  onOpenStudio: () => void;
  fullscreen: boolean;
  onToggleFullscreen: () => void;
}) {
  const section = currentSection(source, visualState);
  const [seeking, setSeeking] = useState(false);
  // Seeking is a short-lived interaction acknowledgement; the underlying
  // useStemTransport position remains the only playback authority.
  useEffect(() => {
    if (!seeking) return;
    const frame = window.requestAnimationFrame(() => setSeeking(false));
    return () => window.cancelAnimationFrame(frame);
  }, [seeking, transport.position]);
  const orderedStems = [...stems].sort((left, right) => stemOrder.indexOf(left.stemType) - stemOrder.indexOf(right.stemType));
  const loading = !source || !stems.length;
  const phase = derivePlayerPhase({ hasSource: Boolean(source), duration, playing: transport.playing, seeking, analysisStatus: source?.analysis?.status, error: transport.error });
  const analysisState = source?.analysis?.status === "complete" ? "analysis complete" : source?.analysis?.status === "failed" ? "analysis unavailable" : "analysis pending";
  const phaseDescription = phase === "paused" && source?.analysis?.status === "complete" ? `${analysisState} · ${playerPhaseLabel(phase)}` : phase === "analysis" ? `${playerPhaseLabel(phase)} · ${analysisState}` : playerPhaseLabel(phase);
  return <section className={`living-player ${fullscreen ? "fullscreen" : ""}`} data-testid="living-player" data-player-state={phase}>
    <div className="player-topline"><span className="eyebrow">Waveyard Play</span><span aria-live="polite">{phaseDescription}</span><button className="button secondary" onClick={onOpenStudio}>Open Studio</button></div>
    <div className="player-identity">
      <ArtworkHero title={source?.originalFilename ?? "Preparing source"} seed={source?.checksumSha256 ?? "waveyard-fallback"} />
      <div className="player-title"><span className="eyebrow">{source ? "Source identity" : "Loading"}</span><h3>{source?.originalFilename ?? "Preparing your music"}</h3><p>{source?.analysis?.status === "complete" ? `${source.analysis.bpm?.toFixed(1) ?? "—"} BPM · ${source.analysis.musicalKey ?? "Key unavailable"}` : "Musical analysis will appear when available."}</p>{section && <b>Section {section.sectionIndex + 1} · {Math.round(visualState.sectionProgress * 100)}%</b>}</div>
    </div>
    <div className="stem-constellation" aria-label="Interactive stem controls">
      {orderedStems.map((stem, index) => {
        const control = controls[stem.id] ?? { volume: 1, pan: 0, muted: false, solo: false };
        const selected = selectedId === stem.id;
        const intensity = visualState.stemIntensity[stem.id] ?? 0;
        const muted = control.muted || (Object.values(controls).some((value) => value.solo && !value.muted) && !control.solo);
        return <article key={stem.id} className={`stem-orbit stem-${stem.stemType} ${selected ? "selected" : ""} ${muted ? "muted" : ""} ${control.solo ? "solo" : ""}`} style={{ "--stem-index": index, "--stem-intensity": intensity } as CSSProperties}>
          <button className="stem-orb" onClick={() => onSelectStem(stem.id)} aria-pressed={selected} aria-label={`Select ${stemDisplay(stem)} stem`}><i aria-hidden="true" /><b>{stemDisplay(stem)}</b><small>{muted ? "Muted" : control.solo ? "Isolated" : `${Math.round(intensity * 100)}% active`}</small></button>
          <div className="stem-orbit-controls"><button type="button" aria-label={`Mute ${stemDisplay(stem)}`} aria-pressed={control.muted} onClick={() => onControl(stem.id, { muted: !control.muted })}>M</button><button type="button" aria-label={`Solo ${stemDisplay(stem)}`} aria-pressed={control.solo} onClick={() => onControl(stem.id, { solo: !control.solo })}>S</button><label><span className="sr-only">{stemDisplay(stem)} volume</span><input aria-label={`${stemDisplay(stem)} player volume`} type="range" min="0" max="2" step="0.01" value={control.volume} onChange={(event) => onControl(stem.id, { volume: Number(event.target.value) })} /></label></div>
        </article>;
      })}
      {!orderedStems.length && <p className="player-empty">Validated stems will appear here.</p>}
    </div>
    <PlayerTimeline source={source} duration={duration} position={transport.position} onSeek={(seconds) => { setSeeking(true); transport.seek(seconds); }} />
    <div className="player-transport"><button className="player-play" disabled={loading} onClick={() => transport.playing ? transport.pause() : void transport.play()} aria-label={transport.playing ? "Pause playback" : "Play playback"}>{transport.playing ? "Ⅱ" : "▶"}</button><output>{formatPlayerTime(transport.position)} <span>/</span> {formatPlayerTime(duration)}</output><button className="button secondary" disabled={loading} onClick={onToggleFullscreen}>{fullscreen ? "Exit fullscreen" : "Fullscreen"}</button></div>
    {transport.error && <p className="error">{transport.error}</p>}
  </section>;
}

export function MiniPlayer({ source, duration, transport, onOpenPlay }: { source?: Source; duration: number; transport: Transport; onOpenPlay: () => void }) {
  return <aside className="mini-player" aria-label="Mini player" data-testid="mini-player"><button className="mini-player-art" onClick={onOpenPlay}><ArtworkHero compact title={source?.originalFilename ?? "Waveyard"} seed={source?.checksumSha256 ?? "waveyard-fallback"} /></button><button className="mini-player-title" onClick={onOpenPlay}><b>{source?.originalFilename ?? "Preparing music"}</b><small>{formatPlayerTime(transport.position)} / {formatPlayerTime(duration)}</small></button><button className="mini-player-toggle" aria-label={transport.playing ? "Pause playback" : "Play playback"} onClick={() => transport.playing ? transport.pause() : void transport.play()}>{transport.playing ? "Ⅱ" : "▶"}</button><progress value={Math.max(0, transport.position)} max={Math.max(1, duration)} /></aside>;
}
