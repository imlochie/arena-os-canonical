import WaveyardNav from "@/components/waveyard/WaveyardNav";
import { ProjectWorkspace } from "@/components/waveyard/ProjectWorkspace";

export const dynamic = "force-dynamic";

export default function ProjectPage({ params }: { params: { id: string } }) {
  const { id } = params;
  return (
    <main className="shell">
      <WaveyardNav />
      <section className="workspace">
        <ProjectWorkspace projectId={id} />
      </section>
    </main>
  );
}
