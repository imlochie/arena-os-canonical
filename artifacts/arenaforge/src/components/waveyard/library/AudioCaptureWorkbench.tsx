"use client";

import { useEffect, useState } from "react";
import type { LibraryAudioCaptureSignal, LibraryAudioCaptureApplication } from "@workspace/api-client-react";

type CaptureDevice = {
  id: string;
  name: string;
  isDefault: boolean;
};

type CaptureFormat = {
  sampleRate: number;
  channels: number;
  bitsPerSample: number;
  blockAlign: number;
};

type CaptureStorageBudget = {
  availableBytes: number;
  reserveBytes: number;
  canRecord: boolean;
  reason?: string;
};

type CaptureSession = {
  sessionId: string;
  status: "starting" | "recording" | "stopping" | "completed" | "failed";
  title: string;
  captureMode?: "system-loopback" | "process-loopback";
  processId?: number;
  startedAt?: string;
  elapsedSeconds: number;
  discontinuityCount: number;
  availableBytes?: number;
  reserveBytes?: number;
  estimatedSecondsRemaining?: number;
  format?: CaptureFormat;
  message?: string;
  signal?: LibraryAudioCaptureSignal;
};

type Recovery = {
  sessionId: string;
  title: string;
  artist?: string;
  album?: string;
  createdAt: string;
  signal?: LibraryAudioCaptureSignal;
};

function signalWarning(signal?: LibraryAudioCaptureSignal): string {
  return signal && signal.state !== "unsupported" && !signal.signalSeen
    ? " Warning: no signal above -80 dBFS was detected. Automatic stem separation was not requested for this capture. Listen to the file before relying on it; check playback and the selected device before recording again."
    : "";
}

type CaptureOptions = {
  available: boolean;
  devices: CaptureDevice[];
  applications?: LibraryAudioCaptureApplication[];
  processLoopbackSupported?: boolean;
  processLoopbackReason?: string;
  reason?: string;
  storage?: CaptureStorageBudget;
  activeSession?: CaptureSession;
  recoveries?: Recovery[];
  recoveryError?: string;
};

async function readJson(response: Response): Promise<Record<string, any>> {
  return response.json().catch(() => ({}));
}

function formatElapsed(seconds: number): string {
  const safe = Math.max(0, Math.floor(seconds));
  const hours = Math.floor(safe / 3600);
  const minutes = Math.floor((safe % 3600) / 60);
  const remaining = safe % 60;
  return hours
    ? `${hours}:${String(minutes).padStart(2, "0")}:${String(remaining).padStart(2, "0")}`
    : `${minutes}:${String(remaining).padStart(2, "0")}`;
}

function formatPcm(format?: CaptureFormat): string {
  if (!format) return "Native Windows output format";
  return `${format.sampleRate.toLocaleString()} Hz · ${format.channels} ch · ${format.bitsPerSample}-bit PCM`;
}

function formatBytes(bytes?: number): string {
  if (bytes === undefined || !Number.isFinite(bytes) || bytes < 0) return "Unknown";
  const gib = 1024 ** 3;
  if (bytes < 1024 ** 2) return `${Math.floor(bytes / 1024)} KiB`;
  return bytes >= gib
    ? `${(bytes / gib).toFixed(1)} GiB`
    : `${Math.round(bytes / (1024 ** 2))} MiB`;
}

export function AudioCaptureWorkbench({ onCaptured }: { onCaptured: () => void }) {
  const [options, setOptions] = useState<CaptureOptions | null>(null);
  const [session, setSession] = useState<CaptureSession | null>(null);
  const [deviceId, setDeviceId] = useState("");
  const [captureMode, setCaptureMode] = useState<"application" | "output">("output");
  const [applicationKey, setApplicationKey] = useState("");
  const [title, setTitle] = useState("");
  const [artist, setArtist] = useState("");
  const [album, setAlbum] = useState("");
  const [rightsReviewed, setRightsReviewed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  const refreshOptions = async (signal?: AbortSignal) => {
    const response = await fetch("/api/library/audio-capture", {
      cache: "no-store",
      signal,
    });
    const data = await readJson(response);
    if (!response.ok) throw new Error(data.error ?? "Could not check Windows audio capture.");
    const next = data as CaptureOptions;
    setOptions(next);
    if (next.activeSession) setSession(next.activeSession);
    const fallbackDeviceId = next.devices.find((device) => device.isDefault)?.id ?? next.devices[0]?.id ?? "";
    setDeviceId((current) =>
      next.devices.some((device) => device.id === current) ? current : fallbackDeviceId);
    setApplicationKey((current) => next.applications?.some((app) =>
      `${app.processId}:${app.processStartTime}` === current) ? current : "");
    return next;
  };

  useEffect(() => {
    const controller = new AbortController();
    void refreshOptions(controller.signal).catch((error: unknown) => {
      if (!controller.signal.aborted) {
        setMessage(error instanceof Error ? error.message : "Could not check audio capture.");
      }
    });
    return () => controller.abort();
  }, []);

  useEffect(() => {
    if (!session || !["starting", "recording", "stopping"].includes(session.status)) return;
    let cancelled = false;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const poll = async () => {
      try {
        const response = await fetch(`/api/library/audio-capture/${encodeURIComponent(session.sessionId)}`, {
          cache: "no-store",
        });
        const data = await readJson(response);
        if (!response.ok && response.status === 404) {
          const latest = await refreshOptions();
          if (cancelled) return;
          setSession(latest.activeSession ?? null);
          const preserved = latest.recoveries?.some((recovery) => recovery.sessionId === session.sessionId);
          setMessage(preserved
            ? "Recording stopped unexpectedly. Its preserved audio is ready to recover below."
            : "The recording session is no longer available. Check preserved recordings below.");
          return;
        }
        if (!response.ok) throw new Error(data.error ?? "Could not update recording status.");
        if (cancelled) return;
        const updated = data as CaptureSession;
        setSession(updated);
        if (updated.status === "failed" || updated.status === "completed") {
          if (updated.message) setMessage(updated.message);
          void refreshOptions().catch(() => {});
          return;
        }
        timeout = setTimeout(() => void poll(), 1000);
      } catch (error) {
        if (!cancelled) {
          setMessage(error instanceof Error ? error.message : "Could not update recording status.");
          timeout = setTimeout(() => void poll(), 2500);
        }
      }
    };
    timeout = setTimeout(() => void poll(), 1000);
    return () => {
      cancelled = true;
      if (timeout) clearTimeout(timeout);
    };
  }, [session?.sessionId, session?.status]);

  const start = async () => {
    if (!options?.available || !rightsReviewed || !title.trim() || busy) return;
    const application = options.applications?.find((app) =>
      `${app.processId}:${app.processStartTime}` === applicationKey);
    if (captureMode === "application" && (!options.processLoopbackSupported || !application)) return;
    if (captureMode === "output" && !deviceId) return;
    setBusy(true);
    setMessage(null);
    try {
      const response = await fetch("/api/library/audio-capture", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          title: title.trim(),
          artist: artist.trim() || undefined,
          album: album.trim() || undefined,
          ...(captureMode === "application" && application
            ? { processId: application.processId, processStartTime: application.processStartTime }
            : { deviceId }),
          rightsReviewed: true,
        }),
      });
      const data = await readJson(response);
      if (!response.ok) throw new Error(data.error ?? `Could not start recording (${response.status}).`);
      setSession({ title: title.trim(), elapsedSeconds: 0, discontinuityCount: 0, ...data } as CaptureSession);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Could not start Windows audio capture.");
      void refreshOptions().catch(() => {});
    } finally {
      setBusy(false);
    }
  };

  const stop = async () => {
    if (!session || busy) return;
    setBusy(true);
    setMessage(null);
    try {
      const response = await fetch(`/api/library/audio-capture/${encodeURIComponent(session.sessionId)}/stop`, {
        method: "POST",
      });
      const data = await readJson(response);
      if (!response.ok) throw new Error(data.error ?? `Could not finalize recording (${response.status}).`);
      const warning = signalWarning(data.signal);
      setMessage(`${data.track?.title ?? title} was added to Waveyard${data.separationQueued ? " and queued for stem separation" : ""}.${warning}`);
      setSession(null);
      setTitle("");
      setArtist("");
      setAlbum("");
      setRightsReviewed(false);
      await refreshOptions();
      onCaptured();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Could not finalize the recording.");
      void refreshOptions().catch(() => {});
    } finally {
      setBusy(false);
    }
  };

  const importRecovery = async (recovery: Recovery) => {
    if (busy) return;
    setBusy(true);
    setMessage(null);
    try {
      const response = await fetch(
        `/api/library/audio-capture/recoveries/${encodeURIComponent(recovery.sessionId)}/import`,
        { method: "POST" },
      );
      const data = await readJson(response);
      if (!response.ok) throw new Error(data.error ?? "Could not import the preserved recording.");
      setMessage(`${data.track?.title ?? recovery.title} was recovered into your Waveyard library.${signalWarning(data.signal)}`);
      await refreshOptions();
      onCaptured();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Could not import the preserved recording.");
    } finally {
      setBusy(false);
    }
  };

  const refreshDevices = async () => {
    if (busy) return;
    setBusy(true);
    setMessage(null);
    try {
      await refreshOptions();
      setMessage("Applications, playback devices and preserved recordings are up to date.");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Could not refresh Windows playback devices.");
    } finally {
      setBusy(false);
    }
  };

  const recording = session && ["starting", "recording", "stopping"].includes(session.status);
  const recoveries = (options?.recoveries ?? []).filter((recovery) =>
    !(session?.status === "completed" && recovery.sessionId === session.sessionId));
  const canStartSource = captureMode === "application"
    ? options?.processLoopbackSupported && !!applicationKey : !!deviceId;

  return (
    <section className="library-audio-backup library-audio-capture" aria-label="Record Windows playback">
      <div className="library-audio-capture-heading">
        <div>
          <strong>Record Windows playback</strong>
          <p>Record one application or a whole output directly into your Waveyard library.</p>
        </div>
        {session?.status === "recording" && (
          <span className="library-audio-capture-live" role="status">
            <span aria-hidden="true" /> Recording · {formatElapsed(session.elapsedSeconds)}
          </span>
        )}
        {!recording && (
          <button type="button" className="library-audio-capture-refresh" onClick={() => void refreshDevices()} disabled={busy}>
            Refresh devices
          </button>
        )}
      </div>

      <p className="library-audio-capture-notice">
        Application mode includes the selected process and its children across outputs; other apps are excluded.
        Whole-output mode includes every app routed through that device, including notifications.
        Protected or blocked output may be unavailable. Windows may already have mixed or resampled the source;
        application capture uses 48 kHz stereo float PCM, not necessarily the source format.
        Whole-output capture uses the endpoint mix format. Neither guarantees bit-perfect source audio.
        Record only audio you are authorized to capture.
      </p>

      {session && (
        <div className={`library-audio-capture-session is-${session.status}`} role="status" aria-live="polite">
          <div>
            <strong>{session.title}</strong>
            {session.captureMode && <span>{session.captureMode === "process-loopback"
              ? `Application process ${session.processId} and its children` : "Whole-output recording · includes other apps"}</span>}
            <span>{formatPcm(session.format)}</span>
            {session.signal && (
              <span data-testid="capture-signal">
                <meter aria-label="Captured audio peak" min={0} max={1} value={session.signal.peak} />
                {" "}
                {session.signal.state === "active" ? "Audio signal detected"
                  : session.signal.state === "silent" ? "PCM received, but no signal above -80 dBFS"
                  : session.signal.state === "unsupported" ? "Signal monitoring unavailable for this PCM format"
                  : "No PCM arriving from the playback device"}
                {" · "}{formatElapsed(session.signal.capturedSeconds)} of audio received
                {session.signal.state !== "unsupported" && !session.signal.signalSeen && session.elapsedSeconds >= 5 && (
                  <span className="library-audio-capture-warning">
                    Check that audio is playing through the selected output. Protected output may be unavailable; this recorder does not bypass it.
                  </span>
                )}
                {session.signal.clippedSamples > 0 && (
                  <span className="library-audio-capture-warning">
                    {session.signal.clippedSamples.toLocaleString()} samples reached full scale; check the playback level for distortion.
                  </span>
                )}
                {session.signal.invalidSamples > 0 && (
                  <span className="library-audio-capture-warning">
                    Invalid audio samples detected. Listen to this recording before relying on it.
                  </span>
                )}
              </span>
            )}
            {session.discontinuityCount > 0 && (
              <span className="library-audio-capture-warning">
                {session.discontinuityCount} audio interruption{session.discontinuityCount === 1 ? "" : "s"} detected.
              </span>
            )}
            {session.availableBytes !== undefined && session.reserveBytes !== undefined && (
              <span>
                {formatBytes(session.availableBytes)} free · {session.estimatedSecondsRemaining === undefined
                  ? "checking safe recording time"
                  : `about ${formatElapsed(session.estimatedSecondsRemaining)} before the disk reserve`}
              </span>
            )}
            {session.message && (
              <span className="library-audio-capture-warning">
                {session.message}
              </span>
            )}
          </div>
          {(recording || session.status === "completed") && (
            <button type="button" onClick={() => void stop()} disabled={busy || !["recording", "completed"].includes(session.status)}>
              {busy || session.status === "stopping" ? "Finalizing…" : session.status === "completed"
                ? "Add captured audio to library" : "Stop and add to library"}
            </button>
          )}
        </div>
      )}

      {!recording && session?.status !== "completed" && (
        <div className="library-audio-capture-form">
          {options?.storage && (
            <p className="library-audio-capture-notice" role="status">
              {formatBytes(options.storage.availableBytes)} free on Arena’s data drive. Waveyard keeps
              {" "}{formatBytes(options.storage.reserveBytes)} available and stops a recording before using that reserve.
              The estimate changes if other apps use the drive.
            </p>
          )}
          <label>
            Capture source
            <select aria-label="Capture source" value={captureMode}
              onChange={(event) => setCaptureMode(event.target.value as "application" | "output")}
              disabled={busy}>
              <option value="output">Whole output · includes other apps</option>
              <option value="application" disabled={!options?.processLoopbackSupported}>One application · exclude other apps</option>
            </select>
          </label>
          {!options?.processLoopbackSupported && (
            <p className="library-audio-capture-notice">
              {options?.processLoopbackReason ?? "Application isolation requires the packaged Windows host and Windows build 20348 or later."}
            </p>
          )}
          {captureMode === "application" ? <label>
            Windows application
            <select aria-label="Windows application" value={applicationKey}
              onChange={(event) => setApplicationKey(event.target.value)} disabled={busy || !options?.available}>
              <option value="">Select a running application</option>
              {options?.applications?.map((app) => <option
                key={`${app.processId}:${app.processStartTime}`} value={`${app.processId}:${app.processStartTime}`}>
                {app.name} · PID {app.processId}
              </option>)}
            </select>
            <span>Includes child processes. For browsers, select the parent browser process; multiple tabs may share it.
              If the app restarts, refresh and select it again. Nothing switches to whole-output capture automatically.</span>
          </label> : <label>
            Windows playback device
            <select
              aria-label="Windows playback device"
              value={deviceId}
              onChange={(event) => setDeviceId(event.target.value)}
              disabled={!options?.available || busy}
            >
              {options?.devices.length === 0 && (
                <option value="">{options?.reason ?? "Checking playback devices…"}</option>
              )}
              {options?.devices.map((device) => (
                <option key={device.id} value={device.id}>
                  {device.name}{device.isDefault ? " · Default" : ""}
                </option>
              ))}
            </select>
          </label>}
          <label>
            Track title
            <input
              aria-label="Track title"
              value={title}
              onChange={(event) => setTitle(event.target.value)}
              maxLength={200}
              placeholder="Name this recording"
              disabled={busy}
            />
          </label>
          <label>
            Artist <span className="optional-label">optional</span>
            <input
              aria-label="Artist"
              value={artist}
              onChange={(event) => setArtist(event.target.value)}
              maxLength={200}
              disabled={busy}
            />
          </label>
          <label>
            Album <span className="optional-label">optional</span>
            <input
              aria-label="Album"
              value={album}
              onChange={(event) => setAlbum(event.target.value)}
              maxLength={200}
              disabled={busy}
            />
          </label>
          <label className="track-backup-choice">
            <input
              type="checkbox"
              checked={rightsReviewed}
              onChange={(event) => setRightsReviewed(event.target.checked)}
              disabled={busy}
            />
            I own or am authorized to record this audio
          </label>
          <button
            type="button"
            onClick={() => void start()}
            disabled={!options?.available || !canStartSource || !rightsReviewed || !title.trim() || busy}
          >
            {busy ? "Starting…" : "Start recording"}
          </button>
          {!options?.available && (
            <p className="library-audio-capture-unavailable" role="status">
              {options?.reason ?? "Checking the packaged Windows capture host…"}
            </p>
          )}
        </div>
      )}

      {recoveries.length > 0 && (
        <div className="library-audio-capture-recoveries">
          <strong>Preserved recordings</strong>
          <p>These files were saved after an interrupted capture and have not been added to your library yet.</p>
          {recoveries.map((recovery) => (
            <div className="library-audio-capture-recovery" key={recovery.sessionId}>
              <div>
                <strong>{recovery.title}</strong>
                <span>{[recovery.artist, recovery.album].filter(Boolean).join(" · ") || "Metadata not provided"}</span>
                <span>
                  {!recovery.signal || recovery.signal.state === "unsupported" ? "Signal not verified; listen after recovery."
                    : recovery.signal.signalSeen ? "Audio signal was detected before this recording stopped."
                    : "No signal above -80 dBFS was detected; check playback before relying on this recording."}
                </span>
                <span>{new Date(recovery.createdAt).toLocaleString()}</span>
              </div>
              <button type="button" onClick={() => void importRecovery(recovery)} disabled={busy}>
                {busy ? "Importing…" : "Recover to library"}
              </button>
            </div>
          ))}
        </div>
      )}

      {options?.recoveryError && (
        <p className="library-audio-capture-warning" role="alert">
          Interrupted recordings could not be checked: {options.recoveryError}
        </p>
      )}
      {message && <p className="library-audio-backup-message" role="status" aria-live="polite">{message}</p>}
    </section>
  );
}
