"use client";
import { useEffect, useMemo, useRef, useState } from "react";

type Stem = { id: string; stemType: string; durationSeconds: number; sampleRate: number; channels: number; format: string; fileSizeBytes: number; model: string; modelVersion: string; };
function clock(seconds: number) { const min = Math.floor(seconds / 60); const sec = Math.floor(seconds % 60); return `${min}:${String(sec).padStart(2, "0")}`; }

export function StemMixer({ stems }: { stems: Stem[] }) {
  const refs = useRef<Record<string, HTMLAudioElement | null>>({}); const [playing, setPlaying] = useState(false); const [position, setPosition] = useState(0); const [volume, setVolume] = useState<Record<string, number>>({}); const [muted, setMuted] = useState<Record<string, boolean>>({});
  const duration = useMemo(() => Math.max(0, ...stems.map((stem) => stem.durationSeconds)), [stems]);
  useEffect(() => () => { Object.values(refs.current).forEach((audio) => audio?.pause()); }, []);
  function setAllPosition(next: number) { Object.values(refs.current).forEach((audio) => { if (audio && Math.abs(audio.currentTime - next) > .12) audio.currentTime = next; }); setPosition(next); }
  async function toggle() { if (playing) { Object.values(refs.current).forEach((audio) => audio?.pause()); setPlaying(false); return; } const started = await Promise.all(Object.values(refs.current).map(async (audio) => { if (!audio) return; audio.currentTime = position; await audio.play(); })); void started; setPlaying(true); }
  function updateVolume(id: string, next: number) { setVolume((current) => ({ ...current, [id]: next })); const audio = refs.current[id]; if (audio) audio.volume = muted[id] ? 0 : next; }
  function toggleMute(id: string) { const next = !muted[id]; setMuted((current) => ({ ...current, [id]: next })); const audio = refs.current[id]; if (audio) audio.volume = next ? 0 : (volume[id] ?? 1); }
  if (!stems.length) return null;
  return <section className="mixer" aria-label="Stem mixer"><div className="transport"><button data-testid="play-all" onClick={() => void toggle()}>{playing ? "Pause" : "Play all"}</button><input aria-label="Seek stems" type="range" min="0" max={duration || 1} value={position} step="0.01" onChange={(event) => setAllPosition(Number(event.target.value))} /><span>{clock(position)} / {clock(duration)}</span></div>{stems.map((stem, index) => <article className="stem" data-testid={`stem-${stem.stemType}`} key={stem.id}><div><b>{stem.stemType}</b><small>{stem.format.toUpperCase()} · {stem.sampleRate} Hz · {stem.channels} ch</small></div><div><input aria-label={`${stem.stemType} volume`} type="range" min="0" max="1" step="0.01" value={volume[stem.id] ?? 1} onChange={(event) => updateVolume(stem.id, Number(event.target.value))} /><audio ref={(node) => { refs.current[stem.id] = node; }} src={`/api/assets/${stem.id}`} preload="metadata" onTimeUpdate={(event) => { if (index === 0) setPosition(event.currentTarget.currentTime); }} onEnded={() => { if (index === 0) setPlaying(false); }} /></div><button className="button secondary" onClick={() => toggleMute(stem.id)}>{muted[stem.id] ? "Unmute" : "Mute"}</button></article>)}</section>;
}
