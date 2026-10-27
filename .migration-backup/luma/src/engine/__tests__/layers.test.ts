import {
  addLayer,
  bringForward,
  bringToFront,
  createShapeLayer,
  createStickerLayer,
  createTextLayer,
  moveLayer,
  removeLayer,
  sendBackward,
  sendToBack,
  toggleVisibility,
  updateLayer,
} from '../layers';
import { Canvas, EMPTY_CANVAS } from '../types';

function withThree(): { canvas: Canvas; ids: string[] } {
  let canvas: Canvas = { ...EMPTY_CANVAS, layers: [] };
  const a = createTextLayer('a');
  const b = createShapeLayer('rect');
  const c = createStickerLayer('★');
  canvas = addLayer(canvas, a);
  canvas = addLayer(canvas, b);
  canvas = addLayer(canvas, c);
  return { canvas, ids: [a.id, b.id, c.id] };
}

describe('layer stack', () => {
  it('adds layers in paint order (last = top)', () => {
    const { canvas, ids } = withThree();
    expect(canvas.layers.map((l) => l.id)).toEqual(ids);
  });

  it('removes a layer by id', () => {
    const { canvas, ids } = withThree();
    const next = removeLayer(canvas, ids[1]!);
    expect(next.layers.map((l) => l.id)).toEqual([ids[0], ids[2]]);
  });

  it('updates a layer immutably', () => {
    const { canvas, ids } = withThree();
    const next = updateLayer(canvas, ids[0]!, { opacity: 0.5 });
    expect(next.layers[0]!.opacity).toBe(0.5);
    expect(canvas.layers[0]!.opacity).toBe(1); // original untouched
  });

  it('bringForward / sendBackward move one step', () => {
    const { canvas, ids } = withThree();
    let next = bringForward(canvas, ids[0]!); // a moves up one
    expect(next.layers.map((l) => l.id)).toEqual([ids[1], ids[0], ids[2]]);
    next = sendBackward(next, ids[0]!);
    expect(next.layers.map((l) => l.id)).toEqual([ids[0], ids[1], ids[2]]);
  });

  it('bringToFront / sendToBack', () => {
    const { canvas, ids } = withThree();
    let next = bringToFront(canvas, ids[0]!);
    expect(next.layers[next.layers.length - 1]!.id).toBe(ids[0]);
    next = sendToBack(next, ids[0]!);
    expect(next.layers[0]!.id).toBe(ids[0]);
  });

  it('moveLayer clamps out-of-range indices', () => {
    const { canvas, ids } = withThree();
    const next = moveLayer(canvas, ids[0]!, 99);
    expect(next.layers[next.layers.length - 1]!.id).toBe(ids[0]);
  });

  it('does not mutate when id is missing', () => {
    const { canvas } = withThree();
    expect(bringForward(canvas, 'nope')).toBe(canvas);
    expect(moveLayer(canvas, 'nope', 0)).toBe(canvas);
  });

  it('toggles visibility', () => {
    const { canvas, ids } = withThree();
    const next = toggleVisibility(canvas, ids[0]!);
    expect(next.layers[0]!.visible).toBe(false);
  });
});
