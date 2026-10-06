/**
 * Web KV store — localStorage-backed implementation of the LUMA KVStore
 * contract (the RN app uses AsyncStorage; the web workspace uses the same
 * interface over localStorage). Small JSON documents only, exactly like the
 * original: image binaries are referenced by URI (blob:/data:), never stored.
 */

export interface KVStore {
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string): Promise<void>;
  removeItem(key: string): Promise<void>;
}

/** In-memory store for tests and non-browser environments. */
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

class LocalStorageKVStore implements KVStore {
  async getItem(key: string): Promise<string | null> {
    try {
      return window.localStorage.getItem(key);
    } catch {
      return null;
    }
  }

  async setItem(key: string, value: string): Promise<void> {
    try {
      window.localStorage.setItem(key, value);
    } catch {
      // Quota exceeded or private mode — degrade silently; the editor keeps
      // working in-memory for this session.
    }
  }

  async removeItem(key: string): Promise<void> {
    try {
      window.localStorage.removeItem(key);
    } catch {}
  }
}

let store: KVStore | null = null;

export function getKVStore(): KVStore {
  if (store) return store;
  store = typeof window !== "undefined" && !!window.localStorage ? new LocalStorageKVStore() : new MemoryKVStore();
  return store;
}

/** Test hook: inject a store. */
export function setKVStore(s: KVStore | null): void {
  store = s;
}
