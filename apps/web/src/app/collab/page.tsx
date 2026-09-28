import CollabLab from "@/components/CollabLab";
import KeysBar from "@/components/KeysBar";

export const dynamic = "force-dynamic";

export default function CollabPage() {
  return (
    <div>
      <section className="mb-6 text-center">
        <p className="inline-flex items-center gap-2 rounded-full border border-emerald-400/30 bg-emerald-400/10 px-4 py-1.5 text-xs font-bold text-emerald-200">
          🤝 Multi-collaboration challenges — your external cognitive OS
        </p>
        <h1 className="mx-auto mt-4 max-w-3xl text-3xl font-black leading-[1.05] tracking-tight text-white sm:text-4xl">
          Don&apos;t pick a winner.{" "}
          <span className="bg-gradient-to-r from-emerald-300 via-cyan-300 to-violet-300 bg-clip-text text-transparent">
            Build the best result.
          </span>
        </h1>
        <p className="mx-auto mt-3 max-w-2xl text-[15px] leading-relaxed text-slate-300">
          Throw messy material at a <strong className="text-white">council of minds</strong> — workshop, second
          brain, debate, systems, scenarios, signal-finding. They draft in parallel, critique each other, and a
          synthesizer merges everything into one best answer. Then you iterate until it clicks.
        </p>
      </section>
      <div className="mb-5">
        <KeysBar />
      </div>
      <CollabLab />
    </div>
  );
}
