/**
 * Cover-palette extraction — "the visualizer dresses in the album's
 * colors" (vision §V4 customization layer). Pure pixel math: an image's
 * pixels are bucketed in HSV, vivid mid-lightness colors are weighted by
 * saturation, and the strongest few become the stem palette. No canvas
 * dependency — the component downsamples the cover and hands over its
 * RGBA bytes.
 */

import { hashSeed } from "./ab-compare";

/** #rrggbb for an r,g,b triple. */
function hex(r: number, g: number, b: number): string {
  const to = (value: number) => Math.round(Math.min(255, Math.max(0, value))).toString(16).padStart(2, "0");
  return `#${to(r)}${to(g)}${to(b)}`;
}

/** RGB (0–255) → HSV (h 0–360, s/v 0–1). */
export function rgbToHsv(r: number, g: number, b: number): { h: number; s: number; v: number } {
  const rn = r / 255;
  const gn = g / 255;
  const bn = b / 255;
  const max = Math.max(rn, gn, bn);
  const min = Math.min(rn, gn, bn);
  const d = max - min;
  let h = 0;
  if (d > 0) {
    if (max === rn) h = ((gn - bn) / d) % 6;
    else if (max === gn) h = (bn - rn) / d + 2;
    else h = (rn - gn) / d + 4;
    h *= 60;
    if (h < 0) h += 360;
  }
  return { h, s: max > 0 ? d / max : 0, v: max };
}

/** HSV (h 0–360, s/v 0–1) → #rrggbb. */
export function hsvToHex(h: number, s: number, v: number): string {
  const hn = ((h % 360) + 360) % 360 / 60;
  const i = Math.floor(hn);
  const f = hn - i;
  const p = v * (1 - s);
  const q = v * (1 - f * s);
  const t = v * (1 - (1 - f) * s);
  const [r, g, b] = i % 6 === 0 ? [v, t, p] : i % 6 === 1 ? [q, v, p] : i % 6 === 2 ? [p, v, t] : i % 6 === 3 ? [p, q, v] : i % 6 === 4 ? [t, p, v] : [v, p, q];
  return hex(r * 255, g * 255, b * 255);
}

const MIN_SATURATION = 0.28;
const HUE_BUCKETS = 24;

/**
 * Extract up to `max` dominant colors from RGBA pixels. Colors must be
 * vivid (saturation ≥ 0.28) and neither mud nor glare; winners are returned
 * lightened to v ≥ 0.62 so they read on a dark canvas. An image with no
 * vivid color returns [] (the caller falls back to the studio palette).
 */
export function extractPalette(pixels: Uint8ClampedArray | Uint8Array, max = 5): string[] {
  if (pixels.length < 4) return [];
  const buckets = new Map<number, { weight: number; h: number; s: number; v: number }>();
  const step = Math.max(4, Math.floor(pixels.length / 4 / 4000) * 4); // sample ≈4000 pixels
  for (let i = 0; i + 3 < pixels.length; i += step) {
    const alpha = pixels[i + 3];
    if (alpha < 128) continue;
    const { h, s, v } = rgbToHsv(pixels[i], pixels[i + 1], pixels[i + 2]);
    if (s < MIN_SATURATION || v < 0.14 || v > 0.96) continue;
    const bucket = Math.floor(h / (360 / HUE_BUCKETS));
    const current = buckets.get(bucket) ?? { weight: 0, h: 0, s: 0, v: 0 };
    const weight = s * (0.4 + v * 0.6);
    buckets.set(bucket, {
      weight: current.weight + weight,
      h: (current.h * current.weight + h * weight) / (current.weight + weight),
      s: (current.s * current.weight + s * weight) / (current.weight + weight),
      v: (current.v * current.weight + v * weight) / (current.weight + weight),
    });
  }
  return [...buckets.values()]
    .sort((a, b) => b.weight - a.weight)
    .slice(0, max)
    .map((bucket) => hsvToHex(bucket.h, Math.min(0.92, bucket.s), Math.min(0.92, Math.max(0.62, bucket.v))));
}

/**
 * A stem-color lookup over a custom palette: each stem type deterministically
 * picks a palette entry (hash-stable, so lanes don't swap colors between
 * frames). Falls back to the studio palette when the custom set is empty.
 */
export function paletteColorFor(palette: readonly string[], fallback: (stemType: string) => string): (stemType: string) => string {
  if (palette.length === 0) return fallback;
  return (stemType: string) => palette[hashSeed(stemType) % palette.length];
}
