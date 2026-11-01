import { useEffect, useRef, useState } from "react";
import { getNativeBridge } from "./nativeArcadeTypes";

type Snapshot = {
  status: "not-prepared" | "prepared-unverified" | "repair-needed";
  candidate: boolean; diagnostic?: string; version?: string; archiveSha256?: string;
  coreFiles?: number; rollbackAvailable: boolean; log?: string;
  launchSupported?: boolean;
  canLaunch?: boolean;
  launchBytes?: number;
  plugins?: { revision: number; rollbackAvailable: boolean; diagnostic: string; assemblies: {
    id: string; enabled: boolean; sha256: string; license: string;
    metadata: { version: string; plugins: { id: string; name: string; version: string;
      requires: { id: string; minimum: string | null; soft: boolean }[]; incompatible: string[]; processes: string[] }[] };
  }[] };
  run?: { id: string; phase: string; logs: string[]; exitCode?: number } | null;
};
type Props = { gameId: string; profileId: string; shareSaves: boolean; locked: boolean };

export default function BepInExProfileControls({ gameId, profileId, shareSaves, locked }: Props) {
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [license, setLicense] = useState("");
  const [authorized, setAuthorized] = useState(false);
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

  async function run(op: string, extra: Record<string, unknown> = {}) {
    const bridge = getNativeBridge();
    if (!bridge?.workshop || inflight.current || busy || locked || shareSaves) return;
    const token = ++serial.current;
    inflight.current = true;
    setBusy(true); setError("");
    try {
      if (op === "loader-stop" && snapshot?.run) await bridge.stop(snapshot.run.id);
      const result = await bridge.workshop({ op: op === "loader-stop" ? "loader-inspect" : op, key, profileId,
        revision: snapshot?.plugins?.revision, ...extra });
      if (serial.current === token) setSnapshot(result as Snapshot);
    } catch (cause) {
      if (serial.current === token) setError(cause instanceof Error ? cause.message : "Loader preparation failed.");
    } finally { if (serial.current === token) { setBusy(false); inflight.current = false; } }
  }
  const running = !!snapshot?.run && ["starting", "process-started"].includes(snapshot.run.phase);
  useEffect(() => {
    if (!running || busy || locked) return;
    const token = serial.current;
    let pending = false;
    const timer = window.setInterval(() => {
      const bridge = getNativeBridge();
      if (!bridge?.workshop || pending || inflight.current) return;
      pending = true;
      void bridge.workshop({ op: "loader-run", key, profileId }).then(async result => {
        if (serial.current !== token) return;
        const next = result as Snapshot["run"];
        if (!next || !["starting", "process-started"].includes(next.phase)) {
          // One full refresh after exit restores launch/edit availability and
          // reads the final loader log. Do not hash the game every poll.
          inflight.current = true; setBusy(true);
          try {
            const refreshed = await bridge.workshop({ op: "loader-inspect", key, profileId });
            if (serial.current === token) setSnapshot(refreshed as Snapshot);
          } finally { if (serial.current === token) { inflight.current = false; setBusy(false); } }
        } else setSnapshot(current => current ? { ...current, run: next } : current);
      }).catch(() => {}).finally(() => { pending = false; });
    }, 2000);
    return () => window.clearInterval(timer);
  }, [running, busy, locked, key, profileId]);
  const disabled = busy || locked || shareSaves;
  return (
    <section className="rounded-xl border border-white/10 bg-black/20 p-3" data-testid="workshop-bepinex">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h4 className="text-xs font-extrabold text-slate-200">BepInEx 5 · native plugins</h4>
        <span className="text-[10px] font-bold text-amber-200">
          {busy ? "Working…" : snapshot?.status === "repair-needed" ? "Repair needed" : snapshot?.status === "prepared-unverified" ? "Prepared · gameplay unverified" : "Not prepared"}
        </span>
      </div>
      <p className="mt-2 text-[11px] leading-relaxed text-slate-400">
        Import original managed DLLs, choose which ones run, then launch this profile through BepInEx.
        Repairs and rollbacks retain configuration and saves. Real gameplay compatibility is not yet verified.
      </p>
      {shareSaves ? <p className="mt-2 text-[11px] text-amber-200">Use a profile with its own saves for loader preparation.</p> : (
        <div className="mt-3 flex flex-wrap gap-2">
          <button type="button" disabled={disabled || running || !snapshot?.candidate} data-testid="workshop-loader-download"
            onClick={() => void run("loader-download")} className="rounded-lg bg-emerald-400 px-3 py-2 text-[11px] font-extrabold text-slate-950 disabled:opacity-40">
            Download BepInEx 5.4.23.2
          </button>
          <button type="button" disabled={disabled || running || !snapshot?.candidate} data-testid="workshop-loader-prepare"
            onClick={() => void run("loader-prepare")} className="rounded-lg border border-white/15 px-3 py-2 text-[11px] font-bold text-slate-200 disabled:opacity-40">
            Use offline loader ZIP…
          </button>
          <button type="button" disabled={disabled || running || !snapshot || snapshot.status === "not-prepared"} data-testid="workshop-loader-repair"
            onClick={() => void run("loader-repair")} className="rounded-lg border border-white/15 px-3 py-2 text-[11px] font-bold text-slate-200 disabled:opacity-40">Repair core</button>
          <button type="button" disabled={disabled || running || !snapshot?.rollbackAvailable} data-testid="workshop-loader-rollback"
            onClick={() => void run("loader-rollback")} className="rounded-lg border border-white/15 px-3 py-2 text-[11px] font-bold text-slate-200 disabled:opacity-40">Restore prior core</button>
          <button type="button" disabled={disabled} data-testid="workshop-loader-refresh"
            onClick={() => void run("loader-inspect")} className="rounded-lg px-3 py-2 text-[11px] text-slate-400 disabled:opacity-40">Refresh</button>
        </div>
      )}
      {error && <p role="alert" className="mt-2 text-xs text-red-200">{error}</p>}
      {snapshot?.diagnostic && <p className="mt-2 text-[11px] text-amber-200">{snapshot.diagnostic}</p>}
      {snapshot?.status !== "not-prepared" && snapshot?.plugins && !shareSaves && (
        <div className="mt-3 space-y-3 border-t border-white/10 pt-3">
          <div className="flex flex-wrap gap-2">
            <button type="button" disabled={disabled || running || !snapshot.canLaunch}
              onClick={() => void run("loader-launch")} data-testid="workshop-loader-launch"
              className="rounded-lg bg-emerald-400 px-3 py-2 text-[11px] font-extrabold text-slate-950 disabled:opacity-40">Launch with BepInEx</button>
            <button type="button" disabled={disabled || !running} onClick={() => void run("loader-stop")}
              className="rounded-lg border border-white/15 px-3 py-2 text-[11px] text-slate-200 disabled:opacity-40">Stop game</button>
            <button type="button" disabled={disabled || running} onClick={() => void run("plugin-repair")}
              className="rounded-lg border border-white/15 px-3 py-2 text-[11px] text-slate-200 disabled:opacity-40">Repair plugins</button>
            <button type="button" disabled={disabled || running || !snapshot.plugins.rollbackAvailable} onClick={() => void run("plugin-rollback")}
              className="rounded-lg border border-white/15 px-3 py-2 text-[11px] text-slate-200 disabled:opacity-40">Restore prior plugins</button>
          </div>
          {!snapshot.launchSupported && <p className="text-[11px] text-amber-200">Modded launch requires the Windows x64 native host and its LPAC/Job containment probe. No uncontained fallback is used.</p>}
          {snapshot.launchBytes !== undefined && <p className="text-[10px] text-slate-500">First launch caches a separate read-only game copy, about {(snapshot.launchBytes / 1048576).toFixed(1)} MiB. Only the latest launch copy per profile is kept; disk reserve and storage-budget checks apply.</p>}
          {snapshot.plugins.diagnostic && <p role="alert" className="text-xs text-amber-200">{snapshot.plugins.diagnostic}</p>}
          {snapshot.plugins.assemblies.map(assembly => (
            <div key={assembly.id} className="rounded-lg border border-white/10 p-2 text-[11px] text-slate-300">
              <label className="flex items-start gap-2">
                <input type="checkbox" checked={assembly.enabled} disabled={disabled || running}
                  onChange={event => void run("plugin-toggle", { id: assembly.id, enabled: event.target.checked })} />
                <span className="font-bold">{assembly.id} · {assembly.metadata.version}</span>
              </label>
              {assembly.metadata.plugins.length ? assembly.metadata.plugins.map(plugin => (
                <div className="mt-1 break-words" key={plugin.id}>
                  {plugin.name} · {plugin.version} · <code>{plugin.id}</code>
                  {plugin.requires.length > 0 && <p className="text-slate-400">Requires: {plugin.requires.map(dep => `${dep.id}${dep.minimum ? ` ≥ ${dep.minimum}` : ""}${dep.soft ? " (optional)" : ""}`).join(", ")}</p>}
                  {plugin.incompatible.length > 0 && <p className="text-amber-200">Incompatible: {plugin.incompatible.join(", ")}</p>}
                  {plugin.processes.length > 0 && <p>Games: {plugin.processes.join(", ")}</p>}
                </div>
              )) : <p className="mt-1 text-slate-400">Managed dependency assembly; no plugin entry class.</p>}
              <details className="mt-1 text-[10px] text-slate-500"><summary className="cursor-pointer">Integrity and permission</summary>
                <p className="break-all">SHA-256 {assembly.sha256}</p><p>{assembly.license}</p>
              </details>
            </div>
          ))}
          {!snapshot.plugins.assemblies.length && <p className="text-[11px] text-slate-400">No DLLs imported. New imports start disabled.</p>}
          <form className="space-y-2" onSubmit={event => {
            event.preventDefault(); void run("plugin-import", { license, authorized });
          }}>
            <label className="block text-[11px] text-slate-400">Plugin license/use terms
              <input value={license} onChange={event => setLicense(event.target.value)} maxLength={1000}
                placeholder="For example: MIT; source license retained with my download"
                className="mt-1 w-full rounded-lg border border-white/15 bg-slate-950 px-2 py-2 text-xs text-slate-100" />
            </label>
            <label className="flex items-start gap-2 text-[11px] text-slate-300">
              <input type="checkbox" checked={authorized} onChange={event => setAuthorized(event.target.checked)} />
              I have permission to use this plugin and understand it executes native managed code in the game sandbox.
            </label>
            <button type="submit" disabled={disabled || running || !authorized || !license.trim()}
              className="rounded-lg border border-white/15 px-3 py-2 text-[11px] font-bold text-slate-200 disabled:opacity-40">Import or update DLL…</button>
          </form>
          <p className="text-[10px] text-slate-500">Managed BepInEx 5 DLLs only. Multi-file asset packs, native DLLs, preloader patchers, installer hooks, IL2CPP and MelonLoader are not supported by this importer.</p>
          {snapshot.run && <div role="status" className="text-[11px] text-slate-300">
            Game process: {snapshot.run.phase}{snapshot.run.exitCode !== undefined ? ` · exit ${snapshot.run.exitCode}` : ""} · gameplay unverified
            <pre className="mt-1 max-h-32 overflow-auto whitespace-pre-wrap text-[10px] text-slate-400">{snapshot.run.logs.slice(-8).join("\n")}</pre>
          </div>}
        </div>
      )}
      {snapshot?.archiveSha256 && <details className="mt-2 text-[10px] text-slate-400">
        <summary className="cursor-pointer">Verified archive and loader log</summary>
        <p className="mt-2 break-all">BepInEx {snapshot.version} · {snapshot.coreFiles} core files · SHA-256 {snapshot.archiveSha256}</p>
        <pre className="mt-2 max-h-40 overflow-auto whitespace-pre-wrap">{snapshot.log || "No loader log yet. Archive preparation is not a game launch."}</pre>
      </details>}
    </section>
  );
}
