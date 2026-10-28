import Link from "@/routing/Link";
import Markdown from "@/components/Markdown";
import { usePageData } from "@/routing/page-data";

type CollabPageData = {
  collab: {
    category: string;
    createdAt: Date | null;
    challenge: string;
    rounds: number;
    synthesis: string;
    bestContributor: number | null;
  };
  strategy: { emoji: string; name: string };
  drafts: Array<{ id: string; contribIndex: number; label: string; content: string }>;
  critiques: Array<{ id: string; label: string; content: string }>;
  rest: Array<{ id: string; round: number; label: string; kind: string; content: string }>;
};

export default function CollabPage({ params }: { params: Record<string,string> }) {
  const state = usePageData<CollabPageData>("collabs", Object.values(params)[0]);
  if (state.loading) return <p className="text-center text-slate-400">Loading…</p>;
  if (state.error) return <p role="alert" className="text-center text-slate-400">{state.error}</p>;
  const { collab, strategy, drafts, critiques, rest } = state.data;

  return (
    <div className="mx-auto max-w-5xl">
      <div className="mb-5 text-center">
        <p className="inline-flex items-center gap-2 rounded-full border border-emerald-400/30 bg-emerald-400/10 px-4 py-1.5 text-xs font-bold text-emerald-200">
          {strategy.emoji} {strategy.name} · {collab.category} · {collab.createdAt?.toLocaleDateString()}
        </p>
        <h1 className="mx-auto mt-3 max-w-3xl text-xl font-black leading-snug text-white sm:text-2xl">
          “{collab.challenge}”
        </h1>
        <p className="mt-2 text-xs text-slate-400">
          {drafts.length} minds · {critiques.length > 0 ? `${critiques.length} critiques · ` : ""}
          {collab.rounds > 1 ? `${collab.rounds} passes · ` : ""}shared collaboration
        </p>
      </div>

      <div className="overflow-hidden rounded-2xl border border-emerald-400/30 bg-gradient-to-b from-emerald-500/10 to-transparent">
        <div className="flex items-center gap-2.5 border-b border-emerald-400/20 px-4 py-3">
          <span className="grid h-9 w-9 place-items-center rounded-xl bg-gradient-to-br from-emerald-500 to-cyan-500 text-lg">💎</span>
          <p className="text-sm font-extrabold text-white">Best result</p>
        </div>
        <div className="p-5">
          <Markdown text={collab.synthesis || "…"} />
        </div>
      </div>

      <h2 className="mb-2 mt-6 text-xs font-black uppercase tracking-wider text-slate-400">Contributing minds</h2>
      <div className="grid items-start gap-3 md:grid-cols-2">
        {drafts.map((d) => (
          <div key={d.id} className={`glass overflow-hidden rounded-2xl ${collab.bestContributor === d.contribIndex ? "ring-2 ring-amber-400/60" : ""}`}>
            <div className="flex items-center gap-2 border-b border-white/10 px-3 py-2.5">
              <p className="min-w-0 flex-1 truncate text-xs font-extrabold text-white">{d.label}</p>
              {collab.bestContributor === d.contribIndex && <span title="Crowned">👑</span>}
            </div>
            <div className="scroll-thin max-h-72 overflow-y-auto p-3">
              <Markdown text={d.content} />
            </div>
          </div>
        ))}
      </div>

      {critiques.length > 0 && (
        <>
          <h2 className="mb-2 mt-6 text-xs font-black uppercase tracking-wider text-slate-400">Critiques</h2>
          <div className="grid gap-2 md:grid-cols-2">
            {critiques.map((c) => (
              <div key={c.id} className="rounded-xl bg-black/30 p-3 ring-1 ring-white/5">
                <p className="text-[11px] font-extrabold text-slate-200">{c.label}</p>
                <div className="mt-1 max-h-48 overflow-y-auto scroll-thin">
                  <Markdown text={c.content} />
                </div>
              </div>
            ))}
          </div>
        </>
      )}

      {rest.length > 0 && (
        <>
          <h2 className="mb-2 mt-6 text-xs font-black uppercase tracking-wider text-slate-400">Iteration trail</h2>
          <div className="space-y-2">
            {rest.map((c) => (
              <div key={c.id} className="rounded-xl bg-black/30 p-3 ring-1 ring-white/5">
                <p className="text-[11px] font-extrabold text-slate-200">Pass {c.round} · {c.label}</p>
                <div className="mt-1">
                  {c.kind === "user" ? (
                    <p className="text-xs italic text-violet-200">“{c.content}”</p>
                  ) : (
                    <Markdown text={c.content} />
                  )}
                </div>
              </div>
            ))}
          </div>
        </>
      )}

      <div className="mt-6 flex flex-wrap justify-center gap-2">
        <Link href="/collab" className="btn-arena rounded-xl px-5 py-2 text-sm font-extrabold text-white">
          🤝 Run your own collab
        </Link>
        <Link href="/" className="rounded-xl border border-white/10 bg-white/5 px-5 py-2 text-sm font-bold text-white hover:bg-white/10">
          ⚔️ Battle arena
        </Link>
      </div>
    </div>
  );
}

