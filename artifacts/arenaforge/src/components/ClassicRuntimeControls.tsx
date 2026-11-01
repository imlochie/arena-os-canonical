import { useState } from "react";
import type { NativeArcadeBridge, NativeSnapshot } from "./nativeArcadeTypes";

type Classics = NonNullable<NativeSnapshot["classics"]>;
type Props = {
  classics: Classics;
  bridge: NativeArcadeBridge;
  busy: boolean;
  pending: string | null;
  installed: (key: string) => boolean;
  run: (label: string, fn: (b: NativeArcadeBridge) => Promise<NativeSnapshot>) => void;
};

const btn =
  "rounded-lg border border-white/10 bg-white/5 px-3 py-1.5 text-[11px] font-extrabold text-slate-200 hover:bg-white/10 disabled:cursor-not-allowed disabled:opacity-40";
const field = "rounded-lg border border-white/10 bg-black/40 px-2 py-1.5 text-[11px] text-slate-200";

const pickHint = (adapter: string) => {
  const a = adapter.toLowerCase();
  if (a.includes("dos")) return "You pick the game folder, then its 8.3 executable.";
  if (a.includes("scumm")) return "You pick the data folder or file. Enter the ScummVM engine ID yourself.";
  return "You pick exactly one .gb or .gbc ROM you are authorized to use. The parent folder is never imported.";
};
const needsEngine = (adapter: string) => adapter.toLowerCase().includes("scumm");

export default function ClassicRuntimeControls({ classics, bridge, busy, pending, installed, run }: Props) {
  const [choiceId, setChoiceId] = useState("");
  const [engine, setEngine] = useState("");
  const [rebindTo, setRebindTo] = useState<Record<string, string>>({});
  const importFn = bridge.importClassic?.bind(bridge);
  const rebindFn = bridge.rebindClassic?.bind(bridge);
  const choice = classics.choices.find((c) => c.id === choiceId);
  const engineMissing = !!choice && needsEngine(choice.adapter) && !engine.trim();
  const pin = (c: { runtime: string; core?: string | null }) => `${c.runtime}${c.core ? ` + ${c.core}` : ""}`;

  return (
    <div className="space-y-3" aria-labelledby="classic-title">
      <div>
        <h3 id="classic-title" className="text-xs font-extrabold text-slate-200">Classic games you own</h3>
        <p className="mt-0.5 text-[10px] text-slate-500">
          Your files, pinned to an exact runtime and core. Nothing is downloaded for you: BIOS and game data are never acquired automatically, and runtimes install separately from the package list above. Windows acceptance is deferred; non-Windows or hosted sessions cannot launch.
        </p>
        {classics.verification && <p className="mt-0.5 text-[10px] text-amber-300/80">{classics.verification}</p>}
      </div>

      <div className="rounded-xl border border-white/10 bg-black/30 p-3">
        <div className="flex flex-wrap items-end gap-2">
          <label className="flex min-w-0 flex-col gap-1 text-[10px] text-slate-400">
            Runtime pin
            <select className={field} value={choiceId} onChange={(e) => setChoiceId(e.target.value)}>
              <option value="">Choose an exact pin</option>
              {classics.choices.map((c) => (
                <option key={c.id} value={c.id}>{c.title} - {pin(c)}{c.ready ? "" : " (dependencies missing)"}</option>
              ))}
            </select>
          </label>
          {choice && needsEngine(choice.adapter) && (
            <label className="flex flex-col gap-1 text-[10px] text-slate-400">
              Engine ID
              <input className={`${field} font-mono`} value={engine} onChange={(e) => setEngine(e.target.value)} placeholder="e.g. scumm" spellCheck={false} />
            </label>
          )}
          <button type="button" className={btn}
            disabled={busy || !importFn || !choice || !choice.ready || engineMissing}
            title={!importFn ? "This desktop build cannot import classics" : choice && !choice.ready ? "Install this pin's runtime and core first" : undefined}
            onClick={() => choice && importFn && run(`import ${choice.id}`, () => importFn(choice.id, needsEngine(choice.adapter) ? engine.trim() : undefined))}>
            {pending === `import ${choiceId}` ? "Waiting for approval..." : "Import from my files"}
          </button>
        </div>
        {choice && (
          <div className="mt-2 space-y-0.5 text-[10px]">
            <p className="text-slate-300">{pickHint(choice.adapter)} Desktop approval is requested first.</p>
            {!choice.ready && <p className="text-amber-300">Runtime or core for this pin is not installed yet.</p>}
            <details>
              <summary className="cursor-pointer text-slate-400">Controls, saves, limits, licenses</summary>
              <p className="mt-1 text-slate-400">Controls: {choice.controls}</p>
              <p className="text-slate-400">Saves: {choice.saves}</p>
              <p className="text-slate-400">Limitations: {choice.limitations}</p>
              <p className="font-mono text-slate-500">runtime {choice.runtimeLicense}{choice.coreLicense ? ` / core ${choice.coreLicense}` : ""}</p>
            </details>
          </div>
        )}
      </div>

      {classics.imports.length > 0 && (
        <ul className="space-y-1.5">
          {classics.imports.map((g) => {
            const alts = classics.choices.filter((c) => c.adapter === g.classic.adapter && c.ready && !(c.runtime === g.classic.runtime && (c.core ?? "") === (g.classic.core ?? "")));
            const target = rebindTo[g.key] ?? "";
            const adapter = classics.adapters.find((a) => a.id === g.classic.adapter);
            return (
              <li key={g.key} className="rounded-lg border border-white/5 bg-black/20 px-2 py-1.5 text-[10px]">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="min-w-0">
                    <p className="break-all font-bold text-slate-200">{g.title} <span className="font-mono font-normal text-slate-400">{g.version}</span>{installed(g.key) ? "" : <span className="ml-1 text-rose-200">files not installed</span>}</p>
                    <p className="break-all font-mono text-slate-500">{adapter?.title ?? g.classic.adapter} / {pin(g.classic)}{g.classic.engine ? ` / engine ${g.classic.engine}` : ""}</p>
                  </div>
                  <div className="flex flex-wrap items-center gap-1.5">
                    <select className={field} aria-label={`New pin for ${g.key}`} value={target} disabled={!alts.length}
                      onChange={(e) => setRebindTo((m) => ({ ...m, [g.key]: e.target.value }))}>
                      <option value="">{alts.length ? "Other pin" : "No other ready pin"}</option>
                      {alts.map((c) => <option key={c.id} value={c.id}>{pin(c)}</option>)}
                    </select>
                    <button type="button" className={btn} disabled={busy || !rebindFn || !target || !alts.some((c) => c.id === target)}
                      title={rebindFn ? "Adds a new pinned version; the old one and your save identity are kept" : "This desktop build cannot rebind"}
                      onClick={() => rebindFn && run(`rebind ${g.key}`, () => rebindFn(g.key, target))}>
                      {pending === `rebind ${g.key}` ? "Rebinding..." : "Pin new version"}
                    </button>
                  </div>
                </div>
                {target && <p className="mt-1 text-amber-300/80">Keeps the current version and save identity. Save states may not carry over between runtimes.</p>}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
