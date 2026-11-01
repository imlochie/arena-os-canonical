import { useCallback, useEffect, useRef, useState } from "react";
import { nativeWindowsAdapter } from "../lib/arcadeRuntimeAdapters";
import {
  formatBytes,
  getNativeBridge,
  keyOf,
  type NativeArcadeBridge,
  type NativeSnapshot,
} from "./nativeArcadeTypes";

const POLL_MS = 2000;
const LOG_LINES = 40;
const TERMINAL_JOB = new Set(["installed", "failed", "cancelled", "interrupted"]);
const ACTIVE_RUN = new Set(["starting", "process-started", "running", "launching", "stopping"]);

const btn =
  "rounded-lg border border-white/10 bg-white/5 px-3 py-1.5 text-[11px] font-extrabold text-slate-200 hover:bg-white/10 disabled:cursor-not-allowed disabled:opacity-40";

export default function NativeGamesWorkspace() {
  const [bridge] = useState<NativeArcadeBridge | null>(() => getNativeBridge());
  const [snap, setSnap] = useState<NativeSnapshot | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState<string | null>(null);
  const mounted = useRef(true);
  const polling = useRef(false);
  const seq = useRef(0);

  const accept = useCallback((s: NativeSnapshot, id: number) => {
    if (!mounted.current || id < seq.current) return;
    seq.current = id;
    setSnap(s);
  }, []);

  const poll = useCallback(async () => {
    if (!bridge || polling.current || document.hidden) return;
    polling.current = true;
    const id = ++seq.current;
    try {
      accept(await bridge.inspect(), id);
      if (mounted.current) setError((e) => (e?.startsWith("Status:") ? null : e));
    } catch (e) {
      if (mounted.current) setError(`Status: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      polling.current = false;
    }
  }, [bridge, accept]);

  useEffect(() => {
    mounted.current = true;
    void poll();
    const t = window.setInterval(() => void poll(), POLL_MS);
    return () => { mounted.current = false; window.clearInterval(t); };
  }, [poll]);

  const run = async (label: string, fn: (b: NativeArcadeBridge) => Promise<NativeSnapshot>) => {
    if (!bridge) return;
    setPending(label);
    setError(null);
    const id = ++seq.current;
    try {
      accept(await fn(bridge), id);
    } catch (e) {
      if (mounted.current) setError(e instanceof Error ? e.message : String(e));
    } finally {
      if (mounted.current) setPending(null);
    }
  };

  if (!bridge) {
    return (
      <section className="glass mt-4 rounded-2xl p-5" aria-labelledby="native-title">
        <h2 id="native-title" className="text-sm font-extrabold text-white">Native games</h2>
        <p className="mt-2 text-xs text-slate-300">
          Native games require the Arena Arcade Windows desktop app. This preview has no native bridge, so nothing can be installed or launched here.
        </p>
        <p className="mt-1 text-xs text-slate-400">Browser games in Create and Import still work in this preview.</p>
      </section>
    );
  }

  const req = snap?.requirements;
  const busy = !!pending || !!snap?.packages.busy || !!snap?.operation;
  const canLaunchHost = !!req?.supportedHost && !!req?.verified;
  const pkgs = snap?.packages.packages ?? {};
  const installed = (k: string) => pkgs[k]?.phase === "ready";
  const runtimeKeys = new Set((snap?.packages.catalog ?? []).filter((d) => d.kind === "runtime").map(keyOf));
  const st = snap?.storage;

  return (
    <section className="glass mt-4 space-y-4 rounded-2xl p-4 sm:p-5" aria-labelledby="native-title" aria-busy={busy}>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 id="native-title" className="text-sm font-extrabold text-white">Native games</h2>
          <p className="mt-1 text-[11px] text-slate-400">
            Each install, launch and removal asks for separate desktop confirmation. Installed does not mean playable, and a started process does not prove gameplay.
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <button type="button" className={btn} disabled={busy || !req?.supportedHost} onClick={() => run("probe", (b) => b.probe())}>
            {pending === "probe" ? "Probing..." : "Run containment probe"}
          </button>
          <button type="button" className={btn} disabled={!snap?.canCancel} onClick={() => run("cancel", (b) => b.cancel())}>
            Cancel operation
          </button>
        </div>
      </div>

      <div role="status" aria-live="polite" className="text-[11px]">
        {!snap && !error && <span className="text-slate-400">Reading native host status...</span>}
        {pending && <span className="text-amber-300">Working: {pending}. Approve or cancel the desktop dialog if shown.</span>}
        {error && <p className="text-rose-300">{error}{snap ? " Last known status kept." : ""}</p>}
      </div>

      {req && (
        <div className="rounded-xl border border-white/10 bg-black/30 p-3 text-[11px]">
          <p className="font-bold text-slate-200">
            Platform: {req.supportedHost ? "Windows x64 candidate" : "unsupported"} / containment {req.verified ? "verified by live probe" : "not verified"} / {req.backend}
          </p>
          <p className="mt-1 text-slate-400">{req.message}</p>
          <p className="mt-1 break-words font-mono text-[10px] text-slate-500">
            {Object.entries(req.limits).map(([k, v]) => `${k}: ${v}`).join("  ")}
          </p>
          {!canLaunchHost && <p className="mt-1 text-amber-300">Launch stays blocked until the host is supported and the containment probe succeeds.</p>}
        </div>
      )}

      {st && (
        <p className="break-words font-mono text-[10px] text-slate-400">
          downloads {formatBytes(st.downloads)} / staging {formatBytes(st.staging)} / installed {formatBytes(st.installed)} / profiles {formatBytes(st.profiles)} / cache {formatBytes(st["build-cache"])} / free {formatBytes(st.freeBytes)} (reserve {formatBytes(st.reserveBytes)}, budget {formatBytes(st.budgetBytes)})
        </p>
      )}
      {st?.warning && <p className="text-xs text-amber-300">{st.warning}</p>}

      {snap && snap.packages.catalog.length === 0 && (
        <p className="text-xs text-slate-400">This build ships no trusted native catalog entries.</p>
      )}

      <ul className="space-y-2">
        {snap?.packages.catalog.map((d) => {
          const k = keyOf(d);
          const state = pkgs[k];
          const missing = d.runtimes.filter((r) => !installed(r));
          const active = snap.runs.some((r) => r.key === k && ACTIVE_RUN.has(r.phase));
          const anyActive = snap.runs.some((r) => ACTIVE_RUN.has(r.phase));
          const referenced = d.kind === "runtime" && snap.packages.catalog.some(game => installed(keyOf(game)) && game.runtimes.includes(k));
          const launchBlock = !canLaunchHost ? "host not verified" : !installed(k) ? "not installed" : missing.length ? `install runtime ${missing.join(", ")} first` : anyActive ? "stop the current native game first" : null;
          return (
            <li key={k} className="rounded-xl border border-white/10 bg-white/[0.03] p-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="min-w-0">
                  <p className="break-all text-xs font-extrabold text-white">{d.id} <span className="font-mono text-slate-400">{d.version}</span> <span className="ml-1 rounded bg-white/10 px-1.5 text-[10px] uppercase text-slate-300">{d.kind}</span></p>
                  <p className="text-[10px] text-slate-400">{d.license} / download {formatBytes(d.downloadBytes)} / unpacked {formatBytes(d.unpackedBytes)}</p>
                  <p className="text-[10px] text-slate-300">State: {state?.phase ?? "not installed"}{state?.detail ? ` - ${state.detail}` : ""}</p>
                  {d.runtimes.length > 0 && (
                    <p className="text-[10px] text-slate-400">
                      Needs: {d.runtimes.map((r) => `${r} (${installed(r) ? "installed" : runtimeKeys.has(r) ? "missing" : "not in catalog"})`).join(", ")}
                    </p>
                  )}
                </div>
                <div className="flex flex-wrap gap-2">
                  {!installed(k) && (
                    <button type="button" className={btn} disabled={busy} aria-label={`Install ${k}`} onClick={() => run(`install ${k}`, (b) => b.install(k))}>Install</button>
                  )}
                  {d.kind === "game" && (
                    <button type="button" className={btn} disabled={busy || !!launchBlock || active} title={launchBlock ?? undefined} aria-label={`Launch ${k}`} onClick={() => run(`launch ${k}`, async (b) => { await nativeWindowsAdapter.launch({ key: k, bridge: b }); return b.inspect(); })}>Launch</button>
                  )}
                  {snap.packages.packages[k] && snap.packages.packages[k].phase !== "removed" && (
                    <button type="button" className={btn} disabled={busy || active || referenced} title={referenced ? "Remove games referencing this runtime first" : undefined} aria-label={`Remove ${k}`} onClick={() => run(`remove ${k}`, (b) => b.remove(k))}>Remove</button>
                  )}
                </div>
              </div>
              {d.kind === "game" && launchBlock && <p className="mt-1 text-[10px] text-amber-300/80">Launch blocked: {launchBlock}.</p>}
              {snap.managedGames?.find(game => game.launch.entryRef === `desktop-catalog:${k}`) && (
                <button type="button" className={`${btn} mt-2`} onClick={() => {
                  const manifest = snap.managedGames.find(game => game.launch.entryRef === `desktop-catalog:${k}`);
                  const url = URL.createObjectURL(new Blob([JSON.stringify(manifest, null, 2)], { type: "application/json" }));
                  const link = document.createElement("a"); link.href = url; link.download = `${k}.manifest.json`; link.click();
                  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
                }}>Export management metadata</button>
              )}
            </li>
          );
        })}
      </ul>
      {Object.keys(pkgs).some(key => !snap?.packages.catalog.some(d => keyOf(d) === key)) && (
        <p className="break-all text-xs text-amber-300">
          Retained from another build (not executable without its trusted descriptor): {Object.keys(pkgs).filter(key => !snap?.packages.catalog.some(d => keyOf(d) === key)).join(", ")}
        </p>
      )}

      {snap?.repository && (snap.repository.jobs.length > 0 || snap.repository.projects.length > 0 || snap.repository.toolPins.length > 0) && (
        <div className="space-y-2" aria-labelledby="native-repo-title">
          <h3 id="native-repo-title" className="text-xs font-extrabold text-slate-200">Source builds</h3>
          <p className="text-[10px] text-slate-500">Built and installed means the build finished. Startup and gameplay are not verified. Saves live in profiles, separate from versions.</p>
          {snap.repository.toolPins.length > 0 && (
            <p className="break-words font-mono text-[10px] text-slate-400" title="Downloaded on demand into Arcade's build cache; nothing is installed system-wide.">
              SDK pins (on demand, not global): {snap.repository.toolPins.map(p => `${p.id} ${p.version} · ${formatBytes(p.bytes)} · ${p.license}`).join("  /  ")}
              {bridge?.resetBuildTool && <span className="mt-2 flex flex-wrap gap-2">{snap.repository.toolPins.map(p =>
                <button key={p.id} type="button" className={btn} disabled={busy}
                  onClick={() => run(`reset ${p.id} SDK`, b => b.resetBuildTool!(p.id))}>Reset {p.id} SDK cache</button>)}</span>}
            </p>
          )}
          {snap.repository.jobs.slice(-6).reverse().map(j => (
            <div key={j.id} className="rounded-xl border border-white/10 bg-black/30 p-3">
              <p className="break-all text-[11px] font-bold text-white">{j.repository} <span className="font-mono text-slate-400">{j.revision.slice(0, 10)}</span> <span className={TERMINAL_JOB.has(j.phase) ? (j.phase === "installed" ? "text-emerald-200" : "text-rose-300") : "text-amber-200"}>/ {j.phase}{TERMINAL_JOB.has(j.phase) ? "" : "…"}</span></p>
              {j.detail && <p className="mt-0.5 text-[10px] text-slate-300">{j.detail}</p>}
              <p className="text-[10px] text-slate-500">Started {new Date(j.createdAt).toLocaleString()}{j.key ? ` · ${j.key}` : ""}</p>
              {j.log && (
                <details className="mt-1">
                  <summary className="cursor-pointer text-[10px] text-slate-300">Build log</summary>
                  <pre className="mt-1 max-h-40 overflow-auto whitespace-pre-wrap break-all rounded bg-black/40 p-2 font-mono text-[10px] text-slate-300">
                    {j.log.split("\n").slice(-LOG_LINES * 5).join("\n")}
                  </pre>
                </details>
              )}
            </div>
          ))}
          {snap.repository.projects.map(p => {
            const versions = [...p.versions].sort((a, b) => b.builtAt - a.builtAt);
            const select = bridge.selectRepositoryVersion?.bind(bridge);
            return (
              <div key={p.id} className="rounded-xl border border-white/10 bg-white/[0.03] p-3">
                <p className="break-all text-xs font-extrabold text-white">{p.repository}{p.folder ? <span className="font-normal text-slate-400"> / {p.folder}</span> : null}</p>
                <ul className="mt-2 space-y-1.5">
                  {versions.map(v => {
                    const isActive = v.key === p.activeKey;
                    const present = pkgs[v.key]?.phase === "ready";
                    return (
                      <li key={v.key} className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-white/5 bg-black/20 px-2 py-1.5">
                        <div className="min-w-0 text-[10px]">
                          <p className="text-slate-200"><span className="font-mono">{v.revision.slice(0, 10)}</span> · built {new Date(v.builtAt).toLocaleString()} {isActive && <span className="ml-1 rounded bg-emerald-300/15 px-1.5 font-bold text-emerald-200">active</span>}{!present && <span className="ml-1 rounded bg-rose-400/15 px-1.5 font-bold text-rose-200">removed</span>}</p>
                          <p className="break-all text-slate-500">{v.recipe} · {v.evidence} · {present ? "installed, startup and gameplay unverified" : "files not installed — reinstall or repair from its package card above"}</p>
                        </div>
                        {!isActive && present && (
                          <button type="button" className={btn} disabled={busy || !select} title={select ? undefined : "This desktop build cannot switch versions"}
                            aria-label={`Use version ${v.revision.slice(0, 10)} of ${p.repository}`}
                            onClick={() => select && run(`select ${v.key}`, () => select(v.key))}>
                            {pending === `select ${v.key}` ? "Switching..." : "Use this version"}
                          </button>
                        )}
                        {present && <button type="button" className={btn}
                          disabled={busy || snap.runs.some(r => r.phase === "starting" || r.phase === "process-started")}
                          title="Requires the verified Windows isolation driver; no host fallback"
                          aria-label={`Launch version ${v.revision.slice(0, 10)} of ${p.repository}`}
                          onClick={() => run(`launch ${v.key}`, async b => { await nativeWindowsAdapter.launch({ key: v.key, bridge: b }); return b.inspect(); })}>Launch</button>}
                      </li>
                    );
                  })}
                </ul>
              </div>
            );
          })}
        </div>
      )}

      {snap && snap.runs.length > 0 && (
        <div className="space-y-2">
          <h3 className="text-xs font-extrabold text-slate-200">Runs</h3>
          {snap.runs.slice(-8).reverse().map((r) => (
            <div key={r.id} className="rounded-xl border border-white/10 bg-black/30 p-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <p className="break-all text-[11px] font-bold text-white">{r.key} <span className="text-slate-400">/ {r.phase}</span></p>
                {ACTIVE_RUN.has(r.phase) && (
                  <button type="button" className={btn} disabled={pending === `stop ${r.id}`} title="Save in the game first. Stop requests window close, then forces termination after five seconds if needed." aria-label={`Stop run ${r.id}`} onClick={() => run(`stop ${r.id}`, async (b) => { await nativeWindowsAdapter.cleanup(Promise.resolve({ bridge: b, id: r.id })); return b.inspect(); })}>Stop</button>
                )}
              </div>
              <p className="text-[10px] text-slate-500">Gameplay not verified. Process state only.{r.profile ? ` Profile: ${r.profile}` : ""}</p>
              {r.logs.length > 0 && (
                <pre className="mt-2 max-h-40 overflow-auto whitespace-pre-wrap break-all rounded bg-black/40 p-2 font-mono text-[10px] text-slate-300">
                  {r.logs.slice(-LOG_LINES).join("\n")}
                </pre>
              )}
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
