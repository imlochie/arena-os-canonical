// Client-safe barrel for the Cut Lab component.
// Everything here is safe to import from a browser component (no server deps).

export {
  ASPECT_DIMS,
  buildTimeline,
  clampTime,
  clipLength,
  CUT_PALETTES,
  fmtTime,
  mulberry32,
  newClipId,
  segmentAt,
} from "./types";
export type { CutAspect, CutClip, CutClipKind, CutProject, TimelineSegment } from "./types";

export { createMediaPool as createMediaPoolSafe, driveMediaAt, preloadPool as preloadPoolSafe, probeDuration as probeDurationSafe, renderFrame as renderFrameSafe } from "./render";
