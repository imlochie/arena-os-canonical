const DATABASE = "arenaforge-imported-games";
const STORE = "games";
const VERSION = 1;
const LEGACY_KEY = "arenaforge.imported-games.v1";

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
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("Could not open the local game shelf."));
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
    await saveImportedGames(parsed);
    localStorage.removeItem(LEGACY_KEY);
    return parsed;
  } catch {
    return [];
  }
}

export async function saveImportedGames(records: readonly unknown[]): Promise<void> {
  const database = await openDatabase();
  return new Promise((resolve, reject) => {
    const transaction = database.transaction(STORE, "readwrite");
    const store = transaction.objectStore(STORE);
    transaction.oncomplete = () => {
      database.close();
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
      for (const record of records) store.put(record);
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
    transaction.oncomplete = () => {
      database.close();
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
      for (const record of changes.upsert) store.put(record);
      for (const id of changes.remove) store.delete(id);
    } catch (error) {
      try { transaction.abort(); } catch { database.close(); }
      reject(error instanceof Error ? error : new Error("Could not update the local game shelf."));
    }
  });
}
