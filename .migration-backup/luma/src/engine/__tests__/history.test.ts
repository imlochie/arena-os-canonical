import {
  canRedo,
  canUndo,
  commit,
  createHistory,
  redo,
  replacePresent,
  resetHistory,
  undo,
} from '../history';

describe('history (undo/redo)', () => {
  it('starts with no undo/redo', () => {
    const h = createHistory(0);
    expect(canUndo(h)).toBe(false);
    expect(canRedo(h)).toBe(false);
    expect(h.present).toBe(0);
  });

  it('commit adds an undo step and clears redo', () => {
    let h = createHistory(0);
    h = commit(h, 1);
    h = commit(h, 2);
    expect(h.present).toBe(2);
    expect(canUndo(h)).toBe(true);
    h = undo(h);
    expect(h.present).toBe(1);
    expect(canRedo(h)).toBe(true);
    // committing after undo discards the redo future
    h = commit(h, 99);
    expect(canRedo(h)).toBe(false);
    expect(h.present).toBe(99);
  });

  it('undo then redo round-trips', () => {
    let h = createHistory('a');
    h = commit(h, 'b');
    h = commit(h, 'c');
    h = undo(h);
    h = undo(h);
    expect(h.present).toBe('a');
    h = redo(h);
    expect(h.present).toBe('b');
    h = redo(h);
    expect(h.present).toBe('c');
    expect(canRedo(h)).toBe(false);
  });

  it('undo/redo are no-ops at the ends', () => {
    let h = createHistory(0);
    expect(undo(h)).toBe(h);
    expect(redo(h)).toBe(h);
  });

  it('commit is a no-op for reference-equal present', () => {
    const obj = { v: 1 };
    let h = createHistory(obj);
    h = commit(h, obj);
    expect(canUndo(h)).toBe(false);
  });

  it('respects the history limit', () => {
    let h = createHistory(0, 3);
    for (let i = 1; i <= 10; i++) h = commit(h, i);
    expect(h.present).toBe(10);
    expect(h.past.length).toBe(3);
    // Only 3 undo steps retained.
    h = undo(h);
    h = undo(h);
    h = undo(h);
    expect(canUndo(h)).toBe(false);
    expect(h.present).toBe(7);
  });

  it('replacePresent does not record history', () => {
    let h = createHistory(0);
    h = replacePresent(h, 5);
    expect(h.present).toBe(5);
    expect(canUndo(h)).toBe(false);
  });

  it('resetHistory clears past and future', () => {
    let h = createHistory(0);
    h = commit(h, 1);
    h = resetHistory(42);
    expect(h.present).toBe(42);
    expect(canUndo(h)).toBe(false);
    expect(canRedo(h)).toBe(false);
  });
});
