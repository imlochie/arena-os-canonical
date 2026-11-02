import { useCallback, useEffect, useRef, useState } from "react";
import {
  decryptLocalSessionPayload,
  encryptLocalSessionPayload,
  type EncryptedLocalSessionPacket,
  type LocalRemoteCommand,
} from "./local-session-crypto";

interface LiveState {
  sessionName: string;
  trackId: string | null;
  title: string;
  artist: string;
  nextTitle: string | null;
  previousTitle: string | null;
  queue: Array<{ id: string; title: string; artist: string; durationSeconds: number }>;
  positionSeconds: number;
  durationSeconds: number;
  playing: boolean;
  updatedAt: number;
}

interface PairCredentials {
  pairingToken: string;
  key: string;
  hostSenderId: string;
  deviceToken?: string;
  deviceId?: string;
}

const SESSION_KEY = "waveyard-local-remote";

function formatTime(seconds: number) {
  const safe = Number.isFinite(seconds) ? Math.max(0, Math.floor(seconds)) : 0;
  return `${Math.floor(safe / 60)}:${String(safe % 60).padStart(2, "0")}`;
}

function readCredentials(): PairCredentials | null {
  try {
    const params = new URLSearchParams(window.location.hash.slice(1));
    const pairingToken = params.get("pair");
    const key = params.get("key");
    const hostSenderId = params.get("host");
    if (pairingToken && key && hostSenderId) {
      const credentials = { pairingToken, key, hostSenderId };
      sessionStorage.setItem(SESSION_KEY, JSON.stringify(credentials));
      history.replaceState(null, "", window.location.pathname + window.location.search);
      return credentials;
    }
    const stored = sessionStorage.getItem(SESSION_KEY);
    if (stored) return JSON.parse(stored) as PairCredentials;
    return null;
  } catch {
    return null;
  }
}

export default function WaveyardLocalRemote() {
  const [credentials, setCredentials] = useState<PairCredentials | null>(() => readCredentials());
  const [state, setState] = useState<LiveState | null>(null);
  const [position, setPosition] = useState(0);
  const [connection, setConnection] = useState<"connecting" | "connected" | "offline" | "invalid">("connecting");
  const [message, setMessage] = useState("");
  const receivedAtRef = useRef(0);
  const lastHostCounterRef = useRef(0);
  const sequenceRef = useRef(Math.floor(Date.now() * 1000 + Math.random() * 1000));
  const joinStartedRef = useRef(false);
  const deviceTokenRef = useRef<string | null>(credentials?.deviceToken ?? null);
  const deviceIdRef = useRef<string | null>(credentials?.deviceId ?? null);

  useEffect(() => {
    if (credentials === null) {
      setConnection("invalid");
      return;
    }
    let cancelled = false;
    let stream: EventSource | null = null;
    const connect = async () => {
      try {
        if (!deviceTokenRef.current) {
          if (joinStartedRef.current) return;
          joinStartedRef.current = true;
          const response = await fetch(`/join?pair=${encodeURIComponent(credentials.pairingToken)}`, {
            cache: "no-store",
          });
          const joined = await response.json() as { deviceId?: string; deviceToken?: string; error?: string };
          if (!response.ok || !joined.deviceId || !joined.deviceToken) {
            throw new Error(joined.error ?? "This QR invitation has expired.");
          }
          if (cancelled) return;
          deviceIdRef.current = joined.deviceId;
          deviceTokenRef.current = joined.deviceToken;
          const saved = { ...credentials, deviceId: joined.deviceId, deviceToken: joined.deviceToken };
          sessionStorage.setItem(SESSION_KEY, JSON.stringify(saved));
          setCredentials(saved);
          return;
        }
        if (!deviceIdRef.current || cancelled) return;
        stream = new EventSource(`/events?token=${encodeURIComponent(deviceTokenRef.current)}`);
        stream.onopen = () => setConnection("connected");
        stream.onerror = () => {
          if (stream?.readyState === EventSource.CLOSED) {
            setConnection("invalid");
            setMessage("This pairing ended or expired. Scan a fresh QR from Waveyard.");
          } else {
            setConnection("offline");
          }
        };
        stream.addEventListener("state", (event) => {
          try {
            const packet = JSON.parse((event as MessageEvent<string>).data) as EncryptedLocalSessionPacket;
            if (packet.senderId !== credentials.hostSenderId || packet.counter <= lastHostCounterRef.current) return;
            const next = decryptLocalSessionPayload<LiveState>(credentials.key, packet);
            if (
              !next
              || typeof next.sessionName !== "string"
              || typeof next.playing !== "boolean"
              || !Array.isArray(next.queue)
            ) return;
            lastHostCounterRef.current = packet.counter;
            receivedAtRef.current = performance.now();
            setState(next);
            setPosition(next.positionSeconds);
            setConnection("connected");
            setMessage("");
          } catch {
            setMessage("The session could not be verified. Rescan the QR from Waveyard.");
            setConnection("invalid");
            stream?.close();
          }
        });
      } catch (error) {
        if (cancelled) return;
        setMessage(error instanceof Error ? error.message : "Could not connect to the desktop.");
        setConnection("invalid");
      } finally {
        joinStartedRef.current = false;
      }
    };
    void connect();
    return () => {
      cancelled = true;
      stream?.close();
    };
  }, [credentials]);

  useEffect(() => {
    if (state === null) return;
    const timer = window.setInterval(() => {
      const elapsed = state.playing ? (performance.now() - receivedAtRef.current) / 1000 : 0;
      setPosition(Math.min(state.durationSeconds, state.positionSeconds + elapsed));
    }, 250);
    return () => window.clearInterval(timer);
  }, [state]);

  const send = useCallback(async (command: LocalRemoteCommand) => {
    if (!credentials || !deviceTokenRef.current || !deviceIdRef.current) return;
    try {
    sequenceRef.current += 1;
      const packet = encryptLocalSessionPayload(
        credentials.key,
        deviceIdRef.current,
        sequenceRef.current,
        command,
      );
      const response = await fetch(`/control?token=${encodeURIComponent(deviceTokenRef.current)}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ packet }),
      });
      if (!response.ok) {
        const result = await response.json().catch(() => ({})) as { error?: string };
        setMessage(result.error ?? "The desktop did not receive that control.");
      } else {
        setMessage("");
      }
    } catch {
      setMessage("Connection lost. Reopen the QR link while the desktop session is shared.");
      setConnection("offline");
    }
  }, [credentials]);

  const commitSeek = useCallback(() => {
    if (state === null) return;
    void send({ type: "seek", positionSeconds: Math.max(0, Math.min(state.durationSeconds, position)) });
  }, [position, send, state]);

  const connected = connection === "connected" && state !== null;

  return (
    <main className="wy-remote">
      <header className="wy-remote-header">
        <div className={`wy-remote-indicator ${connected ? "is-connected" : ""}`} />
        <span>{connected ? "Connected to your laptop" : connection === "connecting" ? "Connecting…" : "Connection paused"}</span>
      </header>

      <section className="wy-remote-content">
        <div className="wy-remote-brand">WAVEYARD <span>REMOTE</span></div>
        {connection === "invalid" && state === null ? (
          <div className="wy-remote-message">
            <h1>Scan the QR from Waveyard</h1>
            <p>{message || "Open the phone-share panel on the laptop to join its live session."}</p>
          </div>
        ) : (
          <>
            <p className="wy-remote-session">{state?.sessionName ?? "Waiting for the laptop…"}</p>
            <section className="wy-remote-track" aria-live="polite">
              <div className="wy-remote-disc" aria-hidden="true"><span>W</span></div>
              <h1>{state?.title ?? "Connecting to session"}</h1>
              <p>{state?.artist ?? "Keep this phone and your laptop on the same Wi-Fi."}</p>
              {state?.nextTitle && <div className="wy-remote-next">UP NEXT <b>{state.nextTitle}</b></div>}
            </section>
            {(state?.queue.length ?? 0) > 1 && (
              <section className="wy-remote-queue" aria-label="Session queue">
                <h2>Session queue <span>{state!.queue.length}</span></h2>
                <div className="wy-remote-queue-list">
                  {state!.queue.map((item) => (
                    <button
                      key={item.id}
                      type="button"
                      className={item.id === state!.trackId ? "is-current" : ""}
                      disabled={!connected}
                      onClick={() => void send({ type: "select-track", itemId: item.id })}
                    >
                      <span className="wy-remote-queue-title">{item.title}</span>
                      <small>{item.artist || "Unknown artist"}</small>
                    </button>
                  ))}
                </div>
              </section>
            )}
            <section className="wy-remote-player" aria-label="Waveyard playback controls">
              <div className="wy-remote-seek-labels"><span>{formatTime(position)}</span><span>{formatTime(state?.durationSeconds ?? 0)}</span></div>
              <input
                className="wy-remote-seek"
                aria-label="Seek current track"
                type="range"
                min={0}
                max={Math.max(1, state?.durationSeconds ?? 1)}
                step={0.25}
                value={Math.min(position, state?.durationSeconds ?? 0)}
                disabled={!connected}
                onChange={(event) => setPosition(Number(event.target.value))}
                onPointerUp={commitSeek}
                onKeyUp={commitSeek}
              />
              <div className="wy-remote-controls">
                <button type="button" aria-label="Previous track" disabled={!connected || !state?.previousTitle} onClick={() => void send({ type: "previous" })}>
                  <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 5h2v14H6zM20 5v14L9 12z" /></svg>
                </button>
                <button className="wy-remote-play" type="button" aria-label={state?.playing ? "Pause" : "Play"} disabled={!connected} onClick={() => void send({ type: "toggle-play" })}>
                  {state?.playing
                    ? <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 5h4v14H6zM14 5h4v14h-4z" /></svg>
                    : <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 4v16l13-8z" /></svg>}
                </button>
                <button type="button" aria-label="Next track" disabled={!connected || !state?.nextTitle} onClick={() => void send({ type: "next" })}>
                  <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M16 5h2v14h-2zM4 5v14l11-7z" /></svg>
                </button>
              </div>
              {message && <p className="wy-remote-alert" role="status">{message}</p>}
            </section>
          </>
        )}
      </section>

      <footer className="wy-remote-footer">
        <span>Audio stays on your laptop. Session details are encrypted between your devices.</span>
        <span>End sharing from Waveyard to disconnect this phone.</span>
      </footer>
    </main>
  );
}
