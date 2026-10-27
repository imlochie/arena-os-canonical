import { tempoRatioForBpm } from "@waveyard/types";

export function tempoRatio(targetBpm: number, sourceBpm: number) {
  if (!Number.isFinite(targetBpm) || targetBpm < 20 || targetBpm > 300)
    throw new Error("Invalid remix BPM.");
  if (!Number.isFinite(sourceBpm) || sourceBpm < 40 || sourceBpm > 300)
    throw new Error("Tempo-sync source BPM is unavailable.");
  return tempoRatioForBpm(targetBpm, sourceBpm)!;
}

/** FFmpeg atempo permits 0.5–2 per stage; deterministic chaining covers more. */
export function atempoFilterChain(ratio: number) {
  if (!Number.isFinite(ratio) || ratio <= 0) throw new Error("Invalid tempo ratio.");
  const stages: number[] = [];
  let remainder = ratio;
  while (remainder < 0.5) {
    stages.push(0.5);
    remainder /= 0.5;
  }
  while (remainder > 2) {
    stages.push(2);
    remainder /= 2;
  }
  stages.push(remainder);
  return stages.map((stage) => `atempo=${stage.toFixed(8)}`).join(",");
}

/** A synced output duration consumes duration × target/source input media. */
export function requiredSourceDurationMs(outputDurationMs: number, ratio: number) {
  if (!Number.isFinite(outputDurationMs) || outputDurationMs <= 0)
    throw new Error("Invalid clip duration.");
  return Math.ceil(outputDurationMs * ratio);
}

export function sourceDurationFits(
  sourceOffsetMs: number,
  outputDurationMs: number,
  ratio: number,
  stemDurationMs: number,
) {
  return Number.isFinite(sourceOffsetMs) && Number.isFinite(stemDurationMs)
    && sourceOffsetMs >= 0 && stemDurationMs >= 0
    && sourceOffsetMs + requiredSourceDurationMs(outputDurationMs, ratio) <= stemDurationMs;
}
