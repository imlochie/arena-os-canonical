/**
 * Waveyard P4 — Stem2 adapter: capability truth (pure, node-testable).
 *
 * Deterministic resolution from observed facts to the honest capability
 * matrix and output-route status. No environment access, no globals, no
 * guessing: every state below is derived from facts the caller actually
 * observed (feature detection, enumeration results, routing outcomes).
 */

import type {
  Stem2CapabilityReport,
  Stem2Endpoint,
  Stem2Environment,
  Stem2OutputStatus,
  Stem2State,
} from "./types";

// ------------------------------------------------------------ detection ----

/**
 * Name heuristic ONLY: an endpoint whose label mentions "Stem 2" is a hint
 * for the user — it is never a connection claim, and the UI must present it
 * as a name match, not a device state. (Mandate: discovering a Bluetooth
 * device name is not "Stem2 connected".)
 */
const STEM2_NAME_PATTERN = /stem\s*2/i;

export function stem2NameHeuristic(label: string): boolean {
  return STEM2_NAME_PATTERN.test(label);
}

// ------------------------------------------------------- output routing ----

/** Observed facts about the output route (all real; none inferred). */
export interface OutputRoutingFacts {
  /** `enumerateDevices` exists in this runtime. */
  hasEnumerateDevices: boolean;
  /** `AudioContext.setSinkId` exists in this runtime. */
  hasContextSink: boolean;
  /** The endpoints enumeration currently reports. */
  endpoints: Stem2Endpoint[];
  /** The user's designated Stem2 output (persisted preference), if any. */
  designated: { deviceId: string; label: string } | null;
  /** The device id the last successful `setSinkId` routed to, if any. */
  routedToDeviceId: string | null;
  /** The real failure reason of the last routing attempt, if it failed. */
  lastError: string | null;
}

/**
 * Resolve the output-route status from facts. Order of precedence:
 *   1. ERROR          — a routing attempt really failed
 *   2. REQUIRES_DEVICE_CONNECTION — designated endpoint is not present
 *   3. AUDIO_ONLY     — routed: audio demonstrably flows to the endpoint,
 *                       and NO hardware control is claimed alongside it
 *   4. CONTROL_UNAVAILABLE — endpoints visible but programmatic selection
 *                       impossible (audio then follows the OS default)
 *   5. AVAILABLE      — routable, nothing routed yet
 *   6. UNSUPPORTED    — this runtime does not even expose output enumeration
 */
export function resolveOutputStatus(facts: OutputRoutingFacts): Stem2OutputStatus {
  if (!facts.hasEnumerateDevices) {
    return {
      state: "UNSUPPORTED",
      designatedLabel: facts.designated?.label ?? null,
      reason: "This runtime does not expose audio output enumeration, so Waveyard cannot see or select output devices.",
    };
  }
  if (facts.lastError !== null) {
    return {
      state: "ERROR",
      designatedLabel: facts.designated?.label ?? null,
      reason:
        facts.designated === null
          ? `Selecting an output failed: ${facts.lastError}`
          : `Routing to “${facts.designated.label}” failed: ${facts.lastError}`,
    };
  }
  if (facts.designated === null) {
    if (!facts.hasContextSink) {
      return {
        state: "CONTROL_UNAVAILABLE",
        designatedLabel: null,
        reason: "Output devices are visible, but this runtime cannot route audio programmatically — set your system default output and Waveyard follows it.",
      };
    }
    return {
      state: "AVAILABLE",
      designatedLabel: null,
      reason:
        facts.endpoints.length > 0
          ? "No Stem2 output selected — Waveyard plays through your system default audio device."
          : "No audio output devices are currently reported by the system.",
    };
  }
  const present = facts.endpoints.some((endpoint) => endpoint.deviceId === facts.designated?.deviceId);
  if (!present) {
    return {
      state: "REQUIRES_DEVICE_CONNECTION",
      designatedLabel: facts.designated.label,
      reason: `“${facts.designated.label}” is not currently available as an audio output. Power or pair the device — Waveyard will route to it automatically when it reappears.`,
    };
  }
  if (facts.routedToDeviceId === facts.designated.deviceId && facts.hasContextSink) {
    return {
      state: "AUDIO_ONLY",
      designatedLabel: facts.designated.label,
      reason: `Waveyard's audio plays through “${facts.designated.label}”. This is an audio-only route — no hardware control over the device is claimed.`,
    };
  }
  if (!facts.hasContextSink) {
    return {
      state: "CONTROL_UNAVAILABLE",
      designatedLabel: facts.designated.label,
      reason: `“${facts.designated.label}” is connected, but this runtime cannot route audio programmatically — set it as your system default output and Waveyard follows it.`,
    };
  }
  return {
    state: "AVAILABLE",
    designatedLabel: facts.designated.label,
    reason: `“${facts.designated.label}” is available — selecting it routes Waveyard's audio to the device.`,
  };
}

// ------------------------------------------------------ capability matrix ---

/**
 * The honest capability matrix, derived from detected environment facts.
 * `CONNECTED` is deliberately NEVER produced here: it is reserved for a
 * control path demonstrably verified on hardware, which does not exist in
 * v1 (see the plan's research section).
 */
export function stem2CapabilityMatrix(env: Stem2Environment): Stem2CapabilityReport[] {
  const reports: Stem2CapabilityReport[] = [];

  if (!env.hasEnumerateDevices) {
    reports.push({
      key: "audio-output",
      title: "Audio output",
      state: "UNSUPPORTED",
      reason: "This runtime does not expose audio output devices.",
      verification: "verified-locally",
    });
  } else if (!env.hasContextSink) {
    reports.push({
      key: "audio-output",
      title: "Audio output",
      state: "CONTROL_UNAVAILABLE",
      reason: "Output devices are visible, but this runtime cannot route audio programmatically. Audio follows the system default output.",
      verification: "verified-locally",
    });
  } else {
    reports.push({
      key: "audio-output",
      title: "Audio output",
      state: "AVAILABLE",
      reason: "Waveyard can route its full audio graph (player, sessions, Studio) to any output device the system exposes — a paired Stem2 appears here.",
      verification: "verified-locally",
    });
  }

  reports.push(
    env.hasMediaSession
      ? {
          key: "hardware-media-keys",
          title: "Hardware play/pause/skip",
          state: "AVAILABLE",
          reason: "The standard OS media-key path is wired, so hardware that sends play/pause/next/previous commands controls Waveyard. Whether Stem2's buttons emit these commands requires on-device verification.",
          verification: "hardware-pending",
        }
      : {
          key: "hardware-media-keys",
          title: "Hardware play/pause/skip",
          state: "UNSUPPORTED",
          reason: "This runtime does not expose the media-key interface.",
          verification: "documented-absent",
        },
  );

  reports.push({
    key: "device-volume",
    title: "Device volume",
    state: "UNSUPPORTED",
    reason: "No interface exists to control a remote speaker's hardware volume. Waveyard's volume control is application-side and never labeled as device volume.",
    verification: "documented-absent",
  });

  reports.push({
    key: "stem-controls",
    title: "Stem controls on the device",
    state: "UNSUPPORTED",
    reason: "No public control API exists. Stem2's own stem keys act on STEM.FM content, not on audio sent over Bluetooth. Stem mixes stay authoritative in Waveyard — and that is exactly what you hear.",
    verification: "documented-absent",
  });

  reports.push({
    key: "device-status",
    title: "Battery, firmware, Wi-Fi",
    state: "UNSUPPORTED",
    reason: "Device status is not exposed to other applications. Waveyard shows nothing rather than guessing.",
    verification: "documented-absent",
  });

  reports.push({
    key: "session-sync",
    title: "Session sync with the device",
    state: "UNSUPPORTED",
    reason: "No documented synchronization protocol exists. The session engine stays authoritative; the device receives the resulting audio.",
    verification: "documented-absent",
  });

  return reports;
}

/** Convenience for panels: the human phrase for a state. */
export function describeStem2State(state: Stem2State): string {
  switch (state) {
    case "AVAILABLE":
      return "available";
    case "CONNECTED":
      return "connected (verified control)";
    case "AUDIO_ONLY":
      return "audio routed";
    case "CONTROL_UNAVAILABLE":
      return "visible, not controllable";
    case "UNSUPPORTED":
      return "unsupported";
    case "REQUIRES_DEVICE_CONNECTION":
      return "waiting for the device";
    case "ERROR":
      return "routing error";
  }
}
