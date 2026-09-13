"use client";

import { apiErrorMessage } from "@/lib/apiErrorClient";

import { useEffect, useState } from "react";
import { loadKeys } from "@/components/KeysBar";
import PrivacyControls from "@/components/PrivacyControls";
import { privacyFlags } from "@/lib/privacyClient";

interface ModelInfo {
  id: string;
  name: string;
  emoji: string;
  elo: number;
  kind: string;
}

const STYLES = [
  "📷 Photorealistic",
  "🎨 Digital art",
  "🌸 Anime",
  "🖌️ Oil painting",
  "🤖 Sci-fi concept",
  "🏰 Fantasy",
];

const STARTERS = [
  "A cozy cabin in a snowy forest at dusk, warm glowing windows, aurora borealis",
  "Portrait of a cyberpunk street vendor selling glowing fruit, neon rain",
  "A floating island with waterfalls pouring into clouds, tiny airships, sunset",
  "Cute robot barista serving coffee in a retro Tokyo café, morning light",
];

const ASPECTS = [
  { id: "768x768", label: "⬛ Square" },
  { id: "768x1024", label: "📱 Portrait" },
  { id: "1024x768", label: "🖥️ Landscape" },
];

function imgUrl(md: string): string | null {
  const m = md.match(/\((https:[^)]+)\)/);
  return m ? m[1] : null;
}

export default function ImageArenaPage() {
  const [models, setModels] = useState<ModelInfo[]>([]);
  const [prompt, setPrompt] = useState("");
  const [aspect, setAspect] = useState("768x768");
  const [mode, setMode] = useState<"random" | "pick">("random");
  const [pickA, setPickA] = useState("image-flux");
  const [pickB, setPickB] = useState("image-turbo");
  const [loading, setLoading] = useState(false);
  const [battle, setBattle] = useState<any | null>(null);
  const [revealed, setRevealed] = useState<any | null>(null);
  const [voting, setVoting] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loaded, setLoaded] = useState({ a: false, b: false });
  const [history, setHistory] = useState<any[]>([]);

  useEffect(() => {
    fetch("/api/models")
      .then((r) => r.json())
      .then((j) => setModels((j.models ?? []).filter((m: ModelInfo) => m.kind === "image")))
      .catch(() => {});
    fetch("/api/battles?limit=12&category=image")
      .then((r) => r.json())
      .then((j) => setHistory(j.battles ?? []))
      .catch(() => {});
  }, []);

  const name = (id: string) => models.find((m) => m.id === id)?.name ?? id;

  async function start(p?: string) {
    const q = (p ?? prompt).trim();
    if (!q || loading) return;
    setLoading(true);
    setError(null);
    setBattle(null);
    setRevealed(null);
    setLoaded({ a: false, b: false });
    try {
      const body: any = { prompt: q, category: "image", imageSize: aspect, keys: loadKeys(), ...privacyFlags() };
      if (mode === "pick") {
        body.modelAId = pickA;
        body.modelBId = pickB;
      }
      const r = await fetch("/api/battles", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const j = await r.json();
      if (!r.ok) throw new Error(apiErrorMessage(j.error, "battle failed"));
      setBattle(j.battle);
      setPrompt(q);
    } catch (e: any) {
      setError(e.message ?? "failed");
    } finally {
      setLoading(false);
    }
  }

  async function vote(winner: "a" | "b" | "tie" | "both-bad") {
    if (!battle || voting) return;
    setVoting(winner);
    try {
      // Ephemeral: sealed reveal, no storage, no Elo.
      if (battle.ephemeral && battle.revealToken) {
        const r = await fetch("/api/battles/reveal", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ revealToken: battle.revealToken, winner }),
        });
        const j = await r.json();
        if (!r.ok) throw new Error("reveal failed");
        setRevealed({ ...battle, modelAId: j.modelAId, modelBId: j.modelBId, winner: j.winner, ephemeral: true });
        return;
      }
      const r = await fetch(`/api/battles/${battle.id}/vote`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ winner }),
      });
      const j = await r.json();
      if (!r.ok) throw new Error("vote failed");
      setRevealed(j.battle);
      fetch("/api/battles?limit=12&category=image")
        .then((r2) => r2.json())
        .then((j2) => setHistory(j2.battles ?? []))
        .catch(() => {});
    } catch (e: any) {
      setError(e.message ?? "vote failed");
    } finally {
      setVoting(null);
    }
  }

  return (
    <div>
      <div className="mb-5 text-center">
        <h1 className="text-2xl font-black tracking-tight text-white sm:text-3xl">🖼️ Image Arena</h1>
        <p className="mx-auto mt-1 max-w-2xl text-sm text-slate-300">
          Same blind-battle rules, but for pixels: Flux vs Turbo paint your prompt. Vote blind, Elo updates —
          free forever, no key needed.
        </p>
      </div>

      <div className="glass mx-auto max-w-3xl rounded-2xl p-4 sm:p-5">
        <div className="flex flex-wrap items-center gap-2">
          {ASPECTS.map((a) => (
            <button
              key={a.id}
              onClick={() => setAspect(a.id)}
              className={`rounded-full px-3 py-1.5 text-xs font-bold ${aspect === a.id ? "bg-violet-600 text-white" : "bg-white/5 text-slate-300 ring-1 ring-white/10 hover:bg-white/10"}`}
            >
              {a.label}
            </button>
          ))}
          <span className="mx-1 h-5 w-px bg-white/10" />
          <div className="flex overflow-hidden rounded-full ring-1 ring-white/10">
            <button onClick={() => setMode("random")} className={`px-3 py-1.5 text-xs font-bold ${mode === "random" ? "bg-cyan-500/25 text-cyan-200" : "text-slate-400"}`}>
              🎲 Blind random
            </button>
            <button onClick={() => setMode("pick")} className={`px-3 py-1.5 text-xs font-bold ${mode === "pick" ? "bg-cyan-500/25 text-cyan-200" : "text-slate-400"}`}>
              🎯 Pick two
            </button>
          </div>
        </div>
        {mode === "pick" && (
          <div className="mt-3 grid gap-2 sm:grid-cols-2">
            {[["Fighter A", pickA, setPickA], ["Fighter B", pickB, setPickB]].map(([label, val, set]: any) => (
              <label key={label} className="block">
                <span className="mb-1 block text-[11px] font-bold uppercase tracking-wider text-slate-400">{label}</span>
                <select value={val} onChange={(e) => set(e.target.value)} className="w-full rounded-lg border border-white/10 bg-black/40 px-3 py-2 text-sm font-semibold text-white focus:border-violet-500 focus:outline-none">
                  {models.map((m) => (
                    <option key={m.id} value={m.id}>{m.emoji} {m.name} ({m.elo})</option>
                  ))}
                </select>
              </label>
            ))}
          </div>
        )}
        <textarea
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          rows={2}
          placeholder="Describe the image… e.g. 'a lighthouse on a cliff during a storm, dramatic waves'"
          className="mt-3 w-full resize-y rounded-xl border border-white/10 bg-black/40 px-4 py-3 text-[15px] text-white placeholder:text-slate-500 focus:border-violet-500 focus:outline-none"
        />
        <div className="mt-2 flex flex-wrap gap-1.5">
          {STYLES.map((s) => (
            <button
              key={s}
              onClick={() => setPrompt((p) => (p ? p + ", " : "") + s.replace(/^\S+\s/, "").toLowerCase())}
              className="rounded-full bg-white/5 px-2.5 py-1 text-[11px] font-bold text-slate-300 ring-1 ring-white/10 hover:bg-white/10"
            >
              + {s}
            </button>
          ))}
        </div>
        <div className="mt-3 flex items-center gap-2">
          <button onClick={() => start()} disabled={loading || !prompt.trim()} className="btn-arena rounded-xl px-6 py-2.5 text-sm font-extrabold text-white">
            {loading ? "🎨 Painting…" : "🎨 Paint battle"}
          </button>
          <PrivacyControls compact />
          {(battle || revealed) && (
            <button onClick={() => { setBattle(null); setRevealed(null); setPrompt(""); }} className="rounded-xl border border-white/10 bg-white/5 px-4 py-2.5 text-sm font-bold text-white hover:bg-white/10">
              ＋ New
            </button>
          )}
        </div>
        {!battle && !loading && (
          <div className="mt-3 flex flex-wrap gap-2">
            {STARTERS.map((s) => (
              <button key={s} onClick={() => start(s)} className="max-w-full truncate rounded-full border border-white/10 bg-white/[0.03] px-3 py-1.5 text-left text-xs text-slate-300 hover:border-violet-500/50 hover:text-white" title={s}>
                {s.length > 60 ? s.slice(0, 60) + "…" : s}
              </button>
            ))}
          </div>
        )}
        {error && <p className="mt-3 rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-sm text-red-300">⚠️ {error}</p>}
      </div>

      {(battle || revealed) && (
        <div className="fade-up mx-auto mt-5 max-w-5xl">
          <p className="mb-3 text-center text-sm font-semibold text-slate-300">“{revealed?.prompt ?? battle?.prompt}”</p>
          <div className="grid items-start gap-4 md:grid-cols-2">
            {(["a", "b"] as const).map((side) => {
              const b = revealed ?? battle;
              const src = imgUrl(side === "a" ? b.responseA : b.responseB);
              const isA = side === "a";
              const won = revealed && ((revealed.winner === "a") === isA);
              const modelId = isA ? b.modelAId : b.modelBId;
              return (
                <div key={side} className={`glass overflow-hidden rounded-2xl ${revealed && won ? "ring-2 ring-amber-400/60" : ""}`}>
                  <div className={`flex items-center gap-2.5 border-b border-white/10 px-4 py-3 ${isA ? "bg-violet-600/10" : "bg-cyan-600/10"}`}>
                    <span className={`grid h-8 w-8 place-items-center rounded-lg text-base font-black text-white ${isA ? "bg-violet-600" : "bg-cyan-600"}`}>
                      {side.toUpperCase()}
                    </span>
                    <p className="flex-1 truncate text-sm font-extrabold text-white">
                      {revealed ? `🎭 → ${name(modelId)}` : "🎭 Anonymous painter"}
                    </p>
                    {revealed && won && <span className="text-xl">🏆</span>}
                  </div>
                  <div className="relative grid min-h-[280px] place-items-center bg-black/30 p-3">
                    {!loaded[side] && (
                      <div className="absolute inset-3 overflow-hidden rounded-xl bg-white/5">
                        <div className="shimmer-bar h-full w-full" />
                        <p className="absolute inset-0 grid place-items-center text-sm text-slate-400">🎨 rendering…</p>
                      </div>
                    )}
                    {src && (
                      <a href={src} target="_blank" rel="noreferrer" className="relative">
                        <img
                          src={src}
                          alt={`Generated image ${side.toUpperCase()}`}
                          onLoad={() => setLoaded((l) => ({ ...l, [side]: true }))}
                          className={`max-h-[520px] rounded-xl border border-white/10 transition-opacity ${loaded[side] ? "opacity-100" : "opacity-0"}`}
                        />
                      </a>
                    )}
                  </div>
                </div>
              );
            })}
          </div>

          {!revealed ? (
            <div className="glass mx-auto mt-4 max-w-2xl rounded-2xl p-4">
              <p className="text-center text-sm font-extrabold text-white">👑 Which image is better?</p>
              <p className="mt-0.5 text-center text-[11px] text-slate-400">
                {battle?.ephemeral
                  ? "👻 Ephemeral vote: reveals painters only — nothing stored, no Elo."
                  : battle?.localOnly
                    ? "🔒 Local canvas: procedural on-device art, zero egress."
                    : "Blind vote reveals both painters + updates the Image board"}
              </p>
              <div className="mx-auto mt-3 grid grid-cols-2 gap-2 sm:grid-cols-4">
                <button onClick={() => vote("a")} disabled={!!voting} className="rounded-xl bg-violet-600 px-3 py-2.5 text-sm font-extrabold text-white hover:bg-violet-500 disabled:opacity-60">🏅 A</button>
                <button onClick={() => vote("b")} disabled={!!voting} className="rounded-xl bg-cyan-600 px-3 py-2.5 text-sm font-extrabold text-white hover:bg-cyan-500 disabled:opacity-60">🏅 B</button>
                <button onClick={() => vote("tie")} disabled={!!voting} className="rounded-xl border border-white/15 bg-white/5 px-3 py-2.5 text-sm font-extrabold text-white hover:bg-white/10 disabled:opacity-60">🤝 Tie</button>
                <button onClick={() => vote("both-bad")} disabled={!!voting} className="rounded-xl border border-white/15 bg-white/5 px-3 py-2.5 text-sm font-extrabold text-slate-300 hover:bg-white/10 disabled:opacity-60">👎 Both bad</button>
              </div>
            </div>
          ) : (
            <div className="reveal-pop glass mx-auto mt-4 max-w-2xl rounded-2xl p-4 text-center">
              <p className="text-sm font-extrabold text-white">
                {revealed.winner === "tie" ? "🤝 Tie!" : revealed.winner === "both-bad" ? "👎 Both marked bad." : `🏆 ${name(revealed.winner === "a" ? revealed.modelAId : revealed.modelBId)} wins!`}
              </p>
              <div className="mt-3 flex flex-wrap justify-center gap-2">
                <button onClick={() => { setBattle(null); setRevealed(null); }} className="btn-arena rounded-xl px-5 py-2 text-sm font-extrabold text-white">🎨 Paint again</button>
                {!revealed.ephemeral && (
                  <a href={`/battles/${revealed.id}`} className="rounded-xl border border-white/10 bg-white/5 px-5 py-2 text-sm font-bold text-white hover:bg-white/10">🔗 Share</a>
                )}
                <a href="/leaderboard" className="rounded-xl border border-white/10 bg-white/5 px-5 py-2 text-sm font-bold text-white hover:bg-white/10">🏆 Image board</a>
              </div>
            </div>
          )}
        </div>
      )}

      {history.length > 0 && (
        <div className="mx-auto mt-8 max-w-5xl">
          <h2 className="mb-3 text-center text-sm font-extrabold text-white">🖼️ Recent image battles</h2>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {history.slice(0, 6).map((h: any) => {
              const src = imgUrl(h.winner === "b" ? h.responseB : h.responseA);
              return (
                <a key={h.id} href={`/battles/${h.id}`} className="glass card-hover overflow-hidden rounded-2xl">
                  {src ? <img src={src} alt={h.prompt} loading="lazy" className="h-44 w-full object-cover" /> : <div className="h-44 bg-white/5" />}
                  <p className="line-clamp-2 p-3 text-xs font-semibold text-slate-200">{h.prompt}</p>
                </a>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
