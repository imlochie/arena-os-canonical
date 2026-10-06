import Link from "next/link";
import { ProjectWorkspace } from "@/components/waveyard/ProjectWorkspace";

export const dynamic = "force-dynamic";

export default async function ProjectPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return (
    <main className="shell">
      <nav className="nav">
        <Link href="/waveyard" className="brand"><i>Waveyard</i><small>open stem studio</small></Link>
        <div className="navlinks"><Link href="/waveyard/discover">Discover</Link><Link href="/waveyard/create">New project</Link></div>
      </nav>
      <section className="workspace">
        <ProjectWorkspace projectId={id} />
      </section>
    </main>
  );
}
