"use client";

import { useCallback, useState } from "react";
import type { Remix } from "./types";

const HISTORY_LIMIT = 80;

export function useArrangementHistory() {
  const [history, setHistory] = useState<Remix[]>([]);
  const [future, setFuture] = useState<Remix[]>([]);
  const reset = useCallback(() => {
    setHistory([]);
    setFuture([]);
  }, []);
  const record = useCallback((current: Remix) => {
    setHistory((entries) => [...entries, current].slice(-HISTORY_LIMIT));
    setFuture([]);
  }, []);
  const undo = useCallback((current: Remix) => {
    const prior = history.at(-1);
    if (!prior) return null;
    setHistory((entries) => entries.slice(0, -1));
    setFuture((entries) => [current, ...entries].slice(0, HISTORY_LIMIT));
    return prior;
  }, [history]);
  const redo = useCallback((current: Remix) => {
    const next = future[0];
    if (!next) return null;
    setFuture((entries) => entries.slice(1));
    setHistory((entries) => [...entries, current].slice(-HISTORY_LIMIT));
    return next;
  }, [future]);
  return { history, future, reset, record, undo, redo };
}
