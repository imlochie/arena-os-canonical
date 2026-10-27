// Cut Lab — types + pure timeline math.
//
// An OpenCut-inspired lightweight video editor that runs entirely in the
// browser (canvas compositor + Web Audio + MediaRecorder export). Zero
// dependencies, zero egress — same local-first contract as the rest of the app.
// See CUT.md and REFERENCES.md (video editing section) for the heavyweight
// companion: OpenCut (MIT) at https://github.com/OpenCut-app/OpenCut

export type CutAspect = "16:9" | "9:16" | "1:1";

export const ASPECT_DIMS: Record<CutAspect, { w: number; h: number }> = {
  "16:9": { w: 1280, h: 720 },
  "9:16": { w: 720, h: 1280 },
  "1:1": { w: 960, h: 960 },
};

export type CutClipKind = "video" | "image" | "procedural";

export interface CutClip {
  id: string;
  name: string;
  kind: CutClipKind;
  // video/image: URL to load (same-origin proxy path, http(s) URL, or blob:)
  src?: string;
  // procedural clips render from a seeded generator (no source needed)
  seed?: number;
  // source length in seconds (video: measured from metadata; image: chosen)
  duration: number;
  // in/out points into the source (seconds)
  trimStart: number;
  trimEnd: number;
  volume: number; // 0..1 (video clips with audio)
  // set when a saved project references a blob: URL that no longer exists
  unlinked?: boolean;
}

export interface CutProject {
  id: string | null;
  title: string;
  aspect: CutAspect;
  clips: CutClip[];
  createdAt?: string;
  updatedAt?: string;
}

// ---- timeline math (pure) ----

export interface TimelineSegment {
  clip: CutClip;
  index: number;
  start: number; // timeline start (s)
  end: number; // timeline end (s)
  localStart: number; // = clip.trimStart
}

export function clipLength(c: CutClip): number {
  const end = Math.min(c.trimEnd, c.duration);
  const start = Math.min(c.trimStart, end);
  return Math.max(0, end - start);
}

export function buildTimeline(clips: CutClip[]): { segments: TimelineSegment[]; duration: number } {
  const segments: TimelineSegment[] = [];
  let t = 0;
  clips.forEach((clip, index) => {
    const len = clipLength(clip);
    if (len > 0.01) {
      segments.push({ clip, index, start: t, end: t + len, localStart: clip.trimStart });
      t += len;
    }
  });
  return { segments, duration: t };
}

export function segmentAt(segments: TimelineSegment[], time: number): TimelineSegment | null {
  if (!segments.length) return null;
  if (time < 0) return segments[0];
  for (const s of segments) {
    if (time >= s.start && time < s.end) return s;
  }
  return segments[segments.length - 1];
}

export function clampTime(segments: TimelineSegment[], time: number): number {
  const last = segments[segments.length - 1];
  const max = last ? last.end : 0;
  return Math.max(0, Math.min(time, max));
}

export function newClipId(): string {
  return `c${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

export function fmtTime(t: number): string {
  const s = Math.max(0, t);
  const m = Math.floor(s / 60);
  const sec = Math.floor(s % 60);
  const cs = Math.floor((s % 1) * 100);
  return `${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")}.${String(cs).padStart(2, "0")}`;
}

// Procedural palette (shared with the Studio demo engine aesthetics)
export const CUT_PALETTES = [
  ["#0ea5e9", "#6366f1", "#a855f7", "#22d3ee"],
  ["#f97316", "#ef4444", "#f59e0b", "#fb7185"],
  ["#10b981", "#14b8a6", "#22c55e", "#84cc16"],
  ["#8b5cf6", "#d946ef", "#6366f1", "#f472b6"],
];

export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
