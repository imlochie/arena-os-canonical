"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";

const INTENTS = [
  { id: "think", emoji: "🧠", label: "THINK", desc: "Pressure-test a belief", href: "/council?jobId=thinking_instrument" },
  { id: "create", emoji: "🎨", label: "CREATE", desc: "Concepts, naming, lore", href: "/council?jobId=creative_workshop" },
  { id: "research", emoji: "🔬", label: "RESEARCH", desc: "Understand deeply", href: "/council?jobId=deep_research" },
  { id: "debate", emoji: "⚔️", label: "DEBATE", desc: "Blind battle test", href: "/" },
  { id: "build", emoji: "⚙️", label: "BUILD", desc: "Systems + machines", href: "/collab?strategy=systems" },
  { id: "explore", emoji: "🔮", label: "EXPLORE", desc: "Prototype futures", href: "/council?jobId=simulation_partner" },
];

export default function CommandPage() {
  const router = useRouter();
  const [data, setData] = useState<any | null>(null);
  const [intent, setIntent] = useState("think");
  const [text, setText] = useState("");
  const [roles, setRoles] = useState<any[]>([]);
  const [sessions, setSessions] = useState<any[]>([]);

  useEffect(() => {
    fetch("/api/command").then((r) => r.json()).then(setData).catch(() => {});
    fetch("/api/workforce").then((r) => r.json()).then((j) => setRoles(j.roles ?? [])).catch(() => {});
    fetch("/api/cognitive-sessions?limit=6").then((r) => r.json()).then((j) => setSessions(j.sessions ?? [])).catch(() => {});
  }, []);

  function start() {
    const base = INTENTS.find((i) => i.id === intent)?.href ?? "/council";
    const sep = base.includes("?") ? "&" : "?";
    const param = base.startsWith("/collab") ? "challenge" : base === "/" ? "prompt" : "material";
    if (!text.trim()) {
      router.push(base);
      return;
    }
    router.push(`${base}${sep}${param}=${encodeURIComponent(text.trim().slice(0, 4000))}`);
  }

  const intel = data?.intelligence ?? { decisions: 0, openQuestions: 0, artifacts: 0, contradictions: 0 };

  return (
    <div className="mx-auto max-w-5xl">
      <div className="text-center">
        <p className="text-xs font-black uppercase tracking-[0.3em] text-slate-500">Arena</p>
        <h1 className="text-glow mt-2 text-3xl font-black tracking-tight text-white sm:text-4xl">
          What are you trying to do?
        </h1>
        <p className="mx-auto mt-2 max-w-xl text-sm text-slate-400">
          Think → challenge → synthesize → create → test → learn. One operating system, three engines.
        </p>
      </div>

      <div className="glass mt-6 rounded-2xl p-4 sm:p-5">
        <div className="grid grid-cols-3 gap-2 sm:grid-cols-6">
          {INTENTS.map((i) => (
            <button
              key={i.id}
              onClick={() => setIntent(i.id)}
              className={`rounded-xl border p-3 text-center transition ${
                intent === i.id
                  ? "border-violet-400/60 bg-violet-600/20 shadow-[0_8px_28px_rgba(124,58,237,0.35)]"
                  : "border-white/10 bg-white/[0.03] hover:border-violet-500/40"
              }`}
            >
              <p className="text-2xl">{i.emoji}</p>
              <p className="mt-1 text-xs font-black tracking-wider text-white">{i.label}</p>
              <p className="mt-0.5 hidden text-[10px] text-slate-400 sm:block">{i.desc}</p>
            </button>
          ))}
        </div>
        <div className="mt-3 flex gap-2">
          <input
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && start()}
            placeholder={`Describe it roughly — the ${INTENTS.find((i) => i.id === intent)?.label.toLowerCase()} engine assembles the right minds…`}
            className="flex-1 rounded-xl border border-white/10 bg-black/40 px-4 py-3 text-sm text-white placeholder:text-slate-500 focus:border-violet-500 focus:outline-none"
          />
          <button onClick={start} className="btn-arena rounded-xl px-6 py-3 text-sm font-extrabold text-white">
            Start →
          </button>
        </div>
        <div className="mt-2 flex flex-wrap justify-center gap-2 text-[11px] font-bold">
          <a href="/" className="rounded-full bg-white/5 px-3 py-1.5 text-slate-300 ring-1 ring-white/10 hover:bg-white/10">⚔️ Arena = competition</a>
          <a href="/collab" className="rounded-full bg-white/5 px-3 py-1.5 text-slate-300 ring-1 ring-white/10 hover:bg-white/10">🤝 Collab = collective creation</a>
          <a href="/council" className="rounded-full bg-white/5 px-3 py-1.5 text-slate-300 ring-1 ring-white/10 hover:bg-white/10">🧠 Council = structured cognition</a>
        </div>
      </div>

      <div className="mt-5 grid gap-4 lg:grid-cols-[1fr_320px]">
        <div>
          <h2 className="mb-2 text-xs font-black uppercase tracking-wider text-slate-400">Active projects</h2>
          <div className="grid gap-2 sm:grid-cols-2">
            {(data?.projects ?? []).map((p: any) => (
              <a key={p.id} href={`/projects/${p.id}`} className="glass card-hover rounded-2xl p-4">
                <p className="text-lg">{p.emoji}</p>
                <p className="mt-1 truncate text-sm font-extrabold text-white">{p.name}</p>
                <p className="mt-0.5 line-clamp-1 text-[11px] text-slate-400">{p.description || "No brief yet"}</p>
                <p className="mt-2 text-[11px] font-bold text-slate-300">
                  📦 {p.artifacts} · ✅ {p.decisions} · ❓ {p.openQuestions}
                </p>
              </a>
            ))}
            {(!data || data.projects?.length === 0) && (
              <p className="text-xs text-slate-500">Loading projects…</p>
            )}
          </div>
          <a href="/projects" className="mt-2 inline-block text-xs font-bold text-violet-300 hover:underline">
            All projects →
          </a>

          <h2 className="mb-2 mt-5 text-xs font-black uppercase tracking-wider text-slate-400">Recent intelligence</h2>
          <div className="glass rounded-2xl p-4">
            <div className="grid grid-cols-2 gap-2 text-center sm:grid-cols-4">
              {[
                ["✅", data ? intel.decisions : "…", "decisions"],
                ["❓", data ? intel.openQuestions : "…", "open questions"],
                ["📦", data ? intel.artifacts : "…", "artifacts"],
                ["⚡", data ? intel.contradictions : "…", "tensions detected"],
              ].map(([e, v, l]) => (
                <div key={l as string} className="rounded-xl bg-white/[0.03] p-3 ring-1 ring-white/5">
                  <p className="text-base">{e}</p>
                  <p className="text-lg font-black text-white">{v}</p>
                  <p className="text-[10px] font-bold text-slate-400">{l}</p>
                </div>
              ))}
            </div>
            <div className="mt-3 space-y-1.5">
              {sessions.slice(0, 4).map((s: any) => {
                const destination = s.mode === "council"
                  ? `/council?sessionId=${encodeURIComponent(s.id)}`
                  : s.mode === "collab" ? "/collab" : "/";
                return (
                  <a key={s.id} href={destination} className="block truncate rounded-lg bg-white/[0.03] px-3 py-2 text-xs text-slate-300 ring-1 ring-white/5 hover:ring-cyan-500/40">
                    🧠 <span className="font-bold text-white">{s.title}</span> <span className="text-slate-500">· {s.mode} · {s.status}</span>
                  </a>
                );
              })}
              {(data?.recent?.artifacts ?? []).slice(0, 4).map((a: any) => (
                <a key={a.id} href="/artifacts" className="block truncate rounded-lg bg-white/[0.03] px-3 py-2 text-xs text-slate-300 ring-1 ring-white/5 hover:ring-violet-500/40">
                  📦 <span className="font-bold text-white">{a.title}</span> <span className="text-slate-500">· {a.kind}</span>
                </a>
              ))}
              {(data?.recent?.councils ?? []).slice(0, 2).map((c: any) => (
                <a key={c.id} href="/council" className="block truncate rounded-lg bg-white/[0.03] px-3 py-2 text-xs text-slate-300 ring-1 ring-white/5 hover:ring-violet-500/40">
                  🧠 <span className="font-bold text-white">{c.jobId}</span> <span className="text-slate-500">· {c.material}</span>
                </a>
              ))}
            </div>
          </div>
        </div>

        <aside className="space-y-4">
          <div className="glass rounded-2xl p-4">
            <h3 className="text-sm font-extrabold text-white">🧑‍💼 Workforce</h3>
            <p className="mt-0.5 text-[11px] text-slate-400">Roles, not models. Best mind auto-assigned per job.</p>
            <div className="mt-2 space-y-1.5">
              {roles.slice(0, 8).map((r: any) => (
                <div key={r.id} className="flex items-center gap-2 rounded-lg bg-white/[0.03] px-2.5 py-1.5 ring-1 ring-white/5">
                  <span>{r.emoji}</span>
                  <span className="min-w-0 flex-1 truncate text-xs font-bold text-white">{r.name}</span>
                  <span className="font-mono text-[10px] text-cyan-300">{r.recommendedModel}</span>
                </div>
              ))}
              {roles.length === 0 && <p className="text-xs text-slate-500">Loading roles…</p>}
            </div>
          </div>
          <div className="rounded-2xl border border-violet-400/25 bg-gradient-to-br from-violet-500/15 to-fuchsia-500/5 p-4">
            <p className="text-sm font-extrabold text-violet-200">🔁 The loop</p>
            <p className="mt-1 text-xs leading-relaxed text-violet-100/80">
              Council briefs enter the Arena. Arena winners enter Collab. Collab syntheses become project
              decisions. Knowledge accumulates — not transcripts.
            </p>
          </div>
        </aside>
      </div>
    </div>
  );
}
