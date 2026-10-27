/**
 * LUMA core data model.
 *
 * These types define the *non-destructive* editing contract for the whole app.
 * Everything downstream (preview renderer, export renderer, presets, projects,
 * persistence, tests) is built on top of these shapes.
 *
 * Design principles:
 *  - An edit is DATA, never a baked pixel buffer. A rendered image is always a
 *    pure function of (sourceImage, EditRecipe).
 *  - The `Adjustments` object is a flat, serialisable bag of scalar parameters,
 *    each in a well-defined, engine-independent range. This keeps presets,
 *    persistence, and tests simple and forward-compatible.
 *  - Advanced image "character" (curves, HSL, halation, chromatic aberration,
 *    masks, etc.) is intentionally NOT implemented in V1, but the schema is
 *    structured (see `AdvancedEffects`) so those can be added later without a
 *    migration of existing projects.
 */

/**
 * Flat scalar adjustment parameters.
 *
 * Ranges are normalised and engine-agnostic:
 *  - Most sliders are bipolar in [-1, 1] where 0 == no change.
 *  - `exposure` is in stops, roughly [-2, 2].
 *  - `grain`, `vignette`, `fade`, `sharpness`, `bloom` are unipolar in [0, 1].
 *
 * The processing engine is responsible for mapping these normalised values into
 * whatever units its underlying implementation needs (color matrices in V1,
 * Core Image / Metal later). The UI and presets only ever speak in this range.
 */
export interface Adjustments {
  /** Exposure in stops. 0 = unchanged. Practical range [-2, 2]. */
  exposure: number;
  /** Global contrast. [-1, 1], 0 = unchanged. */
  contrast: number;
  /** Recover/blow highlights. [-1, 1], negative recovers, positive lifts. */
  highlights: number;
  /** Lift/crush shadows. [-1, 1], positive lifts shadows (matte look). */
  shadows: number;
  /** White balance warmth. [-1, 1], positive = warmer (amber). */
  temperature: number;
  /** White balance tint. [-1, 1], positive = magenta, negative = green. */
  tint: number;
  /** Global saturation. [-1, 1], -1 = greyscale, 0 = unchanged. */
  saturation: number;
  /** Vibrance-ish overall punch handled via saturation for V1. */
  /** Output sharpening amount. [0, 1]. */
  sharpness: number;
  /** Film grain intensity. [0, 1]. */
  grain: number;
  /** Vignette darkening strength. [0, 1]. */
  vignette: number;
  /** Faded / lifted-black matte amount. [0, 1]. */
  fade: number;
}

/** The keys of every adjustment, useful for iteration in UI and tests. */
export const ADJUSTMENT_KEYS: (keyof Adjustments)[] = [
  'exposure',
  'contrast',
  'highlights',
  'shadows',
  'temperature',
  'tint',
  'saturation',
  'sharpness',
  'grain',
  'vignette',
  'fade',
];

/** The neutral (no-op) adjustment set. */
export const NEUTRAL_ADJUSTMENTS: Adjustments = {
  exposure: 0,
  contrast: 0,
  highlights: 0,
  shadows: 0,
  temperature: 0,
  tint: 0,
  saturation: 0,
  sharpness: 0,
  grain: 0,
  vignette: 0,
  fade: 0,
};

/**
 * Metadata describing the valid range + step of each adjustment, consumed by
 * both the slider UI and validation/clamping logic. Single source of truth.
 */
export interface AdjustmentSpec {
  key: keyof Adjustments;
  label: string;
  min: number;
  max: number;
  step: number;
  /** true = 0 is the neutral center (bipolar slider). */
  bipolar: boolean;
}

export const ADJUSTMENT_SPECS: Record<keyof Adjustments, AdjustmentSpec> = {
  exposure: { key: 'exposure', label: 'Exposure', min: -2, max: 2, step: 0.01, bipolar: true },
  contrast: { key: 'contrast', label: 'Contrast', min: -1, max: 1, step: 0.01, bipolar: true },
  highlights: { key: 'highlights', label: 'Highlights', min: -1, max: 1, step: 0.01, bipolar: true },
  shadows: { key: 'shadows', label: 'Shadows', min: -1, max: 1, step: 0.01, bipolar: true },
  temperature: { key: 'temperature', label: 'Temp', min: -1, max: 1, step: 0.01, bipolar: true },
  tint: { key: 'tint', label: 'Tint', min: -1, max: 1, step: 0.01, bipolar: true },
  saturation: { key: 'saturation', label: 'Saturation', min: -1, max: 1, step: 0.01, bipolar: true },
  sharpness: { key: 'sharpness', label: 'Sharpness', min: 0, max: 1, step: 0.01, bipolar: false },
  grain: { key: 'grain', label: 'Grain', min: 0, max: 1, step: 0.01, bipolar: false },
  vignette: { key: 'vignette', label: 'Vignette', min: 0, max: 1, step: 0.01, bipolar: false },
  fade: { key: 'fade', label: 'Fade', min: 0, max: 1, step: 0.01, bipolar: false },
};

/**
 * Placeholder for future advanced image character. NOT rendered in V1.
 * Presets and projects may carry an (optional) `advanced` block; the V1 engine
 * ignores unknown fields, so adding these later is non-breaking.
 */
export interface AdvancedEffects {
  /** Tone curve control points, x/y in [0,1]. */
  toneCurve?: { x: number; y: number }[];
  /** Per-channel curves. */
  redCurve?: { x: number; y: number }[];
  greenCurve?: { x: number; y: number }[];
  blueCurve?: { x: number; y: number }[];
  /** HSL adjustments per color band. */
  hsl?: Record<string, { h: number; s: number; l: number }>;
  bloom?: number;
  halation?: number;
  chromaticAberration?: number;
  lensDistortion?: number;
  highlightRolloff?: number;
  shadowTint?: { r: number; g: number; b: number };
  /** Reserved for selective masks in a later version. */
  masks?: unknown[];
}

/**
 * A preset is an *editable parameter recipe*, not a baked filter.
 * `intensity` (0..1) is applied by the engine as a blend between neutral and
 * the recipe's adjustments, so any preset is smoothly dialable.
 */
export interface Preset {
  id: string;
  name: string;
  family: PresetFamily;
  /** The recipe. Partial: unspecified keys default to neutral. */
  adjustments: Partial<Adjustments>;
  advanced?: AdvancedEffects;
  /** Default intensity when the preset is first applied. [0,1]. */
  defaultIntensity: number;
  /** true for the built-in library; user copies/creations are false. */
  builtIn: boolean;
  /** Short description for the UI. */
  description?: string;
  createdAt?: number;
  updatedAt?: number;
}

export type PresetFamily =
  | 'Digital'
  | 'Clean'
  | 'Film'
  | 'Black & White'
  | 'Night';

export const PRESET_FAMILIES: PresetFamily[] = [
  'Digital',
  'Clean',
  'Film',
  'Black & White',
  'Night',
];

/** Crop / geometry, stored normalised so it is resolution independent. */
export interface Crop {
  /** Normalised rect [0,1] relative to the source image. */
  x: number;
  y: number;
  width: number;
  height: number;
  /** Rotation in degrees, positive = clockwise. */
  rotation: number;
  /** Horizontal/vertical flip. */
  flipH: boolean;
  flipV: boolean;
}

export const DEFAULT_CROP: Crop = {
  x: 0,
  y: 0,
  width: 1,
  height: 1,
  rotation: 0,
  flipH: false,
  flipV: false,
};

/** A reference to the source image being edited. */
export interface SourceAsset {
  /** Local URI to the ORIGINAL image. Never mutated. */
  uri: string;
  width: number;
  height: number;
  /** Optional Photos library asset id, if imported from the library. */
  assetId?: string;
}

/**
 * The complete, serialisable description of an edit. A rendered image is a pure
 * function of (SourceAsset, EditRecipe). This is what history snapshots capture.
 */
export interface EditRecipe {
  /** Applied preset id, or null for "Original". */
  presetId: string | null;
  /** Preset intensity blend [0,1]. */
  presetIntensity: number;
  /** Manual adjustment offsets layered on top of the preset. */
  adjustments: Adjustments;
  crop: Crop;
  /** Cached local source analysis used consistently by preview and export. */
  analysis?: import('./adaptive').ImageAnalysis;
  /** Advanced effects, reserved for future versions. */
  advanced?: AdvancedEffects;
}

export const EMPTY_RECIPE: EditRecipe = {
  presetId: null,
  presetIntensity: 1,
  adjustments: { ...NEUTRAL_ADJUSTMENTS },
  crop: { ...DEFAULT_CROP },
};

// ---------------------------------------------------------------------------
// Creative layer model (CREATE tab). Kept minimal for V1 but structured for
// growth. A Canvas is: background image + an ordered stack of layers.
// ---------------------------------------------------------------------------

export type BlendMode =
  | 'normal'
  | 'multiply'
  | 'screen'
  | 'overlay'
  | 'lighten'
  | 'darken';

export interface BaseLayer {
  id: string;
  type: LayerType;
  /** Normalised center position [0,1] relative to canvas. */
  x: number;
  y: number;
  scale: number;
  /** Rotation in degrees. */
  rotation: number;
  opacity: number;
  visible: boolean;
  blendMode: BlendMode;
}

export type LayerType = 'text' | 'shape' | 'image' | 'sticker';

export interface TextLayer extends BaseLayer {
  type: 'text';
  text: string;
  color: string;
  fontSize: number;
  fontWeight: 'normal' | 'bold';
  align: 'left' | 'center' | 'right';
}

export interface ShapeLayer extends BaseLayer {
  type: 'shape';
  shape: 'rect' | 'ellipse' | 'line';
  color: string;
  /** Normalised size relative to canvas. */
  width: number;
  height: number;
}

export interface ImageLayer extends BaseLayer {
  type: 'image';
  uri: string;
  width: number;
  height: number;
}

export interface StickerLayer extends BaseLayer {
  type: 'sticker';
  /** Emoji or glyph used as a lightweight sticker in V1. */
  glyph: string;
  fontSize: number;
}

export type Layer = TextLayer | ShapeLayer | ImageLayer | StickerLayer;

/** A creative composition on top of an edited photo. */
export interface Canvas {
  layers: Layer[];
}

export const EMPTY_CANVAS: Canvas = { layers: [] };

/** The top-level unit of user work, persisted locally. */
export interface Project {
  id: string;
  /** Optional user-facing name. */
  name?: string;
  source: SourceAsset;
  recipe: EditRecipe;
  canvas: Canvas;
  /** Thumbnail URI for the projects list (optional). */
  thumbnailUri?: string;
  createdAt: number;
  updatedAt: number;
}
