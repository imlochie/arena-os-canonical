import Link from "next/link";
import SessionExperience from "@/components/waveyard/library/SessionExperience";

export const metadata = { title: "Session · Waveyard" };

/** The two-deck session experience for one listening session. */
export default async function SessionPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return (
    <main className="shell session-shell">
      <nav className="nav">
        <Link href="/waveyard" className="brand"><i>Waveyard</i><small>stem-aware music</small></Link>
        <div className="navlinks">
          <Link href="/waveyard">Music</Link>
          <Link href="/waveyard/sessions">Sessions</Link>
          <Link href="/waveyard/discover">Discover</Link>
          <Link href="/waveyard/create">Studio · Create</Link>
        </div>
      </nav>
      <SessionExperience sessionId={id} />
    </main>
  );
}
