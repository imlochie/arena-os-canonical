"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import PrivacyControls from "./PrivacyControls";
import { privacyFlags } from "@workspace/arena/lib/privacyClient";
import { loadKeys } from "./KeysBar";
import BrainCard from "@/components/BrainCard";
import {
  GAME_TYPES,
  detectGameType,
  extractGameCode,
  generateGameOffline,
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

const SHOWCASE: { label: string; prompt: string }[] = [
  { label: "Pong", prompt: "Pong, first to seven, mouse or arrow controls" },
  { label: "Platform adventure", prompt: "A platform adventure with wall jumps, moving platforms, and three short levels" },
  { label: "Twin-stick survival", prompt: "A twin-stick survival game with enemy waves, dashes, and upgrade choices" },
  { label: "A new game idea", prompt: "" },
];

export default function ArcadeForge() {
  const [prompt, setPrompt] = useState("");
  const [strategy, setStrategy] = useState<Strategy>("auto");
  const [modelId, setModelId] = useState<string>(WEBLLM_MODELS[0].id);

  const [busy, setBusy] = useState(false);
  const [phase, setPhase] = useState("");
  const [game, setGame] = useState<any | null>(null);
  const [tab, setTab] = useState<"play" | "code">("play");
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [history, setHistory] = useState<any[]>([]);
  const [search, setSearch] = useState("");
  const [instruction, setInstruction] = useState("");
  const [iterating, setIterating] = useState(false);
  const [copied, setCopied] = useState(false);

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
  const abortRef = useRef<AbortController | null>(null);

  const fetchHistory = useCallback(async () => {
    try {
      const r = await fetch("/api/arcade?limit=30");
      const j = await r.json();
      setHistory(j.games ?? []);
    } catch {}
  }, []);

  useEffect(() => {
    fetchHistory();
    setModelId(getPreferredModel());
    setOfflineReady(modelReadyOffline());
    checkWebGPU().then(setGpu).catch(() => setGpu({ ok: false, reason: "check failed" }));
    setEngineOn(isEngineLoaded());
    setEngineModel(loadedModelId());
  }, [fetchHistory]);

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
      setGame({ ...logged, code: g.code, genMs: ms, engine: g.engine });
    } else {
      const saved = await persistGame({ prompt: p, clientCode: g.code, gameType: g.gameType, parentId });
      // server stamps engine as on-device-ai for clientCode; correct it for cores
      setGame({ ...saved, code: g.code, genMs: ms, engine: g.engine });
      fetchHistory();
    }
    setNotice(`⚡ ${g.title} forged in ${ms}ms (${g.engine}) — validated, ${(g.code.length / 1024).toFixed(1)}KB single file.`);
  }

  async function runServerAI(p: string, parentId?: string, priorCode?: string) {
    setPhase("✨ AI writing your game (server)…");
    const flags = privacyFlags();
    const res = await fetch("/api/arcade/forge", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prompt: p, keys: flags.localOnly ? undefined : loadKeys(), parentId, priorCode, ...flags }),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) {
      throw new Error(body.error ?? "No game-writing model is reachable.");
    }
    if (typeof body.code !== "string") throw new Error("The model did not return a complete playable game.");
    const rt = body.runtime ?? {};
    setGame({
      ...(body.game ?? {}),
      id: body.game?.id ?? crypto.randomUUID(),
      prompt: p,
      gameType: body.game?.gameType ?? detectGameType(p),
      code: body.code,
      engine: "ai-codegen",
      genMs: rt.ms,
      ephemeral: flags.ephemeral,
    });
    if (!flags.ephemeral) fetchHistory();
    setNotice(
      `${body.title ?? "Game"} is playable${body.repairsUsed ? " (repaired after validation)" : ""}. You can now ask for a specific change.`
    );
  }

  async function runAI(p: string, parentId?: string, priorCode?: string, requireModel = false) {
    const ok = await ensureEngine();
    if (!ok) {
      if (requireModel) throw new Error("A custom game needs a working code-writing model. Load the on-device model or connect a model in Settings.");
      const type = detectGameType(p);
      setNotice("On-device model unavailable — using the matching offline classic core instead.");
      await runInstant(p, type, parentId);
      return;
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
        if (requireModel) throw new Error(`The generated game did not pass validation: ${v.issues.join("; ")}`);
        setNotice(`⚠️ AI draft had issues (${v.issues.join("; ")}). Delivered a verified core instead — guaranteed playable.`);
        await runInstant(p, detectGameType(p), parentId);
        return;
      }
      const saved = await persistGame({ prompt: p, clientCode: code, gameType: type, parentId });
      setGame({ ...saved, code, genMs: res.ms, tokps: res.tokps, tokens: res.tokens, engine: "on-device-ai" });
      if (!saved.ephemeral) fetchHistory();
      setNotice(`🧠 On-device AI forged a ${(code.length / 1024).toFixed(1)}KB game in ${(res.ms / 1000).toFixed(1)}s (${res.tokps} tok/s) — 100% offline, validated.`);
    } finally {
      setStreamed("");
      abortRef.current = null;
    }
  }

  async function run(p?: string) {
    const q = (p ?? prompt).trim();
    if (!q || busy) return;
    setPrompt(q);
    setBusy(true);
    setError(null);
    setNotice(null);
    setGame(null);
    setTab("play");
    setPhase("Forging…");
    try {
      const type = detectGameType(q);
      if (strategy === "instant") {
        if (type === "arena") throw new Error("Quick cores cover the built-in classics. Choose Automatic or connect an AI model for this original game idea.");
        await runInstant(q, type);
      } else if (strategy === "ai") {
        await runAI(q, undefined, undefined, true);
      } else if (type === "arena") {
        if (privacyFlags().localOnly || isEngineLoaded()) {
          await runAI(q, undefined, undefined, true);
        } else {
          await runServerAI(q);
        }
      } else {
        await runInstant(q, type);
      }
    } catch (e: any) {
      setError(e.message ?? "forge failed");
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
    setInstruction("");
    setError(null);
    setNotice(null);
    try {
      const combined = `${game.prompt} — CHANGE: ${ins}`;
      const mods = parseMods(ins);
      const offlineModifier =
        game.engine !== "ai-codegen" &&
        (mods.lives !== undefined ||
          mods.speed !== "normal" ||
          mods.accent !== undefined ||
          mods.difficulty !== undefined ||
          /\b(?:wrap|portal|no walls|no hold|no ghost|4096|1024|512)\b/i.test(ins));
      if (offlineModifier) {
        const t0 = performance.now();
        const g = generateGameOffline(combined, game.gameType);
        const saved = await persistGame({ prompt: combined, clientCode: g.code, gameType: g.gameType, parentId: game.id });
        setGame({ ...saved, code: g.code, genMs: Math.round(performance.now() - t0), engine: g.engine });
        fetchHistory();
        setNotice(`Updated the game and saved a new version.`);
      } else if (game.engine === "ai-codegen" && !privacyFlags().localOnly) {
        await runServerAI(ins, game.id, game.code);
      } else {
        if (privacyFlags().localOnly) await runAI(combined, game.id, game.code, true);
        else await runServerAI(ins, game.id, game.code);
      }
    } catch (e: any) {
      setError(e.message ?? "iterate failed");
    } finally {
      setIterating(false);
    }
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

  function copyCode() {
    if (!game?.code) return;
    const done = () => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    };
    if (navigator.clipboard?.writeText) navigator.clipboard.writeText(game.code).then(done).catch(done);
    else done();
  }

  async function openGame(id: string) {
    try {
      const r = await fetch(`/api/arcade/${id}`);
      const j = await r.json();
      if (j.game) {
        setGame(j.game);
        setTab("play");
        setNotice(null);
        setError(null);
        window.scrollTo({ top: 0, behavior: "smooth" });
      }
    } catch {}
  }

  async function deleteGame(id: string) {
    if (!confirm("Delete this game?")) return;
    await fetch(`/api/arcade/${id}`, { method: "DELETE" });
    setHistory((h) => h.filter((x: any) => x.id !== id));
    if (game?.id === id) setGame(null);
  }

  const filtered = history.filter((h: any) =>
    search.trim() ? h.prompt.toLowerCase().includes(search.toLowerCase()) : true
  );
  const detected = prompt.trim() ? detectGameType(prompt) : null;

  return (
    <div className="grid gap-5 lg:grid-cols-[1fr_300px]">
      <div className="min-w-0">
        {/* Engine status */}
        <div className="glass rounded-2xl p-4">
          <div className="flex flex-wrap items-center gap-2">
            <span className={`rounded-full px-2.5 py-1 text-[11px] font-extrabold ring-1 ${gpu === null ? "bg-white/5 text-slate-400 ring-white/10" : gpu.ok ? "bg-emerald-500/15 text-emerald-200 ring-emerald-400/40" : "bg-red-500/15 text-red-200 ring-red-400/40"}`}>
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
          {loadingModel && (
            <div className="mt-2">
              <div className="h-1.5 overflow-hidden rounded-full bg-white/5">
                <div className="h-full rounded-full bg-gradient-to-r from-violet-500 to-cyan-400 transition-all" style={{ width: `${loadProg * 100}%` }} />
              </div>
              <p className="mt-1 truncate text-[11px] text-slate-400">{loadText}</p>
            </div>
          )}
          {gpu && !gpu.ok && <p className="mt-2 text-[11px] text-slate-500">🧠 {gpu.reason} Instant verified cores + remix still cover every classic, fully offline.</p>}
        </div>

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
                {detected === "arena" ? "A game-writing model will build this" : `Quick core: ${GAME_TYPES.find((g) => g.id === detected)?.name}`}
              </span>
            )}
          </div>
          <textarea
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
            <summary className="cursor-pointer text-xs font-bold text-slate-400">Prompt examples</summary>
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
            {busy && strategy !== "instant" && (
              <button
                onClick={() => abortRef.current?.abort()}
                className="rounded-xl border border-red-400/30 bg-red-500/10 px-4 py-2.5 text-sm font-bold text-red-200 hover:bg-red-500/20"
              >
                ⏹ Stop
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
            <span className="text-[11px] text-slate-500">Classics run offline. Online game generation uses the model you connect.</span>
          </div>
          {busy && streamed && (
            <div className="mt-3 rounded-xl border border-violet-500/30 bg-black/40 p-3">
              <p className="mb-1 font-mono text-[10px] font-bold uppercase tracking-wider text-violet-300">🧠 streaming tokens…</p>
              <pre className="scroll-thin max-h-28 overflow-y-auto whitespace-pre-wrap font-mono text-[11px] leading-relaxed text-slate-300">{streamed}</pre>
            </div>
          )}
          {notice && <p className="mt-3 rounded-lg border border-emerald-400/30 bg-emerald-400/10 px-3 py-2 text-xs font-bold text-emerald-200">{notice}</p>}
          {error && <p className="mt-3 rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-sm text-red-300">⚠️ {error}</p>}
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
                {game.engine === "on-device-ai" ? "🧠 on-device AI" : game.engine === "remix" ? "⚡ remix" : "⚡ verified core"}
                {game.genMs !== undefined && game.engine !== "on-device-ai" ? ` · ${game.genMs}ms` : ""}
                {game.tokps ? ` · ${game.tokps} tok/s` : ""} · {(game.code.length / 1024).toFixed(1)}KB
              </span>
              <div className="ml-auto flex gap-1.5">
                <button onClick={copyCode} className="rounded-lg bg-white/5 px-2.5 py-1.5 text-xs font-bold hover:bg-white/15">{copied ? "✓" : "📋"}</button>
                <button onClick={download} className="rounded-lg bg-white/5 px-2.5 py-1.5 text-xs font-bold hover:bg-white/15">⬇️ .html</button>
              </div>
            </div>
            <p className="mt-2 text-center text-sm font-semibold text-slate-300">“{game.prompt}”</p>
            {tab === "play" ? (
              <div className="glass mt-2 overflow-hidden rounded-2xl">
                <iframe
                  key={game.id}
                  title={game.prompt}
                  sandbox="allow-scripts"
                  srcDoc={game.code}
                  className="h-[640px] w-full bg-black"
                />
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
      </div>

      {/* Sidebar */}
      <aside className="min-w-0 space-y-4">
        <div className="rounded-2xl border border-emerald-400/25 bg-gradient-to-br from-emerald-500/15 to-cyan-500/5 p-4">
          <p className="text-sm font-extrabold text-emerald-200">🎮 The offline ultimate test</p>
          <p className="mt-1.5 text-xs leading-relaxed text-emerald-100/80">
            <strong>Instant cores</strong> deliver Pac-Man-classics in milliseconds. <strong>On-device AI</strong> (WebGPU,
            cached after one download) writes anything else — no prompts, no code, no data ever leaves your machine.
            No limits, no boundaries.
          </p>
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
            {filtered.map((h: any) => (
              <div key={h.id} className="group relative rounded-lg bg-white/[0.03] p-2.5 ring-1 ring-white/5 hover:ring-emerald-500/40">
                <button onClick={() => openGame(h.id)} className="block w-full text-left">
                  <p className="pr-6 text-[10px] font-black text-emerald-300">
                    {GAME_TYPES.find((g) => g.id === h.gameType)?.emoji} {h.gameType} · {h.engine === "on-device-ai" ? "🧠 AI" : h.engine} · {(h.bytes / 1024).toFixed(0)}KB
                  </p>
                  <p className="mt-0.5 line-clamp-2 text-xs font-semibold text-slate-200">{h.prompt}</p>
                </button>
                <button
                  onClick={() => deleteGame(h.id)}
                  title="Delete (right to erasure)"
                  className="absolute right-1.5 top-1.5 hidden rounded px-1.5 py-0.5 text-[11px] text-slate-500 hover:bg-red-500/20 hover:text-red-300 group-hover:block"
                >
                  ✕
                </button>
              </div>
            ))}
            {filtered.length === 0 && <p className="text-xs text-slate-500">No games yet — forge the first.</p>}
          </div>
        </div>
      </aside>
    </div>
  );
}
