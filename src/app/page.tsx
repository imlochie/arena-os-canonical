import BattleArena from "@/components/BattleArena";
import KeysBar from "@/components/KeysBar";

export const dynamic = "force-dynamic";

const QUICK_LAUNCH = [
  { href: "/chat", emoji: "💬", name: "Chat", desc: "Talk to the brain you pick" },
  { href: "/spaces", emoji: "🧩", name: "Spaces", desc: "Agent fleets & missions" },
  { href: "/command", emoji: "🧭", name: "Command", desc: "Not sure? Start here" },
  { href: "/waveyard", emoji: "🎚️", name: "Waveyard", desc: "Music studio — stems, remixes" },
  { href: "/arcade", emoji: "🎮", name: "Arcade", desc: "Forge any game", badge: "New" },
  { href: "/collab", emoji: "🤝", name: "Collab", desc: "Models build one answer", badge: "New" },
  { href: "/image", emoji: "🖼️", name: "Image", desc: "Generate pictures" },
  { href: "/projects", emoji: "📁", name: "Projects", desc: "Long-lived work" },
];

export default function HomePage() {
  return (
    <div>
      {/* Hero: one sentence, one decision. */}
      <section className="mb-8 text-center">
        <h1 className="text-glow mx-auto mt-2 max-w-3xl text-4xl font-black leading-[1.05] tracking-tight text-white sm:text-5xl">
          Your private AI arena.{" "}
          <span className="bg-gradient-to-r from-violet-400 via-fuchsia-300 to-cyan-300 bg-clip-text text-transparent">
            Zero cost. Full quality.
          </span>
        </h1>
        <p className="mx-auto mt-3 max-w-xl text-[15px] text-slate-300">
          Battle models blind, vote honestly, and keep everything — rankings, files, agents — on your machine.
        </p>
        <div className="mt-5 flex flex-wrap items-center justify-center gap-2.5">
          <a href="/command" className="btn rounded-xl bg-violet-600 px-6 py-3 text-sm text-white shadow-[0_10px_30px_rgba(124,58,237,0.45)] hover:bg-violet-500">
            🧭 What do you want to do?
          </a>
          <a href="/rooms" className="btn rounded-xl bg-white/5 px-5 py-3 text-sm text-slate-200 ring-1 ring-white/15 hover:bg-white/10">
            🗺️ Browse all rooms
          </a>
        </div>
        <p className="mt-3 text-[11px] text-slate-600">
          Three execution levels — <a href="/runtime" className="text-slate-400 underline decoration-dotted hover:text-slate-200">offline engine · on-device LLM · remote models</a> — every answer says what actually ran.
        </p>
      </section>

      {/* Quick launch: the eight most-used doors, one line each. */}
      <section className="mb-5">
        <p className="section-label mb-2">Quick launch</p>
        <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-4">
          {QUICK_LAUNCH.map((q) => (
            <a
              key={q.href}
              href={q.href}
              className="glass card-hover group relative rounded-xl p-3.5"
            >
              {q.badge && (
                <span className="absolute right-2.5 top-2.5 rounded-full bg-fuchsia-500/20 px-2 py-0.5 text-[9px] font-extrabold uppercase tracking-wider text-fuchsia-200 ring-1 ring-fuchsia-400/30">
                  {q.badge}
                </span>
              )}
              <p className="text-xl">{q.emoji}</p>
              <p className="mt-1.5 text-sm font-extrabold text-white group-hover:text-cyan-200">{q.name}</p>
              <p className="mt-0.5 text-[11px] leading-snug text-slate-500">{q.desc}</p>
            </a>
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
            body: "The primary engine needs no key, signup, or card. Optional free keys (Groq / OpenRouter) add headroom, and the offline engine guarantees the app never breaks.",
          },
          {
            emoji: "🎯",
            title: "Personal, not crowdsourced",
            body: "Public arenas rank models by everyone's taste. Yours ranks by yours — create assistants with your own prompts and battle them for your actual work.",
          },
          {
            emoji: "📦",
            title: "Fully duplicable",
            body: "A standard Next.js + Postgres stack. The Guide shows how to fork the concept, self-host for $0, and keep quality high.",
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
