import Link from "@/routing/Link";
import BattleArena from "@/components/BattleArena";
import KeysBar from "@/components/KeysBar";
import RecentRoomResume from "@/components/RecentRoomResume";

export const dynamic = "force-dynamic";

const QUICK_LAUNCH = [
  { href: "/chat", emoji: "💬", name: "Chat", desc: "Talk to the brain you pick" },
  { href: "/spaces", emoji: "🧩", name: "Spaces", desc: "Browser workspaces and tasks" },
  { href: "/command", emoji: "🧭", name: "Command", desc: "Not sure? Start here" },
  { href: "/waveyard", emoji: "🎚️", name: "Waveyard", desc: "Music studio — stems, remixes" },
  { href: "/arcade", emoji: "🎮", name: "Arcade", desc: "Create and revise browser games", badge: "New" },
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
          Your tools. One workspace.{" "}
          <span className="bg-gradient-to-r from-violet-400 via-fuchsia-300 to-cyan-300 bg-clip-text text-transparent">
            See what actually ran.
          </span>
        </h1>
        <p className="mx-auto mt-3 max-w-xl text-[15px] text-slate-300">
          Chat, build, browse, make games, and work with music in focused rooms.
        </p>
        <div className="mt-5 flex flex-wrap items-center justify-center gap-2.5">
          <Link href="/command" className="btn rounded-xl bg-violet-600 px-6 py-3 text-sm text-white shadow-[0_10px_30px_rgba(124,58,237,0.45)] hover:bg-violet-500">
            🧭 What do you want to do?
          </Link>
          <Link href="/rooms" className="btn rounded-xl bg-white/5 px-5 py-3 text-sm text-slate-200 ring-1 ring-white/15 hover:bg-white/10">
            🗺️ Browse handoff rooms
          </Link>
        </div>
        <p className="mt-3 text-[11px] text-slate-500">
          This web preview runs in the hosted Arena environment.{" "}
          <Link href="/runtime" className="text-slate-300 underline decoration-dotted hover:text-white">
            Check connected runtimes
          </Link>
        </p>
      </section>

      <RecentRoomResume />

      {/* Quick launch: the eight most-used doors, one line each. */}
      <section className="mb-5">
        <p className="section-label mb-2">Quick launch</p>
        <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-4">
          {QUICK_LAUNCH.map((q) => (
            <Link
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
            </Link>
          ))}
        </div>
      </section>

      <div className="mb-5">
        <KeysBar />
      </div>

      <BattleArena />

    </div>
  );
}
