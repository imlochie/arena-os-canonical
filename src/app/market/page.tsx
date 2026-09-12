export const dynamic = "force-dynamic";

function Tag({ children, tone }: { children: React.ReactNode; tone: "yes" | "part" | "no" }) {
  const s = {
    yes: "border-emerald-400/30 bg-emerald-400/10 text-emerald-200",
    part: "border-amber-400/30 bg-amber-400/10 text-amber-200",
    no: "border-white/10 bg-white/5 text-slate-400",
  } as const;
  return (
    <span className={`inline-block rounded-full border px-2 py-0.5 text-[10px] font-bold ${s[tone]}`}>{children}</span>
  );
}

export default function MarketPage() {
  return (
    <div className="mx-auto max-w-5xl">
      <div className="text-center">
        <p className="inline-flex items-center gap-2 rounded-full border border-fuchsia-400/30 bg-fuchsia-400/10 px-4 py-1.5 text-xs font-bold text-fuchsia-200">
          📊 Market assessment
        </p>
        <h1 className="mx-auto mt-4 text-3xl font-black leading-tight tracking-tight text-white sm:text-4xl">
          ArenaForge vs the market:{" "}
          <span className="bg-gradient-to-r from-fuchsia-300 to-cyan-300 bg-clip-text text-transparent">
            what we studied, what we shipped
          </span>
        </h1>
        <p className="mx-auto mt-3 max-w-2xl text-sm leading-relaxed text-slate-300">
          We compared ArenaForge against 6 products across 2 categories — <strong className="text-white">blind-battle arenas</strong> (LMArena,
          Open Model Arena) and <strong className="text-white">self-hosted chat frontends</strong> (OpenWebUI, LibreChat,
          TypingMind, AnythingLLM) — then implemented every high-value gap that fits a $0 personal stack.
        </p>
      </div>

      {/* Arena comparison */}
      <div className="glass mt-6 rounded-2xl p-5">
        <h2 className="text-base font-extrabold text-white">⚔️ Battle arenas compared</h2>
        <div className="mt-3 overflow-x-auto">
          <table className="w-full min-w-[720px] border-collapse text-xs">
            <thead>
              <tr className="text-left text-[11px] uppercase tracking-wider text-slate-400">
                <th className="border border-white/10 bg-white/[0.03] px-3 py-2">Capability</th>
                <th className="border border-white/10 bg-white/[0.03] px-3 py-2">LMArena</th>
                <th className="border border-white/10 bg-white/[0.03] px-3 py-2">Open Model Arena</th>
                <th className="border border-white/10 bg-white/[0.03] px-3 py-2">ArenaForge (now)</th>
              </tr>
            </thead>
            <tbody className="text-slate-200">
              {[
                ["Blind battles + vote-to-reveal", "yes|✓", "yes|✓", "yes|✓"],
                ["Streaming responses", "yes|✓ instant", "yes|✓ SSE", "yes|✓ SSE + fallback"],
                ["Multi-turn battles", "yes|✓", "no|—", "yes|✓ 10 turns"],
                ["Side-by-side (pick two)", "yes|✓", "yes|✓", "yes|✓ models + assistants"],
                ["Assistant / persona battles", "no|—", "no|—", "yes|✓ unique"],
                ["Elo ratings", "yes|✓ BT-based", "yes|✓ K=32", "yes|✓ Elo + BT"],
                ["Confidence intervals", "yes|✓", "no|—", "yes|✓ boot + analytic"],
                ["Category boards", "yes|✓ 9 cats", "part|filter only", "yes|✓ 6 cats"],
                ["AI judge / auto-eval", "part|Arena-Hard sep.", "no|—", "yes|✓ in-battle judge"],
                ["Image arena", "yes|✓", "no|—", "yes|✓ Flux vs Turbo"],
                ["Vote export (JSON/CSV)", "part|research dumps", "yes|✓", "yes|✓ 1-click"],
                ["Prompt templates", "no|—", "part|localStorage", "yes|✓ DB-backed"],
                ["Shareable battle links", "yes|✓", "no|—", "yes|✓ /battles/[id]"],
                ["Personal (solo) ELO", "no|crowd only", "part|local only", "yes|✓ yours"],
                ["Works fully free", "yes|✓", "part|BYOM cost", "yes|✓ $0 + offline"],
              ].map((r) => (
                <tr key={r[0]}>
                  <td className="border border-white/10 px-3 py-2 font-semibold text-white">{r[0]}</td>
                  {[r[1], r[2], r[3]].map((c, i) => {
                    const [tone, label] = c.split("|");
                    return (
                      <td key={i} className="border border-white/10 px-3 py-2">
                        <Tag tone={tone as "yes" | "part" | "no"}>{label}</Tag>
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {/* Chat frontend comparison */}
      <div className="glass mt-5 rounded-2xl p-5">
        <h2 className="text-base font-extrabold text-white">💬 Self-hosted chat features borrowed</h2>
        <div className="mt-3 overflow-x-auto">
          <table className="w-full min-w-[720px] border-collapse text-xs">
            <thead>
              <tr className="text-left text-[11px] uppercase tracking-wider text-slate-400">
                <th className="border border-white/10 bg-white/[0.03] px-3 py-2">Feature (source)</th>
                <th className="border border-white/10 bg-white/[0.03] px-3 py-2">Status here</th>
                <th className="border border-white/10 bg-white/[0.03] px-3 py-2">Notes</th>
              </tr>
            </thead>
            <tbody className="text-slate-200">
              {[
                ["Personas / custom assistants (OpenWebUI, LibreChat)", "yes|✓ SHIPPED", "Full CRUD + per-assistant brain & temperature, usable in chat and battles"],
                ["Prompt library (LibreChat, TypingMind)", "yes|✓ SHIPPED", "DB-backed templates with 1-click apply, save & delete"],
                ["Conversation search (all)", "yes|✓ SHIPPED", "Battle history search + category filtering"],
                ["TTS read-aloud (OpenWebUI)", "yes|✓ SHIPPED", "Free browser speechSynthesis 🔊 on every battle response"],
                ["Copy / retry / stop (all)", "yes|✓ SHIPPED", "Per-response copy, same-prompt retry with fresh fighters, stream stop"],
                ["Direct chat + history (all)", "yes|✓ KEPT", "Pre-existing; unchanged — already at parity"],
                ["Image generation (OpenWebUI, LMArena)", "yes|✓ SHIPPED", "Full Image Arena with Elo, not just a generator box"],
                ["RAG / document chat (AnythingLLM, OpenWebUI)", "no|ROADMAP", "Needs embeddings + vector store; pgvector add-on planned — nothing free & instant matches it"],
                ["Web search grounding (OpenWebUI)", "no|ROADMAP", "Needs a search API key; breaks the $0-keyless promise for now"],
                ["Voice input / STT (OpenWebUI)", "no|ROADMAP", "Browser mic API possible later; TTS output covers the main need"],
                ["Multi-user auth + teams (LibreChat)", "no|OUT OF SCOPE", "Solo personal arena by design; would need auth + per-user vote pools"],
              ].map((r) => (
                <tr key={r[0]}>
                  <td className="border border-white/10 px-3 py-2 font-semibold text-white">{r[0]}</td>
                  <td className="border border-white/10 px-3 py-2">
                    <Tag tone={r[1].split("|")[0] as "yes" | "no"}>{r[1].split("|")[1]}</Tag>
                  </td>
                  <td className="border border-white/10 px-3 py-2 text-slate-300">{r[2]}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {/* Code comparison */}
      <div className="glass mt-5 rounded-2xl p-5">
        <h2 className="text-base font-extrabold text-white">🧑‍💻 Code & architecture comparison</h2>
        <div className="mt-3 grid gap-2 text-xs leading-relaxed sm:grid-cols-3">
          <div className="rounded-xl bg-white/[0.03] p-3 ring-1 ring-white/5">
            <p className="text-sm font-extrabold text-white">LMArena: FastChat + Arena-Rank</p>
            <p className="mt-1 text-slate-300">
              Python (Gradio/FastChat) + the <strong>Arena-Rank</strong> package for BT fitting. Battle-tested at
              6.8M+ votes but heavy to self-host. Our <strong>TypeScript BT implementation</strong> (Hunter MM +
              bootstrap CIs) mirrors its math in one file, tuned for personal-scale N.
            </p>
          </div>
          <div className="rounded-xl bg-white/[0.03] p-3 ring-1 ring-white/5">
            <p className="text-sm font-extrabold text-white">Open Model Arena: BYOM + SSE</p>
            <p className="mt-1 text-slate-300">
              Bring-your-own-model with server-sent streaming and localStorage templates. We adopted its best
              ideas — <strong>true SSE streaming</strong>, templates, CSV/JSON export — but made them
              <strong> DB-backed and keyless-free</strong> instead of config-file driven.
            </p>
          </div>
          <div className="rounded-xl bg-white/[0.03] p-3 ring-1 ring-white/5">
            <p className="text-sm font-extrabold text-white">OpenWebUI / LibreChat: workstations</p>
            <p className="mt-1 text-slate-300">
              Python+Svelte / Node+React monoliths with RAG, plugins, and auth. Powerful but complex (multi-container,
              Mongo/Meili). We stay a <strong>single Next.js + Postgres app</strong> and cherry-pick only the
              workstation features that survive at $0: personas, templates, TTS, search.
            </p>
          </div>
        </div>
      </div>

      {/* Shipped */}
      <div className="mt-5 rounded-2xl border border-emerald-400/25 bg-gradient-to-br from-emerald-500/10 to-cyan-500/5 p-5">
        <h2 className="text-base font-extrabold text-white">🚢 Shipped in this update (all $0, all standards-compliant)</h2>
        <div className="mt-3 grid gap-2 text-xs sm:grid-cols-2">
          {[
            "⚡ SSE streaming battles with graceful non-stream fallback",
            "💬 Multi-turn arena threads (10 turns, vote on the whole conversation)",
            "🧑‍⚖️ In-battle AI judge (advisory scores + one-click accept)",
            "🧬 Assistant-vs-assistant battles (unique to ArenaForge)",
            "🖼️ Image Arena: Flux vs Turbo with Elo + share cards",
            "📝 DB-backed prompt template library (10 starters + your own)",
            "🔗 Shareable battle permalinks with full thread view",
            "🔍 Battle search, 🔁 retry, 📋 copy, 🔊 free TTS, ⏹ stop",
          ].map((s) => (
            <p key={s} className="rounded-xl bg-black/20 p-2.5 font-semibold text-emerald-100 ring-1 ring-emerald-400/15">
              {s}
            </p>
          ))}
        </div>
        <div className="mt-4 flex flex-wrap gap-2">
          <a href="/" className="btn-arena rounded-xl px-5 py-2 text-sm font-extrabold text-white">⚔️ Try streaming battles</a>
          <a href="/image" className="rounded-xl border border-white/10 bg-white/5 px-5 py-2 text-sm font-bold text-white hover:bg-white/10">🖼️ Try the Image Arena</a>
          <a href="/standards" className="rounded-xl border border-white/10 bg-white/5 px-5 py-2 text-sm font-bold text-white hover:bg-white/10">📏 Standards audit</a>
        </div>
      </div>
    </div>
  );
}
