import Link from "@/routing/Link";
import Markdown from "@/components/Markdown";
import { usePageData } from "@/routing/page-data";

type BattlePageData = {
  battle: {
    category: string;
    createdAt: Date | null;
    prompt: string;
    responseA: string | null;
    responseB: string | null;
    winner: string | null;
  };
  turns: Array<{ prompt: string; a?: string; b?: string }>;
  outcome: string;
  nameA: string;
  nameB: string;
  voted: boolean;
};

export default function BattlePage({ params }: { params: Record<string,string> }) {
  const state = usePageData<BattlePageData>("battles", Object.values(params)[0]);
  if (state.loading) return <p className="text-center text-slate-400">Loading…</p>;
  if (state.error) return <p role="alert" className="text-center text-slate-400">{state.error}</p>;
  const { battle, turns, outcome, nameA, nameB, voted } = state.data;

  return (
    <div className="mx-auto max-w-5xl">
      <div className="mb-5 text-center">
        <p className="inline-flex items-center gap-2 rounded-full border border-white/10 bg-white/5 px-4 py-1.5 text-xs font-bold text-slate-300">
          ⚔️ Shared battle · {battle.category} · {battle.createdAt?.toLocaleDateString()}
        </p>
        <h1 className="mx-auto mt-3 max-w-3xl text-xl font-black leading-snug text-white sm:text-2xl">
          “{battle.prompt}”
        </h1>
        <p className="mt-2 text-sm font-extrabold text-cyan-300">{outcome}</p>
      </div>

      <div className="space-y-5">
        {turns.map((t, i) => (
          <div key={i}>
            {turns.length > 1 && (
              <p className="mb-2 text-center text-xs font-black uppercase tracking-wider text-slate-500">
                Turn {i + 1}: {t.prompt}
              </p>
            )}
            <div className="grid items-start gap-4 md:grid-cols-2">
              {(
                [
                  { side: "A", text: t.a ?? battle.responseA, name: nameA, won: battle.winner === "a" },
                  { side: "B", text: t.b ?? battle.responseB, name: nameB, won: battle.winner === "b" },
                ] as const
              ).map((p) => (
                <div key={p.side} className={`glass overflow-hidden rounded-2xl ${voted && p.won ? "ring-2 ring-amber-400/60" : ""}`}>
                  <div className={`flex items-center gap-2 px-4 py-3 ${p.side === "A" ? "bg-violet-600/10" : "bg-cyan-600/10"}`}>
                    <span className={`grid h-7 w-7 place-items-center rounded-lg text-sm font-black text-white ${p.side === "A" ? "bg-violet-600" : "bg-cyan-600"}`}>
                      {p.side}
                    </span>
                    <p className="min-w-0 flex-1 truncate text-sm font-extrabold text-white">
                      {voted ? p.name : "🎭 Anonymous"}
                    </p>
                    {voted && p.won && <span>🏆</span>}
                  </div>
                  <div className="scroll-thin max-h-[480px] overflow-y-auto p-4">
                    <Markdown text={p.text || "…"} />
                  </div>
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>

      <div className="mt-6 flex flex-wrap justify-center gap-2">
        {!voted && (
          <Link href="/" className="btn-arena rounded-xl px-5 py-2 text-sm font-extrabold text-white">
            ⚔️ Vote in the arena
          </Link>
        )}
        <a
          href={battle.category === "image" ? "/image" : "/"}
          className="rounded-xl border border-white/10 bg-white/5 px-5 py-2 text-sm font-bold text-white hover:bg-white/10"
        >
          ⚔️ Run your own battle
        </a>
        <Link href="/leaderboard" className="rounded-xl border border-white/10 bg-white/5 px-5 py-2 text-sm font-bold text-white hover:bg-white/10">
          🏆 Leaderboard
        </Link>
      </div>
    </div>
  );
}

