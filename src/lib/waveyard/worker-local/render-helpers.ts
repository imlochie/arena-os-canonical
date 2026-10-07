/**
 * FFmpeg render helpers — ports of the worker's tempo.ts / key.ts /
 * automation.ts (waveyard-worker/apps/worker/src), plus the desktop's
 * explicit unnormalized mix strategy. Pure functions, shared shape with
 * the worker so renders stay compatible.
 */

import {
  automationLinearSegments,
  evaluateAutomation,
  tempoRatioForBpm,
  semitoneShift,
  type AutomationPoint,
} from "@/lib/waveyard/types";

export function tempoRatio(targetBpm: number, sourceBpm: number) {
  if (!Number.isFinite(targetBpm) || targetBpm < 20 || targetBpm > 300) throw new Error("Invalid remix BPM.");
  if (!Number.isFinite(sourceBpm) || sourceBpm < 40 || sourceBpm > 300) throw new Error("Tempo-sync source BPM is unavailable.");
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
  if (!Number.isFinite(outputDurationMs) || outputDurationMs <= 0) throw new Error("Invalid clip duration.");
  return Math.ceil(outputDurationMs * ratio);
}

export function sourceDurationFits(sourceOffsetMs: number, outputDurationMs: number, ratio: number, stemDurationMs: number) {
  return (
    Number.isFinite(sourceOffsetMs) &&
    Number.isFinite(stemDurationMs) &&
    sourceOffsetMs >= 0 &&
    stemDurationMs >= 0 &&
    sourceOffsetMs + requiredSourceDurationMs(outputDurationMs, ratio) <= stemDurationMs
  );
}

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
  if (!Number.isInteger(semitones) || semitones < -11 || semitones > 11) throw new Error("Invalid key-sync semitone shift.");
  return 2 ** (semitones / 12);
}

/** asetrate changes pitch; inverse atempo restores the timeline duration. */
export function pitchFilterChain(semitones: number, sampleRate: number) {
  if (!Number.isInteger(sampleRate) || sampleRate <= 0) throw new Error("Invalid export sample rate.");
  const ratio = pitchRatioForSemitones(semitones);
  const shiftedSampleRate = Math.round(sampleRate * ratio);
  return `asetrate=${shiftedSampleRate},aresample=${sampleRate},${atempoFilterChain(1 / ratio)}`;
}

function decimal(value: number) {
  return Number(value.toFixed(9)).toString();
}

/** FFmpeg's volume filter evaluates this expression once per frame. */
export function ffmpegAutomationExpression(points: AutomationPoint[], defaultValue: number) {
  if (!points.length) return decimal(defaultValue);
  const ordered = [...points].sort((left, right) => left.timelineMs - right.timelineMs);
  if (ordered.length === 1) return decimal(evaluateAutomation(ordered, ordered[0].timelineMs, defaultValue));
  const first = ordered[0];
  let expression = decimal(evaluateAutomation(ordered, ordered.at(-1)!.timelineMs, defaultValue));
  for (const segment of automationLinearSegments(ordered).reverse()) {
    const startSeconds = decimal(segment.startMs / 1000);
    const endSeconds = decimal(segment.endMs / 1000);
    const slope = `(${decimal(segment.endValue)}-${decimal(segment.startValue)})*(t-${startSeconds})/(${endSeconds}-${startSeconds})`;
    expression = `if(lt(t\\,${endSeconds})\\,${decimal(segment.startValue)}+${slope}\\,${expression})`;
  }
  return `if(lt(t\\,${decimal(first.timelineMs / 1000)})\\,${decimal(first.value)}\\,${expression})`;
}

/** Equal-power pan is the existing static panning law, expressed per frame. */
export function ffmpegPanGainExpressions(panPoints: AutomationPoint[], staticPan: number, volumeExpression: string) {
  const pan = ffmpegAutomationExpression(panPoints, staticPan);
  return {
    left: `(${volumeExpression})*cos(((${pan})+1)*PI/4)`,
    right: `(${volumeExpression})*sin(((${pan})+1)*PI/4)`,
  };
}

/** Max labels per amerge stage (old ffmpeg caps amerge at 64; stay well under). */
const MERGE_CHUNK = 32;

function panSumLabel(count: number): string {
  const left: string[] = [];
  const right: string[] = [];
  for (let input = 0; input < count; input += 1) {
    left.push(`c${input * 2}`);
    right.push(`c${input * 2 + 1}`);
  }
  return `pan=stereo|c0=${left.join("+")}|c1=${right.join("+")}`;
}

/**
 * Unnormalized stereo sum of N padded stereo streams, as an exact
 * replacement for `amix=...:normalize=0:duration=longest`.
 *
 * The bundled (GPL) ffmpeg 4.1 static build predates amix's `normalize`
 * option, so the desktop renders sums explicitly: each stage amerges up to
 * MERGE_CHUNK stereo streams into 2K channels and pans them down as a plain
 * sum. Inputs must be padded to a common length by the caller (apad), which
 * the export graph does from its computed timeline length.
 */
export function mixSumFilters(labels: string[], outputLabel: string): string[] {
  if (labels.length === 0) throw new Error("Cannot mix zero streams.");
  if (labels.length === 1) return [`${labels[0]}anull[${outputLabel}]`];
  const filters: string[] = [];
  let current = labels;
  let stage = 0;
  while (current.length > 1) {
    const next: string[] = [];
    for (let index = 0; index < current.length; index += MERGE_CHUNK) {
      const chunk = current.slice(index, index + MERGE_CHUNK);
      if (chunk.length === 1) {
        next.push(chunk[0]);
        continue;
      }
      const label = current.length <= MERGE_CHUNK ? outputLabel : `sum${stage}_${next.length}`;
      filters.push(`${chunk.join("")}amerge=inputs=${chunk.length},${panSumLabel(chunk.length)}[${label}]`);
      next.push(`[${label}]`);
    }
    current = next;
    stage += 1;
  }
  return filters;
}

/** Pad a stereo clip stream so it spans the full render timeline. */
export function padToTimeline(sampleRate: number, timelineSamples: number, streamEndMs: number): string {
  const streamSamples = Math.ceil((streamEndMs / 1000) * sampleRate);
  const padSamples = Math.max(0, timelineSamples - streamSamples);
  return `apad=pad_len=${padSamples}`;
}

/** Total render length in samples: the end of the last clip. */
export function timelineSampleCount(clips: readonly { timelineStartMs: number; durationMs: number }[], sampleRate: number): number {
  const endMs = clips.reduce((maximum, clip) => Math.max(maximum, clip.timelineStartMs + clip.durationMs), 0);
  return Math.ceil((endMs / 1000) * sampleRate);
}

/** Track-bus filters keep clip gain/fades separate from track automation. */
export function automatedTrackBusFilters(
  clipLabels: string[],
  trackLabel: string,
  volumePoints: AutomationPoint[],
  panPoints: AutomationPoint[],
  staticVolume: number,
  staticPan: number,
) {
  const volume = ffmpegAutomationExpression(volumePoints, staticVolume);
  const gains = ffmpegPanGainExpressions(panPoints, staticPan, volume);
  const raw = `${trackLabel}raw`;
  const left = `${trackLabel}left`;
  const right = `${trackLabel}right`;
  // The bus mix is an unnormalized sum (the bundled ffmpeg 4.1 predates
  // amix normalize, so mixSumFilters amerge+pans explicitly). Caller pads
  // every clip stream to the render timeline first.
  return [
    ...mixSumFilters(clipLabels, raw),
    `[${raw}]asplit=2[${left}in][${right}in]`,
    `[${left}in]pan=mono|c0=c0,volume='${gains.left}':eval=frame[${left}]`,
    `[${right}in]pan=mono|c0=c1,volume='${gains.right}':eval=frame[${right}]`,
    `[${left}][${right}]join=inputs=2:channel_layout=stereo[${trackLabel}]`,
  ];
}
