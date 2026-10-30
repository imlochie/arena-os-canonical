import type { GameEngine, GameType } from "@workspace/arena/lib/games";

const DATABASE = "arenaforge-offline-shelf";
const STORE = "games";
const VERSION = 1;

export type SavedOfflineGame = {
  id: string;
  title: string;
  prompt: string;
  gameType: GameType;
  engine: GameEngine | "ai-codegen";
  code: string;
  saveSlotId: string;
  starter: boolean;
  createdAt: number;
  updatedAt: number;
  draft?: boolean;
  verificationStatus?: "passed" | "failed" | "unavailable";
  verificationIssues?: string[];
};

function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (!("indexedDB" in window)) {
      reject(new Error("This browser does not support the offline game shelf."));
      return;
    }
    const request = indexedDB.open(DATABASE, VERSION);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(STORE)) {
        request.result.createObjectStore(STORE, { keyPath: "id" });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("Could not open the offline game shelf."));
  });
}

export async function loadOfflineSavedGames(): Promise<SavedOfflineGame[]> {
  const database = await openDatabase();
  return new Promise((resolve, reject) => {
    const transaction = database.transaction(STORE, "readonly");
    const request = transaction.objectStore(STORE).getAll();
    request.onsuccess = () => resolve(request.result as SavedOfflineGame[]);
    request.onerror = () => reject(request.error ?? new Error("Could not read the offline game shelf."));
    transaction.oncomplete = () => database.close();
    transaction.onerror = () => {
      database.close();
      reject(transaction.error ?? new Error("Could not read the offline game shelf."));
    };
  });
}

export async function saveOfflineSavedGames(games: readonly SavedOfflineGame[]): Promise<void> {
  const database = await openDatabase();
  return new Promise((resolve, reject) => {
    const transaction = database.transaction(STORE, "readwrite");
    const store = transaction.objectStore(STORE);
    for (const game of games) store.put(game);
    transaction.oncomplete = () => {
      database.close();
      resolve();
    };
    transaction.onerror = () => {
      database.close();
      reject(transaction.error ?? new Error("Could not save the offline game shelf."));
    };
    transaction.onabort = () => {
      database.close();
      reject(transaction.error ?? new Error("Saving the offline game shelf was cancelled."));
    };
  });
}

export async function deleteOfflineSavedGame(id: string): Promise<void> {
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
      reject(transaction.error ?? new Error("Could not delete the offline game."));
    };
    transaction.onabort = () => {
      database.close();
      reject(transaction.error ?? new Error("Deleting the offline game was cancelled."));
    };
  });
}
