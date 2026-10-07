"use client";

/**
 * Master studio — SOURCE → MASTER ANALYSIS → RECOMMENDATIONS → PREVIEW →
 * APPLY, with honest numbers throughout. Recommendations cite
 * measurements; PREVIEW is a real render with before/after tables; APPLY
 * persists the master insert chain onto the remix session (undo by
 * editing the master rack in the mixer). Export state is reported
 * honestly — no "professionally mastered" claims from a limiter alone.
 */

import { useCallback, useEffect, useState } from "react";

import type { AudioMeasurements } from "@/lib/waveyard/measure/cleanup";

type MasterOperation = { processor: string; params: Record<string, number>; reason: string };

type Analysis = {
  measurements: AudioMeasurements;
  spectral: Record<string, number>;
  targetLufs: number;
  recommendations: MasterOperation[];
};

type Preview = {
  audioUrl: string;
  operations: Array<{ processor: string; params: Record<string, number> }>;
  before: AudioMeasurements;
  after: AudioMeasurements;
};

const MEASUREMENT_ROWS: Array<[string, (m: AudioMeasurements) => number | null]> = [
  ["integrated LUFS", (m) => m.lufsIntegrated],
  ["peak dBFS", (m) => m.peakDb],
  ["true peak dBFS", (m) => m.truePeakDb],
  ["RMS dB", (m) => m.rmsDb],
  ["crest dB", (m) => m.crestDb],
  ["correlation", (m) => m.stereoCorrelation],
];

export function MasterStudio({ projectId, sourceAudioUrl }: { projectId: string; sourceAudioUrl: string | null }) {
  const [analysis, setAnalysis] = useState<Analysis | null>(null);
  const [currentChain, setCurrentChain] = useState<Array<{ processor: string; params: Record<string, number> }>>([]);
  const [exportState, setExportState] = useState<string | null>(null);
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [preview, setPreview] = useState<Preview | null>(null);
  const [phase, setPhase] = useState<"idle" | "loading" | "previewing" | "applying">("idle");
  const [error, setError] = useState<string | null>(null);

  const analyze = useCallback(async () => {
    setError(null);
    setPhase("loading");
    setPreview(null);
    const response = await fetch(`/api/waveyard/projects/${projectId}/master`, { cache: "no-store" }).catch(() => null);
    setPhase("idle");
    if (response === null) {
      setError("Network request failed.");
      return;
    }
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      setError(String(data.error ?? "Master analysis failed."));
      return;
    }
    setAnalysis(data.analysis);
    setCurrentChain(data.currentMasterChain ?? []);
    setExportState(data.exportState ?? null);
    const loaded: Analysis = data.analysis;
    setSelected(new Set((loaded.recommendations ?? []).map((_operation: MasterOperation, index: number) => index)));
  }, [projectId]);

  useEffect(() => {
    void analyze();
  }, [analyze]);

  const call = useCallback(async (body: Record<string, unknown>, busy: typeof phase) => {
    setError(null);
    setPhase(busy);
    const response = await fetch(`/api/waveyard/projects/${projectId}/master`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }).catch(() => null);
    setPhase("idle");
    if (response === null) {
      setError("Network request failed.");
      return null;
    }
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      setError(String(data.error ?? "Request failed."));
      return null;
    }
    return data;
  }, [projectId]);

  const buildPreview = async () => {
    const operations = (analysis?.recommendations ?? []).filter((_, index) => selected.has(index))
      .map((operation) => ({ processor: operation.processor, params: operation.params }));
    if (operations.length === 0) {
      setError("Select at least one master stage.");
      return;
    }
    const data = await call({ action: "preview", operations }, "previewing");
    if (data !== null) setPreview(data.preview);
  };

  const apply = async () => {
    const operations = (analysis?.recommendations ?? []).filter((_, index) => selected.has(index))
      .map((operation) => ({ processor: operation.processor, params: operation.params }));
    const data = await call({ action: "apply", operations }, "applying");
    if (data !== null) {
      setCurrentChain(data.applied ?? []);
      setPreview(null);
    }
  };

  return (
    <section className="master-studio" aria-label="Mastering">
      <header>
        <h3>Master</h3>
        <p className="muted">Measured analysis → real master chain → preview → apply. Numbers only — no adjectives.</p>
        <button onClick={analyze} disabled={phase !== "idle"}>{phase === "loading" ? "Analyzing…" : "Re-analyze"}</button>
      </header>

      {error !== null && <p className="error-message" role="alert">{error}</p>}

      {analysis !== null && (
        <div className="master-analysis" data-testid="master-analysis">
          <h4>Master analysis (measured)</h4>
          <table className="cleanup-measurements">
            <tbody>
              {MEASUREMENT_ROWS.map(([label, get]) => (
                <tr key={label}><td>{label}</td><td>{format(get(analysis.measurements))}</td></tr>
              ))}
              <tr><td>target</td><td>{analysis.targetLufs} LUFS</td></tr>
              {Object.entries(analysis.spectral).map(([band, value]) => (
                <tr key={band}><td>band {band} (rel dB)</td><td>{value.toFixed(1)}</td></tr>
              ))}
            </tbody>
          </table>
          {currentChain.length > 0 && (
            <p className="muted">Current master chain: {currentChain.map((stage) => stage.processor).join(" → ") || "empty"}</p>
          )}

          <h4>Recommended master stages</h4>
          {analysis.recommendations.length === 0 && (
            <p className="muted">No master stage is justified by the measurements — adding one would be decoration, not mastering.</p>
          )}
          {analysis.recommendations.map((operation, index) => (
            <label key={index} className="cleanup-repair">
              <input
                type="checkbox"
                checked={selected.has(index)}
                onChange={(event) =>
                  setSelected((current) => {
                    const next = new Set(current);
                    if (event.target.checked) next.add(index);
                    else next.delete(index);
                    return next;
                  })
                }
              />
              <span>
                <b>{operation.processor}</b> {JSON.stringify(operation.params)}
                <small className="muted"> {operation.reason}</small>
              </span>
            </label>
          ))}
          {analysis.recommendations.length > 0 && (
            <button onClick={buildPreview} disabled={phase === "previewing"}>
              {phase === "previewing" ? "Rendering…" : "Preview master chain"}
            </button>
          )}
        </div>
      )}

      {preview !== null && (
        <div className="master-preview" data-testid="master-preview">
          <h4>Master preview — compare</h4>
          <div className="cleanup-ab">
            <figure>
              <figcaption>Source</figcaption>
              <audio controls preload="none" data-testid="master-source" src={sourceAudioUrl ?? undefined} />
            </figure>
            <figure>
              <figcaption>Mastered (preview)</figcaption>
              <audio controls preload="none" data-testid="master-processed" src={preview.audioUrl} />
            </figure>
          </div>
          <table className="cleanup-measurements">
            <thead><tr><th>Measurement</th><th>Before</th><th>After</th></tr></thead>
            <tbody>
              {MEASUREMENT_ROWS.map(([label, get]) => (
                <tr key={label}>
                  <td>{label}</td>
                  <td>{format(get(preview.before))}</td>
                  <td>{format(get(preview.after))}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <div className="cleanup-actions">
            <button onClick={apply} disabled={phase === "applying"}>
              {phase === "applying" ? "Applying…" : "Apply — set as session master chain"}
            </button>
            <button onClick={() => setPreview(null)}>Discard preview</button>
          </div>
        </div>
      )}

      {exportState !== null && <p className="muted master-export-state" data-testid="master-export-state">{exportState}</p>}
    </section>
  );
}

function format(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return "—";
  return Number.isInteger(value) ? String(value) : value.toFixed(2);
}
