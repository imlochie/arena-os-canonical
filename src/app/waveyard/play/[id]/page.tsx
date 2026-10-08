import Link from "next/link";

import { TrackPlayer } from "@/components/waveyard/library/TrackPlayer";

export const dynamic = "force-dynamic";

export default async function PlayTrackPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return (
    <main className="shell">
      <nav className="nav">
        <Link href="/waveyard" className="brand"><i>Waveyard</i><small>stem-aware music</small></Link>
        <div className="navlinks">
          <Link href="/waveyard">Music</Link>
          <Link href="/waveyard/sessions">Sessions</Link>
          <Link href="/waveyard/discover">Discover</Link>
          <Link href="/waveyard/create">Studio · Create</Link>
        </div>
      </nav>
      <TrackPlayer trackId={id} />
    </main>
  );
}
