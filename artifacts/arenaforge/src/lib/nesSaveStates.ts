const DATABASE = "arenaforge-nes-save-states";
const STORE = "states";
const VERSION = 1;

type SaveStateRecord = {
  id: string;
  state: unknown;
  savedAt: number;
};

function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (!("indexedDB" in window)) {
      reject(new Error("This browser does not support local save states."));
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
    request.onerror = () => reject(request.error ?? new Error("Could not open local save storage."));
  });
}

export async function readNesSaveState(id: string): Promise<unknown | null> {
  const database = await openDatabase();
  return new Promise((resolve, reject) => {
    const transaction = database.transaction(STORE, "readonly");
    const request = transaction.objectStore(STORE).get(id);
    request.onsuccess = () => resolve((request.result as SaveStateRecord | undefined)?.state ?? null);
    request.onerror = () => reject(request.error ?? new Error("Could not read the local save state."));
    transaction.oncomplete = () => database.close();
    transaction.onerror = () => {
      database.close();
      reject(transaction.error ?? new Error("Could not read the local save state."));
    };
  });
}

export async function writeNesSaveState(id: string, state: unknown): Promise<void> {
  const database = await openDatabase();
  return new Promise((resolve, reject) => {
    const transaction = database.transaction(STORE, "readwrite");
    transaction.objectStore(STORE).put({ id, state, savedAt: Date.now() } satisfies SaveStateRecord);
    transaction.oncomplete = () => {
      database.close();
      resolve();
    };
    transaction.onerror = () => {
      database.close();
      reject(transaction.error ?? new Error("Could not write the local save state."));
    };
    transaction.onabort = () => {
      database.close();
      reject(transaction.error ?? new Error("Saving the local state was cancelled."));
    };
  });
}

export async function deleteNesSaveState(id: string): Promise<void> {
  const database = await openDatabase();
  return new Promise((resolve, reject) => {
    const transaction = database.transaction(STORE, "readwrite");
    transaction.objectStore(STORE).delete(id);
    transaction.oncomplete = () => {
      database.close();
      resolve();
    };
    transaction.onerror = () => {
      database.close();
      reject(transaction.error ?? new Error("Could not clear the local save state."));
    };
  });
}
