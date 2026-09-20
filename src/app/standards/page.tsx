export const dynamic = "force-dynamic";

function Verdict({ level, children }: { level: "yes" | "partial" | "no"; children: React.ReactNode }) {
  const styles = {
    yes: "border-emerald-400/30 bg-emerald-400/10 text-emerald-200",
    partial: "border-amber-400/30 bg-amber-400/10 text-amber-200",
    no: "border-red-400/30 bg-red-400/10 text-red-200",
  } as const;
  const icon = { yes: "✅", partial: "⚠️", no: "❌" } as const;
  return (
    <span className={`inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-[11px] font-bold ${styles[level]}`}>
      {icon[level]} {children}
    </span>
  );
}

export default function StandardsPage() {
  return (
    <div className="mx-auto max-w-4xl">
      <div className="text-center">
        <p className="inline-flex items-center gap-2 rounded-full border border-cyan-400/30 bg-cyan-400/10 px-4 py-1.5 text-xs font-bold text-cyan-200">
          📏 Standards audit
        </p>
        <h1 className="mx-auto mt-4 text-3xl font-black leading-tight tracking-tight text-white sm:text-4xl">
          Can this arena be held to{" "}
          <span className="bg-gradient-to-r from-cyan-300 to-violet-300 bg-clip-text text-transparent">
            LMArena&apos;s standards?
          </span>
        </h1>
        <p className="mx-auto mt-3 max-w-2xl text-sm leading-relaxed text-slate-300">
          Honest answer: <strong className="text-white">methodologically yes, statistically it depends on you.</strong>{" "}
          The rating math, blinding discipline, and transparency in this app match LMArena&apos;s published
          methodology. What you can&apos;t duplicate alone is their <em>scale</em> — millions of voters. But for{" "}
          <em>personal</em> decisions, your 50 honest votes beat their 6.8M strangers&apos; votes. Here&apos;s the
          item-by-item audit.
        </p>
      </div>

      {/* Methodology match */}
      <div className="glass mt-6 rounded-2xl p-5">
        <h2 className="text-base font-extrabold text-white">⚙️ Methodology: what matches</h2>
        <div className="mt-3 overflow-x-auto">
          <table className="w-full min-w-[620px] border-collapse text-xs">
            <thead>
              <tr className="text-left text-[11px] uppercase tracking-wider text-slate-400">
                <th className="border border-white/10 bg-white/[0.03] px-3 py-2">LMArena standard</th>
                <th className="border border-white/10 bg-white/[0.03] px-3 py-2">This arena</th>
                <th className="border border-white/10 bg-white/[0.03] px-3 py-2">Verdict</th>
              </tr>
            </thead>
            <tbody className="text-slate-200">
              {[
                ["Blind pairwise battles, identities revealed only after voting", "Identities masked server-side (modelAId → \"???\") until vote; one vote per battle, enforced", "yes|MATCHES"],
                ["Random model sampling", "Uniform random pairing in Blind mode; targeted mode labeled separately in the record", "yes|MATCHES"],
                ["Position randomization (no left/right advantage)", "A/B sides randomly swapped 50/50 after generation; position-bias meter on leaderboard", "yes|MATCHES"],
                ["Bradley-Terry MLE scoring (not raw win rate)", "Full BT refit over vote history (Hunter MM algorithm) + online Elo K=32 for live updates", "yes|MATCHES"],
                ["95% confidence intervals on every score", "Bootstrap CIs for BT (80 resamples), analytic CIs for Elo; overlapping bands flagged as noise", "yes|MATCHES"],
                ["Vote-count threshold + Provisional flag", "Provisional below 10 battles per model (personal-scale threshold); stable above", "yes|MATCHES"],
                ["Category leaderboards (Coding, Math, Writing…)", "Per-category Elo tables: Overall, Coding, Writing, Reasoning, Roleplay + General", "yes|MATCHES"],
                ["Tie + both-bad handling", "Tie = ½ win each in BT/Elo; both-bad excluded from BT with small Elo penalty + tracked rate", "yes|MATCHES"],
                ["Style/length-bias disclosure", "Style diagnostic: longer-answer win rate + avg length gap, with 65% health threshold", "yes|MATCHES"],
                ["Open data / reproducible votes", "One-click JSON + CSV export of every battle with methodology header", "yes|MATCHES"],
                ["Expected win-rate scale (100 pts ≈ 64%)", "Same logistic scale; leaderboard shows expected-vs-top for every model", "yes|MATCHES"],
              ].map((r) => (
                <tr key={r[0]}>
                  <td className="border border-white/10 px-3 py-2 font-semibold text-white">{r[0]}</td>
                  <td className="border border-white/10 px-3 py-2">{r[1]}</td>
                  <td className="border border-white/10 px-3 py-2">
                    <Verdict level={r[2].split("|")[0] as "yes"}>{r[2].split("|")[1]}</Verdict>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {/* Honest gaps */}
      <div className="glass mt-5 rounded-2xl p-5">
        <h2 className="text-base font-extrabold text-white">🪞 Honest gaps: what a personal arena can&apos;t claim</h2>
        <div className="mt-3 grid gap-2 text-xs leading-relaxed sm:grid-cols-2">
          <div className="rounded-xl bg-white/[0.03] p-3 ring-1 ring-white/5">
            <p className="text-sm font-extrabold text-white">📊 Statistical power <Verdict level="partial">SCALES WITH YOU</Verdict></p>
            <p className="mt-1.5 text-slate-300">
              LMArena stabilizes scores with ~1,000–100,000 votes per model. Your CIs will be wide (±30–60) until
              you cast 30–50+ votes. The app shows this honestly instead of hiding it — wide bands <em>are</em> the
              standard-compliant behavior at low N.
            </p>
          </div>
          <div className="rounded-xl bg-white/[0.03] p-3 ring-1 ring-white/5">
            <p className="text-sm font-extrabold text-white">👥 Crowd diversity <Verdict level="partial">N/A BY DESIGN</Verdict></p>
            <p className="mt-1.5 text-slate-300">
              Public arenas average thousands of tastes; yours measures one — yours. That&apos;s a feature for
              personal decisions and a limitation for general claims. Never quote your board as &quot;Model X is
              better&quot; — quote it as &quot;better <em>for me</em>&quot;.
            </p>
          </div>
          <div className="rounded-xl bg-white/[0.03] p-3 ring-1 ring-white/5">
            <p className="text-sm font-extrabold text-white">🤖 Anti-gaming / Sybil resistance <Verdict level="no">NOT NEEDED SOLO</Verdict></p>
            <p className="mt-1.5 text-slate-300">
              LMArena needs fingerprinting and anomaly detection because strangers vote. Your arena has one voter,
              so Sybil attacks are meaningless. If you ever open it to a team, add auth + per-user vote caps first.
            </p>
          </div>
          <div className="rounded-xl bg-white/[0.03] p-3 ring-1 ring-white/5">
            <p className="text-sm font-extrabold text-white">🧪 Auto-evals (MT-Bench, Arena-Hard) <Verdict level="no">NOT INCLUDED</Verdict></p>
            <p className="mt-1.5 text-slate-300">
              LMArena pairs human votes with LLM-judged benchmarks for speed. This app is human-vote-only. For
              factuality, safety, or benchmark scores, pair your board with SWE-bench / MMLU / your own test set —
              same advice LMArena gives about itself.
            </p>
          </div>
        </div>
      </div>

      {/* How to reach standard */}
      <div className="glass mt-5 rounded-2xl p-5">
        <h2 className="text-base font-extrabold text-white">🎯 How to make your board statistically legit</h2>
        <div className="mt-3 grid gap-2 text-xs sm:grid-cols-2">
          {[
            { n: "1", t: "Cast 30–50 blind votes", d: "That's when CIs tighten to ±15–25 and real separations appear. Use Blind Random mode so sampling stays uniform." },
            { n: "2", t: "Vote in one category at a time", d: "15 coding votes beat 50 scattered votes. Category boards are where LMArena-grade decisions happen." },
            { n: "3", t: "Respect the CIs", d: "If two models' ± bands overlap, call it a tie regardless of rank order. The app renders bands next to every score for this reason." },
            { n: "4", t: "Watch the integrity panel", d: "Keep position bias 40–60% and longer-answer win rate under 65%. If style bias creeps up, re-read for substance before voting." },
          ].map((s) => (
            <div key={s.n} className="flex gap-3 rounded-xl bg-white/[0.03] p-3 ring-1 ring-white/5">
              <span className="grid h-7 w-7 shrink-0 place-items-center rounded-lg bg-gradient-to-br from-violet-600 to-cyan-500 text-xs font-black text-white">
                {s.n}
              </span>
              <div>
                <p className="text-[13px] font-extrabold text-white">{s.t}</p>
                <p className="mt-0.5 leading-relaxed text-slate-300">{s.d}</p>
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* Bottom line */}
      <div className="mt-5 rounded-2xl border border-emerald-400/25 bg-gradient-to-br from-emerald-500/10 to-cyan-500/5 p-5">
        <h2 className="text-base font-extrabold text-white">⚖️ Bottom line</h2>
        <p className="mt-2 text-sm leading-relaxed text-slate-200">
          <strong className="text-white">Same rules, same math, same disclosures — smaller electorate.</strong> This
          arena implements the full LMArena evaluation protocol (blind pairs → vote → Bradley-Terry + Elo → CIs →
          categories → open data). Its ratings are <em>as rigorous as your vote count allows</em>, and it tells you
          exactly how rigorous that is. For choosing <em>your</em> daily driver among free models, that meets — and
          in relevance beats — the public standard.
        </p>
        <div className="mt-4 flex flex-wrap gap-2">
          <a href="/" className="btn-arena rounded-xl px-5 py-2 text-sm font-extrabold text-white">⚔️ Start voting</a>
          <a href="/leaderboard" className="rounded-xl border border-white/10 bg-white/5 px-5 py-2 text-sm font-bold text-white hover:bg-white/10">🏆 See the board</a>
          <a href="/api/export?format=json" className="rounded-xl border border-white/10 bg-white/5 px-5 py-2 text-sm font-bold text-white hover:bg-white/10">⬇️ Audit the data</a>
        </div>
      </div>
    </div>
  );
}
