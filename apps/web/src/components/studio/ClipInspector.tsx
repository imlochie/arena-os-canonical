"use client";

import { WaveformCanvas } from "@/components/WaveformCanvas";
import type { useStemTransport } from "@/lib/useStemTransport";
import { bytes, clock, type Source, type Stem } from "./types";

type Transport = ReturnType<typeof useStemTransport>;

export function ClipInspector({
  stem,
  source,
  duration,
  transport,
}: {
  stem: Stem;
  source?: Source;
  duration: number;
  transport: Transport;
}) {
  return (
    <aside className="inspector">
      <span className="eyebrow">Selected stem</span>
      <h3>{stem.stemType}</h3>
      <WaveformCanvas
        assetId={stem.id}
        label={`${stem.stemType} inspector waveform`}
        compact
        position={transport.position}
        duration={duration}
        onSeek={transport.seek}
      />
      <dl>
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
