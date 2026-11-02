import { useEffect, useRef, useState } from "react";
import RepositoryAssessmentPanel from "./RepositoryAssessmentPanel";
import GameCatalogBrowser from "./GameCatalogBrowser";
import {
  acquireArcadeRepository, assessArcadeRepository, inspectArcadeRepository,
  type ArcadeRepositoryAssessment,
  type ArcadeRepositoryPreview, type ArcadeRepositoryProvenance,
} from "@workspace/api-client-react";

function canInspectRepository(value: string) {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && ["github.com", "codeberg.org"].includes(url.hostname) &&
      !url.port && !url.username && !url.password && !url.search && !url.hash;
  } catch { return false; }
}

function repositoryInspectionHint(value: string) {
  try {
    if (new URL(value).hostname === "sourceforge.net") {
      return "SourceForge metadata can be reviewed, but no package is acquired without a pinned source tree.";
    }
  } catch { /* the generic hint below explains invalid input */ }
  return "Enter a public GitHub or Codeberg HTTPS repository link.";
}

export default function RepositoryGameImport({ disabled, onImport, onBuildSource, onInstallRelease }: {
  disabled: boolean;
  onBuildSource?: (token: string) => Promise<void>;
  onInstallRelease?: (selection: string) => Promise<void>;
  onImport: (file: File, provenance: ArcadeRepositoryProvenance) => Promise<boolean | void>;
}) {
  const [url, setUrl] = useState("");
  const [preview, setPreview] = useState<ArcadeRepositoryPreview | null>(null);
  const [phase, setPhase] = useState<"assess" | "inspect" | "acquire" | null>(null);
  const [assessment, setAssessment] = useState<ArcadeRepositoryAssessment | null>(null);
  const [rightsConfirmed, setRightsConfirmed] = useState(false);
  const [error, setError] = useState("");
  const pending = useRef<AbortController | null>(null);
  useEffect(() => () => pending.current?.abort(), []);
  useEffect(() => {
    if (disabled) {
      pending.current?.abort();
      pending.current = null;
      setPhase(null);
    }
  }, [disabled]);
  const run = async (operation: "assess" | "inspect" | "acquire", target = url.trim()) => {
    if (disabled || phase) return;
    const controller = new AbortController();
    pending.current = controller;
    setPhase(operation);
    setError("");
    try {
      if (operation === "assess") {
        setPreview(null);
        setAssessment(null);
        const result = await assessArcadeRepository({ url: target, authorized: true }, { signal: controller.signal });
        if (!controller.signal.aborted) setAssessment(result);
      } else if (operation === "inspect") {
        setPreview(null);
        setRightsConfirmed(false);
        const result = await inspectArcadeRepository({ url: target, authorized: true }, { signal: controller.signal });
        if (!controller.signal.aborted) setPreview(result);
      } else if (preview) {
        const snapshot = await acquireArcadeRepository({ token: preview.token, authorized: true }, { signal: controller.signal });
        if (controller.signal.aborted) return;
        if (snapshot.provenance.revision !== preview.revision || snapshot.files.length !== preview.files.length ||
            snapshot.files.some(file => !preview.files.some(expected =>
              expected.path === file.path && expected.sha === file.sha && expected.size === file.size))) {
          throw new Error("The downloaded manifest differs from the reviewed snapshot. Inspect again.");
        }
        const JSZip = (await import("jszip")).default;
        const archive = new JSZip();
        for (const file of snapshot.files) archive.file(file.path, file.contentBase64, { base64: true });
        const bytes = await archive.generateAsync({ type: "uint8array", compression: "DEFLATE" });
        if (controller.signal.aborted) return;
        const name = `${preview.repository.split("/")[1]}-${preview.revision.slice(0, 8)}.zip`;
        const imported = await onImport(new File([new Uint8Array(bytes).buffer], name, { type: "application/zip" }), snapshot.provenance);
        if (imported) setPreview(null);
      }
    } catch (cause) {
      if (!controller.signal.aborted) {
        const apiError = cause as { data?: { error?: string }; message?: string };
        setError(apiError.data?.error || apiError.message || "Repository import failed. Your saved games are unchanged.");
      }
    } finally {
      if (!controller.signal.aborted) setPhase(null);
      if (pending.current === controller) pending.current = null;
    }
  };
  const cancel = () => {
    pending.current?.abort();
    pending.current = null;
    setPhase(null);
  };
  return <section className="rounded-xl border border-emerald-300/20 bg-emerald-300/5 p-4" aria-label="Import game from repository">
    <h3 className="text-sm font-extrabold text-emerald-100">Import open-source game</h3>
    <p className="mt-1 text-xs text-slate-400">GitHub and Codeberg source is pinned to a commit and checked against its license. SourceForge links show their release evidence, but stay blocked without a verified source revision, checksum, and license. Browser games: up to 64 files / 2 MB.</p>
    <GameCatalogBrowser disabled={disabled || phase !== null} onChooseRepository={chosen => {
      if (disabled || phase) return; setUrl(chosen); void run("assess", chosen); }} />
    <label className="mt-3 block text-xs text-slate-300" htmlFor="arcade-repository-url">Repository, project, or release-tag link</label>
    <input id="arcade-repository-url" data-testid="input-repository-url" value={url} type="url"
      placeholder="https://codeberg.org/owner/game" disabled={disabled || phase !== null}
      onChange={event => { setUrl(event.target.value); setPreview(null); setAssessment(null); setRightsConfirmed(false); setError(""); }}
      onKeyDown={event => { if (event.key === "Enter" && url.trim() && !disabled && !phase) { event.preventDefault(); void run("assess"); } }}
      className="mt-1 w-full rounded-lg border border-white/15 bg-black/30 px-3 py-2 text-sm text-slate-100 disabled:opacity-50" />
    <div className="mt-3 flex flex-wrap gap-2">
      <button type="button" data-testid="review-repository" disabled={disabled || phase !== null || !url.trim()}
        onClick={() => void run("assess")} className="rounded-lg bg-emerald-300 px-3 py-2 text-xs font-extrabold text-slate-950 disabled:opacity-50">
        {phase === "assess" ? "Reviewing…" : "Review project"}
      </button>
      <button type="button" data-testid="inspect-repository" title={!canInspectRepository(url.trim()) ? repositoryInspectionHint(url.trim()) : undefined}
        disabled={disabled || phase !== null || !canInspectRepository(url.trim())}
        onClick={() => void run("inspect")} className="rounded-lg border border-emerald-300/30 px-3 py-2 text-xs font-bold text-emerald-100 disabled:opacity-50">
        {phase === "inspect" ? "Inspecting…" : "Inspect repository"}
      </button>
      {phase && <button type="button" data-testid="cancel-repository" onClick={cancel} className="rounded-lg border border-white/20 px-3 py-2 text-xs text-slate-200">Cancel</button>}
    </div>
    {error && <p role="alert" data-testid="repository-error" className="mt-3 text-xs text-red-200">{error}</p>}
    {assessment && !preview && <RepositoryAssessmentPanel assessment={assessment} disabled={disabled} busy={phase !== null}
      onBuildSource={onBuildSource} onInstallRelease={onInstallRelease} onDismiss={() => setAssessment(null)}
      onInspectBrowser={() => void run("inspect", url.trim())}
      onReviewRelease={reviewUrl => { setUrl(reviewUrl); void run("assess", reviewUrl); }} />}
    {preview && <div data-testid="repository-preview" className="mt-4 space-y-2 text-xs text-slate-300">
      <p><strong>{preview.repository}</strong> · {preview.provider === "codeberg" ? "Codeberg" : "GitHub"} verified license: <strong>{preview.license.spdx}</strong></p>
      <p className="break-all">Pinned revision: <code>{preview.revision}</code></p>
      <p>Entry: {preview.entryPath} · {preview.files.length} included files · {(preview.totalBytes / 1024).toFixed(1)} KB</p>
      <details><summary className="cursor-pointer py-1" data-testid="repository-files">Included files</summary>
        <ul className="max-h-44 overflow-auto font-mono">{preview.files.map(file =>
          <li key={file.path}>{file.path} · {file.size} bytes</li>)}</ul>
      </details>
      <details><summary className="cursor-pointer py-1" data-testid="repository-license">License text and obligations</summary>
        <pre className="max-h-48 overflow-auto whitespace-pre-wrap text-[11px]">{preview.license.text}</pre>
        <p className="mt-2">Preserve license notices and comply with any source-sharing requirements when distributing changes.</p>
      </details>
      <p>Preview expires in five minutes. Import verifies every file against this commit, then applies the existing offline-game safety checks.</p>
      <label className="flex items-start gap-2 rounded-md border border-white/10 bg-white/5 p-2">
        <input data-testid="confirm-repository-rights" type="checkbox" checked={rightsConfirmed} disabled={phase !== null} onChange={event => setRightsConfirmed(event.target.checked)} className="mt-0.5 accent-emerald-300" />
        <span>I have the right to use this source and any included game assets.</span>
      </label>
      <button type="button" data-testid="import-reviewed-repository" disabled={disabled || phase !== null || !rightsConfirmed}
        onClick={() => void run("acquire")} className="rounded-lg bg-emerald-300 px-3 py-2 font-extrabold text-slate-950 disabled:opacity-50">
        {phase === "acquire" ? "Downloading and checking…" : "Import reviewed game"}
      </button>
    </div>}
  </section>;
}
