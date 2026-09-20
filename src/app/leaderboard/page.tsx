import LeaderboardBoard from "@/components/LeaderboardBoard";
import IntegrityPanel from "@/components/IntegrityPanel";

export const dynamic = "force-dynamic";

export default function LeaderboardPage() {
  return (
    <div>
      <div className="mb-5 text-center">
        <h1 className="text-2xl font-black tracking-tight text-white sm:text-3xl">🏆 Personal Leaderboard</h1>
        <p className="mx-auto mt-1 max-w-2xl text-sm text-slate-300">
          ELO + Bradley-Terry ratings learned from <strong className="text-white">your</strong> votes — same
          estimator family as LMArena, with confidence intervals and integrity checks.
        </p>
      </div>

      <LeaderboardBoard />

      <div className="mt-5">
        <IntegrityPanel />
      </div>

      <div className="glass mt-5 rounded-2xl p-5">
        <h2 className="text-sm font-extrabold text-white">📐 How to read this like LMArena</h2>
        <div className="mt-2 grid gap-3 text-xs leading-relaxed text-slate-300 sm:grid-cols-3">
          <p className="rounded-xl bg-white/[0.03] p-3 ring-1 ring-white/5">
            <strong className="text-white">100 pts ≈ 64% win rate.</strong> A 200-pt gap ≈ 76%. Bigger gaps =
            genuinely better for you. Smaller gaps = noise until CIs separate.
          </p>
          <p className="rounded-xl bg-white/[0.03] p-3 ring-1 ring-white/5">
            <strong className="text-white">BT beats raw win rate.</strong> Beating a strong model counts more than
            beating a weak one, and uneven schedules are corrected — that&apos;s the MLE refit.
          </p>
          <p className="rounded-xl bg-white/[0.03] p-3 ring-1 ring-white/5">
            <strong className="text-white">Category &gt; Overall.</strong> Use Coding / Writing boards for real
            decisions. Overall skews toward whatever you ask most — same caveat LMArena publishes.
          </p>
        </div>
        <div className="mt-4 flex flex-wrap gap-2">
          <a href="/" className="btn-arena rounded-xl px-5 py-2 text-sm font-extrabold text-white">⚔️ Cast more votes</a>
          <a href="/standards" className="rounded-xl border border-white/10 bg-white/5 px-5 py-2 text-sm font-bold text-white hover:bg-white/10">📏 Full standards audit</a>
        </div>
      </div>
    </div>
  );
}
