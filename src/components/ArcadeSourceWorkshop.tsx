"use client";
import { useState } from "react";
import { privacyFlags, usePrivacySettings } from "@/lib/privacyClient";
import { sandboxGameDocument } from "@/lib/games/sandbox";
type Package = { modification: { patch: string; modifiedSha256: string }; revision: string; license: { spdx: string }; verification: { runtime: string } };
export default function ArcadeSourceWorkshop() {
  const privacy = usePrivacySettings();
  const [count, setCount] = useState(3), [busy, setBusy] = useState(false), [error, setError] = useState("");
  const [result, setResult] = useState<{ bundle: Package; preview: string; artifactId?: string; artifactDownloadUrl?: string; persistenceError?: string } | null>(null);
  const [previewOpen, setPreviewOpen] = useState(false);
  async function acquire() {
    setBusy(true); setError(""); setPreviewOpen(false);
    try {
      const response = await fetch("/api/arcade/source", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ adapter: "2048", initialTiles: count, ...privacyFlags() }) });
      const body = await response.json(); if (!response.ok) throw new Error(body.error);
      setResult(body);
    } catch (e) { setError(e instanceof Error ? e.message : "Source acquisition failed."); }
    finally { setBusy(false); }
  }
  function download(content: string, name: string, type: string) {
    const url = URL.createObjectURL(new Blob([content], { type })), a = document.createElement("a");
    a.href = url; a.download = name; a.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  return <details className="glass mb-4 rounded-2xl p-4">
    <summary className="cursor-pointer font-bold">Source workshop · supported MIT 2048 adapter</summary>
    <p className="mt-2 text-xs text-slate-400">Acquire four pinned files from Gabriele Cirulli’s official repository, inspect architecture and license, and generate a real initial-tile patch. No arbitrary source execution or mod catalogue.</p>
    <label className="mt-2 block text-sm">Initial tiles <input aria-label="Initial tiles" className="ml-2 w-16 rounded bg-slate-800 p-1" type="number" min={2} max={8} value={count} onChange={e => setCount(Number(e.target.value))} /></label>
    <button className="mt-2 rounded bg-cyan-900 px-3 py-2 text-sm" disabled={busy || privacy.localMode || !privacy.online} onClick={acquire}>{busy ? "Acquiring and checking…" : "Acquire source and create patch"}</button>
    {(privacy.localMode || !privacy.online) && <p className="text-xs text-amber-200">Source acquisition needs public network access; disabled in Local Mode/offline.</p>}
    {error && <p role="alert" className="mt-2 text-sm text-red-300">{error}</p>}
    {result && <div className="mt-3 text-xs">
      <p>{result.artifactId ? `Saved Artifact ${result.artifactId}` : result.persistenceError ?? "Ephemeral package—not saved."}</p>
      <p className="break-all">MIT · {result.bundle.revision} · modified SHA-256 {result.bundle.modification.modifiedSha256}</p>
      <p className="mt-1 text-amber-200">{result.bundle.verification.runtime}</p>
      <pre className="my-2 overflow-auto rounded bg-black/30 p-2">{result.bundle.modification.patch}</pre>
      <div className="flex flex-wrap gap-3">
        {result.artifactDownloadUrl && <a className="underline" href={result.artifactDownloadUrl}>Download saved immutable Artifact revision</a>}
        <button onClick={() => download(JSON.stringify(result.bundle, null, 2), "2048-source-package.json", "application/json")}>Download source/evidence package</button>
        <button onClick={() => download(result.bundle.modification.patch, "2048-initial-tiles.patch", "text/plain")}>Download patch</button>
        <button onClick={() => download(result.preview, "2048-arena-preview.html", "text/html")}>Download offline preview (not runtime-verified)</button>
        <button onClick={() => setPreviewOpen(value => !value)}>{previewOpen ? "Close source preview" : "Play source preview (unverified)"}</button>
      </div>
      {previewOpen && <iframe title="2048 source preview" className="mt-3 h-[650px] w-full bg-black" sandbox="allow-scripts" referrerPolicy="no-referrer" srcDoc={sandboxGameDocument(result.preview)} />}
    </div>}
  </details>;
}
