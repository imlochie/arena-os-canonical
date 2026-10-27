import { useEffect } from "react";
import { MusicHome } from "@/components/waveyard/library/MusicHome";
import { useListeningHost } from "@/components/waveyard/listening/ListeningHost";

export const metadata = { title: "Session · Waveyard" };

/** Legacy deep link: opens this session in the persistent host, library alongside. */
export default function SessionPage({ params }: { params: { id: string } }) {
  const { id } = params;
  const { openSession } = useListeningHost();
  useEffect(() => {
    openSession(id);
  }, [id, openSession]);
  return (
    <main className="shell wy-under-host">
      <MusicHome />
    </main>
  );
}
