"use client";

/**
 * Cleanup studio — the complete SOURCE→SCAN→REVIEW→PREVIEW→APPLY workflow
 * with zero manual API calls. Findings cite measured evidence; previews are
 * real processed audio with before/after measurements; apply derives a
 * version (original preserved) with undo. Processors are the real insert
 * registry — nothing here pretends a repair.
 */

import { useCallback, useEffect, useRef, useState } from "react";

import type { CleanupReport } from "@/lib/waveyard/measure/cleanup";
import type { CleanupOperation } from "@/lib/waveyard/measure/recommend";

import type { AudioMeasurements } from "@/lib/waveyard/measure/cleanup";

type Applied = {
  id: string;
  operations: CleanupOperation[];
  audioUrl: string;
  measurementsBefore: AudioMeasurements;
  measurementsAfter: AudioMeasurements;
  createdAt: string;
};

type ScanResponse = { report: CleanupReport; recommendations: CleanupOperation[]; sourceAssetId: string };
type PreviewResponse = {
  preview: {
    audioUrl: string;
    operations: CleanupOperation[];
    before: AudioMeasurements;
    after: AudioMeasurements;
  };
};

const SEVERITY_ORDER = { high: 0, warn: 1, info: 2 } as const;

export function CleanupStudio({ projectId }: { projectId: string }) {
  const [phase, setPhase] = useState<"idle" | "scanning" | "review" | "previewing" | "applying">("idle");
  const [error, setError] = useState<string | null>(null);
  const [report, setReport] = useState<CleanupReport | null>(null);
  const [recommendations, setRecommendations] = useState<CleanupOperation[]>([]);
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [preview, setPreview] = useState<PreviewResponse["preview"] | null>(null);
  const [sourceAssetId, setSourceAssetId] = useState<string | null>(null);
  const [versions, setVersions] = useState<Applied[]>([]);
  const abortRef = useRef<AbortController | null>(null);

  const loadVersions = useCallback(async () => {
    const response = await fetch(`/api/waveyard/projects/${projectId}/cleanup`, { cache: "no-store" }).catch(() => null);
    if (response !== null && response.ok) {
      const data = (await response.json()) as { versions: Applied[] };
      setVersions(data.versions);
    }
  }, [projectId]);

  useEffect(() => {
    void loadVersions();
    return () => abortRef.current?.abort();
  }, [loadVersions]);

  const call = useCallback(
    async (body: Record<string, unknown>, success: (data: unknown) => void, busy: typeof phase) => {
      setError(null);
      setPhase(busy);
      abortRef.current?.abort();
      const controller = new AbortController();
      abortRef.current = controller;
      const response = await fetch(`/api/waveyard/projects/${projectId}/cleanup`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
        signal: controller.signal,
      }).catch(() => null);
      if (response === null) {
        setPhase("review");
        setError("Network request failed.");
        return;
      }
      const data = await response.json().catch(() => ({}));
      if (!response.ok) {
        setPhase(response.status === 424 ? "idle" : "review");
        setError(String(data.error ?? "Cleanup request failed."));
        return;
      }
      success(data);
      setPhase("review");
    },
    [projectId],
  );

  const scan = () => {
    setPreview(null);
    setReport(null);
    void call({ action: "scan" }, (data) => {
      const scan = data as ScanResponse;
      setReport(scan.report);
      setRecommendations(scan.recommendations);
      setSourceAssetId(scan.sourceAssetId);
      setSelected(new Set(scan.recommendations.map((_, index) => index)));
    }, "scanning");
  };

  const buildPreview = () => {
    const operations = recommendations.filter((_, index) => selected.has(index));
    if (operations.length === 0) {
      setError("Select at least one repair.");
      return;
    }
    void call({ action: "preview", operations }, (data) => {
      setPreview((data as PreviewResponse).preview);
    }, "previewing");
  };

  const apply = () => {
    const operations = recommendations.filter((_, index) => selected.has(index));
    void call({ action: "apply", operations }, async (data) => {
      const applied = (data as { version: Applied }).version;
      setVersions((current) => [...current, applied]);
      setPreview(null);
      setReport(null);
    }, "applying");
  };

  const revert = async (version: Applied) => {
    const response = await fetch(
      `/api/waveyard/projects/${projectId}/cleanup?versionId=${version.id}`,
      { method: "DELETE" },
    ).catch(() => null);
    if (response !== null && response.ok) {
      setVersions((current) => current.filter((candidate) => candidate.id !== version.id));
    } else {
      setError("Revert failed.");
    }
  };

  const findings = [...(report?.findings ?? [])].sort(
    (a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity],
  );

  return (
    <section className="cleanup-studio" aria-label="Audio cleanup">
      <header>
        <h3>Clean</h3>
        <p className="muted">Scan the source for measured problems, preview real repairs, keep the original.</p>
        <button onClick={scan} disabled={phase === "scanning" || phase === "applying" || phase === "previewing"}>
          {phase === "scanning" ? "Scanning…" : "Scan source"}
        </button>
      </header>

      {error !== null && <p className="error-message" role="alert">{error}</p>}

      {report !== null && (
        <div className="cleanup-findings" data-testid="cleanup-findings">
          <h4>Findings ({findings.length})</h4>
          {findings.length === 0 && <p className="muted">No problems measured above thresholds.</p>}
          {findings.map((finding, index) => (
            <div key={index} className={`finding severity-${finding.severity}`}>
              <b>{finding.kind.replace(/-/g, " ")}</b>
              <small className="muted">
                {finding.severity} · {finding.summary} · {Object.entries(finding.evidence)
                  .map(([key, value]) => `${key}=${typeof value === "number" ? value.toFixed(Number.isInteger(value) ? 0 : 2) : value}`)
                  .join(", ")}
              </small>
            </div>
          ))}

          <h4>Repairs (real processors only)</h4>
          {recommendations.length === 0 && (
            <p className="muted">No honest single-pass repair maps to the findings above — they are reported, not masked.</p>
          )}
          {recommendations.map((operation, index) => (
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
          {recommendations.length > 0 && (
            <button onClick={buildPreview} disabled={phase === "previewing"}>
              {phase === "previewing" ? "Rendering preview…" : "Preview repairs"}
            </button>
          )}
        </div>
      )}

      {preview !== null && (
        <div className="cleanup-preview" data-testid="cleanup-preview">
          <h4>Preview — compare, then decide</h4>
          <div className="cleanup-ab">
            <figure>
              <figcaption>Original</figcaption>
              <audio controls preload="none" data-testid="cleanup-original" src={sourceAssetId === null ? undefined : `/api/assets/${sourceAssetId}`} />
            </figure>
            <figure>
              <figcaption>Processed</figcaption>
              <audio controls preload="none" data-testid="cleanup-processed" src={preview.audioUrl} />
            </figure>
          </div>
          <table className="cleanup-measurements">
            <thead><tr><th>Measurement</th><th>Before</th><th>After</th></tr></thead>
            <tbody>
              {MEASUREMENT_ROWS.map(([key, get]) => (
                <tr key={key}>
                  <td>{key}</td>
                  <td>{formatMeasurement(get(preview.before))}</td>
                  <td>{formatMeasurement(get(preview.after))}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="muted">
            {preview.operations.length} operation{preview.operations.length === 1 ? "" : "s"}:{" "}
            {preview.operations.map((operation) => operation.processor).join(" → ")}
          </p>
          <div className="cleanup-actions">
            <button onClick={apply} disabled={phase === "applying"}>
              {phase === "applying" ? "Applying…" : "Apply — keep original, create version"}
            </button>
            <button onClick={() => setPreview(null)}>Discard preview</button>
          </div>
        </div>
      )}

      {versions.length > 0 && (
        <div className="cleanup-versions" data-testid="cleanup-versions">
          <h4>Cleanup versions ({versions.length})</h4>
          <ul>
            {versions.map((version) => (
              <li key={version.id}>
                <audio controls preload="none" src={version.audioUrl} />
                <span>
                  {version.operations.map((operation) => operation.processor).join(" + ")}
                  <small className="muted">
                    {" "}peak {formatMeasurement(version.measurementsBefore.peakDb)} dBFS →{" "}
                    {formatMeasurement(version.measurementsAfter.peakDb)} dBFS
                  </small>
                </span>
                <button onClick={() => revert(version)} aria-label="Undo cleanup version">Undo</button>
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}

const MEASUREMENT_ROWS: Array<[string, (m: AudioMeasurements) => number | null]> = [
  ["peak dBFS", (m) => m.peakDb],
  ["true peak dBFS", (m) => m.truePeakDb],
  ["RMS dB", (m) => m.rmsDb],
  ["LUFS integrated", (m) => m.lufsIntegrated],
  ["crest dB", (m) => m.crestDb],
  ["DC offset %", (m) => m.dcOffset * 100],
  ["stereo correlation", (m) => m.stereoCorrelation],
  ["clipped regions", (m) => m.clipped.regions],
  ["clipped ms", (m) => m.clipped.clippedSeconds * 1000],
];

function formatMeasurement(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return "—";
  return Number.isInteger(value) ? String(value) : value.toFixed(2);
}
