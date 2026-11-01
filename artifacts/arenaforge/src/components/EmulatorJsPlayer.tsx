"use client";

import { useEffect, useRef, useState } from "react";
import { browserEmulatorJsAdapter } from "../lib/arcadeRuntimeAdapters";
import {
  arcadeEmulatorGameKey,
  ARCADE_EMULATOR_SYSTEMS,
  EMULATORJS_DATA_URL,
  type ArcadeEmulatorSystemId,
} from "../lib/arcadeEmulatorRuntime";

type EmulatorJsPlayerProps = {
  gameId: string;
  name: string;
  rom: ArrayBuffer;
  system: ArcadeEmulatorSystemId;
};

type PlayerMessage = {
  source?: string;
  gameId?: string;
  type?: string;
};

function safeJson(value: unknown): string {
  return JSON.stringify(value)
    .replace(/</g, "\\u003c")
    .replace(/>/g, "\\u003e")
    .replace(/&/g, "\\u0026");
}

export default function EmulatorJsPlayer({ gameId, name, rom, system }: EmulatorJsPlayerProps) {
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const [playerDocument, setPlayerDocument] = useState("");
  const [status, setStatus] = useState("Preparing the local ROM.");
  const [retryVersion, setRetryVersion] = useState(0);
  const [failed, setFailed] = useState(false);
  const systemInfo = ARCADE_EMULATOR_SYSTEMS[system];

  useEffect(() => {
    const launch = browserEmulatorJsAdapter.launch({ system, gameId });
    const romUrl = URL.createObjectURL(new Blob([rom], { type: "application/octet-stream" }));
    const safeId = safeJson(gameId);
    const sendMessage = `const send = (type) => window.parent.postMessage({ source: "arenaforge-emulatorjs", gameId: ${safeId}, type }, "*");`;
    const config = [
      'window.EJS_player = "#game";',
      `window.EJS_core = ${safeJson(launch.core)};`,
      `window.EJS_gameUrl = ${safeJson(romUrl)};`,
      `window.EJS_gameName = ${safeJson(name)};`,
      `window.EJS_gameID = ${launch.gameKey};`,
      `window.EJS_pathtodata = ${safeJson(launch.dataUrl)};`,
      'window.EJS_language = "en-US";',
      "window.EJS_disableAutoLang = false;",
      "window.EJS_threads = false;",
      "window.EJS_startOnLoaded = true;",
      "window.EJS_volume = 0.7;",
      `window.EJS_defaultOptions = ${safeJson({
        "save-state-location": "browser",
        "save-state-slot": 1,
        "save-save-interval": 60,
      })};`,
      "window.EJS_ready = () => send('ready');",
      "window.EJS_onGameStart = () => send('started');",
      "window.addEventListener('error', (event) => { if (event.target && event.target.tagName === 'SCRIPT') send('load-error'); }, true);",
    ].join("\n");

    setPlayerDocument(`<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Arcade emulator</title>
  <style>
    html, body, #game { width: 100%; height: 100%; margin: 0; overflow: hidden; background: #090c12; color: #f8fafc; }
    #game { min-height: 320px; }
  </style>
</head>
<body>
  <div id="game" aria-label="${systemInfo.label} emulator"></div>
  <script>${sendMessage}\n${config}</script>
  <script src="${EMULATORJS_DATA_URL}loader.js"></script>
</body>
</html>`);
    return () => { URL.revokeObjectURL(romUrl); browserEmulatorJsAdapter.cleanup(launch); };
  }, [gameId, name, rom, system, systemInfo.core, systemInfo.label, retryVersion]);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      setFailed(true);
      setStatus("The game did not report startup within 30 seconds. The pinned core may be unavailable or this game may not be compatible. Check diagnostics; downloading a core is not a gameplay check.");
    }, 30_000);
    const onMessage = (event: MessageEvent<PlayerMessage>) => {
      if (event.source !== iframeRef.current?.contentWindow) return;
      if (event.data?.source !== "arenaforge-emulatorjs" || event.data.gameId !== gameId) return;
      switch (event.data.type) {
        case "ready":
          setStatus("Core ready. Use the player Controls menu for keyboard, gamepad, and touch bindings.");
          break;
        case "started":
          window.clearTimeout(timer);
          setFailed(false);
          setStatus("Running. Save states use browser storage; cartridge saves auto-save every minute.");
          break;
        case "load-error":
          window.clearTimeout(timer);
          setFailed(true);
          setStatus("An EmulatorJS runtime script failed to load. Check access to cdn.emulatorjs.org, then retry. Your ROM remains in this browser.");
          break;
      }
    };
    window.addEventListener("message", onMessage);
    setFailed(false);
    setStatus("Loading the open-source emulator core. The first launch needs internet.");
    return () => { window.clearTimeout(timer); window.removeEventListener("message", onMessage); };
  }, [gameId, retryVersion]);

  return (
    <div className="space-y-2 bg-black/30 p-2 sm:p-3">
      <iframe
        key={gameId}
        ref={iframeRef}
        title={`EmulatorJS player: ${name}`}
        srcDoc={playerDocument}
        sandbox="allow-scripts allow-same-origin"
        allow="autoplay; fullscreen; gamepad"
        allowFullScreen
        referrerPolicy="no-referrer"
        data-testid="emulatorjs-player"
        className="h-[min(72vh,680px)] min-h-[360px] w-full rounded-lg border border-white/10 bg-[#090c12]"
      />
      <p role="status" className="text-center text-[10px] leading-relaxed text-slate-400">{status}</p>
      {failed && <button type="button" className="min-h-11 rounded-lg border border-white/15 px-3 py-2 text-xs text-slate-200" onClick={() => {
        if (window.confirm("Reload the emulator core? The imported ROM and last browser saves stay intact, but any unsaved runtime progress may be lost.")) setRetryVersion(value => value + 1);
      }}>Retry emulator runtime</button>}
    </div>
  );
}
