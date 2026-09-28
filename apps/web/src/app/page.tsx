import Link from "next/link";
import { AuthForm } from "@/components/AuthForm";
import { BuildProject } from "@/components/BuildProject";
import { currentUser } from "@/lib/auth";

export default async function Home() {
  const user = await currentUser();
  return <main className="shell"><nav className="nav"><Link href="/" className="brand"><i>Waveyard</i><small>open stem studio</small></Link><div className="navlinks"><Link href="#how">How it works</Link><Link href="/discover">Discover</Link><Link href="/create">Create</Link>{user && <Link href="/create">{user.displayName}</Link>}</div></nav>
    <section className="hero build-hero"><div><span className="eyebrow">Give Waveyard music</span><h1>Build the first<br />good version.</h1><p>Local audio and authorized source links enter one private source pool. Waveyard separates, understands, and builds an initial listen before Studio asks for detail.</p>{!user && <p className="notice">Sign in below to start a private build.</p>}</div>
    <aside className="hero-card build-card">{user ? <BuildProject /> : <><h2>LOCAL AUDIO + AUTHORIZED LINKS</h2><div className="route">SOURCES → SEPARATE → UNDERSTAND → BUILD → PLAY</div><p style={{fontSize:13,color:"var(--muted)",lineHeight:1.5}}>Authorized links require a compliant resolver configured by this deployment. Waveyard never bypasses platform access controls.</p></>}</aside></section>
    <section id="how" className="steps"><article><b>01 / SOURCE</b><h3>Bring a track.</h3><p>Upload an audio file. The server probes its real codec, duration, sample rate, channels and checksum before it can enter the studio.</p></article><article><b>02 / STEMS</b><h3>Separate for real.</h3><p>A dedicated worker runs the configured Demucs model on CPU or CUDA, validates each emitted stem, and stores only actual output.</p></article><article><b>03 / SESSION</b><h3>Listen with intent.</h3><p>Open the project workspace and audition synchronized stems from private storage. Remix and publication layers follow this truthful foundation.</p></article></section>
    {!user && <section style={{maxWidth:520,paddingTop:26}}><AuthForm /></section>}
  </main>;
}
