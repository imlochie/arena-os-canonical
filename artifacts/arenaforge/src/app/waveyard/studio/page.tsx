"use client";

import Link from "@/routing/Link";
import WaveyardNav from "@/components/waveyard/WaveyardNav";
import { useCallback, useEffect, useState } from "react";

interface StudioProject {
  id: string;
  title: string;
}

export default function StudioHomePage() {
  const [projects, setProjects] = useState<StudioProject[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const loadProjects = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const response = await fetch("/api/waveyard/projects", { cache: "no-store" });
      const body = await response.json().catch(() => null);
      if (!response.ok || !Array.isArray(body?.projects)) {
        throw new Error("The saved arrangements could not be loaded.");
      }
      setProjects(body.projects as StudioProject[]);
    } catch {
      setError("Saved arrangements could not be loaded. Try again.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    const timer = window.setTimeout(() => void loadProjects(), 0);
    return () => window.clearTimeout(timer);
  }, [loadProjects]);

  return (
    <main className="shell">
      <WaveyardNav />
      <section className="session-preview" aria-label="Studio projects">
        <span className="eyebrow">Studio</span>
        <h1>Your arrangements</h1>
        <p>Continue editing a saved arrangement, or start a new project.</p>
        <div className="sess-new">
          <Link className="button" href="/waveyard/create">New studio project</Link>
          <Link className="button secondary" href="/waveyard/sessions">Open sessions</Link>
        </div>
        {loading && projects === null && <p role="status">Loading saved arrangements…</p>}
        {error && (
          <div role="alert">
            <p>{error}</p>
            <button type="button" className="button secondary" onClick={() => void loadProjects()}>
              Try again
            </button>
          </div>
        )}
        {projects !== null && projects.length === 0 && !error && (
          <div className="sess-empty" aria-label="No saved arrangements">
            <p>No saved arrangements yet.</p>
            <p>Send selected tracks from a session to Studio, or create a new project.</p>
          </div>
        )}
        {projects !== null && projects.length > 0 && (
          <ul className="studio-list" aria-label="Saved Studio arrangements">
            {projects.map((project) => (
              <li key={project.id}>
                <Link
                  aria-label={`Open ${project.title} in Studio`}
                  href={`/waveyard/projects/${project.id}?view=studio`}
                >
                  <span>{project.title}</span>
                  <small>Open in Studio</small>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </section>
    </main>
  );
}
