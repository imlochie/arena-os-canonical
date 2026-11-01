import { useEffect, useRef, useState } from "react";
import { getNativeBridge } from "./nativeArcadeTypes";

type Snapshot = {
  status: "not-prepared" | "prepared-unverified" | "repair-needed";
  candidate: boolean; diagnostic?: string; version?: string; archiveSha256?: string;
  coreFiles?: number; rollbackAvailable: boolean; log?: string;
};
type Props = { gameId: string; profileId: string; shareSaves: boolean; locked: boolean };

export default function BepInExProfileControls({ gameId, profileId, shareSaves, locked }: Props) {
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const serial = useRef(0);
  const inflight = useRef(false);
  const key = gameId.slice("native:".length);
  useEffect(() => {
    const token = ++serial.current;
    inflight.current = false;
    setSnapshot(null); setError(""); setBusy(false);
    if (shareSaves) return;
    const bridge = getNativeBridge();
    if (!bridge?.workshop) return;
    inflight.current = true;
    setBusy(true);
    void bridge.workshop({ op: "loader-inspect", key, profileId }).then(result => {
      if (serial.current === token) setSnapshot(result as Snapshot);
    }, cause => {
      if (serial.current === token) setError(cause instanceof Error ? cause.message : "Loader inspection failed.");
    }).finally(() => { if (serial.current === token) { setBusy(false); inflight.current = false; } });
    return () => { serial.current++; inflight.current = false; };
  }, [key, profileId, shareSaves]);

  async function run(op: string) {
    const bridge = getNativeBridge();
    if (!bridge?.workshop || inflight.current || busy || locked || shareSaves) return;
    const token = ++serial.current;
    inflight.current = true;
    setBusy(true); setError("");
    try {
      const result = await bridge.workshop({ op, key, profileId });
      if (serial.current === token) setSnapshot(result as Snapshot);
    } catch (cause) {
      if (serial.current === token) setError(cause instanceof Error ? cause.message : "Loader preparation failed.");
    } finally { if (serial.current === token) { setBusy(false); inflight.current = false; } }
  }
  const disabled = busy || locked || shareSaves;
  return (
    <section className="rounded-xl border border-white/10 bg-black/20 p-3" data-testid="workshop-bepinex">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h4 className="text-xs font-extrabold text-slate-200">BepInEx 5 · profile preparation</h4>
        <span className="text-[10px] font-bold text-amber-200">
          {busy ? "Checking…" : snapshot?.status === "repair-needed" ? "Repair needed" : snapshot?.status === "prepared-unverified" ? "Prepared · not activated" : "Not prepared"}
        </span>
      </div>
      <p className="mt-2 text-[11px] leading-relaxed text-slate-400">
        Prepare a verified loader core for this profile only. This does not yet enable plugin installation or modded Play.
        Configuration, logs and game saves are retained during repair and core rollback.
      </p>
      {shareSaves ? <p className="mt-2 text-[11px] text-amber-200">Use a profile with its own saves for loader preparation.</p> : (
        <div className="mt-3 flex flex-wrap gap-2">
          <button type="button" disabled={disabled || !snapshot?.candidate} data-testid="workshop-loader-prepare"
            onClick={() => void run("loader-prepare")} className="rounded-lg border border-white/15 px-3 py-2 text-[11px] font-bold text-slate-200 disabled:opacity-40">
            Select pinned loader ZIP…
          </button>
          <button type="button" disabled={disabled || !snapshot || snapshot.status === "not-prepared"} data-testid="workshop-loader-repair"
            onClick={() => void run("loader-repair")} className="rounded-lg border border-white/15 px-3 py-2 text-[11px] font-bold text-slate-200 disabled:opacity-40">Repair core</button>
          <button type="button" disabled={disabled || !snapshot?.rollbackAvailable} data-testid="workshop-loader-rollback"
            onClick={() => void run("loader-rollback")} className="rounded-lg border border-white/15 px-3 py-2 text-[11px] font-bold text-slate-200 disabled:opacity-40">Restore prior core</button>
          <button type="button" disabled={disabled} data-testid="workshop-loader-refresh"
            onClick={() => void run("loader-inspect")} className="rounded-lg px-3 py-2 text-[11px] text-slate-400 disabled:opacity-40">Refresh</button>
        </div>
      )}
      {error && <p role="alert" className="mt-2 text-xs text-red-200">{error}</p>}
      {snapshot?.diagnostic && <p className="mt-2 text-[11px] text-amber-200">{snapshot.diagnostic}</p>}
      {snapshot?.archiveSha256 && <details className="mt-2 text-[10px] text-slate-400">
        <summary className="cursor-pointer">Verified archive and loader log</summary>
        <p className="mt-2 break-all">BepInEx {snapshot.version} · {snapshot.coreFiles} core files · SHA-256 {snapshot.archiveSha256}</p>
        <pre className="mt-2 max-h-40 overflow-auto whitespace-pre-wrap">{snapshot.log || "No loader log yet. Archive preparation is not a game launch."}</pre>
      </details>}
    </section>
  );
}
