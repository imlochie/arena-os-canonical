import CurriculumManager from "@/components/college/Curriculum";

export const metadata = {
  title: "Lochie Life College — Curriculum",
  description:
    "The living curriculum: what the College currently teaches, what it merely knows about, and how that has changed over time.",
};

export const dynamic = "force-dynamic";

export default function CurriculumPage() {
  return (
    <main className="mx-auto min-h-screen w-full max-w-6xl px-4 py-8">
      <nav className="mb-4">
        <a
          href="/college"
          className="text-[12px] font-semibold text-slate-400 hover:text-white"
        >
          ← Institutional State
        </a>
      </nav>
      <CurriculumManager />
    </main>
  );
}
