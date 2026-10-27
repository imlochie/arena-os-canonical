import { useEffect, useRef } from "react";
import { useLocation } from "react-router-dom";
import { MusicHome } from "@/components/waveyard/library/MusicHome";
import { useListeningHost } from "@/components/waveyard/listening/ListeningHost";

export const dynamic = "force-dynamic";

/** Legacy deep link: loads the track into the persistent listening session (no second player). */
export default function PlayTrackPage({ params }: { params: { id: string } }) {
  const { id } = params;
  const { sendTrack } = useListeningHost();
  const location = useLocation();
  const handled = useRef<string | null>(null);
  useEffect(() => {
    const key = `${id}:${location.key}`;
    if (handled.current === key) return;
    handled.current = key;
    const autoplay = new URLSearchParams(location.search).get("autoplay") === "1";
    void sendTrack(id, autoplay ? "play" : "load");
  }, [id, location.key, location.search, sendTrack]);
  return (
    <main className="shell wy-under-host">
      <MusicHome />
    </main>
  );
}
