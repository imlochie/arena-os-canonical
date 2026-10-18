"use client";

import { useCallback, useEffect, useState } from "react";

/**
 * Deep Agent — the bounded autonomous agent: plan → act → verify, capped
 * steps, full transcript, honest engine labels. It drafts and researches; it
 * never writes outside its own run (file/system effects stay behind the
 * approval chain).
 */

type Step = { idx: number; title: string; output: string; verdict: "pass" | "fail"; verdictReason: string; attempts: number };
type Run = { id: string; goal: string; status: string; engine: string; via: string; createdAt: string; steps: Step[] };
type RunSummary = { id: string; goal: string; status: string; via: string; createdAt: string; stepCount: number };

const keys = () => ({
  groq: localStorage.getItem("af_key_groq") || undefined,
  openai: localStorage.getItem("af_key_openai") || undefined,
  openrouter: localStorage.getItem("af_key_openrouter") || undefined,
  mistral: localStorage.getItem("af_key_mistral") || undefined,
});

export default function DeepAgentPage() {
  const [goal, setGoal] = useState("");
  const [steps, setSteps] = useState(3);
  const [run, setRun] = useState<Run | null>(null);
  const [history, setHistory] = useState<RunSummary[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [savedNote, setSavedNote] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const response = await fetch("/api/deep-agent");
      setHistory((await response.json()).runs ?? []);
    } catch {
      /* best effort */
    }
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const start = useCallback(async () => {
    if (!goal.trim() || busy) return;
    setBusy(true);
    setError(null);
    setSavedNote(null);
    try {
      const response = await fetch("/api/deep-agent", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ goal, steps, keys: keys() }),
      });
      const data = await response.json();
      if (!response.ok || !data.run) throw new Error(data.error ?? "Agent run failed. Check run history and retry.");
      setRun(data.run);
      refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Agent run failed. Retry when the model is available.");
      refresh();
    } finally {
      setBusy(false);
    }
  }, [goal, steps, busy, refresh]);

  const open = useCallback(async (id: string) => {
    try {
      const response = await fetch(`/api/deep-agent?id=${id}`);
      const data = await response.json();
      if (!response.ok || !data.run) throw new Error(data.error ?? "Could not open this run. Retry.");
      setRun(data.run);
      setSavedNote(null);
      setError(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not open this run. Retry.");
    }
  }, []);

  const saveArtifact = useCallback(async () => {
    if (!run) return;
    const response = await fetch("/api/deep-agent", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ runId: run.id }),
    });
    const data = await response.json().catch(() => ({}));
    setSavedNote(response.ok ? `Saved to the artifact library${data.artifactId ? ` (${data.artifactId.slice(0, 8)}…)` : ""}.` : `Could not save: ${data.error ?? `HTTP ${response.status}`}`);
  }, [run]);

  const remove = useCallback(
    async (id: string) => {
      try {
        const response = await fetch(`/api/deep-agent?id=${id}`, { method: "DELETE" });
        if (!response.ok) throw new Error("Could not delete this run. Retry.");
        if (run?.id === id) setRun(null);
        refresh();
        setError(null);
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : "Could not delete this run. Retry.");
      }
    },
    [run, refresh],
  );

  return (
    <main className="mx-auto max-w-4xl px-6 py-10">
      <h1 className="text-3xl font-black text-white">Deep Agent</h1>
      <p className="mt-2 text-sm text-slate-400">
        Give it a goal. It plans, works each step, and reviews its own output — capped steps, full transcript, no writes outside this page. The engine
        label on every run is the truth. Reviews assess drafts only: a PASS is not independent evidence that software, tools or audio processing executed.
        Failed or unavailable review stops the run and preserves its transcript.
      </p>

      <div className="mt-6 rounded-2xl border border-white/10 bg-white/[0.03] p-5">
        <textarea
          className="w-full rounded-lg border border-white/10 bg-black/40 px-3 py-2 text-sm text-white placeholder:text-slate-600 focus:border-violet-500 focus:outline-none"
          rows={3}
          value={goal}
          onChange={(e) => setGoal(e.target.value)}
          placeholder="e.g. draft a launch plan for my EP: positioning, 3 platform moves, a 2-week schedule"
        />
        <div className="mt-3 flex items-center gap-3">
          <label className="text-xs text-slate-400">
            steps
            <input
              type="number"
              min={2}
              max={8}
              value={steps}
              onChange={(e) => setSteps(Number(e.target.value))}
              className="ml-2 w-16 rounded-lg border border-white/10 bg-black/40 px-2 py-1 text-sm text-white"
            />
          </label>
          <button
            className="rounded-lg bg-violet-600 px-4 py-2 text-sm font-semibold text-white hover:bg-violet-500 disabled:opacity-50"
            onClick={start}
            disabled={busy || !goal.trim()}
          >
            {busy ? "Working (capped at ~110s)…" : "Run agent"}
          </button>
        </div>
      </div>

      {error && <p role="alert" className="mt-4 text-sm text-rose-300">{error}</p>}
      {run && (
        <section className="mt-6 rounded-2xl border border-white/10 bg-white/[0.03] p-5">
          <div className="flex flex-wrap items-center gap-3">
            <h2 className="text-lg font-bold text-white">{run.goal.slice(0, 80)}</h2>
            <span className="rounded-full border border-white/15 px-2 py-0.5 text-[11px] text-slate-400">
              {run.status} · {run.via || "engine pending"}
            </span>
            <button className="ml-auto rounded-lg border border-emerald-500/30 px-3 py-1 text-xs text-emerald-300 hover:bg-emerald-500/10" onClick={saveArtifact}>
              Save as artifact
            </button>
            <button className="rounded-lg border border-rose-500/30 px-3 py-1 text-xs text-rose-300 hover:bg-rose-500/10" onClick={() => remove(run.id)}>
              Delete run
            </button>
          </div>
          <ol className="mt-4 space-y-3">
            {run.steps.map((step) => (
              <li key={step.idx} className="rounded-xl border border-white/10 bg-black/30 p-4">
                <div className="flex items-center gap-2">
                  <span className="text-xs font-bold text-violet-300">STEP {step.idx + 1}</span>
                  <span className="text-sm font-semibold text-white">{step.title}</span>
                  <span
                    className={`ml-auto rounded-full px-2 py-0.5 text-[10px] font-bold ${step.verdict === "pass" ? "bg-emerald-500/15 text-emerald-300" : "bg-rose-500/15 text-rose-300"}`}
                  >
                    {step.verdict.toUpperCase()}
                    {step.attempts > 1 ? ` · ${step.attempts} attempts` : ""}
                  </span>
                </div>
                <p className="mt-2 whitespace-pre-wrap text-sm text-slate-300">{step.output.slice(0, 4000)}</p>
                <p className="mt-2 text-[11px] italic text-slate-500">reviewer: {step.verdictReason}</p>
              </li>
            ))}
          </ol>
          {savedNote && <p className="mt-3 text-xs text-emerald-300">{savedNote}</p>}
        </section>
      )}

      {history.length > 0 && (
        <section className="mt-6">
          <h3 className="text-xs font-bold uppercase tracking-wider text-slate-400">Previous runs</h3>
          <ul className="mt-2 space-y-1">
            {history.map((item) => (
              <li key={item.id} className="flex items-center gap-3 text-sm">
                <button className="truncate text-left text-slate-300 hover:text-white" onClick={() => open(item.id)}>
                  {item.goal.slice(0, 90)}
                </button>
                <span className="text-[10px] text-slate-500">
                  {item.status} · {item.stepCount} steps · {new Date(item.createdAt).toLocaleString()}
                </span>
                <button className="ml-auto text-[10px] text-rose-400 hover:text-rose-300" onClick={() => remove(item.id)}>
                  delete
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}
    </main>
  );
}
