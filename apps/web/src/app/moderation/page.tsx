import Link from "next/link";
import { ModeratorReview } from "@/components/ModeratorReview";
export const dynamic = "force-dynamic";
export default function ModerationPage() { return <main className="shell"><nav className="nav"><Link href="/" className="brand"><i>Waveyard</i><small>open stem studio</small></Link><div className="navlinks"><Link href="/discover">Discover</Link></div></nav><ModeratorReview /></main>; }
