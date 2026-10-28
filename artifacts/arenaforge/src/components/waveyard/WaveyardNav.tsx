import Link from "@/routing/Link";

/**
 * The Waveyard core loop: Music → Sessions → saved Studio arrangements.
 * New project creation stays a separate action inside Studio.
 */
export default function WaveyardNav() {
  return (
    <nav className="nav" aria-label="Waveyard">
      <Link href="/waveyard" className="brand"><i>Waveyard</i><small>stem-aware music</small></Link>
      <div className="navlinks">
        <Link href="/waveyard">Music</Link>
        <Link href="/waveyard/sessions">Sessions</Link>
        <Link href="/waveyard/studio">Studio</Link>
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
