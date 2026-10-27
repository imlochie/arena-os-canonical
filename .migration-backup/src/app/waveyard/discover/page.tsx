import WaveyardNav from "@/components/waveyard/WaveyardNav";
import { DiscoverCatalog } from "@/components/waveyard/DiscoverCatalog";

export const dynamic = "force-dynamic";
export const metadata = { title: "Discover · Waveyard" };

export default function DiscoverPage() {
  return (
    <main className="shell">
      <WaveyardNav />
      <section>
        <span className="eyebrow">Discovery</span>
        <h1>Released from the workshop.</h1>
        <p className="notice">A small catalogue of projects explicitly published by their creators. No rankings, feeds, or recommendations.</p>
      </section>
      <DiscoverCatalog />
    </main>
  );
}
