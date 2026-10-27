import WaveyardNav from "@/components/waveyard/WaveyardNav";
import SessionExperience from "@/components/waveyard/library/SessionExperience";

export const metadata = { title: "Session · Waveyard" };

/** The two-deck session experience for one listening session. */
export default async function SessionPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return (
    <main className="shell session-shell">
      <WaveyardNav />
      <SessionExperience sessionId={id} />
    </main>
  );
}
