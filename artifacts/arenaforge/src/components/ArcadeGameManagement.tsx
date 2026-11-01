import { useEffect, useRef, useState } from "react";
import { currentArcadeEvidence, type ArcadeStage } from "../lib/arcadeManifest";
import { discoverArcadeRuntimeAdapters } from "../lib/arcadeRuntimeAdapters";
import type { useArcadeManagement } from "../lib/useArcadeManagement";
import { readArcadeMetadataRecovery } from "../lib/arcadeManifestStorage";

export default function ArcadeGameManagement({ management }: { management: ReturnType<typeof useArcadeManagement> }) {
  const { manifest, host, error, busy, compatibility, adapter } = management;
  const [startup, setStartup] = useState(false);
  const [gameplay, setGameplay] = useState(false);
  const [provision, setProvision] = useState("");
  const epoch = useRef(0);
  useEffect(() => { epoch.current++; setStartup(false); setGameplay(false); setProvision(""); return () => { epoch.current++; }; }, [manifest?.id, manifest?.installedVersion, manifest?.runtime.id]);
  const exportValue = (value: unknown, filename: string) => {
    const url = URL.createObjectURL(new Blob([JSON.stringify(value, null, 2)], { type: "application/json" }));
    const link = document.createElement("a");
    link.href = url; link.download = filename; document.body.append(link); link.click(); link.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
  const exportManifest = () => {
    if (!manifest) return;
    exportValue(manifest, "arena-game-manifest.json");
  };
  return <details className="rounded-xl border border-white/10 bg-black/20 p-3 text-xs text-slate-300" data-testid="arcade-game-management">
    <summary className="cursor-pointer font-semibold text-slate-100">Game runtime, progress locations and diagnostics</summary>
    <p className="mt-2 text-[11px] leading-relaxed text-slate-400">Local management metadata only. Import ownership, source, controls and save identities are retained. A loaded runtime is not proof that a game works. AI model readiness is separate.</p>
    {error && <p role="alert" className="mt-2 break-words text-amber-200">{error} Original source and saves have not been removed.</p>}
    {!manifest ? <div className="mt-2">
      <p role="status">{busy ? "Preparing versioned metadata…" : "No manifest is available. Original game data is retained."}</p>
      {!busy && <button type="button" onClick={() => void management.rebuild()} className="mt-2 min-h-11 rounded-lg border border-white/15 px-3 py-2">Retry metadata</button>}
    </div> : <>
      <dl className="mt-3 grid grid-cols-1 gap-2 break-words sm:grid-cols-2">
        <div><dt className="text-slate-500">Runtime</dt><dd>{adapter?.definition.name ?? manifest.runtime.id} · {manifest.runtime.version} · {manifest.runtime.profile}</dd></div>
        <div><dt className="text-slate-500">Host</dt><dd>{host.kind} · {host.platform}. Native architecture is not verified.</dd></div>
        <div><dt className="text-slate-500">Game version</dt><dd className="break-all font-mono text-[10px]">{manifest.installedVersion}</dd></div>
        <div><dt className="text-slate-500">Source / license</dt><dd>{manifest.provenance.origin} · {manifest.license.status}. {manifest.sourceRevisionCopies} preserved source copies.</dd></div>
        <div><dt className="text-slate-500">Progress locations</dt><dd className="break-all">{manifest.locations.saves.join("; ")}</dd></div>
        <div><dt className="text-slate-500">Permissions</dt><dd>{manifest.permissions.execution}; network: {manifest.permissions.network}; storage: {manifest.permissions.filesystem}</dd></div>
      </dl>
      {compatibility?.blockers.map(message => <p key={message} role="alert" className="mt-2 text-red-200">{message}</p>)}
      {compatibility?.warnings.map(message => <p key={message} className="mt-2 text-amber-100">{message}</p>)}
      {adapter && <div className="mt-3 space-y-1 text-[11px]">
        <p>{adapter.definition.provision.detail}</p>
        {Object.entries(adapter.definition.interfaces).map(([key, value]) => <p key={key}><strong className="text-slate-200">{key}:</strong> {value}</p>)}
        <p><strong>Recovery:</strong> {adapter.definition.recovery}</p>
      </div>}
      <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-5">
        {(["downloaded", "installed", "built", "startup", "gameplay"] as ArcadeStage[]).map(stage => {
          const evidence = currentArcadeEvidence(manifest, host, stage);
          return <div key={stage} className="rounded-lg border border-white/10 p-2" data-testid={`arcade-evidence-${stage}`}>
            <strong className="block capitalize">{stage}</strong>
            <span>{evidence ? `${evidence.outcome} · ${evidence.origin}` : "Not verified on this host/version"}</span>
          </div>;
        })}
      </div>
      <p className="mt-2 text-[11px] text-slate-400">Downloaded, installed, built, startup and gameplay are independent. Historical or other-host evidence does not verify this run. Player observations below are labeled as such, not automated tests.</p>
      <div className="mt-3 space-y-2">
        <label className="flex items-start gap-2"><input type="checkbox" checked={startup} onChange={event => setStartup(event.target.checked)} />I observed this game open without a startup error.</label>
        <label className="flex items-start gap-2"><input type="checkbox" checked={gameplay} onChange={event => setGameplay(event.target.checked)} />I tested meaningful gameplay input and progress after restarting.</label>
        <div className="flex flex-wrap gap-2">
          <button type="button" disabled={busy || !startup || !compatibility?.available} onClick={() => void management.observe(gameplay ? "gameplay" : "startup", gameplay ? "Player reports testing gameplay controls and progress after restart." : "Player reports observing startup without errors.")} className="min-h-11 rounded-lg border border-emerald-300/25 px-3 py-2 disabled:opacity-40">Record my observation</button>
          <button type="button" onClick={exportManifest} className="min-h-11 rounded-lg border border-white/15 px-3 py-2">Export metadata</button>
          <button type="button" disabled={busy} onClick={() => {
            const token = epoch.current;
            void readArcadeMetadataRecovery(manifest).then(value => { if (token === epoch.current) exportValue(value, "arena-metadata-recovery.json"); })
              .catch(cause => { if (token === epoch.current) setProvision(cause instanceof Error ? cause.message : "Could not export recovery metadata."); });
          }} className="min-h-11 rounded-lg border border-white/15 px-3 py-2 disabled:opacity-40">Export recovery metadata</button>
          <button type="button" disabled={busy} onClick={() => { if (window.confirm("Rebuild this version's runtime metadata and observations? Source, revision history and progress will not change. Previous metadata is retained for recovery.")) void management.rebuild(); }} className="min-h-11 rounded-lg border border-white/15 px-3 py-2 disabled:opacity-40">Rebuild metadata</button>
          <button type="button" disabled={busy || !adapter} onClick={() => {
            const token = epoch.current; setProvision("Checking runtime requirements…");
            void adapter?.provision(host).then(result => { if (token === epoch.current) setProvision(`${result.state}: ${result.detail}`); })
              .catch(cause => { if (token === epoch.current) setProvision(cause instanceof Error ? cause.message : "Runtime availability check failed."); });
          }} className="min-h-11 rounded-lg border border-white/15 px-3 py-2 disabled:opacity-40">Check runtime module</button>
        </div>
        {provision && <p role="status" className="text-sky-100">{provision}</p>}
      </div>
    </>}
    <details className="mt-3"><summary className="cursor-pointer">Registered execution adapters</summary>
      <ul className="mt-2 space-y-2">{discoverArcadeRuntimeAdapters().map(item => <li key={item.definition.id}>{item.definition.name} · {item.definition.version} · {item.definition.provision.mode}. Per-game compatibility remains separate.</li>)}</ul>
    </details>
  </details>;
}
