"use client";

import { useEffect, useState } from "react";

// Curriculum Management. The founder decides what the College currently
// teaches. Arena executes that decision and records it — it never changes the
// curriculum on its own.

interface Course {
  id: string;
  code: string;
  title: string;
  summary: string;
  status: string;
  entryStatus?: string;
}
interface Version {
  id: string;
  label: string;
  versionNumber: number;
  status: string;
  reason: string;
  effectiveFrom: string | null;
}
interface Change {
  id: string;
  changeType: string;
  significance: string;
  field: string;
  previousValue: string;
  newValue: string;
  reason: string;
  createdAt: string;
}

const STATUS_STYLE: Record<string, string> = {
  active: "border-emerald-500/40 text-emerald-300",
  approved: "border-emerald-500/40 text-emerald-300",
  draft: "border-sky-500/40 text-sky-300",
  blueprint: "border-sky-500/40 text-sky-300",
  proposed: "border-violet-500/40 text-violet-300",
  paused: "border-amber-500/40 text-amber-300",
  completed: "border-slate-500/40 text-slate-300",
  archived: "border-slate-600/40 text-slate-400",
  retired: "border-slate-600/40 text-slate-500",
};

export default function CurriculumManager() {
  const [data, setData] = useState<{
    version: Version | null;
    activeCourses: Course[];
    availableCourses: Course[];
    health: Array<{ condition: string; detail: string; severity: string }>;
    versions: Version[];
    changes: Change[];
    note: string;
  } | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [newCode, setNewCode] = useState("");
  const [newTitle, setNewTitle] = useState("");

  const load = async () => {
    const res = await fetch("/api/college/curriculum");
    setData(await res.json());
  };

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const res = await fetch("/api/college/curriculum").catch(() => null);
      if (cancelled || !res) return;
      setData(await res.json());
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const act = async (body: Record<string, unknown>, okMsg: string) => {
    setBusy(true);
    setMsg(null);
    try {
      const res = await fetch("/api/college/curriculum", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const j = await res.json();
      setMsg(j.error ? `✕ ${j.error}` : `✓ ${okMsg}`);
      await load();
    } finally {
      setBusy(false);
    }
  };

  const addCourse = (courseId: string, code: string) => {
    const reason = window.prompt(
      `Why is ${code} entering the active curriculum?\n\nThis is an institutional decision and will be recorded.`
    );
    if (!reason) return;
    act({ action: "add_course", courseId, reason }, `${code} added to the curriculum`);
  };

  const removeCourse = (courseId: string, code: string) => {
    const reason = window.prompt(
      `Why is ${code} leaving the active curriculum?\n\nThe course is preserved, not deleted. Historical sessions stay attached.`
    );
    if (!reason) return;
    const newStatus =
      window.prompt("New status: paused / archived / retired / completed", "archived") ?? "archived";
    act({ action: "remove_course", courseId, reason, newStatus }, `${code} removed (${newStatus})`);
  };

  const createCourse = () => {
    if (!newCode.trim() || !newTitle.trim()) {
      setMsg("✕ code and title are required");
      return;
    }
    act(
      {
        action: "create_course",
        code: newCode.trim(),
        title: newTitle.trim(),
        reason: "Created by founder.",
      },
      `${newCode} created as a draft — add it to the curriculum when ready`
    ).then(() => {
      setNewCode("");
      setNewTitle("");
    });
  };

  const newVersion = () => {
    const reason = window.prompt(
      "Why create a new curriculum version?\n\nThe current configuration is preserved and historical sessions keep referencing it."
    );
    if (!reason) return;
    act({ action: "new_version", reason }, "New curriculum version created");
  };

  if (!data) return <p className="py-20 text-center text-slate-400">Loading curriculum…</p>;

  return (
    <div className="space-y-5">
      <header className="rounded-2xl border border-white/10 bg-gradient-to-br from-emerald-950/40 via-[#0a0f22] to-[#060a17] p-5">
        <p className="text-[11px] font-semibold uppercase tracking-[0.2em] text-emerald-300/70">
          Living institutional state
        </p>
        <h1 className="mt-1 text-2xl font-black tracking-tight text-white">Curriculum</h1>
        <p className="mt-1 text-sm text-slate-400">
          The handbook defines the College&apos;s framework. You decide what it currently teaches.
        </p>
        <div className="mt-3 flex flex-wrap items-center gap-3 border-t border-white/10 pt-3">
          <span className="rounded-lg border border-emerald-500/30 bg-emerald-500/10 px-3 py-1.5 text-[12px] font-bold text-emerald-200">
            {data.version ? data.version.label : "No version"}
          </span>
          <span className="text-[12px] text-slate-400">
            {data.activeCourses.length} active · {data.availableCourses.length} known but not active
          </span>
          <button
            onClick={newVersion}
            disabled={busy}
            className="ml-auto rounded-lg border border-white/15 bg-white/5 px-3 py-1.5 text-[12px] font-semibold text-slate-200 hover:bg-white/10 disabled:opacity-50"
          >
            + New version
          </button>
        </div>
      </header>

      {msg && (
        <p
          className={`rounded-xl border px-4 py-2 text-sm ${
            msg.startsWith("✓")
              ? "border-emerald-500/30 bg-emerald-500/5 text-emerald-200"
              : "border-rose-500/30 bg-rose-500/5 text-rose-200"
          }`}
        >
          {msg}
        </p>
      )}

      <div className="grid gap-5 lg:grid-cols-2">
        {/* ACTIVE CURRICULUM */}
        <section className="rounded-2xl border border-white/10 bg-white/[0.03] p-4">
          <h2 className="text-[13px] font-extrabold uppercase tracking-wider text-white">
            Active curriculum
          </h2>
          <p className="mb-3 text-[11px] italic text-slate-500">What the College currently teaches</p>
          {data.activeCourses.length ? (
            <ul className="space-y-2">
              {data.activeCourses.map((c) => (
                <li key={c.id} className="rounded-lg border border-white/10 bg-black/20 p-3">
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <p className="text-[13px] font-bold text-white">
                        {c.code} — {c.title}
                      </p>
                      {c.summary ? (
                        <p className="mt-0.5 text-[11px] text-slate-400">{c.summary.slice(0, 120)}</p>
                      ) : null}
                    </div>
                    <span
                      className={`shrink-0 rounded border px-1.5 py-0.5 font-mono text-[9px] uppercase ${
                        STATUS_STYLE[c.status] ?? "border-slate-500/40 text-slate-400"
                      }`}
                    >
                      {c.status}
                    </span>
                  </div>
                  <button
                    onClick={() => removeCourse(c.id, c.code)}
                    disabled={busy}
                    className="mt-2 rounded border border-white/10 px-2 py-1 text-[11px] font-semibold text-slate-300 hover:bg-white/5 disabled:opacity-50"
                  >
                    Remove from curriculum
                  </button>
                </li>
              ))}
            </ul>
          ) : (
            <p className="rounded-lg border border-dashed border-white/10 px-3 py-6 text-center text-[12px] text-slate-500">
              The curriculum is empty. Courses below are known to the College but have not been
              selected into it.
            </p>
          )}
        </section>

        {/* AVAILABLE */}
        <section className="rounded-2xl border border-white/10 bg-white/[0.03] p-4">
          <h2 className="text-[13px] font-extrabold uppercase tracking-wider text-white">
            Known but not active
          </h2>
          <p className="mb-3 text-[11px] italic text-slate-500">
            Existing is not the same as being taught — you choose
          </p>
          {data.availableCourses.length ? (
            <ul className="space-y-2">
              {data.availableCourses.map((c) => (
                <li
                  key={c.id}
                  className="flex items-center justify-between gap-2 rounded-lg border border-white/10 bg-black/20 p-3"
                >
                  <div className="min-w-0">
                    <p className="text-[13px] font-bold text-white">
                      {c.code} — {c.title}
                    </p>
                    <span
                      className={`mt-0.5 inline-block rounded border px-1.5 py-0.5 font-mono text-[9px] uppercase ${
                        STATUS_STYLE[c.status] ?? "border-slate-500/40 text-slate-400"
                      }`}
                    >
                      {c.status}
                    </span>
                  </div>
                  <button
                    onClick={() => addCourse(c.id, c.code)}
                    disabled={busy}
                    className="shrink-0 rounded-lg bg-emerald-600/80 px-3 py-1.5 text-[11px] font-bold text-white hover:bg-emerald-500 disabled:opacity-50"
                  >
                    + Add
                  </button>
                </li>
              ))}
            </ul>
          ) : (
            <p className="rounded-lg border border-dashed border-white/10 px-3 py-6 text-center text-[12px] text-slate-500">
              Every known course is in the curriculum.
            </p>
          )}

          <div className="mt-4 rounded-lg border border-white/10 bg-black/20 p-3">
            <p className="mb-2 text-[11px] uppercase tracking-wide text-slate-500">
              Create a new course
            </p>
            <div className="flex flex-wrap gap-2">
              <input
                value={newCode}
                onChange={(e) => setNewCode(e.target.value)}
                placeholder="CODE"
                className="w-24 rounded border border-white/15 bg-black/40 px-2 py-1.5 text-[12px] text-white placeholder:text-slate-600"
              />
              <input
                value={newTitle}
                onChange={(e) => setNewTitle(e.target.value)}
                placeholder="Course title"
                className="min-w-0 flex-1 rounded border border-white/15 bg-black/40 px-2 py-1.5 text-[12px] text-white placeholder:text-slate-600"
              />
              <button
                onClick={createCourse}
                disabled={busy}
                className="rounded-lg bg-violet-600/80 px-3 py-1.5 text-[11px] font-bold text-white hover:bg-violet-500 disabled:opacity-50"
              >
                Create draft
              </button>
            </div>
          </div>
        </section>
      </div>

      {/* HEALTH */}
      <section className="rounded-2xl border border-white/10 bg-white/[0.03] p-4">
        <h2 className="text-[13px] font-extrabold uppercase tracking-wider text-white">
          Curriculum conditions
        </h2>
        <p className="mb-3 text-[11px] italic text-slate-500">
          Actual conditions, not a score
        </p>
        {data.health.length ? (
          <ul className="space-y-1.5">
            {data.health.map((h, i) => (
              <li
                key={i}
                className={`rounded-lg border px-3 py-2 ${
                  h.severity === "high"
                    ? "border-rose-500/30 bg-rose-500/5"
                    : h.severity === "medium"
                      ? "border-amber-500/25 bg-amber-500/5"
                      : "border-white/10 bg-black/20"
                }`}
              >
                <p className="text-[12px] font-semibold text-white">{h.condition}</p>
                <p className="text-[11px] text-slate-400">{h.detail}</p>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-[12px] text-slate-500">No conditions detected.</p>
        )}
      </section>

      {/* CHANGE LOG */}
      <section className="rounded-2xl border border-white/10 bg-white/[0.03] p-4">
        <h2 className="text-[13px] font-extrabold uppercase tracking-wider text-white">
          Curriculum history
        </h2>
        <p className="mb-3 text-[11px] italic text-slate-500">
          Institutional decisions are distinguished from ordinary edits
        </p>
        {data.changes.length ? (
          <ul className="space-y-1.5">
            {data.changes.map((c) => (
              <li key={c.id} className="rounded-lg border border-white/10 bg-black/20 px-3 py-2">
                <div className="flex items-center justify-between gap-2">
                  <span className="font-mono text-[10px] uppercase text-slate-400">
                    {c.changeType}
                  </span>
                  <span
                    className={`rounded border px-1.5 py-0.5 font-mono text-[9px] uppercase ${
                      c.significance === "institutional_decision"
                        ? "border-violet-500/40 text-violet-300"
                        : "border-slate-600/40 text-slate-500"
                    }`}
                  >
                    {c.significance === "institutional_decision" ? "decision" : "edit"}
                  </span>
                </div>
                {c.previousValue || c.newValue ? (
                  <p className="mt-0.5 text-[11px] text-slate-300">
                    {c.field ? <span className="text-slate-500">{c.field}: </span> : null}
                    {c.previousValue ? (
                      <span className="text-slate-500 line-through">{c.previousValue.slice(0, 40)}</span>
                    ) : null}
                    {c.previousValue && c.newValue ? " → " : ""}
                    {c.newValue ? <span>{c.newValue.slice(0, 60)}</span> : null}
                  </p>
                ) : null}
                {c.reason ? <p className="text-[11px] italic text-slate-500">{c.reason}</p> : null}
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-[12px] text-slate-500">No curriculum changes recorded.</p>
        )}
      </section>

      <p className="rounded-xl border border-white/10 bg-black/20 px-4 py-3 text-[11px] italic text-slate-500">
        Editing the curriculum never rewrites history. Each session is pinned to the curriculum
        version and course snapshot that existed when it occurred.
      </p>
    </div>
  );
}
