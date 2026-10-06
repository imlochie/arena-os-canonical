/**
 * AI hearing capability model — the honesty contract.
 *
 * Every AI feature in Waveyard must state which of these three modes it is
 * operating in, and the UI must use the exact labels from capabilityLabel.
 * A text-only model must never be presented as having heard audio.
 */

export const AUDIO_AI_CAPABILITIES = [
  "audio-model",
  "audio-derived",
  "text-only",
] as const;

export type AudioAiCapability = (typeof AUDIO_AI_CAPABILITIES)[number];

/** Exact UI-facing labels — no synonyms, no hedging. */
export function capabilityLabel(capability: AudioAiCapability): string {
  switch (capability) {
    case "audio-model":
      return "AI hearing: direct audio";
    case "audio-derived":
      return "AI reasoning: derived audio analysis";
    case "text-only":
      return "AI cannot hear audio in this session.";
  }
}

export function describeCapability(capability: AudioAiCapability): string {
  switch (capability) {
    case "audio-model":
      return "The selected model accepts audio input and received the actual audio.";
    case "audio-derived":
      return "The selected model cannot hear audio. It receives authoritative measurements and representations derived from the actual audio (levels, loudness, spectrum, dynamics, timing, stems).";
    case "text-only":
      return "The selected model can reason about project metadata only. No audio and no audio-derived measurements were sent in this session.";
  }
}

/** Classify a provider/model pair into the honest capability mode. */
export function classifyProviderCapability(input: {
  provider: string;
  model: string;
  supportsAudioInput: boolean;
  analysisPacketAvailable: boolean;
}): AudioAiCapability {
  if (input.supportsAudioInput) return "audio-model";
  if (input.analysisPacketAvailable) return "audio-derived";
  return "text-only";
}
