/**
 * A//B comparison — the showcase surface for remixes (vision: "an a // b
 * comparison with album covers and audiovisual comparisons to showcase
 * remixes aesthetically on youtube").
 *
 * Pure, client-safe, deterministic. Four pieces:
 *
 *  parseId3Artwork     — real album covers: embedded ID3v2 APIC artwork out
 *                        of an MP3's leading bytes (v2.3 + v2.4). No external
 *                        assets, no network — the cover ships with the song.
 *  proceduralCoverSpec — when a file has no embedded art: a deterministic
 *                        generative cover (seeded geometry + palette from
 *                        the track's identity) — always available, on-brand.
 *  equalPowerCrossfade — the split divider's gain law (constant power).
 *  buildShowcasePlan   — the YouTube timeline: A solo → crossfade → B solo,
 *                        with labels and per-phase divider targets, used to
 *                        drive both playback and the recorded video.
 *
 * The component (CompareAB.tsx) is the skin: it fetches the audio, draws
 * the covers, runs the split-screen visualizer, and records it to a video.
 */

// ---------------------------------------------------------------- ID3 covers

export type EmbeddedArtwork = { mime: string; data: Uint8Array };

function syncsafe(bytes: Uint8Array, offset: number): number {
  return ((bytes[offset] & 0x7f) << 21) | ((bytes[offset + 1] & 0x7f) << 14) | ((bytes[offset + 2] & 0x7f) << 7) | (bytes[offset + 3] & 0x7f);
}

function plainUint32(bytes: Uint8Array, offset: number): number {
  return (bytes[offset] << 24) | (bytes[offset + 1] << 16) | (bytes[offset + 2] << 8) | bytes[offset + 3];
}

/**
 * Extract the first APIC (attached picture) from an MP3's ID3v2 tag.
 * Supports v2.3 and v2.4 frame layout; v2.2 (3-letter "PIC") is honestly
 * rejected. Returns null for anything else — the caller falls back to the
 * generative cover.
 */
export function parseId3Artwork(bytes: Uint8Array): EmbeddedArtwork | null {
  if (bytes.length < 20) return null;
  if (bytes[0] !== 0x49 || bytes[1] !== 0x44 || bytes[2] !== 0x33) return null; // "ID3"
  const major = bytes[3];
  if (major !== 3 && major !== 4) return null;
  const tagSize = syncsafe(bytes, 6);
  const tagEnd = Math.min(bytes.length, 10 + tagSize);

  let offset = 10;
  while (offset + 10 <= tagEnd) {
    const frameId = String.fromCharCode(bytes[offset], bytes[offset + 1], bytes[offset + 2], bytes[offset + 3]);
    // Padding / end of frames.
    if (!/^[A-Z0-9]{4}$/.test(frameId)) break;
    const frameSize = major === 4 ? syncsafe(bytes, offset + 4) : plainUint32(bytes, offset + 4);
    if (frameSize <= 0 || offset + 10 + frameSize > tagEnd) break;
    if (frameId === "APIC") {
      const frame = bytes.subarray(offset + 10, offset + 10 + frameSize);
      const parsed = parseApicFrame(frame);
      if (parsed !== null) return parsed;
    }
    offset += 10 + frameSize;
  }
  return null;
}

function parseApicFrame(frame: Uint8Array): EmbeddedArtwork | null {
  if (frame.length < 4) return null;
  let cursor = 0;
  const encoding = frame[cursor]; // 0 latin1, 1 utf16, 2 utf16be, 3 utf8
  cursor += 1;

  // MIME: null-terminated latin-1.
  let mimeEnd = cursor;
  while (mimeEnd < frame.length && frame[mimeEnd] !== 0) mimeEnd += 1;
  if (mimeEnd >= frame.length) return null;
  const mime = String.fromCharCode(...frame.subarray(cursor, mimeEnd));
  cursor = mimeEnd + 1;

  cursor += 1; // picture type

  // Description: null-terminated in the declared encoding.
  if (encoding === 1 || encoding === 2) {
    while (cursor + 1 < frame.length && !(frame[cursor] === 0 && frame[cursor + 1] === 0)) cursor += 2;
    cursor += 2;
  } else {
    while (cursor < frame.length && frame[cursor] !== 0) cursor += 1;
    cursor += 1;
  }
  if (cursor >= frame.length) return null;

  const data = frame.subarray(cursor);
  if (data.length < 64) return null; // not a real image
  const mimeLower = mime.toLowerCase();
  const known = ["image/jpeg", "image/jpg", "image/png", "image/gif", "image/webp", "image/bmp"];
  return { mime: known.includes(mimeLower) ? mimeLower : "image/jpeg", data: new Uint8Array(data) };
}

// ------------------------------------------------------ generative covers

export type CoverShape = {
  kind: "circle" | "ring" | "bar" | "triangle";
  x: number;
  y: number;
  size: number;
  rotation: number;
  hue: number;
  alpha: number;
};

export type CoverSpec = {
  /** Background hue (hsl). */
  backgroundHue: number;
  shapes: CoverShape[];
  title: string;
  subtitle: string;
};

function seededRandom(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Stable string → 32-bit seed (FNV-1a). */
// ------------------------------------------------------------------ helix
// The DNA view of the A//B: two strands (the two tracks) wound around one
// axis, beats building the rungs between them. Where the tracks agree, the
// rungs glow — mashup proof made visible.

/** A strand's height at `t` (0–1 across the view), −1…1. */
export function helixY(t: number, turns: number, rotation: number, phase: number): number {
  return Math.sin(t * turns * Math.PI * 2 + rotation + phase);
}

/**
 * Rung glow from the two sides' levels: 1 when they match in energy, 0 when
 * only one side is sounding. This is the "they lock here" signal.
 */
export function helixRungGlow(rmsA: number, rmsB: number): number {
  const a = Math.max(0, Math.min(1, Number.isFinite(rmsA) ? rmsA : 0));
  const b = Math.max(0, Math.min(1, Number.isFinite(rmsB) ? rmsB : 0));
  const similarity = 1 - Math.abs(a - b);
  return Math.max(0, similarity * Math.min(1, (a + b) * 2));
}

/** Strand breathing: louder music swells the helix (0.16–0.5 of half-height). */
export function helixAmplitude(rmsA: number, rmsB: number): number {
  const a = Math.max(0, Math.min(1, Number.isFinite(rmsA) ? rmsA : 0));
  const b = Math.max(0, Math.min(1, Number.isFinite(rmsB) ? rmsB : 0));
  return 0.16 + Math.min(1, (a + b) / 2) * 0.34;
}

export function hashSeed(input: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i += 1) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

/**
 * A deterministic generative album cover: concentric geometry on a duotone
 * field, seeded by the track's identity. Same track → same cover, forever —
 * the artwork IS the audio's fingerprint.
 */
export function proceduralCoverSpec(seed: string, title: string, subtitle: string): CoverSpec {
  const random = seededRandom(hashSeed(seed));
  const backgroundHue = Math.floor(random() * 360);
  const shapeCount = 9 + Math.floor(random() * 8);
  const shapes: CoverShape[] = [];
  for (let index = 0; index < shapeCount; index += 1) {
    const kinds: CoverShape["kind"][] = ["circle", "ring", "bar", "triangle"];
    shapes.push({
      kind: kinds[Math.floor(random() * kinds.length)],
      x: 0.1 + random() * 0.8,
      y: 0.1 + random() * 0.8,
      size: 0.08 + random() * 0.34,
      rotation: random() * Math.PI * 2,
      hue: (backgroundHue + 120 + Math.floor(random() * 120)) % 360,
      alpha: 0.25 + random() * 0.6,
    });
  }
  return { backgroundHue, shapes, title, subtitle };
}

// ------------------------------------------------------------- crossfade

/** Equal-power crossfade gains at divider position d ∈ [0,1]:
 *  d=0 → pure A, d=1 → pure B, d=0.5 → both at −3 dB (constant power).
 *  An indeterminate value (NaN) falls to PURE A — the conservative default
 *  is hearing the original, not a coin flip. */
export function equalPowerCrossfade(d: number): { a: number; b: number } {
  const clamped = Number.isFinite(d) ? Math.max(0, Math.min(1, d)) : 0;
  if (clamped <= 0) return { a: 1, b: 0 };
  if (clamped >= 1) return { a: 0, b: 1 };
  const angle = (clamped * Math.PI) / 2;
  return { a: Math.cos(angle), b: Math.sin(angle) };
}

// ---------------------------------------------------------- showcase plan

export type ShowcasePhase = {
  phase: "a" | "crossfade" | "b";
  startMs: number;
  endMs: number;
  /** Divider target at this phase's END (a: 0, b: 1; crossfade ramps). */
  endDivider: number;
  /** The label to feature (side A's or side B's track). */
  feature: "a" | "b" | "both";
};

export type ShowcasePlan = {
  phases: ShowcasePhase[];
  totalMs: number;
};

export type ShowcaseOptions = {
  /** Solo-A lead-in (default 4000). */
  aMs?: number;
  /** Crossfade length (default 3000). */
  crossfadeMs?: number;
  /** Solo-B outro (default 4000). */
  bMs?: number;
};

/** The YouTube timeline: A solo → live crossfade → B solo. Deterministic. */
export function buildShowcasePlan(options: ShowcaseOptions = {}): ShowcasePlan {
  const aMs = Math.max(500, Math.min(30_000, options.aMs ?? 4000));
  const crossfadeMs = Math.max(250, Math.min(30_000, options.crossfadeMs ?? 3000));
  const bMs = Math.max(500, Math.min(30_000, options.bMs ?? 4000));
  return {
    phases: [
      { phase: "a", startMs: 0, endMs: aMs, endDivider: 0, feature: "a" },
      { phase: "crossfade", startMs: aMs, endMs: aMs + crossfadeMs, endDivider: 1, feature: "both" },
      { phase: "b", startMs: aMs + crossfadeMs, endMs: aMs + crossfadeMs + bMs, endDivider: 1, feature: "b" },
    ],
    totalMs: aMs + crossfadeMs + bMs,
  };
}

/** Divider position at time t within the plan (linear ramp in the middle). */
export function showcaseDividerAt(plan: ShowcasePlan, tMs: number): number {
  const crossfade = plan.phases.find((phase) => phase.phase === "crossfade");
  if (crossfade === undefined) return tMs <= plan.phases[0].endMs ? 0 : 1;
  if (tMs <= crossfade.startMs) return 0;
  if (tMs >= crossfade.endMs) return 1;
  return (tMs - crossfade.startMs) / (crossfade.endMs - crossfade.startMs);
}
