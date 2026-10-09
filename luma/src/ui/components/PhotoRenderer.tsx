/**
 * PhotoRenderer — the on-screen, GPU preview of an edit.
 *
 * Renders a source image through the engine's color matrix, then layers the
 * "character" effects (vignette as a radial gradient, grain as a noise overlay)
 * on top. This is the *preview* renderer; the *export* renderer lives in
 * SkiaProcessingEngine.exportImage and produces a high-quality file from the
 * same pure math, so preview matches export.
 *
 * Performance:
 *  - The image is decoded once via useImage and reused across edits.
 *  - Color matrix + uniforms are memoised (cheap pure math).
 *  - Skia renders on the GPU, so slider drags stay smooth. A reduced-resolution
 *    preview path is documented as a future optimisation for very large images.
 */

import React, { useMemo } from 'react';
import { StyleSheet, View } from 'react-native';
import {
  Canvas,
  ColorMatrix,
  Group,
  Image as SkImage,
  RadialGradient,
  Rect,
  Shader,
  Skia,
  useImage,
  vec,
} from '@shopify/react-native-skia';

import { getEngine } from '../../engine';
import { addAdjustments, clampAdjustments, composeEffectiveAdjustments } from '../../engine/adjustments';
import { resolveAdaptiveLook } from '../../engine/adaptive';
import { EditRecipe, NEUTRAL_ADJUSTMENTS, Preset } from '../../engine/types';
import { GRAIN_OVERLAY_SHADER } from '../../engine/shaders';
import { palette } from '../../theme/tokens';

interface PhotoRendererProps {
  uri: string;
  recipe: EditRecipe;
  preset: Preset | null;
  width: number;
  height: number;
  showOriginal?: boolean;
  fit?: 'contain' | 'cover';
}

const grainEffect = (() => {
  try {
    return Skia.RuntimeEffect.Make(GRAIN_OVERLAY_SHADER);
  } catch {
    return null;
  }
})();

export function PhotoRenderer({
  uri,
  recipe,
  preset,
  width,
  height,
  showOriginal = false,
  fit = 'contain',
}: PhotoRendererProps) {
  const image = useImage(uri);
  const engine = getEngine();

  const adj = useMemo(
    () => {
      if (showOriginal) return NEUTRAL_ADJUSTMENTS;
      if (preset && recipe.analysis) {
        const adaptive = resolveAdaptiveLook(preset, recipe.analysis, recipe.presetIntensity).adjustments;
        return clampAdjustments(addAdjustments(adaptive, recipe.adjustments));
      }
      return composeEffectiveAdjustments(recipe, preset);
    },
    [recipe, preset, showOriginal],
  );
  const matrix = useMemo(() => engine.computeColorMatrix(adj), [adj, engine]);
  const uniforms = useMemo(() => engine.computeShaderUniforms(adj, 0), [adj, engine]);

  const layout = useMemo(() => {
    if (!image) return { x: 0, y: 0, w: width, h: height };
    const iw = image.width();
    const ih = image.height();
    const scale =
      fit === 'cover'
        ? Math.max(width / iw, height / ih)
        : Math.min(width / iw, height / ih);
    const w = iw * scale;
    const h = ih * scale;
    return { x: (width - w) / 2, y: (height - h) / 2, w, h };
  }, [image, width, height, fit]);

  if (!image) {
    return <View style={[styles.placeholder, { width, height }]} />;
  }

  const cx = layout.x + layout.w / 2;
  const cy = layout.y + layout.h / 2;
  const vRadius = Math.max(layout.w, layout.h) * 0.75;

  return (
    <Canvas style={{ width, height }}>
      {/* 1. Color-graded photo */}
      <SkImage
        image={image}
        x={layout.x}
        y={layout.y}
        width={layout.w}
        height={layout.h}
        fit={fit}
      >
        <ColorMatrix matrix={matrix} />
      </SkImage>

      {/* 2. Vignette overlay (radial gradient, darkening toward corners) */}
      {uniforms.vignette > 0 ? (
        <Rect
          x={layout.x}
          y={layout.y}
          width={layout.w}
          height={layout.h}
          opacity={uniforms.vignette * 0.85}
        >
          <RadialGradient
            c={vec(cx, cy)}
            r={vRadius}
            colors={['rgba(0,0,0,0)', 'rgba(0,0,0,0)', 'rgba(0,0,0,1)']}
            positions={[0, 0.55, 1]}
          />
        </Rect>
      ) : null}

      {/* 3. Grain overlay (noise), clipped to the image rect */}
      {uniforms.grain > 0 && grainEffect ? (
        <Group clip={{ x: layout.x, y: layout.y, width: layout.w, height: layout.h }}>
          <Rect
            x={layout.x}
            y={layout.y}
            width={layout.w}
            height={layout.h}
            opacity={Math.min(1, uniforms.grain)}
          >
            <Shader
              source={grainEffect}
              uniforms={{
                resolution: [layout.w, layout.h],
                amount: uniforms.grain,
                seed: uniforms.grainSeed,
              }}
            />
          </Rect>
        </Group>
      ) : null}
    </Canvas>
  );
}

const styles = StyleSheet.create({
  placeholder: {
    backgroundColor: palette.bg2,
  },
});
