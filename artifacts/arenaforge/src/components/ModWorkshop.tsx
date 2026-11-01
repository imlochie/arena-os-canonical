"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AlertTriangle, ArrowDown, ArrowUp, Check, Copy, Download, FileJson, GitBranch, Layers, Play, RefreshCw, RotateCcw, ShieldCheck, Trash2, Upload, X } from "lucide-react";
import {
  activateWorkshopProfile,
  commitWorkshopReview,
  createWorkshopProfile,
  exportWorkshopProfile,
  inspectWorkshop,
  launchWorkshopProfile,
  listWorkshopGames,
  readModPackageFile,
  reviewModRepository,
  reviewWorkshopChange,
  rollbackWorkshopProfile,
} from "../lib/modWorkshop";
import type { WorkshopChange, WorkshopGame, WorkshopMod, WorkshopPlayback, WorkshopPreview, WorkshopProfile, WorkshopSnapshot } from "../lib/modWorkshopTypes";
import BepInExProfileControls from "./BepInExProfileControls";

type SettingValue = string | number | boolean;
type Props = { onPlay(playback: WorkshopPlayback): void; activePlayback?: WorkshopPlayback | null };

const UNSUPPORTED_ADAPTERS = [
  { name: "UPS patches", reason: "No UPS adapter is installed. Convert to a supported package before intake." },
  { name: "xdelta / VCDIFF", reason: "No xdelta adapter is installed in the browser workshop." },
  { name: "Framework plugins / install hooks", reason: "Generic installer hooks are not executed. Declared script overlays run only through the game's existing sandboxed runtime." },
];

function message(cause: unknown) {
  return cause instanceof Error ? cause.message : "The workshop operation failed.";
}
function isStale(text: string) {
  return /revision|stale|conflict|changed since/i.test(text);
}
function short(hash: string) {
  return hash ? `${hash.slice(0, 10)}…` : "—";
}
function formatBytes(bytes: number) {
  return bytes < 1024 ? `${bytes} B` : bytes < 1048576 ? `${(bytes / 1024).toFixed(1)} KB` : `${(bytes / 1048576).toFixed(2)} MB`;
}
function download(name: string, text: string) {
  const url = URL.createObjectURL(new Blob([text], { type: "application/json" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = name;
  link.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function CopyButton({ value, label, testId }: { value: string; label: string; testId: string }) {
  const [state, setState] = useState<"" | "ok" | "fail">("");
  return (
    <button type="button" data-testid={testId} aria-label={`Copy ${label}`} title={`Copy ${label}`}
      onClick={() => { navigator.clipboard.writeText(value).then(() => setState("ok"), () => setState("fail")); window.setTimeout(() => setState(""), 1400); }}
      className="inline-flex shrink-0 items-center gap-1 rounded-md px-1.5 py-1 text-[10px] font-bold text-slate-400 hover:bg-white/5 hover:text-emerald-200">
      {state === "ok" ? <Check size={12} /> : <Copy size={12} />}{state === "fail" ? "Copy failed" : ""}
    </button>
  );
}

export default function ModWorkshop({ onPlay, activePlayback = null }: Props) {
  const [games, setGames] = useState<WorkshopGame[] | null>(null);
  const [gamesError, setGamesError] = useState("");
  const [gameId, setGameId] = useState("");
  const [snapshot, setSnapshot] = useState<WorkshopSnapshot | null>(null);
  const [snapshotLoading, setSnapshotLoading] = useState(false);
  const [profileId, setProfileId] = useState("");
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [preview, setPreview] = useState<WorkshopPreview | null>(null);
  const [newName, setNewName] = useState("");
  const [shareSaves, setShareSaves] = useState(false);
  const [rights, setRights] = useState(false);
  const [repoUrl, setRepoUrl] = useState("");
  const [draft, setDraft] = useState<{ enabled: string[]; order: string[]; settings: WorkshopProfile["settings"] } | null>(null);
  const [excluded, setExcluded] = useState<string[] | null>(null);
  const opRef = useRef(0);

  const loadGames = useCallback(async () => {
    setGames(null);
    setGamesError("");
    try {
      const list = await listWorkshopGames();
      setGames(list);
      setGameId((current) => list.some((game) => game.id === current) ? current : list[0]?.id ?? "");
    } catch (cause) {
      setGamesError(message(cause));
      setGames([]);
    }
  }, []);
  useEffect(() => { void loadGames(); }, [loadGames]);

  const loadSnapshot = useCallback(async (id: string) => {
    if (!id) { setSnapshot(null); return; }
    const token = ++opRef.current;
    setSnapshotLoading(true);
    setError("");
    try {
      const next = await inspectWorkshop(id);
      if (token !== opRef.current) return;
      setSnapshot(next);
      setProfileId((current) => next.profiles.some((p) => p.id === current) ? current : next.activeProfileId ?? next.profiles[0]?.id ?? "");
    } catch (cause) {
      if (token === opRef.current) { setSnapshot(null); setError(message(cause)); }
    } finally {
      if (token === opRef.current) setSnapshotLoading(false);
    }
  }, []);
  useEffect(() => { setPreview(null); setExcluded(null); setNotice(""); void loadSnapshot(gameId); }, [gameId, loadSnapshot]);

  const profile = snapshot?.profiles.find((p) => p.id === profileId) ?? null;
  const packagesByKey = useMemo(() => new Map((snapshot?.packages ?? []).map((mod) => [mod.key, mod])), [snapshot]);
  useEffect(() => {
    setDraft(profile ? { enabled: [...profile.enabled], order: [...profile.order], settings: JSON.parse(JSON.stringify(profile.settings)) } : null);
    setPreview(null);
    setExcluded(null);
  }, [profile?.id, snapshot?.revision]); // eslint-disable-line react-hooks/exhaustive-deps

  const dirty = !!(profile && draft && JSON.stringify({ e: profile.enabled, o: profile.order, s: profile.settings }) !== JSON.stringify({ e: draft.enabled, o: draft.order, s: draft.settings }));

  // Every service call goes through run(): it tracks a cancellable token so a
  // cancelled request can never apply a late result or claim success.
  async function run<T>(label: string, task: () => Promise<T>, apply: (value: T) => void) {
    const token = ++opRef.current;
    setBusy(label);
    setError("");
    setNotice("");
    try {
      const value = await task();
      if (token !== opRef.current) return;
      apply(value);
    } catch (cause) {
      if (token === opRef.current) setError(message(cause));
    } finally {
      if (token === opRef.current) setBusy("");
    }
  }
  function cancel() {
    opRef.current++;
    setBusy("");
    setSnapshotLoading(false);
    setNotice("Cancelled. The result will be ignored here; if the request already reached storage, reload the workshop to see the confirmed state.");
  }

  const review = (change: WorkshopChange, label = "Preparing review…") => {
    if (!snapshot || !profile) return;
    void run(label, () => reviewWorkshopChange(snapshot.game.id, profile.id, change, snapshot.revision), (next) => {
      setPreview(next);
      setNotice("Review ready. Nothing has changed until you commit.");
    });
  };

  const onPackageFile = (file: File | undefined) => {
    if (!file || !rights) return;
    void run("Reading package…", async () => readModPackageFile(file), (json) => review({ packageJson: json }, "Reviewing package…"));
  };
  const onRepository = () => {
    const url = repoUrl.trim();
    if (!url || !rights) return;
    void run("Fetching repository package…", () => reviewModRepository(url), (json) => review({ packageJson: json }, "Reviewing package…"));
  };
  const onRestoreFile = (file: File | undefined) => {
    if (!file) return;
    void run("Reading profile JSON…", () => file.text(), (json) => review({ restoreJson: json }, "Reviewing restore…"));
  };

  const move = (key: string, delta: number) => setDraft((d) => {
    if (!d) return d;
    const order = [...d.order];
    const index = order.indexOf(key);
    const target = index + delta;
    if (index < 0 || target < 0 || target >= order.length) return d;
    [order[index], order[target]] = [order[target], order[index]];
    return { ...d, order };
  });
  const toggle = (key: string) => setDraft((d) => d && ({ ...d, enabled: d.enabled.includes(key) ? d.enabled.filter((k) => k !== key) : [...d.enabled, key] }));
  const setSetting = (key: string, name: string, value: SettingValue) => setDraft((d) => d && ({ ...d, settings: { ...d.settings, [key]: { ...(d.settings[key] ?? {}), [name]: value } } }));

  const game = snapshot?.game ?? games?.find((g) => g.id === gameId) ?? null;
  const stale = isStale(error);
  const locked = !!busy || snapshotLoading;

  return (
    <section data-testid="mod-workshop" aria-label="Mod workshop" className="mt-4 grid min-w-0 gap-4 lg:grid-cols-[260px_minmax(0,1fr)]">
      {/* Left rail: base games */}
      <aside className="min-w-0 space-y-3">
        <div className="glass rounded-2xl border border-white/10 p-4">
          <p className="text-[10px] font-black uppercase tracking-[0.22em] text-emerald-300">Mod workshop</p>
          <h2 className="mt-1 text-lg font-black tracking-tight text-white">Profiles over a fixed base.</h2>
          <p className="mt-1 text-[11px] leading-relaxed text-slate-400">Mods apply to independent profiles. The imported base game, its revisions and its saves are never rewritten.</p>
          <label className="mt-4 block text-[10px] font-black uppercase tracking-wider text-slate-400" htmlFor="workshop-game">Base game</label>
          {games === null ? (
            <div className="mt-2 h-9 animate-pulse rounded-lg bg-white/[0.06]" />
          ) : (
            <select id="workshop-game" data-testid="workshop-game" value={gameId} disabled={locked || games.length === 0}
              onChange={(event) => setGameId(event.target.value)}
              className="mt-2 block w-full rounded-lg border border-white/15 bg-slate-950 px-2 py-2 text-xs text-slate-100">
              {games.length === 0 && <option value="">No imported games</option>}
              {games.map((g) => <option key={g.id} value={g.id}>{g.title} · {g.kind}</option>)}
            </select>
          )}
          {gamesError && (
            <div role="alert" className="mt-2 rounded-lg border border-red-400/25 bg-red-500/10 p-2 text-[11px] text-red-200">
              {gamesError}
              <button type="button" data-testid="workshop-retry-games" onClick={() => void loadGames()} className="mt-1 block font-bold underline">Retry</button>
            </div>
          )}
          {games && games.length === 0 && !gamesError && (
            <p className="mt-2 rounded-lg bg-black/20 p-3 text-[11px] leading-relaxed text-slate-500">Import an authorized game in “Import and emulate” first. The workshop only modifies real imported bases.</p>
          )}
        </div>

        {game && (
          <div className="glass rounded-2xl border border-white/10 p-4" data-testid="workshop-base-identity">
            <p className="text-[10px] font-black uppercase tracking-wider text-slate-300">Base identity for package authors</p>
            <div className="mt-2 space-y-1.5 text-[11px]">
              <div className="flex items-center gap-1"><span className="w-14 shrink-0 text-slate-500">Identity</span><code className="min-w-0 flex-1 truncate text-emerald-200" data-testid="workshop-identity">{game.identity}</code><CopyButton value={game.identity} label="base identity" testId="workshop-copy-identity" /></div>
              <div className="flex items-center gap-1"><span className="w-14 shrink-0 text-slate-500">Version</span><code className="min-w-0 flex-1 truncate text-slate-200" data-testid="workshop-version">{game.version}</code><CopyButton value={game.version} label="base version" testId="workshop-copy-version" /></div>
              <div className="flex items-center gap-1"><span className="w-14 shrink-0 text-slate-500">Kind</span><span className="text-slate-200">{game.kind}</span></div>
            </div>
            <p className="mt-3 text-[10px] font-black uppercase tracking-wider text-slate-400">File targets ({game.files.length})</p>
            <ul className="mt-1 max-h-48 space-y-1 overflow-auto">
              {game.files.map((file) => (
                <li key={file.path} className="rounded-md bg-black/20 px-2 py-1.5" data-testid={`workshop-file-${file.path}`}>
                  <div className="flex items-center gap-1"><code className="min-w-0 flex-1 truncate text-[10px] text-slate-200">{file.path}</code><CopyButton value={file.path} label={`path ${file.path}`} testId={`workshop-copy-path-${file.path}`} /></div>
                  <div className="flex items-center gap-1 text-[9px] text-slate-500"><span>{formatBytes(file.bytes)}</span><code className="min-w-0 flex-1 truncate" title={file.sha256}>sha256 {file.sha256}</code><CopyButton value={file.sha256} label={`hash of ${file.path}`} testId={`workshop-copy-hash-${file.path}`} /></div>
                </li>
              ))}
            </ul>
            <CopyButton value={JSON.stringify({ identity: game.identity, version: game.version, files: game.files }, null, 2)} label="full base target manifest" testId="workshop-copy-manifest" />
            <span className="text-[9px] text-slate-500"> Copy target manifest (JSON)</span>
          </div>
        )}

        <div className="glass rounded-2xl border border-white/10 p-4" data-testid="workshop-unsupported-adapters">
          <p className="text-[10px] font-black uppercase tracking-wider text-slate-300">Unavailable adapters</p>
          <ul className="mt-2 space-y-1.5">
            {UNSUPPORTED_ADAPTERS.map((adapter) => (
              <li key={adapter.name} className="rounded-md border border-white/5 bg-white/[0.02] px-2 py-1.5">
                <p className="flex items-center gap-1.5 text-[11px] font-bold text-slate-300"><span className="rounded bg-slate-700/50 px-1.5 py-0.5 text-[8px] font-black uppercase tracking-wider text-slate-400">Unavailable</span>{adapter.name}</p>
                <p className="mt-0.5 text-[10px] leading-relaxed text-slate-500">{adapter.reason}</p>
              </li>
            ))}
          </ul>
        </div>
      </aside>

      {/* Main column */}
      <div className="min-w-0 space-y-4">
        {(busy || snapshotLoading) && (
          <div role="status" className="flex items-center gap-2 rounded-xl border border-cyan-300/20 bg-cyan-300/10 px-3 py-2 text-xs text-cyan-100">
            <RefreshCw size={13} className="animate-spin" /><span className="flex-1">{busy || "Inspecting workshop…"}</span>
            <button type="button" data-testid="workshop-cancel" onClick={cancel} className="inline-flex items-center gap-1 rounded-md border border-cyan-300/30 px-2 py-1 text-[10px] font-bold"><X size={11} />Cancel</button>
          </div>
        )}
        {error && (
          <div role="alert" data-testid="workshop-error" className="flex flex-wrap items-start gap-2 rounded-xl border border-red-400/25 bg-red-500/10 px-3 py-2.5 text-xs text-red-200">
            <AlertTriangle size={15} className="mt-0.5 shrink-0" />
            <span className="min-w-0 flex-1">{error}{stale && " The workshop changed elsewhere; reload before trying again."}</span>
            <button type="button" data-testid="workshop-refresh" onClick={() => { setPreview(null); void loadSnapshot(gameId); }} className="rounded-md border border-red-300/30 px-2 py-1 text-[10px] font-bold">{stale ? "Reload latest revision" : "Reload workshop"}</button>
          </div>
        )}
        {notice && !error && <div role="status" data-testid="workshop-notice" className="rounded-xl border border-emerald-400/20 bg-emerald-400/10 px-3 py-2.5 text-xs text-emerald-100">{notice}</div>}

        {snapshotLoading && !snapshot ? (
          <div className="space-y-3">{[0, 1, 2].map((i) => <div key={i} className="h-24 animate-pulse rounded-2xl bg-white/[0.04]" />)}</div>
        ) : !snapshot ? (
          <div className="flex min-h-56 flex-col items-center justify-center rounded-2xl border border-dashed border-white/10 bg-white/[0.02] px-6 text-center">
            <Layers size={24} className="text-slate-500" />
            <p className="mt-3 text-sm font-extrabold text-slate-200">{games?.length ? "Choose a base game to open its workshop." : "No base game yet."}</p>
            <p className="mt-1 max-w-sm text-xs text-slate-500">Profiles, packages and load order appear here once a real imported game is selected.</p>
          </div>
        ) : (
          <>
            {/* Profiles */}
            <div className="glass rounded-2xl border border-white/10 p-4">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <h3 className="text-xs font-black uppercase tracking-[0.16em] text-slate-200">Profiles</h3>
                <span className="font-mono text-[10px] text-slate-500" data-testid="workshop-revision">rev {snapshot.revision}</span>
              </div>
              <div className="mt-3 flex flex-wrap gap-2">
                {snapshot.profiles.map((p) => (
                  <button key={p.id} type="button" data-testid={`workshop-profile-${p.id}`} onClick={() => setProfileId(p.id)} disabled={locked}
                    className={`rounded-xl border px-3 py-2 text-left text-xs transition ${p.id === profileId ? "border-emerald-300/40 bg-emerald-300/[0.09]" : "border-white/10 bg-white/[0.03] hover:bg-white/[0.06]"}`}>
                    <span className="block font-extrabold text-slate-100">{p.name}</span>
                    <span className="mt-0.5 block text-[9px] font-bold uppercase tracking-wider text-slate-500">
                      {p.enabled.length} on · {p.shareSaves ? "shares base saves" : "own saves"}{snapshot.activeProfileId === p.id ? " · active" : ""}
                    </span>
                  </button>
                ))}
                {snapshot.profiles.length === 0 && <p className="text-[11px] text-slate-500">No profiles yet. Create one below; the base stays playable as-is.</p>}
              </div>
              <form data-testid="workshop-profile" className="mt-4 grid gap-2 rounded-xl border border-white/10 bg-black/20 p-3 sm:grid-cols-[1fr_auto]"
                onSubmit={(event) => {
                  event.preventDefault();
                  const name = newName.trim();
                  if (!name) return;
                  void run("Creating profile…", () => createWorkshopProfile(snapshot.game.id, name, shareSaves, snapshot.revision), (next) => {
                    const created = next.profiles.find((p) => !snapshot.profiles.some((old) => old.id === p.id));
                    setSnapshot(next);
                    if (created) setProfileId(created.id);
                    setNewName("");
                    setShareSaves(false);
                    setNotice(`Profile “${name}” created.`);
                  });
                }}>
                <input data-testid="workshop-profile-name" value={newName} onChange={(e) => setNewName(e.target.value)} maxLength={60} placeholder="New profile name, e.g. Hard mode remix"
                  className="rounded-lg border border-white/15 bg-slate-950 px-3 py-2 text-xs text-slate-100" />
                <button type="submit" data-testid="workshop-create-profile" disabled={locked || !newName.trim()} className="rounded-lg bg-emerald-400 px-3 py-2 text-xs font-extrabold text-slate-950 disabled:opacity-40">Create profile</button>
                <label className="flex items-start gap-2 text-[11px] text-slate-300 sm:col-span-2">
                  <input type="checkbox" data-testid="workshop-share-saves" checked={shareSaves} onChange={(e) => setShareSaves(e.target.checked)} className="mt-0.5 accent-amber-400" />
                  <span>Share saves with the base game</span>
                </label>
                {shareSaves && <p role="alert" className="text-[10px] leading-relaxed text-amber-200 sm:col-span-2">Modded play will read and write the base game's progress. Incompatible mods can corrupt those saves. Leave this off unless the package says saves are compatible.</p>}
              </form>
            </div>

            {profile && draft && (
              <>
                {snapshot.game.id.startsWith("native:") && (
                  <BepInExProfileControls key={`${snapshot.game.id}:${profile.id}`} gameId={snapshot.game.id}
                    profileId={profile.id} shareSaves={profile.shareSaves} locked={locked} />
                )}
                {/* Actions */}
                <div className="glass flex flex-wrap items-center gap-2 rounded-2xl border border-white/10 p-3">
                  <p className="min-w-0 flex-1 truncate text-sm font-extrabold text-white">{profile.name}<span className="ml-2 text-[10px] font-bold text-slate-500">{profile.history} checkpoint{profile.history === 1 ? "" : "s"}</span></p>
                  <button type="button" data-testid="workshop-activate" disabled={locked || snapshot.activeProfileId === profile.id}
                    onClick={() => void run("Activating…", () => activateWorkshopProfile(snapshot.game.id, profile.id, snapshot.revision), (next) => { setSnapshot(next); setNotice(`${profile.name} is the active profile.`); })}
                    className="inline-flex items-center gap-1 rounded-lg border border-white/10 bg-white/5 px-3 py-2 text-[11px] font-bold text-slate-200 disabled:opacity-40"><Check size={12} />{snapshot.activeProfileId === profile.id ? "Active" : "Activate"}</button>
                  <button type="button" data-testid="workshop-play" disabled={locked || dirty}
                    title={dirty ? "Commit or discard pending edits before playing" : snapshot.game.id.startsWith("native:") ? "Play reviewed file mods only; use Launch with BepInEx for plugins" : "Play this profile in the browser runtime"}
                    onClick={() => void run("Building profile runtime…", () => launchWorkshopProfile(snapshot.game.id, profile.id), (playback) => {
                      if (playback.native) setNotice("Native launch requested. Check the game window and Native games run status; process startup is not gameplay verification.");
                      else onPlay(playback);
                    })}
                    className="inline-flex items-center gap-1 rounded-lg bg-emerald-400 px-3 py-2 text-[11px] font-extrabold text-slate-950 disabled:opacity-40"><Play size={12} />Play in browser</button>
                  <button type="button" data-testid="workshop-rollback" disabled={locked || profile.history === 0}
                    onClick={() => { if (window.confirm(`Restore “${profile.name}” to its last known good checkpoint?`)) void run("Restoring…", () => rollbackWorkshopProfile(snapshot.game.id, profile.id, snapshot.revision), (next) => { setSnapshot(next); setNotice("Restored last known good profile."); }); }}
                    className="inline-flex items-center gap-1 rounded-lg border border-amber-300/25 bg-amber-300/10 px-3 py-2 text-[11px] font-bold text-amber-100 disabled:opacity-40"><RotateCcw size={12} />Restore last good</button>
                  <button type="button" data-testid="workshop-export" disabled={locked}
                    onClick={() => void run("Exporting…", () => exportWorkshopProfile(snapshot.game.id, profile.id), (out) => { download(`${profile.name.replace(/[^\w-]+/g, "_")}.profile.json`, out.json); setExcluded(out.excluded); setNotice("Profile JSON downloaded."); })}
                    className="inline-flex items-center gap-1 rounded-lg border border-white/10 bg-white/5 px-3 py-2 text-[11px] font-bold text-slate-200 disabled:opacity-40"><Download size={12} />Export JSON</button>
                  <label className={`inline-flex cursor-pointer items-center gap-1 rounded-lg border border-white/10 bg-white/5 px-3 py-2 text-[11px] font-bold text-slate-200 ${locked ? "pointer-events-none opacity-40" : ""}`}>
                    <FileJson size={12} />Import JSON
                    <input type="file" accept=".json,application/json" className="sr-only" data-testid="workshop-import-profile" disabled={locked}
                      onChange={(e) => { onRestoreFile(e.target.files?.[0]); e.currentTarget.value = ""; }} />
                  </label>
                </div>
                {activePlayback?.profileId === profile.id && <p className="text-[10px] text-emerald-200">This profile is loaded in “Import and emulate”. Use “Leave profile” there to return to the base.</p>}
                <p className="text-[10px] text-slate-500">{snapshot.game.id.startsWith("native:") ? "Ordinary Play launches reviewed file mods. Use Launch with BepInEx above for enabled plugins; native gameplay remains unverified." : "Playback uses the browser runtime."}</p>
                {excluded && (
                  <div className="rounded-xl border border-white/10 bg-black/20 p-3 text-[11px] text-slate-300" data-testid="workshop-export-excluded">
                    {excluded.length ? <>Not included in export: {excluded.join(", ")}</> : "Export includes every package in this profile."}
                  </div>
                )}

                {/* Intake */}
                <div className="glass rounded-2xl border border-white/10 p-4" data-testid="workshop-package">
                  <h3 className="flex items-center gap-1.5 text-xs font-black uppercase tracking-[0.16em] text-slate-200"><Upload size={13} />Add a package</h3>
                  <label className="mt-3 flex cursor-pointer items-start gap-2 text-[11px] leading-relaxed text-slate-300">
                    <input type="checkbox" data-testid="workshop-rights" checked={rights} onChange={(e) => setRights(e.target.checked)} className="mt-0.5 accent-emerald-400" />
                    <span>I have the right to use this mod package with this game. Its license and permissions will be shown before anything changes.</span>
                  </label>
                  <div className="mt-3 grid gap-3 md:grid-cols-2">
                    <label className={`flex cursor-pointer items-center justify-center gap-2 rounded-xl border border-dashed border-emerald-300/25 bg-emerald-300/[0.04] px-3 py-4 text-xs font-bold text-emerald-100 ${!rights || locked ? "pointer-events-none opacity-40" : ""}`}>
                      <Upload size={14} />Choose package file
                      <input type="file" className="sr-only" data-testid="workshop-package-file" disabled={!rights || locked} onChange={(e) => { onPackageFile(e.target.files?.[0]); e.currentTarget.value = ""; }} />
                    </label>
                    <div className="flex min-w-0 flex-col gap-2 sm:flex-row">
                      <input data-testid="workshop-repository-url" value={repoUrl} onChange={(e) => setRepoUrl(e.target.value)} placeholder="https://github.com/owner/mod" disabled={!rights || locked}
                        className="min-w-0 flex-1 rounded-lg border border-white/15 bg-slate-950 px-3 py-2 text-xs text-slate-100 disabled:opacity-40" />
                      <button type="button" data-testid="workshop-repository-review" onClick={onRepository} disabled={!rights || locked || !repoUrl.trim()}
                        className="inline-flex items-center gap-1 rounded-lg border border-cyan-300/25 bg-cyan-300/10 px-3 py-2 text-[11px] font-bold text-cyan-100 disabled:opacity-40"><GitBranch size={12} />Review</button>
                    </div>
                  </div>
                </div>

                {/* Load order & settings */}
                <div className="glass rounded-2xl border border-white/10 p-4">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <h3 className="text-xs font-black uppercase tracking-[0.16em] text-slate-200">Load order preference</h3>
                    <p className="text-[10px] text-slate-500">Dependencies and declared constraints may reorder the final result deterministically; the review shows it.</p>
                  </div>
                  <ol className="mt-3 space-y-2">
                    {draft.order.map((key, index) => {
                      const mod = packagesByKey.get(key);
                      return <ModRow key={key} modKey={key} mod={mod} index={index} count={draft.order.length} enabled={draft.enabled.includes(key)}
                        values={draft.settings[key] ?? {}} locked={locked}
                        onToggle={() => toggle(key)} onMove={(d) => move(key, d)} onSetting={(n, v) => setSetting(key, n, v)}
                        onRemove={() => { if (window.confirm(`Review removing ${mod?.name ?? key} from this profile?`)) review({ remove: key }, "Reviewing removal…"); }} />;
                    })}
                    {draft.order.length === 0 && <li className="rounded-lg bg-black/20 p-4 text-center text-[11px] text-slate-500">No mods in this profile. Add a package above.</li>}
                  </ol>
                  {dirty && (
                    <div className="mt-3 flex flex-wrap gap-2">
                      <button type="button" data-testid="workshop-review" disabled={locked} onClick={() => review({ enabled: draft.enabled, order: draft.order, settings: draft.settings })}
                        className="rounded-lg bg-emerald-400 px-3 py-2 text-xs font-extrabold text-slate-950 disabled:opacity-40">Review changes</button>
                      <button type="button" data-testid="workshop-discard-edits" onClick={() => setDraft({ enabled: [...profile.enabled], order: [...profile.order], settings: JSON.parse(JSON.stringify(profile.settings)) })}
                        className="rounded-lg border border-white/10 px-3 py-2 text-xs font-bold text-slate-300">Discard edits</button>
                    </div>
                  )}
                </div>
              </>
            )}

            {preview && <PreviewPanel preview={preview} packagesByKey={packagesByKey} locked={locked}
              onDiscard={() => { setPreview(null); setNotice("Review discarded. Nothing changed."); }}
              onCommit={() => void run("Committing…", () => commitWorkshopReview(preview.id), (next) => { setSnapshot(next); setPreview(null); setNotice("Committed. A checkpoint was recorded for restore."); })} />}
          </>
        )}
      </div>
    </section>
  );
}

function ModRow({ modKey, mod, index, count, enabled, values, locked, onToggle, onMove, onSetting, onRemove }: {
  modKey: string; mod?: WorkshopMod; index: number; count: number; enabled: boolean; values: Record<string, SettingValue>; locked: boolean;
  onToggle(): void; onMove(delta: number): void; onSetting(name: string, value: SettingValue): void; onRemove(): void;
}) {
  const settings = Object.entries(mod?.settings ?? {});
  return (
    <li className={`rounded-xl border p-3 ${enabled ? "border-emerald-300/20 bg-emerald-300/[0.035]" : "border-white/10 bg-black/20"}`} data-testid={`workshop-mod-${modKey}`}>
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-mono text-[10px] text-slate-500">{String(index + 1).padStart(2, "0")}</span>
        <div className="min-w-0 flex-1">
          <p className="truncate text-xs font-extrabold text-slate-100">{mod?.name ?? modKey} <span className="font-mono text-[10px] font-bold text-cyan-200">v{mod?.version ?? "?"}</span></p>
          <p className="truncate text-[10px] text-slate-500">{mod ? `${mod.id} · ${mod.license} · ${mod.source}` : "Package metadata missing"}</p>
          {mod && mod.permissions.length > 0 && <p className="mt-0.5 text-[9px] text-amber-200/80">Permissions: {mod.permissions.join(", ")}</p>}
        </div>
        <label className="inline-flex items-center gap-1.5 text-[10px] font-bold text-slate-300">
          <input type="checkbox" checked={enabled} onChange={onToggle} disabled={locked} data-testid={`workshop-toggle-${modKey}`} className="accent-emerald-400" />{enabled ? "Enabled" : "Disabled"}
        </label>
        <button type="button" aria-label="Move up" data-testid={`workshop-up-${modKey}`} disabled={locked || index === 0} onClick={() => onMove(-1)} className="rounded-md border border-white/10 p-1.5 text-slate-300 disabled:opacity-30"><ArrowUp size={12} /></button>
        <button type="button" aria-label="Move down" data-testid={`workshop-down-${modKey}`} disabled={locked || index === count - 1} onClick={() => onMove(1)} className="rounded-md border border-white/10 p-1.5 text-slate-300 disabled:opacity-30"><ArrowDown size={12} /></button>
        <button type="button" aria-label="Remove from profile" data-testid={`workshop-remove-${modKey}`} disabled={locked} onClick={onRemove} className="rounded-md border border-white/10 p-1.5 text-slate-400 hover:text-red-200 disabled:opacity-30"><Trash2 size={12} /></button>
      </div>
      {settings.length > 0 && (
        <div className="mt-2 grid gap-2 border-t border-white/5 pt-2 sm:grid-cols-2">
          {settings.map(([name, meta]) => {
            const value = values[name] ?? meta.default;
            const id = `workshop-setting-${modKey}-${name}`;
            return (
              <label key={name} htmlFor={id} className="block text-[10px] text-slate-300">
                <span className="font-bold">{name}</span> <span className="text-slate-500">{meta.type} · default {String(meta.default)}{meta.min !== undefined ? ` · min ${meta.min}` : ""}{meta.max !== undefined ? ` · max ${meta.max}` : ""}</span>
                {meta.type === "boolean" ? (
                  <input id={id} data-testid={id} type="checkbox" checked={value === true} disabled={locked} onChange={(e) => onSetting(name, e.target.checked)} className="ml-2 accent-emerald-400" />
                ) : meta.type === "number" ? (
                  <input id={id} data-testid={id} type="number" value={String(value)} min={meta.min} max={meta.max} disabled={locked}
                    onChange={(e) => { const n = Number(e.target.value); if (e.target.value !== "" && Number.isFinite(n)) onSetting(name, n); }}
                    className="mt-1 block w-full rounded-md border border-white/15 bg-slate-950 px-2 py-1.5 text-xs text-slate-100" />
                ) : (
                  <input id={id} data-testid={id} type="text" value={String(value)} disabled={locked} onChange={(e) => onSetting(name, e.target.value)}
                    className="mt-1 block w-full rounded-md border border-white/15 bg-slate-950 px-2 py-1.5 text-xs text-slate-100" />
                )}
              </label>
            );
          })}
        </div>
      )}
    </li>
  );
}

function PreviewPanel({ preview, packagesByKey, locked, onCommit, onDiscard }: {
  preview: WorkshopPreview; packagesByKey: Map<string, WorkshopMod>; locked: boolean; onCommit(): void; onDiscard(): void;
}) {
  const totalBytes = preview.changes.reduce((sum, change) => sum + change.bytes, 0);
  return (
    <div className="glass rounded-2xl border border-cyan-300/25 p-4" data-testid="workshop-preview">
      <div className="flex flex-wrap items-center gap-2">
        <ShieldCheck size={15} className="text-cyan-200" />
        <h3 className="flex-1 text-sm font-extrabold text-white">Review: {preview.name}</h3>
        <span className="font-mono text-[10px] text-slate-400">{preview.changes.length} file{preview.changes.length === 1 ? "" : "s"} · {formatBytes(totalBytes)} changed</span>
      </div>
      {preview.warnings.length > 0 && (
        <ul role="alert" className="mt-3 space-y-1 rounded-lg border border-amber-300/25 bg-amber-300/10 p-3 text-[11px] text-amber-100">
          {preview.warnings.map((w, i) => <li key={i} className="flex gap-1.5"><AlertTriangle size={12} className="mt-0.5 shrink-0" />{w}</li>)}
        </ul>
      )}
      <div className="mt-3 space-y-2">
        {preview.licenses.map(license => <details key={license.mod} className="rounded-lg border border-white/10 p-3 text-xs text-slate-300">
          <summary className="cursor-pointer">{license.mod} · {license.spdx} · {license.redistributable ? "Payload redistribution declared" : "Excluded from portable backups"}</summary>
          <p className="mt-2 break-all text-slate-400">{license.source}</p>
          <pre className="mt-2 max-h-48 overflow-auto whitespace-pre-wrap text-[10px]">{license.text}</pre>
        </details>)}
      </div>
      <div className="mt-3 grid gap-3 md:grid-cols-3 text-[11px]">
        <div className="rounded-lg bg-black/20 p-3">
          <p className="text-[10px] font-black uppercase tracking-wider text-slate-400">Permissions</p>
          <p className="mt-1 text-slate-200">{preview.permissions.length ? preview.permissions.join(", ") : "None requested"}</p>
        </div>
        <div className="rounded-lg bg-black/20 p-3">
          <p className="text-[10px] font-black uppercase tracking-wider text-slate-400">Automatic dependencies</p>
          <p className="mt-1 text-slate-200">{preview.addedDependencies.length ? preview.addedDependencies.map((k) => packagesByKey.get(k)?.name ?? k).join(", ") : "None added"}</p>
        </div>
        <div className="rounded-lg bg-black/20 p-3">
          <p className="text-[10px] font-black uppercase tracking-wider text-slate-400">Resolved load order</p>
          <ol className="mt-1 list-decimal pl-4 text-slate-200">{preview.order.map((k) => <li key={k}>{packagesByKey.get(k)?.name ?? k}</li>)}</ol>
        </div>
      </div>
      <div className="mt-3 overflow-x-auto rounded-lg border border-white/10">
        <table className="w-full min-w-[560px] text-left text-[10px]">
          <thead className="bg-white/[0.03] text-slate-400"><tr><th className="px-2 py-1.5">Target</th><th className="px-2 py-1.5">Before sha256</th><th className="px-2 py-1.5">After sha256</th><th className="px-2 py-1.5">Bytes</th><th className="px-2 py-1.5">Mod</th></tr></thead>
          <tbody>
            {preview.changes.map((change, i) => {
              const conflict = preview.changes.some((other, j) => j !== i && other.path === change.path);
              return (
                <tr key={`${change.path}-${i}`} className={`border-t border-white/5 ${conflict ? "bg-amber-300/[0.06]" : ""}`} data-testid={`workshop-change-${i}`}>
                  <td className="px-2 py-1.5 font-mono text-slate-200">{change.path}{conflict && <span className="ml-1 rounded bg-amber-300/20 px-1 text-[8px] font-black uppercase text-amber-100">conflict</span>}</td>
                  <td className="px-2 py-1.5 font-mono text-slate-500" title={change.before}>{short(change.before)}</td>
                  <td className="px-2 py-1.5 font-mono text-cyan-200" title={change.after}>{short(change.after)}</td>
                  <td className="px-2 py-1.5 font-mono text-slate-300">{formatBytes(change.bytes)}</td>
                  <td className="px-2 py-1.5 text-slate-300">{packagesByKey.get(change.mod)?.name ?? change.mod}</td>
                </tr>
              );
            })}
            {preview.changes.length === 0 && <tr><td colSpan={5} className="px-2 py-3 text-center text-slate-500">No file bytes change (profile metadata only).</td></tr>}
          </tbody>
        </table>
      </div>
      <p className="mt-2 text-[10px] text-slate-500">Later mods in the resolved order win where targets overlap. The base game is not modified; changes apply to this profile only.</p>
      <div className="mt-3 flex flex-wrap gap-2">
        <button type="button" data-testid="workshop-commit" disabled={locked} onClick={onCommit} className="rounded-lg bg-emerald-400 px-4 py-2 text-xs font-extrabold text-slate-950 disabled:opacity-40">Commit to profile</button>
        <button type="button" data-testid="workshop-discard-review" disabled={locked} onClick={onDiscard} className="rounded-lg border border-white/10 px-3 py-2 text-xs font-bold text-slate-300 disabled:opacity-40">Discard review</button>
      </div>
    </div>
  );
}
