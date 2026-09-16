"use client";

// Space detail — the popped-out window view (/spaces/[id]). Shows everything
// about one agent space: full output, briefcase editor, run history, controls.
// While this window is open it keeps its agent ticking.

import { useCallback, useEffect, useRef, useState } from "react";
import Markdown from "@/components/Markdown";
import { loadKeys } from "@/components/KeysBar";
import { privacyFlags } from "@/lib/privacyClient";

interface SpaceState {
  id: string;
  title: string;
  emoji: string;
  prompt: string;
  modelId: string;
  intervalMinutes: number;
  status: "running" | "paused";
  briefcase: string;
  lastOutput: string | null;
  lastRunAt: string | null;
  nextRunAt: string | null;
  runCount: number;
  okCount: number;
  due: boolean;
}

interface Run {
  id: string;
  status: string;
  output: string;
  via: string;
  ms: number;
  createdAt: string;
}

function fmtCountdown(ms: number): string {
  if (ms <= 0) return "due now";
  const s = Math.ceil(ms / 1000);
  if (s < 90) return `${s}s`;
  const m = Math.round(s / 60);
  return m < 90 ? `${m}m` : `${Math.round(m / 60)}h`;
}

export default function SpaceDetail({ id }: { id: string }) {
  const [space, setSpace] = useState<SpaceState | null>(null);
  const [runs, setRuns] = useState<Run[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [briefcaseDraft, setBriefcaseDraft] = useState<string | null>(null); // null = not editing
  const [tab, setTab] = useState<"output" | "history" | "setup">("output");
  const tickInFlight = useRef(false);

  const load = useCallback(async () => {
    try {
      const res = await fetch(`/api/spaces/${id}`);
      if (!res.ok) {
        setError("space not found");
        return;
      }
      const data = await res.json();
      setSpace(data.space);
      setRuns(data.runs ?? []);
    } catch {
      setError("load failed");
    }
  }, [id]);

  useEffect(() => {
    void load();
  }, [load]);

  // this window keeps its agent ticking while open
  const tick = useCallback(async () => {
    if (tickInFlight.current) return;
    if (typeof document !== "undefined" && document.visibilityState !== "visible") return;
    tickInFlight.current = true;
    try {
      const res = await fetch("/api/spaces/tick", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ limit: 1, keys: loadKeys(), ...privacyFlags() }),
      });
      const data = await res.json();
      if (Array.isArray(data.spaces)) {
        const mine = (data.spaces as SpaceState[]).find((s) => s.id === id);
        if (mine) setSpace(mine);
        if (data.ran?.includes(id)) void load(); // fetch fresh runs if this space ran
      }
    } catch {
      /* transient */
    } finally {
      tickInFlight.current = false;
    }
  }, [id, load]);

  useEffect(() => {
    const iv = setInterval(() => void tick(), 15000);
    return () => clearInterval(iv);
  }, [tick]);

  const runNow = async () => {
    setBusy(true);
    try {
      const res = await fetch(`/api/spaces/${id}/run`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ keys: loadKeys(), ...privacyFlags() }),
      });
      const data = await res.json();
      if (data?.space) setSpace(data.space);
      void load();
    } finally {
      setBusy(false);
    }
  };

  const patch = async (body: Record<string, unknown>) => {
    setBusy(true);
    try {
      const res = await fetch(`/api/spaces/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = await res.json();
      if (data?.space) setSpace(data.space);
    } finally {
      setBusy(false);
    }
  };

  // state-driven clock so render stays pure
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const iv = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(iv);
  }, []);

  if (error) {
    return (
      <div className="mx-auto max-w-3xl p-8 text-center">
        <p className="text-3xl">🫥</p>
        <p className="mt-2 text-sm font-bold text-slate-300">{error}</p>
      </div>
    );
  }
  if (!space) {
    return (
      <div className="mx-auto max-w-3xl p-8 text-center text-sm text-slate-400">loading space…</div>
    );
  }

  const nextIn = space.nextRunAt ? new Date(space.nextRunAt).getTime() - now : 0;

  return (
    <div className="mx-auto max-w-3xl">
      {/* title bar */}
      <div className="glass overflow-hidden rounded-2xl">
        <div className="flex items-center gap-2 border-b border-white/10 bg-white/[0.03] px-3 py-2.5">
          <span className="flex gap-1.5">
            <span className="h-2.5 w-2.5 rounded-full bg-red-400/60" />
            <span className="h-2.5 w-2.5 rounded-full bg-amber-400/60" />
            <span className="h-2.5 w-2.5 rounded-full bg-emerald-400/60" />
          </span>
          <span className="ml-1 min-w-0 flex-1 truncate text-sm font-extrabold text-white">
            {space.emoji} {space.title}
          </span>
          <span
            className={`shrink-0 text-[11px] font-bold ${
              space.status === "running" ? (space.due ? "text-amber-300" : "text-emerald-300") : "text-slate-500"
            }`}
          >
            {space.status === "running" ? (space.due ? "● due now" : `● next in ${fmtCountdown(nextIn)}`) : "⏸ paused"}
          </span>
        </div>

        <div className="p-4">
          <div className="flex flex-wrap items-center gap-1.5">
            <button
              onClick={() => void runNow()}
              disabled={busy}
              className="rounded-lg bg-cyan-500/15 px-3 py-1.5 text-xs font-bold text-cyan-200 ring-1 ring-cyan-400/30 hover:bg-cyan-500/25 disabled:opacity-40"
            >
              ⚡ Run now
            </button>
            <button
              onClick={() => void patch({ status: space.status === "running" ? "paused" : "running" })}
              disabled={busy}
              className="rounded-lg bg-white/5 px-3 py-1.5 text-xs font-bold text-slate-300 ring-1 ring-white/10 hover:bg-white/10 disabled:opacity-40"
            >
              {space.status === "running" ? "⏸ Pause" : "▶ Resume"}
            </button>
            <span className="ml-auto text-[11px] text-slate-500">
              {space.runCount} runs · {space.okCount} ok · every {space.intervalMinutes}m
            </span>
          </div>

          {/* tabs */}
          <div className="mt-3 flex gap-1.5">
            {(["output", "history", "setup"] as const).map((t) => (
              <button
                key={t}
                onClick={() => setTab(t)}
                className={`rounded-lg px-3 py-1.5 text-xs font-bold transition ${
                  tab === t
                    ? "bg-cyan-400/15 text-cyan-100 ring-1 ring-cyan-400/40"
                    : "bg-white/5 text-slate-400 ring-1 ring-white/10 hover:bg-white/10"
                }`}
              >
                {t === "output" ? "📄 Latest" : t === "history" ? `🕘 History (${runs.length})` : "⚙️ Setup"}
              </button>
            ))}
          </div>

          <div className="mt-3">
            {tab === "output" && (
              <div className="scroll-thin max-h-[46vh] overflow-y-auto rounded-xl bg-black/30 p-4 ring-1 ring-white/5">
                {space.lastOutput ? (
                  <Markdown text={space.lastOutput} />
                ) : (
                  <p className="text-xs italic text-slate-600">no output yet</p>
                )}
              </div>
            )}

            {tab === "history" && (
              <div className="scroll-thin max-h-[46vh] space-y-2 overflow-y-auto pr-1">
                {runs.length === 0 && <p className="text-xs italic text-slate-600">no runs yet</p>}
                {runs.map((r) => (
                  <details key={r.id} className="rounded-xl bg-white/[0.03] p-3 ring-1 ring-white/5">
                    <summary className="cursor-pointer text-[11px] font-bold text-slate-400">
                      {r.status === "ok" ? "✅" : "❌"} {new Date(r.createdAt).toLocaleString()} · {r.ms}ms · {r.via || "—"}
                    </summary>
                    <div className="mt-2 text-xs text-slate-200">
                      <Markdown text={r.output} />
                    </div>
                  </details>
                ))}
              </div>
            )}

            {tab === "setup" && (
              <div className="space-y-3">
                <label className="block">
                  <span className="text-xs font-bold uppercase tracking-wider text-slate-400">Task prompt</span>
                  <textarea
                    defaultValue={space.prompt}
                    rows={8}
                    onBlur={(e) => {
                      if (e.target.value.trim() && e.target.value !== space.prompt) {
                        void patch({ prompt: e.target.value });
                      }
                    }}
                    className="scroll-thin mt-1.5 w-full resize-y rounded-xl border border-white/10 bg-black/40 px-3 py-2 text-xs leading-relaxed text-white outline-none focus:border-cyan-400/60"
                  />
                  <span className="text-[10px] text-slate-600">edits save when you click away</span>
                </label>

                <div>
                  <span className="text-xs font-bold uppercase tracking-wider text-slate-400">
                    Briefcase (carry-forward notes)
                  </span>
                  {briefcaseDraft === null ? (
                    <div className="mt-1.5">
                      <pre className="scroll-thin max-h-40 overflow-y-auto whitespace-pre-wrap rounded-xl bg-black/30 p-3 text-xs text-slate-300 ring-1 ring-white/5">
                        {space.briefcase || "(empty)"}
                      </pre>
                      <button
                        onClick={() => setBriefcaseDraft(space.briefcase)}
                        className="mt-1.5 rounded-lg bg-white/5 px-3 py-1.5 text-xs font-bold text-slate-300 ring-1 ring-white/10 hover:bg-white/10"
                      >
                        ✏️ Edit briefcase
                      </button>
                    </div>
                  ) : (
                    <div className="mt-1.5">
                      <textarea
                        value={briefcaseDraft}
                        onChange={(e) => setBriefcaseDraft(e.target.value)}
                        rows={8}
                        className="scroll-thin w-full resize-y rounded-xl border border-white/10 bg-black/40 px-3 py-2 text-xs text-white outline-none focus:border-cyan-400/60"
                      />
                      <div className="mt-1.5 flex gap-2">
                        <button
                          onClick={async () => {
                            await patch({ briefcase: briefcaseDraft });
                            setBriefcaseDraft(null);
                          }}
                          disabled={busy}
                          className="rounded-lg bg-cyan-500/15 px-3 py-1.5 text-xs font-bold text-cyan-200 ring-1 ring-cyan-400/30 hover:bg-cyan-500/25 disabled:opacity-40"
                        >
                          {busy ? "saving…" : "💾 Save briefcase"}
                        </button>
                        <button
                          onClick={() => setBriefcaseDraft(null)}
                          className="rounded-lg bg-white/5 px-3 py-1.5 text-xs text-slate-300 ring-1 ring-white/10"
                        >
                          Cancel
                        </button>
                      </div>
                    </div>
                  )}
                </div>

                <label className="block">
                  <span className="text-xs font-bold text-slate-400">Interval (minutes)</span>
                  <input
                    type="number"
                    min={5}
                    max={1440}
                    defaultValue={space.intervalMinutes}
                    onBlur={(e) => {
                      const v = Number(e.target.value);
                      if (v && v !== space.intervalMinutes) void patch({ intervalMinutes: v });
                    }}
                    className="mt-1 w-28 rounded-xl border border-white/10 bg-black/40 px-3 py-2 text-xs text-white outline-none"
                  />
                  <span className="ml-2 text-[10px] text-slate-600">edits save when you click away</span>
                </label>
              </div>
            )}
          </div>
        </div>
      </div>
      <p className="mt-3 text-center text-[11px] text-slate-600">
        this window keeps its agent ticking while open · drafts only — you act on them
      </p>
    </div>
  );
}
