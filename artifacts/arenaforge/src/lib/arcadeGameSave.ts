import { useCallback, useEffect, useMemo, useRef, useState, type RefObject } from "react";
import {
  ARCADE_SAVE_PREFIX, MAX_ARCADE_SAVE_BYTES, MAX_ARCADE_SAVE_KEY_LENGTH,
  commitHtmlProgressRestoreWithRevision, progressRevisionKey, readProgressRevision,
  withProgressWriteLock, type GameSaveData,
} from "./arcadeGameProgressBackup";

const STORAGE_PREFIX = ARCADE_SAVE_PREFIX;
const MESSAGE_CHANNEL = "arenaforge-game-save";
const MAX_SAVE_BYTES = MAX_ARCADE_SAVE_BYTES;
const MAX_KEY_LENGTH = MAX_ARCADE_SAVE_KEY_LENGTH;

function encodedSize(value: string) {
  return new TextEncoder().encode(value).byteLength;
}

function storageKey(gameId: string) {
  return `${STORAGE_PREFIX}${gameId}`;
}

function readSaveData(gameId: string): GameSaveData {
  try {
    const raw = localStorage.getItem(storageKey(gameId));
    if (!raw || encodedSize(raw) > MAX_SAVE_BYTES) return {};
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const result: GameSaveData = Object.create(null);
    for (const [key, value] of Object.entries(parsed)) {
      if (key.length <= MAX_KEY_LENGTH && typeof value === "string") result[key] = value;
    }
    return result;
  } catch {
    return {};
  }
}

function safelyEmbedJson(value: unknown) {
  return JSON.stringify(value)
    .replace(/</g, "\\u003c")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");
}

function saveRuntimeScript(gameId: string, sessionId: string, saved: GameSaveData, initialRevision: string | null) {
  const safeId = safelyEmbedJson(gameId);
  const safeSessionId = safelyEmbedJson(sessionId);
  const safeSaved = safelyEmbedJson(JSON.stringify(saved));
  return `<script data-arenaforge-save-runtime>(function(){` +
    `var gameId=${safeId},sessionId=${safeSessionId},revision=${safelyEmbedJson(initialRevision)},data=Object.assign(Object.create(null),JSON.parse(${safeSaved})),channel=${safelyEmbedJson(MESSAGE_CHANNEL)};` +
    `function send(op,key,value){try{parent.postMessage({channel:channel,gameId:gameId,sessionId:sessionId,revision:revision,op:op,key:key,value:value},"*")}catch(e){}}` +
    `try{var nativePlay=HTMLMediaElement.prototype.play;HTMLMediaElement.prototype.play=function(){var result=nativePlay.apply(this,arguments);if(result&&typeof result.then==="function")result.then(function(){send("media-play-started",null,null)},function(error){var name=String(error&&error.name||"PlaybackError").slice(0,40);if(name!=="AbortError")send("media-play-failed",null,name)});return result}}catch(e){}` +
    `function size(value){return new TextEncoder().encode(value).byteLength}function reject(key){send("rejected",key&&key.length<=${MAX_KEY_LENGTH}?key:null,"too-large")}` +
    `function write(key,value){key=String(key);value=String(value);if(!key||key.length>${MAX_KEY_LENGTH}||size(value)>${MAX_SAVE_BYTES}){reject(key);return}` +
    `var old=data[key];data[key]=value;if(size(JSON.stringify(data))>${MAX_SAVE_BYTES}){if(old===undefined)delete data[key];else data[key]=old;reject(key);return}send("set",key,value)}` +
    `var store={getItem:function(key){key=String(key);return Object.prototype.hasOwnProperty.call(data,key)?data[key]:null},setItem:write,` +
    `removeItem:function(key){key=String(key);delete data[key];send("remove",key)},clear:function(){data=Object.create(null);send("clear")},` +
    `key:function(index){return Object.keys(data)[index]||null}};` +
    `Object.defineProperty(store,"length",{get:function(){return Object.keys(data).length}});` +
    `try{Object.defineProperty(window,"localStorage",{configurable:true,value:store})}catch(e){}` +
    `window.__arenaGameSave={get:function(key,fallback){var raw=store.getItem(key);if(raw===null)return fallback;try{return JSON.parse(raw)}catch(e){return raw}},` +
    `set:function(key,value){write(key,JSON.stringify(value))},remove:function(key){store.removeItem(key)},clear:function(){store.clear()}};` +
    `window.addEventListener("message",function(event){var m=event.data;if(event.source!==parent||!m||m.channel!==channel||m.gameId!==gameId||m.sessionId!==sessionId)return;` +
    `if(m.op==="clear"){data=Object.create(null);if(typeof m.revision==="string")revision=m.revision}if(m.op==="retry"){send("snapshot",m.token,data)}` +
    `if(m.op==="result"){if(m.ok&&typeof m.revision==="string")revision=m.revision;window.__arenaGameSave.status={ok:m.ok,reason:m.reason};window.dispatchEvent(new CustomEvent("arenaforge-save-status",{detail:window.__arenaGameSave.status}))}});` +
    `})();</script>`;
}

export function createGameSandboxDocument(
  source: string,
  gameId: string,
  sessionId: string = crypto.randomUUID(),
  revision: string | null = readProgressRevision(gameId),
) {
  const csp = `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline' data: blob:; style-src 'unsafe-inline' data: blob:; img-src data: blob:; media-src data: blob:; font-src data: blob:; connect-src 'none'; frame-src 'none'; object-src 'none'; form-action 'none'; base-uri 'none'">`;
  const runtime = saveRuntimeScript(gameId, sessionId, readSaveData(gameId), revision);
  if (/<head\b[^>]*>/i.test(source)) {
    return source.replace(/<head\b[^>]*>/i, (head) => `${head}${csp}${runtime}`);
  }
  if (/<html\b[^>]*>/i.test(source)) {
    return source.replace(/<html\b[^>]*>/i, (html) => `${html}<head>${csp}${runtime}</head>`);
  }
  if (/<!doctype[^>]*>/i.test(source)) {
    return source.replace(/<!doctype[^>]*>/i, (doctype) => `${doctype}<head>${csp}${runtime}</head>`);
  }
  return `<head>${csp}${runtime}</head>${source}`;
}

export function useArcadeGameSave(
  frameRef: RefObject<HTMLIFrameElement | null>,
  gameId: string | null,
) {
  const [hasSavedProgress, setHasSavedProgress] = useState(false);
  const [mediaPlaybackError, setMediaPlaybackError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const [persistenceWarning, setPersistenceWarning] = useState<string | null>(null);
  const [canRetrySave, setCanRetrySave] = useState(true);
  const [hasRevisionConflict, setHasRevisionConflict] = useState(false);
  const retryToken = useRef<string | null>(null);
  const reconcileToken = useRef<string | null>(null);
  const needsSnapshot = useRef(false);
  const oversizedKeys = useRef(new Set<string>());
  const oversizedReplacements = useRef(new Set<string>());
  const unknownOversizedKey = useRef(false);
  const pendingExplicitClear = useRef(false);
  const retryTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const sessionId = useMemo(() => crypto.randomUUID(), [gameId, reloadKey]);
  const initialRevision = useMemo(() => {
    try { return gameId ? readProgressRevision(gameId) : null; } catch { return null; }
  }, [gameId, reloadKey]);
  const sessionRevision = useRef<string | null>(initialRevision);
  const revisionConflict = useRef(false);
  const retiredSaveWindow = useRef<Window | null>(null);

  useEffect(() => {
    setMediaPlaybackError(null);
    setPersistenceWarning(null);
    setCanRetrySave(true);
    setHasRevisionConflict(false);
    revisionConflict.current = false;
    sessionRevision.current = initialRevision;
    retryToken.current = null;
    reconcileToken.current = null;
    needsSnapshot.current = false;
    oversizedKeys.current.clear();
    oversizedReplacements.current.clear();
    unknownOversizedKey.current = false;
    pendingExplicitClear.current = false;
    setHasSavedProgress(gameId ? Object.keys(readSaveData(gameId)).length > 0 : false);
    if (!gameId) return;
    let baselineReadable = true;
    try { localStorage.getItem(storageKey(gameId)); } catch {
      baselineReadable = false;
      setPersistenceWarning("Progress storage is blocked. New progress is not being saved. Keep this game open while restoring browser storage access.");
    }

    const reply = (ok: boolean, reason?: string, revision = sessionRevision.current) => frameRef.current?.contentWindow?.postMessage(
      { channel: MESSAGE_CHANNEL, gameId, sessionId, op: "result", ok, reason, revision }, "*",
    );
    const markRevisionConflict = () => {
      revisionConflict.current = true;
      setHasRevisionConflict(true);
      setCanRetrySave(false);
      setPersistenceWarning("This game’s saved progress changed in another tab. Your running game is still open, and its unsaved progress is retained here. Reload the latest save or explicitly keep this tab’s progress.");
    };
    const updateWarning = () => {
      const oversized = unknownOversizedKey.current || oversizedKeys.current.size > 0;
      if (revisionConflict.current) {
        markRevisionConflict();
        return;
      }
      if (pendingExplicitClear.current) {
        setCanRetrySave(false);
        setPersistenceWarning("Saved progress could not be removed. Restore browser storage access and try Clear progress again. Later autosaves do not confirm removal.");
        return;
      }
      setCanRetrySave(needsSnapshot.current || !oversized);
      setPersistenceWarning(needsSnapshot.current
        ? `Progress could not be saved. The last committed save is retained. Keep this game open, free browser storage or allow storage access, then retry.${oversized ? " An oversized checkpoint also needs a smaller replacement or an explicit clear." : ""}`
        : oversized
          ? "A checkpoint exceeds the 64 KiB save limit. Its last committed value is unchanged. Save a smaller replacement for that checkpoint or explicitly clear it. Saving a different key does not resolve this."
          : null);
    };
    const reject = (oversized = false, key?: unknown, reason?: string) => {
      if (reason === "revision-conflict") {
        markRevisionConflict();
        reply(false, reason, (() => { try { return readProgressRevision(gameId); } catch { return null; } })());
        return;
      }
      if (!oversized) needsSnapshot.current = true;
      else if (typeof key === "string" && key.length > 0 && key.length <= MAX_KEY_LENGTH &&
        (oversizedKeys.current.has(key) || oversizedKeys.current.size < 256)) {
        oversizedKeys.current.add(key);
        oversizedReplacements.current.delete(key);
      } else unknownOversizedKey.current = true;
      updateWarning();
      reply(false, oversized ? "too-large" : "storage-unavailable");
    };

    const processMessage = async (message: any) => {
      if (message.op === "media-play-started") { setMediaPlaybackError(null); return; }
      if (message.op === "media-play-failed") {
        const errorName = typeof message.value === "string" && /^[A-Za-z]+$/.test(message.value)
          ? message.value.slice(0, 40)
          : "PlaybackError";
        setMediaPlaybackError(errorName);
        return;
      }
      if (message.op === "rejected") { reject(true, message.key); return; }
      if (!["set", "remove", "clear", "snapshot"].includes(message.op)) return;
      if (message.op === "snapshot" && (!retryToken.current || message.key !== retryToken.current)) return;
      // A retry can resolve an oversized checkpoint only after the game has
      // explicitly supplied a valid replacement (or removal) for that key.
      if (typeof message.key === "string" && oversizedKeys.current.has(message.key) &&
        (message.op === "remove" || (message.op === "set" && typeof message.value === "string" && encodedSize(message.value) <= MAX_SAVE_BYTES))) {
        oversizedReplacements.current.add(message.key);
      }
      try {
        await withProgressWriteLock(gameId, async () => {
          const currentRevision = readProgressRevision(gameId);
          const explicitReconcile = message.op === "snapshot" && reconcileToken.current === message.key;
          if (currentRevision !== sessionRevision.current && !explicitReconcile) {
            reject(false, undefined, "revision-conflict");
            return;
          }
          const key = storageKey(gameId);
          const raw = localStorage.getItem(key);
          // Never replace an unreadable baseline with the player's possibly empty startup state.
          if (!baselineReadable && raw !== null) {
            setCanRetrySave(false);
            setPersistenceWarning("An existing save could not be loaded when this player opened. It has not been overwritten. Reopen the game after restoring storage access to load it.");
            reply(false, "baseline-unavailable");
            return;
          }
          const current: GameSaveData = raw ? JSON.parse(raw) : Object.create(null);
          if (!current || typeof current !== "object" || Array.isArray(current)) throw new Error("Invalid stored save");
          let next: GameSaveData = Object.assign(Object.create(null), current);
          if (message.op === "clear") next = Object.create(null);
          else if (message.op === "snapshot") {
            if (!message.value || typeof message.value !== "object" || Array.isArray(message.value)) return;
            next = Object.create(null);
            for (const [snapshotKey, value] of Object.entries(message.value)) {
              if (!snapshotKey || snapshotKey.length > MAX_KEY_LENGTH || typeof value !== "string" || encodedSize(value) > MAX_SAVE_BYTES) {
                reject(true, snapshotKey); return;
              }
              next[snapshotKey] = value;
            }
          } else {
            if (typeof message.key !== "string" || !message.key || message.key.length > MAX_KEY_LENGTH) { reject(true, message.key); return; }
            if (message.op === "remove") delete next[message.key];
            else {
              if (typeof message.value !== "string") return;
              if (encodedSize(message.value) > MAX_SAVE_BYTES) { reject(true, message.key); return; }
              next[message.key] = message.value;
            }
          }
          const serialized = JSON.stringify(next);
          if (encodedSize(serialized) > MAX_SAVE_BYTES) { reject(true, message.op === "snapshot" ? null : message.key); return; }
          const hasProgress = Object.keys(next).length > 0;
          const nextRevision = crypto.randomUUID();
          localStorage.setItem(progressRevisionKey(gameId), nextRevision);
          try {
            if (hasProgress) localStorage.setItem(key, serialized);
            else localStorage.removeItem(key);
            if (localStorage.getItem(key) !== (hasProgress ? serialized : null)) throw new Error("Storage did not commit");
          } catch (error) {
            // If the save itself did not change, undo the fence so this tab can retry.
            if (localStorage.getItem(key) === raw && localStorage.getItem(progressRevisionKey(gameId)) === nextRevision) {
              if (currentRevision === null) localStorage.removeItem(progressRevisionKey(gameId));
              else localStorage.setItem(progressRevisionKey(gameId), currentRevision);
            }
            throw error;
          }
          sessionRevision.current = nextRevision;
          baselineReadable = true;
          setHasSavedProgress(hasProgress);
          if (message.op === "clear") {
            pendingExplicitClear.current = false;
            needsSnapshot.current = false;
            oversizedKeys.current.clear();
            oversizedReplacements.current.clear();
            unknownOversizedKey.current = false;
          } else if (message.op === "snapshot") {
            needsSnapshot.current = false;
            for (const oversizedKey of oversizedReplacements.current) oversizedKeys.current.delete(oversizedKey);
            oversizedReplacements.current.clear();
          } else {
            oversizedKeys.current.delete(message.key);
            oversizedReplacements.current.delete(message.key);
          }
          revisionConflict.current = false;
          setHasRevisionConflict(false);
          updateWarning();
          if (message.op === "snapshot") {
            retryToken.current = null;
            reconcileToken.current = null;
            if (retryTimer.current) clearTimeout(retryTimer.current);
          }
          reply(true, undefined, nextRevision);
        });
      } catch { reject(); }
    };

    let writeQueue = Promise.resolve();
    const onMessage = (event: MessageEvent) => {
      if (event.source !== frameRef.current?.contentWindow || event.source === retiredSaveWindow.current) return;
      const message = event.data;
      if (!message || message.channel !== MESSAGE_CHANNEL || message.gameId !== gameId || message.sessionId !== sessionId) return;
      writeQueue = writeQueue.then(() => processMessage(message)).catch(() => {});
    };
    const onStorage = (event: StorageEvent) => {
      if (event.key !== progressRevisionKey(gameId)) return;
      try {
        if (readProgressRevision(gameId) === sessionRevision.current) return;
      } catch { /* The next attempted write still performs the authoritative check. */ }
      markRevisionConflict();
    };
    window.addEventListener("message", onMessage);
    window.addEventListener("storage", onStorage);
    return () => {
      window.removeEventListener("message", onMessage);
      window.removeEventListener("storage", onStorage);
      if (retryTimer.current) clearTimeout(retryTimer.current);
    };
  }, [frameRef, gameId, initialRevision, sessionId]);

  const clearSavedProgress = useCallback(async () => {
    if (!gameId) return;
    try {
      await withProgressWriteLock(gameId, () => {
        const currentRevision = readProgressRevision(gameId);
        if (currentRevision !== sessionRevision.current) {
          revisionConflict.current = true;
          setHasRevisionConflict(true);
          throw new Error("Progress changed in another tab.");
        }
        const previousRaw = localStorage.getItem(storageKey(gameId));
        const nextRevision = crypto.randomUUID();
        localStorage.setItem(progressRevisionKey(gameId), nextRevision);
        try {
          localStorage.removeItem(storageKey(gameId));
          if (localStorage.getItem(storageKey(gameId)) !== null) throw new Error("Removal did not commit");
        } catch (error) {
          if (localStorage.getItem(storageKey(gameId)) === previousRaw &&
            localStorage.getItem(progressRevisionKey(gameId)) === nextRevision) {
            if (currentRevision === null) localStorage.removeItem(progressRevisionKey(gameId));
            else localStorage.setItem(progressRevisionKey(gameId), currentRevision);
          }
          throw error;
        }
        sessionRevision.current = nextRevision;
      });
    } catch {
      if (revisionConflict.current) {
        setPersistenceWarning("This game’s saved progress changed in another tab. Reload the latest save before clearing it; the running game has not been discarded.");
        setCanRetrySave(false);
        return;
      }
      pendingExplicitClear.current = true;
      setPersistenceWarning("Saved progress could not be removed. The committed save and live game were left unchanged. Restore browser storage access and try Clear progress again.");
      setCanRetrySave(false);
      return;
    }
    frameRef.current?.contentWindow?.postMessage(
      { channel: MESSAGE_CHANNEL, gameId, sessionId, op: "clear", revision: sessionRevision.current },
      "*",
    );
    setHasSavedProgress(false);
    setPersistenceWarning(null);
    needsSnapshot.current = false;
    oversizedKeys.current.clear();
    oversizedReplacements.current.clear();
    unknownOversizedKey.current = false;
    pendingExplicitClear.current = false;
    retryToken.current = null;
    revisionConflict.current = false;
    setHasRevisionConflict(false);
  }, [frameRef, gameId, sessionId]);

  const retrySaving = useCallback(() => {
    if (!gameId) return;
    const token = crypto.randomUUID();
    retryToken.current = token;
    if (retryTimer.current) clearTimeout(retryTimer.current);
    retryTimer.current = setTimeout(() => {
      if (retryToken.current === token) {
        retryToken.current = null;
        setPersistenceWarning("The player did not confirm a retry. Keep it open and try saving again.");
      }
    }, 3000);
    frameRef.current?.contentWindow?.postMessage(
      { channel: MESSAGE_CHANNEL, gameId, sessionId, op: "retry", token }, "*",
    );
  }, [frameRef, gameId, sessionId]);

  const reconcileStaleProgress = useCallback(() => {
    if (!gameId || !revisionConflict.current) return;
    const token = crypto.randomUUID();
    retryToken.current = token;
    reconcileToken.current = token;
    if (retryTimer.current) clearTimeout(retryTimer.current);
    retryTimer.current = setTimeout(() => {
      if (retryToken.current === token) {
        retryToken.current = null;
        reconcileToken.current = null;
        setPersistenceWarning("The player did not confirm reconciliation. Your running progress is still here; try again or reload the latest save.");
      }
    }, 3000);
    frameRef.current?.contentWindow?.postMessage(
      { channel: MESSAGE_CHANNEL, gameId, sessionId, op: "retry", token }, "*",
    );
  }, [frameRef, gameId, sessionId]);

  const reloadGame = useCallback(() => {
    setReloadKey((key) => key + 1);
  }, []);

  const restoreSavedProgress = useCallback(async (data: GameSaveData, expectedRaw: string | null, expectedRevision: string | null) => {
    if (!gameId) throw new Error("Select an imported HTML game before restoring progress.");
    await withProgressWriteLock(gameId, () => {
      const nextRevision = commitHtmlProgressRestoreWithRevision(gameId, data, expectedRaw, expectedRevision);
      sessionRevision.current = nextRevision;
    });
    // Ignore queued writes from the outgoing player before React replaces it.
    retiredSaveWindow.current = frameRef.current?.contentWindow ?? null;
    setHasSavedProgress(Object.keys(data).length > 0);
    setPersistenceWarning(null);
    revisionConflict.current = false;
    setHasRevisionConflict(false);
    needsSnapshot.current = false;
    oversizedKeys.current.clear();
    oversizedReplacements.current.clear();
    unknownOversizedKey.current = false;
    pendingExplicitClear.current = false;
    setReloadKey(key => key + 1);
  }, [gameId, frameRef]);

  return {
    hasSavedProgress, mediaPlaybackError, persistenceWarning, canRetrySave, retrySaving, reloadKey, sessionId, initialRevision,
    hasRevisionConflict, reconcileStaleProgress, clearSavedProgress, reloadGame, restoreSavedProgress,
  };
}
