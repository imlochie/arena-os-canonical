/**
 * Types and validation for the `/api/library/audio-capture` payload.
 *
 * Split out of `AudioCaptureWorkbench` so the validation can be tested without
 * a DOM.
 *
 * Why validation exists: the component used to do `data as CaptureOptions` and
 * then `next.devices.find(...)`. When the route was not what answered -- a
 * proxy error page, a partially deployed server, or the SPA fallback serving
 * `index.html` with status 200 -- that threw `can't access property "find",
 * next.devices is undefined` out of a refresh effect: an unhandled rejection
 * rather than a reportable error, so the panel merely looked broken. The bug is
 * real whichever environment provokes it.
 */

import type { LibraryAudioCaptureSignal, LibraryAudioCaptureApplication } from "@workspace/api-client-react";

export type CaptureDevice = {
  id: string;
  name: string;
  isDefault: boolean;
};

export type CaptureFormat = {
  sampleRate: number;
  channels: number;
  bitsPerSample: number;
  blockAlign: number;
};

export type CaptureStorageBudget = {
  availableBytes: number;
  reserveBytes: number;
  canRecord: boolean;
  reason?: string;
};

export type CaptureSession = {
  markers?: Array<{ id: string; sampleFrame: number; metadata: { title: string; artist?: string; album?: string; trackNumber?: number } }>;
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

export type CaptureTags = {
  title: string;
  artist?: string;
  album?: string;
  trackNumber?: number;
  artworkDataUrl?: string;
};

export type MediaTrackSuggestion = {
  sourceAppId: string;
  metadata: CaptureTags;
};

export type Recovery = {
  sessionId: string;
  title: string;
  artist?: string;
  album?: string;
  createdAt: string;
  signal?: LibraryAudioCaptureSignal;
};

export type CaptureOptions = {
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

/**
 * Validate the capture-options payload before it is used.
 *
 * `devices` is required by `CaptureOptions`, but the response is untrusted:
 * a non-API origin, a proxy error page or a partially deployed server can
 * answer 200 with something that is not capture options at all. Previously the
 * body was cast straight to `CaptureOptions` and then `next.devices.find(...)`
 * ran, so a malformed payload became `can't access property "find",
 * next.devices is undefined` -- an unhandled rejection thrown from a refresh
 * effect rather than a reportable error. `available` was likewise read without
 * validation, so an unrelated object could present the room as usable.
 *
 * Returns null when the payload is not a capture-options object; callers treat
 * null as "unavailable with a reason", never as usable.
 */
export function parseCaptureOptions(data: unknown): CaptureOptions | null {
  if (data === null || typeof data !== "object" || Array.isArray(data)) return null;
  const payload = data as { available?: unknown; devices?: unknown };
  if (!Array.isArray(payload.devices)) return null;
  if (typeof payload.available !== "boolean") return null;
  const devices = payload.devices.filter((device: unknown): device is CaptureDevice =>
    device !== null
    && typeof device === "object"
    && typeof (device as { id?: unknown }).id === "string"
    && typeof (device as { name?: unknown }).name === "string");
  // A payload whose device list is entirely malformed is not usable either:
  // silently reporting zero devices would look like a machine with no hardware.
  if (devices.length !== payload.devices.length) return null;
  return { ...(data as CaptureOptions), devices };
}
