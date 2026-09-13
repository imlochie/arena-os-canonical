"use client";

import { useState } from "react";
import { handoffDestination, type HandoffTarget } from "@/lib/handoffs";

// Send work around the loop: Think → Challenge → Synthesize → Create → Test → Learn.
export default function HandoffButtons({
  text,
  projectId,
  source,
  sourceSessionId,
  sourceArtifactId,
  exclude = [],
  compact = false,
}: {
  text: string;
  projectId?: string | null;
  source?: string;
  sourceSessionId?: string | null;
  sourceArtifactId?: string | null;
  exclude?: HandoffTarget[];
  compact?: boolean;
}) {
  const [saved, setSaved] = useState<string | null>(null);
  const [sending, setSending] = useState<HandoffTarget | null>(null);

  async function createHandoff(target: HandoffTarget) {
    if (!text.trim() || sending) return;
    setSending(target);
    try {
      const r = await fetch("/api/handoffs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          sourceSessionId: sourceSessionId || undefined,
          sourceArtifactId: sourceArtifactId || undefined,
          sourceProjectId: projectId || undefined,
          sourceRef: source,
          targetMode: target,
          targetProjectId: projectId || undefined,
          type: "continue",
          intent: `Continue this work in ${target}`,
          context: { kind: "inherited_output", content: text.slice(0, 8000) },
        }),
      });
      const data = await r.json();
      if (!r.ok) throw new Error(data.error?.message ?? "handoff failed");
      window.location.assign(handoffDestination(target, data.handoff.id, data.targetSession.id));
    } catch (error) {
      alert(error instanceof Error ? error.message : "Unable to create handoff.");
      setSending(null);
    }
  }

  async function saveArtifact(kind: string) {
    if (!text.trim()) return;
    const title = window.prompt("Artifact title:", text.slice(0, 60).split("\n")[0] || "Untitled");
    if (!title?.trim()) return;
    try {
      const r = await fetch(projectId ? `/api/projects/${projectId}/artifacts` : "/api/artifacts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title: title.trim().slice(0, 160),
          body: text.slice(0, 20000),
          kind,
          sourceType: source?.split(":")[0] ?? "manual",
          sourceId: source?.split(":").slice(1).join(":") ?? null,
          projectId: projectId || undefined,
        }),
      });
      if (r.ok) {
        setSaved(kind);
        setTimeout(() => setSaved(null), 2000);
      }
    } catch {}
  }

  async function saveMemory(kind: string) {
    if (!projectId) {
      alert("Attach a project first — memory lives inside projects.");
      return;
    }
    if (!text.trim()) return;
    const content = window.prompt(
      kind === "decision" ? "Record this decision:" : kind === "open_question" ? "Record this open question:" : "Record:",
      text.slice(0, 300)
    );
    if (!content?.trim()) return;
    try {
      const r = await fetch(`/api/projects/${projectId}/memory`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ kind, content: content.trim() }),
      });
      if (r.ok) {
        setSaved(kind);
        setTimeout(() => setSaved(null), 2000);
      }
    } catch {}
  }

  const targets = (
    [
      { id: "arena", label: "⚔️ Arena", title: "Challenge it in blind battle" },
      { id: "collab", label: "🤝 Collab", title: "Develop it with a council of minds" },
      { id: "council", label: "🧠 Council", title: "Think it through with disagreeing roles" },
    ] as { id: HandoffTarget; label: string; title: string }[]
  ).filter((t) => !exclude.includes(t.id));

  return (
    <div className="flex flex-wrap items-center gap-1.5">
      <span className={`${compact ? "hidden" : ""} text-[10px] font-black uppercase tracking-wider text-slate-500`}>
        Send to →
      </span>
      {targets.map((t) => (
        <button
          key={t.id}
          onClick={() => createHandoff(t.id)}
          disabled={sending !== null}
          title={t.title}
          className="rounded-lg border border-white/10 bg-white/5 px-2.5 py-1.5 text-xs font-bold text-white hover:bg-white/10 disabled:opacity-50"
        >
          {sending === t.id ? "Creating handoff…" : t.label}
        </button>
      ))}
      <span className="mx-0.5 h-4 w-px bg-white/10" />
      <button
        onClick={() => saveArtifact("brief")}
        title="Save as a reusable artifact in the library"
        className="rounded-lg border border-amber-400/30 bg-amber-400/10 px-2.5 py-1.5 text-xs font-bold text-amber-200 hover:bg-amber-400/20"
      >
        {saved === "brief" ? "✓ Saved" : "📦 Artifact"}
      </button>
      {projectId && (
        <>
          <button
            onClick={() => saveMemory("decision")}
            title="Record as a project decision"
            className="rounded-lg border border-emerald-400/30 bg-emerald-400/10 px-2.5 py-1.5 text-xs font-bold text-emerald-200 hover:bg-emerald-400/20"
          >
            {saved === "decision" ? "✓ Saved" : "✅ Decision"}
          </button>
          <button
            onClick={() => saveMemory("open_question")}
            title="Record as an open question"
            className="rounded-lg border border-white/10 bg-white/5 px-2.5 py-1.5 text-xs font-bold text-slate-200 hover:bg-white/10"
          >
            {saved === "open_question" ? "✓ Saved" : "❓ Question"}
          </button>
        </>
      )}
    </div>
  );
}
