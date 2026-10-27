"use client";

// Archive Assistant — a chat agent with tools over the whole platform,
// plus the searchable archive index panel it manages.
//
// The assistant browses and drives the workspace (spaces, congress,
// artifacts, projects) and catalogs files: register → scan (AI describes,
// tags, collections) → search. Files are referenced, never moved; AI
// metadata is a draft the human can edit on any card.

import { useCallback, useEffect, useRef, useState } from "react";
import Markdown from "@/components/Markdown";
import { loadKeys } from "@/components/KeysBar";
import { privacyFlags } from "@/lib/privacyClient";

interface ModelInfo {
  id: string;
  name: string;
  emoji: string;
  kind: string;
}

interface AssistantStep {
  tool: string;
  args: Record<string, unknown>;
  ok: boolean;
  ms: number;
  summary: string;
}

interface ChatMessage {
  role: "user" | "assistant";
  content: string;
  steps?: AssistantStep[];
  via?: string;
}

interface ArchiveItemView {
  id: string;
  name: string;
  path: string | null;
  kind: string;
  sizeBytes: number | null;
  status: string;
  description: string;
  tags: string[];
  collection: string;
  possibleDupOf: string | null;
  createdAt: string;
}

interface StatsView {
  total: number;
  inbox: number;
  indexed: number;
  duplicates: number;
  byKind: Record<string, number>;
  collections: { name: string; n: number }[];
}

const KIND_EMOJI: Record<string, string> = {
  video: "🎬", image: "🖼️", audio: "🎵", doc: "📄", data: "📊", other: "📦",
};

function fmtSize(n: number | null): string {
  if (n == null) return "";
  if (n < 1024) return `${n} B`;
  if (n < 1024 ** 2) return `${(n / 1024).toFixed(0)} KB`;
  if (n < 1024 ** 3) return `${(n / 1024 ** 2).toFixed(1)} MB`;
  return `${(n / 1024 ** 3).toFixed(2)} GB`;
}

export default function ArchiveAssistant() {
  // ---- chat state ----
  const [messages, setMessages] = useState<ChatMessage[]>([
    {
      role: "assistant",
      content:
        "**🗂️ Archive Assistant** — I live in this workspace and can *understand, browse and use* what you've built.\n\n" +
        "I can list your spaces, projects and congress sessions; create and force-run spaces; convene a congress; " +
        "save artifacts — and I manage the **archive index** on the right: register files, scan them for AI descriptions/tags/collections, " +
        "flag duplicates, and search everything.\n\nTry: *“what modules do I have”*, *“list my spaces”*, *“search archive for beethoven”*.",
      via: "intro",
    },
  ]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [modelId, setModelId] = useState("openai");
  const [models, setModels] = useState<ModelInfo[]>([]);
  const scrollRef = useRef<HTMLDivElement>(null);

  // ---- archive state ----
  const [items, setItems] = useState<ArchiveItemView[]>([]);
  const [stats, setStats] = useState<StatsView | null>(null);
  const [q, setQ] = useState("");
  const [kindFilter, setKindFilter] = useState("");
  const [statusFilter, setStatusFilter] = useState("");
  const [addOpen, setAddOpen] = useState(false);
  const [addText, setAddText] = useState("");
  const [addMsg, setAddMsg] = useState("");
  const [scanning, setScanning] = useState(false);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [editTags, setEditTags] = useState("");
  const [editCollection, setEditCollection] = useState("");

  const textModels = models.filter((m) => m.kind === "text");

  useEffect(() => {
    void (async () => {
      await Promise.resolve();
      try {
        const res = await fetch("/api/models");
        const data = await res.json();
        if (Array.isArray(data.models)) setModels(data.models);
      } catch {
        /* offline */
      }
    })();
  }, []);

  const refreshArchive = useCallback(async () => {
    try {
      const params = new URLSearchParams();
      if (q.trim()) params.set("q", q.trim());
      if (kindFilter) params.set("kind", kindFilter);
      if (statusFilter) params.set("status", statusFilter);
      const res = await fetch(`/api/archive/items?${params.toString()}`);
      const data = await res.json();
      if (Array.isArray(data.items)) setItems(data.items);
      if (data.stats) setStats(data.stats);
    } catch {
      /* offline */
    }
  }, [q, kindFilter, statusFilter]);

  useEffect(() => {
    void (async () => {
      await Promise.resolve();
      void refreshArchive();
    })();
  }, [refreshArchive]);

  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages, busy]);

  // ---- chat ----
  async function send(text: string) {
    const content = text.trim();
    if (!content || busy) return;
    setInput("");
    setBusy(true);
    const history = [...messages, { role: "user" as const, content }];
    setMessages(history);
    try {
      const res = await fetch("/api/archive/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          messages: history.filter((m) => m.via !== "intro").map((m) => ({ role: m.role, content: m.content })),
          modelId,
          keys: loadKeys(),
          localOnly: privacyFlags().localOnly,
        }),
      });
      const data = await res.json();
      setMessages((prev) => [
        ...prev,
        { role: "assistant", content: data.reply ?? data.error ?? "(no reply)", steps: data.steps ?? [], via: data.via },
      ]);
      // tools may have touched the archive — refresh the panel
      void refreshArchive();
    } catch {
      setMessages((prev) => [...prev, { role: "assistant", content: "(network error — try again)" }]);
    } finally {
      setBusy(false);
    }
  }

  // ---- archive actions ----
  async function addFiles() {
    const files = addText
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean)
      .map((l) => {
        const [name, kind, size, ...rest] = l.split("|").map((p) => p.trim());
        const sizeBytes = size ? Math.floor(Number(size.replace(/[^0-9]/g, ""))) || null : null;
        return { name, kind: kind || undefined, sizeBytes, path: rest.join("|") || undefined };
      });
    if (!files.length) return;
    try {
      const res = await fetch("/api/archive/items", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ files }),
      });
      const data = await res.json();
      setAddMsg(
        data.added
          ? `+${data.added.length} added${data.duplicates?.length ? `, ${data.duplicates.length} exact duplicate(s) skipped` : ""}`
          : (data.error ?? "failed")
      );
      setAddText("");
      void refreshArchive();
    } catch {
      setAddMsg("failed");
    }
  }

  async function scan() {
    setScanning(true);
    try {
      const res = await fetch("/api/archive/scan", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ keys: loadKeys(), localOnly: privacyFlags().localOnly, limit: 8 }),
      });
      await res.json();
      void refreshArchive();
    } catch {
      /* offline */
    } finally {
      setScanning(false);
    }
  }

  async function patchItem(id: string, patch: Record<string, unknown>) {
    try {
      await fetch("/api/archive/items", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id, ...patch }),
      });
      void refreshArchive();
    } catch {
      /* offline */
    }
  }

  function openItem(item: ArchiveItemView) {
    if (expanded === item.id) {
      setExpanded(null);
      return;
    }
    setExpanded(item.id);
    setEditTags(item.tags.join(", "));
    setEditCollection(item.collection);
  }

  return (
    <div className="mx-auto max-w-7xl px-4 py-8">
      {/* ---- header ---- */}
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-black tracking-tight text-white">🗂️ Archive Assistant</h1>
          <p className="mt-1 max-w-2xl text-sm text-slate-400">
            An agent that <strong className="text-slate-300">understands, browses and uses</strong> the tools in this
            workspace — and catalogs your files into a searchable archive index (referenced, never moved).
          </p>
        </div>
        <div className="flex items-center gap-2">
          <select
            value={modelId}
            onChange={(e) => setModelId(e.target.value)}
            className="rounded-xl border border-white/10 bg-black/40 px-3 py-2 text-xs font-bold text-white outline-none"
          >
            {textModels.length === 0 && <option value="openai">openai</option>}
            {textModels.map((m) => (
              <option key={m.id} value={m.id}>
                {m.emoji} {m.name}
              </option>
            ))}
          </select>
        </div>
      </div>

      <div className="mt-6 grid gap-5 lg:grid-cols-[1fr_400px]">
        {/* ---- left: chat ---- */}
        <div className="glass flex h-[72vh] min-h-[520px] flex-col rounded-2xl p-4">
          <div ref={scrollRef} className="flex-1 space-y-4 overflow-y-auto pr-1">
            {messages.map((m, i) => (
              <div key={i} className={m.role === "user" ? "flex justify-end" : ""}>
                <div
                  className={
                    m.role === "user"
                      ? "max-w-[85%] rounded-2xl rounded-br-md bg-cyan-500/15 px-4 py-2.5 text-sm text-cyan-50 ring-1 ring-cyan-400/30"
                      : "max-w-[92%] rounded-2xl rounded-bl-md bg-white/5 px-4 py-3 text-sm text-slate-200 ring-1 ring-white/10"
                  }
                >
                  {m.role === "assistant" ? <Markdown text={m.content} /> : <p className="whitespace-pre-wrap">{m.content}</p>}
                  {m.steps && m.steps.length > 0 && (
                    <div className="mt-2 space-y-1">
                      {m.steps.map((s, j) => (
                        <details key={j} className="rounded-lg bg-black/30 px-2.5 py-1.5 text-[11px] text-slate-400">
                          <summary className="cursor-pointer font-mono">
                            🔧 {s.tool} {s.ok ? "✓" : "✗"} · {s.ms}ms
                          </summary>
                          <pre className="mt-1 max-h-40 overflow-auto whitespace-pre-wrap break-all font-mono text-[10px] text-slate-500">
                            {s.summary}
                          </pre>
                        </details>
                      ))}
                    </div>
                  )}
                  {m.via && m.role === "assistant" && i > 0 && (
                    <div className="mt-1.5 text-[10px] font-mono text-slate-500">via {m.via}</div>
                  )}
                </div>
              </div>
            ))}
            {busy && <div className="text-xs font-mono text-slate-500">thinking / calling tools…</div>}
          </div>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void send(input);
            }}
            className="mt-3 flex gap-2"
          >
            <input
              value={input}
              onChange={(e) => setInput(e.target.value)}
              placeholder="ask anything — 'list my spaces', 'search archive for sunset', 'convene a congress on pricing'…"
              className="flex-1 rounded-xl border border-white/10 bg-black/40 px-4 py-2.5 text-sm text-white outline-none focus:border-cyan-400/60"
            />
            <button
              type="submit"
              disabled={busy || !input.trim()}
              className="rounded-xl bg-cyan-500 px-4 py-2.5 text-sm font-black text-black transition hover:bg-cyan-400 disabled:opacity-40"
            >
              Send
            </button>
          </form>
        </div>

        {/* ---- right: archive index ---- */}
        <div className="glass flex h-[72vh] min-h-[520px] flex-col rounded-2xl p-4">
          <div className="flex items-center justify-between">
            <h2 className="text-sm font-extrabold text-white">📦 Archive index</h2>
            <div className="flex gap-1.5">
              <button
                onClick={() => setAddOpen((v) => !v)}
                className="rounded-lg bg-white/5 px-2.5 py-1 text-[11px] font-bold text-slate-300 ring-1 ring-white/10 hover:bg-white/10"
              >
                ➕ Add
              </button>
              <button
                onClick={() => void scan()}
                disabled={scanning}
                className="rounded-lg bg-cyan-500/15 px-2.5 py-1 text-[11px] font-bold text-cyan-100 ring-1 ring-cyan-400/30 hover:bg-cyan-500/25 disabled:opacity-40"
              >
                {scanning ? "scanning…" : "🔍 Scan"}
              </button>
            </div>
          </div>

          {stats && (
            <div className="mt-2 flex flex-wrap gap-1.5 text-[10px] font-bold">
              <span className="rounded-full bg-white/5 px-2 py-1 text-slate-300 ring-1 ring-white/10">{stats.total} items</span>
              <span className="rounded-full bg-amber-400/10 px-2 py-1 text-amber-200 ring-1 ring-amber-400/20">{stats.inbox} inbox</span>
              <span className="rounded-full bg-emerald-400/10 px-2 py-1 text-emerald-200 ring-1 ring-emerald-400/20">{stats.indexed} indexed</span>
              {stats.duplicates > 0 && (
                <span className="rounded-full bg-rose-400/10 px-2 py-1 text-rose-200 ring-1 ring-rose-400/20">{stats.duplicates} dupes</span>
              )}
              {stats.collections.slice(0, 3).map((c) => (
                <span key={c.name} className="rounded-full bg-violet-400/10 px-2 py-1 text-violet-200 ring-1 ring-violet-400/20">
                  {c.name} ({c.n})
                </span>
              ))}
            </div>
          )}

          {addOpen && (
            <div className="mt-2 rounded-xl bg-black/30 p-2.5">
              <p className="text-[10px] leading-relaxed text-slate-500">
                One file per line: <span className="font-mono">name | kind | size | path</span> (kind/size/path optional —
                kind auto-guessed from extension). Exact duplicates (hash or name+size) are skipped.
              </p>
              <textarea
                value={addText}
                onChange={(e) => setAddText(e.target.value)}
                rows={4}
                placeholder={"beach_trip_2023.mp4 | video | 1.2GB | /media/vids\nIMG_4471.heic\nreceipt_feb.pdf | doc"}
                className="mt-1.5 w-full rounded-lg border border-white/10 bg-black/40 px-2.5 py-2 font-mono text-[11px] text-white outline-none focus:border-cyan-400/60"
              />
              <div className="mt-1.5 flex items-center gap-2">
                <button
                  onClick={() => void addFiles()}
                  className="rounded-lg bg-cyan-500 px-2.5 py-1 text-[11px] font-black text-black hover:bg-cyan-400"
                >
                  Register
                </button>
                {addMsg && <span className="text-[10px] text-slate-400">{addMsg}</span>}
              </div>
            </div>
          )}

          <form
            onSubmit={(e) => {
              e.preventDefault();
              void refreshArchive();
            }}
            className="mt-2 flex gap-1.5"
          >
            <input
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="search the index…"
              className="flex-1 rounded-lg border border-white/10 bg-black/40 px-2.5 py-1.5 text-xs text-white outline-none focus:border-cyan-400/60"
            />
            <select
              value={kindFilter}
              onChange={(e) => setKindFilter(e.target.value)}
              className="rounded-lg border border-white/10 bg-black/40 px-1.5 py-1.5 text-[11px] text-white outline-none"
            >
              <option value="">all</option>
              {["video", "image", "audio", "doc", "data", "other"].map((k) => (
                <option key={k} value={k}>
                  {k}
                </option>
              ))}
            </select>
            <select
              value={statusFilter}
              onChange={(e) => setStatusFilter(e.target.value)}
              className="rounded-lg border border-white/10 bg-black/40 px-1.5 py-1.5 text-[11px] text-white outline-none"
            >
              <option value="">any status</option>
              {["inbox", "indexed", "duplicate"].map((s) => (
                <option key={s} value={s}>
                  {s}
                </option>
              ))}
            </select>
          </form>

          <div className="mt-2 flex-1 space-y-1.5 overflow-y-auto pr-1">
            {items.length === 0 && (
              <p className="px-1 py-6 text-center text-xs text-slate-500">
                Nothing indexed yet — add files above, or ask the assistant to do it.
              </p>
            )}
            {items.map((item) => (
              <div
                key={item.id}
                className="cursor-pointer rounded-xl bg-white/5 px-3 py-2 ring-1 ring-white/10 transition hover:bg-white/10"
                onClick={() => openItem(item)}
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="truncate text-xs font-bold text-white">
                    {KIND_EMOJI[item.kind] ?? "📦"} {item.name}
                  </span>
                  <span
                    className={`shrink-0 rounded-full px-1.5 py-0.5 text-[9px] font-black uppercase ${
                      item.status === "indexed"
                        ? "bg-emerald-400/10 text-emerald-200"
                        : item.status === "duplicate"
                          ? "bg-rose-400/10 text-rose-200"
                          : "bg-amber-400/10 text-amber-200"
                    }`}
                  >
                    {item.status}
                  </span>
                </div>
                {item.description && <p className="mt-0.5 line-clamp-2 text-[11px] text-slate-400">{item.description}</p>}
                <div className="mt-1 flex flex-wrap gap-1 text-[9px] font-bold text-slate-500">
                  {item.sizeBytes != null && <span>{fmtSize(item.sizeBytes)}</span>}
                  {item.collection && <span className="text-violet-300">· {item.collection}</span>}
                  {item.tags.slice(0, 4).map((t) => (
                    <span key={t} className="rounded bg-white/5 px-1">
                      #{t}
                    </span>
                  ))}
                  {item.possibleDupOf && <span className="text-rose-300">· near-dupe?</span>}
                </div>

                {expanded === item.id && (
                  <div className="mt-2 border-t border-white/10 pt-2" onClick={(e) => e.stopPropagation()}>
                    {item.path && <p className="break-all font-mono text-[10px] text-slate-500">{item.path}</p>}
                    <p className="mt-1 text-[10px] text-slate-500">added {new Date(item.createdAt).toLocaleString()}</p>
                    <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
                      <input
                        value={editTags}
                        onChange={(e) => setEditTags(e.target.value)}
                        placeholder="tags, comma, separated"
                        className="w-40 rounded-lg border border-white/10 bg-black/40 px-2 py-1 text-[11px] text-white outline-none"
                      />
                      <input
                        value={editCollection}
                        onChange={(e) => setEditCollection(e.target.value)}
                        placeholder="collection"
                        className="w-28 rounded-lg border border-white/10 bg-black/40 px-2 py-1 text-[11px] text-white outline-none"
                      />
                      <button
                        onClick={() =>
                          void patchItem(item.id, {
                            tags: editTags.split(",").map((t) => t.trim()).filter(Boolean),
                            collection: editCollection,
                          })
                        }
                        className="rounded-lg bg-cyan-500/20 px-2 py-1 text-[10px] font-black text-cyan-100 hover:bg-cyan-500/30"
                      >
                        Save
                      </button>
                      {item.status !== "duplicate" && (
                        <button
                          onClick={() => void patchItem(item.id, { status: "duplicate" })}
                          className="rounded-lg bg-rose-500/15 px-2 py-1 text-[10px] font-black text-rose-200 hover:bg-rose-500/25"
                        >
                          Mark dupe
                        </button>
                      )}
                      {item.status !== "indexed" && (
                        <button
                          onClick={() => void patchItem(item.id, { status: "indexed" })}
                          className="rounded-lg bg-emerald-500/15 px-2 py-1 text-[10px] font-black text-emerald-200 hover:bg-emerald-500/25"
                        >
                          Mark indexed
                        </button>
                      )}
                    </div>
                  </div>
                )}
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
