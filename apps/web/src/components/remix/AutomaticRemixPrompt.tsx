"use client";

import type { AutomaticRemixVariant } from "@waveyard/types";

export function AutomaticRemixPrompt({ building, message, onBuild }: {
  building: AutomaticRemixVariant | null;
  message: string | null;
  onBuild: (variant: AutomaticRemixVariant) => void;
}) {
  return <section className="automatic-remix-prompt" aria-label="Automatic remix">
    <div><span className="eyebrow">Automatic starting point</span><h3>Let Waveyard build the first listen.</h3><p>It uses verified structure, tempo, key, and the real stems already in this project. The result remains an ordinary editable arrangement.</p></div>
    <div className="automatic-remix-actions"><button className="button" disabled={building !== null} onClick={() => onBuild("original")}>{building === "original" ? "Building original…" : "Build original"}</button><button className="button secondary" disabled={building !== null} onClick={() => onBuild("hybrid")}>{building === "hybrid" ? "Building hybrid…" : "Try hybrid"}</button></div>
    {message && <p className="automatic-remix-message" role="status">{message}</p>}
  </section>;
}
