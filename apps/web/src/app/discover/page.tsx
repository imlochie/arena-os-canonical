import Link from "next/link";
import { DiscoverCatalog } from "@/components/DiscoverCatalog";
export const dynamic = "force-dynamic";
export default function DiscoverPage() { return <main className="shell"><nav className="nav"><Link href="/" className="brand"><i>Waveyard</i><small>open stem studio</small></Link><div className="navlinks"><Link href="/create">Create</Link></div></nav><section><span className="eyebrow">Discovery</span><h1>Released from the workshop.</h1><p className="notice">A small catalogue of projects explicitly published by their creators. No rankings, feeds, or recommendations.</p><DiscoverCatalog /></section></main>; }
