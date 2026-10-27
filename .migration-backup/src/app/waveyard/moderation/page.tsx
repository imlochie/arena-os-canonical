import WaveyardNav from "@/components/waveyard/WaveyardNav";
import { ModeratorReview } from "@/components/waveyard/ModeratorReview";

export const dynamic = "force-dynamic";
export const metadata = { title: "Moderation · Waveyard" };

export default function ModerationPage() {
  return (
    <main className="shell">
      <WaveyardNav />
      <ModeratorReview />
    </main>
  );
}
