import Link from "next/link";

export const metadata = { title: "Sessions · Waveyard" };

export default function SessionsPage() {
  // Honest capability reporting: sessions are the next increment of the
  // Waveyard evolution (docs/waveyard-evolution-plan.md, P3). This page
  // states that plainly instead of faking session features.
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
      <section className="session-preview" aria-label="Sessions">
        <span className="eyebrow">Coming next</span>
        <h1>Sessions</h1>
        <p>
          A session lines up several songs and lets you play them together — blend each track&rsquo;s stems live, swap a
          vocal or a drum part between songs, and move through them with real transitions. Sessions build on the beat
          grids, tempo and key analysis Waveyard already computes for your music.
        </p>
        <p>
          Sessions arrive right after the full-screen stem player in the Waveyard evolution. Nothing is hidden from
          you: they are simply not built yet.
        </p>
        <div className="player-actions">
          <Link className="button" href="/waveyard">Back to music</Link>
          <Link className="button secondary" href="/waveyard/create">Open the studio</Link>
        </div>
      </section>
    </main>
  );
}
