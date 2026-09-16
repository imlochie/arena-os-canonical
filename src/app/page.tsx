import BattleArena from "@/components/BattleArena";
import KeysBar from "@/components/KeysBar";

export const dynamic = "force-dynamic";

export default function HomePage() {
  return (
    <div>
      <section className="mb-6 text-center">
        <p className="inline-flex items-center gap-2 rounded-full border border-violet-500/30 bg-violet-600/15 px-4 py-1.5 text-xs font-bold text-violet-200">
          ✨ One OS: 🧭 Command → 🧠 Council → ⚔️ Arena → 🤝 Collab → 📦 Artifacts → 📁 Projects
        </p>
        <h1 className="text-glow mx-auto mt-4 max-w-3xl text-4xl font-black leading-[1.05] tracking-tight text-white sm:text-5xl">
          Your private AI arena.{" "}
          <span className="bg-gradient-to-r from-violet-400 via-fuchsia-300 to-cyan-300 bg-clip-text text-transparent">
            Zero cost. Full quality.
          </span>
        </h1>
        <p className="mx-auto mt-3 max-w-2xl text-[15px] leading-relaxed text-slate-300">
          Three modes: <strong className="text-white">⚔️ Battle</strong> — two anonymous models compete, you crown
          the winner blind. <strong className="text-white">🤝 Collab</strong> — minds draft in parallel and
          synthesize one best result. <strong className="text-white">🧠 Council</strong> — name the cognitive
          job and get disagreeing perspectives forged into a usable artifact. Votes build your personal
          ELO; everything runs free.
        </p>
        <div className="mx-auto mt-4 flex max-w-2xl flex-wrap items-center justify-center gap-2 text-[11px] font-bold">
          <a href="/command" className="rounded-full bg-violet-600 px-3.5 py-1.5 text-white shadow-[0_6px_20px_rgba(124,58,237,0.5)] hover:bg-violet-500">
            🧭 Enter Command Centre — what are you trying to do? →
          </a>
          <a href="/collab" className="rounded-full bg-emerald-500/20 px-3.5 py-1.5 text-emerald-200 ring-1 ring-emerald-400/40 hover:bg-emerald-500/30">
            🤝 New: Collab Lab — best result, not just a winner →
          </a>
          <a href="/privacy" className="rounded-full bg-emerald-500/20 px-3.5 py-1.5 text-emerald-200 ring-1 ring-emerald-400/40 hover:bg-emerald-500/30">
            🛡️ Never trained on · offline Local Mode →
          </a>
          <a href="/arcade" className="rounded-full bg-fuchsia-500/20 px-3.5 py-1.5 text-fuchsia-200 ring-1 ring-fuchsia-400/40 hover:bg-fuchsia-500/30">
            🎮 New: Arcade Forge — Pac-Man & Invaders, 100% offline →
          </a>
          <a href="/studio" className="rounded-full bg-cyan-500/20 px-3.5 py-1.5 text-cyan-200 ring-1 ring-cyan-400/40 hover:bg-cyan-500/30">
            🎬 New: Studio — WanGP video/image/audio generation →
          </a>
          {["🎭 Blind battles", "🏆 Personal ELO", "🧬 Custom assistants", "$0 forever"].map((t) => (
            <span key={t} className="rounded-full bg-white/5 px-3 py-1.5 text-slate-300 ring-1 ring-white/10">
              {t}
            </span>
          ))}
        </div>
      </section>

      <div className="mb-5">
        <KeysBar />
      </div>

      <BattleArena />

      <section className="mt-10 grid gap-4 md:grid-cols-3">
        {[
          {
            emoji: "🆓",
            title: "Free without the catch",
            body: "Primary engine is the Pollinations free tier — no key, no signup, no card. Optional Groq / OpenRouter free keys add headroom. Offline Sage guarantees the app never breaks.",
          },
          {
            emoji: "🎯",
            title: "Personal, not crowdsourced",
            body: "Public arenas rank models by everyone's taste. Yours ranks by yours. Create assistants with your own system prompts and battle them for your actual work.",
          },
          {
            emoji: "📦",
            title: "Fully duplicable",
            body: "This whole app is a standard Next.js + Postgres stack. The Clone Guide shows you how to fork the concept, self-host for $0, and keep quality high.",
          },
        ].map((c) => (
          <div key={c.title} className="glass card-hover rounded-2xl p-5">
            <p className="text-2xl">{c.emoji}</p>
            <h3 className="mt-2 text-base font-extrabold text-white">{c.title}</h3>
            <p className="mt-1.5 text-sm leading-relaxed text-slate-300">{c.body}</p>
          </div>
        ))}
      </section>
    </div>
  );
}
