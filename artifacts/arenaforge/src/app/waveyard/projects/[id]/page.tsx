import WaveyardNav from "@/components/waveyard/WaveyardNav";
import { ProjectWorkspace } from "@/components/waveyard/ProjectWorkspace";

export const dynamic = "force-dynamic";

export default function ProjectPage({
  params,
  searchParams,
}: {
  params: { id: string };
  searchParams?: { view?: string };
}) {
  const { id } = params;
  return (
    <main className="shell">
      <WaveyardNav />
      <section className="workspace">
        <ProjectWorkspace projectId={id} initialView={searchParams?.view === "studio" ? "studio" : undefined} />
      </section>
    </main>
  );
}
