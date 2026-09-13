"use client";

import { useCallback, useEffect, useState } from "react";
import Markdown from "./Markdown";
import { loadKeys } from "./KeysBar";
import PrivacyControls from "./PrivacyControls";
import ProjectPicker from "./ProjectPicker";
import HandoffButtons from "./HandoffButtons";
import { privacyFlags, usePrivacySettings } from "@/lib/privacyClient";
import { COGNITIVE_JOBS, COUNCIL_STAGES, getCognitiveJob } from "@/lib/cognitiveJobs";

interface ModelInfo {
  id: string;
  name: string;
  emoji: string;
  kind: string;
}

export default function CouncilLab() {
  const [models, setModels] = useState<ModelInfo[]>([]);
  const [jobId, setJobId] = useState("second_brain");
  const [material, setMaterial] = useState("");
  const [modelA, setModelA] = useState("random");
  const [modelB, setModelB] = useState("random");
  const [synthModel, setSynthModel] = useState("auto");

  const [running, setRunning] = useState(false);
  const [lifecycle, setLifecycle] = useState("created");
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [sessionStatus, setSessionStatus] = useState<string | null>(null);
  const [run, setRun] = useState<any | null>(null);
  const [artifact, setArtifact] = useState<any | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [history, setHistory] = useState<any[]>([]);
  const [artifacts, setArtifacts] = useState<any[]>([]);
  const [sideTab, setSideTab] = useState<"runs" | "artifacts">("runs");
  const [search, setSearch] = useState("");
  const [copied, setCopied] = useState<string | null>(null);
  const [savingTpl, setSavingTpl] = useState(false);
  const [projectId, setProjectId] = useState("");
  const [handoffSource, setHandoffSource] = useState<string | null>(null);
  const privacy = usePrivacySettings();

  const textModels = models.filter((m) => m.kind === "text");
  const job = getCognitiveJob(jobId);
  const isEph = !!run?.ephemeral;
  const stage = ["perspectives", "cross_critique", "synthesis", "artifact_generation"].indexOf(lifecycle);

  const fetchHistory = useCallback(async () => {
    try {
      const r = await fetch("/api/council?limit=30");
      const j = await r.json();
      setHistory(j.runs ?? []);
    } catch {}
    try {
      const r = await fetch("/api/council/artifacts?limit=30");
      const j = await r.json();
      setArtifacts(j.artifacts ?? []);
    } catch {}
  }, []);

  const loadSession = useCallback(async (id: string) => {
    const r = await fetch(`/api/cognitive-sessions/${id}`, { cache: "no-store" });
    const data = await r.json();
    if (!r.ok) throw new Error(data.error?.message ?? "session lookup failed");
    setLifecycle(data.session.lifecycleState ?? data.session.status);
    setSessionId(id);
    setSessionStatus(data.session.status);
    if (typeof data.session.metadata?.jobId === "string") setJobId(data.session.metadata.jobId);
    const primaryInput = data.inputs?.find((input: any) => input.kind === "primary") ?? data.inputs?.[0];
    if (primaryInput?.content) setMaterial(primaryInput.content);
    if (data.session.projectId) setProjectId(data.session.projectId);
    setRunning(data.session.status !== "created" && !data.terminal);
    if (data.run) setRun(data.run);
    if (data.artifact) setArtifact(data.artifact);
    if (data.session.status === "failed") {
      setError(data.session.errorMessage ?? "Council execution failed.");
    }
    return data;
  }, []);

  useEffect(() => {
    fetch("/api/models").then((r) => r.json()).then((j) => setModels(j.models ?? [])).catch(() => {});
    fetchHistory();
    // Handoff intake: ?material= &projectId= &jobId= &source=
    try {
      const q = new URLSearchParams(window.location.search);
      const mat = q.get("material");
      if (mat) setMaterial(mat.slice(0, 8000));
      const pj = q.get("projectId");
      if (pj) setProjectId(pj);
      const jb = q.get("jobId");
      if (jb && COGNITIVE_JOBS.some((j) => j.id === jb)) setJobId(jb);
      const src = q.get("source");
      if (src) setHandoffSource(src);
      const sid = q.get("sessionId");
      if (sid) {
        loadSession(sid).catch(() => {});
        const poll = window.setInterval(async () => {
          try {
            const data = await loadSession(sid);
            if (data.terminal) window.clearInterval(poll);
          } catch {}
        }, 1000);
        return () => window.clearInterval(poll);
      }
    } catch {}
  }, [fetchHistory, loadSession]);

  async function start(m?: string, j?: string) {
    const mat = (m ?? material).trim();
    if (!mat || running) return;
    const jobPick = j ?? jobId;
    const inheritedSessionId = sessionStatus === "created" ? sessionId : null;
    setMaterial(mat);
    setJobId(jobPick);
    setRunning(true);
    setLifecycle("created");
    if (!inheritedSessionId) setSessionId(null);
    setError(null);
    setNotice(null);
    setRun(null);
    setArtifact(null);
    let poll: number | null = null;
    let activeSessionId: string | null = null;
    try {
      const flags = privacyFlags();
      const payload: any = { material: mat, jobId: jobPick, keys: loadKeys(), ...flags };
      if (modelA !== "random") payload.modelAId = modelA;
      if (modelB !== "random") payload.modelBId = modelB;
      if (synthModel !== "auto") payload.synthesisModel = synthModel;
      if (projectId) payload.projectId = projectId;

      // Ephemeral mode intentionally creates no durable record. Every persisted
      // Council creates its session first, then executes in a second request.
      if (!flags.ephemeral) {
        let createdSessionId = inheritedSessionId;
        if (!createdSessionId) {
          const createdResponse = await fetch("/api/cognitive-sessions", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ mode: "council", material: mat, jobId: jobPick, projectId: projectId || undefined }),
          });
          const created = await createdResponse.json();
          if (!createdResponse.ok) throw new Error(created.error?.message ?? "session creation failed");
          createdSessionId = String(created.session.id);
        }
        activeSessionId = createdSessionId;
        payload.sessionId = createdSessionId;
        setSessionId(createdSessionId);
        const url = new URL(window.location.href);
        url.searchParams.set("sessionId", createdSessionId);
        window.history.replaceState({}, "", url);
        poll = window.setInterval(async () => {
          try {
            const state = await loadSession(createdSessionId);
            if (state.terminal && poll !== null) window.clearInterval(poll);
          } catch {}
        }, 1000);
      } else {
        setLifecycle("perspectives");
      }

      const r = await fetch("/api/council", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const data = await r.json();
      if (!r.ok) throw new Error(data.error?.message ?? data.error ?? "council run failed");
      setRun(data.run);
      setArtifact(data.artifact ?? null);
      setLifecycle("completed");
      if (activeSessionId) await loadSession(activeSessionId);
      if (poll !== null) window.clearInterval(poll);
      if (!data.run?.ephemeral) fetchHistory();
      const secs = data.ms ? (data.ms / 1000).toFixed(0) : "?";
      setNotice(
        `${getCognitiveJob(jobPick).emoji} Council complete in ~${secs}s — 2 perspectives, cross-critique, synthesis + artifact.` +
          (data.localOnly ? " 🔒 Fully on-device." : "")
      );
    } catch (e: any) {
      const state = activeSessionId ? await loadSession(activeSessionId).catch(() => null) : null;
      if (!state || state.terminal) {
        if (poll !== null) window.clearInterval(poll);
        setRunning(false);
      }
      setError(e.message ?? "run failed");
    } finally {
      if (!activeSessionId) setRunning(false);
    }
  }

  async function openRun(id: string) {
    try {
      const r = await fetch(`/api/council/${id}`);
      const j = await r.json();
      if (j.run) {
        setRun(j.run);
        setArtifact((j.artifacts ?? [])[0] ?? null);
        setJobId(j.run.jobId);
        setMaterial(j.run.material);
        setNotice(null);
        setError(null);
        window.scrollTo({ top: 0, behavior: "smooth" });
      }
    } catch {}
  }

  async function deleteRun(id: string) {
    if (!confirm("Delete this council run and its artifact?")) return;
    await fetch(`/api/council/${id}`, { method: "DELETE" });
    setHistory((h) => h.filter((x: any) => x.id !== id));
    setArtifacts((a) => a.filter((x: any) => x.runId !== id));
    if (run?.id === id) {
      setRun(null);
      setArtifact(null);
    }
  }

  function copy(id: string, text: string) {
    const done = () => {
      setCopied(id);
      setTimeout(() => setCopied(null), 1500);
    };
    if (navigator.clipboard?.writeText) navigator.clipboard.writeText(text).then(done).catch(done);
    else done();
  }

  function downloadArtifact() {
    if (!artifact) return;
    const blob = new Blob([`# ${artifact.title}\n\n${artifact.body}`], { type: "text/markdown" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `${(artifact.kind || "artifact").replace(/[^a-z0-9-]+/gi, "-")}.md`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  }

  async function saveArtifactAsTemplate() {
    if (!artifact || savingTpl) return;
    setSavingTpl(true);
    try {
      await fetch("/api/templates", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: artifact.title.slice(0, 80), prompt: artifact.body.slice(0, 2000), category: "general" }),
      });
      copy("tpl", "saved");
    } finally {
      setSavingTpl(false);
    }
  }

  const filteredHistory = history.filter((h: any) =>
    search.trim() ? (h.material as string).toLowerCase().includes(search.toLowerCase()) : true
  );
  const filteredArtifacts = artifacts.filter((a: any) =>
    search.trim()
      ? ((a.title + " " + a.body) as string).toLowerCase().includes(search.toLowerCase())
      : true
  );

  return (
    <div className="grid gap-5 lg:grid-cols-[1fr_300px]">
      <div className="min-w-0">
        <div className="glass rounded-2xl p-4 sm:p-5">
          <p className="text-[11px] font-black uppercase tracking-wider text-slate-400">
            1 · What cognitive job are you doing?
          </p>
          <div className="mt-2 grid gap-2 sm:grid-cols-2 xl:grid-cols-3">
            {COGNITIVE_JOBS.map((j) => (
              <button
                key={j.id}
                onClick={() => setJobId(j.id)}
                className={`rounded-xl border p-3 text-left transition ${
                  jobId === j.id
                    ? "border-cyan-400/60 bg-cyan-500/10 shadow-[0_8px_28px_rgba(34,211,238,0.25)]"
                    : "border-white/10 bg-white/[0.03] hover:border-cyan-500/40"
                }`}
              >
                <p className="text-sm font-extrabold text-white">
                  {j.emoji} {j.name}
                </p>
                <p className="mt-0.5 text-[11px] font-bold text-cyan-300">{j.question}</p>
                <p className="mt-1 line-clamp-2 text-[11px] leading-relaxed text-slate-400">{j.description}</p>
                <p className="mt-1.5 text-[10px] font-bold text-slate-500">
                  {j.roleA.emoji} {j.roleA.name} ↔ {j.roleB.emoji} {j.roleB.name}
                </p>
              </button>
            ))}
          </div>

          <p className="mt-4 text-[11px] font-black uppercase tracking-wider text-slate-400">
            2 · Drop the raw material (mess welcome)
          </p>
          <textarea
            value={material}
            onChange={(e) => setMaterial(e.target.value)}
            rows={4}
            placeholder={`For ${job.name}: paste notes, half-formed ideas, drafts, data, dilemmas — the council turns disagreement into the answer. (Ctrl+Enter to run)`}
            onKeyDown={(e) => {
              if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) start();
            }}
            className="mt-2 min-h-[100px] w-full resize-y rounded-xl border border-white/10 bg-black/40 px-4 py-3 text-[15px] text-white placeholder:text-slate-500 focus:border-cyan-500 focus:outline-none focus:ring-2 focus:ring-cyan-500/30"
          />
          <div className="mt-2 grid gap-1.5">
            {job.examples.map((ex) => (
              <button
                key={ex.slice(0, 40)}
                onClick={() => start(ex)}
                className="truncate rounded-lg border border-white/10 bg-white/[0.03] px-3 py-1.5 text-left text-xs text-slate-300 hover:border-cyan-500/50 hover:text-white"
                title={ex}
              >
                {ex.length > 110 ? ex.slice(0, 110) + "…" : ex}
              </button>
            ))}
          </div>

          <div className="mt-3 grid gap-2 rounded-xl border border-white/5 bg-black/20 p-3 sm:grid-cols-3">
            <label className="block">
              <span className="mb-1 block text-[11px] font-bold uppercase tracking-wider text-slate-400">
                {job.roleA.emoji} {job.roleA.name}
              </span>
              <select
                value={modelA}
                onChange={(e) => setModelA(e.target.value)}
                className="w-full rounded-lg border border-white/10 bg-black/40 px-2 py-1.5 text-xs font-semibold text-white focus:border-cyan-500 focus:outline-none"
              >
                <option value="random">🧑‍💼 Workforce auto-assign</option>
                {textModels.map((m) => (
                  <option key={m.id} value={m.id}>{m.emoji} {m.name}</option>
                ))}
              </select>
            </label>
            <label className="block">
              <span className="mb-1 block text-[11px] font-bold uppercase tracking-wider text-slate-400">
                {job.roleB.emoji} {job.roleB.name}
              </span>
              <select
                value={modelB}
                onChange={(e) => setModelB(e.target.value)}
                className="w-full rounded-lg border border-white/10 bg-black/40 px-2 py-1.5 text-xs font-semibold text-white focus:border-cyan-500 focus:outline-none"
              >
                <option value="random">🧑‍💼 Workforce auto-assign</option>
                {textModels.map((m) => (
                  <option key={m.id} value={m.id}>{m.emoji} {m.name}</option>
                ))}
              </select>
            </label>
            <label className="block">
              <span className="mb-1 block text-[11px] font-bold uppercase tracking-wider text-slate-400">
                💎 Synthesizer
              </span>
              <select
                value={synthModel}
                onChange={(e) => setSynthModel(e.target.value)}
                className="w-full rounded-lg border border-white/10 bg-black/40 px-2 py-1.5 text-xs font-semibold text-white focus:border-cyan-500 focus:outline-none"
              >
                <option value="auto">🧑‍💼 Workforce auto-assign</option>
                {textModels.map((m) => (
                  <option key={m.id} value={m.id}>{m.emoji} {m.name}</option>
                ))}
              </select>
            </label>
          </div>

          <div className="mt-3 flex flex-wrap items-center gap-2">
            <button onClick={() => start()} disabled={running || !material.trim()} className="btn-arena rounded-xl px-6 py-2.5 text-sm font-extrabold text-white">
              {running ? `🧠 ${COUNCIL_STAGES[stage]?.label ?? "Convening"}…` : `🧠 Convene the ${job.name} Council`}
            </button>
            {run && !running && (
              <button
                onClick={() => {
                  setRun(null);
                  setArtifact(null);
                  setMaterial("");
                  setNotice(null);
                }}
                className="rounded-xl border border-white/10 bg-white/5 px-4 py-2.5 text-sm font-bold text-white hover:bg-white/10"
              >
                ＋ New material
              </button>
            )}
          </div>

          {running && (
            <div className="mt-3">
              <div className="flex gap-1.5">
                {COUNCIL_STAGES.map((s, i) => (
                  <div key={s.id} className="flex-1">
                    <div className={`h-1.5 overflow-hidden rounded-full ${i <= stage ? "bg-cyan-500/30" : "bg-white/5"}`}>
                      {i === stage && <div className="shimmer-bar h-full w-full" />}
                      {i < stage && <div className="h-full w-full bg-cyan-400" />}
                    </div>
                    <p className={`mt-1 text-center text-[10px] font-bold ${i <= stage ? "text-cyan-300" : "text-slate-500"}`}>
                      {s.label}
                    </p>
                  </div>
                ))}
              </div>
              <p className="mt-1.5 text-center text-xs text-slate-400">
                {COUNCIL_STAGES[stage]?.desc ?? "Creating the durable session and assembling the Council…"}
                {stage >= 0 ? " — disagreement in progress…" : ""}
                {sessionId ? <span className="ml-1 font-mono text-[10px] text-slate-600">{sessionId.slice(0, 8)}</span> : null}
              </p>
            </div>
          )}

          {handoffSource && (
            <p className="mt-2 rounded-lg border border-cyan-400/30 bg-cyan-400/10 px-3 py-1.5 text-[11px] font-bold text-cyan-200">
              🔁 Handoff from {handoffSource.replace(":", " ")} — project memory will be included when attached.
            </p>
          )}
          <div className="mt-3 flex flex-wrap items-center gap-2 border-t border-white/5 pt-3">
            <PrivacyControls compact />
            <ProjectPicker value={projectId} onChange={setProjectId} />
            <span className="text-[11px] text-slate-500">
              {privacy.ephemeral
                ? "👻 Ephemeral: perspectives + synthesis vanish, nothing stored."
                : privacy.localMode || !privacy.online
                  ? "🔒 Local: council runs on-device, memory still saved."
                  : "2 minds · cross-critique · synthesis · artifact · never trained on"}
            </span>
          </div>
          {notice && <p className="mt-3 rounded-lg border border-emerald-400/30 bg-emerald-400/10 px-3 py-2 text-xs font-bold text-emerald-200">{notice}</p>}
          {error && <p className="mt-3 rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-sm text-red-300">⚠️ {error}</p>}
        </div>

        {run && (
          <div className="fade-up mt-5 space-y-4">
            {isEph && (
              <p className="text-center text-[11px] font-bold text-slate-400">
                👻 Ephemeral council — this run was never stored.
              </p>
            )}
            {/* Perspectives */}
            <div>
              <p className="mb-2 text-[11px] font-black uppercase tracking-wider text-slate-400">
                👁️ Perspectives — productive disagreement
              </p>
              <div className="grid items-start gap-3 md:grid-cols-2">
                {[
                  { label: run.roleALabel, body: run.perspectiveA },
                  { label: run.roleBLabel, body: run.perspectiveB },
                ].map((p, i) => (
                  <div key={i} className="glass overflow-hidden rounded-2xl">
                    <div className="border-b border-white/10 px-3 py-2.5">
                      <p className="truncate text-xs font-extrabold text-white">{p.label}</p>
                    </div>
                    <div className="scroll-thin max-h-80 overflow-y-auto p-3">
                      <Markdown text={p.body} />
                    </div>
                  </div>
                ))}
              </div>
            </div>

            {/* Cross-critiques */}
            <details className="glass rounded-2xl p-4">
              <summary className="cursor-pointer text-xs font-extrabold text-white">
                ⚔️ Cross-critiques — where each side concedes and sharpens
              </summary>
              <div className="mt-3 grid gap-2 md:grid-cols-2">
                {[
                  { label: `${run.roleALabel} critiques`, body: run.critiqueA },
                  { label: `${run.roleBLabel} critiques`, body: run.critiqueB },
                ].map((c, i) => (
                  <div key={i} className="rounded-xl bg-black/30 p-3 ring-1 ring-white/5">
                    <p className="text-[11px] font-extrabold text-slate-200">{c.label}</p>
                    <div className="scroll-thin mt-1 max-h-56 overflow-y-auto">
                      <Markdown text={c.body} />
                    </div>
                  </div>
                ))}
              </div>
            </details>

            {/* Synthesis */}
            <div className="overflow-hidden rounded-2xl border border-cyan-400/30 bg-gradient-to-b from-cyan-500/10 to-transparent">
              <div className="flex items-center gap-2.5 border-b border-cyan-400/20 px-4 py-3">
                <span className="grid h-9 w-9 place-items-center rounded-xl bg-gradient-to-br from-cyan-500 to-violet-500 text-lg">💎</span>
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-extrabold text-white">Higher-order synthesis</p>
                  <p className="text-[11px] text-slate-400">What survived scrutiny, merged into one best result</p>
                </div>
                <button onClick={() => copy("synth", run.synthesis)} className="rounded-lg bg-white/5 px-2.5 py-1.5 text-xs font-bold hover:bg-white/15">
                  {copied === "synth" ? "✓" : "📋"}
                </button>
              </div>
              <div className="scroll-thin max-h-[560px] overflow-y-auto p-5">
                <Markdown text={run.synthesis} />
              </div>
              {!run.ephemeral && (
                <div className="border-t border-cyan-400/20 p-3">
                  <HandoffButtons text={run.synthesis} projectId={projectId || run.projectId} sourceSessionId={run.sessionId} source={`council:${run.id}`} exclude={["council"]} />
                </div>
              )}
            </div>

            {/* Artifact */}
            {artifact && (
              <div className="overflow-hidden rounded-2xl border border-amber-400/30 bg-gradient-to-b from-amber-500/10 to-transparent">
                <div className="flex items-center gap-2.5 border-b border-amber-400/20 px-4 py-3">
                  <span className="grid h-9 w-9 place-items-center rounded-xl bg-gradient-to-br from-amber-500 to-orange-500 text-lg">📦</span>
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-extrabold text-white">{artifact.title}</p>
                    <p className="text-[11px] text-slate-400">Usable artifact · {artifact.kind}</p>
                  </div>
                  <div className="flex gap-1.5">
                    <button onClick={() => copy("art", artifact.body)} className="rounded-lg bg-white/5 px-2.5 py-1.5 text-xs font-bold hover:bg-white/15" title="Copy artifact">
                      {copied === "art" ? "✓" : "📋"}
                    </button>
                    <button onClick={downloadArtifact} className="rounded-lg bg-white/5 px-2.5 py-1.5 text-xs font-bold hover:bg-white/15" title="Download .md">
                      ⬇️
                    </button>
                    <button onClick={saveArtifactAsTemplate} disabled={savingTpl} className="rounded-lg bg-white/5 px-2.5 py-1.5 text-xs font-bold hover:bg-white/15" title="Save to template library">
                      {copied === "tpl" ? "✓" : "💾"}
                    </button>
                  </div>
                </div>
                <div className="scroll-thin max-h-[480px] overflow-y-auto p-5">
                  <Markdown text={artifact.body} />
                </div>
                {!run.ephemeral && (
                  <div className="border-t border-amber-400/20 p-3">
                    <HandoffButtons text={artifact.body} projectId={projectId || run.projectId} sourceSessionId={run.sessionId} source={`council:${run.id}`} exclude={["council"]} />
                  </div>
                )}
              </div>
            )}
          </div>
        )}
      </div>

      <aside className="min-w-0 space-y-4">
        <div className="rounded-2xl border border-cyan-400/25 bg-gradient-to-br from-cyan-500/15 to-violet-500/5 p-4">
          <p className="text-sm font-extrabold text-cyan-200">🧠 Why a council?</p>
          <p className="mt-1.5 text-xs leading-relaxed text-cyan-100/80">
            Battles ask <strong>which AI won</strong>. The council asks{" "}
            <strong>what cognitive job you&apos;re doing</strong> — then assembles disagreeing roles,
            cross-examines them, and forges the result into an artifact you can actually use.
          </p>
        </div>
        <div className="glass rounded-2xl p-4">
          <div className="flex items-center justify-between">
            <h3 className="text-sm font-extrabold text-white">{sideTab === "runs" ? "🕘 Council runs" : "📦 Artifact library"}</h3>
            <div className="flex overflow-hidden rounded-full ring-1 ring-white/10">
              <button onClick={() => setSideTab("runs")} className={`px-2.5 py-1 text-[11px] font-bold ${sideTab === "runs" ? "bg-cyan-500/25 text-cyan-200" : "text-slate-400"}`}>
                Runs
              </button>
              <button onClick={() => setSideTab("artifacts")} className={`px-2.5 py-1 text-[11px] font-bold ${sideTab === "artifacts" ? "bg-cyan-500/25 text-cyan-200" : "text-slate-400"}`}>
                Artifacts
              </button>
            </div>
          </div>
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder={sideTab === "runs" ? "🔍 Search material…" : "🔍 Search artifacts…"}
            className="mt-2 w-full rounded-lg border border-white/10 bg-black/40 px-3 py-1.5 text-xs text-white placeholder:text-slate-600 focus:border-cyan-500 focus:outline-none"
          />
          <div className="scroll-thin mt-2 max-h-80 space-y-2 overflow-y-auto">
            {sideTab === "runs" ? (
              <>
                {filteredHistory.map((h: any) => {
                  const j = getCognitiveJob(h.jobId);
                  return (
                    <div key={h.id} className="group relative rounded-lg bg-white/[0.03] p-2.5 ring-1 ring-white/5 hover:ring-cyan-500/40">
                      <button onClick={() => openRun(h.id)} className="block w-full text-left">
                        <p className="pr-6 text-[10px] font-black text-cyan-300">{j.emoji} {j.name}</p>
                        <p className="mt-0.5 line-clamp-2 text-xs font-semibold text-slate-200">{h.material}</p>
                        <p className="mt-1 text-[11px] text-slate-500">
                          {h.createdAt ? new Date(h.createdAt).toLocaleString() : ""}
                        </p>
                      </button>
                      <button
                        onClick={() => deleteRun(h.id)}
                        title="Delete (right to erasure)"
                        className="absolute right-1.5 top-1.5 hidden rounded px-1.5 py-0.5 text-[11px] text-slate-500 hover:bg-red-500/20 hover:text-red-300 group-hover:block"
                      >
                        ✕
                      </button>
                    </div>
                  );
                })}
                {filteredHistory.length === 0 && <p className="text-xs text-slate-500">No runs yet — convene your first council.</p>}
              </>
            ) : (
              <>
                {filteredArtifacts.map((a: any) => (
                  <div key={a.id} className="rounded-lg bg-white/[0.03] p-2.5 ring-1 ring-white/5">
                    <p className="text-[10px] font-black text-amber-300">📦 {a.kind}</p>
                    <p className="mt-0.5 line-clamp-1 text-xs font-bold text-slate-200">{a.title}</p>
                    <p className="mt-0.5 line-clamp-2 text-[11px] text-slate-400">{a.body.slice(0, 140)}</p>
                    <div className="mt-1.5 flex gap-1.5">
                      <button onClick={() => copy(a.id, a.body)} className="rounded bg-white/5 px-2 py-1 text-[10px] font-bold hover:bg-white/15">
                        {copied === a.id ? "✓ Copied" : "📋 Copy"}
                      </button>
                      <button onClick={() => openRun(a.runId)} className="rounded bg-white/5 px-2 py-1 text-[10px] font-bold hover:bg-white/15">
                        🧠 Open run
                      </button>
                    </div>
                  </div>
                ))}
                {filteredArtifacts.length === 0 && <p className="text-xs text-slate-500">No artifacts yet — they appear here after each run.</p>}
              </>
            )}
          </div>
        </div>
      </aside>
    </div>
  );
}
