import Link from "next/link";
import { ProjectWorkspace } from "@/components/ProjectWorkspace";
export default async function ProjectPage({ params }: { params: Promise<{ id: string }> }) { const { id } = await params; return <main className="shell"><nav className="nav"><Link href="/" className="brand"><i>Waveyard</i><small>open stem studio</small></Link><div className="navlinks"><Link href="/discover">Discover</Link><Link href="/create">New project</Link></div></nav><section className="workspace"><ProjectWorkspace projectId={id} /></section></main>; }
