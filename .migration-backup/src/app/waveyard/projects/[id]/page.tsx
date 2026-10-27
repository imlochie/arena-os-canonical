import WaveyardNav from "@/components/waveyard/WaveyardNav";
import { ProjectWorkspace } from "@/components/waveyard/ProjectWorkspace";

export const dynamic = "force-dynamic";

export default async function ProjectPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return (
    <main className="shell">
      <WaveyardNav />
      <section className="workspace">
        <ProjectWorkspace projectId={id} />
      </section>
    </main>
  );
}
