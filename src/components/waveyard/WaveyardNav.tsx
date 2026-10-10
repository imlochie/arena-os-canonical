import Link from "next/link";

/**
 * The ONE Waveyard navigation (P5 product cohesion).
 *
 * The loop leads (vision Decision 2, parked platform surface): Music →
 * Sessions → Studio are the default destinations. The parked platform pages
 * (Discover, Moderation) stay one click away in the secondary row — kept,
 * tested, out of the default navigation until the core loop is
 * stem.fm-grade. Studio pages keep their own content untouched.
 */
export default function WaveyardNav() {
  return (
    <nav className="nav" aria-label="Waveyard">
      <Link href="/waveyard" className="brand"><i>Waveyard</i><small>stem-aware music</small></Link>
      <div className="navlinks">
        <Link href="/waveyard">Music</Link>
        <Link href="/waveyard/sessions">Sessions</Link>
        <Link href="/waveyard/create">Studio</Link>
      </div>
      <div className="navlinks parked" aria-label="Parked platform surfaces">
        <Link href="/waveyard/discover" title="Parked platform surface — kept, out of the default navigation">Discover</Link>
        {/* The local owner holds the moderator role (local-context), so the
            review surface is theirs — parked, one click, not in the loop. */}
        <Link href="/waveyard/moderation" title="Review reports on public projects">Moderation</Link>
      </div>
    </nav>
  );
}
