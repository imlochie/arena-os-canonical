"use client";

import { useState } from "react";
import { ARRANGEMENT_EXTENSION_INTENTS, type ArrangementExtensionIntent, type ArrangementExtensionProposal } from "@waveyard/types";

function title(intent: ArrangementExtensionIntent) {
  return ({ "extend-intro": "Extend intro", "extend-outro": "Extend outro", "repeat-section": "Repeat section", "instrumental-break": "Add instrumental break" })[intent];
}

export function ExtendedArrangementPanel({ remixId, anchorClipId, onApplied }: { remixId: string; anchorClipId: string | null; onApplied: () => Promise<void> }) {
  const [proposal, setProposal] = useState<ArrangementExtensionProposal | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const request = async (intent: ArrangementExtensionIntent) => {
    if (!anchorClipId) { setMessage("Select an existing arrangement clip first. Waveyard will extend that intentional material, not invent a new arrangement."); return; }
    setBusy(true); setMessage(null); setProposal(null);
    const response = await fetch(`/api/remixes/${remixId}/extensions`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ anchorClipId, intent }) });
    const body = await response.json().catch(() => ({})); setBusy(false);
    if (!response.ok) { setMessage(body.error ?? "Could not propose this extension."); return; }
    setProposal(body.proposal); setMessage(null);
  };
  const accept = async () => {
    if (!proposal || !anchorClipId) return;
    setBusy(true); setMessage(null);
    const response = await fetch(`/api/remixes/${remixId}/extensions`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ anchorClipId, intent: proposal.intent, proposalId: proposal.id }) });
    const body = await response.json().catch(() => ({})); setBusy(false);
    if (!response.ok) { setMessage(body.error ?? "Could not add this extension."); return; }
    await onApplied(); setProposal(null); setMessage("Extension added as ordinary arrangement clips. The original anchor remains intact.");
  };
  return <section className="extended-arrangement-panel" aria-label="Extend this arrangement">
    <div className="panel-title"><div><span className="eyebrow">Editing assistant</span><h3>Extend this</h3></div><span>{anchorClipId ? "Anchor selected" : "Select a clip"}</span></div>
    <p>Choose an intentional extension. Waveyard keeps your current structure and handles only the placement and timing mechanics.</p>
    <div className="extension-intents">{ARRANGEMENT_EXTENSION_INTENTS.map((intent) => <button key={intent} className="button secondary" disabled={busy} onClick={() => void request(intent)}>{title(intent)}</button>)}</div>
    {proposal && <article className="extension-proposal"><span className="eyebrow">{title(proposal.intent)}</span><b>{proposal.barCount ? `${proposal.barCount} bars` : "Selected musical unit"}</b><p>{proposal.reasons.join(" · ")}</p><button className="button" disabled={busy} onClick={() => void accept()}>{busy ? "Adding…" : "Add extension"}</button></article>}
    {message && <p className="notice" role="status">{message}</p>}
  </section>;
}
