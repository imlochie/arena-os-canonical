import Link from "next/link";

/**
 * The ONE Waveyard navigation (P5 product cohesion).
 *
 * The product reads top-down: Music → Sessions → Discover → Studio. Every
 * Waveyard surface renders this same nav, so the Studio is always reachable
 * from the music platform and vice versa — one application, not a stack of
 * demos. Studio pages keep their own content untouched.
 */
export default function WaveyardNav() {
  return (
    <nav className="nav" aria-label="Waveyard">
      <Link href="/waveyard" className="brand"><i>Waveyard</i><small>stem-aware music</small></Link>
      <div className="navlinks">
        <Link href="/waveyard">Music</Link>
        <Link href="/waveyard/sessions">Sessions</Link>
        <Link href="/waveyard/discover">Discover</Link>
        <Link href="/waveyard/create">Studio</Link>
      </div>
    </nav>
  );
}
