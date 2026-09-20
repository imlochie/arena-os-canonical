/**
 * SkiaProcessingEngine — the V1 image-processing backend.
 *
 * Implements ProcessingEngine using React Native Skia:
 *  - color grading via a GPU ColorMatrix (see colorPipeline)
 *  - grain/vignette/fade via an SkSL runtime shader (see shaders)
 *  - export via Skia offscreen surface -> PNG/JPEG -> file
 *
 * IMPORTANT: This class is the *only* place that imports Skia's imperative API.
 * The React render components consume the matrix/uniform math (pure, testable)
 * from colorPipeline; this engine adds the file-export capability. When a native
 * Core Image/Metal engine is written later, only this file and getEngine() need
 * to change — no UI, preset, or data-model code is affected.
 *
 * The Skia import is done lazily inside exportImage so that the pure math
 * (computeColorMatrix / computeShaderUniforms) can be used in any environment,
 * including Node-based unit tests, without loading native code.
 */

import { buildColorMatrix, buildShaderUniforms } from './colorPipeline';
import { composeEffectiveAdjustments } from './adjustments';
import {
  ColorMatrix,
  EngineCapabilities,
  ExportOptions,
  ExportResult,
  ProcessingEngine,
  ShaderUniforms,
} from './ProcessingEngine';
import { Adjustments, EditRecipe, Preset, SourceAsset } from './types';
import { CHARACTER_SHADER } from './shaders';

export class SkiaProcessingEngine implements ProcessingEngine {
  readonly capabilities: EngineCapabilities = {
    colorMatrix: true,
    runtimeShader: true,
    export: true,
    name: 'Skia (GPU) — V1',
  };

  computeColorMatrix(adj: Adjustments): ColorMatrix {
    return buildColorMatrix(adj);
  }

  computeShaderUniforms(adj: Adjustments, seed = 0): ShaderUniforms {
    return buildShaderUniforms(adj, seed);
  }

  /**
   * Render at export quality to a PNG/JPEG file using an offscreen Skia surface.
   * Applies the color matrix and the character shader, matching the on-screen
   * preview so what you see is what you export.
   *
   * Pipeline:
   *   1. decode source -> Skia image
   *   2. draw color-graded image (ColorMatrix filter) into an offscreen surface
   *   3. run the character shader (grain/vignette/fade) over that graded image
   *   4. encode to bytes and write to the cache directory
   */
  async exportImage(
    source: SourceAsset,
    recipe: EditRecipe,
    preset: Preset | null,
    options: ExportOptions = {},
  ): Promise<ExportResult> {
    // Lazy native imports — never loaded during pure-math unit tests.
    const {
      Skia,
      TileMode,
      FilterMode,
      MipmapMode,
      ImageFormat,
    } = require('@shopify/react-native-skia');
    const FileSystem = require('expo-file-system/legacy');

    const adj = composeEffectiveAdjustments(recipe, preset);
    const matrix = this.computeColorMatrix(adj);
    const uniforms = this.computeShaderUniforms(adj, Math.random() * 1000);

    // 1. Load source pixels into a Skia image.
    const data = await Skia.Data.fromURI(source.uri);
    const baseImage = Skia.Image.MakeImageFromEncoded(data);
    if (!baseImage) {
      throw new Error('LUMA: failed to decode source image for export.');
    }

    const srcW = baseImage.width();
    const srcH = baseImage.height();

    // Output dimensions honor maxDimension while preserving aspect ratio.
    let outW = srcW;
    let outH = srcH;
    if (options.maxDimension && Math.max(srcW, srcH) > options.maxDimension) {
      const s = options.maxDimension / Math.max(srcW, srcH);
      outW = Math.max(1, Math.round(srcW * s));
      outH = Math.max(1, Math.round(srcH * s));
    }

    // 2. Color-grade into an offscreen surface.
    const gradeSurface = Skia.Surface.MakeOffscreen(outW, outH);
    if (!gradeSurface) {
      throw new Error('LUMA: failed to allocate Skia grading surface.');
    }
    const gradeCanvas = gradeSurface.getCanvas();
    const gradePaint = Skia.Paint();
    gradePaint.setColorFilter(Skia.ColorFilter.MakeMatrix(matrix));
    gradeCanvas.drawImageRect(
      baseImage,
      Skia.XYWHRect(0, 0, srcW, srcH),
      Skia.XYWHRect(0, 0, outW, outH),
      gradePaint,
    );
    gradeSurface.flush();
    const gradedImage = gradeSurface.makeImageSnapshot();

    // 3. Character pass (grain/vignette/fade) via runtime shader.
    let finalImage = gradedImage;
    const effect = Skia.RuntimeEffect.Make(CHARACTER_SHADER);
    const needsCharacter =
      uniforms.grain > 0 || uniforms.vignette > 0 || uniforms.fade > 0;
    if (effect && needsCharacter) {
      const outSurface = Skia.Surface.MakeOffscreen(outW, outH);
      if (outSurface) {
        const outCanvas = outSurface.getCanvas();
        const imgShader = gradedImage.makeShaderOptions(
          TileMode.Clamp,
          TileMode.Clamp,
          FilterMode.Linear,
          MipmapMode.None,
        );
        const shader = effect.makeShaderWithChildren(
          [
            outW,
            outH,
            uniforms.grain,
            uniforms.vignette,
            uniforms.fade,
            uniforms.grainSeed,
          ],
          [imgShader],
        );
        const paint = Skia.Paint();
        paint.setShader(shader);
        outCanvas.drawRect(Skia.XYWHRect(0, 0, outW, outH), paint);
        outSurface.flush();
        finalImage = outSurface.makeImageSnapshot();
      }
    }

    // 4. Encode + write.
    const format = options.format ?? 'jpeg';
    const quality = Math.round((options.quality ?? 0.95) * 100);
    const bytes =
      format === 'png'
        ? finalImage.encodeToBytes(ImageFormat.PNG, 100)
        : finalImage.encodeToBytes(ImageFormat.JPEG, quality);

    const base64 = bytesToBase64(bytes);
    const ext = format === 'png' ? 'png' : 'jpg';
    const dir = FileSystem.cacheDirectory ?? FileSystem.documentDirectory;
    const outUri = `${dir}luma-export-${Date.now()}.${ext}`;
    await FileSystem.writeAsStringAsync(outUri, base64, {
      encoding: FileSystem.EncodingType.Base64,
    });

    return { uri: outUri, width: outW, height: outH };
  }
}

/** Minimal, dependency-free base64 encoder for Skia byte output. */
function bytesToBase64(bytes: Uint8Array): string {
  const chars =
    'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  const at = (idx: number): number => bytes[idx] ?? 0;
  const ch = (idx: number): string => chars[idx] ?? 'A';
  let result = '';
  let i = 0;
  for (; i + 2 < bytes.length; i += 3) {
    const n = (at(i) << 16) | (at(i + 1) << 8) | at(i + 2);
    result += ch((n >> 18) & 63) + ch((n >> 12) & 63) + ch((n >> 6) & 63) + ch(n & 63);
  }
  const rem = bytes.length - i;
  if (rem === 1) {
    const n = at(i) << 16;
    result += ch((n >> 18) & 63) + ch((n >> 12) & 63) + '==';
  } else if (rem === 2) {
    const n = (at(i) << 16) | (at(i + 1) << 8);
    result += ch((n >> 18) & 63) + ch((n >> 12) & 63) + ch((n >> 6) & 63) + '=';
  }
  return result;
}
