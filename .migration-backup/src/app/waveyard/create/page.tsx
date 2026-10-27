import WaveyardNav from "@/components/waveyard/WaveyardNav";
import { BuildProject } from "@/components/waveyard/BuildProject";

export const metadata = { title: "Create · Waveyard" };

export default function CreatePage() {
  return (
    <main className="shell">
      <WaveyardNav />
      <section className="create">
        <div>
          <span className="eyebrow">Build a first listen</span>
          <h1>Drop audio or paste authorized links.</h1>
          <p className="notice">Both paths create normal private Source Assets, then enter the same separation and analysis pipeline. Only add material you are authorized to use.</p>
        </div>
        <BuildProject />
      </section>
    </main>
  );
}
