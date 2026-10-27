
import { PublicProject } from "@/components/waveyard/PublicProject";

export const dynamic = "force-dynamic";



export default function PublicProjectPage({ params }: { params: { id: string } }) {
  const { id } = params;
  return <PublicProject projectId={id} />;
}
