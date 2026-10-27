export interface WaveyardQueueChange {
  id: string;
  sender: string;
  affectedSessionIds: string[];
}

type QueueChangeListener = (change: Pick<WaveyardQueueChange, "affectedSessionIds">) => void;

const LOCAL_EVENT = "waveyard:queue-changed";
const STORAGE_KEY = "waveyard:queue-change";
const CHANNEL_NAME = "waveyard:queue-sync";

let clientId: string | null = null;
let channel: BroadcastChannel | null = null;

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
  ) return null;
  return {
    id: candidate.id,
    sender: candidate.sender,
    affectedSessionIds: candidate.affectedSessionIds,
  };
}

/** Update other tabs while keeping the initiating tab's UI event compatible. */
export function publishWaveyardQueueChange(affectedSessionIds: string[] = []) {
  if (typeof window === "undefined") return;
  const change: WaveyardQueueChange = {
    id: `${Date.now()}-${Math.random().toString(36).slice(2)}`,
    sender: getClientId(),
    affectedSessionIds: [...new Set(affectedSessionIds)],
  };
  window.dispatchEvent(new CustomEvent(LOCAL_EVENT, { detail: change }));

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

export function subscribeToWaveyardQueueChanges(listener: QueueChangeListener) {
  const seen = new Set<string>();
  const onLocal = () => listener({ affectedSessionIds: [] });
  const onRemote = (value: unknown) => {
    const change = parseChange(value);
    if (change === null || change.sender === getClientId() || seen.has(change.id)) return;
    seen.add(change.id);
    if (seen.size > 32) seen.delete(seen.values().next().value!);
    listener({ affectedSessionIds: change.affectedSessionIds });
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
