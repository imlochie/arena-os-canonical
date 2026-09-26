"use client";

import Link from "next/link";
import { FormEvent, useEffect, useState } from "react";

type PublicData = { project: { title: string; description: string; genre: string | null; tags: string[]; licenseCode: string; creatorDisplayName: string; releaseDate: string }; release: { filename: string; durationSeconds: number; sampleRate: number; channels: number; format: string; downloadAllowed: boolean } };

export function PublicProject({ projectId }: { projectId: string }) {
  const [data, setData] = useState<PublicData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [reporting, setReporting] = useState(false);
  const [reportMessage, setReportMessage] = useState<string | null>(null);
  useEffect(() => { void fetch(`/api/public/projects/${projectId}`, { cache: "no-store" }).then(async (response) => { const body = await response.json().catch(() => ({})); if (!response.ok) setError(body.error ?? "This public project is unavailable."); else setData(body); }).catch(() => setError("This public project is unavailable.")); }, [projectId]);
  async function report(event: FormEvent<HTMLFormElement>) { event.preventDefault(); const reason = String(new FormData(event.currentTarget).get("reason") ?? ""); const response = await fetch(`/api/public/projects/${projectId}/reports`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ reason }) }); const body = await response.json().catch(() => ({})); if (response.ok) { setReportMessage(body.reused ? "You have already reported this project." : "Report received for review."); setReporting(false); } else setReportMessage(body.error ?? "Sign in to report this project."); }
  if (error) return <main className="shell"><p className="error" role="alert">{error}</p><Link href="/discover" className="button secondary">Browse releases</Link></main>;
  if (!data) return <main className="shell"><p className="notice">Loading public release…</p></main>;
  const { project, release } = data;
  return <main className="shell public-project"><nav className="nav"><Link href="/" className="brand"><i>Waveyard</i><small>open stem studio</small></Link><div className="navlinks"><Link href="/discover">Discover</Link><button className="link-button" onClick={() => void navigator.clipboard.writeText(window.location.href)}>Copy link</button></div></nav><article className="public-release"><span className="eyebrow">{project.genre || "Public release"}</span><h1>{project.title}</h1><p className="creator">By {project.creatorDisplayName}</p><p>{project.description || "No public description yet."}</p>{project.tags.length > 0 && <p className="tags">{project.tags.map((tag) => <span key={tag}>#{tag}</span>)}</p>}<dl className="release-meta"><dt>License</dt><dd>{project.licenseCode}</dd><dt>Released</dt><dd>{new Date(project.releaseDate).toLocaleDateString()}</dd><dt>Render</dt><dd>{release.format.toUpperCase()} · {release.sampleRate} Hz · {release.channels} ch · {Math.round(release.durationSeconds)}s</dd></dl><audio controls preload="metadata" src={`/api/public/projects/${projectId}/release`} aria-label="Public final release" />{release.downloadAllowed && <a className="button secondary" href={`/api/public/projects/${projectId}/release?download=1`}>Download WAV</a>}<div className="report-box">{reportMessage && <p className="notice">{reportMessage}</p>}{reporting ? <form onSubmit={report}><label>Report reason<textarea name="reason" required minLength={3} maxLength={1000} rows={3} /></label><button className="button secondary">Send report</button></form> : <button className="link-button" onClick={() => setReporting(true)}>Report this public project</button>}</div></article></main>;
}
