"use client";
import { useEffect, useState } from "react";
import { privacyFlags, usePrivacySettings } from "@/lib/privacyClient";
import { sandboxGameDocument } from "@/lib/games/sandbox";
type Package = { modification: { patch: string; modifiedSha256: string; spawnRule: string }; revision: string; license: { spdx: string }; verification: { runtime: string } };
type Result = { bundle: Package; preview: string; artifactId?: string; revisionId?: string; artifactDownloadUrl?: string; persistenceError?: string; runtime?: { status: string; scope: string; sourceSha256: string } };
type Saved = { id: string; title: string; currentRevisionId: string; sourceType: string };
export default function ArcadeSourceWorkshop() {
  const privacy = usePrivacySettings();
  const [count, setCount] = useState(3), [busy, setBusy] = useState(false), [error, setError] = useState("");
  const [result, setResult] = useState<Result | null>(null);
  const [rule, setRule] = useState("original"), [saved, setSaved] = useState<Saved[]>([]);
  const [attempts, setAttempts] = useState<{ error: string; draft: Result | null }[]>([]);
  const [previewOpen, setPreviewOpen] = useState(false);
  async function refreshSaved() {
    try {
      const response = await fetch("/api/artifacts?kind=source-patch&limit=100");
      const body = await response.json();
      if (!response.ok) throw new Error("Saved games unavailable; retained revisions were not removed.");
      setSaved(body.artifacts.filter((item: Saved) => item.sourceType === "arcade-source"));
    } catch (e) { setError(e instanceof Error ? e.message : "Saved games unavailable."); }
  }
  useEffect(() => { void refreshSaved(); }, []);
  async function acquire() {
    setBusy(true); setError(""); setPreviewOpen(false);
    try {
      const response = await fetch("/api/arcade/source", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ adapter: "2048", initialTiles: count, spawnRule: rule, generateOnly: rule === "guaranteed-four", ...privacyFlags() }) });
      const body = await response.json(); if (!response.ok) throw new Error(body.error);
      setResult(body);
      await refreshSaved();
    } catch (e) { const message = e instanceof Error ? e.message : "Source acquisition failed."; setError(message); setAttempts(a => [...a, { error: message, draft: result }]); }
    finally { setBusy(false); }
  }
  async function saveOrReopen(item?: Saved) {
    setBusy(true); setError("");
    try {
      const response = await fetch("/api/arcade/source", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(item ? { action: "reopen", artifactId: item.id, revisionId: item.currentRevisionId } : { action: "save", bundle: result?.bundle, ...privacyFlags() }) });
      const body = await response.json(); if (!response.ok) throw new Error(`${body.error} ${body.runtime?.issues?.join("; ") ?? ""}`);
      setResult(body); setPreviewOpen(true); await refreshSaved();
    } catch (e) {
      const message = e instanceof Error ? e.message : "Save/reopen failed.";
      setError(message); setAttempts(a => [...a, { error: message, draft: result }]);
    } finally { setBusy(false); }
  }
  function download(content: string, name: string, type: string) {
    const url = URL.createObjectURL(new Blob([content], { type })), a = document.createElement("a");
    a.href = url; a.download = name; a.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  return <details className="glass mb-4 rounded-2xl p-4">
    <summary className="cursor-pointer font-bold">Source workshop · supported MIT 2048 adapter</summary>
    <p className="mt-2 text-xs text-slate-400">Acquire four pinned files from Gabriele Cirulli’s official repository. Modify initial tiles or the actual spawning rule, verify in Chromium, then save/reopen an immutable game. Board progress is memory-only; no catalogue publication or arbitrary patches.</p>
    <label className="mt-2 block text-sm">Initial tiles <input aria-label="Initial tiles" className="ml-2 w-16 rounded bg-slate-800 p-1" type="number" min={2} max={8} value={count} onChange={e => setCount(Number(e.target.value))} /></label>
    <label className="mt-2 block text-sm">Spawning rule <select aria-label="Spawning rule" value={rule} onChange={e => setRule(e.target.value)} className="ml-2 rounded bg-slate-800 p-1"><option value="original">Original: 90% two / 10% four</option><option value="guaranteed-four">Guaranteed four-tile spawning</option></select></label>
    <button className="mt-2 rounded bg-cyan-900 px-3 py-2 text-sm" disabled={busy || privacy.localMode || !privacy.online} onClick={acquire}>{busy ? "Acquiring and checking…" : "Acquire source and create patch"}</button>
    {(privacy.localMode || !privacy.online) && <p className="text-xs text-amber-200">Source acquisition needs public network access; disabled in Local Mode/offline.</p>}
    {error && <p role="alert" className="mt-2 text-sm text-red-300">{error}</p>}
    <section aria-label="Saved source games" className="mt-3 text-xs">
      <h3>Saved source games · immutable revisions</h3>
      <button disabled={busy} onClick={refreshSaved}>Refresh saved games</button>
      {saved.map(item => <p key={item.id}>{item.title} <button disabled={busy} onClick={() => saveOrReopen(item)}>Reopen {item.id}</button> <span className="break-all">Revision {item.currentRevisionId}</span></p>)}
      {!saved.length && <p>No saved source games loaded.</p>}
    </section>
    {result && <div className="mt-3 text-xs">
      <p>{result.artifactId ? `Saved Artifact ${result.artifactId}` : result.persistenceError ?? (privacy.ephemeral ? "Ephemeral package—not saved." : "Generated package—not saved.")}</p>
      <p>{result.artifactId ? result.runtime?.status === "passed" ? "Saved + browser-verified selected rule. Human review pending." : "Saved source only; browser execution not verified." : "Generated but not saved; browser execution unverified."}</p>
      <p>Selected spawning rule: {result.bundle.modification.spawnRule}. Board progress is not persisted.</p>
      <p className="break-all">MIT · {result.bundle.revision} · modified SHA-256 {result.bundle.modification.modifiedSha256}</p>
      <p className="mt-1 text-amber-200">{result.runtime?.status === "passed" ? `This source passed: ${result.runtime.scope}` : result.bundle.verification.runtime}</p>
      <pre className="my-2 overflow-auto rounded bg-black/30 p-2">{result.bundle.modification.patch}</pre>
      <div className="flex flex-wrap gap-3">
        {result.artifactDownloadUrl && <a className="underline" href={result.artifactDownloadUrl}>Download saved immutable Artifact revision</a>}
        <button onClick={() => download(JSON.stringify(result.bundle, null, 2), "2048-source-package.json", "application/json")}>Download source/evidence package</button>
        <button onClick={() => download(result.bundle.modification.patch, "2048-initial-tiles.patch", "text/plain")}>Download patch</button>
        <button onClick={() => download(result.preview, "2048-arena-preview.html", "text/html")}>Download offline preview (not runtime-verified)</button>
        <button onClick={() => setPreviewOpen(value => !value)}>{previewOpen ? "Close source preview" : "Play source preview (unverified)"}</button>
        <button disabled={busy || !privacy.online || privacy.ephemeral} onClick={() => saveOrReopen()}>{busy ? "Checking…" : "Verify rule and save immutable game"}</button>
      </div>
      {previewOpen && <iframe title="2048 source preview" className="mt-3 h-[650px] w-full bg-black" sandbox="allow-scripts" referrerPolicy="no-referrer" srcDoc={sandboxGameDocument(result.preview)} />}
    </div>}
    {attempts.length > 0 && <details className="mt-3 text-xs"><summary>Failed attempts retained for inspection ({attempts.length})</summary>{attempts.map((attempt, i) => <p key={i}>{attempt.error} <button onClick={() => download(JSON.stringify(attempt, null, 2), `2048-failed-attempt-${i + 1}.json`, "application/json")}>Download failed attempt {i + 1}</button></p>)}<p>Attempts are retained in this page until reload; download before leaving. Saved immutable games are unchanged.</p></details>}
  </details>;
}
