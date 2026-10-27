import WaveyardNav from "@/components/waveyard/WaveyardNav";

import { TrackPlayer } from "@/components/waveyard/library/TrackPlayer";

export const dynamic = "force-dynamic";

export default function PlayTrackPage({ params }: { params: { id: string } }) {
  const { id } = params;
  return (
    <main className="shell">
      <WaveyardNav />
      <TrackPlayer trackId={id} />
    </main>
  );
}
