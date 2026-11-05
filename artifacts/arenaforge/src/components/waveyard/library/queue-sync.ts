export interface WaveyardQueueChange {
  id: string;
  sender: string;
  affectedSessionIds: string[];
  affectedTrackIds?: string[];
  transport?: WaveyardTransportSnapshot;
}

export interface WaveyardTransportSnapshot {
  sessionId: string;
  trackId: string | null;
  positionSeconds: number;
  playing: boolean;
  action: "state" | "seek" | "speed" | "pitch";
  playbackRate?: number;
  pitchPreserving?: boolean;
  priority: "control" | "heartbeat";
  clock: number;
  updatedAt: number;
}

export interface WaveyardRemoteTransport extends WaveyardTransportSnapshot {
  sender: string;
}

type QueueChangeListener = (change: {
  affectedSessionIds: string[];
  affectedTrackIds: string[];
  transport?: WaveyardRemoteTransport;
}) => void;

const LOCAL_EVENT = "waveyard:queue-changed";
const STORAGE_KEY = "waveyard:queue-change";
const CHANNEL_NAME = "waveyard:queue-sync";

let clientId: string | null = null;
let channel: BroadcastChannel | null = null;
let logicalClock = 0;

function getClientId() {
  if (clientId !== null) return clientId;
  try {
    clientId = window.crypto.randomUUID();
  } catch {
    clientId = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  }
  return clientId;
}

function getChannel() {
  if (channel !== null || typeof window === "undefined" || typeof BroadcastChannel === "undefined") return channel;
  try {
    channel = new BroadcastChannel(CHANNEL_NAME);
  } catch {
    channel = null;
  }
  return channel;
}

function parseChange(value: unknown): WaveyardQueueChange | null {
  if (typeof value !== "object" || value === null) return null;
  const candidate = value as Partial<WaveyardQueueChange>;
  if (
    typeof candidate.id !== "string"
    || typeof candidate.sender !== "string"
    || !Array.isArray(candidate.affectedSessionIds)
    || !candidate.affectedSessionIds.every((id) => typeof id === "string")
    || (candidate.affectedTrackIds !== undefined
      && (!Array.isArray(candidate.affectedTrackIds) || !candidate.affectedTrackIds.every((id) => typeof id === "string")))
  ) return null;
  let transport: WaveyardTransportSnapshot | undefined;
  if (candidate.transport !== undefined) {
    const value = candidate.transport as Partial<WaveyardTransportSnapshot>;
    if (
      typeof value.sessionId !== "string"
      || (value.trackId !== null && typeof value.trackId !== "string")
      || typeof value.positionSeconds !== "number"
      || !Number.isFinite(value.positionSeconds)
      || value.positionSeconds < 0
      || typeof value.playing !== "boolean"
      || (value.action !== "state" && value.action !== "seek" && value.action !== "speed" && value.action !== "pitch")
      || (value.playbackRate !== undefined && (typeof value.playbackRate !== "number" || !Number.isFinite(value.playbackRate)))
      || (value.pitchPreserving !== undefined && typeof value.pitchPreserving !== "boolean")
      || (value.action === "speed" && typeof value.playbackRate !== "number")
      || (value.action === "pitch" && typeof value.pitchPreserving !== "boolean")
      || (value.priority !== "control" && value.priority !== "heartbeat")
      || typeof value.clock !== "number"
      || !Number.isSafeInteger(value.clock)
      || value.clock < 1
      || typeof value.updatedAt !== "number"
      || !Number.isFinite(value.updatedAt)
    ) return null;
    transport = {
      sessionId: value.sessionId,
      trackId: value.trackId ?? null,
      positionSeconds: value.positionSeconds,
      playing: value.playing,
      action: value.action,
      ...(typeof value.playbackRate === "number" ? { playbackRate: value.playbackRate } : {}),
      ...(typeof value.pitchPreserving === "boolean" ? { pitchPreserving: value.pitchPreserving } : {}),
      priority: value.priority,
      clock: value.clock,
      updatedAt: value.updatedAt,
    };
  }
  return {
    id: candidate.id,
    sender: candidate.sender,
    affectedSessionIds: candidate.affectedSessionIds,
    ...(candidate.affectedTrackIds ? { affectedTrackIds: candidate.affectedTrackIds } : {}),
    ...(transport ? { transport } : {}),
  };
}

function sendToOtherTabs(change: WaveyardQueueChange) {
  if (typeof window === "undefined") return;
  try {
    const activeChannel = getChannel();
    if (activeChannel !== null) {
      activeChannel.postMessage(change);
      return;
    }
  } catch {
    // Fall through to the storage event for browsers where channel posting fails.
  }
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(change));
  } catch {
    // Same-tab listeners still receive the custom event when storage is unavailable.
  }
}

function publishChange(change: Omit<WaveyardQueueChange, "id" | "sender">, notifyLocal = true) {
  if (typeof window === "undefined") return;
  const event: WaveyardQueueChange = {
    id: `${Date.now()}-${Math.random().toString(36).slice(2)}`,
    sender: getClientId(),
    ...change,
  };
  if (notifyLocal) window.dispatchEvent(new CustomEvent(LOCAL_EVENT, { detail: event }));
  sendToOtherTabs(event);
}

/** Update other tabs while keeping the initiating tab's queue UI event compatible. */
export function publishWaveyardQueueChange(affectedSessionIds: string[] = []) {
  publishChange({ affectedSessionIds: [...new Set(affectedSessionIds)] });
}

/** Refresh matching library rows in other tabs after a persisted track change. */
export function publishWaveyardLibraryTrackChange(affectedTrackIds: string[]) {
  const uniqueTrackIds = [...new Set(affectedTrackIds.filter((id) => id.length > 0))];
  if (uniqueTrackIds.length === 0) return;
  publishChange({ affectedSessionIds: [], affectedTrackIds: uniqueTrackIds }, false);
}

/** Publish a causally ordered transport snapshot to the other session tabs. */
export function publishWaveyardTransportChange(
  snapshot: Omit<WaveyardTransportSnapshot, "clock" | "updatedAt">,
): WaveyardRemoteTransport | null {
  if (typeof window === "undefined") return null;
  if (snapshot.priority === "control") logicalClock += 1;
  if (logicalClock < 1) logicalClock = 1;
  const sender = getClientId();
  const transport = { ...snapshot, clock: logicalClock, updatedAt: Date.now() };
  sendToOtherTabs({
    id: `${Date.now()}-${Math.random().toString(36).slice(2)}`,
    sender,
    affectedSessionIds: [snapshot.sessionId],
    transport,
  });
  return { ...transport, sender };
}

/** Re-read saved state on return even if suspension dropped every live notice. */
export function subscribeToWaveyardResume(listener: () => void) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const onReturn = () => {
    if (document.visibilityState === "hidden" || timer !== undefined) return;
    // Focus, pageshow and visibilitychange often arrive together.
    timer = setTimeout(() => {
      timer = undefined;
      if (document.visibilityState !== "hidden") listener();
    }, 0);
  };
  document.addEventListener("visibilitychange", onReturn);
  window.addEventListener("focus", onReturn);
  window.addEventListener("pageshow", onReturn);
  return () => {
    clearTimeout(timer);
    document.removeEventListener("visibilitychange", onReturn);
    window.removeEventListener("focus", onReturn);
    window.removeEventListener("pageshow", onReturn);
  };
}

export function subscribeToWaveyardQueueChanges(listener: QueueChangeListener) {
  const seen = new Set<string>();
  const onLocal = (event: Event) => {
    const change = parseChange((event as CustomEvent<unknown>).detail);
    listener({
      affectedSessionIds: change?.affectedSessionIds ?? [],
      affectedTrackIds: change?.affectedTrackIds ?? [],
    });
  };
  const onRemote = (value: unknown) => {
    const change = parseChange(value);
    if (change === null || change.sender === getClientId() || seen.has(change.id)) return;
    seen.add(change.id);
    if (seen.size > 32) seen.delete(seen.values().next().value!);
    if (change.transport) logicalClock = Math.max(logicalClock, change.transport.clock);
    listener({
      affectedSessionIds: change.affectedSessionIds,
      affectedTrackIds: change.affectedTrackIds ?? [],
      ...(change.transport ? { transport: { ...change.transport, sender: change.sender } } : {}),
    });
  };
  const onStorage = (event: StorageEvent) => {
    if (event.key !== STORAGE_KEY || event.newValue === null) return;
    try {
      onRemote(JSON.parse(event.newValue));
    } catch {
      // Ignore malformed storage events; the next queue change can refresh state.
    }
  };
  const activeChannel = getChannel();
  const onMessage = (event: MessageEvent<unknown>) => onRemote(event.data);

  window.addEventListener(LOCAL_EVENT, onLocal);
  window.addEventListener("storage", onStorage);
  activeChannel?.addEventListener("message", onMessage);
  return () => {
    window.removeEventListener(LOCAL_EVENT, onLocal);
    window.removeEventListener("storage", onStorage);
    activeChannel?.removeEventListener("message", onMessage);
  };
}
