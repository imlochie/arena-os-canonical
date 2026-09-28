"use client";

import Link from "next/link";
import { FormEvent, useEffect, useState } from "react";

type LinkedArenaProject = { id: string; name: string; emoji: string };

type Props = {
  waveyardProjectId: string;
  projectTitle: string;
  projectDescription: string;
  editable: boolean;
};

export function WaveyardHandoffPanel({ waveyardProjectId, projectTitle, projectDescription, editable }: Props) {
  const [arenaProject, setArenaProject] = useState<LinkedArenaProject | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [title, setTitle] = useState(`${projectTitle} — studio note`);
  const [summary, setSummary] = useState(projectDescription);
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      const response = await fetch(`/api/projects/${waveyardProjectId}/arena-handoff`, { cache: "no-store" });
      const body = await response.json().catch(() => ({}));
      if (!cancelled && response.ok && body.linked) setArenaProject(body.arenaProject);
      if (!cancelled) setLoading(false);
    }
    void load();
    return () => { cancelled = true; };
  }, [waveyardProjectId]);

  async function attach() {
    setBusy(true);
    setMessage(null);
    const response = await fetch(`/api/projects/${waveyardProjectId}/arena-handoff`, { method: "POST" });
    const body = await response.json().catch(() => ({}));
    setBusy(false);
    if (!response.ok) return setMessage(body.error ?? "Arena project attachment could not be created.");
    setArenaProject(body.arenaProject);
    setMessage(body.created ? "Attached to an Arena project container." : "Already attached to Arena.");
  }

  async function handoff(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setMessage(null);
    const response = await fetch(`/api/projects/${waveyardProjectId}/arena-handoff`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "handoff", title, summary }),
    });
    const body = await response.json().catch(() => ({}));
    setBusy(false);
    if (!response.ok) return setMessage(body.error ?? "The note could not be handed off.");
    setArenaProject(body.arenaProject);
    setMessage("Added an Arena artifact with Waveyard provenance.");
  }

  return (
    <section className="add-source-panel" aria-labelledby="arena-handoff-title">
      <div>
        <span className="eyebrow">Arena handoff</span>
        <h2 id="arena-handoff-title">Attach music work to the wider project.</h2>
        <p>Only a title, your written note, and provenance move to Arena. Private sources, stems, analysis files, playback, and exports remain in Waveyard.</p>
        {loading ? <p className="notice">Checking the shared project link…</p> : arenaProject ? <p className="notice">Attached to <Link href={`/projects/${arenaProject.id}`}>{arenaProject.emoji} {arenaProject.name}</Link>.</p> : null}
      </div>
      {editable && !arenaProject && <button className="button secondary" type="button" disabled={busy || loading} onClick={() => void attach()}>{busy ? "Attaching…" : "Attach to Arena"}</button>}
      {editable && arenaProject && <form className="add-source-form" onSubmit={handoff}>
        <label>Handoff title<input value={title} maxLength={180} onChange={(event) => setTitle(event.target.value)} /></label>
        <label>Decision or output note<textarea value={summary} required maxLength={8000} rows={3} onChange={(event) => setSummary(event.target.value)} placeholder="What should the shared project remember or use next?" /></label>
        <button className="button secondary" disabled={busy}>{busy ? "Handing off…" : "Add to Arena artifacts"}</button>
      </form>}
      {message && <p className="notice">{message}</p>}
    </section>
  );
}
