/**
 * Palette extraction tests — synthetic RGBA images with known dominant
 * colors verify the bucketing, the vividness filter, and the deterministic
 * stem mapping.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { extractPalette, hsvToHex, paletteColorFor, rgbToHsv } from "./palette";

/** A solid-color RGBA image of n pixels. */
function solid(r: number, g: number, b: number, count = 64): Uint8Array {
  const pixels = new Uint8Array(count * 4);
  for (let i = 0; i < count * 4; i += 4) {
    pixels[i] = r;
    pixels[i + 1] = g;
    pixels[i + 2] = b;
    pixels[i + 3] = 255;
  }
  return pixels;
}

test("color space conversions round-trip", () => {
  const hex = hsvToHex(210, 0.8, 0.9);
  const back = rgbToHsv(parseInt(hex.slice(1, 3), 16), parseInt(hex.slice(3, 5), 16), parseInt(hex.slice(5, 7), 16));
  assert.ok(Math.abs(back.h - 210) < 2, `hue round-trips (${back.h})`);
  assert.ok(Math.abs(back.s - 0.8) < 0.02, "saturation round-trips");
  assert.ok(Math.abs(back.v - 0.9) < 0.02, "value round-trips");
});

test("a vivid image yields its color, lifted to visible lightness", () => {
  const palette = extractPalette(solid(220, 30, 40)); // a red
  assert.equal(palette.length, 1, "one dominant bucket");
  const [r, g, b] = [parseInt(palette[0].slice(1, 3), 16), parseInt(palette[0].slice(3, 5), 16), parseInt(palette[0].slice(5, 7), 16)];
  assert.ok(r > g + 60 && r > b + 60, "the color is still red");
  const { v } = rgbToHsv(r, g, b);
  assert.ok(v >= 0.62, `dark covers are lifted for the dark canvas (${v})`);
});

test("washed-out and monochrome images fall back honestly", () => {
  assert.deepEqual(extractPalette(solid(128, 128, 128)), [], "grey has no vivid color");
  assert.deepEqual(extractPalette(solid(250, 250, 250)), [], "glare is rejected");
  assert.deepEqual(extractPalette(solid(5, 5, 8)), [], "mud is rejected");
  assert.deepEqual(extractPalette(new Uint8Array(0)), [], "no pixels, no palette");
  const transparent = new Uint8Array(64 * 4); // alpha 0
  assert.deepEqual(extractPalette(transparent), [], "transparent pixels are skipped");
});

test("multi-color images rank by weighted dominance", () => {
  // 3/4 teal, 1/4 orange.
  const pixels = new Uint8Array(64 * 4);
  for (let i = 0; i < 64; i += 1) {
    const teal = i < 48;
    pixels[i * 4] = teal ? 20 : 235;
    pixels[i * 4 + 1] = teal ? 200 : 120;
    pixels[i * 4 + 2] = teal ? 210 : 45;
    pixels[i * 4 + 3] = 255;
  }
  const palette = extractPalette(pixels, 2);
  assert.equal(palette.length, 2, "both hues surface");
  const [r, g, b] = [parseInt(palette[0].slice(1, 3), 16), parseInt(palette[0].slice(3, 5), 16), parseInt(palette[0].slice(5, 7), 16)];
  assert.ok(g > r && g > b - 40 && b > r, `teal dominates (${palette[0]})`);
});

test("the stem mapping is deterministic and falls back when empty", () => {
  const pick = paletteColorFor(["#ff0000", "#00ff00"], () => "#111111");
  assert.equal(pick("vocals"), pick("vocals"), "same stem → same color");
  assert.ok(["#ff0000", "#00ff00"].includes(pick("vocals")), "picks from the palette");
  const fallback = paletteColorFor([], () => "#111111");
  assert.equal(fallback("vocals"), "#111111", "empty palette → fallback");
  // Distinct stems are spread across the palette (both entries used).
  const picks = new Set(["vocals", "drums", "bass", "other"].map((stem) => pick(stem)));
  assert.equal(picks.size, 2, "both palette entries are used");
});
