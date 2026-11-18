"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  MANUAL_VOCAL_SECTION_LABELS,
  manualVocalSectionLabel,
  manualVocalSectionSchema,
  type ManualVocalSection,
  type ManualVocalSectionLabel,
} from "@workspace/arena/lib/waveyard/types";
import type { Source, Stem } from "./types";

function formatTime(milliseconds: number) {
  const seconds = Math.max(0, milliseconds) / 1_000;
  const minutes = Math.floor(seconds / 60);
  return `${minutes}:${String(Math.floor(seconds % 60)).padStart(2, "0")}.${String(Math.round((seconds % 1) * 10))}`;
}

function labelTitle(label: ManualVocalSectionLabel) {
  return label === "pre-chorus" ? "Pre-chorus" : label[0].toUpperCase() + label.slice(1);
}

export function ManualVocalSectionEditor({
  source,
  vocalStem,
  remixId,
  onFindWhereFits,
}: {
  source: Source;
  vocalStem: Stem | null;
  remixId: string | null;
  onFindWhereFits?: (sectionId: string, stemAssetId: string) => Promise<string | null>;
}) {
  const audioRef = useRef<HTMLAudioElement>(null);
  const durationMs = Math.max(1, Math.round((vocalStem?.durationSeconds ?? source.durationSeconds) * 1_000));
  const [sections, setSections] = useState<ManualVocalSection[]>([]);
  const [revision, setRevision] = useState(0);
  const [loaded, setLoaded] = useState(false);
  const [stale, setStale] = useState(false);
  const [revisionConflict, setRevisionConflict] = useState(false);
  const [confirmCurrentAudio, setConfirmCurrentAudio] = useState(false);
  const [label, setLabel] = useState<ManualVocalSectionLabel>("verse");
  const [title, setTitle] = useState("");
  const [startMs, setStartMs] = useState(0);
  const [endMs, setEndMs] = useState(Math.min(durationMs, 20_000));
  const [editingId, setEditingId] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [findingId, setFindingId] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  const load = useCallback(async (signal?: AbortSignal) => {
    if (!remixId || !vocalStem) {
      setSections([]);
      setRevision(0);
      setStale(false);
      setRevisionConflict(false);
      setLoaded(true);
      return;
    }
    setLoaded(false);
    setMessage(null);
    setSections([]);
    try {
      const response = await fetch(`/api/remixes/${remixId}/manual-vocal-sections/${source.id}/${vocalStem.id}`, { signal });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(body.error ?? "Could not load saved vocal markers.");
      const parsed: ManualVocalSection[] = [];
      if (Array.isArray(body.sections)) {
        for (const value of body.sections as unknown[]) {
          const validated = manualVocalSectionSchema.safeParse(value);
          if (!validated.success) throw new Error("Saved vocal markers are incomplete; no markers were changed.");
          parsed.push(validated.data);
        }
      }
      setSections(parsed);
      setRevision(Number.isSafeInteger(body.revision) && body.revision >= 0 ? body.revision : 0);
      setStale(body.stale === true);
      setConfirmCurrentAudio(false);
      setRevisionConflict(false);
    } catch (error) {
      if (signal?.aborted) return;
      setMessage(error instanceof Error ? error.message : "Could not load saved vocal markers.");
    } finally {
      if (!signal?.aborted) setLoaded(true);
    }
  }, [remixId, source.id, source.checksumSha256, vocalStem?.id, vocalStem?.checksumSha256]);

  useEffect(() => {
    const controller = new AbortController();
    void load(controller.signal);
    return () => controller.abort();
  }, [load]);

  useEffect(() => {
    const refreshOnReturn = () => {
      if (!editingId && !saving && !revisionConflict) void load();
    };
    window.addEventListener("focus", refreshOnReturn);
    return () => window.removeEventListener("focus", refreshOnReturn);
  }, [editingId, load, revisionConflict, saving]);

  const save = async (next: ManualVocalSection[]) => {
    if (!remixId || !vocalStem) {
      setMessage("Open a private Studio session to save these vocal markers.");
      return false;
    }
    if (revisionConflict) {
      setMessage("Reload the newer session markers before saving over them.");
      return false;
    }
    setSaving(true);
    setMessage(null);
    try {
      const response = await fetch(`/api/remixes/${remixId}/manual-vocal-sections/${source.id}/${vocalStem.id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          expectedRevision: revision,
          confirmCurrentAudio,
          sections: next,
        }),
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) {
        if (body.code === "VOCAL_SECTION_SOURCE_CHANGED") setStale(true);
        if (body.code === "VOCAL_SECTION_REVISION_CONFLICT") {
          setRevisionConflict(true);
          setMessage(body.error ?? "Markers changed on another device. Reload before saving.");
        } else {
          setMessage(body.error ?? "Could not save vocal markers.");
        }
        return false;
      }
      setSections(body.sections);
      setRevision(body.revision);
      setStale(false);
      setConfirmCurrentAudio(false);
      setMessage("Saved in this private Studio session.");
      return true;
    } catch {
      setMessage("Could not reach the server. Your unsaved edits remain on this screen.");
      return false;
    } finally {
      setSaving(false);
    }
  };

  const markPlayhead = (edge: "start" | "end") => {
    const player = audioRef.current;
    if (!player) return;
    const time = Math.max(0, Math.min(durationMs, Math.round(player.currentTime * 1_000)));
    if (edge === "start") {
      setStartMs(Math.min(time, Math.max(0, endMs - 1)));
    } else {
      setEndMs(Math.max(time, startMs + 1));
    }
  };

  const submitSection = async () => {
    const parsed = manualVocalSectionSchema.safeParse({
      id: editingId ?? crypto.randomUUID(),
      label,
      title: label === "custom" ? title : "",
      startMs: Math.round(startMs),
      endMs: Math.round(endMs),
    });
    if (!parsed.success || parsed.data.endMs > durationMs) {
      setMessage(parsed.error?.issues[0]?.message ?? "Choose a range inside the current vocal audio.");
      return;
    }
    const next = [...sections.filter((section) => section.id !== parsed.data.id), parsed.data]
      .sort((left, right) => left.startMs - right.startMs || left.endMs - right.endMs);
    if (await save(next)) {
      setEditingId(null);
      setTitle("");
    }
  };

  const editSection = (section: ManualVocalSection) => {
    setEditingId(section.id);
    setLabel(section.label);
    setTitle(section.title);
    setStartMs(section.startMs);
    setEndMs(section.endMs);
    setMessage(null);
  };

  const findFit = async (section: ManualVocalSection) => {
    if (!onFindWhereFits || !vocalStem || stale) return;
    setFindingId(section.id);
    setMessage(null);
    try {
      const result = await onFindWhereFits(section.id, vocalStem.id);
      setMessage(result ?? "Placement recommendations are ready to review.");
    } catch {
      setMessage("Could not check placements. Your saved vocal markers are unchanged.");
    } finally {
      setFindingId(null);
    }
  };

  return (
    <section className="manual-vocal-sections" aria-label="Manual vocal sections" data-testid="manual-vocal-section-editor">
      <div className="panel-title">
        <div><span className="eyebrow">Human evidence</span><h3>Mark vocal sections</h3></div>
        <div className="manual-vocal-section-header-actions">
          <span>{sections.length} saved</span>
          <button type="button" className="button secondary" disabled={!remixId || !vocalStem || !loaded || saving || revisionConflict} onClick={() => void load()}>Reload saved markers</button>
        </div>
      </div>
      <p>Listen to the separated vocal and mark intro, verse, chorus, or other ranges. These labels remain human-authored; Waveyard uses the exact source times to find measured placement options.</p>
      {vocalStem ? (
        <audio ref={audioRef} controls preload="metadata" src={`/api/assets/${encodeURIComponent(vocalStem.id)}`} aria-label="Separated vocal stem for section marking" />
      ) : (
        <p className="notice">Separate this source into stems to mark vocal ranges.</p>
      )}
      {!remixId && <p className="notice">Create or open a private Studio session to save markers and use them for placement.</p>}
      {revisionConflict && <div className="notice" role="alert">
        Newer markers were saved in this session on another device. Your draft will not overwrite them silently.
        <button type="button" className="button secondary" disabled={saving || !loaded} onClick={() => {
          setEditingId(null);
          setLabel("verse");
          setTitle("");
          setStartMs(0);
          setEndMs(Math.min(durationMs, 20_000));
          void load();
        }}>Discard this draft and reload</button>
      </div>}
      {stale && <div className="notice" role="alert">
        This source or vocal stem changed after these markers were saved. Listen to the current vocal audio and re-check the boundaries before saving them for reuse.
        <label><input type="checkbox" checked={confirmCurrentAudio} onChange={(event) => setConfirmCurrentAudio(event.target.checked)} /> I rechecked these boundaries against the current vocal stem</label>
      </div>}
      <div className="manual-vocal-section-form">
        <label>Section
          <select value={label} onChange={(event) => setLabel(event.target.value as ManualVocalSectionLabel)}>
            {MANUAL_VOCAL_SECTION_LABELS.map((value) => <option key={value} value={value}>{labelTitle(value)}</option>)}
          </select>
        </label>
        {label === "custom" && <label>Custom name<input maxLength={80} value={title} onChange={(event) => setTitle(event.target.value)} /></label>}
        <label>Start (seconds)
          <input type="number" min="0" max={durationMs / 1_000} step="0.05" value={(startMs / 1_000).toFixed(2)} onChange={(event) => setStartMs(Math.round(Number(event.target.value) * 1_000))} />
        </label>
        <button type="button" className="button secondary" disabled={!vocalStem} onClick={() => markPlayhead("start")}>Set start to playhead</button>
        <label>End (seconds)
          <input type="number" min="0.05" max={durationMs / 1_000} step="0.05" value={(endMs / 1_000).toFixed(2)} onChange={(event) => setEndMs(Math.round(Number(event.target.value) * 1_000))} />
        </label>
        <button type="button" className="button secondary" disabled={!vocalStem} onClick={() => markPlayhead("end")}>Set end to playhead</button>
        <button type="button" className="button" disabled={!remixId || !vocalStem || saving || revisionConflict || (stale && !confirmCurrentAudio)} onClick={() => void submitSection()}>
          {saving ? "Saving…" : editingId ? "Save section" : "Add section"}
        </button>
        {editingId && <button type="button" className="button secondary" disabled={saving} onClick={() => { setEditingId(null); setMessage(null); }}>Cancel edit</button>}
      </div>
      {!loaded && <p role="status">Loading this session’s vocal markers…</p>}
      {sections.length > 0 && <ol className="manual-vocal-section-list">
        {sections.map((section) => <li key={section.id}>
          <div><strong>{manualVocalSectionLabel(section)}</strong><span>{formatTime(section.startMs)}–{formatTime(section.endMs)}</span></div>
          <div className="manual-vocal-section-actions">
            <button type="button" className="button secondary" onClick={() => editSection(section)}>Edit range</button>
            <button type="button" className="button" disabled={!onFindWhereFits || !remixId || stale || findingId !== null} onClick={() => void findFit(section)}>
              {findingId === section.id ? "Finding…" : "Find where this fits"}
            </button>
            <button type="button" className="button secondary" disabled={saving} onClick={() => void save(sections.filter((item) => item.id !== section.id))}>Delete</button>
          </div>
        </li>)}
      </ol>}
      {message && <p className="notice" role="status">{message}</p>}
      <small>Only section labels and source times are saved with this private session. Audio is not copied into the annotation record. Saved placements become normal clips that can be moved or edited later.</small>
    </section>
  );
}
