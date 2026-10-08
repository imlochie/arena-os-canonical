"use client";

/**
 * Waveyard P4 — the Stem2 hardware panel.
 *
 * Shows ONLY what the adapter actually observed: the real output-route
 * status, the real endpoint list, and the honest capability matrix. No
 * battery, firmware, Wi-Fi, or connection theater — those values do not
 * exist for us, so they are not rendered.
 */

import { useCallback, useEffect, useState } from "react";
import {
  describeStem2State,
  getStem2Routing,
  stem2NameHeuristic,
  type Stem2RuntimeState,
} from "@/lib/waveyard/stem2";

/** Live adapter state for one surface (client-only; null before mount). */
export function useStem2Output(): {
  state: Stem2RuntimeState | null;
  select: (deviceId: string) => void;
  clear: () => void;
} {
  const [state, setState] = useState<Stem2RuntimeState | null>(null);
  useEffect(() => {
    const controller = getStem2Routing();
    if (controller === null) return;
    const unsubscribe = controller.subscribe(setState);
    return unsubscribe;
  }, []);
  const select = useCallback((deviceId: string) => {
    void getStem2Routing()?.select(deviceId);
  }, []);
  const clear = useCallback(() => {
    void getStem2Routing()?.clear();
  }, []);
  return { state, select, clear };
}

export default function Stem2Panel() {
  const { state, select, clear } = useStem2Output();
  if (state === null) return null;

  const { environment, endpoints, status, designatedDeviceId, capabilities } = state;
  const chipClass = `stem2-chip stem2-chip-${status.state.toLowerCase().replace(/_/g, "-")}`;

  return (
    <section className="stem2-panel" aria-label="Stem2 hardware" data-testid="stem2-panel">
      <header className="stem2-head">
        <span className="eyebrow">Stem2 · hardware output</span>
        <span className={chipClass} data-testid="stem2-state">{describeStem2State(status.state)}</span>
      </header>
      <p className="stem2-status" role="status" data-testid="stem2-status">
        {status.reason}
      </p>

      {environment.hasEnumerateDevices && (
        <label className="stem2-output">
          <span className="stem2-output-label">Audio output</span>
          <select
            aria-label="Stem2 audio output device"
            value={designatedDeviceId ?? ""}
            onChange={(event) => {
              if (event.target.value === "") clear();
              else select(event.target.value);
            }}
          >
            <option value="">System default</option>
            {endpoints.map((endpoint) => (
              <option key={endpoint.deviceId} value={endpoint.deviceId}>
                {endpoint.label === ""
                  ? "Output device (name unavailable)"
                  : endpoint.label}
                {stem2NameHeuristic(endpoint.label) ? " · name matches “Stem2”" : ""}
              </option>
            ))}
          </select>
        </label>
      )}

      <ul className="stem2-caps">
        {capabilities.map((capability) => (
          <li key={capability.key} className="stem2-cap">
            <span className="stem2-cap-title">
              {capability.title}
              <span
                className={`stem2-cap-state ${
                  capability.state === "AVAILABLE" || capability.state === "AUDIO_ONLY"
                    ? "ok"
                    : capability.state === "UNSUPPORTED"
                      ? "no"
                      : "maybe"
                }`}
              >
                {capability.state}
              </span>
            </span>
            <small>
              {capability.reason}
              {capability.verification === "hardware-pending"
                ? " Status: pending on-device verification — not claimed yet."
                : ""}
            </small>
          </li>
        ))}
      </ul>
    </section>
  );
}
