"use client";

/**
 * MashupStudio — song × song (Waveyard's main goal). Pick a vocal track and
 * an instrumental track; Waveyard reads both songs' real structure (tempo,
 * key, sections) and PROPOSES the mashup: master tempo, stretch, key move,
 * entry point — every decision explained, every risk warned. Render it to a
 * real WAV, or take the plan as a starting point. Extending a song (loop a
 * section to lengthen it) lives here too.
 *
 * Authority: the plan is a proposal. Nothing here touches the user's own
 * arrangement, and the rationale is shown so disagreement is informed.
 */

import { useEffect, useRef, useState } from "react";

import type { Source } from "./types";

type Plan = {
  masterBpm: number;
  vocalsStretchRatio: number;
  vocalsPitchSemitones: number;
  keyRelationship: string;
  segments: Array<{ mashupStartMs: number; mashupEndMs: number; rationale: string }>;
  durationMs: number;
  rationale: string[];
  warnings: string[];
};

export function MashupStudio({ projectId, sources, canEdit }: { projectId: string; sources: Source[]; canEdit: boolean }) {
  const analysable = sources.filter((source) => source.analysis?.bpm != null);
  const [vocalsId, setVocalsId] = useState(analysable[0]?.id ?? "");
  const [bedId, setBedId] = useState(analysable[1]?.id ?? analysable[0]?.id ?? "");
  const [plan, setPlan] = useState<Plan | null>(null);
  const [planning, setPlanning] = useState(false);
  const [rendering, setRendering] = useState<"mashup" | "extend" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [renderUrl, setRenderUrl] = useState<string | null>(null);
  const [renderKind, setRenderKind] = useState<"mashup" | "extended" | null>(null);
  const renderUrlRef = useRef<string | null>(null);

  useEffect(() => {
    return () => {
      if (renderUrlRef.current !== null) URL.revokeObjectURL(renderUrlRef.current);
    };
  }, []);

  const call = async (payload: Record<string, unknown>, kind: "mashup" | "extended") => {
    setRendering(kind === "mashup" ? "mashup" : "extend");
    setError(null);
    const response = await fetch(`/api/waveyard/projects/${projectId}/mashup`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    if (kind === "mashup" && response.headers.get("content-type")?.includes("application/json")) {
      const body = await response.json().catch(() => ({}));
      setRendering(null);
      if (!response.ok) {
        setError(body.error ?? "The mashup could not be planned.");
        return null;
      }
      return body.plan as Plan;
    }
    if (!response.ok) {
      const body = await response.json().catch(() => ({}));
      setRendering(null);
      setError(body.error ?? "The render failed.");
      return null;
    }
    const blob = await response.blob();
    if (renderUrlRef.current !== null) URL.revokeObjectURL(renderUrlRef.current);
    const url = URL.createObjectURL(blob);
    renderUrlRef.current = url;
    setRenderUrl(url);
    setRenderKind(kind);
    setRendering(null);
    return null;
  };

  const planMashup = async () => {
    setPlanning(true);
    setError(null);
    const result = await call({ action: "plan", vocalsSourceId: vocalsId, instrumentalSourceId: bedId }, "mashup");
    setPlan(result);
    setPlanning(false);
  };

  const renderMashup = async () => {
    if (plan === null) return;
    await call({ action: "render", vocalsSourceId: vocalsId, instrumentalSourceId: bedId }, "mashup");
  };

  const extendTrack = async () => {
    if (bedId === "") return;
    await call({ action: "extend", sourceAssetId: bedId, repeats: 2 }, "extended");
  };

  if (sources.length < 2) {
    return (
      <section className="remix-panel" data-testid="mashup-studio">
        <div className="panel-title">
          <div>
            <span className="eyebrow">Song × song</span>
            <h3>Mashup studio</h3>
          </div>
        </div>
        <p className="empty-state">
          Add a second track to the project — Waveyard reads both songs’ structure (tempo, key,
          sections) and proposes the mashup: which tempo wins, how the vocal is stretched and
          pitched, where it enters, and why.
        </p>
      </section>
    );
  }

  return (
    <section className="remix-panel" data-testid="mashup-studio">
      <div className="panel-title">
        <div>
          <span className="eyebrow">Song × song</span>
          <h3>Mashup studio</h3>
        </div>
        <small>{analysable.length} analysed track{analysable.length === 1 ? "" : "s"}</small>
      </div>

      {canEdit && (
        <div className="mashup-pickers">
          <label>
            Vocals from
            <select aria-label="Vocal track" value={vocalsId} onChange={(event) => setVocalsId(event.target.value)}>
              {analysable.map((source) => (
                <option key={source.id} value={source.id}>
                  {source.originalFilename} · {source.analysis?.bpm} BPM{source.analysis?.musicalKey ? ` · ${source.analysis.musicalKey}` : ""}
                </option>
              ))}
            </select>
          </label>
          <label>
            Over the instrumental of
            <select aria-label="Instrumental track" value={bedId} onChange={(event) => setBedId(event.target.value)}>
              {analysable.map((source) => (
                <option key={source.id} value={source.id}>
                  {source.originalFilename} · {source.analysis?.bpm} BPM{source.analysis?.musicalKey ? ` · ${source.analysis.musicalKey}` : ""}
                </option>
              ))}
            </select>
          </label>
          <button className="button" disabled={planning || vocalsId === "" || bedId === "" || vocalsId === bedId} onClick={() => void planMashup()}>
            {planning ? "Reading both songs…" : "Plan the mashup"}
          </button>
        </div>
      )}
      {error && <p className="form-error" role="alert">{error}</p>}

      {plan !== null && (
        <div className="mashup-plan" data-testid="mashup-plan">
          <div className="mashup-plan-summary">
            <div><b>{plan.masterBpm} BPM</b><small>master tempo (bed wins)</small></div>
            <div><b>×{plan.vocalsStretchRatio.toFixed(3)}</b><small>vocal stretch</small></div>
            <div><b>{plan.vocalsPitchSemitones === 0 ? "0" : plan.vocalsPitchSemitones > 0 ? `+${plan.vocalsPitchSemitones}` : plan.vocalsPitchSemitones} st</b><small>vocal pitch ({plan.keyRelationship})</small></div>
            <div><b>{(plan.durationMs / 1000 / 60).toFixed(1)} min</b><small>mashup length</small></div>
          </div>
          {plan.warnings.length > 0 && (
            <ul className="mashup-warnings">
              {plan.warnings.map((warning, index) => <li key={index}>⚠ {warning}</li>)}
            </ul>
          )}
          <details open>
            <summary>Why these decisions</summary>
            <ul className="mashup-rationale">
              {plan.rationale.map((line, index) => <li key={index}>{line}</li>)}
              {plan.segments.map((segment, index) => <li key={`s${index}`}>{segment.rationale}.</li>)}
            </ul>
          </details>
          {canEdit && (
            <div className="remix-actions">
              <button className="button" disabled={rendering !== null} onClick={() => void renderMashup()}>
                {rendering === "mashup" ? "Rendering…" : "Render mashup (WAV)"}
              </button>
              <small>The plan is a proposal — your arrangement is never touched.</small>
            </div>
          )}
        </div>
      )}

      {canEdit && (
        <div className="remix-actions mashup-extend">
          <button className="button secondary" disabled={rendering !== null || bedId === ""} onClick={() => void extendTrack()}>
            {rendering === "extend" ? "Extending…" : "Extend the instrumental (+2 chorus loops)"}
          </button>
        </div>
      )}

      {renderUrl !== null && (
        <div className="chop-render-result">
          <audio controls src={renderUrl} />
          <a className="button secondary" href={renderUrl} download={`waveyard-${renderKind}.wav`}>Download WAV</a>
        </div>
      )}
    </section>
  );
}
