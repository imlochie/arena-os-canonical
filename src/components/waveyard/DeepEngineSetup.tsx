"use client";

/**
 * DeepEngineSetup — the self-service preparation flow for the deep
 * (six-stem Demucs) engine.
 *
 * This is a REAL setup flow, not instructions: every action calls a
 * backend operation and returns an honest result.
 *  - Inspect the actual engine state (interpreters, checkpoint,
 *    FFmpeg) and the ordered plan with what will be installed or
 *    downloaded, its verified source, expected size and license.
 *  - Consent to the material steps, then let Arena prepare an
 *    isolated environment, acquire and verify the model, and run a
 *    real inference smoke test.
 *  - Watch meaningful progress, cancel, retry recoverable failures,
 *    review actionable errors, import a checkpoint you already own,
 *    and confirm the verified model + runtime versions.
 *
 * State is polled from the durable server-side record, so it survives
 * navigation and reconnect; nothing here is remembered client-side.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import {
  cancelDeepPreparation,
  fetchDeepPreparation,
  importDeepCheckpoint,
  recoverDeepPreparation,
  startDeepPreparation,
  type DeepPreparationConsent,
  type DeepPreparationInspect,
  type DeepPreparationStatus,
} from "@/lib/waveyard/separation/client";
import { fetchDeepEngineStatus } from "@/lib/waveyard/separation/client";

const POLL_MS = 2_000;

/** Lifecycle states that mean "a run is in flight" — poll while in one. */
const ACTIVE_STATES = new Set([
  "checking",
  "awaiting_consent",
  "preparing_python",
  "installing_dependencies",
  "acquiring_model",
  "verifying_model",
  "testing_engine",
  "recovering",
]);

const STATE_LABEL: Record<string, string> = {
  not_prepared: "Not prepared",
  checking: "Inspecting this machine",
  awaiting_consent: "Waiting for your approval",
  preparing_python: "Preparing the Python runtime",
  installing_dependencies: "Installing the engine's dependencies",
  acquiring_model: "Acquiring the model",
  verifying_model: "Verifying the model",
  testing_engine: "Testing the engine",
  ready: "Ready",
  failed: "Failed",
  cancelled: "Cancelled",
  recovering: "Recovering an interrupted run",
};

const STEP_STATE_DOT: Record<string, string> = {
  pending: "bg-slate-600",
  active: "bg-sky-400 animate-pulse",
  done: "bg-emerald-400",
  failed: "bg-red-400",
  skipped: "bg-slate-500",
};

function megabytes(bytes: number | null): string {
  if (bytes === null) return "size confirmed at download";
  return `~${Math.round(bytes / 1_000_000)} MB`;
}

export function DeepEngineSetup({ onReady }: { onReady?: () => void } = {}) {
  const [inspect, setInspect] = useState<DeepPreparationInspect | null>(null);
  const [deep, setDeep] = useState<Awaited<ReturnType<typeof fetchDeepEngineStatus>>>(null);
  const [consented, setConsented] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [importing, setImporting] = useState(false);
  const [showImport, setShowImport] = useState(false);
  const fileRef = useRef<HTMLInputElement | null>(null);

  const status = inspect?.status ?? null;
  const state = status?.state ?? "not_prepared";
  const prepared = deep?.prepared ?? false;

  const refresh = useCallback(async (withPlan = false) => {
    const [preparation, deepStatus] = await Promise.all([
      fetchDeepPreparation(withPlan),
      fetchDeepEngineStatus(),
    ]);
    if (preparation !== null) setInspect(preparation);
    if (deepStatus !== null) setDeep(deepStatus);
  }, []);

  // Poll while a preparation is in flight; stop once terminal.
  useEffect(() => {
    if (!ACTIVE_STATES.has(state)) return;
    const timer = setInterval(() => void refresh(false), POLL_MS);
    return () => clearInterval(timer);
  }, [state, refresh]);

  // Initial load.
  useEffect(() => {
    void refresh(false);
  }, [refresh]);

  // Surface readiness to the parent (e.g. re-enable the deep target).
  useEffect(() => {
    if (prepared) onReady?.();
  }, [prepared, onReady]);

  async function inspectPlan() {
    setActionError(null);
    await refresh(true);
  }

  async function begin() {
    setBusy(true);
    setActionError(null);
    setNotice(null);
    const result = await startDeepPreparation([...consented]);
    if (!result.ok) setActionError(result.error);
    await refresh(true);
    setBusy(false);
  }

  async function cancel() {
    setBusy(true);
    await cancelDeepPreparation();
    await refresh(false);
    setBusy(false);
  }

  async function recover() {
    setBusy(true);
    setActionError(null);
    await recoverDeepPreparation();
    await refresh(true);
    setBusy(false);
  }

  async function retry() {
    // A failure is recoverable: re-plan (discovery is re-run) and
    // start again with the same consents.
    setBusy(true);
    setActionError(null);
    await refresh(true);
    const result = await startDeepPreparation([...consented]);
    if (!result.ok) setActionError(result.error);
    await refresh(false);
    setBusy(false);
  }

  async function runReadinessTest() {
    setBusy(true);
    setNotice("Running the readiness test against the real engine…");
    await refresh(true);
    setNotice(null);
    setBusy(false);
  }

  async function onImportFile(file: File | undefined) {
    if (file === undefined) return;
    setImporting(true);
    setActionError(null);
    const result = await importDeepCheckpoint(file);
    if (!result.ok) setActionError(result.error ?? "The checkpoint could not be imported.");
    else setNotice("Checkpoint imported and verified — re-checking readiness.");
    await refresh(true);
    setImporting(false);
    if (fileRef.current !== null) fileRef.current.value = "";
  }

  const consentItems = (inspect?.plan?.consent ?? []) as DeepPreparationConsent[];
  const needsConsent = inspect?.plan?.needsConsent ?? false;
  const allConsented = consentItems.every((item) => consented.has(item.id));
  const canStart = !ACTIVE_STATES.has(state) && state !== "ready" && (!needsConsent || allConsented);

  const steps = status?.steps ?? [];
  const progress = status?.progress;

  return (
    <section className="deep-setup rounded-xl border border-white/10 bg-white/[0.03] p-4" data-testid="deep-engine-setup" aria-label="Deep engine setup">
      <header className="flex items-center justify-between gap-3">
        <div>
          <h3 className="text-sm font-bold text-white">Deep separation — six stems</h3>
          <p className="mt-0.5 text-[11px] leading-4 text-slate-400">
            vocals · drums · bass · guitar · piano · other — a local Demucs engine Arena prepares for you.
          </p>
        </div>
        <span
          className={`shrink-0 rounded-full border px-2.5 py-1 text-[10px] font-bold ${
            prepared
              ? "border-emerald-400/30 bg-emerald-500/15 text-emerald-300"
              : "border-slate-500/40 bg-slate-500/10 text-slate-300"
          }`}
          data-testid="deep-engine-state"
        >
          {prepared ? "READY" : state === "ready" ? "READY" : STATE_LABEL[state] ?? state}
        </span>
      </header>

      {/* What is actually missing — the honest self-diagnosis. */}
      {!prepared && deep !== null && deep.reason !== null && !ACTIVE_STATES.has(state) && state !== "failed" && (
        <p className="mt-3 rounded-lg border border-amber-400/20 bg-amber-500/10 p-2.5 text-[11px] leading-4 text-amber-200" data-testid="deep-missing-reason">
          {deep.reason}
        </p>
      )}

      {/* Progress while a run is in flight. */}
      {ACTIVE_STATES.has(state) && (
        <div className="mt-3" data-testid="deep-progress">
          <div className="flex items-center justify-between text-[11px]">
            <span className="font-bold text-sky-300">{progress?.label ?? STATE_LABEL[state]}</span>
            <span className="text-slate-400">{progress?.percent ?? 0}%</span>
          </div>
          <div className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-white/10">
            <div
              className="h-full rounded-full bg-sky-400 transition-[width]"
              style={{ width: `${progress?.percent ?? 0}%` }}
            />
          </div>
          <ol className="mt-3 space-y-1">
            {steps.map((step) => (
              <li key={step.id} className="flex items-center gap-2 text-[11px]">
                <span className={`inline-block h-1.5 w-1.5 rounded-full ${STEP_STATE_DOT[step.state] ?? "bg-slate-600"}`} />
                <span className={step.state === "active" ? "text-white" : "text-slate-400"}>{step.label}</span>
                <span className="ml-auto text-slate-500">{step.state === "done" ? "done" : step.state === "active" ? "running…" : step.state}</span>
              </li>
            ))}
          </ol>
          <button type="button" className="button secondary mt-3" onClick={() => void cancel()}>
            Cancel
          </button>
        </div>
      )}

      {/* Failure: actionable detail + recovery. */}
      {(state === "failed" || state === "recovering") && status?.error !== null && status?.error !== undefined && (
        <div className="mt-3 rounded-lg border border-red-400/30 bg-red-500/10 p-3" data-testid="deep-error">
          <p className="text-[11px] font-bold text-red-300">
            {state === "recovering" ? "Preparation was interrupted (Arena restarted mid-run)." : `Preparation failed (${status?.error?.code ?? "error"}).`}
          </p>
          <p className="mt-1 text-[11px] leading-4 text-red-200/90">{status?.error?.message}</p>
          <div className="mt-2 flex gap-2">
            {state === "recovering" ? (
              <button type="button" className="button secondary" onClick={() => void recover()}>
                Review &amp; start again
              </button>
            ) : (
              <button type="button" className="button secondary" disabled={busy} onClick={() => void retry()}>
                Retry
              </button>
            )}
          </div>
        </div>
      )}

      {/* Ready: the verified facts. */}
      {(state === "ready" || prepared) && status !== null && (
        <dl className="mt-3 grid gap-1.5 text-[11px] leading-4" data-testid="deep-ready-facts">
          <div className="flex gap-2"><dt className="w-28 shrink-0 text-slate-500">Engine</dt><dd className="text-emerald-300">verified — real inference probe passed</dd></div>
          <div className="flex gap-2"><dt className="w-28 shrink-0 text-slate-500">Model</dt><dd className="text-slate-200">htdemucs_6s · checkpoint 5c90dfd2-34c22ccb</dd></div>
          <div className="flex gap-2"><dt className="w-28 shrink-0 text-slate-500">Provenance</dt><dd className="font-mono text-slate-300">{status.result.provenance ?? "htdemucs_6s@5c90dfd2-34c22ccb/demucs-…"}</dd></div>
          <div className="flex gap-2"><dt className="w-28 shrink-0 text-slate-500">Python</dt><dd className="font-mono text-slate-300">{status.environment.pythonVersion ?? "…"} · isolated environment</dd></div>
          <div className="flex gap-2"><dt className="w-28 shrink-0 text-slate-500">Demucs</dt><dd className="text-slate-300">{status.environment.demucsVersion ?? "…"}</dd></div>
          <div className="flex gap-2"><dt className="w-28 shrink-0 text-slate-500">Stored at</dt><dd className="font-mono break-all text-slate-400" title={status.environment.checkpointPath}>{status.environment.checkpointPath}</dd></div>
        </dl>
      )}

      {/* The plan + consent, shown before anything material happens. */}
      {!prepared && !ACTIVE_STATES.has(state) && state !== "ready" && state !== "failed" && inspect?.plan !== undefined && (
        <div className="mt-3" data-testid="deep-plan">
          <p className="text-[11px] font-bold text-slate-200">Arena will prepare the deep engine:</p>
          <ol className="mt-1.5 space-y-1">
            {inspect.plan.phases.flatMap((phase) => phase.steps).map((step) => (
              <li key={step.id} className="flex items-start gap-2 text-[11px] leading-4">
                <span className="mt-1 inline-block h-1 w-1 shrink-0 rounded-full bg-slate-500" />
                <span><b className="text-slate-200">{step.label}</b> — <span className="text-slate-400">{step.detail}</span></span>
              </li>
            ))}
          </ol>

          {needsConsent && (
            <div className="mt-3 space-y-2 border-t border-white/10 pt-3">
              <p className="text-[11px] font-bold text-slate-200">Review what Arena will do — nothing happens until you approve:</p>
              {consentItems.map((item) => (
                <label key={item.id} className="flex cursor-pointer items-start gap-2 rounded-lg border border-white/10 bg-white/[0.02] p-2.5" data-testid={`consent-${item.id}`}>
                  <input
                    type="checkbox"
                    className="mt-0.5"
                    checked={consented.has(item.id)}
                    onChange={(event) => {
                      const next = new Set(consented);
                      if (event.target.checked) next.add(item.id);
                      else next.delete(item.id);
                      setConsented(next);
                    }}
                  />
                  <span>
                    <span className="block text-[11px] font-bold text-white">
                      {item.label} <span className="font-normal text-slate-500">({megabytes(item.sizeBytes)})</span>
                    </span>
                    <span className="mt-0.5 block text-[10px] leading-3.5 text-slate-400">{item.reason}</span>
                    <span className="mt-0.5 block text-[10px] text-slate-500">
                      Source: {item.source} · Stored in: <span className="font-mono">{item.destination}</span>
                    </span>
                    <span className="mt-0.5 block text-[10px] italic leading-3.5 text-amber-300/90">{item.license}</span>
                  </span>
                </label>
              ))}
            </div>
          )}

          <button type="button" className="button mt-3" disabled={busy || (needsConsent && !allConsented)} onClick={() => void begin()} data-testid="deep-start">
            {busy ? "Starting…" : "Prepare deep separation"}
          </button>
        </div>
      )}

      {/* Actions available whenever the engine is not prepared and nothing is running. */}
      {!prepared && !ACTIVE_STATES.has(state) && state !== "ready" && state !== "failed" && inspect?.plan === undefined && (
        <button type="button" className="button secondary mt-3" onClick={() => void inspectPlan()}>
          Inspect &amp; prepare deep engine
        </button>
      )}

      {/* Always-available secondary actions. */}
      <div className="mt-3 flex flex-wrap items-center gap-2 border-t border-white/10 pt-2.5">
        <button type="button" className="button secondary" disabled={busy} onClick={() => void runReadinessTest()}>
          Run readiness test
        </button>
        <button type="button" className="button secondary" onClick={() => { setShowImport((v) => !v); }}>
          {showImport ? "Hide import" : "Import a checkpoint I already have"}
        </button>
        {showImport && (
          <span className="flex items-center gap-2 text-[11px] text-slate-300">
            <input
              ref={fileRef}
              type="file"
              aria-label="Import the htdemucs_6s checkpoint file"
              onChange={(event) => void onImportFile(event.target.files?.[0])}
            />
            {importing && <span className="text-slate-400">verifying…</span>}
          </span>
        )}
      </div>

      {actionError !== null && <p className="form-error mt-2" role="alert" data-testid="deep-setup-error">{actionError}</p>}
      {notice !== null && <p className="notice mt-2" role="status" data-testid="deep-setup-notice">{notice}</p>}

      {status?.log.length ? (
        <details className="mt-3">
          <summary className="cursor-pointer text-[10px] text-slate-500">Preparation log ({status.log.length} lines)</summary>
          <pre className="mt-1 max-h-40 overflow-auto rounded-lg bg-black/40 p-2 font-mono text-[10px] leading-4 text-slate-300">
            {status.log.join("\n")}
          </pre>
        </details>
      ) : null}
    </section>
  );
}
