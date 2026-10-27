/**
 * Waveyard P4 — Stem2 adapter boundary: types.
 *
 * Stem2 is a real Bluetooth speaker (see docs/waveyard-stem2-plan.md for the
 * research and the capability matrix). The one interface it genuinely exposes
 * to any audio application today is OS-level Bluetooth audio output, plus —
 * in all likelihood — standard Bluetooth media commands from its physical
 * playback buttons (hardware verification pending). Everything deeper is
 * undocumented or unshipped, and this adapter never pretends otherwise.
 *
 * Capability states are EXACTLY the mandated set; no richer state is invented
 * to make the UI look complete.
 */

export const STEM2_STATES = [
  "AVAILABLE",
  "CONNECTED",
  "AUDIO_ONLY",
  "CONTROL_UNAVAILABLE",
  "UNSUPPORTED",
  "REQUIRES_DEVICE_CONNECTION",
  "ERROR",
] as const;

export type Stem2State = (typeof STEM2_STATES)[number];

/** A real audio output endpoint as exposed by the OS (Chromium
 * `enumerateDevices`). `label` may be empty when the environment withholds
 * device names — surfaced honestly, never guessed. */
export interface Stem2Endpoint {
  deviceId: string;
  label: string;
  groupId: string | null;
}

/** Runtime feature facts, detected — never assumed. */
export interface Stem2Environment {
  /** `navigator.mediaDevices.enumerateDevices()` exists. */
  hasEnumerateDevices: boolean;
  /** `devicechange` events are observable. */
  hasDeviceChangeEvents: boolean;
  /** `AudioContext.prototype.setSinkId` exists (Chromium ≥ 110). */
  hasContextSink: boolean;
  /** `navigator.mediaSession` + `MediaMetadata` exist (OS media-key path). */
  hasMediaSession: boolean;
}

export const STEM2_CAPABILITY_KEYS = [
  "audio-output",
  "hardware-media-keys",
  "device-volume",
  "stem-controls",
  "device-status",
  "session-sync",
] as const;

export type Stem2CapabilityKey = (typeof STEM2_CAPABILITY_KEYS)[number];

/** One row of the honest capability matrix. */
export interface Stem2CapabilityReport {
  key: Stem2CapabilityKey;
  title: string;
  state: Stem2State;
  reason: string;
  /** How the state is backed. `hardware-pending` = real standard code path
   * wired, but on-device verification has not happened — never claimed. */
  verification: "verified-locally" | "hardware-pending" | "documented-absent";
}

/** Status of the audio-output route specifically (the one real v1 path). */
export interface Stem2OutputStatus {
  state: Extract<
    Stem2State,
    "AVAILABLE" | "AUDIO_ONLY" | "CONTROL_UNAVAILABLE" | "UNSUPPORTED" | "REQUIRES_DEVICE_CONNECTION" | "ERROR"
  >;
  /** The designated output's name, when one is designated. */
  designatedLabel: string | null;
  reason: string;
}

/** Everything the UI is allowed to know — all of it real. */
export interface Stem2RuntimeState {
  environment: Stem2Environment;
  endpoints: Stem2Endpoint[];
  status: Stem2OutputStatus;
  /** The designated output's device id (for the picker), when designated. */
  designatedDeviceId: string | null;
  capabilities: Stem2CapabilityReport[];
}
