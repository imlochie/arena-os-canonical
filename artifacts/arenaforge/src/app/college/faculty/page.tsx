import FacultyCoordination from "@/components/college/FacultyCoordination";

export const metadata = {
  title: "Lochie Life College — Faculty attention",
  description:
    "How the faculty coordinates: attention policies, activation conditions, consultations, handoffs and the inspectable coordination trace.",
};

export const dynamic = "force-dynamic";

export default function FacultyAttentionPage() {
  return (
    <main className="mx-auto min-h-screen w-full max-w-6xl px-4 py-8">
      <nav className="mb-4 flex gap-3">
        <a href="/college" className="text-[12px] font-semibold text-slate-400 hover:text-white">
          ← Institutional State
        </a>
        <a
          href="/college/curriculum"
          className="text-[12px] font-semibold text-slate-400 hover:text-white"
        >
          Curriculum
        </a>
      </nav>
      <FacultyCoordination />
    </main>
  );
}
