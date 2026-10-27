import WaveyardNav from "@/components/waveyard/WaveyardNav";

import { MusicHome } from "@/components/waveyard/library/MusicHome";

export const metadata = { title: "Waveyard · Arena" };

export default function WaveyardHome() {
  // Single-owner local app: the original's sign-in gate is intentionally gone.
  // The home surface is the MUSIC PLATFORM (library, search, playlists, queue,
  // recently played); the studio keeps its own explicit entries (/create and
  // the Studio section below) and is untouched.
  return (
    <main className="shell">
      <WaveyardNav />
      <MusicHome />
    </main>
  );
}
