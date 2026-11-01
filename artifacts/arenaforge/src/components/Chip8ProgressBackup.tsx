import { useEffect, useRef, useState } from "react";
import { createChip8ProgressBackup, inspectChip8ProgressBackup, MAX_CHIP8_BACKUP_BYTES, type Chip8ProgressState, type Chip8ProgressTarget } from "../lib/chip8ProgressBackup";

export default function Chip8ProgressBackup({ target, getSnapshot, onRestore, onPause }: {
  target: Chip8ProgressTarget; getSnapshot: () => Chip8ProgressState;
  onRestore: (snapshot: Chip8ProgressState) => void; onPause: (paused: boolean) => void;
}) {
  const [candidate, setCandidate] = useState<Awaited<ReturnType<typeof inspectChip8ProgressBackup>> | null>(null);
  const [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const generation = useRef(0);
  useEffect(() => {
    generation.current++;
    setCandidate(null); setConfirmed(false); setBusy(false); setError(""); setNotice("");
    onPause(false);
    return () => { generation.current++; onPause(false); };
  }, [target.gameId, target.rom, target.dialect, onPause]);
  const report = (cause: unknown) => setError(cause instanceof Error ? cause.message : "Snapshot operation failed.");
  const exportSnapshot = async () => {
    const token = ++generation.current;
    setBusy(true); setError(""); setNotice("");
    let url: string | undefined;
    const link = document.createElement("a");
    try {
      const backup = await createChip8ProgressBackup(target, getSnapshot());
      if (token !== generation.current) return;
      url = URL.createObjectURL(new Blob([JSON.stringify(backup)], { type: "application/json" }));
      link.href = url;
      link.download = `${target.name.replace(/\.[^.]+$/, "").replace(/[^a-z0-9_-]/gi, "-").slice(0, 80) || "chip8"}.arena-snapshot.json`;
      document.body.append(link); link.click();
      setNotice("Snapshot downloaded locally. Keep the matching original ROM too.");
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
    setBusy(true); setCandidate(null); setConfirmed(false); setError(""); setNotice(""); onPause(false);
    try {
      if (file.size > MAX_CHIP8_BACKUP_BYTES) throw new Error("Snapshot files must be no larger than 256 KiB.");
      const prepared = await inspectChip8ProgressBackup(await file.text(), target);
      if (token !== generation.current) return;
      setCandidate(prepared); onPause(true);
    } catch (cause) { if (token === generation.current) report(cause); }
    finally { if (token === generation.current) setBusy(false); }
  };
  const cancel = () => { generation.current++; setCandidate(null); setConfirmed(false); setError(""); onPause(false); };
  const restore = () => {
    if (!candidate || !confirmed || busy) return;
    setError(""); setNotice("");
    try {
      onRestore(candidate.backup.snapshot);
      setCandidate(null); setConfirmed(false); onPause(false);
      setNotice("Snapshot restored locally. ROM and other games are unchanged.");
    } catch (cause) { report(cause); }
  };
  return (
    <details className="rounded-lg border border-white/10 p-3" data-testid="chip8-progress-backup" onKeyDown={event => event.stopPropagation()} onKeyUp={event => event.stopPropagation()}>
      <summary className="cursor-pointer text-xs font-bold text-slate-200">Move progress between browsers</summary>
      <p className="mt-2 text-[11px] leading-relaxed text-slate-400">Snapshot files stay on your device and contain emulated memory, including program bytes. Nothing is uploaded. Restore requires the same ROM fingerprint and runtime profile; keep your original ROM.</p>
      <div className="mt-3 flex flex-wrap items-center gap-3">
        <button type="button" disabled={busy || !!candidate} onClick={() => void exportSnapshot()} className="min-h-11 rounded-lg border border-sky-300/25 px-3 py-2 text-xs font-bold text-sky-100 disabled:opacity-40" data-testid="button-export-chip8-snapshot">Export snapshot</button>
        <label className="text-[11px] text-slate-300">Choose snapshot file<input type="file" accept=".json,application/json" disabled={busy} className="mt-1 block max-w-full text-[11px]" data-testid="input-chip8-snapshot" onChange={event => { void inspect(event.target.files?.[0]); event.currentTarget.value = ""; }} /></label>
      </div>
      {busy && <p role="status" className="mt-2 text-xs text-sky-100">Checking local snapshot…</p>}
      {candidate && <div className="mt-3 space-y-2 rounded-lg border border-amber-300/25 bg-amber-300/5 p-3" data-testid="chip8-snapshot-preview">
        <p className="break-words text-xs font-semibold text-slate-200">{candidate.backup.name} · {candidate.backup.dialect === "schip" ? "Super-CHIP" : "Classic CHIP-8"} · saved {new Date(candidate.backup.exportedAt).toLocaleString()}</p>
        <p className="text-[11px] text-amber-100">Game paused while reviewing. Restore replaces this game's current run and saved progress. {candidate.sameIdentity ? "" : "This is a new import identity with an exact ROM match."}</p>
        <label className="flex items-start gap-2 text-[11px] text-amber-100"><input type="checkbox" checked={confirmed} onChange={event => setConfirmed(event.target.checked)} />Use this snapshot for this imported game and replace its current progress.</label>
        <div className="flex flex-wrap gap-2">
          <button type="button" disabled={!confirmed || busy} onClick={restore} className="min-h-11 rounded-lg bg-sky-300 px-3 py-2 text-xs font-bold text-slate-950 disabled:opacity-40" data-testid="button-restore-chip8-snapshot">Restore snapshot</button>
          <button type="button" onClick={cancel} className="min-h-11 rounded-lg border border-white/15 px-3 py-2 text-xs text-slate-300">Cancel snapshot restore</button>
        </div>
      </div>}
      {error && <p role="alert" className="mt-2 text-xs text-red-200">{error}</p>}
      {notice && <p role="status" className="mt-2 text-xs text-emerald-100">{notice}</p>}
    </details>
  );
}
