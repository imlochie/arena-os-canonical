/** Per-controller acknowledged writes with an optional restart journal; no cross-tab locking claim. */
export type SessionSaveStatus = "saved" | "pending" | "saving" | "error";

export type SessionSaveJournal = {
  read(): Array<[string, string]>;
  write(entries: Array<[string, string]>): void;
};

export type SessionSavePatch = {
  stemMixPatch?: Record<string, unknown>;
  transition?: unknown;
};

export type SessionSavePendingWrites = { activeBody?: string; queuedBody?: string };

function parseSessionSavePatch(body: string): SessionSavePatch | null {
  try {
    const value: unknown = JSON.parse(body);
    if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
    const record = value as Record<string, unknown>;
    const patch: SessionSavePatch = {};
    if (typeof record.stemMixPatch === "object" && record.stemMixPatch !== null && !Array.isArray(record.stemMixPatch)) {
      patch.stemMixPatch = record.stemMixPatch as Record<string, unknown>;
    }
    if (Object.hasOwn(record, "transition")) patch.transition = record.transition;
    return Object.keys(patch).length > 0 ? patch : null;
  } catch {
    return null;
  }
}

/** Return the latest journaled write for one exact session membership. */
export function sessionSavePatchForTrack(
  entries: Array<[string, string]>,
  sessionId: string,
  sessionTrackId: string,
): SessionSavePatch | null {
  const url = `/api/library/sessions/${sessionId}/tracks/${sessionTrackId}`;
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];
    if (entry?.[0] === url) return parseSessionSavePatch(entry[1]);
  }
  return null;
}

/**
 * Check queued/in-flight results, then return a durable desired snapshot.
 * Queued bodies replace one another, and a restart may replay the latest body
 * without the active request having reached the server.
 */
export function sessionSavePatchAgainstPending(
  saved: { stemMix: Record<string, number>; transitionJson: string },
  desired: { stemMix: Record<string, number>; transitionJson: string },
  pendingWrites: string | SessionSavePendingWrites = {},
): string | null {
  const writes: SessionSavePendingWrites = typeof pendingWrites === "string"
    ? { queuedBody: pendingWrites }
    : pendingWrites;
  const apply = (base: { stemMix: Record<string, number>; transitionJson: string }, body?: string) => {
    const stemMix = { ...base.stemMix };
    let transitionJson = base.transitionJson;
    if (!body) return { stemMix, transitionJson };
    const pending = parseSessionSavePatch(body);
    for (const [key, value] of Object.entries(pending?.stemMixPatch ?? {})) {
      if (typeof value === "number" && Number.isFinite(value)) stemMix[key] = value;
    }
    if (pending && Object.hasOwn(pending, "transition")) {
      transitionJson = JSON.stringify(pending.transition);
    }
    return { stemMix, transitionJson };
  };
  const afterActive = apply(saved, writes.activeBody);
  const projected = apply(afterActive, writes.queuedBody);
  const activePatch = writes.activeBody ? parseSessionSavePatch(writes.activeBody) : null;
  const queuedPatch = writes.queuedBody ? parseSessionSavePatch(writes.queuedBody) : null;

  const differsFromPendingMix = Object.entries(desired.stemMix).some(([stemType, value]) =>
    !Object.is(projected.stemMix[stemType] ?? 1, value),
  );
  const transitionDiffersFromPending = projected.transitionJson !== desired.transitionJson;
  if (!differsFromPendingMix && !transitionDiffersFromPending) return null;

  // Include changes from the acknowledged baseline, plus any field the active
  // request could still change. That makes this snapshot safe to replay alone.
  const stemMixPatch = Object.fromEntries(
    Object.entries(desired.stemMix).filter(([stemType, value]) =>
      !Object.is(saved.stemMix[stemType] ?? 1, value)
      || Object.hasOwn(activePatch?.stemMixPatch ?? {}, stemType)
      || Object.hasOwn(queuedPatch?.stemMixPatch ?? {}, stemType),
    ),
  );
  const body: Record<string, unknown> = {};
  if (Object.keys(stemMixPatch).length > 0) body.stemMixPatch = stemMixPatch;
  if (saved.transitionJson !== desired.transitionJson
    || (activePatch && Object.hasOwn(activePatch, "transition"))
    || (queuedPatch && Object.hasOwn(queuedPatch, "transition"))) {
    body.transition = JSON.parse(desired.transitionJson) as unknown;
  }
  if (Object.keys(body).length > 0) return JSON.stringify(body);
  return null;
}

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
  private activeWrite: { url: string; body: string } | null = null;
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

  /** Active and queued writes, kept separate because a queued body is replaceable. */
  pendingWrites(url: string): SessionSavePendingWrites {
    const writes: SessionSavePendingWrites = {};
    if (this.activeWrite?.url === url) writes.activeBody = this.activeWrite.body;
    const queued = this.pending.get(url);
    if (queued !== undefined && queued !== writes.activeBody) writes.queuedBody = queued;
    return writes;
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
      this.activeWrite = { url, body };
      try {
        await this.write(url, body);
      } catch {
        this.activeWrite = null;
        // Keep the latest body (which may have changed during the request).
        if (!this.pending.has(url)) continue;
        this.failed = url;
        this.notify("error");
        return false;
      }
      this.activeWrite = null;
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
