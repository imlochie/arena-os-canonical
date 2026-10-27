"use client";

import { useEffect, useState } from "react";

interface Stats {
  totals: { battles: number; votes: number; btVotes: number };
  integrity: {
    aWins: number;
    bWins: number;
    ties: number;
    bothBad: number;
    tieRate: number;
    bothBadRate: number;
    positionBiasAWinRate: number;
    positionHealthy: boolean;
    lengthBiasLongerWinRate: number;
    lengthHealthy: boolean;
    avgDecisiveLengthDiff: number;
  };
  matrix: Record<string, Record<string, { total: number; winRate: number | null }>>;
}

const SHORT: Record<string, string> = {
  openai: "⚡GPT",
  mistral: "🌬️Mis",
  deepseek: "🧠DS",
  claude: "🟠Cl",
  gemini: "✨Gem",
  llama: "🦙Lla",
  qwen: "🛠️Qw",
  grok: "😏Grk",
  kimi: "🌙Kim",
  "offline-sage": "🛡️Off",
};

export default function IntegrityPanel() {
  const [stats, setStats] = useState<Stats | null>(null);

  useEffect(() => {
    fetch("/api/stats?category=overall")
      .then((r) => r.json())
      .then(setStats)
      .catch(() => {});
  }, []);

  if (!stats) return <p className="text-sm text-slate-500">Loading integrity metrics…</p>;
  const g = stats.integrity;
  const ids = Object.keys(stats.matrix);

  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <div className="glass rounded-2xl p-5">
        <h3 className="text-sm font-extrabold text-white">🛡️ Vote integrity (LMArena-style checks)</h3>
        <div className="mt-3 grid grid-cols-2 gap-2 text-center">
          {[
            { label: "Battles", value: stats.totals.battles },
            { label: "Votes cast", value: stats.totals.votes },
            { label: `Tie rate`, value: `${g.tieRate}%` },
            { label: "Both-bad rate", value: `${g.bothBadRate}%` },
          ].map((s) => (
            <div key={s.label} className="rounded-xl bg-white/[0.03] p-3 ring-1 ring-white/5">
              <p className="text-lg font-black text-white">{s.value}</p>
              <p className="text-[11px] font-bold text-slate-400">{s.label}</p>
            </div>
          ))}
        </div>
        <div className="mt-3 space-y-2 text-xs">
          <div className={`rounded-xl p-3 ring-1 ${g.positionHealthy ? "bg-emerald-400/5 ring-emerald-400/20" : "bg-amber-400/5 ring-amber-400/30"}`}>
            <p className="font-extrabold text-white">
              {g.positionHealthy ? "✅" : "⚠️"} Position bias: A-side wins {g.positionBiasAWinRate}% of decisive votes
            </p>
            <p className="mt-1 leading-relaxed text-slate-400">
              Healthy = 40–60%. Sides are randomly assigned per battle, so persistent skew means you may favor the
              left panel — try reading B first sometimes.
            </p>
          </div>
          <div className={`rounded-xl p-3 ring-1 ${g.lengthHealthy ? "bg-emerald-400/5 ring-emerald-400/20" : "bg-amber-400/5 ring-amber-400/30"}`}>
            <p className="font-extrabold text-white">
              {g.lengthHealthy ? "✅" : "⚠️"} Style check: longer answer wins {g.lengthBiasLongerWinRate}%
            </p>
            <p className="mt-1 leading-relaxed text-slate-400">
              LMArena publishes a separate Style-Control board because verbosity inflates scores. Above ~65% suggests
              you&apos;re rewarding length over substance (avg decisive length gap: {g.avgDecisiveLengthDiff} chars).
            </p>
          </div>
        </div>
        <div className="mt-3 flex flex-wrap gap-2">
          <a href="/api/export?format=json" className="rounded-lg border border-white/10 bg-white/5 px-3 py-1.5 text-xs font-bold text-white hover:bg-white/10">
            ⬇️ Export votes (JSON)
          </a>
          <a href="/api/export?format=csv" className="rounded-lg border border-white/10 bg-white/5 px-3 py-1.5 text-xs font-bold text-white hover:bg-white/10">
            ⬇️ Export votes (CSV)
          </a>
        </div>
      </div>

      <div className="glass rounded-2xl p-5">
        <h3 className="text-sm font-extrabold text-white">⚔️ Head-to-head win matrix</h3>
        <p className="mt-1 text-[11px] text-slate-400">
          Row beats column % (ties = half-win). Empty = pair hasn&apos;t met yet.
        </p>
        <div className="scroll-thin mt-3 overflow-x-auto">
          <table className="border-collapse text-[11px]">
            <thead>
              <tr>
                <th className="sticky left-0 bg-[#0d1426] p-1.5 text-left text-slate-500">↓ vs →</th>
                {ids.map((id) => (
                  <th key={id} className="min-w-[52px] p-1.5 text-center font-bold text-slate-300">
                    {SHORT[id] ?? id.slice(0, 4)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {ids.map((a) => (
                <tr key={a}>
                  <td className="sticky left-0 bg-[#0d1426] p-1.5 font-bold text-slate-300">{SHORT[a] ?? a.slice(0, 4)}</td>
                  {ids.map((b) => {
                    const cell = stats.matrix[a]?.[b];
                    if (a === b)
                      return (
                        <td key={b} className="p-1.5 text-center text-slate-700">
                          —
                        </td>
                      );
                    if (!cell || cell.total === 0)
                      return (
                        <td key={b} className="p-1.5 text-center text-slate-700">
                          ·
                        </td>
                      );
                    const wr = cell.winRate ?? 50;
                    const bg =
                      wr >= 65 ? "bg-emerald-500/25 text-emerald-200" : wr >= 55 ? "bg-emerald-500/10 text-emerald-100" : wr <= 35 ? "bg-red-500/25 text-red-200" : wr <= 45 ? "bg-red-500/10 text-red-100" : "bg-white/5 text-slate-200";
                    return (
                      <td key={b} className={`rounded p-1.5 text-center font-mono font-bold ${bg}`} title={`${cell.total} battles`}>
                        {wr}%
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="mt-2 text-[11px] text-slate-500">
          Small samples lie: a 100% cell on 1 battle is noise. Bradley-Terry discounts these automatically.
        </p>
      </div>
    </div>
  );
}
