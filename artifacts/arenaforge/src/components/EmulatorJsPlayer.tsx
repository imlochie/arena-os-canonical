"use client";

import { useEffect, useRef, useState } from "react";
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
  const systemInfo = ARCADE_EMULATOR_SYSTEMS[system];

  useEffect(() => {
    const romUrl = URL.createObjectURL(new Blob([rom], { type: "application/octet-stream" }));
    const safeId = safeJson(gameId);
    const sendMessage = `const send = (type) => window.parent.postMessage({ source: "arenaforge-emulatorjs", gameId: ${safeId}, type }, "*");`;
    const config = [
      'window.EJS_player = "#game";',
      `window.EJS_core = ${safeJson(systemInfo.core)};`,
      `window.EJS_gameUrl = ${safeJson(romUrl)};`,
      `window.EJS_gameName = ${safeJson(name)};`,
      `window.EJS_gameID = ${arcadeEmulatorGameKey(gameId)};`,
      `window.EJS_pathtodata = ${safeJson(EMULATORJS_DATA_URL)};`,
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
    return () => URL.revokeObjectURL(romUrl);
  }, [gameId, name, rom, system, systemInfo.core, systemInfo.label]);

  useEffect(() => {
    const onMessage = (event: MessageEvent<PlayerMessage>) => {
      if (event.source !== iframeRef.current?.contentWindow) return;
      if (event.data?.source !== "arenaforge-emulatorjs" || event.data.gameId !== gameId) return;
      switch (event.data.type) {
        case "ready":
          setStatus("Core ready. Use the player Controls menu for keyboard, gamepad, and touch bindings.");
          break;
        case "started":
          setStatus("Running. Save states use browser storage; cartridge saves auto-save every minute.");
          break;
      }
    };
    window.addEventListener("message", onMessage);
    setStatus("Loading the open-source emulator core. The first launch needs internet.");
    return () => window.removeEventListener("message", onMessage);
  }, [gameId]);

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
    </div>
  );
}
