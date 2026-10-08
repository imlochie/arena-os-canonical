"use client";

import Link from "next/link";
import WaveyardNav from "@/components/waveyard/WaveyardNav";
import { useEffect, useState } from "react";

interface SessionListItem {
  id: string;
  name: string;
  trackCount: number;
  updatedAt: string;
}

/** The sessions browser: real sessions from the owner's library — create,
 * open, delete. Opening one loads the two-deck SessionExperience. */
export default function SessionsPage() {
  const [sessions, setSessions] = useState<SessionListItem[] | null>(null);
  const [name, setName] = useState("");
  const [status, setStatus] = useState<string | null>(null);

  useEffect(() => {
    const timer = setTimeout(() => {
      void (async () => {
        try {
          const response = await fetch("/api/library/sessions", { cache: "no-store" });
          if (!response.ok) {
            setStatus("Your sessions could not be loaded right now.");
            return;
          }
          setSessions(((await response.json()).sessions ?? []) as SessionListItem[]);
        } catch {
          setStatus("Your sessions could not be loaded right now.");
        }
      })();
    }, 0);
    return () => clearTimeout(timer);
  }, []);

  const createSession = async () => {
    const trimmed = name.trim();
    if (trimmed === "") return;
    try {
      const response = await fetch("/api/library/sessions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: trimmed }),
      });
      if (!response.ok) {
        const body = (await response.json().catch(() => null)) as { error?: string } | null;
        setStatus(body?.error ?? "The session could not be created.");
        return;
      }
      const created = (await response.json()).session as SessionListItem;
      setSessions((prev) => [created, ...(prev ?? [])]);
      setName("");
      setStatus(null);
    } catch {
      setStatus("The session could not be created.");
    }
  };

  const deleteSession = async (id: string) => {
    try {
      const response = await fetch(`/api/library/sessions/${id}`, { method: "DELETE" });
      if (!response.ok) {
        setStatus("The session could not be deleted.");
        return;
      }
      setSessions((prev) => prev?.filter((s) => s.id !== id) ?? null);
    } catch {
      setStatus("The session could not be deleted.");
    }
  };

  return (
    <main className="shell">
      <WaveyardNav />
      <section className="session-preview" aria-label="Sessions">
        <span className="eyebrow">Sessions</span>
        <h1>Play your songs together</h1>
        <p>
          A session lines up several songs and lets you play them as one set — blend each track&rsquo;s stems live,
          swap a vocal or a drum part between songs, and move between them with real crossfades. Transitions use the
          beat grids, tempo and key analysis Waveyard already computed for your music.
        </p>
        <div className="sess-new">
          <label htmlFor="sess-new-name" className="visually-hidden">New session name</label>
          <input
            id="sess-new-name"
            type="text"
            placeholder="Name a new session…"
            value={name}
            maxLength={160}
            onChange={(event) => setName(event.target.value)}
          />
          <button type="button" className="button" onClick={() => void createSession()} disabled={name.trim() === ""} data-testid="session-create">
            Create session
          </button>
        </div>
        {status !== null && <p className="sess-status" role="status">{status}</p>}
        {sessions !== null && sessions.length === 0 && (
          <div className="sess-empty" aria-label="What is a session?">
            <p className="sess-status">No sessions yet.</p>
            <p className="sess-empty-about">
              A session lines up several of your songs and plays them as one set: two decks (the current track and the
              next one), real crossfades, live stem control during transitions, and honest tempo/key/beat evidence for
              every pairing. You can create one above — or press <b>Play as session</b> on any track in the player to
              start with that track loaded. Sessions are saved as you go: close Waveyard, and the set — including the
              track you were on and where — comes back exactly as you left it.
            </p>
          </div>
        )}
        <ul className="sess-list">
          {(sessions ?? []).map((session) => (
            <li key={session.id} className="sess-list-item" data-testid="session-list-item">
              <Link className="sess-list-link" href={`/waveyard/session/${session.id}`}>
                <span className="sess-list-name">{session.name}</span>
                <span className="sess-list-meta">
                  {session.trackCount} track{session.trackCount === 1 ? "" : "s"} · updated{" "}
                  {new Date(session.updatedAt).toLocaleString()}
                </span>
              </Link>
              <button
                type="button"
                className="button tiny"
                aria-label={`Delete ${session.name}`}
                onClick={() => void deleteSession(session.id)}
              >
                Delete
              </button>
            </li>
          ))}
        </ul>
      </section>
    </main>
  );
}
