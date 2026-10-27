import { MusicHome } from "@/components/waveyard/library/MusicHome";

export const metadata = { title: "Waveyard · Arena" };

/** Home: the persistent listening workspace (mounted in App) sits above the library. */
export default function WaveyardHome() {
  return (
    <main className="shell wy-under-host">
      <MusicHome />
    </main>
  );
}
