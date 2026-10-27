"use client";

import { useEffect, useState } from "react";
import Markdown from "@/components/Markdown";

const KINDS = ["brief", "decision", "research", "concept", "plan", "critique", "prompt", "spec", "comparison", "answer"];

export default function ArtifactsPage() {
  const [artifacts, setArtifacts] = useState<any[]>([]);
  const [projects, setProjects] = useState<any[]>([]);
  const [q, setQ] = useState("");
  const [kind, setKind] = useState("");
  const [projectId, setProjectId] = useState("");

  useEffect(() => {
    fetch("/api/artifacts?limit=100").then((r) => r.json()).then((j) => setArtifacts(j.artifacts ?? []));
    fetch("/api/projects").then((r) => r.json()).then((j) => setProjects(j.projects ?? []));
  }, []);

  const filtered = artifacts.filter((a) => {
    if (kind && a.kind !== kind) return false;
    if (projectId && a.projectId !== projectId) return false;
    if (q.trim() && !(a.title + " " + a.body).toLowerCase().includes(q.toLowerCase())) return false;
    return true;
  });

  async function remove(id: string) {
    if (!confirm("Delete this artifact?")) return;
    await fetch(`/api/artifacts/${id}`, { method: "DELETE" });
    setArtifacts((l) => l.filter((x) => x.id !== id));
  }

  function copy(body: string) {
    if (navigator.clipboard?.writeText) navigator.clipboard.writeText(body).catch(() => {});
  }

  return (
    <div className="mx-auto max-w-5xl">
      <div className="text-center">
        <h1 className="text-2xl font-black tracking-tight text-white sm:text-3xl">📦 Artifact Library</h1>
        <p className="mx-auto mt-1 max-w-xl text-sm text-slate-300">
          Reusable knowledge, not transcripts. Every artifact can re-enter the loop as Arena, Collab, or Council input.
        </p>
      </div>
      <div className="glass mt-4 flex flex-col gap-2 rounded-2xl p-3 sm:flex-row">
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="🔍 Search artifacts…" className="flex-1 rounded-lg border border-white/10 bg-black/40 px-3 py-2 text-xs text-white placeholder:text-slate-600 focus:border-violet-500 focus:outline-none" />
        <select value={kind} onChange={(e) => setKind(e.target.value)} className="rounded-lg border border-white/10 bg-black/40 px-2 py-2 text-xs text-white">
          <option value="">All kinds</option>
          {KINDS.map((k) => (
            <option key={k} value={k}>{k}</option>
          ))}
        </select>
        <select value={projectId} onChange={(e) => setProjectId(e.target.value)} className="rounded-lg border border-white/10 bg-black/40 px-2 py-2 text-xs text-white">
          <option value="">All projects</option>
          {projects.map((p: any) => (
            <option key={p.id} value={p.id}>{p.emoji} {p.name}</option>
          ))}
        </select>
      </div>
      <div className="mt-4 grid gap-3 md:grid-cols-2">
        {filtered.map((a) => (
          <details key={a.id} className="glass overflow-hidden rounded-2xl">
            <summary className="cursor-pointer p-4">
              <span className="mr-1.5 rounded bg-amber-500/20 px-1.5 py-0.5 text-[10px] font-black text-amber-200">{a.kind}</span>
              <span className="text-sm font-extrabold text-white">{a.title}</span>
              <span className="ml-2 text-[10px] text-slate-500">{a.sourceType}{a.createdAt ? ` · ${new Date(a.createdAt).toLocaleDateString()}` : ""}</span>
            </summary>
            <div className="border-t border-white/10 p-4">
              <div className="scroll-thin max-h-64 overflow-y-auto">
                <Markdown text={a.body} />
              </div>
              <div className="mt-3 flex flex-wrap gap-1.5">
                <a href={`/?prompt=${encodeURIComponent(a.body.slice(0, 1500))}${a.projectId ? `&projectId=${a.projectId}` : ""}&source=${encodeURIComponent(`artifact:${a.id}`)}`} className="rounded-lg border border-white/10 bg-white/5 px-2.5 py-1.5 text-[11px] font-bold hover:bg-white/10">⚔️ Battle it</a>
                <a href={`/collab?challenge=${encodeURIComponent(a.body.slice(0, 2000))}${a.projectId ? `&projectId=${a.projectId}` : ""}&source=${encodeURIComponent(`artifact:${a.id}`)}`} className="rounded-lg border border-white/10 bg-white/5 px-2.5 py-1.5 text-[11px] font-bold hover:bg-white/10">🤝 Collab it</a>
                <a href={`/council?material=${encodeURIComponent(a.body.slice(0, 2500))}${a.projectId ? `&projectId=${a.projectId}` : ""}&source=${encodeURIComponent(`artifact:${a.id}`)}`} className="rounded-lg border border-white/10 bg-white/5 px-2.5 py-1.5 text-[11px] font-bold hover:bg-white/10">🧠 Council it</a>
                <button onClick={() => copy(a.body)} className="rounded-lg border border-white/10 bg-white/5 px-2.5 py-1.5 text-[11px] font-bold hover:bg-white/10">📋</button>
                <button onClick={() => remove(a.id)} className="rounded-lg border border-white/10 bg-white/5 px-2.5 py-1.5 text-[11px] font-bold text-red-300 hover:bg-red-500/20">🗑️</button>
              </div>
            </div>
          </details>
        ))}
      </div>
      {filtered.length === 0 && <p className="mt-6 text-center text-sm text-slate-500">No artifacts match. Run a council or save outputs as artifacts to grow the library.</p>}
    </div>
  );
}
