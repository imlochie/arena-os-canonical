import WaveyardNav from "@/components/waveyard/WaveyardNav";
import SessionExperience from "@/components/waveyard/library/SessionExperience";

export const metadata = { title: "Session · Waveyard" };

/** The two-deck session experience for one listening session. */
export default function SessionPage({ params }: { params: { id: string } }) {
  const { id } = params;
  return (
    <main className="shell session-shell">
      <WaveyardNav />
      <SessionExperience sessionId={id} />
    </main>
  );
}
