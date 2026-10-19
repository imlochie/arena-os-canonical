"use client";
import { useState } from "react";
type Artifact = { id: string; title: string; body: string; revision: number; deletedAt?: string | null; currentRevisionId?: string | null };
type Revision = { id: string; revision: number; snapshot: { title: string; body: string; deletedAt: string | null; sourceType: string; sourceId: string | null }; restoredFromRevisionId: string | null };
export function ArtifactHistory({ artifact, onChange }: { artifact: Artifact; onChange: () => Promise<void> }) {
  const [revisions, setRevisions] = useState<Revision[] | null>(null);
  const [nextBefore, setNextBefore] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState(false);
  const [title, setTitle] = useState(artifact.title), [body, setBody] = useState(artifact.body), [base, setBase] = useState(artifact.revision);
  async function history(before?: number) {
    try { setError(null); const response = await fetch(`/api/artifacts/${artifact.id}/history${before ? `?before=${before}` : ""}`); const data = await response.json(); if (!response.ok) throw new Error(data.error); setRevisions((previous) => before ? [...(previous ?? []), ...data.revisions] : data.revisions); setNextBefore(data.nextBefore ?? null); if (!artifact.currentRevisionId) await onChange(); }
    catch (failure) { setError(failure instanceof Error ? failure.message : "History unavailable. Retry."); }
  }
  async function change(revisionId?: string) {
    setBusy(true); setError(null);
    try {
      const response = await fetch(`/api/artifacts/${artifact.id}${revisionId ? "/history" : ""}`, { method: revisionId ? "POST" : "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(revisionId ? { revisionId, expectedRevision: artifact.revision } : { title, body, expectedRevision: base }) });
      const data = await response.json(); if (!response.ok) throw new Error(data.error ?? "Save unavailable. Reload before retrying.");
      setEditing(false); await onChange(); await history();
    } catch (failure) { setError(failure instanceof Error ? failure.message : "Change unavailable. Your edit is retained here."); }
    finally { setBusy(false); }
  }
  return <section aria-label={`History of ${artifact.title}`} className="mt-3 space-y-2">
    <span>Current revision {artifact.revision ?? "legacy"}{artifact.deletedAt ? " · deleted, recoverable" : ""}</span>{" "}
    {!artifact.deletedAt && <button type="button" onClick={() => { setTitle(artifact.title); setBody(artifact.body); setBase(artifact.revision); setEditing(true); }}>Edit artifact</button>}{" "}
    <button type="button" onClick={() => void history()}>Load revision history</button>
    {editing && <div><label>Artifact title<input aria-label="Artifact title" value={title} onChange={(event) => setTitle(event.target.value)} /></label><label>Artifact content<textarea aria-label="Artifact content" value={body} onChange={(event) => setBody(event.target.value)} className="block w-full min-h-40 bg-black/30" /></label><button type="button" disabled={busy} onClick={() => void change()}>Save revision</button><button type="button" onClick={() => setEditing(false)}>Cancel edit</button></div>}
    {error && <div role="alert">{error}<button type="button" onClick={() => void onChange()}>Reload current state (keep draft)</button></div>}
    {revisions?.map((revision) => <details key={revision.id}><summary>Revision {revision.revision} · {revision.snapshot.title}{revision.snapshot.deletedAt ? " · deletion" : ""}{revision.restoredFromRevisionId ? " · restored" : ""}</summary><pre className="max-h-64 overflow-auto whitespace-pre-wrap">{revision.snapshot.body}</pre><small>Source: {revision.snapshot.sourceType} {revision.snapshot.sourceId ?? ""} · immutable {revision.id}</small><div><a href={`/api/artifacts/${artifact.id}?revision=${revision.id}&download=1`}>Download revision {revision.revision}</a>{" "}<button type="button" disabled={busy} onClick={() => void change(revision.id)}>Restore revision {revision.revision}</button></div></details>)}
    {nextBefore && <button type="button" onClick={() => void history(nextBefore)}>Load older revisions</button>}
  </section>;
}
