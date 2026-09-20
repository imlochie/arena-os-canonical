"use client";

import { useEffect, useState } from "react";

const EMOJIS = ["📁", "🎛️", "⚙️", "🗂️", "🚀", "🎨", "📚", "🧪", "🏠", "💡"];

export default function ProjectsPage() {
  const [projects, setProjects] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [name, setName] = useState("");
  const [desc, setDesc] = useState("");
  const [emoji, setEmoji] = useState("📁");

  useEffect(() => {
    fetch("/api/projects").then((r) => r.json()).then((j) => {
      setProjects(j.projects ?? []);
      setLoading(false);
    });
  }, []);

  async function create() {
    if (!name.trim()) return;
    const r = await fetch("/api/projects", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: name.trim(), description: desc.trim(), emoji }),
    });
    const j = await r.json();
    if (j.project) {
      setProjects((p) => [{ ...j.project, counts: { battles: 0, collabs: 0, councils: 0, artifacts: 0, memory: 0 } }, ...p]);
      setName("");
      setDesc("");
    }
  }

  return (
    <div className="mx-auto max-w-5xl">
      <div className="text-center">
        <h1 className="text-2xl font-black tracking-tight text-white sm:text-3xl">📁 Projects</h1>
        <p className="mx-auto mt-1 max-w-xl text-sm text-slate-300">
          Persistent work above sessions. Battles, councils, collabs, artifacts, and memory accumulate here.
        </p>
      </div>

      <div className="glass mt-5 rounded-2xl p-4">
        <p className="text-xs font-extrabold text-white">＋ New project</p>
        <div className="mt-2 flex flex-wrap gap-1.5">
          {EMOJIS.map((e) => (
            <button key={e} onClick={() => setEmoji(e)} className={`grid h-8 w-8 place-items-center rounded-lg text-base ${emoji === e ? "bg-violet-600 ring-2 ring-violet-300" : "bg-white/5 hover:bg-white/10"}`}>
              {e}
            </button>
          ))}
        </div>
        <div className="mt-2 flex flex-col gap-2 sm:flex-row">
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Project name…" className="flex-1 rounded-xl border border-white/10 bg-black/40 px-4 py-2.5 text-sm text-white placeholder:text-slate-500 focus:border-violet-500 focus:outline-none" />
          <input value={desc} onChange={(e) => setDesc(e.target.value)} onKeyDown={(e) => e.key === "Enter" && create()} placeholder="One-line brief…" className="flex-[2] rounded-xl border border-white/10 bg-black/40 px-4 py-2.5 text-sm text-white placeholder:text-slate-500 focus:border-violet-500 focus:outline-none" />
          <button onClick={create} disabled={!name.trim()} className="btn-arena rounded-xl px-5 py-2.5 text-sm font-extrabold text-white">
            Create
          </button>
        </div>
      </div>

      {loading ? (
        <p className="mt-5 text-center text-sm text-slate-500">Loading…</p>
      ) : (
        <div className="mt-5 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {projects.map((p) => (
            <a key={p.id} href={`/projects/${p.id}`} className="glass card-hover rounded-2xl p-5">
              <p className="text-3xl">{p.emoji}</p>
              <p className="mt-2 truncate text-base font-extrabold text-white">{p.name}</p>
              <p className="mt-0.5 line-clamp-2 min-h-[2em] text-xs text-slate-400">{p.description || "No brief yet"}</p>
              <div className="mt-3 flex flex-wrap gap-1.5 text-[10px] font-bold text-slate-300">
                <span className="rounded-full bg-white/5 px-2 py-1 ring-1 ring-white/10">⚔️ {p.counts?.battles ?? 0}</span>
                <span className="rounded-full bg-white/5 px-2 py-1 ring-1 ring-white/10">🧠 {p.counts?.councils ?? 0}</span>
                <span className="rounded-full bg-white/5 px-2 py-1 ring-1 ring-white/10">🤝 {p.counts?.collabs ?? 0}</span>
                <span className="rounded-full bg-white/5 px-2 py-1 ring-1 ring-white/10">📦 {p.counts?.artifacts ?? 0}</span>
                <span className="rounded-full bg-white/5 px-2 py-1 ring-1 ring-white/10">🧠 {p.counts?.memory ?? 0} mem</span>
              </div>
            </a>
          ))}
        </div>
      )}
    </div>
  );
}
