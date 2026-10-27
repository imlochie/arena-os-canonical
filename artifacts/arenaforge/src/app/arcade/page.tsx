import ArcadeForge from "@/components/ArcadeForge";

export const dynamic = "force-dynamic";

export default function ArcadePage() {
  return (
    <div>
      <section className="mb-6 text-center">
        <p className="inline-flex items-center gap-2 rounded-full border border-emerald-400/30 bg-emerald-400/10 px-4 py-1.5 text-xs font-bold text-emerald-200">
          🎮 Arcade
        </p>
        <h1 className="mx-auto mt-4 max-w-3xl text-3xl font-black leading-[1.05] tracking-tight text-white sm:text-4xl">
          Games from ideas.{" "}
          <span className="bg-gradient-to-r from-emerald-300 via-cyan-300 to-violet-300 bg-clip-text text-transparent">
            Play. Remix. Repeat.
          </span>
        </h1>
        <p className="mx-auto mt-3 max-w-2xl text-[15px] leading-relaxed text-slate-300">
          Describe how it should play. Change the game by prompting again. Classic cores work offline; new mechanics need a connected game-writing model.
        </p>
      </section>
      <ArcadeForge />
    </div>
  );
}
