"use client";

import { useCallback, useEffect, useState } from "react";
import {
  CheckCircle2,
  CircleAlert,
  Database,
  Info,
  Loader2,
  RefreshCw,
} from "lucide-react";
import type { ArchiveBridgeStatus } from "@/lib/archive-assistant/bridge-status";
import ArchiveFindingLineage from "./ArchiveFindingLineage";

/**
 * The Archive Assistant room panel — NATIVE since the merge. What used to be
 * a read-only status card for an external app is now the control panel for
 * the in-process archive assistant: connect plex/jellyfin, run syncs,
 * reconcile the local archive index against provider libraries, and work
 * the review queue. Tokens are sealed server-side and never rendered here;
 * decisions are recorded, nothing is renamed/moved/deleted/downloaded.
 */

type Provider = {
  id: string;
  kind: string;
  name: string;
  baseUrl: string;
  username: string;
  lastSyncAt: string | null;
  lastError: string | null;
};

type ReviewItem = {
  id: number;
  title: string;
  kind: string;
  state: string;
  classification: string | null;
  providerKind: string | null;
  summary: string;
  evidence: string[];
  decision: string | null;
  currentObservationId: number | null;
};

type SyncOutcome = {
  provider: string;
  status: string;
  snapshotCompleteness: string;
  itemCount: number;
  libraries: number;
  failedLibraries: { library: string; reason: string }[];
};

const input =
  "w-full rounded-lg border border-white/10 bg-black/40 px-3 py-2 text-sm text-white placeholder:text-slate-600 focus:border-cyan-500 focus:outline-none";
const action =
  "rounded-lg bg-cyan-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-cyan-500 disabled:opacity-50";
const ghost =
  "rounded-lg border border-white/15 px-3 py-1.5 text-xs text-slate-300 hover:text-white disabled:opacity-50";

export default function ArchiveAssistantBridge({ status }: { status: ArchiveBridgeStatus }) {
  const [providers, setProviders] = useState<Provider[]>([]);
  const [reviews, setReviews] = useState<ReviewItem[]>([]);
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  // add-provider form
  const [kind, setKind] = useState<"plex" | "jellyfin">("plex");
  const [baseUrl, setBaseUrl] = useState("");
  const [token, setToken] = useState("");
  const [username, setUsername] = useState("");

  const refresh = useCallback(async () => {
    try {
      const [p, r] = await Promise.all([
        fetch("/api/archive/providers", { cache: "no-store" }).then((x) => x.json()),
        fetch("/api/archive/review", { cache: "no-store" }).then((x) => x.json()),
      ]);
      setProviders(p.providers ?? []);
      setReviews(r.items ?? []);
    } catch {
      /* best effort */
    }
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const post = useCallback(
    async (label: string, body: Record<string, unknown>) => {
      setBusy(label);
      setMessage(null);
      try {
        const response = await fetch("/api/archive/providers", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        });
        const data = await response.json().catch(() => ({}));
        if (!response.ok) {
          setMessage(`✗ ${data.error ?? response.status}: ${String(data.message ?? "").slice(0, 160)}`);
          return null;
        }
        return data as Record<string, unknown>;
      } catch (e) {
        setMessage(`✗ ${String(e)}`);
        return null;
      } finally {
        setBusy(null);
      }
    },
    [],
  );

  const saveProvider = useCallback(async () => {
    if (!baseUrl.trim() || !token) return;
    const data = await post("save", { action: "save", kind, baseUrl, token, username });
    if (data) {
      setToken("");
      setMessage(`✓ ${kind} saved (token sealed).`);
      await refresh();
    }
  }, [baseUrl, token, kind, username, post, refresh]);

  const testProvider = useCallback(async () => {
    if (!baseUrl.trim() || !token) return;
    const data = await post("test", { action: "test", kind, baseUrl, token, username });
    if (data && data.ok) {
      setMessage(`✓ Connected — libraries: ${(data.libraries as string[]).join(", ") || "(none)"}`);
    } else if (data) {
      const hint = data.code === "auth_failed" ? " (token rejected — check the Plex token / Jellyfin API key)" : "";
      setMessage(`✗ ${data.code}: ${String(data.detail ?? "").slice(0, 160)}${hint}`);
    }
  }, [baseUrl, token, kind, username, post]);

  const syncProvider = useCallback(
    async (providerKind: string) => {
      const data = await post(`sync-${providerKind}`, { action: "sync", kind: providerKind });
      if (data) {
        const outcome = data.outcome as SyncOutcome;
        setMessage(
          `✓ ${providerKind} sync: ${outcome.status} (${outcome.snapshotCompleteness}) — ` +
            `${outcome.itemCount} items across ${outcome.libraries} libraries` +
            (outcome.failedLibraries.length ? `; failed: ${outcome.failedLibraries.map((f) => f.library).join(", ")}` : ""),
        );
        await refresh();
      }
    },
    [post, refresh],
  );

  const removeProvider = useCallback(
    async (providerKind: string) => {
      const data = await post(`remove-${providerKind}`, { action: "delete", kind: providerKind });
      if (data) {
        setMessage(`✓ ${providerKind} removed.`);
        await refresh();
      }
    },
    [post, refresh],
  );

  const reconcile = useCallback(async () => {
    const data = await post("reconcile", { action: "reconcile" });
    if (data) {
      const s = data.summary as Record<string, number>;
      setMessage(
        `✓ Reconciled: ${s.localCount} local ↔ ${s.providerCount} provider — ` +
          `${s.matchedCount} matched, ${s.localOnlyCount} local-only, ${s.providerOnlyCount} provider-only, ` +
          `${s.duplicateCount} duplicates, ${s.uncertainCount} uncertain.`,
      );
      await refresh();
    }
  }, [post, refresh]);

  const decide = useCallback(
    async (id: number, decision: "approve" | "reject" | "reopen") => {
      setBusy(`decide-${id}`);
      try {
        const response = await fetch("/api/archive/review", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ id, decision }),
        });
        if (!response.ok) {
          const data = await response.json().catch(() => ({}));
          setMessage(`✗ ${data.message ?? response.status}`);
          return;
        }
        await refresh();
      } finally {
        setBusy(null);
      }
    },
    [refresh],
  );

  const open = reviews.filter((r) => r.state === "needs_you" || r.state === "uncertain");

  return (
    <div className="mt-8 space-y-4">
      {/* status header */}
      {status.state === "no_providers" ? (
        <div className="rounded-2xl border border-amber-300/15 bg-amber-300/[0.05] p-4" data-testid="archive-bridge-native-empty">
          <div className="flex items-start gap-3">
            <Database className="mt-0.5 shrink-0 text-amber-200" size={18} aria-hidden="true" />
            <div>
              <p className="text-sm font-bold text-amber-100">Archive Assistant is native — connect a media server</p>
              <p className="mt-1 text-sm leading-5 text-slate-400">
                The external bridge is gone; the assistant runs inside Arena OS. Connect Plex or Jellyfin below and the
                six read operations (overview, workload, reconciliation, lineage, provider state + history) are served
                from your own database.
              </p>
            </div>
          </div>
        </div>
      ) : status.state === "syncing" ? (
        <div className="rounded-2xl border border-cyan-300/15 bg-cyan-300/[0.05] p-4" data-testid="archive-bridge-native-syncing">
          <div className="flex items-center gap-3">
            <Loader2 className="animate-spin text-cyan-200" size={18} aria-hidden="true" />
            <p className="text-sm font-bold text-cyan-100">A provider sync is running…</p>
          </div>
        </div>
      ) : (
        <div
          className={`rounded-2xl border p-4 ${status.state === "ready" ? "border-emerald-300/15 bg-emerald-300/[0.06]" : "border-amber-300/15 bg-amber-300/[0.05]"}`}
          data-testid={`archive-bridge-native-${status.state}`}
        >
          <div className="flex items-start gap-3">
            {status.state === "ready" ? (
              <CheckCircle2 className="mt-0.5 shrink-0 text-emerald-200" size={18} aria-hidden="true" />
            ) : (
              <CircleAlert className="mt-0.5 shrink-0 text-amber-200" size={18} aria-hidden="true" />
            )}
            <div className="w-full">
              <p className="text-sm font-bold text-white">
                Archive Assistant (native)
                <span className="ml-2 font-mono text-[11px] font-normal text-slate-400">
                  {status.providers} provider{status.providers === 1 ? "" : "s"}
                </span>
              </p>
              <div className="mt-3 grid gap-2 sm:grid-cols-3">
                <div className="rounded-xl border border-white/10 bg-black/20 p-3">
                  <p className="text-[10px] font-bold uppercase tracking-[0.14em] text-slate-500">Needs you</p>
                  <p className="mt-1 text-sm font-bold text-white">{status.attentionCount}</p>
                </div>
                <div className="rounded-xl border border-white/10 bg-black/20 p-3">
                  <p className="text-[10px] font-bold uppercase tracking-[0.14em] text-slate-500">Last sync</p>
                  <p className="mt-1 text-sm font-bold text-white">
                    {status.lastSync ? new Date(status.lastSync).toLocaleString() : "never"}
                  </p>
                </div>
                <div className="rounded-xl border border-white/10 bg-black/20 p-3">
                  <p className="text-[10px] font-bold uppercase tracking-[0.14em] text-slate-500">Scan</p>
                  <p className="mt-1 text-sm font-bold text-white">{status.scanStatus}</p>
                </div>
              </div>
              {status.lastErrors.length > 0 && (
                <ul className="mt-2 space-y-1">
                  {status.lastErrors.map((e) => (
                    <li key={e} className="break-words text-xs text-amber-300/80">⚠ {e}</li>
                  ))}
                </ul>
              )}
              {status.informational.length > 0 && (
                <ul className="mt-2 space-y-1">
                  {status.informational.map((line) => (
                    <li key={line} className="flex items-start gap-2 text-xs leading-5 text-slate-400">
                      <Info size={12} className="mt-0.5 shrink-0" aria-hidden="true" />
                      {line}
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </div>
        </div>
      )}

      {/* providers */}
      <div className="rounded-2xl border border-white/10 bg-white/[0.03] p-5">
        <h3 className="text-sm font-bold uppercase tracking-wider text-slate-400">Media servers</h3>
        {providers.length > 0 && (
          <ul className="mt-3 space-y-2">
            {providers.map((provider) => (
              <li key={provider.id} className="flex flex-wrap items-center gap-3 rounded-xl border border-cyan-400/15 bg-cyan-400/5 px-4 py-3">
                <div className="min-w-0">
                  <p className="text-sm font-bold text-white">
                    {provider.kind}
                    <span className="ml-2 font-mono text-[11px] font-normal text-slate-400">{provider.baseUrl}</span>
                  </p>
                  <p className="text-[11px] text-slate-400">
                    {provider.lastSyncAt ? `last sync ${new Date(provider.lastSyncAt).toLocaleString()}` : "never synced"}
                    {provider.lastError ? ` · ⚠ ${provider.lastError.slice(0, 80)}` : ""}
                  </p>
                </div>
                <div className="ml-auto flex items-center gap-2">
                  <button className={action} disabled={busy !== null} onClick={() => void syncProvider(provider.kind)}>
                    <RefreshCw size={11} className="mr-1 inline" aria-hidden="true" />
                    {busy === `sync-${provider.kind}` ? "Syncing…" : "Sync"}
                  </button>
                  <button className={ghost} disabled={busy !== null} onClick={() => void removeProvider(provider.kind)}>
                    Remove
                  </button>
                </div>
              </li>
            ))}
          </ul>
        )}
        <details className="mt-3">
          <summary className="cursor-pointer text-xs font-bold uppercase tracking-wider text-slate-400">
            {providers.length ? "Add another server" : "Connect a server"}
          </summary>
          <div className="mt-2 grid gap-2 sm:grid-cols-2">
            <select className={input} value={kind} onChange={(e) => setKind(e.target.value as "plex" | "jellyfin")}>
              <option value="plex">Plex</option>
              <option value="jellyfin">Jellyfin</option>
            </select>
            <input className={input} value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} placeholder="http://192.168.1.10:32400" />
            <input className={input} type="password" value={token} onChange={(e) => setToken(e.target.value)} placeholder={kind === "plex" ? "X-Plex-Token" : "API key"} />
            {kind === "jellyfin" ? (
              <input className={input} value={username} onChange={(e) => setUsername(e.target.value)} placeholder="User id (optional — first user is used)" />
            ) : (
              <input className={input} disabled placeholder="Token stays on this machine (sealed)" />
            )}
          </div>
          <div className="mt-2 flex gap-2">
            <button className={action} disabled={busy !== null || !baseUrl.trim() || !token} onClick={() => void testProvider()}>
              {busy === "test" ? "Testing…" : "Test connection"}
            </button>
            <button className={action} disabled={busy !== null || !baseUrl.trim() || !token} onClick={() => void saveProvider()}>
              {busy === "save" ? "Saving…" : "Save"}
            </button>
          </div>
        </details>
        <button className={`${action} mt-3`} disabled={busy !== null} onClick={() => void reconcile()}>
          {busy === "reconcile" ? "Reconciling…" : "Run reconciliation"}
        </button>
      </div>

      {/* review workload */}
      <div className="rounded-2xl border border-white/10 bg-white/[0.03] p-5">
        <h3 className="text-sm font-bold uppercase tracking-wider text-slate-400">
          Review queue {open.length > 0 && <span className="ml-1 text-cyan-300">({open.length} open)</span>}
        </h3>
        <ul className="mt-3 space-y-2">
          {open.slice(0, 12).map((item) => (
            <li key={item.id} className="rounded-xl border border-white/10 bg-black/30 p-3">
              <div className="flex flex-wrap items-baseline gap-2">
                <p className="min-w-0 flex-1 text-sm font-bold text-white">{item.title}</p>
                <span className="rounded bg-white/10 px-1.5 py-0.5 text-[10px] font-bold text-slate-300">
                  {item.kind}
                  {item.classification ? ` · ${item.classification}` : ""}
                  {item.state === "uncertain" ? " · uncertain" : ""}
                </span>
              </div>
              <p className="mt-1 text-xs leading-5 text-slate-400">{item.summary}</p>
              {item.evidence.length > 0 && (
                <p className="mt-1 text-[11px] text-slate-500">evidence: {item.evidence.join(" · ")}</p>
              )}
              <div className="mt-2 flex items-center gap-2">
                <button className={action} disabled={busy !== null} onClick={() => void decide(item.id, "approve")}>
                  {busy === `decide-${item.id}` ? "…" : "Approve"}
                </button>
                <button className={ghost} disabled={busy !== null} onClick={() => void decide(item.id, "reject")}>
                  Dismiss
                </button>
              </div>
            </li>
          ))}
          {open.length === 0 && (
            <li className="py-6 text-center text-sm text-slate-500">
              Nothing needs you. Sync a server and run reconciliation to find drift.
            </li>
          )}
        </ul>
        {(reviews.some((r) => r.state === "completed") || reviews.some((r) => r.state === "dismissed")) && (
          <details className="mt-2">
            <summary className="cursor-pointer text-xs text-slate-500">
              {reviews.filter((r) => r.state === "completed").length} approved ·{" "}
              {reviews.filter((r) => r.state === "dismissed").length} dismissed (reopen anytime)
            </summary>
            <ul className="mt-2 space-y-1">
              {reviews
                .filter((r) => r.state === "completed" || r.state === "dismissed" || r.state === "superseded")
                .map((item) => (
                  <li key={item.id} className="flex items-center gap-2 text-xs text-slate-500">
                    <span className="rounded bg-white/5 px-1.5 py-0.5">{item.state}</span>
                    <span className="min-w-0 flex-1 truncate">{item.title}</span>
                    <button className="text-cyan-300 hover:text-white" disabled={busy !== null} onClick={() => void decide(item.id, "reopen")}>
                      reopen
                    </button>
                  </li>
                ))}
            </ul>
          </details>
        )}
        <ArchiveFindingLineage connected />
        <p className="mt-3 text-xs leading-5 text-slate-500">
          Read-only toward your servers; decisions are recorded, never auto-executed — Arena does not rename, move,
          delete or download anything. Full bounded context:{" "}
          <a href="/api/archive/context" className="font-bold text-cyan-200 hover:text-white">
            /api/archive/context
          </a>
          .
        </p>
      </div>

      {message && <p className="break-words text-xs text-cyan-300">{message}</p>}
    </div>
  );
}
