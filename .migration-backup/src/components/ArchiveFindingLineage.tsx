"use client";

import { useState } from "react";

/**
 * Finding lineage — the on-demand lookup the bridge advertises (audit
 * wiring: /api/archive/findings/{reviewItemId}/lineage was UI-orphaned).
 *
 * Explicit and never eager: Arena fetches a finding's lineage only when the
 * user asks for one id, exactly like the route's design ("Arena does NOT
 * eagerly fetch"). Read-only; rendered only when the bridge is connected.
 */
export default function ArchiveFindingLineage({ connected }: { connected: boolean }) {
  const [reviewItemId, setReviewItemId] = useState("");
  const [result, setResult] = useState<{
    lineage: {
      finding: { reviewItemId: number; subjectKey: string; state: string; classification: string | null; title: string };
      currentObservation: { observationId: number; evidenceKey: string; observedAt: string } | null;
      previousObservation: { observationId: number; evidenceKey: string; observedAt: string } | null;
      provider: { provider: string | null; refreshId: string | null; capturedAt: string | null; snapshotReference: string | null } | null;
    };
    facts: Array<{ statement: string }>;
    meta: { generatedAt: string; reviewItemId: number; upstreamHost: string };
  } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  if (!connected) return null;

  const lookup = async () => {
    const id = Number(reviewItemId.trim());
    if (!Number.isInteger(id) || id < 1) {
      setError("Enter the finding's review item id (a positive integer).");
      return;
    }
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      const response = await fetch(`/api/archive/findings/${id}/lineage`, { cache: "no-store" });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) {
        setError(body.message ?? body.error ?? "The lineage lookup failed.");
        return;
      }
      setResult(body);
    } catch {
      setError("The lineage lookup failed — the bridge could not be reached.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="mt-4 rounded-xl border border-white/10 bg-black/20 p-3" data-testid="archive-finding-lineage">
      <p className="text-[10px] font-bold uppercase tracking-[0.14em] text-slate-500">
        Finding lineage — on-demand, read-only
      </p>
      <div className="mt-2 flex flex-wrap items-center gap-2">
        <input
          aria-label="Review item id"
          inputMode="numeric"
          value={reviewItemId}
          onChange={(event) => setReviewItemId(event.target.value)}
          placeholder="review item id"
          className="w-36 rounded-lg bg-black/40 px-2.5 py-1.5 font-mono text-xs text-white ring-1 ring-white/10 focus:outline-none focus:ring-cyan-500/40"
        />
        <button
          onClick={() => void lookup()}
          disabled={busy}
          className="rounded-lg bg-white/5 px-3 py-1.5 text-xs font-bold text-slate-200 ring-1 ring-white/10 hover:bg-white/10 disabled:opacity-50"
        >
          {busy ? "Looking up…" : "Look up lineage"}
        </button>
      </div>
      {error && <p className="mt-2 text-xs text-rose-300">{error}</p>}
      {result && (
        <div className="mt-3 space-y-2 text-xs leading-5 text-slate-300">
          <p className="font-bold text-white">
            #{result.lineage.finding.reviewItemId} · {result.lineage.finding.title}
            <span className="ml-2 font-mono text-[10px] font-normal text-slate-500">{result.lineage.finding.state}</span>
            {result.lineage.finding.classification !== null && (
              <span className="ml-2 rounded bg-white/5 px-1.5 py-0.5 font-mono text-[10px]">{result.lineage.finding.classification}</span>
            )}
          </p>
          <p className="font-mono text-[10px] text-slate-500">subject {result.lineage.finding.subjectKey}</p>
          <ul className="space-y-1">
            {result.facts.map((fact, index) => (
              <li key={index} className="flex items-start gap-2 text-slate-400">
                <span aria-hidden="true" className="mt-1.5 block size-1 shrink-0 rounded-full bg-cyan-300/60" />
                {fact.statement}
              </li>
            ))}
          </ul>
          <p className="text-[10px] text-slate-600">
            fetched {new Date(result.meta.generatedAt).toLocaleString()} · upstream {result.meta.upstreamHost}
          </p>
        </div>
      )}
    </div>
  );
}
