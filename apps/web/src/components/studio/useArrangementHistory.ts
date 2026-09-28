"use client";

import { useCallback, useState } from "react";
import type { Remix } from "./types";

export const HISTORY_LIMIT = 80;

export function recordArrangementHistory<T>(entries: T[], current: T) {
  return [...entries, current].slice(-HISTORY_LIMIT);
}

export function undoArrangementHistory<T>(entries: T[], future: T[], current: T) {
  const prior = entries.at(-1) ?? null;
  return {
    prior,
    history: prior ? entries.slice(0, -1) : entries,
    future: prior ? [current, ...future].slice(0, HISTORY_LIMIT) : future,
  };
}

export function redoArrangementHistory<T>(entries: T[], future: T[], current: T) {
  const next = future[0] ?? null;
  return {
    next,
    history: next ? recordArrangementHistory(entries, current) : entries,
    future: next ? future.slice(1) : future,
  };
}

export function useArrangementHistory() {
  const [history, setHistory] = useState<Remix[]>([]);
  const [future, setFuture] = useState<Remix[]>([]);
  const reset = useCallback(() => {
    setHistory([]);
    setFuture([]);
  }, []);
  const record = useCallback((current: Remix) => {
    setHistory((entries) => recordArrangementHistory(entries, current));
    setFuture([]);
  }, []);
  const undo = useCallback((current: Remix) => {
    const result = undoArrangementHistory(history, future, current);
    if (!result.prior) return null;
    setHistory(result.history);
    setFuture(result.future);
    return result.prior;
  }, [future, history]);
  const redo = useCallback((current: Remix) => {
    const result = redoArrangementHistory(history, future, current);
    if (!result.next) return null;
    setHistory(result.history);
    setFuture(result.future);
    return result.next;
  }, [future, history]);
  return { history, future, reset, record, undo, redo };
}
