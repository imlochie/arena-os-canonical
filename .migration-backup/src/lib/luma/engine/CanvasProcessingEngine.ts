/**
 * CanvasProcessingEngine — the WEB implementation of the LUMA ProcessingEngine
 * contract (the native app ships SkiaProcessingEngine; this port runs the SAME
 * pure color math from colorPipeline.ts through a 2D canvas pixel pipeline).
 *
 * Same contract, same recipes, same presets — only the rendering backend
 * differs. Non-destructive editing semantics are unchanged: the source image is
 * never mutated; every render derives from (source, recipe).
 */

import type {
  Adjustments,
  EditRecipe,
  Preset,
  SourceAsset,
} from "./types";
import type {
  ColorMatrix,
  EngineCapabilities,
  ExportOptions,
  ExportResult,
  ProcessingEngine,
  ShaderUniforms,
} from "./ProcessingEngine";
import { buildColorMatrix, buildShaderUniforms } from "./colorPipeline";
import { composeEffectiveAdjustments, isRecipeNeutral } from "./adjustments";

/** Apply a 4x5 color matrix to ImageData in place. */
function applyColorMatrix(data: Uint8ClampedArray, m: ColorMatrix): void {
  for (let i = 0; i < data.length; i += 4) {
    const r = data[i]!;
    const g = data[i + 1]!;
    const b = data[i + 2]!;
    data[i] = r * m[0]! + g * m[1]! + b * m[2]! + 255 * m[4]!;
    data[i + 1] = r * m[5]! + g * m[6]! + b * m[7]! + 255 * m[9]!;
    data[i + 2] = r * m[10]! + g * m[11]! + b * m[12]! + 255 * m[14]!;
    // alpha row unused (m[15..18] identity)
  }
}

/** Deterministic grain noise from a seed (matches the shader contract: stable per render). */
function grainAt(seed: number, x: number, y: number): number {
  let h = (seed ^ (x * 374761393) ^ (y * 668265263)) >>> 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

/** Apply grain / vignette / fade — the "character" pass a color matrix can't express. */
function applyCharacter(
  data: Uint8ClampedArray,
  w: number,
  h: number,
  u: ShaderUniforms,
): void {
  const cx = w / 2;
  const cy = h / 2;
  const maxDist = Math.sqrt(cx * cx + cy * cy);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      let r = data[i]!;
      let g = data[i + 1]!;
      let b = data[i + 2]!;

      // grain: additive noise, luminance-only
      if (u.grain > 0) {
        const n = (grainAt(u.grainSeed, x, y) - 0.5) * u.grain * 60;
        r += n;
        g += n;
        b += n;
      }

      // vignette: darken toward the corners
      if (u.vignette > 0) {
        const dx = (x - cx) / maxDist;
        const dy = (y - cy) / maxDist;
        const d = Math.sqrt(dx * dx + dy * dy);
        const v = 1 - u.vignette * Math.pow(Math.max(0, d - 0.35) / 0.65, 1.6);
        r *= v;
        g *= v;
        b *= v;
      }

      // matte fade: lift blacks toward a neutral milk tone
      if (u.fade > 0) {
        const lift = u.fade * 70;
        r = lift + r * (1 - (u.fade * 70) / 255);
        g = lift + g * (1 - (u.fade * 62) / 255);
        b = lift + b * (1 - (u.fade * 55) / 255);
      }

      data[i] = r;
      data[i + 1] = g;
      data[i + 2] = b;
    }
  }
}

export class CanvasProcessingEngine implements ProcessingEngine {
  readonly capabilities: EngineCapabilities = {
    colorMatrix: true,
    runtimeShader: true, // grain/vignette/fade implemented in the pixel pass
    export: true,
    name: "Canvas2D (web)",
  };

  computeColorMatrix(adj: Adjustments): ColorMatrix {
    return buildColorMatrix(adj);
  }

  computeShaderUniforms(adj: Adjustments, seed?: number): ShaderUniforms {
    return buildShaderUniforms(adj, seed);
  }

  /**
   * Render (image, recipe, preset) into a canvas. Pure derivation — the source
   * bitmap is read-only.
   */
  renderToCanvas(
    image: CanvasImageSource,
    width: number,
    height: number,
    recipe: EditRecipe,
    preset: Preset | null,
    canvas?: HTMLCanvasElement,
    seed = 1337,
  ): HTMLCanvasElement {
    const out = canvas ?? document.createElement("canvas");
    out.width = width;
    out.height = height;
    const ctx = out.getContext("2d", { willReadFrequently: true })!;
    ctx.clearRect(0, 0, width, height);
    ctx.drawImage(image, 0, 0, width, height);
    if (!preset && isRecipeNeutral(recipe)) return out;

    const effective = composeEffectiveAdjustments(recipe, preset);
    const frame = ctx.getImageData(0, 0, width, height);
    applyColorMatrix(frame.data, buildColorMatrix(effective));
    applyCharacter(frame.data, width, height, buildShaderUniforms(effective, seed));
    ctx.putImageData(frame, 0, 0);
    return out;
  }

  async exportImage(
    source: SourceAsset,
    recipe: EditRecipe,
    preset: Preset | null,
    options?: ExportOptions,
  ): Promise<ExportResult> {
    const img = await loadImage(source.uri);
    let w = img.naturalWidth || source.width;
    let h = img.naturalHeight || source.height;
    if (options?.maxDimension && Math.max(w, h) > options.maxDimension) {
      const scale = options.maxDimension / Math.max(w, h);
      w = Math.round(w * scale);
      h = Math.round(h * scale);
    }
    const canvas = this.renderToCanvas(img, w, h, recipe, preset);
    const format = options?.format ?? "jpeg";
    const uri = canvas.toDataURL(`image/${format}`, options?.quality ?? 0.92);
    return { uri, width: w, height: h };
  }
}

export function loadImage(uri: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("image failed to load"));
    img.src = uri;
  });
}

let engine: CanvasProcessingEngine | null = null;

/** The web engine factory (native: getEngine() → SkiaProcessingEngine). */
export function getEngine(): CanvasProcessingEngine {
  if (!engine) engine = new CanvasProcessingEngine();
  return engine;
}
