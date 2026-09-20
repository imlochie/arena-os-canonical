import Link from "next/link";
import { AuthForm } from "@/components/AuthForm";
import { currentUser } from "@/lib/auth";

export default async function Home() {
  const user = await currentUser();
  return <main className="shell"><nav className="nav"><Link href="/" className="brand"><i>Waveyard</i><small>open stem studio</small></Link><div className="navlinks"><Link href="#how">How it works</Link><Link href="/create">Create</Link>{user && <Link href="/create">{user.displayName}</Link>}</div></nav>
    <section className="hero"><div><span className="eyebrow">Source separation for people who make things</span><h1>Pull music<br />apart. Build it<br />back differently.</h1><p>Waveyard is a self-hostable studio for turning a source track into real, inspectable vocal, drum, bass, and other stems—then hearing what is possible.</p><div style={{display:"flex",gap:10,marginTop:26}}><Link className="button" href="/create">Upload a track</Link><a className="button secondary" href="#how">See the pipeline</a></div></div>
    <aside className="hero-card"><h2>First real slice</h2><div className="route">UPLOAD → QUEUE → DEMUCS → VALIDATE → STORE → PLAY</div><p style={{fontSize:13,color:"var(--muted)",lineHeight:1.5}}>No generated substitute audio. If the configured worker or model cannot run, Waveyard records the failure instead of pretending a separation completed.</p></aside></section>
    <section id="how" className="steps"><article><b>01 / SOURCE</b><h3>Bring a track.</h3><p>Upload an audio file. The server probes its real codec, duration, sample rate, channels and checksum before it can enter the studio.</p></article><article><b>02 / STEMS</b><h3>Separate for real.</h3><p>A dedicated worker runs the configured Demucs model on CPU or CUDA, validates each emitted stem, and stores only actual output.</p></article><article><b>03 / SESSION</b><h3>Listen with intent.</h3><p>Open the project workspace and audition synchronized stems from private storage. Remix and publication layers follow this truthful foundation.</p></article></section>
    {!user && <section style={{maxWidth:520,paddingTop:26}}><AuthForm /></section>}
  </main>;
}
