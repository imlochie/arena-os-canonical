import LumaStudio from "@/components/LumaStudio";

export const metadata = { title: "LUMA · Arena" };

export default function LumaPage() {
  return (
    <div className="mx-auto max-w-7xl px-4 py-8">
      <section className="relative overflow-hidden rounded-3xl border border-amber-300/20 bg-gradient-to-br from-[#17120b] via-[#0d1020] to-[#081525] p-6 shadow-[0_24px_80px_rgba(245,184,67,0.12)] sm:p-8">
        <div className="pointer-events-none absolute -right-20 -top-24 h-72 w-72 rounded-full bg-amber-400/15 blur-3xl" />
        <div className="flex flex-col justify-between gap-4 md:flex-row md:items-end">
          <div className="max-w-2xl">
            <p className="text-xs font-bold uppercase tracking-[0.24em] text-amber-300">Arena room · Photography</p>
            <h1 className="mt-3 text-4xl font-black tracking-tight text-white sm:text-5xl">
              LUMA<span className="text-amber-300">.</span>
            </h1>
            <p className="mt-3 text-sm leading-6 text-slate-300">
              A local-first photography tool: capture or import <strong className="text-white">your own photos</strong>,
              apply non-destructive looks (cameras, presets, manual adjustments), and export real image files.
              The full LUMA color pipeline runs in this browser — nothing is uploaded anywhere.
            </p>
          </div>
          <div className="rounded-2xl border border-amber-300/20 bg-black/25 px-5 py-3 text-xs text-slate-300">
            <p className="font-bold text-amber-200">Photography, not generation</p>
            <p className="mt-1 max-w-xs">
              LUMA never generates images from text. Every photograph starts from your camera or your files —
              text-to-image is the separate Image surface.
            </p>
          </div>
        </div>
      </section>

      <div className="mt-6">
        <LumaStudio />
      </div>
    </div>
  );
}
