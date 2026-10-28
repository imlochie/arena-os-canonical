"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import PrivacyControls from "./PrivacyControls";
import ImportedGameWorkspace from "./ImportedGameWorkspace";
import { createGameSandboxDocument, useArcadeGameSave } from "../lib/arcadeGameSave";
import {
  deleteOfflineSavedGame,
  loadOfflineSavedGames,
  saveOfflineSavedGames,
  type SavedOfflineGame,
} from "../lib/offlineGameStorage";
import { privacyFlags } from "@workspace/arena/lib/privacyClient";
import { loadKeys } from "./KeysBar";
import BrainCard from "@/components/BrainCard";
import {
  GAME_TYPES,
  detectGameType,
  extractGameCode,
  generateGameOffline,
  isClassicCorePrompt,
  validateGameCode,
  LLM_GAME_SYSTEM,
  type GameType,
} from "@workspace/arena/lib/games";
import {
  WEBLLM_MODELS,
  checkWebGPU,
  generateCode,
  getPreferredModel,
  isEngineLoaded,
  loadEngine,
  loadedModelId,
  modelReadyOffline,
  setPreferredModel,
} from "@workspace/arena/lib/webllm";

type Strategy = "auto" | "instant" | "ai";
type ArcadeWorkspace = "create" | "imports";
type ArcadeServerModel = {
  id: string;
  name: string;
  provider?: string;
  backend: string;
  requiresKey?: boolean;
  requiresNetwork?: boolean;
  kind?: string;
};
const SAVE_SLOT_ALIAS_PREFIX = "arenaforge.game-save-slot.v1:";
const SERVER_MODEL_PREFERENCE = "af_arcade_server_model";
const OFFLINE_STARTERS_SEEDED_KEY = "arenaforge.offline-starters-seeded.v1";
const OFFLINE_STARTERS = [
  ...GAME_TYPES.map((meta) => ({
    id: `offline-starter:${meta.id}`,
    title: meta.name,
    prompt: `${meta.name}: ${meta.desc}.`,
    gameType: meta.id,
  })),
  {
    id: "offline-starter:twin-stick",
    title: "Twin-stick survival",
    prompt: "Twin-stick survival: survive enemy waves, aim with the mouse, and collect upgrades.",
    gameType: "arena" as GameType,
  },
];
const LOCAL_CHECK_CHANNEL = "arenaforge-local-model-check";
const LOCAL_CHECK_PROMPT =
  "Create a tiny original HTML5 game for a local model test: draw a blue square on a canvas, move it with arrow keys, let it collect one gold coin, and show a score HUD. Use requestAnimationFrame. Make it one complete offline HTML file with no external URLs or assets.";

type LocalModelCheck = {
  id: string;
  nonce: string;
  source: "webllm" | "model-hub";
  modelId: string;
  via: string;
  code: string;
  bytes: number;
  ms: number;
  tokps?: number;
  status: "checking" | "passed" | "failed";
  message: string;
};

function createLocalModelCheckDocument(code: string, saveId: string, nonce: string) {
  const probe =
    `<script data-arcade-local-check>(function(){` +
    `var channel=${JSON.stringify(LOCAL_CHECK_CHANNEL)},nonce=${JSON.stringify(nonce)};` +
    `function send(type,message){try{parent.postMessage({channel:channel,nonce:nonce,type:type,message:String(message||"").slice(0,240)},"*")}catch(e){}}` +
    `window.addEventListener("error",function(e){send("runtime-error",e.message||"Game script error")},true);` +
    `window.addEventListener("unhandledrejection",function(e){send("runtime-error",e.reason&&e.reason.message||e.reason||"Unhandled promise rejection")});` +
    `document.addEventListener("DOMContentLoaded",function(){if(!document.querySelector("canvas")){send("runtime-error","The game preview did not create a canvas");return}` +
    `requestAnimationFrame(function(){requestAnimationFrame(function(){send("ready","")})})});})();</script>`;
  const document = createGameSandboxDocument(code, saveId);
  return document.replace(/<\/head>/i, `${probe}</head>`);
}

function resolveSaveSlot(gameId: string): string {
  try {
    return localStorage.getItem(`${SAVE_SLOT_ALIAS_PREFIX}${gameId}`) || gameId;
  } catch {
    return gameId;
  }
}

function rememberSaveSlot(gameId: string, saveSlotId: string) {
  try {
    if (gameId !== saveSlotId) localStorage.setItem(`${SAVE_SLOT_ALIAS_PREFIX}${gameId}`, saveSlotId);
  } catch {}
}

const SHOWCASE: { label: string; prompt: string }[] = [
  { label: "Pong", prompt: "Pong" },
  { label: "Platform adventure", prompt: "A platform adventure with wall jumps, moving platforms, and three short levels" },
  { label: "Twin-stick survival", prompt: "A twin-stick survival game with enemy waves, dashes, and upgrade choices" },
  { label: "A new game idea", prompt: "" },
];

export default function ArcadeForge() {
  const [prompt, setPrompt] = useState("");
  const [strategy, setStrategy] = useState<Strategy>("auto");
  const [modelId, setModelId] = useState<string>(WEBLLM_MODELS[0].id);
  const [serverModelId, setServerModelId] = useState("");
  const [serverModels, setServerModels] = useState<ArcadeServerModel[]>([]);

  const [busy, setBusy] = useState(false);
  const [phase, setPhase] = useState("");
  const [game, setGame] = useState<any | null>(null);
  const [tab, setTab] = useState<"play" | "code">("play");
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [history, setHistory] = useState<any[]>([]);
  const [historyError, setHistoryError] = useState<string | null>(null);
  const [historyLoading, setHistoryLoading] = useState(true);
  const [historyAction, setHistoryAction] = useState<{ id: string; kind: "open" | "delete" } | null>(null);
  const historyRetryRef = useRef<(() => void) | null>(null);
  const [offlineGames, setOfflineGames] = useState<SavedOfflineGame[]>([]);
  const [offlineShelfLoading, setOfflineShelfLoading] = useState(true);
  const [offlineShelfError, setOfflineShelfError] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [instruction, setInstruction] = useState("");
  const [iterating, setIterating] = useState(false);
  const [copied, setCopied] = useState(false);
  const [copyError, setCopyError] = useState<string | null>(null);
  const [workspace, setWorkspace] = useState<ArcadeWorkspace>("create");
  const [modelSetupOpen, setModelSetupOpen] = useState(false);

  // On-device AI state
  const [gpu, setGpu] = useState<{ ok: boolean; reason?: string } | null>(null);
  const [engineOn, setEngineOn] = useState(false);
  const [engineModel, setEngineModel] = useState<string | null>(null);
  const [loadProg, setLoadProg] = useState(0);
  const [loadText, setLoadText] = useState("");
  const [loadingModel, setLoadingModel] = useState(false);
  const [tokps, setTokps] = useState<number | null>(null);
  const [streamed, setStreamed] = useState("");
  const [offlineReady, setOfflineReady] = useState<string | null>(null);
  const [localCheckRunning, setLocalCheckRunning] = useState(false);
  const [activeCheckSource, setActiveCheckSource] = useState<"webllm" | "model-hub" | null>(null);
  const [localCheckError, setLocalCheckError] = useState<string | null>(null);
  const [localModelCheck, setLocalModelCheck] = useState<LocalModelCheck | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const gameFrameRef = useRef<HTMLIFrameElement>(null);
  const localCheckFrameRef = useRef<HTMLIFrameElement>(null);
  const localCheckAbortRef = useRef<AbortController | null>(null);
  const localModelCheckRef = useRef<LocalModelCheck | null>(null);
  localModelCheckRef.current = localModelCheck;
  const saveSlotId = game?.saveSlotId ?? game?.id ?? null;
  const gameSaves = useArcadeGameSave(gameFrameRef, saveSlotId);

  const fetchHistory = useCallback(async () => {
    setHistoryLoading(true);
    try {
      const r = await fetch("/api/arcade?limit=30");
      const j = await r.json().catch(() => null);
      if (!r.ok) throw new Error(j?.error ?? `Could not load saved games (${r.status}).`);
      if (!Array.isArray(j?.games)) throw new Error("The saved-game list response was invalid.");
      setHistory(j.games);
      setHistoryError(null);
      historyRetryRef.current = null;
    } catch (error) {
      setHistoryError(error instanceof Error ? error.message : "Could not load saved games.");
      historyRetryRef.current = () => { void fetchHistory(); };
    } finally {
      setHistoryLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchHistory();
    setModelId(getPreferredModel());
    setOfflineReady(modelReadyOffline());
    checkWebGPU().then(setGpu).catch(() => setGpu({ ok: false, reason: "check failed" }));
    setEngineOn(isEngineLoaded());
    setEngineModel(loadedModelId());
    fetch("/api/models")
      .then((response) => response.json())
      .then((body) => {
        const choices = Array.isArray(body.models) ? body.models as ArcadeServerModel[] : [];
        setServerModels(choices);
        const saved = localStorage.getItem(SERVER_MODEL_PREFERENCE);
        if (saved && choices.some((choice) => choice.id === saved)) setServerModelId(saved);
      })
      .catch(() => {});
  }, [fetchHistory]);

  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      const current = localModelCheckRef.current;
      const frame = localCheckFrameRef.current;
      const message = event.data;
      if (
        !current ||
        !frame ||
        event.source !== frame.contentWindow ||
        !message ||
        message.channel !== LOCAL_CHECK_CHANNEL ||
        message.nonce !== current.nonce
      ) return;

      setLocalModelCheck((existing) => {
        if (!existing || existing.id !== current.id) return existing;
        if (message.type === "runtime-error") {
          return {
            ...existing,
            status: "failed",
            message: String(message.message || "The generated game had a startup error.").slice(0, 240),
          };
        }
        if (message.type === "ready" && existing.status === "checking") {
          return {
            ...existing,
            status: "passed",
            message: existing.source === "model-hub"
              ? "The selected local model generated a valid game and it started in the isolated preview. WebGPU and remote providers were not used."
              : "The generated game passed validation and started in the isolated preview without a startup error.",
          };
        }
        return existing;
      });
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, []);

  useEffect(() => {
    if (!localModelCheck || localModelCheck.status !== "checking") return;
    const checkId = localModelCheck.id;
    const timer = window.setTimeout(() => {
      setLocalModelCheck((current) => current?.id === checkId && current.status === "checking"
        ? { ...current, status: "failed", message: "The generated game did not finish starting in the isolated preview." }
        : current);
    }, 12000);
    return () => window.clearTimeout(timer);
  }, [localModelCheck?.id, localModelCheck?.status]);

  useEffect(() => () => localCheckAbortRef.current?.abort(), []);

  useEffect(() => {
    let active = true;
    async function initializeOfflineShelf() {
      try {
        let stored = await loadOfflineSavedGames();
        if (localStorage.getItem(OFFLINE_STARTERS_SEEDED_KEY) !== "1") {
          const existingIds = new Set(stored.map((item) => item.id));
          const now = Date.now();
          const starters = OFFLINE_STARTERS
            .filter((starter) => !existingIds.has(starter.id))
            .map((starter) => {
              const generated = generateGameOffline(starter.prompt, starter.gameType);
              const validation = validateGameCode(generated.code);
              if (!validation.ok) {
                throw new Error(`${starter.title} could not be added to the offline shelf: ${validation.issues.join("; ")}`);
              }
              return {
                ...starter,
                code: generated.code,
                engine: generated.engine,
                saveSlotId: starter.id,
                starter: true,
                createdAt: now,
                updatedAt: now,
              } satisfies SavedOfflineGame;
            });
          if (starters.length) {
            await saveOfflineSavedGames(starters);
            stored = [...stored, ...starters];
          }
          localStorage.setItem(OFFLINE_STARTERS_SEEDED_KEY, "1");
        }
        if (active) setOfflineGames(stored.sort((a, b) => a.title.localeCompare(b.title)));
      } catch (e) {
        if (active) setOfflineShelfError(e instanceof Error ? e.message : "Could not load offline games.");
      } finally {
        if (active) setOfflineShelfLoading(false);
      }
    }
    void initializeOfflineShelf();
    return () => {
      active = false;
    };
  }, []);

  function chooseServerModel(id: string) {
    setServerModelId(id);
    try {
      if (id) localStorage.setItem(SERVER_MODEL_PREFERENCE, id);
      else localStorage.removeItem(SERVER_MODEL_PREFERENCE);
    } catch {}
  }

  async function ensureEngine(): Promise<boolean> {
    if (isEngineLoaded()) {
      setEngineOn(true);
      setEngineModel(loadedModelId());
      return true;
    }
    const g = await checkWebGPU();
    setGpu(g);
    if (!g.ok) {
      setError(`🧠 On-device AI unavailable: ${g.reason} — instant cores still work fully offline.`);
      return false;
    }
    setLoadingModel(true);
    setLoadProg(0);
    setLoadText("connecting…");
    try {
      await loadEngine(modelId, (p) => {
        setLoadProg(p.progress);
        setLoadText(p.text);
      });
      setEngineOn(true);
      setEngineModel(modelId);
      setOfflineReady(modelId);
      return true;
    } catch (e: any) {
      setError(`Model load failed: ${e.message ?? e}. Instant cores still work offline.`);
      return false;
    } finally {
      setLoadingModel(false);
    }
  }

  async function runLocalGenerationCheck() {
    if (!engineOn || localCheckRunning || busy || iterating) return;
    localCheckAbortRef.current?.abort();
    const controller = new AbortController();
    localCheckAbortRef.current = controller;
    const nonce = crypto.randomUUID();
    setLocalModelCheck(null);
    setLocalCheckError(null);
    setLocalCheckRunning(true);
    setActiveCheckSource("webllm");
    setBusy(true);
    setError(null);
    setNotice(null);
    setPhase("Running a real local generation check…");
    setStreamed("");

    try {
      const result = await generateCode({
        system: LLM_GAME_SYSTEM,
        user: LOCAL_CHECK_PROMPT,
        maxTokens: 3000,
        temperature: 0.2,
        signal: controller.signal,
        onToken: (token) => setStreamed((current) => (current + token).slice(-6000)),
      });
      if (controller.signal.aborted) return;
      const code = extractGameCode(result.text);
      if (!code) throw new Error("The model did not return a complete HTML game.");
      const validation = validateGameCode(code);
      if (!validation.ok) {
        throw new Error(`Generated HTML failed Arcade validation: ${validation.issues.join("; ")}`);
      }
      const id = `local-model-check:${nonce}`;
      setLocalModelCheck({
        id,
        nonce,
        source: "webllm",
        modelId: loadedModelId() ?? engineModel ?? modelId,
        via: "webllm",
        code,
        bytes: validation.bytes,
        ms: result.ms,
        tokps: result.tokps,
        status: "checking",
        message: "Generated and validated. Waiting for the isolated preview to start…",
      });
    } catch (cause) {
      if (!controller.signal.aborted) {
        const message = cause instanceof Error ? cause.message : "The local generation check failed.";
        setLocalCheckError(message.slice(0, 500));
      }
    } finally {
      if (localCheckAbortRef.current === controller) localCheckAbortRef.current = null;
      setLocalCheckRunning(false);
      setActiveCheckSource(null);
      setBusy(false);
      setPhase("");
      setStreamed("");
    }
  }

  async function runConnectedModelGenerationCheck() {
    const selected = serverModels.find((model) => model.id === serverModelId);
    if (!selected || selected.backend !== "local-server") {
      setLocalCheckError("Select a local Model Hub model before running this check.");
      return;
    }
    if (localCheckRunning || busy || iterating) return;

    localCheckAbortRef.current?.abort();
    const controller = new AbortController();
    localCheckAbortRef.current = controller;
    const nonce = crypto.randomUUID();
    setLocalModelCheck(null);
    setLocalCheckError(null);
    setLocalCheckRunning(true);
    setActiveCheckSource("model-hub");
    setBusy(true);
    setError(null);
    setNotice(null);
    setPhase("Testing the selected local model…");
    setStreamed("");

    try {
      const response = await fetch("/api/arcade/forge", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          prompt: LOCAL_CHECK_PROMPT,
          modelId: selected.id,
          localOnly: true,
          ephemeral: true,
        }),
        signal: controller.signal,
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(body.error ?? "The selected local model could not create a game.");
      const code = typeof body.code === "string" ? body.code : "";
      if (!code) throw new Error("The local model did not return a complete HTML game.");
      const validation = validateGameCode(code);
      if (!validation.ok) {
        throw new Error(`Generated HTML failed Arcade validation: ${validation.issues.join("; ")}`);
      }

      const runtime = body.runtime ?? {};
      setLocalModelCheck({
        id: `model-hub-check:${nonce}`,
        nonce,
        source: "model-hub",
        modelId: String(runtime.modelId ?? selected.id),
        via: String(runtime.via ?? selected.provider ?? selected.backend),
        code,
        bytes: validation.bytes,
        ms: Number.isFinite(Number(runtime.ms)) ? Number(runtime.ms) : 0,
        status: "checking",
        message: "Generated and validated. Waiting for the isolated preview to start…",
      });
    } catch (cause) {
      if (!controller.signal.aborted) {
        const message = cause instanceof Error ? cause.message : "The local model generation check failed.";
        setLocalCheckError(message.slice(0, 500));
      }
    } finally {
      if (localCheckAbortRef.current === controller) localCheckAbortRef.current = null;
      setLocalCheckRunning(false);
      setActiveCheckSource(null);
      setBusy(false);
      setPhase("");
      setStreamed("");
    }
  }

  function clearLocalGenerationCheck() {
    localCheckAbortRef.current?.abort();
    setLocalModelCheck(null);
    setLocalCheckError(null);
  }

  function persistGame(payload: any) {
    return fetch("/api/arcade", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...payload, ...privacyFlags() }),
    }).then(async (r) => {
      const j = await r.json();
      if (!r.ok) throw new Error(j.error ?? "save failed");
      return j.game;
    });
  }

  async function runInstant(p: string, type: GameType, parentId?: string) {
    const t0 = performance.now();
    // Instant path runs 100% locally in this browser tab — not even a server
    // round-trip is needed for generation. Then we persist the result.
    const g = generateGameOffline(p, type);
    const v = validateGameCode(g.code);
    if (!v.ok) throw new Error("core validation failed: " + v.issues.join("; "));
    const ms = Math.round(performance.now() - t0);
    const flags = privacyFlags();
    if (flags.ephemeral) {
      const logged = await persistGame({ prompt: p, clientCode: g.code, gameType: g.gameType, engine: g.engine });
      setGame({ ...logged, code: g.code, genMs: ms, engine: g.engine, saveSlotId: logged.id });
    } else {
      const saved = await persistGame({ prompt: p, clientCode: g.code, gameType: g.gameType, parentId });
      // server stamps engine as on-device-ai for clientCode; correct it for cores
      setGame({ ...saved, code: g.code, genMs: ms, engine: g.engine, saveSlotId: saved.id });
      fetchHistory();
    }
    setNotice(`⚡ ${g.title} forged in ${ms}ms (${g.engine}) — validated, ${(g.code.length / 1024).toFixed(1)}KB single file.`);
  }

  async function saveOfflineRevision(
    id: string,
    promptText: string,
    code: string,
    engine: SavedOfflineGame["engine"],
  ): Promise<SavedOfflineGame> {
    const existing = offlineGames.find((item) => item.id === id);
    if (!existing) throw new Error("This offline game is no longer in your local shelf.");
    const updated = { ...existing, prompt: promptText, code, engine, updatedAt: Date.now() };
    await saveOfflineSavedGames([updated]);
    setOfflineGames((current) => current.map((item) => item.id === id ? updated : item));
    return updated;
  }

  async function runServerAI(
    p: string,
    parentId?: string,
    priorCode?: string,
    inheritedSaveSlot?: string,
    routeModelId: string | undefined = serverModelId || undefined,
    localOfflineId?: string,
  ) {
    const routedModelId = routeModelId ?? serverModelId;
    const selectedModel = serverModels.find((model) => model.id === routedModelId);
    const controller = selectedModel?.backend === "local-server" ? new AbortController() : null;
    if (controller) abortRef.current = controller;
    setPhase(selectedModel?.backend === "local-server" ? "🖥️ Local model writing your game…" : "✨ AI writing your game (server)…");
    const flags = privacyFlags();
    try {
      const res = await fetch("/api/arcade/forge", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          prompt: p,
          keys: flags.localOnly ? undefined : loadKeys(),
          modelId: routeModelId,
          parentId: localOfflineId ? undefined : parentId,
          priorCode,
          ...flags,
          ephemeral: flags.ephemeral || Boolean(localOfflineId),
        }),
        ...(controller ? { signal: controller.signal } : {}),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(body.error ?? "No game-writing model is reachable.");
      }
      if (typeof body.code !== "string") throw new Error("The model did not return a complete playable game.");
      const rt = body.runtime ?? {};
      const temporaryLocalRevision = Boolean(localOfflineId && flags.ephemeral);
      const gameId = temporaryLocalRevision ? crypto.randomUUID() : localOfflineId ?? body.game?.id ?? crypto.randomUUID();
      const gameSaveSlot = temporaryLocalRevision ? gameId : inheritedSaveSlot ?? resolveSaveSlot(gameId);
      rememberSaveSlot(gameId, gameSaveSlot);
      const localSaved = localOfflineId && !flags.ephemeral
        ? await saveOfflineRevision(localOfflineId, p, body.code, "remix")
        : null;
      setGame({
        ...(localSaved ?? {}),
        ...(body.game ?? {}),
        id: gameId,
        prompt: p,
        gameType: localSaved?.gameType ?? body.game?.gameType ?? detectGameType(p),
        code: body.code,
        engine: "ai-codegen",
        runtime: rt,
        genMs: rt.ms,
        ephemeral: flags.ephemeral,
        saveSlotId: gameSaveSlot,
        localOffline: Boolean(localSaved),
      });
      if (!flags.ephemeral && !localOfflineId) fetchHistory();
      setNotice(localSaved
        ? `Updated “${localSaved.title}” in your offline shelf. The original game slot and progress are preserved.`
        : `${body.title ?? "Game"} is playable${body.repairsUsed ? " (repaired after validation)" : ""}. You can now ask for a specific change.`);
    } finally {
      if (controller && abortRef.current === controller) abortRef.current = null;
    }
  }

  async function runAI(
    p: string,
    parentId?: string,
    priorCode?: string,
    inheritedSaveSlot?: string,
    localOfflineId?: string,
  ) {
    const ok = await ensureEngine();
    if (!ok) {
      const status = await checkWebGPU();
      if (!status.ok) {
        throw new Error(`This browser cannot run the local game-writing model: ${status.reason} Enable WebGPU or connect a game-writing model, then retry.`);
      }
      throw new Error("The local model could not be loaded. Open Model setup to check the download and try again.");
    }
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    setStreamed("");
    setPhase("🧠 On-device AI writing your game…");
    const user = priorCode
      ? `Modify this complete single-file HTML5 game per the instruction.\n\nINSTRUCTION: ${p}\n\nCURRENT GAME FILE:\n${priorCode.slice(0, 30000)}`
      : `Create a complete single-file HTML5 arcade game: ${p}\nMake it polished and complete. OUTPUT ONLY THE HTML FILE.`;
    try {
      const res = await generateCode({
        system: LLM_GAME_SYSTEM,
        user,
        signal: ctrl.signal,
        onToken: (t) => setStreamed((s) => (s + t).slice(-6000)),
      });
      setTokps(res.tokps);
      const code = extractGameCode(res.text);
      if (!code) throw new Error("AI output wasn't a complete game file");
      const v = validateGameCode(code);
      if (!v.ok) {
        throw new Error(`The generated game did not pass validation: ${v.issues.join("; ")}`);
      }
      const type = detectGameType(p);
      const runtime = {
        backend: "webllm",
        modelId: loadedModelId() ?? engineModel ?? modelId,
        via: "webllm",
        fallback: false,
      };
      if (localOfflineId && !privacyFlags().ephemeral) {
        const saved = await saveOfflineRevision(localOfflineId, p, code, "on-device-ai");
        const gameSaveSlot = inheritedSaveSlot ?? saved.saveSlotId;
        setGame({
          ...saved,
          code,
          genMs: res.ms,
          tokps: res.tokps,
          tokens: res.tokens,
          engine: "on-device-ai",
          runtime,
          saveSlotId: gameSaveSlot,
          localOffline: true,
        });
        setNotice(`Updated “${saved.title}” locally. The offline copy and its progress are preserved.`);
        return;
      }
      if (localOfflineId && privacyFlags().ephemeral) {
        const temporaryId = crypto.randomUUID();
        setGame({
          id: temporaryId,
          prompt: p,
          gameType: type,
          code,
          genMs: res.ms,
          tokps: res.tokps,
          tokens: res.tokens,
          engine: "on-device-ai",
          runtime,
          ephemeral: true,
          saveSlotId: temporaryId,
        });
        setNotice("Temporary revision is ready. The saved offline original was not changed.");
        return;
      }
      const saved = await persistGame({ prompt: p, clientCode: code, gameType: type, parentId });
      const gameSaveSlot = inheritedSaveSlot ?? saved.id;
      rememberSaveSlot(saved.id, gameSaveSlot);
      setGame({
        ...saved,
        code,
        genMs: res.ms,
        tokps: res.tokps,
        tokens: res.tokens,
        engine: "on-device-ai",
        runtime,
        saveSlotId: gameSaveSlot,
      });
      if (!saved.ephemeral) fetchHistory();
      setNotice(`🧠 On-device AI forged a ${(code.length / 1024).toFixed(1)}KB game in ${(res.ms / 1000).toFixed(1)}s (${res.tokps} tok/s) — 100% offline, validated.`);
    } finally {
      setStreamed("");
      abortRef.current = null;
    }
  }

  function shouldRouteToServerModel(localOnly: boolean, hasConnectedProvider: boolean): boolean {
    if (strategy === "ai") return false;
    const hasSelectedModel = serverModelId.trim() !== "";
    const selectedModelIsLocal = hasSelectedModel && serverModels.some(
      (model) => model.id === serverModelId && model.backend === "local-server",
    );
    if (hasSelectedModel) return !localOnly || selectedModelIsLocal;
    return !localOnly && !isEngineLoaded() && hasConnectedProvider;
  }

  function generationRuntimeLabel(runtime: any): string | null {
    if (!runtime || typeof runtime.backend !== "string") return null;
    if (runtime.fallback) return "Fallback runtime";
    if (runtime.backend === "local-server") {
      const selected = serverModels.find((model) => model.id === runtime.modelId);
      const modelName = selected?.name ?? runtime.via?.split("/").at(-1) ?? runtime.modelId;
      return `Local Model Hub · ${modelName}`;
    }
    if (runtime.backend === "webllm") return `Browser model · ${runtime.modelId}`;
    if (runtime.backend === "offline-core" || runtime.backend === "arena-local-engine") {
      return "Offline engine · not model-generated";
    }
    const selected = serverModels.find((model) => model.id === runtime.modelId);
    return `Remote model · ${selected?.name ?? runtime.modelId ?? runtime.backend}`;
  }

  async function run(p?: string) {
    const q = (p ?? prompt).trim();
    if (!q || busy) return;
    setPrompt(q);
    setBusy(true);
    setError(null);
    setNotice(null);
    setTab("play");
    setPhase("Forging…");
    try {
      const type = detectGameType(q);
      if (strategy === "instant") {
        if (!isClassicCorePrompt(q)) throw new Error("Quick cores start standard classics such as Pong or Snake. Choose Automatic for custom mechanics.");
        await runInstant(q, type);
      } else if (strategy === "ai") {
        await runAI(q);
      } else {
        const flags = privacyFlags();
        const hasConnectedProvider = Object.values(loadKeys()).some((key) => typeof key === "string" && key.length > 0);
        if (
          strategy === "auto" &&
          shouldRouteToServerModel(flags.localOnly, hasConnectedProvider)
        ) {
          await runServerAI(q);
        } else {
          await runAI(q);
        }
      }
    } catch (e: any) {
      if (e?.name === "AbortError") {
        setError(null);
        setNotice(game ? "Generation stopped. Your current game is unchanged." : "Generation stopped. No game was saved.");
        return;
      }
      const message = e.message ?? "forge failed";
      setError(message);
      if (/no game-writing model is reachable|not loaded|webgpu unavailable/i.test(message)) {
        setModelSetupOpen(true);
        window.requestAnimationFrame(() => {
          const setupToggle = document.querySelector<HTMLElement>('[data-testid="arcade-model-setup-toggle"]');
          setupToggle?.scrollIntoView({ block: "start" });
          setupToggle?.focus();
        });
      }
    } finally {
      setBusy(false);
      setPhase("");
    }
  }

  async function iterate() {
    const ins = instruction.trim();
    if (!ins || !game || iterating || busy) return;
    if (game.ephemeral) {
      setError("👻 Ephemeral games are single-run — disable Ephemeral to iterate.");
      return;
    }
    setIterating(true);
    setError(null);
    setNotice(null);
    try {
      const combined = `${game.prompt} — CHANGE: ${ins}`;
      const flags = privacyFlags();
      const hasConnectedProvider = Object.values(loadKeys()).some((key) => typeof key === "string" && key.length > 0);
      if (shouldRouteToServerModel(flags.localOnly, hasConnectedProvider)) {
        await runServerAI(
          ins,
          game.localOffline ? undefined : game.id,
          game.code,
          game.saveSlotId ?? game.id,
          undefined,
          game.localOffline ? game.id : undefined,
        );
      } else {
        await runAI(
          combined,
          game.localOffline ? undefined : game.id,
          game.code,
          game.saveSlotId ?? game.id,
          game.localOffline ? game.id : undefined,
        );
      }
      setInstruction("");
    } catch (e: any) {
      if (e?.name === "AbortError") {
        setError(null);
        setNotice("Revision stopped. Your current game is unchanged.");
      } else {
        setError(e.message ?? "iterate failed");
      }
    } finally {
      setIterating(false);
    }
  }

  async function reviseImportedSource(source: string, instruction: string): Promise<string> {
    if (source.length > 50_000) {
      throw new Error("Game source sent for revision is limited to 50 KB after media is removed.");
    }
    const flags = privacyFlags();
    const hasConnectedProvider = Object.values(loadKeys()).some((key) => typeof key === "string" && key.length > 0);
    const useServerModel = shouldRouteToServerModel(flags.localOnly, hasConnectedProvider);
    if (!useServerModel) {
      const ready = await ensureEngine();
      if (!ready) {
        const status = await checkWebGPU();
        throw new Error(status.ok
          ? "The local model could not be loaded. Open Model setup to check the download and try again."
          : `This browser cannot run the local game-writing model: ${status.reason} Enable WebGPU or connect a game-writing model, then retry.`);
      }
      const result = await generateCode({
        system:
          "You revise authorized HTML5 browser games by changing their actual gameplay code. Return only the complete HTML document. " +
          "Preserve existing mechanics and controls unless the request changes them. Keep every data:ARENA_ASSET_TOKEN_NNNN marker exactly once in its original location; these stand for local bundled media. " +
          "Keep or add meaningful progress saving with localStorage; Arcade provides an isolated per-game localStorage bridge. " +
          "Do not add network access, imports, external resources, browser navigation, or parent-window access.",
        user:
          `Modify this complete HTML browser game according to the requested change.\n\n` +
          `REQUESTED CHANGE:\n${instruction}\n\nCURRENT GAME SOURCE:\n${source}`,
      });
      const revised = extractGameCode(result.text);
      if (!revised) throw new Error("The model did not return a complete HTML game.");
      return revised;
    }

    const response = await fetch("/api/arcade/import/revise", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        prompt: instruction,
        priorCode: source,
        keys: flags.localOnly ? undefined : loadKeys(),
        modelId: serverModelId || undefined,
        ...flags,
        ephemeral: true,
      }),
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(body.error ?? "No game-writing model is available.");
    if (typeof body.code !== "string") throw new Error("The model did not return a complete HTML game.");
    return body.code;
  }

  function useRemakePrompt(remakePrompt: string) {
    setPrompt(remakePrompt);
    setStrategy("auto");
    setWorkspace("create");
    setNotice("Remake prompt loaded. Review it, then create a new browser game.");
    setError(null);
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  function download() {
    if (!game?.code) return;
    const blob = new Blob([game.code], { type: "text/html" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `arenaforge-${game.gameType}-${game.id.slice(0, 8)}.html`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  }

  async function copyCode() {
    if (!game?.code) return;
    setCopyError(null);
    setCopied(false);
    try {
      if (!navigator.clipboard?.writeText) {
        throw new Error("Clipboard access is unavailable. Use the .html download instead.");
      }
      await navigator.clipboard.writeText(game.code);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch (error) {
      setCopyError(error instanceof Error
        ? `Could not copy game source: ${error.message}`
        : "Could not copy game source. Use the .html download instead.");
    }
  }

  async function openGame(id: string) {
    setHistoryError(null);
    historyRetryRef.current = null;
    setHistoryAction({ id, kind: "open" });
    try {
      const r = await fetch(`/api/arcade/${id}`);
      const j = await r.json().catch(() => null);
      if (!r.ok) throw new Error(j?.error ?? `Could not open saved game (${r.status}).`);
      if (!j?.game) throw new Error("The server returned no saved game.");
      setGame({ ...j.game, saveSlotId: j.game.saveSlotId ?? resolveSaveSlot(j.game.id) });
      setTab("play");
      setNotice(null);
      setError(null);
      window.scrollTo({ top: 0, behavior: "smooth" });
    } catch (error) {
      setHistoryError(error instanceof Error ? error.message : "Could not open saved game.");
      historyRetryRef.current = () => { void openGame(id); };
    } finally {
      setHistoryAction(null);
    }
  }

  function openOfflineGame(saved: SavedOfflineGame) {
    setGame({
      ...saved,
      localOffline: true,
      ephemeral: false,
      saveSlotId: saved.saveSlotId || saved.id,
    });
    setPrompt(saved.prompt);
    setWorkspace("create");
    setTab("play");
    setNotice("Opened from your offline shelf. Play it, inspect its source, or prompt a change.");
    setError(null);
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  async function deleteOfflineGame(id: string) {
    const saved = offlineGames.find((item) => item.id === id);
    if (!saved || !confirm(`Remove “${saved.title}” from this browser's offline shelf?`)) return;
    try {
      await deleteOfflineSavedGame(id);
      try {
        localStorage.removeItem(`arenaforge.game-save.v1:${saved.saveSlotId || id}`);
      } catch {}
      setOfflineGames((current) => current.filter((item) => item.id !== id));
      if (game?.id === id) setGame(null);
    } catch (e) {
      setOfflineShelfError(e instanceof Error ? e.message : "Could not remove the offline game.");
    }
  }

  async function deleteGame(id: string, confirmed = false) {
    if (!confirmed && !confirm("Delete this game?")) return;
    setHistoryError(null);
    historyRetryRef.current = null;
    setHistoryAction({ id, kind: "delete" });
    try {
      const response = await fetch(`/api/arcade/${id}`, { method: "DELETE" });
      if (!response.ok) {
        const payload = await response.json().catch(() => null);
        throw new Error(payload?.error ?? `Could not delete saved game (${response.status}).`);
      }
      setHistory((current) => current.filter((item: any) => item.id !== id));
      if (game?.id === id) setGame(null);
    } catch (error) {
      setHistoryError(error instanceof Error ? error.message : "Could not delete saved game.");
      historyRetryRef.current = () => { void deleteGame(id, true); };
    } finally {
      setHistoryAction(null);
    }
  }

  const filtered = history.filter((h: any) =>
    search.trim() ? h.prompt.toLowerCase().includes(search.toLowerCase()) : true
  );
  const detected = prompt.trim() ? detectGameType(prompt) : null;
  const serverModelChoices = serverModels.filter(
    (model) => model.kind === "text" && model.backend !== "arena-local-engine" && model.backend !== "webllm",
  );
  const selectedLocalServerModel = serverModels.some(
    (model) => model.id === serverModelId && model.backend === "local-server",
  );

  return (
    <div className="grid gap-5 lg:grid-cols-[1fr_300px]">
      <div className="min-w-0">
        {/* Engine status */}
        <details
          data-testid="arcade-model-setup"
          open={loadingModel || modelSetupOpen}
          onToggle={(event) => setModelSetupOpen(event.currentTarget.open)}
          className="glass rounded-2xl p-4"
        >
          <summary data-testid="arcade-model-setup-toggle" className="cursor-pointer text-sm font-bold text-slate-200">
            Model setup <span className="ml-2 text-xs font-normal text-slate-400">{engineOn ? "On-device model loaded" : "Model Hub and browser models"}</span>
          </summary>
          <div className="mt-3">
          <div className="flex flex-wrap items-center gap-2">
            <span data-testid="arcade-webgpu-status" className={`rounded-full px-2.5 py-1 text-[11px] font-extrabold ring-1 ${gpu === null ? "bg-white/5 text-slate-400 ring-white/10" : gpu.ok ? "bg-emerald-500/15 text-emerald-200 ring-emerald-400/40" : "bg-red-500/15 text-red-200 ring-red-400/40"}`}>
              {gpu === null ? "🔍 checking WebGPU…" : gpu.ok ? "⚡ WebGPU ready" : "🚫 WebGPU unavailable"}
            </span>
            <span className={`rounded-full px-2.5 py-1 text-[11px] font-extrabold ring-1 ${engineOn ? "bg-violet-500/15 text-violet-200 ring-violet-400/40" : "bg-white/5 text-slate-400 ring-white/10"}`}>
              {engineOn ? `🧠 AI loaded (${WEBLLM_MODELS.find((m) => m.id === engineModel)?.name ?? "custom"})` : "🧠 AI not loaded"}
            </span>
            {offlineReady && (
              <span className="rounded-full bg-cyan-500/15 px-2.5 py-1 text-[11px] font-extrabold text-cyan-200 ring-1 ring-cyan-400/40">
                📴 Offline-ready
              </span>
            )}
            {tokps !== null && (
              <span className="rounded-full bg-white/5 px-2.5 py-1 font-mono text-[11px] font-bold text-slate-300 ring-1 ring-white/10">
                {tokps} tok/s
              </span>
            )}
            <span className="rounded-full bg-emerald-500/15 px-2.5 py-1 text-[11px] font-extrabold text-emerald-200 ring-1 ring-emerald-400/40">
              ⚡ Classic cores: instant
            </span>
          </div>
          <p data-testid="arcade-model-runtime-explanation" className="mt-2 text-[11px] leading-relaxed text-slate-400">
            The browser-loaded model needs WebGPU. Model Hub models do not; they run wherever Arena’s API server runs—on this PC in the packaged desktop app, on the host in a browser preview.
          </p>

          <BrainCard context="arcade" />

          {/* Model loader */}
          <div className="mt-3 flex flex-col gap-2 rounded-xl border border-white/5 bg-black/20 p-3 sm:flex-row sm:items-center">
            <select
              value={modelId}
              onChange={(e) => {
                setModelId(e.target.value);
                setPreferredModel(e.target.value);
              }}
              disabled={loadingModel || engineOn}
              className="flex-1 rounded-lg border border-white/10 bg-black/40 px-3 py-2 text-xs font-semibold text-white focus:border-violet-500 focus:outline-none disabled:opacity-50"
            >
              {WEBLLM_MODELS.map((m) => (
                <option key={m.id} value={m.id}>{m.name} · {m.size} — {m.desc}</option>
              ))}
            </select>
            {!engineOn ? (
              <button
                onClick={() => ensureEngine()}
                disabled={loadingModel || gpu?.ok === false}
                className="btn-arena rounded-xl px-5 py-2 text-xs font-extrabold text-white disabled:opacity-50"
                title="Downloads once, then cached for offline use"
              >
                {loadingModel ? `⬇️ ${(loadProg * 100).toFixed(0)}%` : "⬇️ Load on-device AI"}
              </button>
            ) : (
              <span className="text-xs font-bold text-emerald-300">✓ cached — works offline from now on</span>
            )}
          </div>
          <div className="mt-3 rounded-xl border border-white/5 bg-black/20 p-3">
            <label htmlFor="arcade-server-model" className="block text-xs font-bold text-slate-200">
              Connected model source
            </label>
            <div className="mt-2 flex flex-col gap-2 sm:flex-row">
              <select
                id="arcade-server-model"
                aria-label="Connected model source"
                value={serverModelId}
                onChange={(event) => chooseServerModel(event.target.value)}
                className="min-w-0 flex-1 rounded-lg border border-white/10 bg-black/40 px-3 py-2 text-xs font-semibold text-white focus:border-violet-500 focus:outline-none"
              >
                <option value="">Automatic — configured provider or on-device</option>
                {serverModelChoices.map((model) => (
                  <option key={model.id} value={model.id}>
                    {model.name} · {model.provider ?? model.backend}
                    {model.requiresKey ? " · key required" : ""}
                    {model.requiresNetwork ? " · network" : ""}
                  </option>
                ))}
              </select>
              <a
                href="/model-hub"
                className="rounded-lg border border-white/10 px-3 py-2 text-center text-xs font-bold text-slate-200 hover:bg-white/5"
              >
                Add local models
              </a>
            </div>
            <p className="mt-2 text-[11px] leading-relaxed text-slate-400">
              Select a listed provider or Model Hub runtime to route game code there. Automatic uses an available model. Local Mode blocks remote AI providers and sends no provider keys, but prompts still reach Arena’s API server.
            </p>
          </div>
          {loadingModel && (
            <div className="mt-2">
              <div className="h-1.5 overflow-hidden rounded-full bg-white/5">
                <div className="h-full rounded-full bg-gradient-to-r from-violet-500 to-cyan-400 transition-all" style={{ width: `${loadProg * 100}%` }} />
              </div>
              <p className="mt-1 truncate text-[11px] text-slate-400">{loadText}</p>
            </div>
          )}
          <div data-testid="local-generation-check-panel" className="mt-3 rounded-xl border border-cyan-400/20 bg-cyan-500/5 p-3">
            <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
              <div>
                <p className="text-xs font-extrabold text-cyan-100">Prove local game generation</p>
                <p className="mt-1 text-[11px] leading-relaxed text-slate-400">
                  Test either the loaded browser model or a selected Model Hub runtime. The browser model needs WebGPU; the Model Hub test sends only this fixed prompt to the app machine’s loopback model. Both validate and boot the game in an isolated preview without saving it.
                </p>
              </div>
              <div className="flex shrink-0 flex-wrap gap-2">
                <button
                  type="button"
                  data-testid="button-local-generation-check"
                  onClick={runLocalGenerationCheck}
                  disabled={!engineOn || localCheckRunning || busy || iterating || loadingModel}
                  title={engineOn ? "Generate and validate a temporary game with the loaded browser model" : "Load the browser model first"}
                  className="rounded-lg border border-cyan-300/30 bg-cyan-400/10 px-3 py-2 text-xs font-extrabold text-cyan-100 hover:bg-cyan-400/20 disabled:cursor-not-allowed disabled:opacity-40"
                >
                  {activeCheckSource === "webllm" ? "Generating locally…" : "Test browser model"}
                </button>
                <button
                  type="button"
                  data-testid="button-local-server-generation-check"
                  onClick={runConnectedModelGenerationCheck}
                  disabled={!selectedLocalServerModel || localCheckRunning || busy || iterating || loadingModel}
                  title={selectedLocalServerModel ? "Generate a temporary game through the selected local Model Hub runtime without WebGPU" : "Select a local Model Hub model above"}
                  className="rounded-lg border border-emerald-300/30 bg-emerald-400/10 px-3 py-2 text-xs font-extrabold text-emerald-100 hover:bg-emerald-400/20 disabled:cursor-not-allowed disabled:opacity-40"
                >
                  {activeCheckSource === "model-hub" ? "Testing local model…" : "Test selected local model"}
                </button>
              </div>
            </div>
            <p data-testid="local-generation-status" role="status" className="mt-2 text-[11px] text-slate-400">
              {selectedLocalServerModel
                ? "A local Model Hub model is selected. Its test uses no WebGPU, no cloud key, and no public fallback."
                : engineOn
                  ? "Browser model loaded. A pass requires generated code, validator approval, and a clean startup in the isolated game preview."
                : gpu?.ok === false
                    ? `WebGPU is unavailable here (${gpu.reason ?? "unsupported browser or GPU"}). Select a Model Hub model above to test local generation without WebGPU.`
                    : "Load the browser model above or select a local Model Hub model to run a real generation check."}
            </p>
            {localCheckError && (
              <p data-testid="local-generation-error" role="alert" className="mt-2 rounded-lg border border-red-400/20 bg-red-500/10 px-3 py-2 text-xs text-red-200">
                Generation check did not pass: {localCheckError}
              </p>
            )}
            {localModelCheck && (
              <div className="mt-3 rounded-lg border border-white/10 bg-black/20 p-3">
                <p
                  data-testid="local-generation-result"
                  role={localModelCheck.status === "failed" ? "alert" : "status"}
                  className={`text-xs font-bold ${localModelCheck.status === "passed" ? "text-emerald-200" : localModelCheck.status === "failed" ? "text-red-200" : "text-amber-200"}`}
                >
                  {localModelCheck.status === "passed"
                    ? `Passed: ${localModelCheck.message}`
                    : localModelCheck.status === "failed"
                      ? `Did not pass: ${localModelCheck.message}`
                      : localModelCheck.message}
                </p>
                <p className="mt-1 text-[10px] text-slate-400">
                  {WEBLLM_MODELS.find((model) => model.id === localModelCheck.modelId)?.name ?? localModelCheck.modelId}
                  {" · "}{localModelCheck.via}
                  {" · "}{(localModelCheck.bytes / 1024).toFixed(1)} KB
                  {" · "}{(localModelCheck.ms / 1000).toFixed(1)} s
                  {typeof localModelCheck.tokps === "number" ? ` · ${localModelCheck.tokps} tokens/s` : ""}
                </p>
                {localModelCheck.status !== "failed" && (
                  <>
                    <iframe
                      ref={localCheckFrameRef}
                      data-testid="local-generation-preview"
                      title="Temporary locally generated game"
                      sandbox="allow-scripts"
                      srcDoc={createLocalModelCheckDocument(localModelCheck.code, localModelCheck.id, localModelCheck.nonce)}
                      className="mt-3 h-[320px] w-full rounded-lg bg-black"
                    />
                    <p className="mt-2 text-[10px] text-slate-400">
                      Test the arrow-key movement and score in the preview. This generated test game stays in memory and is not saved to your library.
                    </p>
                  </>
                )}
                <button
                  type="button"
                  data-testid="button-clear-local-generation-check"
                  onClick={clearLocalGenerationCheck}
                  className="mt-2 rounded-md border border-white/10 px-2 py-1 text-[10px] font-bold text-slate-300 hover:bg-white/5"
                >
                  Clear local test
                </button>
              </div>
            )}
          </div>
          {gpu && !gpu.ok && <p className="mt-2 text-[11px] text-slate-500">On-device GPU unavailable. Quick cores still work; choose a reachable model source above for custom games.</p>}
          </div>
        </details>

        <div className="mt-4 flex gap-2" role="tablist" aria-label="Arcade workspace">
          <button
            type="button"
            role="tab"
            aria-selected={workspace === "create"}
            onClick={() => setWorkspace("create")}
            className={`rounded-xl px-4 py-2 text-xs font-extrabold ${workspace === "create" ? "bg-emerald-400 text-slate-950" : "border border-white/10 bg-white/5 text-slate-300 hover:bg-white/10"}`}
          >
            Create and revise
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={workspace === "imports"}
            onClick={() => setWorkspace("imports")}
            className={`rounded-xl px-4 py-2 text-xs font-extrabold ${workspace === "imports" ? "bg-emerald-400 text-slate-950" : "border border-white/10 bg-white/5 text-slate-300 hover:bg-white/10"}`}
          >
            Import and emulate
          </button>
        </div>

        {workspace === "imports" ? (
          <ImportedGameWorkspace onReviseSource={reviseImportedSource} onUseRemakePrompt={useRemakePrompt} />
        ) : (
          <>
        {/* Composer */}
        <div className="glass mt-4 rounded-2xl p-4 sm:p-5">
          <div className="flex flex-wrap items-center gap-2">
            <label htmlFor="arcade-generation-mode" className="text-xs font-bold text-slate-400">Generation</label>
            <select
              id="arcade-generation-mode"
              value={strategy}
              onChange={(event) => setStrategy(event.target.value as Strategy)}
              className="rounded-lg border border-white/10 bg-black/40 px-3 py-2 text-xs font-bold text-white"
            >
              <option value="auto">Automatic — model for new games</option>
              <option value="instant">Quick cores — classic games</option>
              <option value="ai">On-device model</option>
            </select>
            {detected && (
              <span className="text-[11px] font-bold text-slate-400">
                {strategy === "instant"
                  ? `Quick core: ${GAME_TYPES.find((g) => g.id === detected)?.name}`
                  : strategy === "ai"
                    ? "Browser model path; requires WebGPU"
                    : "Automatic model routing; no preset fallback"}
              </span>
            )}
          </div>
          <textarea
            aria-label="Game prompt"
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) run();
            }}
            rows={2}
            placeholder="Describe a game or a change you want to make. (Ctrl+Enter)"
            className="mt-3 min-h-[64px] w-full resize-y rounded-xl border border-white/10 bg-black/40 px-4 py-3 text-[15px] text-white placeholder:text-slate-500 focus:border-violet-500 focus:outline-none"
          />
          <details className="mt-3">
            <summary className="cursor-pointer text-xs font-bold text-slate-400">Prompt examples (AI-generated)</summary>
            <div className="mt-2 flex flex-wrap gap-1.5">
              {SHOWCASE.map((example) => (
                <button
                  key={example.label}
                  type="button"
                  onClick={() => setPrompt(example.prompt)}
                  className="rounded-full bg-white/5 px-2.5 py-1 text-[11px] font-bold text-slate-300 ring-1 ring-white/10 hover:bg-white/10"
                >
                  {example.label}
                </button>
              ))}
            </div>
          </details>
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <button onClick={() => run()} disabled={busy || !prompt.trim()} className="btn-arena rounded-xl px-6 py-2.5 text-sm font-extrabold text-white">
              {busy ? `🎮 ${phase || "Building…"}` : "🎮 Create & play"}
            </button>
            {(busy || iterating) && abortRef.current && (
              <button
                onClick={() => abortRef.current?.abort()}
                className="rounded-xl border border-red-400/30 bg-red-500/10 px-4 py-2.5 text-sm font-bold text-red-200 hover:bg-red-500/20"
              >
                ⏹ Stop local generation
              </button>
            )}
            {game && !busy && (
              <button
                onClick={() => {
                  setGame(null);
                  setPrompt("");
                  setNotice(null);
                  setError(null);
                }}
                className="rounded-xl border border-white/10 bg-white/5 px-4 py-2.5 text-sm font-bold text-white hover:bg-white/10"
              >
                ＋ New
              </button>
            )}
          </div>
          <div className="mt-3 flex flex-wrap items-center gap-2 border-t border-white/5 pt-3">
            <PrivacyControls compact />
            <span className="text-[11px] text-slate-500">
              {strategy === "instant"
                ? "Quick cores are fixed offline classics; custom mechanics need a code-writing model."
                : strategy === "ai"
                  ? "Browser AI requires WebGPU and a one-time model download."
                  : "Automatic needs a reachable model and never substitutes a quick-core preset."}
            </span>
          </div>
          {busy && streamed && (
            <div className="mt-3 rounded-xl border border-violet-500/30 bg-black/40 p-3">
              <p className="mb-1 font-mono text-[10px] font-bold uppercase tracking-wider text-violet-300">🧠 streaming tokens…</p>
              <pre className="scroll-thin max-h-28 overflow-y-auto whitespace-pre-wrap font-mono text-[11px] leading-relaxed text-slate-300">{streamed}</pre>
            </div>
          )}
          {notice && <p className="mt-3 rounded-lg border border-emerald-400/30 bg-emerald-400/10 px-3 py-2 text-xs font-bold text-emerald-200">{notice}</p>}
          {error && <p role="alert" className="mt-3 rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-sm text-red-300">⚠️ {error}</p>}
        </div>

        {/* Result */}
        {game && (
          <div className="fade-up mt-5">
            <div className="flex flex-wrap items-center gap-2">
              <div className="flex overflow-hidden rounded-full ring-1 ring-white/10">
                <button onClick={() => setTab("play")} className={`px-4 py-1.5 text-xs font-bold ${tab === "play" ? "bg-emerald-500/25 text-emerald-200" : "text-slate-400 hover:text-white"}`}>
                  ▶ Play
                </button>
                <button onClick={() => setTab("code")} className={`px-4 py-1.5 text-xs font-bold ${tab === "code" ? "bg-emerald-500/25 text-emerald-200" : "text-slate-400 hover:text-white"}`}>
                  {"</>"} Code
                </button>
              </div>
              <span className="rounded-full bg-white/5 px-2.5 py-1 text-[11px] font-bold text-slate-300 ring-1 ring-white/10">
                {game.engine === "on-device-ai"
                  ? "🧠 on-device AI"
                  : game.engine === "ai-codegen"
                    ? "✨ AI codegen"
                    : game.engine === "remix"
                      ? "⚡ remix"
                      : "⚡ quick core"}
                {game.genMs !== undefined && game.engine !== "on-device-ai" ? ` · ${game.genMs}ms` : ""}
                {game.tokps ? ` · ${game.tokps} tok/s` : ""} · {(game.code.length / 1024).toFixed(1)}KB
              </span>
              {generationRuntimeLabel(game.runtime) && (
                <span
                  data-testid="game-runtime-provenance"
                  title={game.runtime.via ?? game.runtime.backend}
                  className="rounded-full bg-cyan-400/10 px-2.5 py-1 text-[11px] font-bold text-cyan-100 ring-1 ring-cyan-300/20"
                >
                  {generationRuntimeLabel(game.runtime)}
                </span>
              )}
              {game.localOffline && (
                <span className="rounded-full bg-emerald-400/10 px-2.5 py-1 text-[11px] font-bold text-emerald-200 ring-1 ring-emerald-400/20">
                  💾 saved in this browser
                </span>
              )}
              <div className="ml-auto flex gap-1.5">
                <button
                  type="button"
                  onClick={() => void copyCode()}
                  aria-label={copied ? "Game source copied" : "Copy game source"}
                  title={copied ? "Game source copied" : "Copy game source"}
                  className="rounded-lg bg-white/5 px-2.5 py-1.5 text-xs font-bold hover:bg-white/15"
                >
                  {copied ? "✓" : "📋"}
                </button>
                <button
                  type="button"
                  onClick={download}
                  aria-label="Download game source as HTML"
                  title="Download game source as HTML"
                  className="rounded-lg bg-white/5 px-2.5 py-1.5 text-xs font-bold hover:bg-white/15"
                >
                  ⬇️ .html
                </button>
              </div>
            </div>
            {copyError && <p data-testid="arcade-copy-error" role="alert" className="mt-2 text-xs text-red-300">{copyError}</p>}
            <p className="mt-2 text-center text-sm font-semibold text-slate-300">“{game.prompt}”</p>
            {tab === "play" ? (
              <div className="glass mt-2 overflow-hidden rounded-2xl">
                <iframe
                  key={`${game.id}:${gameSaves.reloadKey}`}
                  ref={gameFrameRef}
                  title={game.prompt}
                  sandbox="allow-scripts"
                  srcDoc={createGameSandboxDocument(game.code, saveSlotId ?? game.id)}
                  className="h-[640px] w-full bg-black"
                />
                <div className="flex items-center justify-between gap-3 border-t border-white/5 px-3 py-2">
                  <p className="text-[10px] text-slate-500">
                    Progress saves in this browser{gameSaves.hasSavedProgress ? " · save data found" : ""}.
                  </p>
                  {gameSaves.hasSavedProgress && (
                    <button type="button" onClick={gameSaves.clearSavedProgress} className="text-[10px] font-bold text-slate-400 hover:text-red-200">
                      Clear progress
                    </button>
                  )}
                </div>
              </div>
            ) : (
              <div className="glass mt-2 overflow-hidden rounded-2xl">
                <pre className="scroll-thin max-h-[560px] overflow-auto p-4 font-mono text-[11px] leading-relaxed text-slate-300">{game.code}</pre>
              </div>
            )}

            {!game.ephemeral ? (
              <div className="glass mt-3 rounded-2xl p-4">
                <p className="text-xs font-extrabold text-white">Change this game</p>
                <div className="mt-2 flex gap-2">
                  <input
                    aria-label="Game change"
                    value={instruction}
                    onChange={(e) => setInstruction(e.target.value)}
                    onKeyDown={(e) => e.key === "Enter" && iterate()}
                    placeholder="Add a level, change the movement, or add co-op…"
                    className="flex-1 rounded-xl border border-white/10 bg-black/40 px-4 py-2.5 text-sm text-white placeholder:text-slate-500 focus:border-violet-500 focus:outline-none"
                  />
                  <button onClick={iterate} disabled={iterating || busy || !instruction.trim()} className="btn-arena rounded-xl px-5 py-2.5 text-sm font-extrabold text-white">
                    {iterating ? "…" : "Apply change"}
                  </button>
                </div>
              </div>
            ) : (
              <p className="mt-2 text-center text-[11px] text-slate-500">👻 Ephemeral game — never stored. Disable Ephemeral to iterate with revisions.</p>
            )}
          </div>
        )}
          </>
        )}
      </div>

      {/* Sidebar */}
      <aside className="min-w-0 space-y-4">
        <div className="rounded-2xl border border-emerald-400/25 bg-gradient-to-br from-emerald-500/15 to-cyan-500/5 p-4">
          <p className="text-sm font-extrabold text-emerald-200">Your game, then your changes</p>
          <p className="mt-1.5 text-xs leading-relaxed text-emerald-100/80">
            Build from the prompt, play the result, then change it. Custom revisions use the current game file as their starting point, not a replacement preset.
          </p>
        </div>
        <div className="glass rounded-2xl p-4">
          <div className="flex items-center justify-between gap-2">
            <h3 className="text-sm font-extrabold text-white">💾 Offline starter games</h3>
            <span className="rounded-full bg-emerald-400/10 px-2 py-0.5 text-[10px] font-bold text-emerald-200">{offlineGames.length}</span>
          </div>
          <p className="mt-1.5 text-[11px] leading-relaxed text-slate-400">
            These playable games and their code stay in this browser. Open one to play, inspect, or prompt a gameplay change.
          </p>
          {offlineShelfLoading && <p className="mt-3 text-xs text-slate-500">Loading local games…</p>}
          {offlineShelfError && <p role="alert" className="mt-3 rounded-lg bg-red-500/10 px-2.5 py-2 text-xs text-red-200">{offlineShelfError}</p>}
          {!offlineShelfLoading && !offlineShelfError && (
            <div className="scroll-thin mt-3 max-h-72 space-y-2 overflow-y-auto">
              {offlineGames.map((saved) => (
                <div key={saved.id} className="group relative rounded-lg bg-white/[0.03] ring-1 ring-white/5 hover:ring-emerald-500/40">
                  <button
                    type="button"
                    onClick={() => openOfflineGame(saved)}
                    aria-label={`Open offline game ${saved.title}`}
                    className="block w-full p-2.5 pr-9 text-left"
                  >
                    <p className="text-[10px] font-black uppercase tracking-wide text-emerald-300">
                      {GAME_TYPES.find((meta) => meta.id === saved.gameType)?.emoji ?? "🎮"} {saved.gameType} · offline
                    </p>
                    <p className="mt-0.5 text-xs font-semibold text-slate-100">{saved.title}</p>
                  </button>
                  <button
                    type="button"
                    onClick={() => void deleteOfflineGame(saved.id)}
                    aria-label={`Remove offline game ${saved.title}`}
                    title="Remove from this browser"
                    className="absolute right-1.5 top-1.5 rounded px-1.5 py-0.5 text-[11px] text-slate-500 hover:bg-red-500/20 hover:text-red-300"
                  >
                    ×
                  </button>
                </div>
              ))}
              {offlineGames.length === 0 && <p className="text-xs text-slate-500">No offline games saved in this browser.</p>}
            </div>
          )}
        </div>
        <div className="glass rounded-2xl p-4">
          <h3 className="text-sm font-extrabold text-white">🕹️ Game library</h3>
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="🔍 Search games…"
            className="mt-2 w-full rounded-lg border border-white/10 bg-black/40 px-3 py-1.5 text-xs text-white placeholder:text-slate-600 focus:border-violet-500 focus:outline-none"
          />
          <div className="scroll-thin mt-2 max-h-96 space-y-2 overflow-y-auto">
            {historyError && (
              <div data-testid="arcade-history-error" role="alert" className="rounded-lg border border-red-400/20 bg-red-500/10 p-2.5 text-xs text-red-200">
                <p>{historyError}</p>
                {historyRetryRef.current && (
                  <button
                    type="button"
                    onClick={() => historyRetryRef.current?.()}
                    className="mt-2 rounded-md bg-red-300/10 px-2.5 py-1 font-bold hover:bg-red-300/20"
                  >
                    Retry saved game action
                  </button>
                )}
              </div>
            )}
            {historyLoading && history.length === 0 && <p className="text-xs text-slate-500">Loading saved games…</p>}
            {filtered.map((h: any) => (
              <div key={h.id} data-game-id={h.id} className="group relative rounded-lg bg-white/[0.03] p-2.5 ring-1 ring-white/5 hover:ring-emerald-500/40">
                <button
                  type="button"
                  onClick={() => void openGame(h.id)}
                  aria-label={`Open saved game ${h.prompt}`}
                  aria-busy={historyAction !== null && historyAction.id === h.id && historyAction.kind === "open"}
                  disabled={historyAction !== null}
                  className="block w-full text-left disabled:opacity-60"
                >
                  <p className="pr-6 text-[10px] font-black text-emerald-300">
                    {GAME_TYPES.find((g) => g.id === h.gameType)?.emoji} {h.gameType} · {h.engine === "on-device-ai" ? "🧠 AI" : h.engine} · {(h.bytes / 1024).toFixed(0)}KB
                  </p>
                  <p className="mt-0.5 line-clamp-2 text-xs font-semibold text-slate-200">
                    {historyAction !== null && historyAction.id === h.id && historyAction.kind === "open" ? "Opening… " : ""}{h.prompt}
                  </p>
                </button>
                <button
                  type="button"
                  onClick={() => void deleteGame(h.id)}
                  aria-label={`Delete saved game ${h.prompt}`}
                  title="Delete (right to erasure)"
                  disabled={historyAction !== null}
                  className="absolute right-1.5 top-1.5 block rounded px-1.5 py-0.5 text-[11px] text-slate-500 hover:bg-red-500/20 hover:text-red-300 disabled:opacity-50 sm:hidden sm:group-hover:block"
                >
                  {historyAction !== null && historyAction.id === h.id && historyAction.kind === "delete" ? "…" : "✕"}
                </button>
              </div>
            ))}
            {!historyLoading && !historyError && filtered.length === 0 && <p className="text-xs text-slate-500">No games yet — forge the first.</p>}
          </div>
        </div>
      </aside>
    </div>
  );
}
