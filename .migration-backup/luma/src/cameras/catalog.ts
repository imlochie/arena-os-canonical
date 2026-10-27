/**
 * Camera catalog — the *product* layer on top of the preset engine.
 *
 * Product thesis (inspired by, not copied from, "five cameras / five looks"
 * apps): the user doesn't pick a filter, they pick a **camera**. Each camera has
 * a personality — a number, a name, a one-line mood — and a lead "look" plus a
 * few variants.
 *
 * IMPORTANT ARCHITECTURE NOTE:
 *   This is presentation/identity only. Internally everything is still a
 *   `Preset` recipe fed through the `ProcessingEngine`. A Camera simply groups
 *   existing preset ids from a family and adds identity + a viewfinder hint.
 *   The engine, recipes, projects, and persistence are unchanged — so this
 *   reframe adds zero risk to the core.
 *
 * `hint` is a CHEAP approximation used to tint the live viewfinder so it "feels"
 * like the selected camera. It is NOT real grading — true live processing needs
 * a native frame processor (the top roadmap item). The real look is applied,
 * non-destructively, from the recipe the moment a photo is captured.
 */

import { PresetFamily } from '../engine/types';

export interface CameraHint {
  /** Translucent color wash over the viewfinder (rgba string). */
  tint: string;
  /** Vignette strength hint [0,1]. */
  vignette: number;
  /** Cameras whose real look is monochrome; surfaced in copy since a color
   *  overlay can't desaturate a live RN camera feed without a frame processor. */
  mono: boolean;
}

export interface Camera {
  id: string;
  /** Display number, e.g. "01". */
  number: string;
  /** User-facing camera name (original to LUMA). */
  name: string;
  /** One-line mood / when-to-use. */
  tagline: string;
  /** The underlying preset family this camera draws from. */
  family: PresetFamily;
  /** Ordered preset ids that make up this camera's selectable "looks". */
  lookIds: string[];
  /** The lead look applied by default when shooting with this camera. */
  defaultLookId: string;
  /** Viewfinder identity hint. */
  hint: CameraHint;
}

export const CAMERAS: Camera[] = [
  {
    id: 'digicam',
    number: '01',
    name: 'DigiCam',
    tagline: 'Punchy point & shoot',
    family: 'Digital',
    lookIds: ['digi-x', 'digi', 'digi-flash'],
    defaultLookId: 'digi-x',
    hint: { tint: 'rgba(255,178,84,0.10)', vignette: 0.2, mono: false },
  },
  {
    id: 'clean',
    number: '02',
    name: 'Clean',
    tagline: 'Soft & true to life',
    family: 'Clean',
    lookIds: ['clean-girl', 'digi-lite', 'clean-soft'],
    defaultLookId: 'clean-girl',
    hint: { tint: 'rgba(255,241,224,0.05)', vignette: 0.08, mono: false },
  },
  {
    id: 'filmbox',
    number: '03',
    name: 'FilmBox',
    tagline: 'Analog & faded',
    family: 'Film',
    lookIds: ['gold-n', 'digi-s', 'warm-film'],
    defaultLookId: 'gold-n',
    hint: { tint: 'rgba(206,172,120,0.14)', vignette: 0.26, mono: false },
  },
  {
    id: 'mono',
    number: '04',
    name: 'Mono',
    tagline: 'Timeless monochrome',
    family: 'Black & White',
    lookIds: ['bw', 'bw-classic'],
    defaultLookId: 'bw',
    hint: { tint: 'rgba(232,232,236,0.06)', vignette: 0.3, mono: true },
  },
  {
    id: 'nox',
    number: '05',
    name: 'Nox',
    tagline: 'After dark',
    family: 'Night',
    lookIds: ['red-light', 'night-flash', 'night-grain'],
    defaultLookId: 'red-light',
    hint: { tint: 'rgba(64,96,168,0.14)', vignette: 0.34, mono: false },
  },
];

export const CAMERA_MAP: Record<string, Camera> = Object.fromEntries(
  CAMERAS.map((c) => [c.id, c]),
);

export function getCamera(id: string | null | undefined): Camera | undefined {
  if (!id) return undefined;
  return CAMERA_MAP[id];
}

/** The camera whose family owns a given preset id (for editor context). */
export function cameraForPresetId(presetId: string | null): Camera | undefined {
  if (!presetId) return undefined;
  return CAMERAS.find((c) => c.lookIds.includes(presetId));
}

export const DEFAULT_CAMERA_ID = 'clean';
