"use client";

/**
 * Waveyard P4 — Stem2 audio-output routing (the one real v1 capability).
 *
 * Routes Waveyard's EXISTING Web Audio graphs to a chosen OS audio output
 * endpoint (a paired Stem2 appears as one) via `AudioContext.setSinkId`.
 * There is no second playback engine: the P2 player and the P3 session
 * engine keep running unchanged; only the physical output changes.
 *
 * Reaching the engine's contexts without modifying it: `useStemTransport`
 * and `useArrangementPreview` construct `new AudioContext()` on the global.
 * `installRoutedAudioContext` swaps the global constructor for a registering
 * subclass (idempotent). When NO route is active, nothing is ever called on
 * any context — the stock engine behavior is preserved bit-for-bit.
 *
 * Observability: endpoint presence via `enumerateDevices` + `devicechange`.
 * A Bluetooth name is never treated as a connection claim. Persistence is
 * machine-local (Chromium device ids are per-install values, not session
 * semantics), mirroring the arena-handoff-drafts storage pattern.
 */

import {
  resolveOutputStatus,
  stem2CapabilityMatrix,
  type OutputRoutingFacts,
} from "./capability";
import type {
  Stem2CapabilityReport,
  Stem2Endpoint,
  Stem2Environment,
  Stem2OutputStatus,
  Stem2RuntimeState,
} from "./types";

// --------------------------------------------------------------- plumbing --

export interface AudioContextLike {
  setSinkId?(sinkId: string): Promise<void>;
  sinkId?: string;
  close?(): Promise<unknown>;
  addEventListener?(type: "statechange", listener: () => void): void;
  removeEventListener?(type: "statechange", listener: () => void): void;
}

export type AudioContextCtor = new (options?: unknown) => AudioContextLike;

export interface MediaDevicesLike {
  enumerateDevices(): Promise<Array<{ deviceId?: string; label?: string; groupId?: string; kind?: string }>>;
  addEventListener?(type: "devicechange", listener: () => void): void;
  removeEventListener?(type: "devicechange", listener: () => void): void;
}

export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

const STORAGE_KEY = "waveyard.stem2.output.v1";
const DEFAULT_SINK = "";

// --------------------------------------------------- context interception --

/**
 * Patch `target.AudioContext` (in the app: `window`) so every context the
 * unmodified engine creates registers itself with the routing service.
 * Idempotent: a second call on an already-patched target is a no-op.
 */
export function installRoutedAudioContext(
  target: { AudioContext?: AudioContextCtor },
  register: (context: AudioContextLike) => void,
): boolean {
  const Native = target.AudioContext;
  if (typeof Native !== "function") return false;
  const marker = Native as AudioContextCtor & { __stem2Routed?: boolean };
  if (marker.__stem2Routed === true) return true;
  class RoutedAudioContext extends Native {
    constructor(options?: unknown) {
      super(options);
      register(this);
    }
  }
  (RoutedAudioContext as AudioContextCtor & { __stem2Routed?: boolean }).__stem2Routed = true;
  target.AudioContext = RoutedAudioContext;
  return true;
}

// ------------------------------------------------------------ controller ---

export interface Stem2RoutingController {
  getState(): Stem2RuntimeState;
  subscribe(listener: (state: Stem2RuntimeState) => void): () => void;
  /** Re-enumerate endpoints and reconcile the route (devicechange, startup). */
  refresh(): Promise<void>;
  /** Designate an endpoint and route all live audio graphs to it. */
  select(deviceId: string): Promise<void>;
  /** Return to the system default output and forget the designation. */
  clear(): Promise<void>;
  /** Test-only: number of live registered contexts. */
  liveContextCount(): number;
}

export interface RoutingDeps {
  mediaDevices: MediaDevicesLike | null;
  storage: StorageLike | null;
  /** Patch target for context interception; null skips installation. */
  installTarget?: { AudioContext?: AudioContextCtor } | null;
  /** Whether the standard media-key interface exists (detected by the
   * caller; injected so tests stay hermetic). Default: false. */
  hasMediaSession?: boolean;
}

interface PersistedRoute {
  deviceId: string;
  label: string;
}

function readPersisted(storage: StorageLike | null): PersistedRoute | null {
  if (storage === null) return null;
  try {
    const raw = storage.getItem(STORAGE_KEY);
    if (raw === null) return null;
    const parsed = JSON.parse(raw) as { deviceId?: unknown; label?: unknown };
    if (typeof parsed.deviceId !== "string" || parsed.deviceId.length === 0 || parsed.deviceId.length > 256) return null;
    if (typeof parsed.label !== "string" || parsed.label.length > 256) return null;
    return { deviceId: parsed.deviceId, label: parsed.label };
  } catch {
    return null;
  }
}

function writePersisted(storage: StorageLike | null, route: PersistedRoute | null): void {
  if (storage === null) return;
  try {
    if (route === null) storage.removeItem(STORAGE_KEY);
    else storage.setItem(STORAGE_KEY, JSON.stringify(route));
  } catch {
    // Storage may be unavailable (private mode, quota) — routing still works
    // for this session; persistence is best-effort by design.
  }
}

/**
 * Create the routing controller. All environment access is injected, so the
 * unit tests drive it with an explicitly simulated environment (never
 * presented as hardware verification).
 */
export function createStem2Routing(deps: RoutingDeps): Stem2RoutingController {
  const contexts = new Set<AudioContextLike>();
  const listeners = new Set<(state: Stem2RuntimeState) => void>();
  const environment: Stem2Environment = {
    hasEnumerateDevices: deps.mediaDevices !== null && typeof deps.mediaDevices.enumerateDevices === "function",
    hasDeviceChangeEvents:
      deps.mediaDevices !== null && typeof deps.mediaDevices.addEventListener === "function",
    hasContextSink: false, // resolved below against the REAL constructor
    hasMediaSession: deps.hasMediaSession === true,
  };

  // Feature-detect setSinkId against the actual constructor we will patch —
  // never assume from the name of the runtime. A prototype check needs no
  // instance (no AudioContext is created before the engine itself plays).
  const probeTarget = deps.installTarget ?? null;
  environment.hasContextSink =
    probeTarget?.AudioContext !== undefined
    && typeof probeTarget.AudioContext.prototype.setSinkId === "function";

  let route: PersistedRoute | null = readPersisted(deps.storage);
  let routedTo: string | null = null;
  let lastError: string | null = null;
  let endpoints: Stem2Endpoint[] = [];
  let capabilities: Stem2CapabilityReport[] = stem2CapabilityMatrix(environment);
  let status: Stem2OutputStatus = resolveOutputStatus({
    hasEnumerateDevices: environment.hasEnumerateDevices,
    hasContextSink: environment.hasContextSink,
    endpoints,
    designated: route,
    routedToDeviceId: routedTo,
    lastError,
  });
  const emit = () => {
    const state: Stem2RuntimeState = {
      environment,
      endpoints,
      status,
      designatedDeviceId: route?.deviceId ?? null,
      capabilities,
    };
    for (const listener of listeners) listener(state);
  };

  const recomputeStatus = () => {
    status = resolveOutputStatus({
      hasEnumerateDevices: environment.hasEnumerateDevices,
      hasContextSink: environment.hasContextSink,
      endpoints,
      designated: route,
      routedToDeviceId: routedTo,
      lastError,
    });
    emit();
  };

  const register = (context: AudioContextLike) => {
    contexts.add(context);
    // A closed context never routes; drop it when the runtime tells us.
    context.addEventListener?.("statechange", () => {
      if ((context as AudioContextLike & { state?: string }).state === "closed") contexts.delete(context);
    });
    // Contexts created AFTER a route exists get the route immediately —
    // and if applying it fails NOW, the status must say so.
    if (route !== null && routedTo === route.deviceId) {
      void applySinkToContext(context, route.deviceId).then((ok) => {
        if (!ok) recomputeStatus();
      });
    }
  };

  const applySinkToContext = async (context: AudioContextLike, deviceId: string): Promise<boolean> => {
    if (typeof context.setSinkId !== "function") return false;
    try {
      await context.setSinkId(deviceId);
      return true;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
      return false;
    }
  };

  const applySinkEverywhere = async (deviceId: string): Promise<boolean> => {
    if (contexts.size === 0) {
      // No live graphs yet (nothing played): the route still counts once a
      // context appears (register applies it). Record the intent.
      return true;
    }
    const outcomes = await Promise.all(
      [...contexts].map((context) => applySinkToContext(context, deviceId)),
    );
    return outcomes.every((ok) => ok);
  };

  const reconcile = async () => {
    // Chromium device ids are normally stable per install, but a changed id
    // (new OS pairing, profile reset) with the SAME label is the same
    // physical device: restore by label so the route survives.
    if (route !== null && !endpoints.some((endpoint) => endpoint.deviceId === route?.deviceId)) {
      const byLabel = endpoints.find((endpoint) => endpoint.label !== "" && endpoint.label === route?.label);
      if (byLabel !== undefined) {
        route = { deviceId: byLabel.deviceId, label: byLabel.label };
        writePersisted(deps.storage, route);
      }
    }
    const facts: OutputRoutingFacts = {
      hasEnumerateDevices: environment.hasEnumerateDevices,
      hasContextSink: environment.hasContextSink,
      endpoints,
      designated: route,
      routedToDeviceId: routedTo,
      lastError,
    };
    const next = resolveOutputStatus(facts);
    // Auto-restore: the designated endpoint (re)appeared but the route has
    // not been applied (reconnect, app restart) → route now.
    if (
      route !== null
      && environment.hasContextSink
      && endpoints.some((endpoint) => endpoint.deviceId === route?.deviceId)
      && next.state === "AVAILABLE"
    ) {
      lastError = null;
      const ok = await applySinkEverywhere(route.deviceId);
      if (ok) routedTo = route.deviceId;
    }
    status = resolveOutputStatus({
      hasEnumerateDevices: environment.hasEnumerateDevices,
      hasContextSink: environment.hasContextSink,
      endpoints,
      designated: route,
      routedToDeviceId: routedTo,
      lastError,
    });
    emit();
  };

  // Serialize async operations so select/refresh/devicechange never
  // interleave. The chain itself never rejects; the caller's promise does.
  let queue: Promise<void> = Promise.resolve();
  const run = (operation: () => Promise<void>): Promise<void> => {
    const result = queue.then(operation);
    queue = result.catch(() => undefined);
    return result;
  };

  const enumerate = async (): Promise<void> => {
    if (deps.mediaDevices === null) return;
    try {
      const devices = await deps.mediaDevices.enumerateDevices();
      endpoints = devices
        .filter((device) => device.kind === "audiooutput" && typeof device.deviceId === "string")
        .map((device) => ({
          deviceId: device.deviceId as string,
          label: typeof device.label === "string" ? device.label : "",
          groupId: typeof device.groupId === "string" ? device.groupId : null,
        }));
    } catch {
      // Enumeration failed once — keep the last known endpoints and report
      // through the status resolver's facts; never fabricate devices.
    }
  };

  const controller: Stem2RoutingController = {
    getState() {
      return {
        environment,
        endpoints,
        status,
        designatedDeviceId: route?.deviceId ?? null,
        capabilities,
      };
    },
    subscribe(listener) {
      listeners.add(listener);
      listener(controller.getState());
      return () => listeners.delete(listener);
    },
    liveContextCount() {
      return contexts.size;
    },
    refresh() {
      return run(async () => {
        await enumerate();
        await reconcile();
      });
    },
    async select(deviceId) {
      await run(async () => {
        await enumerate();
        const endpoint = endpoints.find((item) => item.deviceId === deviceId);
        if (endpoint === undefined) {
          lastError = "that output is no longer listed by the system";
          status = resolveOutputStatus({
            hasEnumerateDevices: environment.hasEnumerateDevices,
            hasContextSink: environment.hasContextSink,
            endpoints,
            designated: route,
            routedToDeviceId: routedTo,
            lastError,
          });
          emit();
          return;
        }
        route = { deviceId: endpoint.deviceId, label: endpoint.label };
        lastError = null;
        if (environment.hasContextSink) {
          const ok = await applySinkEverywhere(endpoint.deviceId);
          if (ok) routedTo = endpoint.deviceId;
        }
        writePersisted(deps.storage, route);
        await reconcile();
      });
    },
    async clear() {
      await run(async () => {
        route = null;
        routedTo = null;
        lastError = null;
        writePersisted(deps.storage, null);
        if (environment.hasContextSink) {
          // Return every live graph to the system default output.
          await Promise.allSettled([...contexts].map((context) => context.setSinkId?.(DEFAULT_SINK)));
        }
        await reconcile();
      });
    },
  };

  // Install the context interception (app path: window). Test path may pass
  // a plain object or skip installation entirely.
  if (probeTarget?.AudioContext !== undefined) {
    installRoutedAudioContext(probeTarget, register);
  }

  // Observe real connect/disconnect when the runtime supports it.
  deps.mediaDevices?.addEventListener?.("devicechange", () => {
    void controller.refresh();
  });

  // Initial state: enumerate + reconcile (restores a persisted route).
  void controller.refresh();

  return controller;
}

// ------------------------------------------------------ browser singleton --

let singleton: Stem2RoutingController | null = null;

/** The app-wide routing controller (browser only; created once). */
export function getStem2Routing(): Stem2RoutingController | null {
  if (typeof window === "undefined") return null;
  if (singleton !== null) return singleton;
  const nav = typeof navigator === "undefined" ? undefined : navigator.mediaDevices;
  let storage: StorageLike | null = null;
  try {
    storage = window.localStorage;
  } catch {
    storage = null;
  }
  singleton = createStem2Routing({
    mediaDevices: nav ?? null,
    storage,
    installTarget: window as unknown as { AudioContext?: AudioContextCtor },
    hasMediaSession:
      typeof navigator !== "undefined"
      && "mediaSession" in navigator
      && typeof (globalThis as { MediaMetadata?: unknown }).MediaMetadata === "function",
  });
  return singleton;
}

/** Test-only: reset the singleton (simulated environments in tests). */
export function resetStem2RoutingSingleton(): void {
  singleton = null;
}
