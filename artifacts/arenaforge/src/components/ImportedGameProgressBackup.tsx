import { useEffect, useRef, useState } from "react";
import { createHtmlProgressBackup, inspectHtmlProgressBackup, MAX_PROGRESS_BACKUP_BYTES, type GameSaveData, type ProgressBackupTarget } from "../lib/arcadeGameProgressBackup";

type PreparedBackup = Awaited<ReturnType<typeof inspectHtmlProgressBackup>>;
export default function ImportedGameProgressBackup({ game, hasProgress, disabled, onRestore }: {
  game: ProgressBackupTarget;
  hasProgress: boolean;
  disabled: boolean;
  onRestore: (data: GameSaveData, expectedRaw: string | null, expectedRevision: string | null) => void | Promise<void>;
}) {
  const [candidate, setCandidate] = useState<PreparedBackup | null>(null);
  const [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const generation = useRef(0);
  const pickerRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    generation.current++;
    setCandidate(null); setConfirmed(false); setError(""); setNotice(""); setBusy(false);
    return () => { generation.current++; };
  }, [game.id, game.source]);
  useEffect(() => {
    const picker = pickerRef.current;
    if (!picker) return;
    const onCancel = () => setNotice("No file selected. The current progress was not changed.");
    picker.addEventListener("cancel", onCancel);
    return () => picker.removeEventListener("cancel", onCancel);
  }, []);
  const report = (cause: unknown) => setError(cause instanceof Error ? cause.message : "Progress backup failed.");

  const exportProgress = async () => {
    const token = ++generation.current;
    setBusy(true); setError(""); setNotice("");
    let url: string | undefined;
    const link = document.createElement("a");
    try {
      const backup = await createHtmlProgressBackup(game);
      if (token !== generation.current) return;
      url = URL.createObjectURL(new Blob([JSON.stringify(backup, null, 2)], { type: "application/json" }));
      link.href = url;
      link.download = `${game.name.replace(/\.(html?|zip)$/i, "").replace(/[^a-z0-9_-]/gi, "-").slice(0, 80) || "arcade-game"}.arena-progress.json`;
      document.body.append(link); link.click();
      setNotice("Progress backup downloaded. Game source and media are not included.");
    } catch (cause) { if (token === generation.current) report(cause); }
    finally {
      link.remove();
      if (url) window.setTimeout(() => URL.revokeObjectURL(url!), 1000);
      if (token === generation.current) setBusy(false);
    }
  };
  const inspect = async (file?: File) => {
    if (!file) return;
    const token = ++generation.current;
    setBusy(true); setCandidate(null); setConfirmed(false); setError(""); setNotice("");
    try {
      if (file.size > MAX_PROGRESS_BACKUP_BYTES) throw new Error("Progress backup files must be no larger than 256 KiB.");
      const prepared = await inspectHtmlProgressBackup(await file.text(), game);
      if (token === generation.current) setCandidate(prepared);
    } catch (cause) { if (token === generation.current) report(cause); }
    finally { if (token === generation.current) setBusy(false); }
  };
  const restore = async () => {
    if (!candidate || !confirmed || busy || disabled) return;
    setError(""); setNotice(""); setBusy(true);
    try {
      await onRestore(candidate.backup.data, candidate.expectedRaw, candidate.expectedRevision);
      setCandidate(null); setConfirmed(false);
      setNotice("Progress restored locally. The game restarted with this save; source and other games are unchanged.");
    } catch (cause) { report(cause); }
    finally { setBusy(false); }
  };
  return (
    <details className="mt-3 rounded-lg border border-white/10 bg-black/20 p-3" data-testid="imported-progress-backup">
      <summary className="cursor-pointer text-xs font-bold text-slate-200">Progress backup and restore</summary>
      <p className="mt-2 text-[11px] leading-relaxed text-slate-400">Private progress files stay on your device. Source and media are not included; keep a separate HTML source backup with rollback copies too when clearing browser data or moving browsers. Browsers with Web Locks serialize tabs; without it, localStorage cannot guarantee atomic cross-tab writes.</p>
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <button type="button" disabled={busy || disabled || !hasProgress} onClick={() => void exportProgress()} className="min-h-11 rounded-lg border border-sky-300/25 px-3 py-2 text-[11px] font-bold text-sky-100 disabled:opacity-40" data-testid="button-export-imported-progress">Export progress</button>
        <label className="text-[11px] font-semibold text-slate-300">Choose progress backup
          <input ref={pickerRef} type="file" accept=".json,application/json" disabled={busy || disabled} className="mt-1 block max-w-full text-[11px] text-slate-400" data-testid="input-imported-progress-backup" onChange={event => {
            void inspect(event.target.files?.[0]); event.currentTarget.value = "";
          }} />
        </label>
      </div>
      {!hasProgress && <p className="mt-2 text-[10px] text-slate-400">Export becomes available after this game saves progress. You can still restore a backup now.</p>}
      {busy && <p role="status" className="mt-2 text-xs text-sky-100">Preparing progress backup…</p>}
      {candidate && (
        <div className="mt-3 space-y-2 rounded-lg border border-amber-300/25 bg-amber-300/5 p-3" data-testid="imported-progress-restore-preview">
          <p className="break-words text-xs font-semibold text-slate-200">{candidate.backup.gameName} · saved {new Date(candidate.backup.exportedAt).toLocaleString()} · {Object.keys(candidate.backup.data).length} keys</p>
          {!candidate.sameIdentity && <p className="text-[11px] text-amber-100">Different import identity, but the HTML source matches exactly. Only continue if this is the copy you want to use.</p>}
          {candidate.sameIdentity && !candidate.sameSource && <p className="text-[11px] text-amber-100">This save belongs to another source version of this game. Its progress format may not be compatible.</p>}
          <p className="text-[11px] text-slate-300">Restoring replaces this game's current progress and restarts its player. Game source, revision history and other games are not replaced.</p>
          <label className="flex items-start gap-2 text-[11px] text-amber-100">
            <input type="checkbox" checked={confirmed} onChange={event => setConfirmed(event.target.checked)} />
            {candidate.sameIdentity ? "Replace this game's current progress with this backup." : "Use this backup for this imported copy and replace its current progress."}
          </label>
          <div className="flex flex-wrap gap-2">
            <button type="button" disabled={!confirmed || disabled || busy} onClick={restore} className="min-h-11 rounded-lg bg-sky-300 px-3 py-2 text-xs font-bold text-slate-950 disabled:opacity-40" data-testid="button-restore-imported-progress">Restore progress</button>
            <button type="button" onClick={() => { generation.current++; setCandidate(null); setConfirmed(false); setError(""); }} className="min-h-11 rounded-lg border border-white/15 px-3 py-2 text-xs text-slate-300">Cancel restore</button>
          </div>
        </div>
      )}
      {error && <p role="alert" className="mt-2 text-xs text-red-200">{error}</p>}
      {notice && <p role="status" className="mt-2 text-xs text-emerald-100">{notice}</p>}
    </details>
  );
}
