import CouncilLab from "@/components/CouncilLab";
import KeysBar from "@/components/KeysBar";

export const dynamic = "force-dynamic";

export default function CouncilPage() {
  return (
    <div>
      <section className="mb-6 text-center">
        <p className="inline-flex items-center gap-2 rounded-full border border-cyan-400/30 bg-cyan-400/10 px-4 py-1.5 text-xs font-bold text-cyan-200">
          🧠 Cognitive Council — what job is your mind doing?
        </p>
        <h1 className="mx-auto mt-4 max-w-3xl text-3xl font-black leading-[1.05] tracking-tight text-white sm:text-4xl">
          Don&apos;t ask which AI won.{" "}
          <span className="bg-gradient-to-r from-cyan-300 via-violet-300 to-fuchsia-300 bg-clip-text text-transparent">
            Ask what you&apos;re thinking for.
          </span>
        </h1>
        <p className="mx-auto mt-3 max-w-2xl text-[15px] leading-relaxed text-slate-300">
          Pick the cognitive job — workshop, second brain, pressure-test, research, systems, futures,
          or signal-finding. Two disagreeing minds read your raw material, cross-examine each other,
          and forge the result into an <strong className="text-white">artifact you can actually use</strong>.
        </p>
      </section>
      <div className="mb-5">
        <KeysBar />
      </div>
      <CouncilLab />
    </div>
  );
}
