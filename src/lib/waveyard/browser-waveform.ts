/**
 * Browser-computed waveform peaks — the honest offline path.
 *
 * When the Waveyard worker (ffmpeg/BullMQ) is unavailable, the browser itself
 * decodes the uploaded audio via Web Audio and computes REAL min/max peaks in
 * the exact `waveyard-peaks-v1` document format. The result is posted to
 * /api/waveform-jobs/{id}/browser-computed, validated server-side with the
 * same validateWaveform() the worker output passes, and stored with the job
 * stage "browser-computed" — real data, labeled provenance, never a fake.
 */

import type { WaveformDocument, WaveformPeaks } from "./types";
import { WAVEFORM_RESOLUTIONS } from "./types";

/** Must match the worker's canonical PCM format: 44.1 kHz mono. */
const WAVEFORM_PCM_SAMPLE_RATE = 44_100;

function peaksFor(samples: Float32Array, resolution: number): WaveformPeaks {
  const min = new Array<number>(resolution).fill(0);
  const max = new Array<number>(resolution).fill(0);
  for (let bucket = 0; bucket < resolution; bucket += 1) {
    const start = Math.floor((bucket * samples.length) / resolution);
    const end = Math.floor(((bucket + 1) * samples.length) / resolution);
    if (start >= end) continue;
    let low = 1;
    let high = -1;
    for (let i = start; i < end; i += 1) {
      const value = samples[i];
      if (value < low) low = value;
      if (value > high) high = value;
    }
    min[bucket] = Number(low.toFixed(6));
    max[bucket] = Number(high.toFixed(6));
  }
  return { min, max };
}

/** Decodes the file in the browser and builds a waveyard-peaks-v1 document
 *  from the actual samples. Throws when the browser cannot decode the audio. */
export async function computeBrowserWaveform(file: Blob): Promise<WaveformDocument> {
  const AudioCtx: typeof AudioContext =
    window.AudioContext ??
    (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
  const context = new AudioCtx();
  try {
    const buffer = await context.decodeAudioData(await file.arrayBuffer());
    // Mono mix of all channels, linearly resampled to the canonical 44.1 kHz
    // mono PCM the worker's ffmpeg path produces (-ac 1 -ar 44100).
    const monoNative = new Float32Array(buffer.length);
    for (let channel = 0; channel < buffer.numberOfChannels; channel += 1) {
      const data = buffer.getChannelData(channel);
      for (let i = 0; i < buffer.length; i += 1) monoNative[i] += data[i] / buffer.numberOfChannels;
    }
    const targetLength = Math.max(1, Math.round(buffer.duration * WAVEFORM_PCM_SAMPLE_RATE));
    const mono = new Float32Array(targetLength);
    if (buffer.sampleRate === WAVEFORM_PCM_SAMPLE_RATE) {
      mono.set(monoNative.subarray(0, Math.min(monoNative.length, targetLength)));
    } else {
      for (let i = 0; i < targetLength; i += 1) {
        const position = (i * buffer.sampleRate) / WAVEFORM_PCM_SAMPLE_RATE;
        const left = Math.floor(position);
        const right = Math.min(left + 1, monoNative.length - 1);
        const fraction = position - left;
        mono[i] = (monoNative[left] ?? 0) * (1 - fraction) + (monoNative[right] ?? 0) * fraction;
      }
    }
    const resolutions: Record<string, WaveformPeaks> = {};
    for (const resolution of WAVEFORM_RESOLUTIONS) {
      resolutions[String(resolution)] = peaksFor(mono, resolution);
    }
    return {
      format: "waveyard-peaks-v1",
      durationSeconds: targetLength / WAVEFORM_PCM_SAMPLE_RATE,
      sampleRate: WAVEFORM_PCM_SAMPLE_RATE,
      channels: 1,
      resolutions,
    };
  } finally {
    void context.close();
  }
}

/** Browser-decoded stream metadata, used only when the server has no ffprobe
 *  (see the uploads route fallback). Sent alongside the upload form. */
export async function computeBrowserAudioMetadata(file: Blob): Promise<{
  clientDurationSeconds: number;
  clientSampleRate: number;
  clientChannels: number;
  clientCodec: string;
}> {
  const AudioCtx: typeof AudioContext =
    window.AudioContext ??
    (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
  const context = new AudioCtx();
  try {
    const buffer = await context.decodeAudioData(await file.arrayBuffer());
    return {
      clientDurationSeconds: Math.round(buffer.duration * 1000) / 1000,
      clientSampleRate: buffer.sampleRate,
      clientChannels: buffer.numberOfChannels,
      clientCodec: "browser-decoded",
    };
  } finally {
    void context.close();
  }
}
