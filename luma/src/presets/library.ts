/**
 * LUMA built-in preset library.
 *
 * These are ORIGINAL recipes authored for LUMA — not copied from, nor claimed to
 * reproduce, any commercial application's processing. They are a photographic
 * *foundation* expressed as editable parameter recipes (see engine/types.ts).
 * Every value is in the engine-agnostic normalised range, so each preset is
 * fully adjustable, dialable via intensity, duplicable, and resettable.
 *
 * Families: Digital, Clean, Film, Black & White, Night.
 *
 * Naming note: these names are working titles and may change. They describe the
 * *character* of the look, not any third-party product.
 */

import { Preset } from '../engine/types';

/**
 * Helper to author presets concisely. Unspecified adjustments default to neutral
 * at render time, so recipes only list the parameters that matter to the look.
 */
function preset(
  id: string,
  name: string,
  family: Preset['family'],
  adjustments: Preset['adjustments'],
  description: string,
  defaultIntensity = 1,
): Preset {
  return {
    id,
    name,
    family,
    adjustments,
    description,
    defaultIntensity,
    builtIn: true,
  };
}

export const BUILT_IN_PRESETS: Preset[] = [
  // ---------------------------------------------------------------- DIGITAL
  // Crisp, punchy, "point-and-shoot" digital character.
  preset(
    'digi',
    'Digi',
    'Digital',
    {
      exposure: -0.05,
      contrast: 0.2,
      saturation: 0.14,
      temperature: 0.05,
      sharpness: 0.35,
      grain: 0.22,
      vignette: 0.1,
    },
    'Crisp, punchy digital point-and-shoot look.',
  ),
  preset(
    'digi-warm',
    'Digi Warm',
    'Digital',
    {
      exposure: 0.03,
      contrast: 0.16,
      saturation: 0.1,
      temperature: 0.22,
      tint: 0.04,
      sharpness: 0.28,
      grain: 0.2,
      vignette: 0.08,
    },
    'Warm golden-hour take on the digital look.',
  ),
  preset(
    'digi-flash',
    'Digi Flash',
    'Digital',
    {
      exposure: 0.18,
      contrast: 0.28,
      highlights: 0.12,
      shadows: -0.08,
      saturation: 0.06,
      temperature: -0.04,
      sharpness: 0.4,
      grain: 0.3,
      vignette: 0.22,
    },
    'Hard, direct-flash party look with deep falloff.',
  ),

  // ------------------------------------------------------------------ CLEAN
  // True-to-life, minimal processing, gentle polish.
  preset(
    'clean',
    'Clean',
    'Clean',
    {
      contrast: 0.06,
      saturation: 0.04,
      sharpness: 0.18,
    },
    'Natural, true-to-life color with a light polish.',
  ),
  preset(
    'clean-warm',
    'Clean Warm',
    'Clean',
    {
      exposure: 0.04,
      contrast: 0.05,
      saturation: 0.05,
      temperature: 0.14,
      sharpness: 0.15,
    },
    'Clean tones with a soft, inviting warmth.',
  ),
  preset(
    'clean-soft',
    'Clean Soft',
    'Clean',
    {
      exposure: 0.06,
      contrast: -0.08,
      shadows: 0.14,
      saturation: -0.02,
      fade: 0.12,
      sharpness: 0.08,
    },
    'Airy, low-contrast softness for portraits.',
  ),

  // ------------------------------------------------------------------- FILM
  // Analog character: lifted blacks, restrained saturation, grain.
  preset(
    'soft-film',
    'Soft Film',
    'Film',
    {
      exposure: 0.03,
      contrast: -0.05,
      shadows: 0.18,
      saturation: -0.06,
      temperature: 0.08,
      grain: 0.4,
      fade: 0.22,
      vignette: 0.1,
    },
    'Gentle analog film with lifted, matte shadows.',
  ),
  preset(
    'warm-film',
    'Warm Film',
    'Film',
    {
      exposure: 0.02,
      contrast: 0.02,
      shadows: 0.12,
      saturation: 0.02,
      temperature: 0.2,
      tint: 0.06,
      grain: 0.42,
      fade: 0.16,
      vignette: 0.12,
    },
    'Sun-warmed film stock with amber shadows.',
  ),
  preset(
    'faded-film',
    'Faded Film',
    'Film',
    {
      exposure: 0.05,
      contrast: -0.12,
      highlights: -0.08,
      shadows: 0.24,
      saturation: -0.14,
      temperature: 0.06,
      grain: 0.5,
      fade: 0.4,
      vignette: 0.08,
    },
    'Washed-out vintage film with heavy fade.',
  ),

  // ------------------------------------------------------------ BLACK & WHITE
  preset(
    'bw-classic',
    'Classic B&W',
    'Black & White',
    {
      contrast: 0.12,
      saturation: -1,
      shadows: 0.06,
      grain: 0.3,
      sharpness: 0.2,
    },
    'Balanced monochrome with a full tonal range.',
  ),
  preset(
    'bw-high-contrast',
    'High Contrast B&W',
    'Black & White',
    {
      contrast: 0.42,
      saturation: -1,
      highlights: 0.1,
      shadows: -0.12,
      grain: 0.36,
      sharpness: 0.3,
      vignette: 0.16,
    },
    'Bold, graphic monochrome with crushed blacks.',
  ),

  // ------------------------------------------------------------------ NIGHT
  preset(
    'night-flash',
    'Night Flash',
    'Night',
    {
      exposure: 0.12,
      contrast: 0.24,
      highlights: 0.08,
      shadows: -0.16,
      saturation: 0.08,
      temperature: -0.1,
      sharpness: 0.34,
      grain: 0.32,
      vignette: 0.3,
    },
    'Cool, high-contrast direct flash in the dark.',
  ),
  preset(
    'night-grain',
    'Night Grain',
    'Night',
    {
      exposure: 0.16,
      contrast: 0.1,
      shadows: 0.2,
      saturation: -0.04,
      temperature: -0.06,
      grain: 0.62,
      fade: 0.14,
      vignette: 0.24,
    },
    'Moody low-light grain with lifted shadows.',
  ),
];

/** Map for O(1) lookup by id. */
export const BUILT_IN_PRESET_MAP: Record<string, Preset> = Object.fromEntries(
  BUILT_IN_PRESETS.map((p) => [p.id, p]),
);

export function getBuiltInPreset(id: string): Preset | undefined {
  return BUILT_IN_PRESET_MAP[id];
}
