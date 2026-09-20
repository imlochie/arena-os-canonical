"use client";

import { useEffect, useState } from "react";
import { LEADERBOARD_CATS } from "@/lib/models";

interface Row {
  id: string;
  name: string;
  provider: string;
  description: string;
  elo: number;
  battles: number;
  wins: number;
  ties: number;
  ci: number;
  provisional: boolean;
  expectedVsTop: number;
}

interface BTEntry {
  id: string;
  btElo: number;
  ci: number;
  votes: number;
  expectedVsTop: number;
}

function medal(i: number) {
  return i === 0 ? "🥇" : i === 1 ? "🥈" : i === 2 ? "🥉" : `${i + 1}`;
}

export default function LeaderboardBoard() {
  const [category, setCategory] = useState("overall");
  const [rows, setRows] = useState<Row[]>([]);
  const [bt, setBt] = useState<BTEntry[]>([]);
  const [mode, setMode] = useState<"elo" | "bt">("elo");
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    setLoading(true);
    Promise.all([
      fetch(`/api/leaderboard?category=${category}`).then((r) => r.json()),
      fetch(`/api/stats?category=${category}`).then((r) => r.json()),
    ])
      .then(([lb, stats]) => {
        setRows(lb.leaderboard ?? []);
        setBt(stats.btBoard ?? []);
      })
      .finally(() => setLoading(false));
  }, [category]);

  const btById = new Map(bt.map((b) => [b.id, b]));
  const display = [...rows].sort((a, b) => {
    if (mode === "bt") return (btById.get(b.id)?.btElo ?? 1200) - (btById.get(a.id)?.btElo ?? 1200);
    return b.elo - a.elo;
  });
  const maxScore = Math.max(1300, ...display.map((r) => (mode === "bt" ? (btById.get(r.id)?.btElo ?? 1200) : r.elo)));

  return (
    <div>
      <div className="flex flex-wrap items-center justify-center gap-2">
        {LEADERBOARD_CATS.map((c: any) => (
          <button
            key={c.id}
            onClick={() => setCategory(c.id)}
            className={`rounded-full px-3.5 py-1.5 text-xs font-bold transition ${
              category === c.id
                ? "bg-violet-600 text-white shadow-[0_6px_20px_rgba(124,58,237,0.5)]"
                : "bg-white/5 text-slate-300 ring-1 ring-white/10 hover:bg-white/10"
            }`}
          >
            {c.emoji} {c.label}
          </button>
        ))}
      </div>

      <div className="mt-3 flex items-center justify-center gap-2">
        <div className="flex overflow-hidden rounded-full ring-1 ring-white/10">
          <button
            onClick={() => setMode("elo")}
            className={`px-4 py-1.5 text-xs font-bold ${mode === "elo" ? "bg-cyan-500/25 text-cyan-200" : "text-slate-400 hover:text-white"}`}
            title="Live online Elo, updated after every vote (K=32)"
          >
            ⚡ Online Elo
          </button>
          <button
            onClick={() => setMode("bt")}
            className={`px-4 py-1.5 text-xs font-bold ${mode === "bt" ? "bg-cyan-500/25 text-cyan-200" : "text-slate-400 hover:text-white"}`}
            title="Bradley-Terry maximum-likelihood refit over your full vote history — LMArena's method"
          >
            📊 Bradley-Terry
          </button>
        </div>
      </div>
      <p className="mt-2 text-center text-[11px] text-slate-500">
        {mode === "elo"
          ? "Live Elo (K=32) with analytic 95% CI. Updates the instant you vote."
          : "Bradley-Terry MLE refit + bootstrap 95% CI — the same estimator family LMArena uses."}
      </p>

      <div className="glass mt-4 overflow-hidden rounded-2xl">
        <div className="hidden grid-cols-[52px_1fr_130px_90px_90px_110px] gap-2 border-b border-white/10 bg-white/[0.03] px-5 py-3 text-[11px] font-black uppercase tracking-wider text-slate-400 md:grid">
          <span>Rank</span>
          <span>Model</span>
          <span className="text-right">{mode === "elo" ? "Elo ± CI" : "BT ± CI"}</span>
          <span className="text-right">Battles</span>
          <span className="text-right">Win rate</span>
          <span className="text-right">Status</span>
        </div>
        <div className="divide-y divide-white/5">
          {loading && <p className="px-5 py-8 text-center text-sm text-slate-500">Computing ratings…</p>}
          {!loading &&
            display.map((r, i) => {
              const score = mode === "elo" ? r.elo : (btById.get(r.id)?.btElo ?? 1200);
              const ci = mode === "elo" ? r.ci : (btById.get(r.id)?.ci ?? 200);
              const n = mode === "elo" ? r.battles : (btById.get(r.id)?.votes ?? 0);
              const winRate = r.battles ? Math.round((r.wins / r.battles) * 100) : 0;
              const width = Math.max(8, Math.round(((score - 900) / (maxScore - 900)) * 100));
              return (
                <div
                  key={r.id}
                  className="grid grid-cols-[44px_1fr_auto] items-center gap-3 px-4 py-4 md:grid-cols-[52px_1fr_130px_90px_90px_110px] md:gap-2 md:px-5"
                >
                  <span className="text-center text-sm font-black text-slate-300">{medal(i)}</span>
                  <div className="min-w-0">
                    <p className="truncate text-sm font-extrabold text-white">
                      {r.name}{" "}
                      {r.provisional && mode === "elo" && (
                        <span className="ml-1 rounded-full bg-amber-400/15 px-2 py-0.5 text-[10px] font-bold text-amber-300 ring-1 ring-amber-400/30">
                          provisional
                        </span>
                      )}
                    </p>
                    <p className="truncate text-[11px] text-slate-400">
                      {r.provider} · {r.description}
                    </p>
                    <div className="mt-1.5 h-1.5 w-full max-w-xs overflow-hidden rounded-full bg-white/5">
                      <div
                        className="h-full rounded-full bg-gradient-to-r from-violet-500 to-cyan-400"
                        style={{ width: `${width}%` }}
                      />
                    </div>
                  </div>
                  <div className="text-right">
                    <p className="font-mono text-base font-black text-cyan-300 md:text-lg">
                      {score}
                      <span className="ml-1 text-[11px] font-bold text-slate-400">±{ci}</span>
                    </p>
                    <p className="text-[10px] text-slate-500 md:hidden">
                      {n} battles · {winRate}%
                    </p>
                  </div>
                  <p className="hidden text-right font-mono text-sm font-bold text-slate-200 md:block">{n}</p>
                  <p className="hidden text-right font-mono text-sm font-bold text-slate-200 md:block">
                    {mode === "elo" ? `${winRate}%` : "—"}
                  </p>
                  <p className="hidden text-right text-xs font-bold md:block">
                    {n === 0 ? (
                      <span className="text-slate-500">unranked</span>
                    ) : n < 10 ? (
                      <span className="text-amber-300"> provisional</span>
                    ) : (
                      <span className="text-emerald-300">● stable</span>
                    )}
                  </p>
                </div>
              );
            })}
        </div>
      </div>

      <p className="mx-auto mt-3 max-w-2xl text-center text-[11px] leading-relaxed text-slate-500">
        Overlapping ±CI bands mean the rank order is statistical noise — treat models within ~50 points as tied,
        exactly as LMArena advises. &quot;Provisional&quot; = fewer than 10 battles (personal-scale analogue of
        LMArena&apos;s vote-count threshold).
      </p>
    </div>
  );
}
