import Link from "next/link";
import { ModeratorReview } from "@/components/ModeratorReview";
export const dynamic = "force-dynamic";
export default function ModerationPage() { return <main className="shell"><nav className="nav"><Link href="/waveyard" className="brand"><i>Waveyard</i><small>open stem studio</small></Link><div className="navlinks"><Link href="/waveyard/discover">Discover</Link></div></nav><ModeratorReview /></main>; }
