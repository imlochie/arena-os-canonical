"use client";

import { useEffect, useState } from "react";

export interface ProjectLite {
  id: string;
  name: string;
  emoji: string;
}

export default function ProjectPicker({
  value,
  onChange,
  allowCreate = true,
}: {
  value: string;
  onChange: (v: string) => void;
  allowCreate?: boolean;
}) {
  const [projects, setProjects] = useState<ProjectLite[]>([]);
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState("");

  useEffect(() => {
    fetch("/api/projects")
      .then((r) => r.json())
      .then((j) => setProjects((j.projects ?? []).map((p: any) => ({ id: p.id, name: p.name, emoji: p.emoji }))))
      .catch(() => {});
  }, []);

  async function create() {
    const n = name.trim();
    if (!n) return;
    try {
      const r = await fetch("/api/projects", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: n }),
      });
      const j = await r.json();
      if (j.project) {
        setProjects((p) => [{ id: j.project.id, name: j.project.name, emoji: j.project.emoji }, ...p]);
        onChange(j.project.id);
        setName("");
        setCreating(false);
      }
    } catch {}
  }

  return (
    <div className="flex items-center gap-1.5">
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        title="Attach this work to a project — memory and artifacts accumulate there"
        className="max-w-[220px] rounded-lg border border-white/10 bg-black/40 px-2 py-1.5 text-xs font-semibold text-white focus:border-violet-500 focus:outline-none"
      >
        <option value="">📁 No project</option>
        {projects.map((p) => (
          <option key={p.id} value={p.id}>
            {p.emoji} {p.name}
          </option>
        ))}
      </select>
      {allowCreate &&
        (creating ? (
          <span className="flex items-center gap-1">
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && create()}
              placeholder="Project name…"
              autoFocus
              className="w-28 rounded-lg border border-white/10 bg-black/40 px-2 py-1.5 text-xs text-white placeholder:text-slate-600 focus:border-violet-500 focus:outline-none"
            />
            <button onClick={create} className="rounded-lg bg-violet-600 px-2 py-1.5 text-xs font-bold text-white hover:bg-violet-500">
              ✓
            </button>
            <button onClick={() => setCreating(false)} className="rounded-lg bg-white/5 px-2 py-1.5 text-xs text-slate-300">
              ✕
            </button>
          </span>
        ) : (
          <button
            onClick={() => setCreating(true)}
            title="New project"
            className="rounded-lg border border-white/10 bg-white/5 px-2 py-1.5 text-xs font-bold text-slate-200 hover:bg-white/10"
          >
            ＋
          </button>
        ))}
    </div>
  );
}
