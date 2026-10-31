import { useCallback, useEffect, useState, type RefObject } from "react";

const STORAGE_PREFIX = "arenaforge.game-save.v1:";
const MESSAGE_CHANNEL = "arenaforge-game-save";
const MAX_SAVE_BYTES = 64 * 1024;
const MAX_KEY_LENGTH = 256;

type GameSaveData = Record<string, string>;

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

function saveRuntimeScript(gameId: string, saved: GameSaveData) {
  const safeId = safelyEmbedJson(gameId);
  const safeSaved = safelyEmbedJson(saved);
  return `<script data-arenaforge-save-runtime>(function(){` +
    `var gameId=${safeId},data=${safeSaved},channel=${safelyEmbedJson(MESSAGE_CHANNEL)};` +
    `function send(op,key,value){try{parent.postMessage({channel:channel,gameId:gameId,op:op,key:key,value:value},"*")}catch(e){}}` +
    `function write(key,value){key=String(key);value=String(value);if(!key||key.length>${MAX_KEY_LENGTH}||value.length>${MAX_SAVE_BYTES})return;` +
    `var old=data[key];data[key]=value;if(JSON.stringify(data).length>${MAX_SAVE_BYTES}){if(old===undefined)delete data[key];else data[key]=old;return}send("set",key,value)}` +
    `var store={getItem:function(key){key=String(key);return Object.prototype.hasOwnProperty.call(data,key)?data[key]:null},setItem:write,` +
    `removeItem:function(key){key=String(key);delete data[key];send("remove",key)},clear:function(){data={};send("clear")},` +
    `key:function(index){return Object.keys(data)[index]||null}};` +
    `Object.defineProperty(store,"length",{get:function(){return Object.keys(data).length}});` +
    `try{Object.defineProperty(window,"localStorage",{configurable:true,value:store})}catch(e){}` +
    `window.__arenaGameSave={get:function(key,fallback){var raw=store.getItem(key);if(raw===null)return fallback;try{return JSON.parse(raw)}catch(e){return raw}},` +
    `set:function(key,value){write(key,JSON.stringify(value))},remove:function(key){store.removeItem(key)},clear:function(){store.clear()}};` +
    `window.addEventListener("message",function(event){var m=event.data;if(event.source===parent&&m&&m.channel===channel&&m.gameId===gameId&&m.op==="clear"){data={}}});` +
    `})();</script>`;
}

export function createGameSandboxDocument(source: string, gameId: string) {
  const csp = `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline' data: blob:; style-src 'unsafe-inline' data: blob:; img-src data: blob:; media-src data: blob:; font-src data: blob:; connect-src 'none'; frame-src 'none'; object-src 'none'; form-action 'none'; base-uri 'none'">`;
  const runtime = saveRuntimeScript(gameId, readSaveData(gameId));
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
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    setHasSavedProgress(gameId ? Object.keys(readSaveData(gameId)).length > 0 : false);
    if (!gameId) return;

    const onMessage = (event: MessageEvent) => {
      if (event.source !== frameRef.current?.contentWindow) return;
      const message = event.data;
      if (!message || message.channel !== MESSAGE_CHANNEL || message.gameId !== gameId) return;

      const current = readSaveData(gameId);
      if (message.op === "clear") {
        try {
          localStorage.removeItem(storageKey(gameId));
        } catch {}
        setHasSavedProgress(false);
        return;
      }
      if (typeof message.key !== "string" || !message.key || message.key.length > MAX_KEY_LENGTH) return;
      if (message.op === "remove") {
        delete current[message.key];
      } else if (message.op === "set" && typeof message.value === "string" && encodedSize(message.value) <= MAX_SAVE_BYTES) {
        current[message.key] = message.value;
      } else {
        return;
      }

      const serialized = JSON.stringify(current);
      if (encodedSize(serialized) > MAX_SAVE_BYTES) return;
      try {
        localStorage.setItem(storageKey(gameId), serialized);
        setHasSavedProgress(Object.keys(current).length > 0);
      } catch {}
    };

    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [frameRef, gameId]);

  const clearSavedProgress = useCallback(() => {
    if (!gameId) return;
    try {
      localStorage.removeItem(storageKey(gameId));
    } catch {}
    frameRef.current?.contentWindow?.postMessage(
      { channel: MESSAGE_CHANNEL, gameId, op: "clear" },
      "*",
    );
    setHasSavedProgress(false);
    setReloadKey((key) => key + 1);
  }, [frameRef, gameId]);

  const reloadGame = useCallback(() => {
    setReloadKey((key) => key + 1);
  }, []);

  return { hasSavedProgress, reloadKey, clearSavedProgress, reloadGame };
}
