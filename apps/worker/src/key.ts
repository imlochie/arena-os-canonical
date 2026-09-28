import { semitoneShift } from "@waveyard/types";
import { atempoFilterChain } from "./tempo";

export { semitoneShift };

export function resolveKeySync(
  analysisStatus: unknown,
  sourceKey: unknown,
  targetKey: unknown,
): { semitones: number } | { errorCode: "key_sync_analysis_missing" | "key_sync_key_unavailable" } {
  if (analysisStatus !== "complete") return { errorCode: "key_sync_analysis_missing" };
  const semitones = semitoneShift(sourceKey, targetKey);
  return semitones === null ? { errorCode: "key_sync_key_unavailable" } : { semitones };
}

export function pitchRatioForSemitones(semitones: number) {
  if (!Number.isInteger(semitones) || semitones < -11 || semitones > 11)
    throw new Error("Invalid key-sync semitone shift.");
  return 2 ** (semitones / 12);
}

/**
 * FFmpeg has no dedicated pitch-preserving filter in this runtime. Changing
 * asetrate changes pitch, then inverse atempo restores the timeline duration.
 */
export function pitchFilterChain(semitones: number, sampleRate: number) {
  if (!Number.isInteger(sampleRate) || sampleRate <= 0)
    throw new Error("Invalid export sample rate.");
  const ratio = pitchRatioForSemitones(semitones);
  const shiftedSampleRate = Math.round(sampleRate * ratio);
  return `asetrate=${shiftedSampleRate},aresample=${sampleRate},${atempoFilterChain(1 / ratio)}`;
}
