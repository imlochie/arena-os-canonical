const ASSET_TTL_MS = 30_000;
const MAX_CACHED_ASSETS = 8;
const MAX_CACHED_BYTES = 128 * 1024 * 1024;

type AssetEntry = {
  controller: AbortController;
  promise: Promise<Blob>;
  blob: Blob | null;
  consumers: number;
  mediaLeases: number;
  settled: boolean;
  expired: boolean;
  timer: ReturnType<typeof setTimeout> | null;
  objectUrls: Set<string>;
};

export type SessionAudioMediaLease = {
  src: string;
  release: () => void;
};

/**
 * Shares private audio bytes between the standby deck's media element and
 * live-stem decoding. Nothing is written to CacheStorage or persistent storage.
 */
export class SessionAudioAssetPool {
  private entries = new Map<string, AssetEntry>();
  private retired = new Set<AssetEntry>();
  private invalidatedUrls = new Set<string>();
  private replacementListeners = new Set<(url: string) => void>();
  private cachedBytes = 0;
  private disposed = false;

  private entryFor(url: string) {
    if (this.disposed) throw new Error("The session audio asset pool has been disposed.");
    const existing = this.entries.get(url);
    if (existing) {
      this.entries.delete(url);
      this.entries.set(url, existing);
      return existing;
    }

    const controller = new AbortController();
    const entry: AssetEntry = {
      controller,
      promise: Promise.resolve(new Blob()),
      blob: null,
      consumers: 0,
      mediaLeases: 0,
      settled: false,
      expired: false,
      timer: null,
      objectUrls: new Set(),
    };
    entry.promise = fetch(url, { cache: "no-store", signal: controller.signal })
      .then(async (response) => {
        if (!response.ok) throw new Error(`Audio asset download failed (${response.status}).`);
        const blob = await response.blob();
        if (controller.signal.aborted) throw new DOMException("Audio asset loading was cancelled.", "AbortError");
        entry.blob = blob;
        this.cachedBytes += blob.size;
        entry.settled = true;
        entry.timer = setTimeout(() => {
          entry.expired = true;
          this.removeIfUnused(url, entry);
        }, ASSET_TTL_MS);
        this.trimCache();
        if (this.invalidatedUrls.delete(url)) {
          for (const listener of this.replacementListeners) listener(url);
        }
        return blob;
      })
      .catch((error: unknown) => {
        entry.settled = true;
        this.remove(url, entry);
        throw error;
      });
    this.entries.set(url, entry);
    return entry;
  }

  private waitForBlob(entry: AssetEntry, signal?: AbortSignal) {
    if (signal?.aborted) return Promise.reject(new DOMException("Audio asset loading was cancelled.", "AbortError"));
    entry.consumers += 1;
    return new Promise<Blob>((resolve, reject) => {
      let finished = false;
      const finish = (callback: () => void) => {
        if (finished) return;
        finished = true;
        signal?.removeEventListener("abort", abort);
        callback();
      };
      const abort = () => finish(() => reject(
        new DOMException("Audio asset loading was cancelled.", "AbortError"),
      ));
      signal?.addEventListener("abort", abort, { once: true });
      entry.promise.then(
        (blob) => finish(() => signal?.aborted
          ? reject(new DOMException("Audio asset loading was cancelled.", "AbortError"))
          : resolve(blob)),
        (error: unknown) => finish(() => reject(error)),
      );
    }).finally(() => {
      entry.consumers -= 1;
      if (entry.consumers === 0 && !entry.settled) entry.controller.abort();
      this.removeIfUnused("", entry);
      this.trimCache();
    });
  }

  private removeIfUnused(url: string, entry: AssetEntry) {
    if (entry.consumers > 0 || entry.mediaLeases > 0 || !entry.settled) return;
    if (entry.expired || this.disposed) {
      const key = url || [...this.entries].find(([, candidate]) => candidate === entry)?.[0];
      if (key !== undefined) this.remove(key, entry);
    }
  }

  private remove(url: string, entry: AssetEntry) {
    if (this.entries.get(url) === entry) this.entries.delete(url);
    this.retired.delete(entry);
    if (entry.timer !== null) clearTimeout(entry.timer);
    entry.timer = null;
    if (entry.blob !== null) {
      this.cachedBytes = Math.max(0, this.cachedBytes - entry.blob.size);
      entry.blob = null;
    }
    for (const objectUrl of entry.objectUrls) URL.revokeObjectURL(objectUrl);
    entry.objectUrls.clear();
  }

  private trimCache() {
    while (this.entries.size > MAX_CACHED_ASSETS || this.cachedBytes > MAX_CACHED_BYTES) {
      const oldest = [...this.entries].find(([, entry]) =>
        entry.settled && entry.consumers === 0 && entry.mediaLeases === 0,
      );
      if (!oldest) return;
      this.remove(oldest[0], oldest[1]);
    }
  }

  async readBytes(url: string, signal: AbortSignal) {
    const blob = await this.waitForBlob(this.entryFor(url), signal);
    return blob.arrayBuffer();
  }

  async preload(url: string, signal?: AbortSignal) {
    await this.waitForBlob(this.entryFor(url), signal);
  }

  /** Retry rejected audio with fresh bytes without revoking a playing deck's URL. */
  invalidate(url: string) {
    const entry = this.entries.get(url);
    if (!entry) return;
    this.entries.delete(url);
    this.invalidatedUrls.add(url);
    entry.expired = true;
    this.retired.add(entry);
    this.removeIfUnused(url, entry);
  }

  subscribeToReplacement(listener: (url: string) => void) {
    this.replacementListeners.add(listener);
    return () => { this.replacementListeners.delete(listener); };
  }

  async acquireMediaUrl(url: string, signal: AbortSignal): Promise<SessionAudioMediaLease> {
    const entry = this.entryFor(url);
    entry.mediaLeases += 1;
    try {
      const blob = await this.waitForBlob(entry, signal);
      if (signal.aborted) throw new DOMException("Audio asset loading was cancelled.", "AbortError");
      const src = URL.createObjectURL(blob);
      entry.objectUrls.add(src);
      let released = false;
      return {
        src,
        release: () => {
          if (released) return;
          released = true;
          URL.revokeObjectURL(src);
          entry.objectUrls.delete(src);
          entry.mediaLeases -= 1;
          this.removeIfUnused(url, entry);
          this.trimCache();
        },
      };
    } catch (error) {
      entry.mediaLeases -= 1;
      this.removeIfUnused(url, entry);
      throw error;
    }
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    for (const [url, entry] of this.entries) {
      entry.controller.abort();
      this.remove(url, entry);
    }
    for (const entry of this.retired) {
      entry.controller.abort();
      this.remove("", entry);
    }
    this.entries.clear();
    this.invalidatedUrls.clear();
    this.replacementListeners.clear();
    this.cachedBytes = 0;
  }
}
