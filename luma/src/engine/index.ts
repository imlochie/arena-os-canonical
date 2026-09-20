/**
 * Engine entry point + backend selection.
 *
 * getEngine() returns the single ProcessingEngine the app uses. To swap in a
 * native Core Image/Metal backend later, implement ProcessingEngine and return
 * it here — nothing else in the app needs to change.
 */

import { ProcessingEngine } from './ProcessingEngine';
import { SkiaProcessingEngine } from './SkiaProcessingEngine';

let engine: ProcessingEngine | null = null;

export function getEngine(): ProcessingEngine {
  if (!engine) {
    engine = new SkiaProcessingEngine();
  }
  return engine;
}

/** Test/DI hook to override the engine (e.g. a fake in tests). */
export function setEngine(next: ProcessingEngine): void {
  engine = next;
}

export * from './types';
export * from './adjustments';
export * from './adaptive';
export * from './ProcessingEngine';
export { buildColorMatrix, buildShaderUniforms, identityColorMatrix } from './colorPipeline';
