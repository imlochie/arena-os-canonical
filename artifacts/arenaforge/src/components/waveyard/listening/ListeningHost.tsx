"use client";

/**
 * The persistent Waveyard listening host. Mounted once in the App shell,
 * OUTSIDE the routed page subtree, so the session's audio never unmounts while
 * the user browses library, sessions, Studio or any other room.
 *
 * It owns only "which session is current" plus a command channel. The real
 * playback, mixing, transitions and persistence stay in SessionExperience,
 * against the existing /api/library/sessions endpoints.
 */

import { createContext, lazy, Suspense, useCallback, useContext, useMemo, useRef, useState, type ReactNode } from "react";
import { useLocation } from "react-router-dom";
import type { HostCommand, HostCommandKind } from "@/components/waveyard/library/SessionExperience";

const SessionExperience = lazy(() => import("@/components/waveyard/library/SessionExperience"));

const STORAGE_KEY = "waveyard.listening.sessionId";

interface ListeningHostApi {
  sessionId: string | null;
  /** Load a library track into the current listening session (creating one if needed). */
  sendTrack: (trackId: string, kind: HostCommandKind) => Promise<void>;
  /** Append library tracks to the live listening order without interrupting playback. */
  enqueueTracks: (trackIds: string[], queueItemIds?: string[]) => Promise<boolean>;
  /** Rehydrate the active session after a saved-queue deletion cascades into it. */
  refreshSession: (sessionIds: string[]) => void;
  openSession: (sessionId: string) => void;
  hostError: string | null;
}

const ListeningContext = createContext<ListeningHostApi | null>(null);

export function useListeningHost(): ListeningHostApi {
  const value = useContext(ListeningContext);
  if (value === null) throw new Error("useListeningHost must be used inside ListeningHostProvider");
  return value;
}

function readStoredSession(): string | null {
  try {
    return window.localStorage.getItem(STORAGE_KEY);
  } catch {
    return null;
  }
}

function storeSession(id: string | null) {
  try {
    if (id === null) window.localStorage.removeItem(STORAGE_KEY);
    else window.localStorage.setItem(STORAGE_KEY, id);
  } catch {
    /* storage unavailable: the host still works for this page lifetime */
  }
}

interface HostState {
  sessionId: string | null;
  command: HostCommand | null;
  setMissing: () => void;
}

const HostStateContext = createContext<HostState | null>(null);

export function ListeningHostProvider({ children }: { children: ReactNode }) {
  const [sessionId, setSessionId] = useState<string | null>(() => readStoredSession());
  const [command, setCommand] = useState<HostCommand | null>(null);
  const [hostError, setHostError] = useState<string | null>(null);
  const sessionIdRef = useRef(sessionId);
  sessionIdRef.current = sessionId;
  const creating = useRef<Promise<string> | null>(null);
  const seq = useRef(0);

  const selectSession = useCallback((id: string | null) => {
    sessionIdRef.current = id;
    setSessionId(id);
    storeSession(id);
  }, []);

  const ensureSession = useCallback(async (): Promise<string> => {
    if (sessionIdRef.current !== null) return sessionIdRef.current;
    if (creating.current !== null) return creating.current;
    creating.current = (async () => {
      const response = await fetch("/api/library/sessions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: `Listening · ${new Date().toLocaleDateString()}` }),
      });
      if (!response.ok) {
        const body = (await response.json().catch(() => null)) as { error?: string } | null;
        throw new Error(body?.error ?? `HTTP ${response.status}`);
      }
      const created = (await response.json()).session as { id: string };
      selectSession(created.id);
      return created.id;
    })();
    try {
      return await creating.current;
    } finally {
      creating.current = null;
    }
  }, [selectSession]);

  const sendTrack = useCallback(
    async (trackId: string, kind: HostCommandKind) => {
      setHostError(null);
      try {
        await ensureSession();
        seq.current += 1;
        setCommand({ seq: seq.current, kind, trackId });
      } catch (error) {
        setHostError(`Could not start a listening session — ${error instanceof Error ? error.message : "network error"}.`);
      }
    },
    [ensureSession],
  );

  const enqueueTracks = useCallback(async (trackIds: string[], queueItemIds?: string[]) => {
    const ids = trackIds.filter((id) => id.length > 0);
    if (ids.length === 0) return false;
    setHostError(null);
    try {
      await ensureSession();
      seq.current += 1;
      setCommand({
        seq: seq.current,
        kind: "enqueue",
        trackId: ids[0],
        trackIds: ids,
        queueItemIds: queueItemIds?.length === ids.length ? queueItemIds : undefined,
      });
      return true;
    } catch (error) {
      setHostError(`Could not add to the listening order — ${error instanceof Error ? error.message : "network error"}.`);
      return false;
    }
  }, [ensureSession]);

  const refreshSession = useCallback((sessionIds: string[]) => {
    const activeId = sessionIdRef.current;
    if (activeId === null || !sessionIds.includes(activeId)) return;
    seq.current += 1;
    setCommand({ seq: seq.current, kind: "refresh", trackId: "" });
  }, []);

  const openSession = useCallback(
    (id: string) => {
      if (sessionIdRef.current !== id) selectSession(id);
    },
    [selectSession],
  );

  const setMissing = useCallback(() => selectSession(null), [selectSession]);

  const api = useMemo(
    () => ({ sessionId, sendTrack, enqueueTracks, refreshSession, openSession, hostError }),
    [sessionId, sendTrack, enqueueTracks, refreshSession, openSession, hostError],
  );
  const state = useMemo(() => ({ sessionId, command, setMissing }), [sessionId, command, setMissing]);

  return (
    <ListeningContext.Provider value={api}>
      <HostStateContext.Provider value={state}>{children}</HostStateContext.Provider>
    </ListeningContext.Provider>
  );
}

/** Routes where the full workspace shows. Everywhere else: compact dock. */
export function isWorkspaceRoute(pathname: string): boolean {
  return pathname === "/waveyard" || pathname === "/waveyard/" || pathname.startsWith("/waveyard/play/") || pathname.startsWith("/waveyard/session/");
}

/** The single mount point of the session engine. Same tree position on every route. */
export function ListeningWorkspace() {
  const state = useContext(HostStateContext);
  const api = useContext(ListeningContext);
  const { pathname } = useLocation();
  if (state === null || api === null) return null;
  const variant = isWorkspaceRoute(pathname) ? "full" : "compact";
  return (
    <div className={`waveyard-room wy-host wy-host-${variant}`}>
      {api.hostError !== null && variant === "full" && (
        <p className="sess-status wy-host-error" role="alert">{api.hostError}</p>
      )}
      {state.sessionId === null ? (
        variant === "full" ? (
          <section className="wy-workspace wy-workspace-empty" aria-label="Listening workspace">
            <span className="eyebrow">Now playing</span>
            <p>Nothing loaded. Press Play on any song below — it starts here. Pick another with Next and it lines up on the second deck.</p>
          </section>
        ) : null
      ) : (
        <Suspense fallback={variant === "full" ? <section className="wy-workspace wy-workspace-empty"><p>Loading the mixer…</p></section> : null}>
          <SessionExperience
            sessionId={state.sessionId}
            variant={variant}
            command={state.command}
            onMissing={state.setMissing}
          />
        </Suspense>
      )}
    </div>
  );
}
