/**
 * A tiny key/value storage abstraction.
 *
 * The app persists small JSON documents (projects, user presets, settings)
 * locally. We isolate the storage backend behind this interface so:
 *  - tests can inject an in-memory implementation (deterministic, no native)
 *  - the backend (AsyncStorage today) can change without touching call sites.
 *
 * Only JSON-serialisable data goes through here; large binaries (images) live on
 * the filesystem and are referenced by URI.
 */

export interface KVStore {
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string): Promise<void>;
  removeItem(key: string): Promise<void>;
}

/** In-memory store for tests and non-native environments. */
export class MemoryKVStore implements KVStore {
  private map = new Map<string, string>();

  async getItem(key: string): Promise<string | null> {
    return this.map.has(key) ? (this.map.get(key) as string) : null;
  }

  async setItem(key: string, value: string): Promise<void> {
    this.map.set(key, value);
  }

  async removeItem(key: string): Promise<void> {
    this.map.delete(key);
  }
}

let store: KVStore | null = null;

/**
 * Return the active KV store. Lazily loads AsyncStorage on device; falls back to
 * an in-memory store if the native module is unavailable (e.g. tests).
 */
export function getKVStore(): KVStore {
  if (store) return store;
  try {
    // Lazy require so tests don't need the native module.
    const AsyncStorage = require('@react-native-async-storage/async-storage').default;
    store = AsyncStorage as KVStore;
  } catch {
    store = new MemoryKVStore();
  }
  return store;
}

/** Test/DI hook. */
export function setKVStore(next: KVStore): void {
  store = next;
}
