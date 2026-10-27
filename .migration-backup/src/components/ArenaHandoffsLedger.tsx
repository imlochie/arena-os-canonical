"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import {
  Check,
  CheckCircle2,
  Clipboard,
  FileText,
  Inbox,
  LoaderCircle,
  RefreshCw,
  ShieldAlert,
  Trash2,
} from "lucide-react";
import {
  readArenaHandoffs,
  writeArenaHandoffs,
  type ArenaHandoff,
  type HandoffStatus,
} from "@/lib/arenaHandoffs";
import { getArenaRoom } from "@/lib/arenaRooms";

type Filter = "all" | HandoffStatus;

function formatDate(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "Unknown date";
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(date);
}

export default function ArenaHandoffsLedger() {
  const [records, setRecords] = useState<ArenaHandoff[]>([]);
  const [filter, setFilter] = useState<Filter>("all");
  const [loading, setLoading] = useState(true);
  const [storageError, setStorageError] = useState<string | null>(null);
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  function loadRecords() {
    setLoading(true);
    setActionError(null);
    const result = readArenaHandoffs();
    if (result.ok) {
      setRecords(result.records);
      setStorageError(null);
    } else {
      setRecords([]);
      setStorageError(result.error);
    }
    setLoading(false);
  }

  useEffect(() => {
    loadRecords();
  }, []);

  const visibleRecords = useMemo(
    () => (filter === "all" ? records : records.filter((record) => record.status === filter)),
    [filter, records],
  );

  function updateRecords(transform: (current: ArenaHandoff[]) => ArenaHandoff[]) {
    setActionError(null);
    const current = readArenaHandoffs();
    if (!current.ok) {
      setStorageError(current.error);
      return;
    }
    const next = transform(current.records);
    const result = writeArenaHandoffs(next);
    if (!result.ok) {
      setStorageError(result.error);
      return;
    }
    setRecords(next);
  }

  function markReviewed(id: string) {
    updateRecords((current) =>
      current.map((record) =>
        record.id === id ? { ...record, status: "reviewed" as const } : record,
      ),
    );
  }

  function removeRecord(id: string) {
    if (!window.confirm("Delete this handoff from this browser?")) return;
    updateRecords((current) => current.filter((record) => record.id !== id));
  }

  async function copyPayload(record: ArenaHandoff) {
    setActionError(null);
    try {
      await navigator.clipboard.writeText(record.payload);
      setCopiedId(record.id);
      window.setTimeout(() => setCopiedId((current) => (current === record.id ? null : current)), 1600);
    } catch {
      setActionError("Payload could not be copied. Your browser did not grant clipboard access.");
    }
  }

  return (
    <section className="mx-auto w-full max-w-6xl px-4 py-8 sm:px-6 sm:py-12" data-testid="arena-handoffs-ledger">
      <div className="flex flex-col justify-between gap-5 border-b border-white/10 pb-7 sm:flex-row sm:items-end">
        <div>
          <Link
            href="/rooms"
            className="inline-flex items-center gap-2 text-xs font-bold text-slate-400 transition hover:text-white"
            data-testid="handoffs-rooms-link"
          >
            Room directory
          </Link>
          <p className="mt-6 flex items-center gap-2 text-[11px] font-bold uppercase tracking-[0.2em] text-cyan-200/80">
            <Inbox size={14} aria-hidden="true" />
            User-controlled transfers
          </p>
          <h1 className="mt-3 text-4xl font-black tracking-[-0.05em] text-white sm:text-5xl">
            Handoff ledger
          </h1>
          <p className="mt-3 max-w-2xl text-sm leading-6 text-slate-400">
            Metadata saved in this browser. Review the destination before you decide what to
            do next; nothing here auto-sends a payload.
          </p>
        </div>
        <Link
          href="/rooms"
          className="btn-arena inline-flex min-h-11 items-center justify-center gap-2 rounded-xl px-4 py-3 text-sm font-extrabold text-white"
          data-testid="ledger-new-handoff"
        >
          New handoff
          <FileText size={15} aria-hidden="true" />
        </Link>
      </div>

      <div className="mt-6 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex flex-wrap gap-2" role="group" aria-label="Filter handoffs">
          {(["all", "queued", "reviewed"] as Filter[]).map((option) => (
            <button
              key={option}
              type="button"
              aria-pressed={filter === option}
              onClick={() => setFilter(option)}
              className={`rounded-full px-3.5 py-2 text-xs font-bold capitalize transition ${
                filter === option
                  ? "bg-violet-500/25 text-white ring-1 ring-violet-300/40"
                  : "border border-white/10 bg-white/[0.04] text-slate-400 hover:bg-white/[0.08] hover:text-white"
              }`}
              data-testid={`handoff-filter-${option}`}
            >
              {option}
            </button>
          ))}
        </div>
        <button
          type="button"
          onClick={loadRecords}
          className="inline-flex items-center gap-2 self-start rounded-lg px-2 py-2 text-xs font-bold text-slate-400 transition hover:bg-white/5 hover:text-white sm:self-auto"
          data-testid="handoffs-refresh"
        >
          <RefreshCw size={14} aria-hidden="true" />
          Refresh
        </button>
      </div>

      {storageError ? (
        <div className="mt-5 flex items-start justify-between gap-4 rounded-2xl border border-amber-300/20 bg-amber-300/[0.07] p-4 text-sm text-amber-100" role="alert" data-testid="handoffs-storage-error">
          <div className="flex gap-3">
            <ShieldAlert size={18} className="mt-0.5 shrink-0" aria-hidden="true" />
            <div>
              <p className="font-bold">Storage is unavailable</p>
              <p className="mt-1 text-xs leading-5 text-amber-100/75">{storageError}</p>
            </div>
          </div>
          <button type="button" onClick={loadRecords} className="shrink-0 text-xs font-bold underline underline-offset-4" data-testid="handoffs-retry">
            Retry
          </button>
        </div>
      ) : null}

      {actionError ? (
        <div className="mt-5 flex items-center gap-2 rounded-xl border border-rose-300/20 bg-rose-300/[0.07] p-3 text-xs text-rose-100" role="alert" data-testid="handoffs-action-error">
          <ShieldAlert size={15} aria-hidden="true" />
          {actionError}
        </div>
      ) : null}

      {loading ? (
        <div className="mt-6 space-y-3" data-testid="handoffs-loading" aria-label="Loading handoffs">
          {[1, 2, 3].map((item) => (
            <div key={item} className="glass h-36 animate-pulse rounded-2xl p-5">
              <div className="h-4 w-1/3 rounded bg-white/10" />
              <div className="mt-4 h-3 w-2/3 rounded bg-white/10" />
              <div className="mt-5 h-8 w-full rounded bg-white/5" />
            </div>
          ))}
        </div>
      ) : visibleRecords.length === 0 ? (
        <div className="glass mt-6 rounded-[24px] border-dashed p-10 text-center" data-testid="handoffs-empty">
          <span className="mx-auto grid h-12 w-12 place-items-center rounded-2xl border border-violet-300/20 bg-violet-300/10 text-violet-200">
            <Inbox size={21} aria-hidden="true" />
          </span>
          <h2 className="mt-5 text-lg font-extrabold text-white">
            {filter === "all" ? "No handoffs yet" : `No ${filter} handoffs`}
          </h2>
          <p className="mx-auto mt-2 max-w-md text-sm leading-6 text-slate-400">
            {filter === "all"
              ? "Start from a room when you have context worth making visible to another surface."
              : "Try another filter or create a new handoff from a room."}
          </p>
          <Link
            href="/rooms"
            className="mt-5 inline-flex items-center gap-2 text-sm font-bold text-cyan-200 hover:text-white"
            data-testid="handoffs-empty-rooms"
          >
            Browse rooms
            <RefreshCw size={14} aria-hidden="true" />
          </Link>
        </div>
      ) : (
        <div className="mt-6 space-y-3">
          {visibleRecords.map((record) => {
            const source = getArenaRoom(record.fromRoomId);
            const destination = getArenaRoom(record.toRoomId);
            const reviewed = record.status === "reviewed";

            return (
              <article
                key={record.id}
                className="glass rounded-2xl p-5 transition hover:border-violet-300/25 sm:p-6"
                data-testid={`handoff-record-${record.id}`}
              >
                <div className="flex flex-col justify-between gap-4 lg:flex-row lg:items-start">
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className={`rounded-full px-2.5 py-1 text-[10px] font-bold uppercase tracking-[0.14em] ${
                        reviewed
                          ? "border border-emerald-300/20 bg-emerald-300/10 text-emerald-100"
                          : "border border-amber-300/20 bg-amber-300/10 text-amber-100"
                      }`}>
                        {reviewed ? "Reviewed" : "Queued"}
                      </span>
                      <span className="text-xs text-slate-500">{formatDate(record.createdAt)}</span>
                    </div>
                    <h2 className="mt-3 truncate text-lg font-extrabold text-white">{record.title}</h2>
                    <div className="mt-2 flex flex-wrap items-center gap-2 text-sm text-slate-400">
                      <Link href={`/rooms/${record.fromRoomId}`} className="font-semibold text-violet-200 hover:text-white" data-testid={`handoff-source-${record.id}`}>
                        {source?.name ?? record.fromRoomId}
                      </Link>
                      <span className="text-slate-600" aria-hidden="true">→</span>
                      <Link href={`/rooms/${record.toRoomId}`} className="font-semibold text-cyan-200 hover:text-white" data-testid={`handoff-destination-${record.id}`}>
                        {destination?.name ?? record.toRoomId}
                      </Link>
                      {record.projectId ? (
                        <Link
                          href={`/projects/${record.projectId}`}
                          className="rounded-full border border-white/10 bg-white/5 px-2 py-1 text-[10px] font-bold text-slate-300 transition hover:border-cyan-300/30 hover:text-cyan-100"
                          data-testid={`handoff-project-${record.id}`}
                        >
                          Project linked
                        </Link>
                      ) : (
                        <span className="rounded-full border border-white/10 bg-white/5 px-2 py-1 text-[10px] font-bold text-slate-500">
                          No project
                        </span>
                      )}
                    </div>
                  </div>
                  <div className="flex shrink-0 flex-wrap gap-2">
                    {!reviewed ? (
                      <button
                        type="button"
                        onClick={() => markReviewed(record.id)}
                        disabled={Boolean(storageError)}
                        className="inline-flex items-center gap-2 rounded-lg border border-emerald-300/20 bg-emerald-300/10 px-3 py-2 text-xs font-bold text-emerald-100 transition hover:bg-emerald-300/20 disabled:cursor-not-allowed disabled:opacity-50"
                        data-testid={`handoff-review-${record.id}`}
                      >
                        <CheckCircle2 size={14} aria-hidden="true" />
                        Mark reviewed
                      </button>
                    ) : null}
                    <button
                      type="button"
                      onClick={() => removeRecord(record.id)}
                      disabled={Boolean(storageError)}
                      className="inline-flex items-center gap-2 rounded-lg border border-rose-300/15 bg-rose-300/[0.06] px-3 py-2 text-xs font-bold text-rose-100 transition hover:bg-rose-300/15 disabled:cursor-not-allowed disabled:opacity-50"
                      data-testid={`handoff-delete-${record.id}`}
                    >
                      <Trash2 size={14} aria-hidden="true" />
                      Delete
                    </button>
                  </div>
                </div>

                <div className="mt-5 rounded-xl border border-white/10 bg-black/20 p-4">
                  <div className="flex items-center justify-between gap-3">
                    <p className="flex items-center gap-2 text-[10px] font-bold uppercase tracking-[0.16em] text-slate-500">
                      <FileText size={13} aria-hidden="true" />
                      Payload
                    </p>
                    <button
                      type="button"
                      onClick={() => copyPayload(record)}
                      className="inline-flex items-center gap-1.5 rounded-lg px-2 py-1.5 text-xs font-bold text-cyan-200 transition hover:bg-cyan-300/10 hover:text-white"
                      data-testid={`handoff-copy-${record.id}`}
                    >
                      {copiedId === record.id ? <Check size={13} aria-hidden="true" /> : <Clipboard size={13} aria-hidden="true" />}
                      {copiedId === record.id ? "Copied" : "Copy payload"}
                    </button>
                  </div>
                  <pre className="mt-3 max-h-48 overflow-auto whitespace-pre-wrap break-words font-mono text-xs leading-5 text-slate-300">
                    {record.payload}
                  </pre>
                </div>

                <div className="mt-4 flex items-center gap-2 text-xs text-slate-500">
                  <LoaderCircle size={13} className="text-violet-200" aria-hidden="true" />
                  Destination link opens the room only; it does not send this payload.
                </div>
              </article>
            );
          })}
        </div>
      )}
    </section>
  );
}