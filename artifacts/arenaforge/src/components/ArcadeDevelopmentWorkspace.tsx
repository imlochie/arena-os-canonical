import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AlertTriangle, Check, Cpu, Download, FileCode2, Hammer, Lock, Play, RefreshCw, RotateCcw, Save, ShieldCheck, Square, X } from "lucide-react";
import {
  checkDevelopment, commitDevelopment, hashDevelopment, listDevelopmentGames, listDevelopmentModels, openDevelopment,
  packageDevelopment, playDevelopment, reviewDevelopment, rollbackDevelopment, runDevelopment, saveDevelopment, assessDevelopment,
  type DevelopmentDocument, type DevelopmentModel,
} from "../lib/arcadeDevelopment";
import { compareImportedGameSource } from "../lib/importedGameSourceComparison";
import type { WorkshopGame, WorkshopPlayback, WorkshopPreview } from "../lib/modWorkshopTypes";

type Props = { onPlay(playback: WorkshopPlayback): void };

const LIMIT = 50_000;
const msg = (c: unknown) => (c && typeof c === "object" && "status" in c && c.status === 401
  ? "Model missions require an Arena owner session in the hosted preview. Manual editing, static checks and Workshop installation remain local and do not need a login."
  : c instanceof Error ? c.message : "The development operation failed.");
const short = (h?: string) => (h ? `${h.slice(0, 12)}…` : "—");
const bytes = (s: string) => new TextEncoder().encode(s).length;

function download(name: string, text: string) {
  const url = URL.createObjectURL(new Blob([text], { type: "application/json" }));
  const a = document.createElement("a");
  a.href = url; a.download = name; a.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function Diff({ before, after }: { before: string; after: string }) {
  const c = useMemo(() => compareImportedGameSource(before, after), [before, after]);
  if (c.identical) return <p className="text-[11px] text-slate-500" data-testid="text-diff-summary">Draft is identical to the original.</p>;
  return (
    <div>
      <p className="text-[11px] text-slate-300" data-testid="text-diff-summary">
        {c.displayIdentical ? "Bytes differ but displayed text is unchanged." : `+${c.added} added / −${c.removed} removed lines`}
        {c.truncated && " · excerpt only, not a complete comparison"}{c.coarse && " · coarse block diff"}
      </p>
      {!c.displayIdentical && (
        <div className="mt-2 max-h-72 overflow-auto rounded-lg border border-white/10 bg-black/40 font-mono text-[11px]" role="region" aria-label="Original versus draft" tabIndex={0}>
          {c.rows.map((row, i) => (
            <div key={i} className={`flex gap-2 px-2 py-0.5 ${row.kind === "added" ? "bg-emerald-500/15 text-emerald-100" : row.kind === "removed" ? "bg-rose-500/15 text-rose-100" : row.kind === "gap" ? "bg-slate-800/60 text-slate-400" : "text-slate-400"}`}>
              <span className="w-14 shrink-0 select-none text-right text-slate-500">{row.beforeLine ?? "·"}/{row.afterLine ?? "·"}</span>
              <span className="w-3 shrink-0">{row.kind === "added" ? "+" : row.kind === "removed" ? "−" : row.kind === "gap" ? "…" : " "}</span>
              <code className="min-w-0 whitespace-pre-wrap break-all">{row.text || " "}</code>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function Step({ n, title, children, muted }: { n: string; title: string; children: React.ReactNode; muted?: boolean }) {
  return (
    <section className={`glass rounded-2xl border border-white/10 p-4 ${muted ? "opacity-60" : ""}`}>
      <h3 className="flex items-center gap-2 text-xs font-black uppercase tracking-[0.16em] text-slate-200">
        <span className="rounded-md bg-amber-300/15 px-1.5 py-0.5 font-mono text-[10px] text-amber-200">{n}</span>{title}
      </h3>
      <div className="mt-3">{children}</div>
    </section>
  );
}

export default function ArcadeDevelopmentWorkspace({ onPlay }: Props) {
  const [games, setGames] = useState<WorkshopGame[] | null>(null);
  const [gamesError, setGamesError] = useState("");
  const [gameId, setGameId] = useState("");
  const [authorized, setAuthorized] = useState(false);
  const [doc, setDoc] = useState<DevelopmentDocument | null>(null);
  const [draft, setDraft] = useState("");
  const [modelId, setModelId] = useState("");
  const [prompt, setPrompt] = useState("");
  const [assessment, setAssessment] = useState("");
  const [models, setModels] = useState<DevelopmentModel[] | null>(null);
  const [modelsError, setModelsError] = useState("");
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [build, setBuild] = useState<unknown>(null);
  const [preview, setPreview] = useState<WorkshopPreview | null>(null);
  const [draftHash, setDraftHash] = useState("");
  const [showDiff, setShowDiff] = useState(false);
  const opRef = useRef(0);
  const abortRef = useRef<AbortController | null>(null);
  useEffect(() => () => { abortRef.current?.abort(); opRef.current++; }, []);

  const loadGames = useCallback(async () => {
    setGames(null); setGamesError("");
    try { const list = await listDevelopmentGames(); setGames(list); }
    catch (c) { setGamesError(msg(c)); setGames([]); }
  }, []);
  const loadModels = useCallback(async () => {
    setModels(null); setModelsError("");
    try { setModels(await listDevelopmentModels()); } catch (c) { setModelsError(msg(c)); setModels([]); }
  }, []);
  useEffect(() => { void loadGames(); void loadModels(); }, [loadGames, loadModels]);

  const adopt = useCallback((next: DevelopmentDocument, resetLocal = true) => {
    setDoc(next);
    if (resetLocal) { setDraft(next.draft); setModelId(next.modelId); setPrompt(next.prompt); setAssessment(next.assessment ?? ""); }
  }, []);

  useEffect(() => { let live = true; void hashDevelopment(draft).then(h => live && setDraftHash(h)); return () => { live = false; }; }, [draft]);

  async function run<T>(label: string, task: (signal: AbortSignal) => Promise<T>, apply: (v: T) => void) {
    if (abortRef.current) return;
    const token = ++opRef.current, ctl = new AbortController();
    abortRef.current = ctl;
    setBusy(label); setError(""); setNotice("");
    try { const v = await task(ctl.signal); if (token === opRef.current) apply(v); }
    catch (c) { if (token === opRef.current) setError((c as Error)?.name === "AbortError" ? "Cancelled. No result was applied." : msg(c)); }
    finally { if (token === opRef.current) { setBusy(""); abortRef.current = null; } }
  }
  function cancel() {
    abortRef.current?.abort(); opRef.current++; setBusy("");
    setNotice("Cancelled. Any late result is ignored here; reopen the copy to see what was stored.");
  }

  const open = (id = gameId) => {
    if (!id || !authorized) return;
    setPreview(null); setBuild(null); setDoc(null);
    void run("Opening private development copy…", () => openDevelopment(id), (d) => {
      adopt(d);
      if (d.mission && /running|queued|working|pending/i.test(d.mission.status)) setNotice(`Recovered after refresh. The mission was last "${d.mission.status}". Nothing resumed or installed automatically; choose Resume to continue.`);
    });
  };

  const draftChanged = !!doc && draft !== doc.draft;
  const configChanged = !!doc && (modelId !== doc.modelId || prompt !== doc.prompt);
  const changed = draftChanged || configChanged;
  // Any edit invalidates a prepared review.
  useEffect(() => { if (changed) { setPreview(null); setBuild(null); } }, [changed, draft, modelId, prompt]);

  const locked = !!busy;
  const size = bytes(draft);
  const isModelDraft = !!doc?.aiLineage?.length;
  const modelMissing = !!doc && !!modelId && models !== null && !modelsError && !models.some(m => m.id === modelId);
  const pendingApprovals = !changed ? doc?.approvals ?? [] : [];
  const approvedMatches = !!doc?.approvedHash && doc.approvedHash === draftHash && !changed;
  const installedMatches = !!doc?.installedHash && doc.installedHash === draftHash && !changed;
  const staleTab = /another tab|immutable base/i.test(error);

  const saveCheckpoint = () => {
    if (!doc) return;
    const manual = draftChanged;
    void run("Saving checkpoint…", () => saveDevelopment({
      ...doc, draft, modelId, prompt, assessment: doc.assessment, approvedHash: undefined, approvals: undefined,
      ...(manual ? { mission: undefined } : {}),
    }), (d) => { adopt(d); setNotice(manual ? "Manual checkpoint saved. Earlier approvals no longer apply; any AI-derived provenance is retained." : "Model and instructions saved. Earlier pending approval was cleared."); });
  };

  const startMission = (op: "start" | "resume") => {
    if (!doc || !modelId || !prompt.trim() || modelMissing) return;
    void run(op === "start" ? "Sending draft to selected local model…" : "Resuming mission…", async (signal) => {
      let base = doc;
      if (changed || op === "start") base = await saveDevelopment({ ...doc, draft, modelId, prompt: prompt.trim(), approvals: undefined, approvedHash: undefined, ...(op === "start" ? { mission: undefined } : {}) });
      adopt(base);
      return runDevelopment(base, op, signal);
    }, (d) => { adopt(d); setNotice(`Mission ${d.mission?.status ?? "returned"}. Review the proposed draft below; nothing is installed.`); });
  };
  const decide = (op: "approve" | "deny", approvalId: string) => {
    if (!doc || changed) return;
    void run(op === "approve" ? "Approving…" : "Denying…", (s) => runDevelopment(doc, op, s, approvalId), (d) => adopt(d));
  };

  return (
    <section data-testid="arcade-development" aria-label="Arcade development" className="mt-4 grid min-w-0 gap-4 lg:grid-cols-[270px_minmax(0,1fr)]">
      <aside className="min-w-0 space-y-3">
        <div className="glass rounded-2xl border border-white/10 p-4">
          <p className="text-[10px] font-black uppercase tracking-[0.22em] text-amber-300">Development bench</p>
          <h2 className="mt-1 text-lg font-black tracking-tight text-white">Draft against a frozen original.</h2>
          <p className="mt-1 text-[11px] leading-relaxed text-slate-400">One owner-authorized offline HTML game up to 50 KB. Copies and static checks stay in this browser. Explicit model runs send source through Arena’s API for that request, not to the shared catalog. Original games and saves are never rewritten. No ROM or native engine editors.</p>
          <label htmlFor="dev-game" className="mt-4 block text-[10px] font-black uppercase tracking-wider text-slate-400">Imported HTML game</label>
          {games === null ? <div className="mt-2 h-9 animate-pulse rounded-lg bg-white/[0.06]" /> : (
            <select id="dev-game" data-testid="select-dev-game" value={gameId} disabled={locked}
              onChange={(e) => { setGameId(e.target.value); setAuthorized(false); setDoc(null); setPreview(null); setBuild(null); setError(""); setNotice(""); }}
              className="mt-2 block w-full rounded-lg border border-white/15 bg-slate-950 px-2 py-2 text-xs text-slate-100">
              <option value="">{games.length ? "Choose a game" : "No HTML imports"}</option>
              {games.map(g => <option key={g.id} value={g.id}>{g.title}</option>)}
            </select>
          )}
          {gamesError && <div role="alert" className="mt-2 rounded-lg border border-red-400/25 bg-red-500/10 p-2 text-[11px] text-red-200">{gamesError}<button type="button" data-testid="button-retry-games" onClick={() => void loadGames()} className="ml-2 font-bold underline">Retry</button></div>}
          {games?.length === 0 && !gamesError && <p className="mt-2 rounded-lg bg-black/20 p-3 text-[11px] text-slate-500">Import an authorized offline HTML game first.</p>}
          {gameId && (
            <>
              <label className="mt-3 flex items-start gap-2 text-[11px] leading-relaxed text-slate-300">
                <input type="checkbox" data-testid="checkbox-dev-authorized" checked={authorized} disabled={locked} onChange={(e) => setAuthorized(e.target.checked)} className="mt-0.5 accent-amber-400" />
                <span>I own or am authorized to modify this game. Its source may be checked locally, and sent to a model only when I press Run.</span>
              </label>
              <button type="button" data-testid="button-open-dev" disabled={!authorized || locked} onClick={() => open()}
                className="mt-3 inline-flex w-full items-center justify-center gap-1.5 rounded-lg bg-amber-300 px-3 py-2 text-xs font-extrabold text-slate-950 disabled:opacity-40">
                <FileCode2 size={13} />{doc ? "Reopen copy" : "Open development copy"}
              </button>
            </>
          )}
        </div>
        {doc && (
          <div className="glass rounded-2xl border border-white/10 p-4 text-[11px]" data-testid="panel-dev-identity">
            <p className="text-[10px] font-black uppercase tracking-wider text-slate-300">Copy record</p>
            <dl className="mt-2 space-y-1 text-slate-400">
              <div className="flex gap-2"><dt className="w-16 shrink-0">Revision</dt><dd className="font-mono text-slate-200" data-testid="text-dev-revision">{doc.revision}</dd></div>
              <div className="flex gap-2"><dt className="w-16 shrink-0">Draft</dt><dd data-testid="text-dev-kind" className={isModelDraft ? "text-cyan-200" : "text-amber-200"}>{isModelDraft ? `Model proposal (${doc.modelId})` : "Manual draft"}</dd></div>
              <div className="flex gap-2"><dt className="w-16 shrink-0">Hash</dt><dd className="font-mono text-slate-200">{short(draftHash)}</dd></div>
              <div className="flex gap-2"><dt className="w-16 shrink-0">Installed</dt><dd className="font-mono text-slate-200">{doc.installedHash ? `${short(doc.installedHash)}${installedMatches ? " (current)" : " (older)"}` : "none"}</dd></div>
            </dl>
            <p className="mt-2 break-words text-[10px] text-slate-500">Provenance: {doc.provenance}</p>
          </div>
        )}
      </aside>

      <div className="min-w-0 space-y-4">
        {busy && (
          <div role="status" className="flex items-center gap-2 rounded-xl border border-cyan-300/20 bg-cyan-300/10 px-3 py-2 text-xs text-cyan-100">
            <RefreshCw size={13} className="animate-spin" /><span className="flex-1">{busy}</span>
            <button type="button" data-testid="button-dev-cancel" onClick={cancel} className="inline-flex items-center gap-1 rounded-md border border-cyan-300/30 px-2 py-1 text-[10px] font-bold"><X size={11} />Cancel</button>
          </div>
        )}
        {error && (
          <div role="alert" data-testid="status-dev-error" className="flex flex-wrap items-start gap-2 rounded-xl border border-red-400/25 bg-red-500/10 px-3 py-2.5 text-xs text-red-200">
            <AlertTriangle size={15} className="mt-0.5 shrink-0" /><span className="min-w-0 flex-1">{error}</span>
            {doc && authorized && <button type="button" data-testid="button-dev-reopen" onClick={() => open()} className="rounded-md border border-red-300/30 px-2 py-1 text-[10px] font-bold">{staleTab ? "Reopen latest" : "Retry by reopening"}</button>}
          </div>
        )}
        {notice && !error && <div role="status" data-testid="status-dev-notice" className="rounded-xl border border-emerald-400/20 bg-emerald-400/10 px-3 py-2.5 text-xs text-emerald-100">{notice}</div>}

        {!doc ? (
          busy ? <div className="space-y-3">{[0, 1, 2].map(i => <div key={i} className="h-24 animate-pulse rounded-2xl bg-white/[0.04]" />)}</div> : (
            <div className="flex min-h-56 flex-col items-center justify-center rounded-2xl border border-dashed border-white/10 bg-white/[0.02] px-6 text-center">
              <Lock size={22} className="text-slate-500" />
              <p className="mt-3 text-sm font-extrabold text-slate-200">Nothing is read until you authorize.</p>
              <p className="mt-1 max-w-sm text-xs text-slate-500">Pick an imported HTML game, confirm you may modify it, then open its private copy.</p>
            </div>
          )
        ) : (
          <>
            <Step n="01" title="Source draft">
              <div className="flex flex-wrap items-center gap-2 text-[10px]">
                <span className={`font-mono ${size > LIMIT ? "text-red-300" : "text-slate-500"}`} data-testid="text-dev-size">{(size / 1024).toFixed(1)} / 50 KB</span>
                {draftChanged && <span className="rounded bg-amber-300/15 px-1.5 py-0.5 font-bold uppercase tracking-wider text-amber-200">Unsaved manual edits</span>}
                <span className="flex-1" />
                <button type="button" data-testid="button-toggle-diff" onClick={() => setShowDiff(v => !v)} className="rounded-md border border-white/10 px-2 py-1 font-bold text-slate-300">{showDiff ? "Hide comparison" : "Compare with original"}</button>
                <button type="button" data-testid="button-revert-draft" disabled={locked || !draftChanged} onClick={() => setDraft(doc.draft)} className="rounded-md border border-white/10 px-2 py-1 font-bold text-slate-300 disabled:opacity-40">Discard edits</button>
                <button type="button" data-testid="button-reset-original" disabled={locked || draft === doc.original} onClick={() => setDraft(doc.original)} className="rounded-md border border-white/10 px-2 py-1 font-bold text-slate-300 disabled:opacity-40">Load original</button>
                <button type="button" data-testid="button-save-checkpoint" disabled={locked || !changed || size > LIMIT} onClick={saveCheckpoint}
                  className="inline-flex items-center gap-1 rounded-md bg-amber-300 px-2 py-1 font-extrabold text-slate-950 disabled:opacity-40"><Save size={11} />Save checkpoint</button>
              </div>
              {showDiff && <div className="mt-3"><Diff before={doc.original} after={draft} /></div>}
              <textarea data-testid="input-dev-draft" value={draft} onChange={(e) => setDraft(e.target.value)} disabled={locked} spellCheck={false}
                className="mt-3 h-72 w-full resize-y rounded-lg border border-white/15 bg-slate-950 p-3 font-mono text-[11px] leading-relaxed text-slate-100" />
              {isModelDraft && draftChanged && <p className="mt-1 text-[10px] text-amber-200">Hand edits invalidate earlier approval. AI-derived provenance remains attached; gameplay is still unverified.</p>}
            </Step>

            <Step n="02" title="Local model mission">
              <p className="text-[11px] text-slate-400">Only explicit model runs send the draft through Arena’s authenticated API to your selected local runtime. Static checks run locally without a model or login. No public-provider fallback.</p>
              <p className="mt-1 text-[11px] text-slate-500">Start a local code-model server, register it in <a href="/model-hub" className="text-amber-200 underline">Model Hub</a>, then refresh this list. A catalog name alone does not mean a model is running. WebGPU is not required.</p>
              {models === null ? <div className="mt-2 h-9 animate-pulse rounded-lg bg-white/[0.06]" /> : (
                <div className="mt-2 flex flex-wrap gap-2">
                  <select data-testid="select-dev-model" value={modelId} disabled={locked} onChange={(e) => setModelId(e.target.value)} className="min-w-0 flex-1 rounded-lg border border-white/15 bg-slate-950 px-2 py-2 text-xs text-slate-100">
                    <option value="">{models.length ? "Choose a local model" : "No local models available"}</option>
                    {modelMissing && <option value={modelId}>{modelId} (missing)</option>}
                    {models.map(m => <option key={m.id} value={m.id}>{m.name} · {m.backend}</option>)}
                  </select>
                  <button type="button" data-testid="button-retry-models" onClick={() => void loadModels()} className="rounded-lg border border-white/10 px-2 text-[10px] font-bold text-slate-300"><RefreshCw size={12} /></button>
                </div>
              )}
              {modelsError && <p role="alert" className="mt-1 text-[11px] text-red-200">{modelsError}</p>}
              {modelMissing && <p role="alert" className="mt-1 text-[11px] text-amber-200">The saved model is no longer in Model Hub. Choose another; the manual editor still works.</p>}
              <textarea data-testid="input-dev-prompt" value={prompt} onChange={(e) => setPrompt(e.target.value)} disabled={locked} maxLength={4000} placeholder="e.g. Make the paddle 20% wider and add a pause key on P."
                className="mt-2 h-20 w-full rounded-lg border border-white/15 bg-slate-950 p-2 text-xs text-slate-100" />
              {configChanged && <p className="text-[10px] text-amber-200">Model or instructions changed: any pending approval is set aside and will not be continued.</p>}
              <div className="mt-2 flex flex-wrap gap-2">
                <button type="button" data-testid="button-dev-run" disabled={locked || !modelId || modelMissing || !prompt.trim() || size > LIMIT} onClick={() => startMission("start")}
                  className="inline-flex items-center gap-1 rounded-lg bg-cyan-300 px-3 py-2 text-[11px] font-extrabold text-slate-950 disabled:opacity-40"><Cpu size={12} />Run with selected model</button>
                <button type="button" data-testid="button-dev-resume" disabled={locked || !doc.mission || changed || modelMissing} onClick={() => startMission("resume")}
                  className="inline-flex items-center gap-1 rounded-lg border border-cyan-300/25 bg-cyan-300/10 px-3 py-2 text-[11px] font-bold text-cyan-100 disabled:opacity-40"><RotateCcw size={12} />Resume</button>
                {busy && <button type="button" data-testid="button-dev-stop" onClick={cancel} className="inline-flex items-center gap-1 rounded-lg border border-red-300/25 px-3 py-2 text-[11px] font-bold text-red-200"><Square size={11} />Cancel run</button>}
              </div>
              {doc.mission && (
                <div className="mt-3 rounded-xl border border-white/10 bg-black/20 p-3" data-testid="panel-dev-journal">
                  <p className="text-[11px] text-slate-200">Mission <code className="text-slate-400">{doc.mission.id.slice(0, 10)}</code> · <span data-testid="status-dev-mission" className="font-bold text-cyan-200">{doc.mission.status}</span></p>
                  {doc.mission.statusDetail && <p className="mt-0.5 text-[10px] text-slate-400">{doc.mission.statusDetail}</p>}
                  <ol className="mt-2 max-h-56 space-y-1 overflow-auto">
                    {doc.mission.journal.map((s: any, i: number) => (
                      <li key={i} className="rounded-md bg-white/[0.03] px-2 py-1 text-[10px] text-slate-300" data-testid={`row-journal-${i}`}>
                        <span className="font-bold text-slate-100">{String(s?.agent ?? `Step ${i + 1}`)}</span>
                        <p className="mt-1 text-slate-400">{s?.thought}</p>
                        {s?.actions?.map((action: any, n: number) => <div key={n} className="mt-1 break-words"><strong>{action.tool}: {action.ok ? "succeeded" : "not completed"}</strong><pre className="mt-1 max-h-24 overflow-auto whitespace-pre-wrap text-[10px] text-slate-500">{String(action.output ?? "")}</pre></div>)}
                        {s?.status && <span className="ml-2 text-cyan-200">{String(s.status)}</span>}
                        {s?.runtime && <span className="ml-2 text-slate-500">runtime {typeof s.runtime === "string" ? s.runtime : JSON.stringify(s.runtime)}</span>}
                        {s?.backend && <span className="ml-2 text-slate-500">backend {String(s.backend)}</span>}
                        {s?.approval && <span className="ml-2 text-amber-200">approval {typeof s.approval === "string" ? s.approval : JSON.stringify(s.approval)}</span>}
                        {s?.error && <span className="block text-red-300">{typeof s.error === "string" ? s.error : JSON.stringify(s.error)}</span>}
                        {s?.detail && <span className="block text-slate-500">{String(s.detail)}</span>}
                      </li>
                    ))}
                    {doc.mission.journal.length === 0 && <li className="text-[10px] text-slate-500">No journal entries recorded.</li>}
                  </ol>
                </div>
              )}
              {pendingApprovals.map(a => (
                <div key={a.id} className="mt-2 flex flex-wrap items-center gap-2 rounded-xl border border-amber-300/25 bg-amber-300/10 p-3 text-[11px] text-amber-100" data-testid={`panel-approval-${a.id}`}>
                  <span className="min-w-0 flex-1">Pending install approval: {a.summary}</span>
                  <button type="button" data-testid={`button-approve-${a.id}`} disabled={locked} onClick={() => decide("approve", a.id)} className="rounded-md bg-amber-300 px-2 py-1 font-extrabold text-slate-950 disabled:opacity-40">Approve</button>
                  <button type="button" data-testid={`button-deny-${a.id}`} disabled={locked} onClick={() => decide("deny", a.id)} className="rounded-md border border-amber-300/30 px-2 py-1 font-bold disabled:opacity-40">Deny</button>
                </div>
              ))}
              {isModelDraft && <p className="mt-2 text-[10px] text-slate-500">Artifact approval: {approvedMatches ? <span className="text-emerald-200">exact draft {short(doc.approvedHash)} approved</span> : "not approved for this exact draft"}</p>}
            </Step>

            <Step n="03" title="Check, review and install" muted={changed}>
              {changed && <p className="mb-2 text-[11px] text-amber-200">Save a checkpoint first; review uses the stored draft only.</p>}
              <div className="flex flex-wrap gap-2">
                <button type="button" data-testid="button-dev-check" disabled={locked || changed} onClick={() => void run("Running static build check…", () => checkDevelopment(doc), (m) => setBuild(m ?? {}))}
                  className="inline-flex items-center gap-1 rounded-lg border border-white/10 bg-white/5 px-3 py-2 text-[11px] font-bold text-slate-200 disabled:opacity-40"><Hammer size={12} />Static build check</button>
                <button type="button" data-testid="button-dev-review" disabled={locked || changed || (doc.proposalHash === draftHash && !approvedMatches)} onClick={() => void run("Preparing install review…", () => reviewDevelopment(doc), ({ document, preview: p }) => { adopt(document, false); setPreview(p); setNotice("Review ready. Nothing is installed until you commit."); })}
                  className="inline-flex items-center gap-1 rounded-lg bg-emerald-400 px-3 py-2 text-[11px] font-extrabold text-slate-950 disabled:opacity-40"><ShieldCheck size={12} />Review installation</button>
                <button type="button" data-testid="button-dev-play" disabled={locked || !doc.profileId || !doc.installedHash} onClick={() => void run("Launching profile…", () => playDevelopment(doc), onPlay)}
                  className="inline-flex items-center gap-1 rounded-lg border border-emerald-300/25 bg-emerald-300/10 px-3 py-2 text-[11px] font-bold text-emerald-100 disabled:opacity-40"><Play size={12} />Play installed</button>
                <button type="button" data-testid="button-dev-rollback" disabled={locked || !doc.profileId || !doc.installedHash} onClick={() => { if (window.confirm("Restore the development profile to its last good checkpoint and play it?")) void run("Rolling back…", () => rollbackDevelopment(doc), onPlay); }}
                  className="inline-flex items-center gap-1 rounded-lg border border-amber-300/25 bg-amber-300/10 px-3 py-2 text-[11px] font-bold text-amber-100 disabled:opacity-40"><RotateCcw size={12} />Roll back</button>
                <button type="button" data-testid="button-dev-package" disabled={locked || changed} onClick={() => void run("Packaging…", () => packageDevelopment(doc), (json) => { download(`dev-${doc.developmentId.slice(0, 8)}.unverified.mod.json`, json); setNotice("Package downloaded. It is marked non-redistributable and unverified."); })}
                  className="inline-flex items-center gap-1 rounded-lg border border-white/10 bg-white/5 px-3 py-2 text-[11px] font-bold text-slate-200 disabled:opacity-40"><Download size={12} />Download restricted package</button>
              </div>
              <p className="mt-2 text-[10px] text-slate-500">Packages are local derivatives: distribution rights are not established and gameplay is not verified. Installs go to an independent-save profile.</p>
              {build !== null && (
                <div className="mt-3 rounded-xl border border-emerald-300/20 bg-emerald-300/[0.05] p-3" data-testid="panel-dev-build">
                  <p className="flex items-center gap-1 text-[11px] font-bold text-emerald-100"><Check size={12} />Static build passed. This is not a gameplay check.</p>
                  <pre className="mt-1 max-h-32 overflow-auto whitespace-pre-wrap text-[10px] text-slate-400">{JSON.stringify(build, null, 2)}</pre>
                </div>
              )}
              {preview && (
                <div className="mt-3 rounded-xl border border-white/10 bg-black/20 p-3 text-[11px]" data-testid="panel-dev-preview">
                  <p className="font-bold text-slate-100">Install preview · {preview.name}</p>
                  <ul className="mt-1 space-y-0.5 font-mono text-[10px] text-slate-400">
                    {preview.changes.map(c => <li key={c.path}>{c.path}: {short(c.before)} → {short(c.after)} ({c.bytes} B)</li>)}
                  </ul>
                  {preview.warnings.length > 0 && <ul className="mt-2 space-y-0.5 text-amber-200">{preview.warnings.map((w, i) => <li key={i}>Warning: {w}</li>)}</ul>}
                  {preview.licenses.map(l => <p key={l.mod} className="mt-2 text-slate-400">License {l.spdx} · {l.redistributable ? "redistributable" : "not redistributable"}</p>)}
                  <p className="mt-1 text-slate-500">Permissions: {preview.permissions.join(", ") || "none"}</p>
                  <div className="mt-2 flex gap-2">
                    <button type="button" data-testid="button-dev-commit" disabled={locked} onClick={() => void run("Installing…", () => commitDevelopment(doc, preview.id), (d) => { adopt(d, false); setPreview(null); setNotice("Installed into the development profile. The original and its saves are unchanged."); })}
                      className="rounded-lg bg-emerald-400 px-3 py-2 text-[11px] font-extrabold text-slate-950 disabled:opacity-40">Commit install</button>
                    <button type="button" data-testid="button-dev-discard-review" onClick={() => { setPreview(null); setNotice("Review discarded. Nothing changed."); }} className="rounded-lg border border-white/10 px-3 py-2 text-[11px] font-bold text-slate-300">Discard</button>
                  </div>
                </div>
              )}
            </Step>

            <Step n="04" title="Owner assessment">
              <p className="mb-2 text-[10px] text-slate-500">Owner report only, not independent verification. {doc.assessmentResult ? `Last report: ${doc.assessmentResult}.` : "No gameplay assessment recorded."}</p>
              <textarea data-testid="input-dev-assessment" value={assessment} onChange={(e) => setAssessment(e.target.value)} disabled={locked} maxLength={2000} placeholder="What you observed when playing. Stored only on this device."
                className="h-20 w-full rounded-lg border border-white/15 bg-slate-950 p-2 text-xs text-slate-100" />
              <button type="button" data-testid="button-save-assessment" disabled={locked || changed || assessment === (doc.assessment ?? "")}
                onClick={() => void run("Saving assessment…", () => saveDevelopment({ ...doc, assessment }), (d) => { adopt(d, false); setNotice("Assessment saved locally."); })}
                className="mt-2 rounded-lg border border-white/10 bg-white/5 px-3 py-2 text-[11px] font-bold text-slate-200 disabled:opacity-40">Save assessment</button>
              {changed && <p className="mt-1 text-[10px] text-slate-500">Save or discard draft changes first.</p>}
              <div className="mt-2 flex flex-wrap gap-2">
                {(["working", "failed"] as const).map(result => <button key={result} type="button" disabled={locked || changed || !doc.installedHash}
                  onClick={() => void run("Recording owner gameplay report…", () => assessDevelopment(doc, result, assessment), d => adopt(d, false))}
                  className="rounded-lg border border-white/10 px-3 py-2 text-[11px] font-bold text-slate-300 disabled:opacity-40">
                  {result === "working" ? "Report gameplay working" : "Report gameplay failure"}
                </button>)}
              </div>
            </Step>
          </>
        )}
      </div>
    </section>
  );
}
