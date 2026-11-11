import { clipFadeShapeOrLinear, fadeGainAt } from "./fades";
import { evaluateAutomation, type RemixAutomationLane } from "./types/arrangement-automation";

export type ArrangementPreviewGainClip = {
  gain: number;
  durationMs: number;
  fadeInMs: number;
  fadeOutMs: number;
  fadeShape?: unknown;
};

/**
 * Sample the exact effective gain curve used by Studio's browser preview:
 * absolute track-volume automation × clip gain × the persisted clip fades.
 */
export function arrangementPreviewGainCurve(input: {
  trackId: string;
  trackVolume: number;
  automation?: RemixAutomationLane[];
  clip: ArrangementPreviewGainClip;
  clipElapsedMs: number;
  timelineStartMs: number;
  durationMs: number;
  samples?: number;
}): Float32Array {
  const count = Math.max(2, Math.floor(input.samples ?? 33));
  const volumePoints = input.automation?.find(
    (lane) => lane.remixTrackId === input.trackId && lane.parameter === "volume",
  )?.points ?? [];
  const fadeShape = clipFadeShapeOrLinear(input.clip.fadeShape);
  const curve = new Float32Array(count);
  for (let index = 0; index < count; index += 1) {
    const fraction = index / (count - 1);
    const clipOffsetMs = input.clipElapsedMs + input.durationMs * fraction;
    const timelineMs = input.timelineStartMs + input.durationMs * fraction;
    let clipLevel = 1;
    if (input.clip.fadeInMs > 0 && clipOffsetMs < input.clip.fadeInMs) {
      clipLevel = fadeGainAt(fadeShape, clipOffsetMs / input.clip.fadeInMs);
    } else {
      const fadeOutStartMs = input.clip.durationMs - input.clip.fadeOutMs;
      if (input.clip.fadeOutMs > 0 && clipOffsetMs > fadeOutStartMs) {
        clipLevel = fadeGainAt(fadeShape, (input.clip.durationMs - clipOffsetMs) / input.clip.fadeOutMs);
      }
    }
    const trackVolume = evaluateAutomation(volumePoints, timelineMs, input.trackVolume);
    curve[index] = trackVolume * input.clip.gain * clipLevel;
  }
  return curve;
}

export function hasArrangementVolumeAutomation(
  automation: RemixAutomationLane[] | undefined,
  trackId: string,
) {
  return automation?.some(
    (lane) => lane.remixTrackId === trackId && lane.parameter === "volume" && lane.points.length > 0,
  ) ?? false;
}
