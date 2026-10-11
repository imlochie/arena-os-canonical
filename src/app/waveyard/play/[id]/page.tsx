import WaveyardNav from "@/components/waveyard/WaveyardNav";

import { TrackPlayer } from "@/components/waveyard/library/TrackPlayer";

export const dynamic = "force-dynamic";

export default async function PlayTrackPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return (
    <main className="shell">
      <WaveyardNav />
      <TrackPlayer trackId={id} />
    </main>
  );
}
