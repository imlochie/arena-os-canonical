import type { Metadata } from "next";
import { PublicProject } from "@/components/waveyard/PublicProject";

export const dynamic = "force-dynamic";

export async function generateMetadata({ params }: { params: Promise<{ id: string }> }): Promise<Metadata> {
  const { id } = await params;
  return { title: `Release ${id.slice(0, 8)} — Waveyard` };
}

export default async function PublicProjectPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <PublicProject projectId={id} />;
}
