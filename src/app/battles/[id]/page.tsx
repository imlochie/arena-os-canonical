import { db } from "@/db";
import { battles, battleMessages, assistants, models } from "@/db/schema";
import { asc, eq, inArray } from "drizzle-orm";
import { notFound } from "next/navigation";
import Markdown from "@/components/Markdown";

export const dynamic = "force-dynamic";

export default async function BattlePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const [battle] = await db.select().from(battles).where(eq(battles.id, id)).limit(1);
  if (!battle) notFound();

  const msgs = await db
    .select()
    .from(battleMessages)
    .where(eq(battleMessages.battleId, id))
    .orderBy(asc(battleMessages.createdAt))
    .limit(100);

  const voted = !!battle.winner;
  let nameA = "???";
  let nameB = "???";
  if (voted) {
    const mRows = await db.select().from(models).where(inArray(models.id, [battle.modelAId, battle.modelBId]));
    const byM = new Map(mRows.map((m) => [m.id, m.name]));
    nameA = byM.get(battle.modelAId) ?? battle.modelAId;
    nameB = byM.get(battle.modelBId) ?? battle.modelBId;
    const aIds = [battle.assistantAId, battle.assistantBId].filter(Boolean) as string[];
    if (aIds.length) {
      const aRows = await db.select().from(assistants).where(inArray(assistants.id, aIds));
      const byA = new Map(aRows.map((a) => [a.id, `${a.avatar} ${a.name}`]));
      if (battle.assistantAId && byA.get(battle.assistantAId)) nameA = `${byA.get(battle.assistantAId)} (${nameA})`;
      if (battle.assistantBId && byA.get(battle.assistantBId)) nameB = `${byA.get(battle.assistantBId)} (${nameB})`;
    }
  }

  // Group messages into turns
  const turns: { prompt: string; a?: string; b?: string }[] = [];
  for (const m of msgs) {
    if (m.role === "user") turns.push({ prompt: m.content });
    else if (turns.length) {
      const last = turns[turns.length - 1];
      if (m.role === "a") last.a = m.content;
      else last.b = m.content;
    }
  }
  if (turns.length === 0) {
    turns.push({ prompt: battle.prompt, a: battle.responseA, b: battle.responseB });
  }

  const outcome =
    battle.winner === "a" ? `🏆 ${nameA} won` : battle.winner === "b" ? `🏆 ${nameB} won` : battle.winner === "tie" ? "🤝 Tie" : battle.winner === "both-bad" ? "👎 Both bad" : "🎭 Awaiting vote";

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
          <a href="/" className="btn-arena rounded-xl px-5 py-2 text-sm font-extrabold text-white">
            ⚔️ Vote in the arena
          </a>
        )}
        <a
          href={battle.category === "image" ? "/image" : "/"}
          className="rounded-xl border border-white/10 bg-white/5 px-5 py-2 text-sm font-bold text-white hover:bg-white/10"
        >
          ⚔️ Run your own battle
        </a>
        <a href="/leaderboard" className="rounded-xl border border-white/10 bg-white/5 px-5 py-2 text-sm font-bold text-white hover:bg-white/10">
          🏆 Leaderboard
        </a>
      </div>
    </div>
  );
}
