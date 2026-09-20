"use client";

import { useCallback, useEffect, useState } from "react";
import { useParams } from "next/navigation";
import Markdown from "@/components/Markdown";

const MEM_KINDS = [
  { id: "fact", label: "Facts", emoji: "📌" },
  { id: "decision", label: "Decisions", emoji: "✅" },
  { id: "preference", label: "Preferences", emoji: "💜" },
  { id: "open_question", label: "Open questions", emoji: "❓" },
  { id: "rejected_idea", label: "Rejected", emoji: "🚫" },
  { id: "source", label: "Sources", emoji: "🔗" },
];

export default function ProjectPage() {
  const { id } = useParams<{ id: string }>();
  const [data, setData] = useState<any | null>(null);
  const [memKind, setMemKind] = useState("fact");
  const [memText, setMemText] = useState("");
  const [memFilter, setMemFilter] = useState("all");
  const [artKind, setArtKind] = useState("brief");
  const [artTitle, setArtTitle] = useState("");
  const [artBody, setArtBody] = useState("");
  const [showArtForm, setShowArtForm] = useState(false);
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState("");
  const [desc, setDesc] = useState("");

  const refresh = useCallback(async () => {
    const r = await fetch(`/api/projects/${id}`);
    const j = await r.json();
    if (!j.error) {
      setData(j);
      setName(j.project.name);
      setDesc(j.project.description || "");
    }
  }, [id]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  async function addMemory() {
    if (!memText.trim()) return;
    await fetch(`/api/projects/${id}/memory`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ kind: memKind, content: memText.trim() }),
    });
    setMemText("");
    refresh();
  }

  async function addArtifact() {
    if (!artBody.trim()) return;
    await fetch(`/api/projects/${id}/artifacts`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ kind: artKind, title: artTitle.trim() || "Untitled", body: artBody }),
    });
    setArtTitle("");
    setArtBody("");
    setShowArtForm(false);
    refresh();
  }

  async function saveEdit() {
    await fetch(`/api/projects/${id}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name, description: desc }),
    });
    setEditing(false);
    refresh();
  }

  if (!data) return <p className="text-center text-sm text-slate-500">Loading workspace…</p>;
  const p = data.project;
  const mem = (data.memory ?? []).filter((m: any) => (memFilter === "all" ? true : m.kind === memFilter));

  return (
    <div className="mx-auto max-w-6xl">
      <a href="/projects" className="text-xs font-bold text-slate-400 hover:text-white">← All projects</a>
      <div className="mt-2 flex flex-wrap items-start justify-between gap-3">
        <div className="flex items-center gap-3">
          <span className="grid h-14 w-14 place-items-center rounded-2xl bg-white/5 text-3xl ring-1 ring-white/10">{p.emoji}</span>
          <div>
            {editing ? (
              <span className="flex gap-1.5">
                <input value={name} onChange={(e) => setName(e.target.value)} className="w-48 rounded-lg border border-white/10 bg-black/40 px-2 py-1 text-sm font-bold text-white" />
                <button onClick={saveEdit} className="rounded-lg bg-violet-600 px-3 py-1 text-xs font-bold text-white">Save</button>
                <button onClick={() => setEditing(false)} className="rounded-lg bg-white/5 px-3 py-1 text-xs text-slate-300">✕</button>
              </span>
            ) : (
              <h1 className="text-2xl font-black text-white">
                {p.name}
                <button onClick={() => setEditing(true)} className="ml-2 text-sm text-slate-500 hover:text-white" title="Rename">✏️</button>
              </h1>
            )}
            <p className="mt-0.5 max-w-xl text-xs text-slate-400">{p.description || "No brief yet"}</p>
          </div>
        </div>
        <div className="flex flex-wrap gap-1.5">
          <a href={`/council?projectId=${p.id}`} className="rounded-xl bg-cyan-600/80 px-3 py-2 text-xs font-extrabold text-white hover:bg-cyan-600">🧠 Council</a>
          <a href={`/?projectId=${p.id}`} className="rounded-xl bg-violet-600/80 px-3 py-2 text-xs font-extrabold text-white hover:bg-violet-600">⚔️ Battle</a>
          <a href={`/collab?projectId=${p.id}`} className="rounded-xl bg-emerald-600/80 px-3 py-2 text-xs font-extrabold text-white hover:bg-emerald-600">🤝 Collab</a>
          <a href={`/stems?projectId=${p.id}`} className="rounded-xl bg-fuchsia-600/80 px-3 py-2 text-xs font-extrabold text-white hover:bg-fuchsia-600">🎚️ Stems</a>
          <a href={`/chat?projectId=${p.id}`} className="rounded-xl border border-white/10 bg-white/5 px-3 py-2 text-xs font-bold text-white hover:bg-white/10">💬 Chat</a>
        </div>
      </div>

      <div className="mt-5 grid gap-4 lg:grid-cols-[1fr_340px]">
        <div className="min-w-0 space-y-4">
          {/* Memory */}
          <div className="glass rounded-2xl p-4">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h2 className="text-sm font-extrabold text-white">🧠 Project memory</h2>
              <div className="flex flex-wrap gap-1">
                {[{ id: "all", label: "All", emoji: "🌍" }, ...MEM_KINDS].map((k) => (
                  <button key={k.id} onClick={() => setMemFilter(k.id)} className={`rounded-full px-2 py-1 text-[10px] font-bold ${memFilter === k.id ? "bg-violet-600 text-white" : "bg-white/5 text-slate-400 ring-1 ring-white/10"}`}>
                    {k.emoji} {k.label}
                  </button>
                ))}
              </div>
            </div>
            <div className="mt-2 flex gap-1.5">
              <select value={memKind} onChange={(e) => setMemKind(e.target.value)} className="rounded-lg border border-white/10 bg-black/40 px-2 py-2 text-xs font-semibold text-white">
                {MEM_KINDS.map((k) => (
                  <option key={k.id} value={k.id}>{k.emoji} {k.label}</option>
                ))}
              </select>
              <input value={memText} onChange={(e) => setMemText(e.target.value)} onKeyDown={(e) => e.key === "Enter" && addMemory()} placeholder="Add a fact, decision, question…" className="flex-1 rounded-lg border border-white/10 bg-black/40 px-3 py-2 text-xs text-white placeholder:text-slate-600 focus:border-violet-500 focus:outline-none" />
              <button onClick={addMemory} disabled={!memText.trim()} className="rounded-lg bg-violet-600 px-3 py-2 text-xs font-extrabold text-white disabled:opacity-50">Add</button>
            </div>
            <div className="scroll-thin mt-2 max-h-64 space-y-1.5 overflow-y-auto">
              {mem.map((m: any) => (
                <div key={m.id} className="group flex items-start gap-2 rounded-lg bg-white/[0.03] px-2.5 py-2 text-xs ring-1 ring-white/5">
                  <span>{MEM_KINDS.find((k) => k.id === m.kind)?.emoji ?? "📌"}</span>
                  <span className="flex-1 text-slate-200">{m.content}</span>
                  <button
                    onClick={async () => {
                      await fetch(`/api/projects/${id}/memory?id=${m.id}`, { method: "DELETE" });
                      refresh();
                    }}
                    className="hidden text-slate-500 hover:text-red-300 group-hover:block"
                  >
                    ✕
                  </button>
                </div>
              ))}
              {mem.length === 0 && <p className="text-xs text-slate-500">No memory yet. Councils will build on whatever you record here.</p>}
            </div>
          </div>

          {/* Artifacts */}
          <div className="glass rounded-2xl p-4">
            <div className="flex items-center justify-between">
              <h2 className="text-sm font-extrabold text-white">📦 Artifacts ({(data.artifacts ?? []).length})</h2>
              <button onClick={() => setShowArtForm(!showArtForm)} className="rounded-lg border border-white/10 bg-white/5 px-3 py-1.5 text-xs font-bold text-white hover:bg-white/10">
                {showArtForm ? "✕ Close" : "＋ New artifact"}
              </button>
            </div>
            {showArtForm && (
              <div className="mt-2 space-y-1.5 rounded-xl border border-white/5 bg-black/20 p-3">
                <div className="flex gap-1.5">
                  <select value={artKind} onChange={(e) => setArtKind(e.target.value)} className="rounded-lg border border-white/10 bg-black/40 px-2 py-1.5 text-xs text-white">
                    {["brief", "decision", "research", "concept", "plan", "critique", "prompt", "spec", "comparison", "answer"].map((k) => (
                      <option key={k} value={k}>{k}</option>
                    ))}
                  </select>
                  <input value={artTitle} onChange={(e) => setArtTitle(e.target.value)} placeholder="Title…" className="flex-1 rounded-lg border border-white/10 bg-black/40 px-2 py-1.5 text-xs text-white placeholder:text-slate-600" />
                </div>
                <textarea value={artBody} onChange={(e) => setArtBody(e.target.value)} rows={4} placeholder="Markdown body…" className="w-full rounded-lg border border-white/10 bg-black/40 px-2 py-1.5 font-mono text-xs text-white placeholder:text-slate-600" />
                <button onClick={addArtifact} disabled={!artBody.trim()} className="rounded-lg bg-amber-500/80 px-3 py-1.5 text-xs font-extrabold text-black disabled:opacity-50">Save artifact</button>
              </div>
            )}
            <div className="mt-2 grid gap-2 md:grid-cols-2">
              {(data.artifacts ?? []).map((a: any) => (
                <details key={a.id} className="rounded-xl bg-white/[0.03] p-2.5 ring-1 ring-white/5">
                  <summary className="cursor-pointer text-xs font-bold text-white">
                    <span className="mr-1 rounded bg-amber-500/20 px-1.5 py-0.5 text-[10px] text-amber-200">{a.kind}</span>
                    {a.title}
                  </summary>
                  <div className="scroll-thin mt-2 max-h-48 overflow-y-auto">
                    <Markdown text={a.body} />
                  </div>
                  <div className="mt-2 flex gap-1.5">
                    <a href={`/?prompt=${encodeURIComponent(a.body.slice(0, 1500))}&projectId=${id}&source=${encodeURIComponent(`artifact:${a.id}`)}`} className="rounded bg-white/5 px-2 py-1 text-[10px] font-bold hover:bg-white/15">⚔️ Battle</a>
                    <a href={`/collab?challenge=${encodeURIComponent(a.body.slice(0, 2000))}&projectId=${id}&source=${encodeURIComponent(`artifact:${a.id}`)}`} className="rounded bg-white/5 px-2 py-1 text-[10px] font-bold hover:bg-white/15">🤝 Collab</a>
                    <a href={`/council?material=${encodeURIComponent(a.body.slice(0, 2500))}&projectId=${id}&source=${encodeURIComponent(`artifact:${a.id}`)}`} className="rounded bg-white/5 px-2 py-1 text-[10px] font-bold hover:bg-white/15">🧠 Council</a>
                  </div>
                </details>
              ))}
              {(data.artifacts ?? []).length === 0 && <p className="text-xs text-slate-500">No artifacts yet — council runs and handoffs will accumulate here.</p>}
            </div>
          </div>
        </div>

        <aside className="space-y-4">
          <div className="glass rounded-2xl p-4">
            <h3 className="text-sm font-extrabold text-white">🧠 Councils ({(data.councils ?? []).length})</h3>
            <div className="mt-2 space-y-1.5">
              {(data.councils ?? []).slice(0, 5).map((c: any) => (
                <a key={c.id} href="/council" className="block truncate rounded-lg bg-white/[0.03] px-2.5 py-2 text-xs text-slate-300 ring-1 ring-white/5">
                  <span className="font-bold text-cyan-300">{c.jobId}</span> · {c.material.slice(0, 80)}
                </a>
              ))}
              {(data.councils ?? []).length === 0 && <p className="text-xs text-slate-500">None yet.</p>}
            </div>
          </div>
          <div className="glass rounded-2xl p-4">
            <h3 className="text-sm font-extrabold text-white">⚔️ Battles ({(data.battles ?? []).length})</h3>
            <div className="mt-2 space-y-1.5">
              {(data.battles ?? []).slice(0, 5).map((b: any) => (
                <a key={b.id} href={`/battles/${b.id}`} className="block truncate rounded-lg bg-white/[0.03] px-2.5 py-2 text-xs text-slate-300 ring-1 ring-white/5">
                  {b.winner ? "✅ " : "🎭 "}{b.prompt.slice(0, 90)}
                </a>
              ))}
              {(data.battles ?? []).length === 0 && <p className="text-xs text-slate-500">None yet.</p>}
            </div>
          </div>
          <div className="glass rounded-2xl p-4">
            <h3 className="text-sm font-extrabold text-white">🤝 Collabs ({(data.collabs ?? []).length})</h3>
            <div className="mt-2 space-y-1.5">
              {(data.collabs ?? []).slice(0, 5).map((c: any) => (
                <a key={c.id} href={`/collabs/${c.id}`} className="block truncate rounded-lg bg-white/[0.03] px-2.5 py-2 text-xs text-slate-300 ring-1 ring-white/5">
                  {c.strategy} · {c.challenge.slice(0, 80)}
                </a>
              ))}
              {(data.collabs ?? []).length === 0 && <p className="text-xs text-slate-500">None yet.</p>}
            </div>
          </div>
        </aside>
      </div>
    </div>
  );
}
