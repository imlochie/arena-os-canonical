import { validArcadeManifest, type ArcadeManifest } from "./arcadeManifest";
const DATABASE = "arenaforge-arcade-management";
const STORE = "manifests";
export const arcadeManifestKey = (manifest: ArcadeManifest) => JSON.stringify([manifest.ownership, manifest.id, manifest.installedVersion]);
function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DATABASE, 1);
    request.onupgradeneeded = () => request.result.createObjectStore(STORE, { keyPath: "key" });
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("Could not open local Arcade management."));
    request.onblocked = () => reject(new Error("Another tab is blocking the Arcade management database."));
  });
}
/** Non-destructive lazy migration: one atomic metadata transaction, never an
 * upgrade/clear/rewrite of either legacy game DB or any save namespace. Version
 * keys prevent an older open tab from rewinding a newer version's manifest. */
export async function syncArcadeManifests(manifests: ArcadeManifest[], force = false): Promise<ArcadeManifest[]> {
  if (!manifests.every(validArcadeManifest)) throw new Error("The game manifest is malformed or uses an unsupported schema version.");
  const database = await open();
  return new Promise((resolve, reject) => {
    const transaction = database.transaction(STORE, "readwrite");
    const store = transaction.objectStore(STORE);
    const result: ArcadeManifest[] = [];
    let error: unknown;
    const abort = (cause: unknown) => { error = cause; try { transaction.abort(); } catch {} };
    transaction.oncomplete = () => { database.close(); resolve(result); };
    transaction.onerror = transaction.onabort = () => { database.close(); reject(error ?? transaction.error ?? new Error("Manifest metadata was not saved. Existing game data is unchanged.")); };
    try {
      for (const derived of manifests) {
        const key = arcadeManifestKey(derived);
        const request = store.get(key);
        request.onsuccess = () => {
          try {
            const prior: unknown = request.result?.manifest;
            if (prior && !validArcadeManifest(prior) && !force) throw new Error("Stored manifest has an unsupported schema or invalid metadata. Existing game bytes remain intact; rebuild metadata explicitly.");
            if (prior && validArcadeManifest(prior) && (prior.id !== derived.id || prior.ownership !== derived.ownership || prior.installedVersion !== derived.installedVersion)) throw new Error("Manifest identity/version mismatch. Rebuild metadata explicitly.");
            const compatible = validArcadeManifest(prior) ? prior : undefined;
            const merged: ArcadeManifest = compatible && !force ? {
              ...derived, runtime: compatible.runtime, profiles: compatible.profiles,
              history: compatible.history, evidence: [...compatible.evidence, ...derived.evidence.filter(e =>
                !compatible.evidence.some(p => p.stage === e.stage && p.hostId === e.hostId && p.gameVersion === e.gameVersion && p.runtimeVersion === e.runtimeVersion))].slice(-64),
            } : derived;
            store.put({ ...request.result, key, manifest: merged, ...(force && prior ? { previous: prior } : {}) });
            result.push(merged);
          } catch (cause) { abort(cause); }
        };
        request.onerror = () => abort(request.error);
      }
    } catch (cause) { abort(cause); }
  });
}
/** Atomic read/modify/write for observations; never an update of game bytes. */
export async function updateArcadeManifest(expected: ArcadeManifest, transform: (latest: ArcadeManifest) => ArcadeManifest): Promise<ArcadeManifest> {
  const database = await open();
  return new Promise((resolve, reject) => {
    const transaction = database.transaction(STORE, "readwrite");
    const store = transaction.objectStore(STORE);
    let result: ArcadeManifest;
    let error: unknown;
    transaction.oncomplete = () => { database.close(); resolve(result); };
    transaction.onerror = transaction.onabort = () => { database.close(); reject(error ?? transaction.error ?? new Error("The observation could not be saved.")); };
    const request = store.get(arcadeManifestKey(expected));
    request.onsuccess = () => {
      try {
        const latest: unknown = request.result?.manifest;
        if (!validArcadeManifest(latest) || latest.runtime.id !== expected.runtime.id || latest.runtime.version !== expected.runtime.version ||
          latest.runtime.profile !== expected.runtime.profile) throw new Error("Runtime metadata changed in another tab. Reopen diagnostics before recording this observation.");
        result = transform(latest);
        if (!validArcadeManifest(result) || arcadeManifestKey(result) !== arcadeManifestKey(expected)) throw new Error("An observation cannot change the game identity or installed version.");
        store.put({ ...request.result, manifest: result });
      } catch (cause) { error = cause; transaction.abort(); }
    };
  });
}
export async function readArcadeMetadataRecovery(manifest: ArcadeManifest): Promise<unknown> {
  const database = await open();
  return new Promise((resolve, reject) => {
    const transaction = database.transaction(STORE, "readonly");
    const request = transaction.objectStore(STORE).get(arcadeManifestKey(manifest));
    let result: unknown;
    request.onsuccess = () => { result = request.result; };
    transaction.oncomplete = () => { database.close(); resolve({ format: "arena.arcade.metadata-recovery", record: result ?? null }); };
    transaction.onerror = transaction.onabort = () => { database.close(); reject(transaction.error ?? new Error("Could not read metadata recovery record.")); };
  });
}
