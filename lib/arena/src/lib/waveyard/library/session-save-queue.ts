/** Per-controller acknowledged writes with an optional restart journal; no cross-tab locking claim. */
export type SessionSaveStatus = "saved" | "pending" | "saving" | "error";

export type SessionSaveJournal = {
  read(): Array<[string, string]>;
  write(entries: Array<[string, string]>): void;
};

/** A small synchronous journal so a tab restart can replay idempotent PATCHes. */
export function localStorageSessionSaveJournal(storage: Pick<Storage, "getItem" | "setItem" | "removeItem">, key: string): SessionSaveJournal {
  return {
    read() {
      let raw: string | null;
      try {
        raw = storage.getItem(key);
      } catch {
        return [];
      }
      if (raw === null) return [];
      try {
        const value: unknown = JSON.parse(raw);
        if (!Array.isArray(value)) throw new Error("invalid journal");
        return value.filter((entry): entry is [string, string] =>
          Array.isArray(entry) && entry.length === 2
          && typeof entry[0] === "string" && entry[0].startsWith("/api/library/sessions/") && entry[0].includes("/tracks/")
          && typeof entry[1] === "string",
        );
      } catch {
        try { storage.removeItem(key); } catch { /* Storage may be unavailable in a restricted context. */ }
        return [];
      }
    },
    write(entries) {
      if (entries.length) storage.setItem(key, JSON.stringify(entries));
      else storage.removeItem(key);
    },
  };
}

export class SessionSaveQueue {
  private pending = new Map<string, string>();
  private running: Promise<boolean> | null = null;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private failed: string | null = null;
  private write: (url: string, body: string) => Promise<void>;
  private notify: (status: SessionSaveStatus) => void;
  private delay: number;
  private journal?: SessionSaveJournal;

  constructor(
    write: (url: string, body: string) => Promise<void>,
    notify: (status: SessionSaveStatus) => void,
    delay = 600,
    journal?: SessionSaveJournal,
  ) {
    this.write = write;
    this.notify = notify;
    this.delay = delay;
    this.journal = journal;
    for (const [url, body] of journal?.read() ?? []) this.pending.set(url, body);
    if (this.pending.size) this.schedule();
  }

  enqueue(url: string, body: string) {
    this.pending.set(url, body);
    this.persist();
    this.notify(this.failed ? "error" : "pending");
    this.schedule();
  }

  /** Only call after the server acknowledges removal of this membership. */
  forget(url: string) {
    if (!this.pending.delete(url)) return;
    this.persist();
    if (this.failed === url) this.failed = null;
    if (!this.failed) void this.flush();
  }

  get unsaved() {
    return this.pending.size > 0 || this.running !== null;
  }

  flush(retry = false): Promise<boolean> {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    if (retry) this.failed = null;
    if (this.running) return this.running;
    if (this.failed) return Promise.resolve(false);
    if (!this.pending.size) {
      this.notify("saved");
      return Promise.resolve(true);
    }
    this.notify("saving");
    this.running = this.drain().finally(() => {
      this.running = null;
    });
    return this.running;
  }

  private async drain(): Promise<boolean> {
    while (this.pending.size) {
      const [url, body] = this.pending.entries().next().value!;
      try {
        await this.write(url, body);
      } catch {
        // Keep the latest body (which may have changed during the request).
        if (!this.pending.has(url)) continue;
        this.failed = url;
        this.notify("error");
        return false;
      }
      if (this.pending.get(url) === body) this.pending.delete(url);
      this.persist();
    }
    this.notify("saved");
    return true;
  }

  private schedule() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => { void this.flush(); }, this.delay);
  }

  private persist() {
    try {
      this.journal?.write([...this.pending.entries()]);
    } catch {
      // The server remains authoritative; a failed local journal must not
      // prevent the acknowledged network write from being attempted.
    }
  }
}
