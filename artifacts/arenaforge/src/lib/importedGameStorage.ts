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
    store.clear();
    for (const record of records) store.put(record);
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
  });
}
