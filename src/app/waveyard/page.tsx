import WaveyardStudio from "@/components/WaveyardStudio";

export const metadata = { title: "Waveyard · Arena" };

export default function WaveyardPage() {
  return (
    <div className="mx-auto max-w-6xl px-4 py-8">
      <section className="rounded-3xl border border-cyan-400/20 bg-gradient-to-br from-[#061a22] via-[#0a0f1e] to-[#0c0714] p-6 shadow-[0_24px_80px_rgba(34,211,238,0.08)] sm:p-8">
        <p className="text-xs font-bold uppercase tracking-[0.24em] text-cyan-300">Arena room · Music</p>
        <h1 className="mt-3 text-4xl font-black tracking-tight text-white sm:text-5xl">Waveyard</h1>
        <p className="mt-3 max-w-2xl text-sm leading-6 text-slate-300">
          A real music workspace: upload audio (decoded and peak-analyzed in your browser), arrange clips
          across tracks, play back through Web Audio, and persist arrangement versions. Stem separation and
          automated analysis need the Waveyard worker — honestly unavailable until one is connected.
        </p>
      </section>
      <div className="mt-6">
        <WaveyardStudio />
      </div>
    </div>
  );
}
