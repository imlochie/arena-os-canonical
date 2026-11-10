"use client";

import type { AutomaticRemixCompatibilityReport, AutomaticRemixVariant } from "@workspace/arena/lib/waveyard/types";
import { AutomaticRemixEvidence } from "./AutomaticRemixEvidence";

export function AutomaticRemixPrompt({ building, message, compatibility, onBuild }: {
  building: AutomaticRemixVariant | null;
  message: string | null;
  compatibility?: AutomaticRemixCompatibilityReport | null;
  onBuild: (variant: AutomaticRemixVariant) => void;
}) {
  return <section className="automatic-remix-prompt" aria-label="Automatic remix">
    <div><span className="eyebrow">Automatic starting point</span><h3>Let Waveyard build the first listen.</h3><p>Hybrid suggestions compare rhythm, chroma, beat phase, phrase length, and trusted tempo separately. Missing vocal, instrument, or downbeat evidence is shown; every result is an editable audition candidate, not a quality guarantee.</p></div>
    <div className="automatic-remix-actions"><button className="button" disabled={building !== null} onClick={() => onBuild("original")}>{building === "original" ? "Building original…" : "Build original"}</button><button className="button secondary" disabled={building !== null} onClick={() => onBuild("hybrid")}>{building === "hybrid" ? "Building hybrid…" : "Try hybrid"}</button></div>
    {message && <p className="automatic-remix-message" role="status">{message}</p>}
    <AutomaticRemixEvidence report={compatibility} />
  </section>;
}
