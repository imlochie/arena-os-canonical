/**
 * ProcessingEngine — the isolation boundary for image processing.
 *
 * The ENTIRE app talks to image processing only through this interface. The V1
 * implementation (`SkiaProcessingEngine`) uses React Native Skia (GPU color
 * matrices + an SkSL runtime shader for grain/vignette/fade). Later this can be
 * replaced with a native Core Image / Metal engine WITHOUT touching any UI:
 * just provide a new class that satisfies this interface and swap it in
 * `getEngine()`.
 *
 * The engine is deliberately *pure math + descriptors* at this layer:
 *  - `computeColorMatrix()` and `computeShaderUniforms()` return plain data that
 *    the render components feed into Skia. This keeps the heavy React/GPU code
 *    thin and this module unit-testable.
 *  - `exportImage()` is the one method that performs real I/O (rendering to a
 *    file). It is optional-by-capability so tests and non-native environments
 *    can use the engine's math without a GPU.
 */

import { Adjustments, EditRecipe, Preset, SourceAsset } from './types';

/** A 4x5 row-major color matrix compatible with Skia's ColorMatrix filter. */
export type ColorMatrix = number[]; // length 20

/**
 * Uniforms for the "character" runtime shader (grain, vignette, fade, etc.).
 * These are effects that a plain color matrix cannot express.
 */
export interface ShaderUniforms {
  grain: number; // [0,1]
  vignette: number; // [0,1]
  fade: number; // [0,1]
  /** A per-render seed so grain is stable within a render but varies frame to frame if desired. */
  grainSeed: number;
}

export interface ExportOptions {
  /** Target longest-edge in pixels. undefined = native resolution. */
  maxDimension?: number;
  /** JPEG quality 0..1. */
  quality?: number;
  format?: 'jpeg' | 'png';
}

export interface ExportResult {
  uri: string;
  width: number;
  height: number;
}

export interface EngineCapabilities {
  colorMatrix: boolean;
  runtimeShader: boolean;
  export: boolean;
  /** Human-readable name for Settings / diagnostics. */
  name: string;
}

/**
 * The contract every processing backend must satisfy.
 */
export interface ProcessingEngine {
  readonly capabilities: EngineCapabilities;

  /**
   * Map effective adjustments into a Skia-compatible 4x5 color matrix.
   * Covers exposure, contrast, temperature, tint, saturation, highlights,
   * shadows, and fade's tonal lift. Pure function — safe in tests.
   */
  computeColorMatrix(adj: Adjustments): ColorMatrix;

  /**
   * Map effective adjustments into runtime-shader uniforms for effects that a
   * color matrix cannot represent (grain, vignette, matte fade). Pure function.
   */
  computeShaderUniforms(adj: Adjustments, seed?: number): ShaderUniforms;

  /**
   * Render the recipe to a file at export quality. Performs real I/O and needs
   * a GPU context; only available when `capabilities.export` is true.
   */
  exportImage?(
    source: SourceAsset,
    recipe: EditRecipe,
    preset: Preset | null,
    options?: ExportOptions,
  ): Promise<ExportResult>;
}
