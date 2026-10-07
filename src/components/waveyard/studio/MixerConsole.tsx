"use client";

/**
 * Waveyard mixer console — the real workstation surface over the existing
 * transport. Every control here modifies the actual audio graph:
 *  - fader → channel GainNode (persisted as remix track volume)
 *  - pan → StereoPannerNode
 *  - phase → real polarity flip (negative gain)
 *  - mono → explicit 1-channel downmix
 *  - meters → AnalyserNode taps (peak/RMS/clip, master L/R/correlation)
 *
 * Channels are grouped SOURCE → STEM strips; MASTER is its own strip.
 * No decorative controls: anything not wired to the graph is not shown.
 */

import { useEffect, useRef, useState } from "react";

import { clock, sourceStemLabel, type Source, type Stem } from "./types";
import { InsertRack } from "./InsertRack";
import type { InsertChain } from "@/lib/waveyard/mixer/inserts";
import type { MixerValues, MeterSnapshot, useStemTransport } from "@/lib/waveyard/useStemTransport";

type Transport = ReturnType<typeof useStemTransport>;

type SourceGroup = {
  id: string;
  source?: Source;
  stems: Stem[];
};

function dbLabel(volume: number): string {
  if (volume <= 0.0001) return "−∞";
  const db = 20 * Math.log10(volume);
  return `${db >= 0 ? "+" : ""}${db.toFixed(1)}`;
}

function MeterBar({ meter, stereo }: { meter: { peak: number; rms: number; clipped: boolean }; stereo?: { left: number; right: number } }) {
  const toPct = (value: number) => `${Math.min(100, (20 * Math.log10(Math.max(value, 1e-6)) + 60) * (100 / 66))}%`;
  return (
    <div className={`console-meter ${meter.clipped ? "clipping" : ""}`} role="meter" aria-label="level">
      {stereo ? (
        <>
          <div className="meter-track"><span className="meter-rms" style={{ width: toPct(stereo.left) }} /><span className="meter-peak" style={{ width: toPct(stereo.left) }} /></div>
          <div className="meter-track"><span className="meter-rms" style={{ width: toPct(stereo.right) }} /><span className="meter-peak" style={{ width: toPct(stereo.right) }} /></div>
        </>
      ) : (
        <div className="meter-track"><span className="meter-rms" style={{ width: toPct(meter.rms) }} /><span className="meter-peak" style={{ width: toPct(meter.peak) }} /></div>
      )}
    </div>
  );
}

export function MixerConsole({
  stems,
  sources,
  selectedId,
  duration,
  controls,
  transport,
  onSelect,
  onControl,
  inserts,
  onInserts,
  masterInserts,
  onMasterInserts,
}: {
  stems: Stem[];
  sources: Source[];
  selectedId: string;
  duration: number;
  controls: Record<string, MixerValues>;
  transport: Transport;
  onSelect: (id: string) => void;
  onControl: (id: string, patch: Partial<MixerValues>) => void;
  inserts: Record<string, InsertChain>;
  onInserts: (stemAssetId: string, chain: InsertChain) => void;
  masterInserts: InsertChain;
  onMasterInserts: (chain: InsertChain) => void;
}) {
  const [meters, setMeters] = useState<MeterSnapshot | null>(null);
  const rafId = useRef<number | null>(null);
  const lastUpdate = useRef(0);

  // Poll the real AnalyserNode taps while audio flows.
  useEffect(() => {
    if (!transport.playing) {
      setMeters(transport.readMeters());
      return;
    }
    const tick = (now: number) => {
      if (now - lastUpdate.current > 50) {
        lastUpdate.current = now;
        setMeters(transport.readMeters());
      }
      rafId.current = requestAnimationFrame(tick);
    };
    rafId.current = requestAnimationFrame(tick);
    return () => {
      if (rafId.current) cancelAnimationFrame(rafId.current);
    };
  }, [transport, transport.playing]);

  const anySolo = Object.values(controls).some((track) => track.solo);
  const grouped: SourceGroup[] = sources
    .map((source) => ({ id: source.id, source, stems: stems.filter((stem) => stem.sourceAssetId === source.id) }))
    .filter((group) => group.stems.length > 0);
  const unlinked = stems.filter(
    (stem) => !grouped.some((group) => group.stems.some((candidate) => candidate.id === stem.id)),
  );
  if (unlinked.length) grouped.push({ id: "unknown-source", stems: unlinked });

  const masterMeter = meters?.master;

  return (
    <div className="mixer-panel">
      <div className="panel-title">
        <h3>Mixer console</h3>
        <span>
          {anySolo ? "Solo active" : "All unmuted stems audible"}
          {masterMeter?.correlation != null && typeof masterMeter.correlation === "number" && Number.isFinite(masterMeter.correlation)
            ? ` · stereo correlation ${masterMeter.correlation.toFixed(2)}`
            : ""}
        </span>
      </div>

      <div className="console-strips">
        {grouped.map((group, groupIndex) => (
          <section
            className="source-stem-group"
            data-testid={group.source ? `source-stems-${group.source.id}` : "source-stems-unknown"}
            aria-label={group.source ? `${group.source.originalFilename} stems` : "Unknown-source stems"}
            key={group.id}
          >
            <header className="source-stem-heading">
              <span>SOURCE {groupIndex + 1}</span>
              <b>{group.source?.originalFilename ?? "Unknown source"}</b>
              <small>{group.stems.length} stem{group.stems.length === 1 ? "" : "s"}</small>
            </header>
            {group.stems.map((stem) => {
              const control = controls[stem.id] ?? { volume: 1, pan: 0, muted: false, solo: false };
              const label = sourceStemLabel(group.source, stem.stemType);
              const meter = meters?.channels[stem.id];
              return (
                <article
                  key={stem.id}
                  data-testid={`stem-${stem.stemType}`}
                  className={`studio-stem console-strip ${selectedId === stem.id ? "selected" : ""}`}
                >
                  <button className="stem-select" onClick={() => onSelect(stem.id)}>
                    <b>STEM · {label}</b>
                    <small>{clock(stem.durationSeconds)} · {stem.sampleRate} Hz · {dbLabel(control.volume)} dB</small>
                  </button>
                  <MeterBar meter={meter ?? { peak: 0, rms: 0, clipped: false }} />
                  <label className="console-fader">
                    Fader
                    <input
                      aria-label={`${label} fader`}
                      type="range" min="0" max="2" step="0.01" value={control.volume}
                      onChange={(event) => onControl(stem.id, { volume: Number(event.target.value) })}
                    />
                  </label>
                  <label className="console-pan">
                    Pan
                    <input
                      aria-label={`${label} pan`}
                      type="range" min="-1" max="1" step="0.01" value={control.pan}
                      onChange={(event) => onControl(stem.id, { pan: Number(event.target.value) })}
                    />
                  </label>
                  <div className="console-toggles">
                    <button
                      className={`toggle ${control.muted ? "on" : ""}`}
                      aria-label={`Mute ${label}`} aria-pressed={control.muted}
                      onClick={() => onControl(stem.id, { muted: !control.muted })}
                    >M</button>
                    <button
                      className={`toggle ${control.solo ? "on" : ""}`}
                      aria-label={`Solo ${label}`} aria-pressed={control.solo}
                      onClick={() => onControl(stem.id, { solo: !control.solo })}
                    >S</button>
                    <button
                      className={`toggle ${control.phaseInvert ? "on" : ""}`}
                      aria-label={`Invert phase of ${label}`} aria-pressed={control.phaseInvert ?? false}
                      title="Phase inversion (polarity flip)"
                      onClick={() => onControl(stem.id, { phaseInvert: !control.phaseInvert })}
                    >Ø</button>
                    <button
                      className={`toggle ${control.monoMonitor ? "on" : ""}`}
                      aria-label={`Monitor ${label} in mono`} aria-pressed={control.monoMonitor ?? false}
                      title="Mono monitoring"
                      onClick={() => onControl(stem.id, { monoMonitor: !control.monoMonitor })}
                    >M①</button>
                  </div>
                  <InsertRack
                    channelLabel={label}
                    chain={inserts[stem.id] ?? []}
                    onChange={(chain) => onInserts(stem.id, chain)}
                  />
                  <audio aria-label={`${label} audio`} ref={(element) => transport.register(stem.id, element)} src={`/api/assets/${stem.id}`} preload="auto" />
                </article>
              );
            })}
          </section>
        ))}

        <section className="source-stem-group console-master" aria-label="Master channel">
          <header className="source-stem-heading">
            <span>MASTER</span>
            <b>Master</b>
            <small>{dbLabel(transport.masterVolume)} dB</small>
          </header>
          <article className="studio-stem console-strip" data-testid="master-strip">
            <div className="stem-select"><b>Master output</b><small>sum of all audible channels</small></div>
            <MeterBar
              meter={masterMeter ?? { peak: 0, rms: 0, clipped: false }}
              stereo={masterMeter ? { left: masterMeter.left, right: masterMeter.right } : { left: 0, right: 0 }}
            />
            <label className="console-fader">
              Master
              <input
                aria-label="Master volume"
                type="range" min="0" max="2" step="0.01" value={transport.masterVolume}
                onChange={(event) => transport.setMasterVolume(Number(event.target.value))}
              />
            </label>
            <div className="console-toggles">
              {masterMeter?.clipped ? (
                <button className="toggle on" aria-label="Master clipping" title="Clipping detected at the master">CLIP</button>
              ) : (
                <button className="toggle" disabled aria-label="Master not clipping" title="No clipping">—</button>
              )}
            </div>
            <InsertRack channelLabel="master" chain={masterInserts} onChange={onMasterInserts} />
          </article>
        </section>
      </div>
    </div>
  );
}
