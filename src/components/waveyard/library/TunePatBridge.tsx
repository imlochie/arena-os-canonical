"use client";
import { useEffect, useRef, useState } from "react";
const candidate = "C:\\Program Files (x86)\\TunePat\\TunePat Apple Music Converter\\TunePat Apple Music Converter.exe";
export default function TunePatBridge({ onImport, busy }: { onImport: (files: File[]) => Promise<void>; busy: boolean }) {
  const [path, setPath] = useState(""), [status, setStatus] = useState("Not configured; native conversion is independent of TunePat."), [checking, setChecking] = useState(false);
  const folder = useRef<HTMLInputElement>(null);
  useEffect(() => { folder.current?.setAttribute("webkitdirectory", ""); }, []);
  // Configuration is browser-local owner input. It is sent only on an explicit action.
  const act = async (action: "status" | "launch") => {
    setChecking(true);
    try { localStorage.setItem("af_waveyard_tunepat_path", path); const response = await fetch("/api/library/tunepat", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action, path, confirm: action === "launch" }) }); const data = await response.json(); setStatus(response.ok ? `${data.state}: ${data.message}` : data.error); }
    catch (error) { setStatus(`External tool request failed: ${String(error)}`); } finally { setChecking(false); }
  };
  return <details><summary>Optional TunePat external tool</summary>
    <p>Windows desktop bridge only; requires a fresh owner sign-in to launch. No supported automation interface has been verified. Arena sends no conversion arguments and does not capture protected playback. Configure TunePat&apos;s destination inside TunePat, then explicitly select its completed output folder below.</p>
    <label>TunePat executable<input aria-label="TunePat executable" value={path} onChange={e => setPath(e.target.value)} /></label>
    <button type="button" onClick={() => setPath(localStorage.getItem("af_waveyard_tunepat_path") ?? "")}>Load saved tool path</button>
    <button type="button" onClick={() => setPath(candidate)}>Use supplied shortcut candidate (not universal)</button>
    <button type="button" disabled={checking || !path} onClick={() => void act("status")}>Check TunePat installation</button>
    <button type="button" disabled={checking || !path} onClick={() => { if (window.confirm("Open your configured TunePat application? This does not start or verify a conversion.")) void act("launch"); }}>Open TunePat</button>
    <p role="status">{status}</p>
    <label>Select completed TunePat output folder<input aria-label="TunePat output folder" ref={folder} type="file" multiple disabled={busy} onChange={e => { void onImport(Array.from(e.target.files ?? [])); e.target.value = ""; }} /></label>
    <p>User-selected files use the same metadata, checksum, deduplication and library intake as native music. No automatic directory watcher or host-wide scan.</p>
  </details>;
}
