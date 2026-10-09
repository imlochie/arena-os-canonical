/**
 * Pure helpers for the creative layer stack (CREATE tab).
 *
 * Layers are stored in paint order: index 0 is the bottom-most layer (drawn
 * first), the last index is on top. These helpers are pure so ordering and
 * transforms are fully unit-testable.
 */

import {
  BlendMode,
  Canvas,
  Layer,
  LayerType,
  ShapeLayer,
  StickerLayer,
  TextLayer,
} from './types';

export function makeLayerId(): string {
  return `layer_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
}

const baseDefaults = {
  x: 0.5,
  y: 0.5,
  scale: 1,
  rotation: 0,
  opacity: 1,
  visible: true,
  blendMode: 'normal' as BlendMode,
};

export function createTextLayer(text = 'Double tap to edit'): TextLayer {
  return {
    id: makeLayerId(),
    type: 'text',
    ...baseDefaults,
    text,
    color: '#FFFFFF',
    fontSize: 32,
    fontWeight: 'bold',
    align: 'center',
  };
}

export function createShapeLayer(shape: ShapeLayer['shape'] = 'rect'): ShapeLayer {
  return {
    id: makeLayerId(),
    type: 'shape',
    ...baseDefaults,
    shape,
    color: '#F5B843',
    width: 0.4,
    height: 0.25,
  };
}

export function createStickerLayer(glyph = '✨'): StickerLayer {
  return {
    id: makeLayerId(),
    type: 'sticker',
    ...baseDefaults,
    glyph,
    fontSize: 64,
  };
}

/** Append a layer on top of the stack. */
export function addLayer(canvas: Canvas, layer: Layer): Canvas {
  return { ...canvas, layers: [...canvas.layers, layer] };
}

/** Remove a layer by id. */
export function removeLayer(canvas: Canvas, id: string): Canvas {
  return { ...canvas, layers: canvas.layers.filter((l) => l.id !== id) };
}

/** Update a single layer immutably by id. */
export function updateLayer(canvas: Canvas, id: string, patch: Partial<Layer>): Canvas {
  return {
    ...canvas,
    layers: canvas.layers.map((l) =>
      l.id === id ? ({ ...l, ...patch } as Layer) : l,
    ),
  };
}

function clampIndex(len: number, i: number): number {
  return Math.max(0, Math.min(len - 1, i));
}

/** Move a layer to an explicit index in paint order. */
export function moveLayer(canvas: Canvas, id: string, toIndex: number): Canvas {
  const from = canvas.layers.findIndex((l) => l.id === id);
  if (from < 0) return canvas;
  const layers = [...canvas.layers];
  const [moved] = layers.splice(from, 1);
  if (!moved) return canvas;
  const dest = clampIndex(layers.length + 1, toIndex);
  layers.splice(dest, 0, moved);
  return { ...canvas, layers };
}

/** Bring a layer one step toward the top. */
export function bringForward(canvas: Canvas, id: string): Canvas {
  const i = canvas.layers.findIndex((l) => l.id === id);
  if (i < 0 || i === canvas.layers.length - 1) return canvas;
  return moveLayer(canvas, id, i + 1);
}

/** Send a layer one step toward the bottom. */
export function sendBackward(canvas: Canvas, id: string): Canvas {
  const i = canvas.layers.findIndex((l) => l.id === id);
  if (i <= 0) return canvas;
  return moveLayer(canvas, id, i - 1);
}

/** Bring a layer fully to the top. */
export function bringToFront(canvas: Canvas, id: string): Canvas {
  return moveLayer(canvas, id, canvas.layers.length - 1);
}

/** Send a layer fully to the bottom. */
export function sendToBack(canvas: Canvas, id: string): Canvas {
  return moveLayer(canvas, id, 0);
}

export function toggleVisibility(canvas: Canvas, id: string): Canvas {
  const layer = canvas.layers.find((l) => l.id === id);
  if (!layer) return canvas;
  return updateLayer(canvas, id, { visible: !layer.visible } as Partial<Layer>);
}

/** All layer types available for creation in V1. */
export const CREATABLE_LAYER_TYPES: LayerType[] = ['text', 'shape', 'sticker', 'image'];
