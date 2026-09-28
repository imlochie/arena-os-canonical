import type { Metadata } from "next";
import { PublicProject } from "@/components/PublicProject";
import { publicProjectResolution, safePublicProject } from "@/lib/publication";
export const dynamic = "force-dynamic";
export async function generateMetadata({ params }: { params: Promise<{ id: string }> }): Promise<Metadata> { try { const { id } = await params; const data = safePublicProject(await publicProjectResolution(id)); return { title: `${data.project.title} — Waveyard`, description: data.project.description || `A public Waveyard release by ${data.project.creatorDisplayName}.`, openGraph: { title: data.project.title, description: data.project.description || `A public Waveyard release by ${data.project.creatorDisplayName}.`, type: "music.song" }, twitter: { card: "summary", title: data.project.title, description: data.project.description || `A public Waveyard release by ${data.project.creatorDisplayName}.` } }; } catch { return { title: "Public release unavailable — Waveyard" }; } }
export default async function PublicProjectPage({ params }: { params: Promise<{ id: string }> }) { const { id } = await params; return <PublicProject projectId={id} />; }
