/**
 * Waveyard synthesis engine — real rendered audio, no placeholders.
 *
 * Renders note events (from the arrangement composer) into stereo PCM
 * through the same buffer format the DSP kernels and meters consume, and
 * encodes standard 16-bit PCM WAV files. Instruments are honest
 * subtractive-synthesis approximations (detuned saw ensembles, plucks,
 * sub-sine), chosen so a CPU-only render is fast and deterministic.
 */

import { designBiquad, applySoftClipCeiling, type StereoBuffer } from "./dsp";

export const SYNTH_INSTRUMENTS = ["strings", "pad", "pluck", "choir", "sub-bass"] as const;
export type SynthInstrument = (typeof SYNTH_INSTRUMENTS)[number];

export type NoteEvent = {
  /** Start time in milliseconds, on the arrangement timeline. */
  startMs: number;
  /** Duration in milliseconds (> 0). */
  durationMs: number;
  /** MIDI note number (0–127). */
  midi: number;
  /** Velocity 0–1. */
  velocity: number;
};

export const A4_MIDI = 69;
export const A4_HZ = 440;

export function midiToHz(midi: number): number {
  return A4_HZ * Math.pow(2, (midi - A4_MIDI) / 12);
}

export type InstrumentVoice = {
  /** Detuned saw/voice count. */
  voices: number;
  /** Detune in cents between adjacent voices. */
  detuneCents: number;
  /** Attack/release in seconds. */
  attackSec: number;
  releaseSec: number;
  /** Lowpass cutoff base (Hz) before velocity scaling. */
  cutoffHz: number;
  /** Oscillator kind. */
  oscillator: "saw" | "sine";
  /** Vibrato depth in cents (0 = none). */
  vibratoCents: number;
};

export const INSTRUMENT_VOICES: Record<SynthInstrument, InstrumentVoice> = {
  strings: { voices: 3, detuneCents: 8, attackSec: 0.12, releaseSec: 0.35, cutoffHz: 3200, oscillator: "saw", vibratoCents: 6 },
  pad: { voices: 4, detuneCents: 12, attackSec: 0.4, releaseSec: 0.8, cutoffHz: 1800, oscillator: "saw", vibratoCents: 4 },
  pluck: { voices: 1, detuneCents: 0, attackSec: 0.004, releaseSec: 0.28, cutoffHz: 5200, oscillator: "saw", vibratoCents: 0 },
  choir: { voices: 3, detuneCents: 6, attackSec: 0.25, releaseSec: 0.5, cutoffHz: 2400, oscillator: "saw", vibratoCents: 10 },
  "sub-bass": { voices: 1, detuneCents: 0, attackSec: 0.01, releaseSec: 0.15, cutoffHz: 160, oscillator: "sine", vibratoCents: 0 },
};

function sawPhase(phase: number): number {
  return 2 * (phase - Math.floor(phase + 0.5));
}

/**
 * Render note events into a stereo buffer of `totalSeconds`. Notes outside
 * the buffer are clipped, not wrapped. Deterministic: no randomness.
 */
export function renderNotes(
  events: NoteEvent[],
  instrument: SynthInstrument,
  sampleRate: number,
  totalSeconds: number,
  gain = 0.5,
): StereoBuffer {
  const voice = INSTRUMENT_VOICES[instrument];
  const totalFrames = Math.max(1, Math.round(totalSeconds * sampleRate));
  const buffer = new Float32Array(totalFrames * 2);

  for (const event of events) {
    const startFrame = Math.round((event.startMs / 1000) * sampleRate);
    const lengthFrames = Math.round((event.durationMs / 1000) * sampleRate);
    if (lengthFrames <= 0 || startFrame >= totalFrames) continue;
    const endFrame = Math.min(totalFrames, startFrame + lengthFrames);
    const hz = midiToHz(event.midi);
    const cutoff = Math.max(80, Math.min(sampleRate * 0.45, voice.cutoffHz * (0.5 + event.velocity)));
    const lp = designBiquad({ type: "lowpass", freqHz: cutoff, q: 0.5 }, sampleRate);

    // Each note owns its filter state — overlapping notes never interfere.
    let x1 = 0, x2 = 0, y1 = 0, y2 = 0;

    for (let frame = startFrame; frame < endFrame; frame += 1) {
      const t = (frame - startFrame) / sampleRate;
      const envelope =
        Math.min(1, t / voice.attackSec) *
        Math.min(1, Math.max(0, (lengthFrames / sampleRate - t) / voice.releaseSec));
      if (envelope <= 0) continue;

      let sample = 0;
      for (let v = 0; v < voice.voices; v += 1) {
        const detuneFactor = Math.pow(2, (voice.detuneCents * (v - (voice.voices - 1) / 2)) / 1200);
        const vibrato =
          voice.vibratoCents > 0
            ? Math.pow(2, (voice.vibratoCents * Math.sin(2 * Math.PI * 5.5 * t)) / 1200)
            : 1;
        const freq = hz * detuneFactor * vibrato;
        const phase = (freq * frame) / sampleRate;
        sample +=
          voice.oscillator === "sine"
            ? Math.sin(2 * Math.PI * phase)
            : sawPhase(phase);
      }
      const x = (sample / voice.voices) * envelope * event.velocity * gain;
      const y = lp.b0 * x + lp.b1 * x1 + lp.b2 * x2 - lp.a1 * y1 - lp.a2 * y2;
      x2 = x1; x1 = x; y2 = y1; y1 = y;
      buffer[frame * 2] += y;
      buffer[frame * 2 + 1] += y;
    }
  }
  applySoftClipCeiling(buffer, -3);
  return buffer;
}

// ---------------------------------------------------------------------------
// WAV encoding (16-bit PCM, stereo)
// ---------------------------------------------------------------------------

export function encodeWav16(buffer: StereoBuffer, sampleRate: number): Uint8Array {
  const frames = buffer.length >> 1;
  const dataBytes = frames * 4; // 2 channels × 2 bytes
  const out = new Uint8Array(44 + dataBytes);
  const view = new DataView(out.buffer);

  const ascii = (offset: number, text: string) => {
    for (let i = 0; i < text.length; i += 1) view.setUint8(offset + i, text.charCodeAt(i));
  };
  ascii(0, "RIFF");
  view.setUint32(4, 36 + dataBytes, true);
  ascii(8, "WAVE");
  ascii(12, "fmt ");
  view.setUint32(16, 16, true); // PCM chunk size
  view.setUint16(20, 1, true); // PCM format
  view.setUint16(22, 2, true); // channels
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 4, true); // byte rate
  view.setUint16(32, 4, true); // block align
  view.setUint16(34, 16, true); // bits per sample
  ascii(36, "data");
  view.setUint32(40, dataBytes, true);

  let offset = 44;
  for (let i = 0; i < buffer.length; i += 1) {
    const clipped = Math.max(-1, Math.min(1, buffer[i]));
    view.setInt16(offset, Math.round(clipped * 32767), true);
    offset += 2;
  }
  return out;
}

export type DecodedWav = { sampleRate: number; channels: number; frames: number; samples: Float32Array };

/** Parse a 16-bit PCM WAV back to floats — used by tests and round-trip checks. */
export function decodeWav16(bytes: Uint8Array): DecodedWav | null {
  if (bytes.length < 44) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const tag = (offset: number, length: number) =>
    String.fromCharCode(...bytes.subarray(offset, offset + length));
  if (tag(0, 4) !== "RIFF" || tag(8, 4) !== "WAVE") return null;
  let offset = 12;
  let sampleRate = 0;
  let channels = 0;
  let bits = 0;
  while (offset + 8 <= bytes.length) {
    const chunkId = tag(offset, 4);
    const size = view.getUint32(offset + 4, true);
    if (chunkId === "fmt ") {
      channels = view.getUint16(offset + 10, true);
      sampleRate = view.getUint32(offset + 12, true);
      bits = view.getUint16(offset + 22, true);
    } else if (chunkId === "data") {
      if (bits !== 16) return null;
      const sampleCount = Math.floor(size / 2);
      const samples = new Float32Array(sampleCount);
      for (let i = 0; i < sampleCount; i += 1)
        samples[i] = view.getInt16(offset + 8 + i * 2, true) / 32768;
      return { sampleRate, channels, frames: Math.floor(sampleCount / channels), samples };
    }
    offset += 8 + size + (size % 2);
  }
  return null;
}

/** Render note events straight to a WAV file body. */
export function renderNotesToWav(
  events: NoteEvent[],
  instrument: SynthInstrument,
  sampleRate: number,
  totalSeconds: number,
  gain?: number,
): Uint8Array {
  return encodeWav16(renderNotes(events, instrument, sampleRate, totalSeconds, gain), sampleRate);
}
