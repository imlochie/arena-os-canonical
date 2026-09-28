import { redirect } from "next/navigation";

export default async function LegacyWaveyardReleaseRedirect({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  redirect(`/waveyard/p/${id}`);
}
