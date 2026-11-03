import { useRef, useState } from "react";
import { createImportedSourceBackup, parseImportedSourceBackup, MAX_SOURCE_BACKUP_BYTES, type SourceBackupGame } from "../lib/importedGameSourceBackup";
import { getImportedRevisionHistory } from "../lib/importedGameRevision";

type ShelfGame = { id: string; name: string };
type Props = {
  selected: SourceBackupGame | null;
  games: readonly ShelfGame[];
  disabled: boolean;
  authorized: boolean;
  onRestore(game: SourceBackupGame, expected: ShelfGame | undefined): Promise<boolean>;
};

export default function ImportedGameSourceBackup({ selected, games, disabled, authorized, onRestore }: Props) {
  const [candidate, setCandidate] = useState<{ game: SourceBackupGame; expected?: ShelfGame } | null>(null);
  const [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const generation = useRef(0);
  const inspect = async (file?: File) => {
    const token = ++generation.current;
    setCandidate(null); setConfirmed(false); setError(""); setNotice("");
    if (!file || disabled || !authorized) return;
    setBusy(true);
    try {
      if (file.size > MAX_SOURCE_BACKUP_BYTES) throw new Error("Source backups are limited to 40 MB.");
      const backup = parseImportedSourceBackup(await file.text());
      if (token !== generation.current) return;
      setCandidate({ game: backup.game, expected: games.find(game => game.id === backup.game.id) });
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Could not read source backup."); }
    finally { if (token === generation.current) setBusy(false); }
  };
  const exportSource = () => {
    if (!selected || disabled || !authorized) return;
    setError(""); setNotice("");
    let url: string | undefined;
    const link = document.createElement("a");
    try {
      url = URL.createObjectURL(new Blob([createImportedSourceBackup(selected)], { type: "application/json" }));
      link.href = url;
      link.download = `${selected.name.replace(/[<>:"/\\|?*\u0000-\u001f]/g, "_").slice(0, 100) || "game"}.arena-source.json`;
      document.body.appendChild(link); link.click();
      setNotice("Source backup downloaded. Keep a separate progress backup for gameplay saves.");
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Could not export source backup."); }
    finally { link.remove(); if (url) setTimeout(() => URL.revokeObjectURL(url!), 1000); }
  };
  const restore = async () => {
    if (!candidate || !confirmed || disabled || busy || !authorized) return;
    setBusy(true); setError(""); setNotice("");
    try {
      if (await onRestore(candidate.game, candidate.expected)) {
        setCandidate(null); setConfirmed(false);
        setNotice("Game source and rollback copies restored locally. Saved gameplay progress was not replaced.");
      } else setError("Source was not restored. Check the shelf warning, refresh if needed, and choose the backup again.");
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Source restore failed. Existing games are unchanged."); }
    finally { setBusy(false); }
  };
  const stale = !!candidate && games.find(game => game.id === candidate.game.id) !== candidate.expected;
  const buttonClass = "min-h-11 rounded-lg border border-sky-300/25 px-3 py-2 text-xs font-bold text-sky-100 disabled:opacity-40";
  return (
    <details className="mt-3 rounded-xl border border-white/10 bg-black/20 p-3" data-testid="imported-source-backup">
      <summary className="cursor-pointer text-xs font-bold text-slate-100">HTML source backup · game and rollback copies</summary>
      <p className="mt-2 text-[11px] text-slate-400">A local, versioned file with embedded assets, attribution, stable game identity and retained revisions. No upload, ROMs or gameplay progress. Accept the permission checkbox above to export or restore.</p>
      <div className="mt-3 flex flex-wrap items-center gap-3">
        <button type="button" className={buttonClass} disabled={!selected || disabled || busy || !authorized} onClick={exportSource} data-testid="button-export-imported-source">Export source backup</button>
        <label className="text-[11px] text-slate-300">Choose source backup
          <input type="file" accept=".json,application/json" disabled={disabled || busy || !authorized} data-testid="input-imported-source-backup" className="mt-1 block max-w-full text-[11px]" onChange={event => { void inspect(event.target.files?.[0]); event.currentTarget.value = ""; }} />
        </label>
      </div>
      {busy && <p role="status" className="mt-2 text-xs text-sky-100">Preparing source backup…</p>}
      {candidate && <div className="mt-3 space-y-2 rounded-lg border border-amber-300/25 p-3" data-testid="imported-source-restore-preview">
        <p className="break-words text-xs text-slate-100">{candidate.game.name} · {getImportedRevisionHistory(candidate.game).length} rollback copies{candidate.game.revisionUndoSource !== undefined ? " · pending edit undo included" : ""}</p>
        <p className="text-[11px] text-amber-100">{candidate.expected ? `Identity collision: this replaces source, attribution and revisions for “${candidate.expected.name}”.` : "This adds the game with its original identity."} Gameplay saves are not changed. Existing saves for this identity may be incompatible with the restored source. Keep a progress backup separately.</p>
        {stale && <p role="alert" className="text-xs text-red-200">This game changed since the preview. Choose the backup again.</p>}
        <label className="flex items-start gap-2 text-[11px] text-amber-100"><input type="checkbox" checked={confirmed} onChange={event => setConfirmed(event.target.checked)} />{candidate.expected ? "Replace this game's source and all retained revisions." : "Add this game and its retained revisions to my local shelf."}</label>
        <div className="flex flex-wrap gap-2">
          <button type="button" className={buttonClass} disabled={!confirmed || stale || disabled || busy || !authorized} onClick={() => void restore()} data-testid="button-restore-imported-source">{candidate.expected ? "Overwrite source from backup" : "Restore source backup"}</button>
          <button type="button" className={buttonClass} disabled={busy} onClick={() => { generation.current++; setCandidate(null); setConfirmed(false); }}>Cancel source restore</button>
        </div>
      </div>}
      {error && <p role="alert" className="mt-2 text-xs text-red-200">{error}</p>}
      {notice && <p role="status" className="mt-2 text-xs text-emerald-100">{notice}</p>}
    </details>
  );
}
