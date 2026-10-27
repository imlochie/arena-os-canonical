"use client";

import { useState } from "react";
import { MULTI_SOURCE_PLACEMENT_MODES, type MultiSourcePlacement, type MultiSourcePlacementMode } from "@/lib/waveyard/types";

function label(mode: MultiSourcePlacementMode) { return ({ overlay: "Overlay", "hard-cut": "Hard cut", "beat-handoff": "Beat handoff", "bar-handoff": "Bar handoff", crossfade: "Crossfade" })[mode]; }

export function MultiSourcePlacementPanel({ remixId, anchorClipId, stemAssetId, sourceSectionId, onApplied }: { remixId: string; anchorClipId: string | null; stemAssetId: string; sourceSectionId: string | null; onApplied: () => Promise<void> }) {
  const [proposal, setProposal] = useState<MultiSourcePlacement | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const request = async (mode: MultiSourcePlacementMode) => {
    if (!anchorClipId || !sourceSectionId) { setMessage("Select an arrangement clip and a verified source section first. Waveyard will only place material you chose."); return; }
    setBusy(true); setProposal(null); setMessage(null);
    const response = await fetch(`/api/remixes/${remixId}/placements`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ anchorClipId, stemAssetId, sourceSectionId, mode }) });
    const body = await response.json().catch(() => ({})); setBusy(false);
    if (!response.ok) { setMessage(body.error ?? "Could not propose this placement."); return; }
    setProposal(body.proposal);
  };
  const accept = async () => {
    if (!proposal || !anchorClipId || !sourceSectionId) return;
    setBusy(true); setMessage(null);
    const response = await fetch(`/api/remixes/${remixId}/placements`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ anchorClipId, stemAssetId, sourceSectionId, mode: proposal.mode, proposalId: proposal.id }) });
    const body = await response.json().catch(() => ({})); setBusy(false);
    if (!response.ok) { setMessage(body.error ?? "Could not add the selected source."); return; }
    await onApplied(); setProposal(null); setMessage("Added as an ordinary source clip. Your existing material remains in place.");
  };
  return <section className="multi-source-placement-panel" aria-label="Intentional overlay or transition">
    <div className="panel-title"><div><span className="eyebrow">Editing assistant</span><h3>Combine these cleanly</h3></div><span>{anchorClipId && sourceSectionId ? "Material selected" : "Choose material"}</span></div>
    <p>Waveyard will not choose sources or stack them automatically. Pick a clip, pick a source section, then choose the relationship you want.</p>
    <div className="placement-modes">{MULTI_SOURCE_PLACEMENT_MODES.map((mode) => <button key={mode} className="button secondary" disabled={busy} onClick={() => void request(mode)}>{label(mode)}</button>)}</div>
    {proposal && <article className={`placement-proposal ${proposal.state}`}><span className="eyebrow">{proposal.state}</span><b>{label(proposal.mode)}</b><p>{proposal.reasons.join(" · ")}</p><dl><dt>Tempo</dt><dd>{proposal.tempoSyncEnabled ? `${proposal.tempoRatio.toFixed(4)}×` : "Native"}</dd><dt>Key</dt><dd>{proposal.keyShiftSemitones === null ? "Unavailable" : proposal.keySyncEnabled ? `${proposal.keyShiftSemitones >= 0 ? "+" : ""}${proposal.keyShiftSemitones} semitones` : "Native"}</dd></dl><button className="button" disabled={busy || proposal.state === "experimental"} onClick={() => void accept()}>{busy ? "Adding…" : "Use this placement"}</button></article>}
    {message && <p className="notice" role="status">{message}</p>}
  </section>;
}
