/**
 * SkSL runtime shader sources for LUMA's "character" effects.
 *
 * A color matrix handles exposure/contrast/WB/saturation/tone. Effects that are
 * spatial or noise-based (grain, vignette) cannot be expressed as a matrix.
 *
 * Rather than compose a child image shader (which is fiddly to align in Skia's
 * declarative API), the preview renders these as self-contained OVERLAYS drawn
 * on top of the color-graded image:
 *   - GRAIN_OVERLAY_SHADER: emits bipolar monochrome noise as a translucent
 *     layer, blended over the photo.
 *   - The vignette is drawn separately as a radial gradient (see PhotoRenderer).
 *
 * The export path (SkiaProcessingEngine) uses the same conceptual pipeline.
 */

/**
 * Grain overlay. Produces greyish noise centered on 0.5 so that, drawn with a
 * moderate opacity over the image, it lightens and darkens pixels evenly like
 * film grain. `amount` scales the deviation from neutral; `seed` varies it.
 */
export const GRAIN_OVERLAY_SHADER = `
uniform float2 resolution;
uniform float amount;  // [0,1]
uniform float seed;

float hash(float2 p) {
  p = fract(p * float2(123.34, 456.21));
  p += dot(p, p + 45.32);
  return fract(p.x * p.y);
}

half4 main(float2 fragCoord) {
  float n = hash(fragCoord + seed);
  // Center noise around 0.5 grey; alpha carries the strength.
  float g = 0.5 + (n - 0.5);
  return half4(half3(g), amount * 0.5);
}
`;

/**
 * Kept for the export engine / future full-frame passes: a combined character
 * shader that samples a child image and layers grain + vignette in one pass.
 */
export const CHARACTER_SHADER = `
uniform shader image;
uniform float2 resolution;
uniform float grain;
uniform float vignette;
uniform float fade;
uniform float seed;

float hash(float2 p) {
  p = fract(p * float2(123.34, 456.21));
  p += dot(p, p + 45.32);
  return fract(p.x * p.y);
}

half4 main(float2 fragCoord) {
  float2 uv = fragCoord / resolution;
  half4 color = image.eval(fragCoord);

  if (vignette > 0.0) {
    float2 centered = uv - 0.5;
    float dist = length(centered) * 1.41421356;
    float v = smoothstep(0.5, 1.0, dist);
    color.rgb *= (1.0 - v * vignette * 0.85);
  }

  if (grain > 0.0) {
    float n = hash(fragCoord + seed) - 0.5;
    float luma = dot(color.rgb, half3(0.2126, 0.7152, 0.0722));
    float midWeight = max(1.0 - abs(luma - 0.5) * 1.6, 0.15);
    color.rgb += half3(n * grain * 0.18 * midWeight);
  }

  if (fade > 0.0) {
    color.rgb = mix(color.rgb, color.rgb + half3(0.04), fade * 0.5);
  }

  return clamp(color, 0.0, 1.0);
}
`;
