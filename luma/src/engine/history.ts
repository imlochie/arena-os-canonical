/**
 * Undo/redo history as an immutable, generic ring of snapshots.
 *
 * Editing is non-destructive: each committed change pushes a full snapshot of
 * the serialisable edit state. This module is pure and generic over the snapshot
 * type <T>, so it is trivially unit-testable and reusable for both the Edit
 * recipe and the Create canvas.
 *
 * A bounded history keeps memory predictable (snapshots are small JSON-able
 * objects, not pixel buffers).
 */

export interface History<T> {
  past: T[];
  present: T;
  future: T[];
  /** Max number of undo steps retained. */
  limit: number;
}

export function createHistory<T>(present: T, limit = 50): History<T> {
  return { past: [], present, future: [], limit };
}

/**
 * Commit a new present state. Clears the redo stack (future) and trims the past
 * to `limit`. If `next` is reference-equal to present, this is a no-op.
 */
export function commit<T>(history: History<T>, next: T): History<T> {
  if (next === history.present) return history;
  const past = [...history.past, history.present];
  // Trim oldest entries beyond the limit.
  while (past.length > history.limit) past.shift();
  return { ...history, past, present: next, future: [] };
}

export function canUndo<T>(history: History<T>): boolean {
  return history.past.length > 0;
}

export function canRedo<T>(history: History<T>): boolean {
  return history.future.length > 0;
}

export function undo<T>(history: History<T>): History<T> {
  if (!canUndo(history)) return history;
  const past = [...history.past];
  const previous = past.pop() as T;
  const future = [history.present, ...history.future];
  return { ...history, past, present: previous, future };
}

export function redo<T>(history: History<T>): History<T> {
  if (!canRedo(history)) return history;
  const future = [...history.future];
  const next = future.shift() as T;
  const past = [...history.past, history.present];
  while (past.length > history.limit) past.shift();
  return { ...history, past, present: next, future };
}

/**
 * Replace the present WITHOUT recording history (e.g. live slider dragging).
 * Call commit() once when the interaction ends to record a single undo step.
 */
export function replacePresent<T>(history: History<T>, next: T): History<T> {
  return { ...history, present: next };
}

/** Reset history to a single present, discarding all past/future. */
export function resetHistory<T>(present: T, limit = 50): History<T> {
  return createHistory(present, limit);
}
