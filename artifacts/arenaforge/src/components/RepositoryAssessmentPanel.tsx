import { useEffect, useRef, useState } from "react";
import type { ArcadeRepositoryAssessment } from "@workspace/api-client-react";
import { getNativeBridge, type NativeSnapshot } from "./nativeArcadeTypes";

type RepoJob = NonNullable<NativeSnapshot["repository"]>["jobs"][number];

const TYPE_LABEL: Record<ArcadeRepositoryAssessment["projectType"], string> = {
  browser: "Browser game", godot: "Godot project", sdl: "SDL / native C project", native: "Native project", unknown: "Unrecognised project",
};
const SOURCE_BUILD = new Set(["godot", "sdl"]);
const RELEASE_NATIVE = new Set(["godot", "sdl", "native"]);
const TERMINAL = new Set(["installed", "failed", "cancelled", "interrupted"]);
const WIN64 = /(?:win(?:dows)?[-_.]?(?:x64|x86_64)|win64|win32-x64|x86_64-pc-windows)/i;

const fmtBytes = (bytes: number) =>
  bytes < 1024 ? `${bytes} B` : bytes < 1048576 ? `${(bytes / 1024).toFixed(1)} KB` : `${(bytes / 1048576).toFixed(1)} MB`;

function useNow(active: boolean) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, [active]);
  return now;
}

function Chips({ label, items }: { label: string; items: string[] }) {
  if (!items.length) return null;
  return <div className="flex flex-wrap items-baseline gap-1.5">
    <span className="w-24 shrink-0 text-[11px] uppercase tracking-wide text-slate-500">{label}</span>
    {items.map(item => <span key={item} className="rounded-md border border-white/10 bg-white/5 px-1.5 py-0.5 font-mono text-[11px] text-slate-200">{item}</span>)}
  </div>;
}

export default function RepositoryAssessmentPanel({ assessment, disabled, busy, onInspectBrowser, onReviewRelease, onBuildSource, onInstallRelease, onDismiss }: {
  assessment: ArcadeRepositoryAssessment;
  disabled: boolean;
  busy: boolean;
  onInspectBrowser: () => void;
  onReviewRelease: (reviewUrl: string) => void;
  onBuildSource?: (token: string) => Promise<void>;
  onInstallRelease?: (selection: string) => Promise<void>;
  onDismiss: () => void;
}) {
  const a = assessment;
  const [rightsConfirmed, setRightsConfirmed] = useState(false);
  const [build, setBuild] = useState<"idle" | "pending" | "returned" | "error">("idle");
  const [job, setJob] = useState<RepoJob | null>(null);
  const [nativeCancel, setNativeCancel] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const startedAt = useRef(0);
  const [action, setAction] = useState("");
  const reference = a.reference;
  const releaseMode = !!reference && a.releases.some(r => r.tag === reference);
  const [buildError, setBuildError] = useState("");
  const attempt = useRef(0);
  const expiresMs = a.expiresAt;
  const now = useNow(true);
  const expired = now >= expiresMs;
  const remaining = Math.max(0, Math.round((expiresMs - now) / 1000));
  const native = RELEASE_NATIVE.has(a.projectType);
  const buildable = SOURCE_BUILD.has(a.projectType);
  const blocked = a.blockers.length > 0;

  useEffect(() => { setRightsConfirmed(false); setBuild("idle"); setBuildError(""); attempt.current++; }, [a.token]);
  useEffect(() => () => { attempt.current++; }, []);

  useEffect(() => {
    if (build !== "pending") return;
    const bridge = getNativeBridge();
    if (!bridge) return;
    let alive = true;
    let inFlight = false;
    const tick = async () => {
      if (inFlight || !alive) return;
      inFlight = true;
      try {
        const snap = await bridge.inspect();
        if (!alive) return;
        const match = (snap.repository?.jobs ?? [])
          .filter(j => j.repository === a.repository && j.revision === a.revision && j.createdAt >= startedAt.current - 2000)
          .sort((x, y) => y.createdAt - x.createdAt)[0] ?? null;
        setJob(match);
        setNativeCancel(!!match && !TERMINAL.has(match.phase) && !!snap.canCancel);
      } catch { /* keep last known job state */ } finally { inFlight = false; }
    };
    void tick();
    const t = window.setInterval(() => void tick(), 2000);
    return () => { alive = false; window.clearInterval(t); };
  }, [build, a.repository, a.revision]);

  const cancelNative = async () => {
    const bridge = getNativeBridge();
    if (!bridge || !nativeCancel || cancelling) return;
    setCancelling(true);
    try { await bridge.cancel(); } catch (cause) {
      setBuildError((cause as { message?: string })?.message || "Cancel request failed.");
    } finally { setCancelling(false); setNativeCancel(false); }
  };

  const pending = build === "pending";
  const canBuild = !!onBuildSource && buildable && !expired && !blocked && !!a.license && rightsConfirmed && !disabled && !busy && !pending;

  const assetBlock = (asset: ArcadeRepositoryAssessment["releases"][number]["assets"][number], tag: string): string | null => {
    if (expired) return "Review expired.";
    if (!a.license) return "No license detected.";
    if (reference !== tag) return "Review this release first.";
    if (!asset.sha256) return "No publisher digest to verify against.";
    if (!/\.zip$/i.test(asset.name)) return "Only .zip archives are supported.";
    if (!WIN64.test(asset.name)) return "Not labelled as a Windows x64 build.";
    if (!rightsConfirmed) return "Confirm the license below first.";
    if (disabled || busy) return "Another action is running.";
    return null;
  };

  const start = async (kind: string, fn: () => Promise<void>) => {
    if (pending) return;
    const id = ++attempt.current;
    startedAt.current = Date.now();
    setAction(kind);
    setBuild("pending"); setBuildError(""); setJob(null); setNativeCancel(false);
    try {
      await fn();
      if (attempt.current === id) setBuild("returned");
    } catch (cause) {
      if (attempt.current !== id) return;
      setBuild("error");
      setBuildError((cause as { message?: string })?.message || "The desktop request failed. Nothing was installed.");
    }
  };
  const stopWaiting = () => { attempt.current++; setBuild("idle"); setJob(null); setNativeCancel(false); };

  const confTone = a.confidence === "high" ? "text-emerald-200 border-emerald-300/30" : a.confidence === "medium" ? "text-amber-200 border-amber-300/30" : "text-slate-300 border-white/20";

  return <div data-testid="repository-assessment" className="mt-4 rounded-lg border border-white/10 bg-black/25 text-xs text-slate-300">
    <header className="flex flex-wrap items-start justify-between gap-2 border-b border-white/10 p-3">
      <div className="min-w-0">
        <p className="truncate font-bold text-slate-100">{a.repository}{a.folder ? <span className="font-normal text-slate-400"> / {a.folder}</span> : null}</p>
        <p className="mt-0.5 font-mono text-[11px] text-slate-500">{a.revision.slice(0, 12)} · {a.files.length} files · {fmtBytes(a.totalBytes)}</p>
      </div>
      <div className="flex items-center gap-2">
        <span data-testid="assessment-provider" className="rounded-md bg-white/5 px-2 py-0.5 font-mono text-[10px] uppercase text-slate-300">{a.provider}</span>
        <span data-testid="assessment-type" className="rounded-md bg-emerald-300/15 px-2 py-0.5 font-bold text-emerald-100">{TYPE_LABEL[a.projectType]}</span>
        <span className={`rounded-md border px-2 py-0.5 ${confTone}`}>{a.confidence} confidence</span>
        <button type="button" onClick={onDismiss} aria-label="Close review" className="rounded px-1.5 text-slate-400 hover:text-slate-100 focus-visible:outline focus-visible:outline-emerald-300">×</button>
      </div>
    </header>

    <div className="space-y-3 p-3">
      {blocked
        ? <div role="alert" data-testid="assessment-blockers" className="rounded-md border border-red-300/30 bg-red-400/10 p-2.5">
            <p className="font-bold text-red-100">Can’t continue yet</p>
            <ul className="mt-1 list-disc space-y-0.5 pl-4 text-red-100/90">{a.blockers.map(b => <li key={b}>{b}</li>)}</ul>
          </div>
        : <p className="text-slate-400">No blockers found. This is a static read of the source — not proof it builds or plays.</p>}

      <div className="space-y-1.5">
        <Chips label="Languages" items={a.languages} />
        <Chips label="Build" items={a.buildSystems} />
        <Chips label="SDKs" items={a.sdks} />
        <Chips label="Targets" items={a.targets} />
        {a.modHooks.length > 0 && <Chips label="Mod hooks" items={a.modHooks} />}
      </div>

      <p data-testid="assessment-license">
        License: {a.license
          ? <><strong className="text-slate-100">{a.license.spdx}</strong> <span className="text-slate-500">({a.license.path})</span></>
          : <strong className="text-amber-200">none detected — you’ll need to confirm rights yourself</strong>}
      </p>

      <details className="group">
        <summary className="cursor-pointer select-none py-1 text-slate-200 focus-visible:outline focus-visible:outline-emerald-300">Why we think so · {a.evidence.length} clue{a.evidence.length === 1 ? "" : "s"}</summary>
        <ul className="mt-1 max-h-40 space-y-1 overflow-auto">{a.evidence.map((e, i) =>
          <li key={`${e.path}-${i}`}><code className="text-emerald-100/80">{e.path}</code> <span className="text-slate-400">— {e.detail}</span></li>)}</ul>
      </details>
      {a.dependencies.length > 0 && <details>
        <summary className="cursor-pointer select-none py-1 text-slate-200">Dependencies · {a.dependencies.length}</summary>
        <ul className="mt-1 max-h-32 overflow-auto font-mono text-[11px]">{a.dependencies.map(d => <li key={d}>{d}</li>)}</ul>
      </details>}
      <details>
        <summary className="cursor-pointer select-none py-1 text-slate-200">Files · {a.files.length}</summary>
        <ul className="mt-1 max-h-40 overflow-auto font-mono text-[11px]">{a.files.map(f => <li key={f.path} className="break-all">{f.path} · {fmtBytes(f.size)}</li>)}</ul>
      </details>
      {a.license && <details>
        <summary className="cursor-pointer select-none py-1 text-slate-200">License text</summary>
        <pre className="max-h-40 overflow-auto whitespace-pre-wrap text-[11px]">{a.license.text}</pre>
      </details>}

      {a.releases.length > 0 && <details data-testid="assessment-releases" open={releaseMode || undefined}>
        <summary className="cursor-pointer select-none py-1 text-slate-200">Releases · {a.releases.length}</summary>
        <ul className="mt-1 space-y-2">{a.releases.map((r, ri) => {
          const reviewed = reference === r.tag;
          return <li key={r.tag} className="rounded-md border border-white/10 p-2">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span><strong className="text-slate-100">{r.name || r.tag}</strong> <code className="text-slate-500">{r.tag}</code>{r.prerelease && <span className="ml-1 rounded bg-amber-300/15 px-1 text-amber-200">pre-release</span>}{reviewed && <span className="ml-1 rounded bg-emerald-300/15 px-1 text-emerald-200">this review</span>}</span>
            {!reviewed && <button type="button" disabled={disabled || busy || pending} onClick={() => onReviewRelease(r.reviewUrl)}
              className="rounded-md border border-emerald-300/30 px-2 py-1 font-bold text-emerald-100 disabled:opacity-50">Review this release</button>}
          </div>
          {r.assets.length > 0 && <ul className="mt-1.5 space-y-1 text-[11px]">{r.assets.map((asset, ai) => {
            const selection = `${a.token}:${ri}:${ai}`;
            const why = reviewed && onInstallRelease && native ? assetBlock(asset, r.tag) : null;
            return <li key={asset.url} className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <span className="break-all font-mono text-slate-300">{asset.name}</span>
            <span className="text-slate-500">{fmtBytes(asset.bytes)}</span>
            {asset.sha256
              ? <span className="font-mono text-slate-500" title={asset.sha256}>sha256 {asset.sha256.slice(0, 10)}…</span>
              : <span className="text-amber-200">no publisher digest</span>}
            {reviewed && onInstallRelease && native && <button type="button" data-testid="assessment-install-release" disabled={!!why || pending}
              title={why ?? undefined} onClick={() => void start(selection, () => onInstallRelease(selection))}
              className="ml-auto rounded-md bg-emerald-300 px-2 py-1 font-extrabold text-slate-950 disabled:bg-white/10 disabled:text-slate-400">
              {pending && action === selection ? "Sent to desktop…" : "Install portable release"}
            </button>}
            {why && !pending && <span className="w-full text-[10px] text-slate-500">{why}</span>}
          </li>; })}</ul>}
          <p className="mt-1 text-[11px] text-slate-500">{reviewed ? "Only checksummed Windows x64 .zip assets can be installed." : "Nothing is downloaded. Reviewing re-checks this tag first."}</p>
        </li>; })}</ul>
      </details>}

      <div className="border-t border-white/10 pt-3">
        <p className="text-[11px] text-slate-500" aria-live="polite">{expired ? "Review expired — review again to continue." : `Review valid for ${Math.floor(remaining / 60)}:${String(remaining % 60).padStart(2, "0")}`}</p>

        {a.projectType === "browser" && <button type="button" data-testid="assessment-continue-browser" disabled={disabled || busy || blocked || expired}
          onClick={onInspectBrowser} className="mt-2 rounded-lg bg-emerald-300 px-3 py-2 font-extrabold text-slate-950 disabled:opacity-50">
          Continue to browser import
        </button>}

        {native && <div className="mt-2 space-y-2">
          {!(onBuildSource && buildable) && !onInstallRelease
            ? <p data-testid="assessment-native-unavailable" className="rounded-md border border-white/10 bg-white/5 p-2 text-slate-300">{TYPE_LABEL[a.projectType]}s need the Arcade desktop app to build or install. Nothing is assumed installed here.</p>
            : <>
              <label className="flex items-start gap-2">
                <input type="checkbox" checked={rightsConfirmed} disabled={!a.license || pending} onChange={e => setRightsConfirmed(e.target.checked)} className="mt-0.5 accent-emerald-300" />
                <span>{a.license ? `I’ve read the ${a.license.spdx} license and have the right to use this locally.` : "A license is required before building or installing."}</span>
              </label>
              {!buildable && <p data-testid="assessment-native-release-only" className="text-[11px] text-slate-400">No source build recipe for this project. Review a release tag above to install a checksummed Windows x64 portable build.</p>}
              <div className="flex flex-wrap gap-2">
                {onBuildSource && buildable && <button type="button" data-testid="assessment-build-source" disabled={!canBuild} onClick={() => void start("build", () => onBuildSource(a.token))}
                  className="rounded-lg bg-emerald-300 px-3 py-2 font-extrabold text-slate-950 disabled:opacity-50">
                  {pending && action === "build" ? "Sent to desktop…" : "Build from source"}
                </button>}
                {pending && <button type="button" onClick={stopWaiting} className="rounded-lg border border-white/20 px-3 py-2 text-slate-200">Stop waiting</button>}
                {pending && nativeCancel && <button type="button" data-testid="assessment-cancel-build" disabled={cancelling} onClick={() => void cancelNative()} className="rounded-lg border border-red-300/40 px-3 py-2 font-bold text-red-100 disabled:opacity-50">{cancelling ? "Cancelling…" : "Cancel job"}</button>}
              </div>
              {pending && <div aria-live="polite" className="text-[11px]">
                {job
                  ? <p className="text-slate-300"><span className={`font-bold ${TERMINAL.has(job.phase) ? (job.phase === "installed" ? "text-emerald-200" : "text-red-200") : "text-amber-200"}`}>{job.phase}</span>{job.detail ? ` — ${job.detail}` : ""}</p>
                  : <p className="text-slate-500">Waiting for the desktop app to start a job. Approve its dialog if shown.</p>}
                <p className="text-slate-500">Stop waiting only hides this request{nativeCancel ? "; Cancel job stops the desktop work." : "."}</p>
              </div>}
              {build === "returned" && <p aria-live="polite" className="text-[11px] text-slate-300">Desktop request returned{job ? ` (last seen: ${job.phase})` : ""}. Check Native games for the result — startup and gameplay are not verified.</p>}
              {build === "error" && <p role="alert" className="text-red-200">{buildError}</p>}
            </>}
        </div>}

        {a.projectType === "unknown" && !blocked && <p className="mt-2 text-slate-400">Arcade can’t tell how to run this one. Try a folder or release link that points at the game itself.</p>}
      </div>
    </div>
  </div>;
}
