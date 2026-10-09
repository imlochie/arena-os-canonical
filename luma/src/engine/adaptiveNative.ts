import { ImageAnalysis, analyzeSamples } from './adaptive';

/**
 * Read a small RGBA thumbnail through Skia and derive local statistics.
 * Kept separate from the pure resolver so the latter remains testable in Node.
 */
export async function analyzeSourceImage(sourceUri: string, maxDimension = 64): Promise<ImageAnalysis> {
  // Native imports are intentionally lazy: tests and web never load Skia.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { Skia } = require('@shopify/react-native-skia');
  const data = await Skia.Data.fromURI(sourceUri);
  const image = Skia.Image.MakeImageFromEncoded(data);
  if (!image) throw new Error('LUMA: failed to decode image for analysis.');

  const width = image.width();
  const height = image.height();
  const scale = Math.min(1, maxDimension / Math.max(width, height));
  const sampleWidth = Math.max(1, Math.round(width * scale));
  const sampleHeight = Math.max(1, Math.round(height * scale));
  const pixels = image.readPixels(0, 0, {
    width: sampleWidth,
    height: sampleHeight,
    colorType: 4, // RGBA 8888
    alphaType: 1, // unpremultiplied
  }) as Uint8Array | null;
  if (!pixels) throw new Error('LUMA: failed to read thumbnail pixels.');

  const samples: { r: number; g: number; b: number }[] = [];
  for (let i = 0; i + 3 < pixels.length; i += 4) {
    samples.push({ r: pixels[i] ?? 0, g: pixels[i + 1] ?? 0, b: pixels[i + 2] ?? 0 });
  }
  return analyzeSamples(samples, width, height);
}
