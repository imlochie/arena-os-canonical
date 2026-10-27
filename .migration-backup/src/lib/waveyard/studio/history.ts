/**
 * Universal undo/redo — the studio's single history primitive (vision:
 * "a universal undo / redo button could always help").
 *
 * The core is pure and time-injectable so coalescing is deterministic under
 * test: rapid edits (pointer drags fire a change per pointermove) collapse
 * into ONE history entry when they land inside the coalesce window, while
 * deliberate later edits get their own entry. `useUndoRedo` is the React
 * skin; every editing surface (piano roll, chop builder, layer editor)
 * shares the same semantics.
 */

import { useCallback, useState } from "react";

export const HISTORY_LIMIT = 100;
export const DEFAULT_COALESCE_MS = 400;

export type HistoryState<T> = {
  past: T[];
  present: T;
  future: T[];
  /** Timestamp of the last commit (caller-supplied clock, ms). */
  lastCommitAt: number;
};

export function createHistory<T>(initial: T): HistoryState<T> {
  return { past: [], present: initial, future: [], lastCommitAt: 0 };
}

/**
 * Commit the next value. When `now` is within `coalesceMs` of the previous
 * commit, the top of the past stack is REPLACED (one drag = one undo step)
 * and the present moves forward.
 */
export function commit<T>(
  state: HistoryState<T>,
  next: T,
  now: number,
  coalesceMs: number = DEFAULT_COALESCE_MS,
): HistoryState<T> {
  if (next === state.present) return state;
  const coalescing =
    state.lastCommitAt > 0 && now - state.lastCommitAt <= coalesceMs && state.past.length > 0;
  if (coalescing) {
    return { past: state.past, present: next, future: [], lastCommitAt: now };
  }
  const past = [...state.past, state.present];
  if (past.length > HISTORY_LIMIT) past.shift();
  return { past, present: next, future: [], lastCommitAt: now };
}

/** Step back. Returns the state unchanged when there is nothing to undo. */
export function undo<T>(state: HistoryState<T>): HistoryState<T> {
  if (state.past.length === 0) return state;
  const past = [...state.past];
  const previous = past.pop() as T;
  return {
    past,
    present: previous,
    future: [state.present, ...state.future],
    lastCommitAt: 0, // undo breaks any coalescing chain — the next commit is deliberate
  };
}

/** Step forward. Returns the state unchanged when there is nothing to redo. */
export function redo<T>(state: HistoryState<T>): HistoryState<T> {
  if (state.future.length === 0) return state;
  const [next, ...future] = state.future;
  return {
    past: [...state.past, state.present],
    present: next,
    future,
    lastCommitAt: 0,
  };
}

/**
 * React hook over the pure core: `value` is the current state, `set`
 * commits (with drag coalescing), `undo`/`redo` step through history.
 */
export function useUndoRedo<T>(initial: T) {
  const [state, setState] = useState<HistoryState<T>>(() => createHistory(initial));
  const set = useCallback((next: T) => {
    setState((current) => commit(current, next, Date.now()));
  }, []);
  const reset = useCallback((next: T) => {
    setState(createHistory(next));
  }, []);
  const stepUndo = useCallback(() => setState((current) => undo(current)), []);
  const stepRedo = useCallback(() => setState((current) => redo(current)), []);
  return {
    value: state.present,
    set,
    reset,
    undo: stepUndo,
    redo: stepRedo,
    canUndo: state.past.length > 0,
    canRedo: state.future.length > 0,
  };
}
