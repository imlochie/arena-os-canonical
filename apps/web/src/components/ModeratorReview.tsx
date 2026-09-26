"use client";

import { useCallback, useEffect, useState } from "react";

type ModerationProject = { id: string; title: string; creatorDisplayName: string; moderationStatus: string; visibility: string };
export function ModeratorReview() {
  const [projects, setProjects] = useState<ModerationProject[]>([]); const [message, setMessage] = useState<string | null>(null);
  const load = useCallback(async () => { const response = await fetch("/api/moderation/projects?status=reported", { cache: "no-store" }); const body = await response.json().catch(() => ({})); if (!response.ok) setMessage(body.error ?? "Moderator review is unavailable."); else setProjects(body.projects ?? []); }, []);
  useEffect(() => { const timer = window.setTimeout(() => { void load(); }, 0); return () => window.clearTimeout(timer); }, [load]);
  const action = async (id: string, type: "hide" | "restore" | "remove") => { const reason = window.prompt(`Reason to ${type} this project`); if (!reason) return; const response = await fetch(`/api/moderation/projects/${id}/actions`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: type, reason }) }); const body = await response.json().catch(() => ({})); if (!response.ok) setMessage(body.error ?? "Action could not be saved."); else { setMessage(`Project ${type}d.`); await load(); } };
  return <section className="moderator-review"><span className="eyebrow">Moderation</span><h1>Reported public projects</h1>{message && <p className="notice">{message}</p>}{!projects.length && <p className="notice">No reported published projects need review.</p>}{projects.map((project) => <article className="public-card" key={project.id}><h2>{project.title}</h2><p>By {project.creatorDisplayName} · {project.visibility}</p><div className="publication-actions"><button className="button secondary" onClick={() => void action(project.id, "hide")}>Hide</button><button className="button secondary" onClick={() => void action(project.id, "restore")}>Restore</button><button className="button" onClick={() => void action(project.id, "remove")}>Remove</button></div></article>)}</section>;
}
