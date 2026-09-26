"use client";

import { FormEvent, useCallback, useEffect, useMemo, useState } from "react";

type Publication = {
  visibility: "private" | "unlisted" | "public";
  publicationStatus: string;
  moderationStatus: string;
  publishedExportAssetId: string | null;
  licenseCode: string;
  downloadPermission: "owner-only" | "public";
  rightsAcknowledgementVersion: string;
  rightsAcknowledgementStatement: string;
  tags: string[];
};
type ExportCandidate = {
  id: string;
  filename: string;
  durationSeconds: number;
  format: string;
  sampleRate: number;
  channels: number;
};

export function PublicationPanel({ projectId, editable }: { projectId: string; editable: boolean }) {
  const [publication, setPublication] = useState<Publication | null>(null);
  const [exports, setExports] = useState<ExportCandidate[]>([]);
  const [visibility, setVisibility] = useState<Publication["visibility"]>("private");
  const [assetId, setAssetId] = useState("");
  const [downloadPermission, setDownloadPermission] = useState<"owner-only" | "public">("owner-only");
  const [acknowledged, setAcknowledged] = useState(false);
  const [tags, setTags] = useState("");
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const publicLink = useMemo(
    () => (typeof window === "undefined" ? "" : `${window.location.origin}/p/${projectId}`),
    [projectId],
  );
  const load = useCallback(async () => {
    const response = await fetch(`/api/projects/${projectId}/publication`, { cache: "no-store" });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) return setMessage(body.error ?? "Publication settings could not be loaded.");
    setPublication(body.publication);
    setExports(body.exports ?? []);
    setVisibility(body.publication.visibility);
    setAssetId(body.publication.publishedExportAssetId ?? "");
    setDownloadPermission(body.publication.downloadPermission);
    setTags((body.publication.tags ?? []).join(", "));
  }, [projectId]);
  useEffect(() => { const timer = window.setTimeout(() => { void load(); }, 0); return () => window.clearTimeout(timer); }, [load]);

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true); setMessage(null);
    const response = await fetch(`/api/projects/${projectId}/publication`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        visibility,
        publishedExportAssetId: visibility === "private" ? null : assetId || null,
        rightsAcknowledged: visibility === "private" ? undefined : acknowledged,
        downloadPermission,
        tags: tags.split(",").map((tag) => tag.trim()).filter(Boolean),
      }),
    });
    const body = await response.json().catch(() => ({}));
    setBusy(false);
    if (!response.ok) return setMessage(body.error ?? "Publication settings could not be saved.");
    setPublication(body.publication);
    setExports(body.exports ?? []);
    setAcknowledged(false);
    setMessage(visibility === "private" ? "Project returned to the private workshop." : "Publication settings saved.");
  }

  if (!publication) return <section className="publication-panel"><p className="notice">Loading publication settings…</p>{message && <p className="error">{message}</p>}</section>;
  return <section className="publication-panel" aria-label="Publication settings">
    <div className="panel-title"><div><span className="eyebrow">Publication</span><h2>Release this project deliberately.</h2></div><span className={`publication-state ${publication.moderationStatus}`}>{publication.visibility} · {publication.publicationStatus} · {publication.moderationStatus}</span></div>
    <p className="notice">Source files, stems, remix snapshots, and every non-selected export remain private. A public project exposes only its selected final render through Waveyard.</p>
    {!editable ? <p className="notice">You can inspect publication state, but only project editors and owners can change it.</p> : <form className="publication-form" onSubmit={save}>
      <label>Visibility<select value={visibility} onChange={(event) => setVisibility(event.target.value as Publication["visibility"])}><option value="private">Private — workshop only</option><option value="unlisted">Unlisted — anyone with the direct link</option><option value="public">Public — included in discovery</option></select></label>
      <label>Final worker export<select value={assetId} onChange={(event) => setAssetId(event.target.value)} disabled={visibility === "private"}><option value="">Select a completed WAV export</option>{exports.map((asset) => <option value={asset.id} key={asset.id}>{asset.filename} · {Math.round(asset.durationSeconds)}s · {asset.sampleRate} Hz</option>)}</select></label>
      <label>License <output>{publication.licenseCode}</output></label>
      <label>Tags<input value={tags} onChange={(event) => setTags(event.target.value)} maxLength={600} placeholder="ambient, remix, live" /></label>
      <label>Public download<select value={downloadPermission} onChange={(event) => setDownloadPermission(event.target.value as "owner-only" | "public")} disabled={visibility === "private"}><option value="owner-only">Player only</option><option value="public">Allow WAV download</option></select></label>
      {visibility !== "private" && <label className="acknowledgement"><input type="checkbox" checked={acknowledged} onChange={(event) => setAcknowledged(event.target.checked)} /> {publication.rightsAcknowledgementStatement}</label>}
      <div className="publication-actions"><button className="button" disabled={busy}>{busy ? "Saving…" : visibility === "private" ? "Keep private" : "Publish project"}</button>{publication.publicationStatus === "published" && <button className="button secondary" type="button" onClick={() => void navigator.clipboard.writeText(publicLink).then(() => setMessage("Public link copied."))}>Copy public link</button>}</div>
    </form>}
    {message && <p className={message.includes("could") || message.includes("required") ? "error" : "notice"} role="status">{message}</p>}
  </section>;
}
