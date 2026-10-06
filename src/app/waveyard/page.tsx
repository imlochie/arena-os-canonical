import Link from "next/link";
import { BuildProject } from "@/components/waveyard/BuildProject";

export const metadata = { title: "Waveyard · Arena" };

export default function WaveyardHome() {
  // Single-owner local app: the original's sign-in gate is intentionally gone.
  return (
    <main className="shell">
      <nav className="nav">
        <Link href="/waveyard" className="brand"><i>Waveyard</i><small>open stem studio</small></Link>
        <div className="navlinks">
          <Link href="#how">How it works</Link>
          <Link href="/waveyard/discover">Discover</Link>
          <Link href="/waveyard/create">Create</Link>
        </div>
      </nav>
      <section className="hero build-hero">
        <div>
          <span className="eyebrow">Give Waveyard music</span>
          <h1>Build the first<br />good version.</h1>
          <p>Local audio and authorized source links enter one private source pool. Waveyard separates, understands, and builds an initial listen before Studio asks for detail.</p>
        </div>
        <aside className="hero-card build-card">
          <BuildProject />
        </aside>
      </section>
      <section id="how" className="steps">
        <article><b>01 / SOURCE</b><h3>Bring a track.</h3><p>Upload an audio file. The server probes its real codec, duration, sample rate, channels and checksum before it can enter the studio.</p></article>
        <article><b>02 / STEMS</b><h3>Separate for real.</h3><p>A dedicated worker runs the configured Demucs model on CPU or CUDA, validates each emitted stem, and stores only actual output. Without the worker, separation is reported as unavailable — never faked.</p></article>
        <article><b>03 / SESSION</b><h3>Listen with intent.</h3><p>Open the project workspace and audition synchronized stems from private storage. Remix and publication layers follow this truthful foundation.</p></article>
      </section>
    </main>
  );
}
