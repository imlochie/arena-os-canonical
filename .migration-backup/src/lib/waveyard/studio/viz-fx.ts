/**
 * Post FX + overlays for the sound visualizer — the presentation half of
 * the customization layer. The MATH is pure and tested (letterbox bars,
 * overlay anchors, timecode labels, the Web MIDI maps); the draw helpers
 * consume a 2D context at draw time. Everything degrades to a no-op at
 * strength 0.
 */

import { SCENE_IDS, type SceneId } from "./visualizer";

/** Letterbox bars for a target aspect (e.g. 21/9) — zero-height when the
 * canvas already matches or exceeds the target ratio. */
export function letterboxBars(width: number, height: number, targetRatio: number): { top: number; bottom: number } {
  if (width <= 0 || height <= 0 || targetRatio <= 0) return { top: 0, bottom: 0 };
  const natural = width / height;
  if (natural >= targetRatio) return { top: 0, bottom: 0 };
  const targetHeight = width / targetRatio;
  const bar = (height - targetHeight) / 2;
  return { top: bar, bottom: bar };
}

/** Anchor points for the overlay captions (CSS pixel coordinates). */
export function overlayPositions(width: number, height: number): {
  title: { x: number; y: number };
  caption: { x: number; y: number };
  badge: { x: number; y: number };
  section: { x: number; y: number };
} {
  return {
    title: { x: Math.max(16, width * 0.03), y: Math.max(28, height * 0.09) },
    caption: { x: Math.max(16, width * 0.03), y: height - Math.max(14, height * 0.06) },
    badge: { x: width - Math.max(16, width * 0.03), y: Math.max(28, height * 0.09) },
    section: { x: width / 2, y: Math.max(28, height * 0.09) },
  };
}

/** Seconds → "M:SS" (or "H:MM:SS" past the hour). */
export function timecodeLabel(seconds: number): string {
  const total = Math.max(0, Math.floor(seconds));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const secs = total % 60;
  const two = (value: number) => value.toString().padStart(2, "0");
  return hours > 0 ? `${hours}:${two(minutes)}:${two(secs)}` : `${minutes}:${two(secs)}`;
}

/**
 * Web MIDI map (chromatic): MIDI 48–60 select the thirteen scenes in
 * SCENE_IDS order, 61 returns to Auto. Other notes do nothing.
 */
export function midiNoteToScene(note: number): SceneId | "auto" | null {
  if (note === 61) return "auto";
  if (note < 48 || note > 48 + SCENE_IDS.length - 1) return null;
  return SCENE_IDS[note - 48];
}

/**
 * Web MIDI map (controls): CC 70+i sets stem i's volume (0–127 → 0–1.25).
 * Other controller numbers return null.
 */
export function midiControlToVolume(controller: number, value: number, stemCount: number): { stemIndex: number; volume: number } | null {
  if (controller < 70 || controller >= 70 + Math.max(0, stemCount)) return null;
  const clamped = Math.min(127, Math.max(0, value));
  return { stemIndex: controller - 70, volume: (clamped / 127) * 1.25 };
}

// ------------------------------------------------------------------ drawing

/** Film grain: a pre-baked noise tile stamped at a jittered offset. */
export function drawGrain(ctx: CanvasRenderingContext2D, width: number, height: number, strength: number, tick: number): void {
  if (strength <= 0) return;
  const tile = 160;
  const alpha = Math.min(0.22, strength * 0.2);
  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.globalCompositeOperation = "overlay";
  for (let y = -((tick * 37) % tile); y < height; y += tile) {
    for (let x = -((tick * 53) % tile); x < width; x += tile) {
      // Cheap deterministic speckle per tile.
      const seed = ((x * 31 + y * 17 + tick * 101) >>> 0) % 97;
      ctx.fillStyle = seed % 2 === 0 ? "rgba(255,255,255,0.16)" : "rgba(0,0,0,0.16)";
      ctx.fillRect(x, y, tile, tile);
    }
  }
  ctx.restore();
}

/** Scanlines: dark horizontal rules every 3px. */
export function drawScanlines(ctx: CanvasRenderingContext2D, width: number, height: number, strength: number): void {
  if (strength <= 0) return;
  ctx.save();
  ctx.globalAlpha = Math.min(0.35, strength * 0.32);
  ctx.fillStyle = "rgba(0,0,0,1)";
  for (let y = 0; y < height; y += 3) ctx.fillRect(0, y, width, 1);
  ctx.restore();
}

/** Vignette: radial falloff to the corners. */
export function drawVignette(ctx: CanvasRenderingContext2D, width: number, height: number, strength: number): void {
  if (strength <= 0) return;
  const radius = Math.max(width, height) * 0.75;
  const gradient = ctx.createRadialGradient(width / 2, height / 2, radius * 0.45, width / 2, height / 2, radius);
  gradient.addColorStop(0, "rgba(0,0,0,0)");
  gradient.addColorStop(1, `rgba(0,0,0,${Math.min(0.75, strength * 0.7)})`);
  ctx.save();
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, width, height);
  ctx.restore();
}

/** Letterbox: two black bars (drawn last, over everything). */
export function drawLetterbox(ctx: CanvasRenderingContext2D, width: number, height: number, targetRatio: number): void {
  const { top, bottom } = letterboxBars(width, height, targetRatio);
  if (top <= 0 && bottom <= 0) return;
  ctx.save();
  ctx.fillStyle = "#000";
  if (top > 0) ctx.fillRect(0, 0, width, top);
  if (bottom > 0) ctx.fillRect(0, height - bottom, width, bottom);
  ctx.restore();
}

/**
 * Chromatic aberration: re-composite the offscreen scene twice, tinted and
 * offset in opposite directions (the classic cheap lens split). Requires
 * ctx.filter support — guarded by the caller.
 */
export function drawAberration(
  ctx: CanvasRenderingContext2D,
  scene: HTMLCanvasElement,
  width: number,
  height: number,
  strength: number,
): void {
  if (strength <= 0) return;
  const offset = 2 + strength * 8;
  ctx.save();
  ctx.globalCompositeOperation = "lighter";
  ctx.globalAlpha = Math.min(0.5, strength * 0.45);
  ctx.filter = "sepia(1) saturate(6) hue-rotate(-40deg)";
  ctx.drawImage(scene, -offset, 0, width, height);
  ctx.filter = "sepia(1) saturate(6) hue-rotate(140deg)";
  ctx.drawImage(scene, offset, 0, width, height);
  ctx.filter = "none";
  ctx.restore();
}
