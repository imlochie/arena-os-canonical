import { createRoot } from "react-dom/client";
import WaveyardLocalRemote from "@/components/waveyard/library/WaveyardLocalRemote";
import "@/components/waveyard/library/waveyard-remote.css";

createRoot(document.getElementById("root")!).render(<WaveyardLocalRemote />);
