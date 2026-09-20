import Link from "next/link";

const SURFACES = [
  { emoji: "📷", title: "Camera", body: "Capture with LUMA cameras and looks. Choose the moment before you edit.", status: "iPhone app" },
  { emoji: "✦", title: "Edit", body: "Non-destructive recipes, adaptive looks, intensity, and manual refinement.", status: "LUMA engine" },
  { emoji: "▣", title: "Archive", body: "Keep originals, derivatives, recipes, and processing lineage distinct.", status: "Coming with Arena media" },
];

export const metadata = { title: "LUMA · Arena" };

export default function LumaPage() {
  return (
    <div className="mx-auto max-w-6xl">
      <section className="relative overflow-hidden rounded-3xl border border-amber-300/20 bg-gradient-to-br from-[#17120b] via-[#0d1020] to-[#081525] p-7 shadow-[0_24px_80px_rgba(245,184,67,0.12)] sm:p-10">
        <div className="pointer-events-none absolute -right-20 -top-24 h-72 w-72 rounded-full bg-amber-400/15 blur-3xl" />
        <p className="text-xs font-bold uppercase tracking-[0.24em] text-amber-300">Arena · Creative surface</p>
        <div className="mt-4 flex flex-col justify-between gap-8 md:flex-row md:items-end">
          <div className="max-w-2xl">
            <h1 className="text-5xl font-black tracking-tight text-white sm:text-6xl">LUMA<span className="text-amber-300">.</span></h1>
            <p className="mt-4 text-lg leading-relaxed text-slate-300">
              A local-first camera and image studio for the things you make, capture, and remember.
              LUMA owns the creative work. Arena provides the context when you choose to connect it.
            </p>
          </div>
          <div className="rounded-2xl border border-amber-300/20 bg-black/25 px-5 py-4 text-sm text-slate-300">
            <p className="font-bold text-amber-200">Independent by design</p>
            <p className="mt-1 max-w-xs">Capture and edit offline. No Arena account is required to use LUMA.</p>
          </div>
        </div>
        <div className="mt-8 flex flex-wrap gap-3 text-sm font-bold">
          <a href="/luma" className="rounded-xl bg-amber-300 px-4 py-2.5 text-black shadow-[0_8px_24px_rgba(245,184,67,0.2)]">LUMA workspace →</a>
          <Link href="/projects" className="rounded-xl border border-white/15 bg-white/5 px-4 py-2.5 text-white hover:bg-white/10">Browse Arena context</Link>
        </div>
      </section>

      <section className="mt-8 grid gap-4 md:grid-cols-3">
        {SURFACES.map((surface) => (
          <article key={surface.title} className="glass card-hover rounded-2xl p-5">
            <div className="flex items-start justify-between gap-3">
              <span className="grid h-11 w-11 place-items-center rounded-xl bg-amber-300/10 text-2xl ring-1 ring-amber-300/20">{surface.emoji}</span>
              <span className="rounded-full bg-white/5 px-2.5 py-1 text-[10px] font-bold uppercase tracking-wide text-slate-400">{surface.status}</span>
            </div>
            <h2 className="mt-5 text-xl font-extrabold text-white">{surface.title}</h2>
            <p className="mt-2 text-sm leading-relaxed text-slate-300">{surface.body}</p>
          </article>
        ))}
      </section>

      <section className="mt-8 rounded-2xl border border-white/10 bg-white/[0.03] p-6 sm:p-8">
        <p className="text-xs font-bold uppercase tracking-[0.2em] text-slate-500">The boundary</p>
        <div className="mt-4 grid gap-6 md:grid-cols-2">
          <div>
            <h2 className="text-lg font-extrabold text-white">LUMA owns the artifact</h2>
            <p className="mt-2 text-sm leading-relaxed text-slate-400">Capture, import, analysis, cameras, looks, recipes, editing, rendering, export, and processing lineage stay inside LUMA.</p>
          </div>
          <div>
            <h2 className="text-lg font-extrabold text-white">Arena owns the context</h2>
            <p className="mt-2 text-sm leading-relaxed text-slate-400">Identity, evidence, provenance, sessions, commitments, institutional metadata, and synchronization belong to Arena.</p>
          </div>
        </div>
        <p className="mt-6 border-t border-white/10 pt-5 text-sm font-semibold text-amber-100">Arena records what happened around a LUMA artifact. It does not decide what the artifact means.</p>
      </section>
    </div>
  );
}
