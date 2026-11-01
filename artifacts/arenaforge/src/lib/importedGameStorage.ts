const DATABASE = "arenaforge-imported-games";
const STORE = "games";
const VERSION = 2;
const LEGACY_KEY = "arenaforge.imported-games.v1";
const SIGNAL_KEY = "arenaforge.imported-games.changed";
const CHANNEL = "arenaforge-imported-games-changed";
const REVISION_KEY = "__arenaShelfRevision";
const writerId = crypto.randomUUID();
const committedRevisions = new WeakMap<object, string>();

export class ImportedGameStorageConflictError extends Error {
  name = "ImportedGameStorageConflictError";
  constructor() {
    super("This game changed or was removed in another tab. Refresh the saved shelf before retrying. Your local version is still available in this session.");
  }
}

/** Compare only a record being changed, never read/rewrite unrelated ROMs. */
export function importedGameRecordsMatch(previous: unknown, current: unknown): boolean {
  if (previous === undefined || current === undefined) return previous === current;
  const revision = (record: unknown) => typeof record === "object" && record !== null
    ? committedRevisions.get(record) ?? (record as Record<string, unknown>)[REVISION_KEY]
    : undefined;
  if (revision(previous) !== revision(current)) return false;
  // Legacy records have no revision. Also compare metadata/source to detect
  // writes from an older client that does not issue fresh revision stamps.
  const fingerprint = (record: unknown) => JSON.stringify(record, (key, value) =>
    key === REVISION_KEY ? undefined : value instanceof ArrayBuffer ? { arrayBufferBytes: value.byteLength } : value);
  return fingerprint(previous) === fingerprint(current);
}

function publishShelfChange(ids?: string[]) {
  const signal = { writer: writerId, token: crypto.randomUUID(), ids };
  // Notification failure must not turn an already committed write into a
  // reported save failure. Transactional conflict checks remain authoritative.
  try { localStorage.setItem(SIGNAL_KEY, JSON.stringify(signal)); } catch {}
  try {
    const channel = new BroadcastChannel(CHANNEL);
    channel.postMessage(signal);
    channel.close();
  } catch {}
}

export function subscribeImportedGamesChanged(notify: (ids?: string[]) => void): () => void {
  let seenToken: string | undefined;
  const readSignal = () => {
    try { return JSON.parse(localStorage.getItem(SIGNAL_KEY) ?? "null"); } catch { return null; }
  };
  seenToken = readSignal()?.token;
  let focusedToken = seenToken;
  const receive = (signal: unknown) => {
    if (!signal || typeof signal !== "object") return;
    const value = signal as { writer?: unknown; token?: unknown; ids?: unknown };
    if (typeof value.token !== "string" || value.token === seenToken) return;
    seenToken = value.token;
    if (value.writer !== writerId) notify(Array.isArray(value.ids) && value.ids.every((id) => typeof id === "string") ? value.ids : undefined);
  };
  let channel: BroadcastChannel | undefined;
  try {
    channel = new BroadcastChannel(CHANNEL);
    channel.onmessage = (event) => receive(event.data);
  } catch {}
  const onStorage = (event: StorageEvent) => {
    if (!channel && event.key === SIGNAL_KEY) {
      const signal = readSignal();
      if (signal?.token !== seenToken && signal?.writer !== writerId) {
        seenToken = signal?.token;
        notify();
      }
    }
  };
  const onFocus = () => {
    const signal = readSignal();
    if (!signal || signal.token === focusedToken) return;
    focusedToken = signal.token;
    if (signal.writer !== writerId) notify(); // Reconcile any missed background events.
  };
  window.addEventListener("storage", onStorage);
  window.addEventListener("focus", onFocus);
  return () => {
    channel?.close();
    window.removeEventListener("storage", onStorage);
    window.removeEventListener("focus", onFocus);
  };
}

export async function loadImportedGameRecords(ids: readonly string[]): Promise<unknown[]> {
  if (!ids.length) return [];
  const database = await openDatabase();
  return new Promise((resolve, reject) => {
    const transaction = database.transaction(STORE, "readonly");
    const rows: unknown[] = [];
    for (const id of new Set(ids)) {
      const request = transaction.objectStore(STORE).get(id);
      request.onsuccess = () => { if (request.result !== undefined) rows.push(request.result); };
    }
    transaction.oncomplete = () => { database.close(); resolve(rows); };
    transaction.onerror = transaction.onabort = () => {
      database.close();
      reject(transaction.error ?? new Error("Could not refresh changed game records."));
    };
  });
}

function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (!("indexedDB" in window)) {
      reject(new Error("This browser does not support a local game shelf."));
      return;
    }
    const request = indexedDB.open(DATABASE, VERSION);
    request.onupgradeneeded = () => {
      const database = request.result;
      if (!database.objectStoreNames.contains(STORE)) {
        database.createObjectStore(STORE, { keyPath: "id" });
      }
      for (const store of ["workshop", "mod-packages"]) if (!database.objectStoreNames.contains(store)) database.createObjectStore(store, { keyPath: "id" });
    };
    request.onsuccess = () => { request.result.onversionchange = () => request.result.close(); resolve(request.result); };
    request.onblocked = () => reject(new Error("Close older Arena tabs so the mod shelf can be upgraded safely."));
    request.onerror = () => reject(request.error ?? new Error("Could not open the local game shelf."));
  });
}

export async function readImportedWorkshopRecord(store: "workshop" | "mod-packages", id: string): Promise<any> {
  const database = await openDatabase();
  return new Promise((resolve, reject) => {
    const tx = database.transaction(store, "readonly"), read = tx.objectStore(store).get(id); let value: unknown;
    read.onsuccess = () => { value = read.result; };
    tx.oncomplete = () => { database.close(); resolve(value); };
    tx.onerror = tx.onabort = () => { database.close(); reject(tx.error ?? new Error("Could not read the mod shelf.")); };
  });
}
/** A workshop commit and its base-game stale check share one IDB transaction. */
export async function commitImportedWorkshop(gameId: string, expectedGame: unknown, expectedRevision: number, state: any, packages: Record<string, string>) {
  const database = await openDatabase();
  return new Promise<void>((resolve, reject) => {
    const tx = database.transaction([STORE, "workshop", "mod-packages"], "readwrite"); let failure: Error | undefined;
    const fail = (error: Error) => { failure = error; tx.abort(); };
    const game = tx.objectStore(STORE).get(gameId);
    game.onsuccess = () => {
      if (!importedGameRecordsMatch(expectedGame, game.result)) { fail(new ImportedGameStorageConflictError()); return; }
      const previous = tx.objectStore("workshop").get(gameId);
      previous.onsuccess = () => {
        if ((previous.result?.state?.revision ?? 0) !== expectedRevision) { fail(new Error("Workshop changed in another window. Refresh before retrying.")); return; }
        try {
          for (const [digest, json] of Object.entries(packages)) tx.objectStore("mod-packages").put({ id: digest, json });
          tx.objectStore("workshop").put({ id: gameId, state });
        } catch (error) { fail(error instanceof Error ? error : new Error("Could not save mod profile.")); }
      };
    };
    tx.oncomplete = () => { database.close(); resolve(); };
    tx.onerror = tx.onabort = () => { database.close(); reject(failure ?? tx.error ?? new Error("The mod transaction was interrupted; the previous profile remains active.")); };
  });
}

export async function loadImportedGames(): Promise<unknown[]> {
  const database = await openDatabase();
  const stored = await new Promise<unknown[]>((resolve, reject) => {
    const transaction = database.transaction(STORE, "readonly");
    const request = transaction.objectStore(STORE).getAll();
    request.onsuccess = () => resolve(request.result as unknown[]);
    request.onerror = () => reject(request.error ?? new Error("Could not read the local game shelf."));
    transaction.oncomplete = () => database.close();
    transaction.onerror = () => {
      database.close();
      reject(transaction.error ?? new Error("Could not read the local game shelf."));
    };
  });
  if (stored.length) return stored;

  try {
    const legacy = localStorage.getItem(LEGACY_KEY);
    if (!legacy) return [];
    const parsed: unknown = JSON.parse(legacy);
    if (!Array.isArray(parsed)) return [];
    const records = parsed.filter((record): record is { id: string } =>
      typeof record === "object" && record !== null && typeof record.id === "string");
    // Merge legacy imports, rather than clearing a record another tab may
    // have saved since the initial empty-shelf read.
    await saveImportedGameChanges([], records);
    localStorage.removeItem(LEGACY_KEY);
    return records.length ? loadImportedGames() : [];
  } catch {
    return [];
  }
}

export async function saveImportedGames(records: readonly unknown[]): Promise<void> {
  const database = await openDatabase();
  return new Promise((resolve, reject) => {
    const transaction = database.transaction(STORE, "readwrite");
    const store = transaction.objectStore(STORE);
    const revisions = new Map<object, string>();
    transaction.oncomplete = () => {
      for (const [record, revision] of revisions) committedRevisions.set(record, revision);
      database.close();
      publishShelfChange();
      resolve();
    };
    transaction.onerror = () => {
      database.close();
      reject(transaction.error ?? new Error("Could not save the local game shelf."));
    };
    transaction.onabort = () => {
      database.close();
      reject(transaction.error ?? new Error("Saving the local game shelf was cancelled."));
    };
    try {
      store.clear();
      for (const record of records) {
        if (typeof record === "object" && record !== null) {
          const revision = crypto.randomUUID();
          revisions.set(record, revision);
          store.put({ ...record, [REVISION_KEY]: revision });
        } else store.put(record);
      }
    } catch (error) {
      // Synchronous DataCloneError/DataError does not automatically abort a
      // transaction. Without this, clear() could commit after put() throws.
      try { transaction.abort(); } catch { database.close(); }
      reject(error instanceof Error ? error : new Error("Could not save the local game shelf."));
    }
  });
}

export function importedGameStorageChanges<T extends { id: string }>(
  previous: readonly T[],
  next: readonly T[],
): { upsert: T[]; remove: string[] } {
  const previousById = new Map(previous.map((record) => [record.id, record]));
  const nextById = new Map(next.map((record) => [record.id, record]));
  return {
    // Workspace updates replace changed records instead of mutating them.
    // Identity checks avoid cloning large unchanged ROM buffers on every edit.
    upsert: [...nextById.values()].filter((record) => previousById.get(record.id) !== record),
    remove: [...previousById.keys()].filter((id) => !nextById.has(id)),
  };
}

export async function saveImportedGameChanges<T extends { id: string }>(
  previous: readonly T[],
  next: readonly T[],
): Promise<void> {
  const changes = importedGameStorageChanges(previous, next);
  if (changes.upsert.length === 0 && changes.remove.length === 0) return;

  const database = await openDatabase();
  return new Promise((resolve, reject) => {
    const transaction = database.transaction(STORE, "readwrite");
    const store = transaction.objectStore(STORE);
    const previousById = new Map(previous.map((record) => [record.id, record]));
    const upsertById = new Map(changes.upsert.map((record) => [record.id, record]));
    const changedIds = [...upsertById.keys(), ...changes.remove];
    const revisions = new Map<object, string>();
    let failed = false;
    const fail = (error: unknown) => {
      if (failed) return;
      failed = true;
      try { transaction.abort(); } catch { database.close(); }
      reject(error instanceof Error ? error : new Error("Could not update the local game shelf."));
    };
    transaction.oncomplete = () => {
      for (const [record, revision] of revisions) committedRevisions.set(record, revision);
      database.close();
      publishShelfChange(changedIds);
      resolve();
    };
    transaction.onerror = () => {
      database.close();
      reject(transaction.error ?? new Error("Could not update the local game shelf."));
    };
    transaction.onabort = () => {
      database.close();
      reject(transaction.error ?? new Error("Updating the local game shelf was cancelled."));
    };

    try {
      for (const id of changedIds) {
        const request = store.get(id);
        request.onsuccess = () => {
          if (failed) return;
          try {
            if (!importedGameRecordsMatch(previousById.get(id), request.result)) {
              fail(new ImportedGameStorageConflictError());
              return;
            }
            const record = upsertById.get(id);
            if (record) {
              const revision = crypto.randomUUID();
              revisions.set(record, revision);
              store.put({ ...record, [REVISION_KEY]: revision });
            } else store.delete(id);
          } catch (error) { fail(error); }
        };
      }
    } catch (error) {
      fail(error);
    }
  });
}
