"use client";

// Collaboration Orchestrator — structured multi-participant AI collaboration.
//
// A session holds a goal, shared context, and participants (arena models,
// external OpenAI-compatible AIs, the human owner). Work moves through
// explicit relays — source → target with purpose, request, privacy
// classification, and a response contract. Advance performs one step:
// dispatch to a model/external participant, or surface a human checkpoint.
// The conductor (auto-route) can propose the next relay when a working model
// is available; offline it declines honestly.

import { useCallback, useEffect, useState } from "react";
import Markdown from "@/components/Markdown";
import { loadKeys } from "@/components/KeysBar";
import { privacyFlags } from "@/lib/privacyClient";
import type { Collaboration, Participant, Relay } from "@/lib/orchestrator";

interface ModelInfo {
  id: string;
  name: string;
  emoji: string;
  kind: string;
}

interface ParticipantDraft {
  name: string;
  kind: "model" | "human" | "external";
  modelId: string;
  adapterUrl: string;
  adapterModel: string;
  capabilities: string;
  trust: "internal" | "external";
}

interface PreferenceView {
  id: string;
  content: string;
  kind: string;
  classification: string;
  source: string;
}

// The perspectives roster: every participant assumes a different lens, all
// deliberating in the owner's best interest. The Steward guards boundaries
// and holds tool access.
const DELIBERATION_PRESET: ParticipantDraft[] = [
  { name: "Visionary", kind: "model", modelId: "openai", adapterUrl: "", adapterModel: "", capabilities: "expansion, possibilities, bold directions", trust: "internal" },
  { name: "Pragmatist", kind: "model", modelId: "openai", adapterUrl: "", adapterModel: "", capabilities: "feasibility, execution, cost", trust: "internal" },
  { name: "Skeptic", kind: "model", modelId: "openai", adapterUrl: "", adapterModel: "", capabilities: "risk, adversarial review", trust: "internal" },
  { name: "Steward", kind: "model", modelId: "openai", adapterUrl: "", adapterModel: "", capabilities: "owner interest, boundaries, tool_use", trust: "internal" },
  { name: "Owner", kind: "human", modelId: "openai", adapterUrl: "", adapterModel: "", capabilities: "decisions, approvals", trust: "internal" },
];

const KIND_EMOJI: Record<string, string> = { model: "🤖", human: "🧑", external: "🛰️" };
const CLASSIFICATION_STYLE: Record<string, string> = {
  public: "bg-emerald-400/10 text-emerald-200 ring-emerald-400/20",
  internal: "bg-cyan-400/10 text-cyan-200 ring-cyan-400/20",
  private: "bg-rose-400/10 text-rose-200 ring-rose-400/20",
};
const STATUS_STYLE: Record<string, string> = {
  pending: "bg-amber-400/10 text-amber-200 ring-amber-400/20",
  responded: "bg-emerald-400/10 text-emerald-200 ring-emerald-400/20",
  cancelled: "bg-slate-400/10 text-slate-300 ring-slate-400/20",
  failed: "bg-rose-400/10 text-rose-200 ring-rose-400/20",
  running: "bg-emerald-400/10 text-emerald-200 ring-emerald-400/20",
  blocked: "bg-amber-400/10 text-amber-200 ring-amber-400/20",
  closed: "bg-slate-400/10 text-slate-300 ring-slate-400/20",
};

function Badge({ text, style }: { text: string; style: string }) {
  return <span className={`rounded-full px-2 py-0.5 text-[9px] font-black uppercase tracking-wide ring-1 ${style}`}>{text}</span>;
}

export default function OrchestratorWorkbench() {
  const [collabs, setCollabs] = useState<Collaboration[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<Collaboration | null>(null);
  const [models, setModels] = useState<ModelInfo[]>([]);
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);

  // ---- create form ----
  const [title, setTitle] = useState("");
  const [goal, setGoal] = useState("");
  const [context, setContext] = useState("");
  const [autoRoute, setAutoRoute] = useState(false);
  const [participants, setParticipants] = useState<ParticipantDraft[]>([
    { name: "Architect", kind: "model", modelId: "openai", adapterUrl: "", adapterModel: "", capabilities: "architecture, planning", trust: "internal" },
    { name: "Critic", kind: "model", modelId: "openai", adapterUrl: "", adapterModel: "", capabilities: "adversarial review", trust: "internal" },
    { name: "Owner", kind: "human", modelId: "openai", adapterUrl: "", adapterModel: "", capabilities: "decisions, approvals", trust: "internal" },
  ]);
  const [relayTarget, setRelayTarget] = useState("architect");
  const [relayPurpose, setRelayPurpose] = useState("draft");
  const [relayRequest, setRelayRequest] = useState("");
  const [relayClassification, setRelayClassification] = useState("internal");
  const [relayContract, setRelayContract] = useState("markdown text");

  // ---- add-relay form (in detail) ----
  const [nextTarget, setNextTarget] = useState("");
  const [nextPurpose, setNextPurpose] = useState("contribute");
  const [nextRequest, setNextRequest] = useState("");
  const [nextClassification, setNextClassification] = useState("internal");

  // ---- checkpoint ----
  const [checkpointText, setCheckpointText] = useState("");

  // ---- preferences ----
  const [prefs, setPrefs] = useState<PreferenceView[]>([]);
  const [prefText, setPrefText] = useState("");
  const [prefKind, setPrefKind] = useState("preference");
  const [prefClass, setPrefClass] = useState("internal");

  // ---- deliberation preset ----
  const [preset, setPreset] = useState<"deliberation" | "custom">("deliberation");

  // ---- tool relay ----
  const [nextToolUse, setNextToolUse] = useState(false);

  const textModels = models.filter((m) => m.kind === "text");

  const refreshList = useCallback(async () => {
    try {
      const res = await fetch("/api/orchestrator");
      const data = await res.json();
      if (Array.isArray(data.collaborations)) setCollabs(data.collaborations);
    } catch {
      /* offline */
    }
  }, []);

  const loadDetail = useCallback(async (id: string) => {
    try {
      const res = await fetch(`/api/orchestrator/${id}`);
      if (!res.ok) {
        setDetail(null);
        return;
      }
      const data = await res.json();
      setDetail(data.collaboration);
    } catch {
      /* offline */
    }
  }, []);

  useEffect(() => {
    void (async () => {
      await Promise.resolve();
      void refreshList();
      try {
        const res = await fetch("/api/models");
        const data = await res.json();
        if (Array.isArray(data.models)) setModels(data.models);
      } catch {
        /* offline */
      }
      try {
        const res = await fetch("/api/preferences");
        const data = await res.json();
        if (Array.isArray(data.preferences)) setPrefs(data.preferences);
      } catch {
        /* offline */
      }
    })();
  }, [refreshList]);

  useEffect(() => {
    void (async () => {
      await Promise.resolve();
      if (selectedId) await loadDetail(selectedId);
      else setDetail(null);
    })();
  }, [selectedId, loadDetail]);

  function updateParticipant(index: number, patch: Partial<ParticipantDraft>) {
    setParticipants((current) => current.map((p, i) => (i === index ? { ...p, ...patch } : p)));
  }

  function applyPreset(next: "deliberation" | "custom") {
    setPreset(next);
    if (next === "deliberation") {
      setParticipants(DELIBERATION_PRESET.map((p) => ({ ...p })));
      setRelayTarget("visionary");
    }
  }

  async function savePreference() {
    if (!prefText.trim() || busy) return;
    setBusy(true);
    try {
      const res = await fetch("/api/preferences", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content: prefText.trim(), kind: prefKind, classification: prefClass }),
      });
      const data = await res.json();
      if (res.ok) {
        setPrefText("");
        const listed = await fetch("/api/preferences").then((r) => r.json());
        if (Array.isArray(listed.preferences)) setPrefs(listed.preferences);
        setNotice(`Remembered (${prefKind}).`);
      } else setNotice(data.error ?? "failed to save preference");
    } catch {
      setNotice("network error");
    } finally {
      setBusy(false);
    }
  }

  async function forgetPreference(id: string) {
    try {
      await fetch(`/api/preferences/${id}`, { method: "DELETE" });
      setPrefs((current) => current.filter((p) => p.id !== id));
    } catch {
      /* offline */
    }
  }

  async function deliberateRound() {
    if (!detail || busy) return;
    setBusy(true);
    try {
      const res = await fetch(`/api/orchestrator/${detail.id}/deliberate`, { method: "POST" });
      const data = await res.json();
      if (res.ok) {
        setDetail(data.collaboration);
        setNotice("Deliberation round queued — Advance to run it.");
      } else setNotice(data.error ?? "failed to queue deliberation");
      void refreshList();
    } catch {
      setNotice("network error");
    } finally {
      setBusy(false);
    }
  }

  async function create() {
    if (!goal.trim() || busy) return;
    setBusy(true);
    setNotice("");
    try {
      const res = await fetch("/api/orchestrator", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title: title.trim() || undefined,
          goal: goal.trim(),
          context: context.trim() || undefined,
          autoRoute,
          participants: participants.map((p) => ({
            name: p.name.trim() || p.kind,
            kind: p.kind,
            modelId: p.kind === "model" ? p.modelId : undefined,
            adapterUrl: p.kind === "external" ? p.adapterUrl.trim() || undefined : undefined,
            adapterModel: p.kind === "external" ? p.adapterModel.trim() || undefined : undefined,
            capabilities: p.capabilities.split(",").map((c) => c.trim()).filter(Boolean),
            trust: p.trust,
          })),
          relay: relayRequest.trim()
            ? {
                target: relayTarget,
                purpose: relayPurpose.trim() || "contribute",
                request: relayRequest.trim(),
                classification: relayClassification,
                responseContract: relayContract.trim() || "markdown text",
              }
            : undefined,
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        setNotice(data.error ?? "failed to create");
        return;
      }
      setGoal("");
      setTitle("");
      setContext("");
      setRelayRequest("");
      setNotice("Collaboration opened.");
      await refreshList();
      setSelectedId(data.collaboration.id);
    } catch {
      setNotice("network error");
    } finally {
      setBusy(false);
    }
  }

  async function advance() {
    if (!detail || busy) return;
    setBusy(true);
    try {
      const res = await fetch(`/api/orchestrator/${detail.id}/advance`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ keys: loadKeys(), localOnly: privacyFlags().localOnly }),
      });
      const data = await res.json();
      if (res.ok) {
        setDetail(data.collaboration);
        setNotice(data.note ?? "");
      } else {
        setNotice(data.error ?? "advance failed");
      }
      void refreshList();
    } catch {
      setNotice("network error");
    } finally {
      setBusy(false);
    }
  }

  async function close() {
    if (!detail || busy) return;
    setBusy(true);
    try {
      const res = await fetch(`/api/orchestrator/${detail.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: "closed" }),
      });
      const data = await res.json();
      if (res.ok) {
        setDetail(data.collaboration);
        setNotice("Closed — the collaboration record was filed as an artifact.");
      } else setNotice(data.error ?? "close failed");
      void refreshList();
    } finally {
      setBusy(false);
    }
  }

  async function addRelay() {
    if (!detail || !nextRequest.trim() || busy) return;
    setBusy(true);
    try {
      const res = await fetch(`/api/orchestrator/${detail.id}/relays`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          target: nextTarget,
          purpose: nextPurpose.trim() || "contribute",
          request: nextRequest.trim(),
          classification: nextClassification,
          toolUse: nextToolUse,
        }),
      });
      const data = await res.json();
      if (res.ok) {
        setNextRequest("");
        setNotice(`Relay #${data.relay.seq} queued.`);
        await loadDetail(detail.id);
      } else setNotice(data.error ?? "failed to add relay");
    } finally {
      setBusy(false);
    }
  }

  async function respond(relay: Relay, rejected: boolean) {
    if (busy) return;
    setBusy(true);
    try {
      const res = await fetch(`/api/orchestrator/relays/${relay.id}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ response: checkpointText.trim() || undefined, rejected }),
      });
      const data = await res.json();
      if (res.ok) {
        setCheckpointText("");
        setNotice(rejected ? "Relay rejected." : "Checkpoint answered.");
        if (detail) await loadDetail(detail.id);
      } else setNotice(data.error ?? "failed to respond");
    } finally {
      setBusy(false);
    }
  }

  const participantByKey = (key: string): Participant | undefined => detail?.participants.find((p) => p.key === key);
  const pendingCheckpoint = detail?.relays.find(
    (r) => r.status === "pending" && participantByKey(r.targetKey)?.kind === "human"
  );

  return (
    <div className="mx-auto max-w-7xl px-4 py-8">
      {/* ---- header ---- */}
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-black tracking-tight text-white">🎼 Collaboration Orchestrator</h1>
          <p className="mt-1 max-w-2xl text-sm text-slate-400">
            Structured multi-participant collaboration — models, external AIs, and you, connected by explicit relays
            with privacy classification and response contracts. No more ferrying messages between AIs by hand.
          </p>
        </div>
        {notice && <span className="text-xs text-cyan-200">{notice}</span>}
      </div>

      <div className="mt-6 grid gap-5 lg:grid-cols-[360px_1fr]">
        {/* ---- left: create + list ---- */}
        <div className="space-y-5">
          <div className="glass rounded-2xl p-4">
            <h2 className="text-sm font-extrabold text-white">➕ New collaboration</h2>

            <div className="mt-3 flex gap-1.5">
              {(["deliberation", "custom"] as const).map((presetId) => (
                <button
                  key={presetId}
                  onClick={() => applyPreset(presetId)}
                  className={`flex-1 rounded-xl px-2.5 py-1.5 text-[11px] font-bold ring-1 transition ${
                    preset === presetId
                      ? "bg-violet-400/15 text-violet-100 ring-violet-400/40"
                      : "bg-white/5 text-slate-300 ring-white/10 hover:bg-white/10"
                  }`}
                >
                  {presetId === "deliberation" ? "🎯 Perspectives preset" : "🧩 Custom roster"}
                </button>
              ))}
            </div>

            <label className="mt-3 block">
              <span className="text-xs font-bold uppercase tracking-wider text-slate-400">Goal</span>
              <textarea
                value={goal}
                onChange={(e) => setGoal(e.target.value)}
                rows={2}
                placeholder="e.g. Design the archive naming convention and pressure-test it"
                className="mt-1.5 w-full rounded-xl border border-white/10 bg-black/40 px-3 py-2 text-sm text-white outline-none focus:border-cyan-400/60"
              />
            </label>
            <label className="mt-2 block">
              <span className="text-xs font-bold uppercase tracking-wider text-slate-400">Shared context (optional)</span>
              <textarea
                value={context}
                onChange={(e) => setContext(e.target.value)}
                rows={2}
                placeholder="constraints, links, prior decisions…"
                className="mt-1.5 w-full rounded-xl border border-white/10 bg-black/40 px-3 py-2 text-xs text-white outline-none focus:border-cyan-400/60"
              />
            </label>

            <div className="mt-3 space-y-2">
              <div className="flex items-center justify-between">
                <span className="text-xs font-bold uppercase tracking-wider text-slate-400">Participants</span>
                <button
                  onClick={() =>
                    setParticipants((c) => [...c, { name: "", kind: "model", modelId: "openai", adapterUrl: "", adapterModel: "", capabilities: "", trust: "internal" }])
                  }
                  className="rounded-lg bg-white/5 px-2 py-1 text-[10px] font-bold text-slate-300 ring-1 ring-white/10 hover:bg-white/10"
                >
                  + add
                </button>
              </div>
              {participants.map((p, i) => (
                <div key={i} className="rounded-xl bg-black/30 p-2.5">
                  <div className="flex gap-1.5">
                    <input
                      value={p.name}
                      onChange={(e) => updateParticipant(i, { name: e.target.value })}
                      placeholder="name"
                      className="w-24 rounded-lg border border-white/10 bg-black/40 px-2 py-1 text-[11px] text-white outline-none"
                    />
                    <select
                      value={p.kind}
                      onChange={(e) => updateParticipant(i, { kind: e.target.value as ParticipantDraft["kind"] })}
                      className="rounded-lg border border-white/10 bg-black/40 px-1.5 py-1 text-[11px] text-white outline-none"
                    >
                      <option value="model">model</option>
                      <option value="human">human</option>
                      <option value="external">external</option>
                    </select>
                    <select
                      value={p.trust}
                      onChange={(e) => updateParticipant(i, { trust: e.target.value as ParticipantDraft["trust"] })}
                      className="rounded-lg border border-white/10 bg-black/40 px-1.5 py-1 text-[11px] text-white outline-none"
                    >
                      <option value="internal">internal</option>
                      <option value="external">external</option>
                    </select>
                    {participants.length > 1 && (
                      <button
                        onClick={() => setParticipants((c) => c.filter((_, j) => j !== i))}
                        className="ml-auto rounded-lg bg-rose-500/15 px-2 py-1 text-[10px] font-bold text-rose-200 hover:bg-rose-500/25"
                      >
                        ✕
                      </button>
                    )}
                  </div>
                  {p.kind === "model" && (
                    <select
                      value={p.modelId}
                      onChange={(e) => updateParticipant(i, { modelId: e.target.value })}
                      className="mt-1.5 w-full rounded-lg border border-white/10 bg-black/40 px-2 py-1 text-[11px] text-white outline-none"
                    >
                      {textModels.length === 0 && <option value="openai">openai</option>}
                      {textModels.map((m) => (
                        <option key={m.id} value={m.id}>
                          {m.emoji} {m.name}
                        </option>
                      ))}
                    </select>
                  )}
                  {p.kind === "external" && (
                    <div className="mt-1.5 grid grid-cols-2 gap-1.5">
                      <input
                        value={p.adapterUrl}
                        onChange={(e) => updateParticipant(i, { adapterUrl: e.target.value })}
                        placeholder="http://127.0.0.1:8000"
                        className="rounded-lg border border-white/10 bg-black/40 px-2 py-1 text-[11px] text-white outline-none"
                      />
                      <input
                        value={p.adapterModel}
                        onChange={(e) => updateParticipant(i, { adapterModel: e.target.value })}
                        placeholder="model name"
                        className="rounded-lg border border-white/10 bg-black/40 px-2 py-1 text-[11px] text-white outline-none"
                      />
                    </div>
                  )}
                  <input
                    value={p.capabilities}
                    onChange={(e) => updateParticipant(i, { capabilities: e.target.value })}
                    placeholder="capabilities, comma separated"
                    className="mt-1.5 w-full rounded-lg border border-white/10 bg-black/40 px-2 py-1 text-[11px] text-white outline-none"
                  />
                </div>
              ))}
            </div>

            <div className="mt-3 rounded-xl bg-black/30 p-2.5">
              <div className="text-[10px] font-bold uppercase tracking-wider text-slate-500">Initial relay</div>
              <div className="mt-1.5 flex gap-1.5">
                <select
                  value={relayTarget}
                  onChange={(e) => setRelayTarget(e.target.value)}
                  className="flex-1 rounded-lg border border-white/10 bg-black/40 px-2 py-1 text-[11px] text-white outline-none"
                >
                  {participants
                    .filter((p) => p.kind !== "human")
                    .map((p) => (
                      <option key={p.name} value={p.name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "participant"}>
                        → {p.name || "participant"}
                      </option>
                    ))}
                </select>
                <input
                  value={relayPurpose}
                  onChange={(e) => setRelayPurpose(e.target.value)}
                  placeholder="purpose"
                  className="w-24 rounded-lg border border-white/10 bg-black/40 px-2 py-1 text-[11px] text-white outline-none"
                />
              </div>
              <textarea
                value={relayRequest}
                onChange={(e) => setRelayRequest(e.target.value)}
                rows={2}
                placeholder="the request — what should this participant do first?"
                className="mt-1.5 w-full rounded-lg border border-white/10 bg-black/40 px-2 py-1.5 text-[11px] text-white outline-none"
              />
              <div className="mt-1.5 flex items-center gap-1.5">
                <select
                  value={relayClassification}
                  onChange={(e) => setRelayClassification(e.target.value)}
                  className="rounded-lg border border-white/10 bg-black/40 px-1.5 py-1 text-[10px] text-white outline-none"
                >
                  <option value="public">public</option>
                  <option value="internal">internal</option>
                  <option value="private">private</option>
                </select>
                <input
                  value={relayContract}
                  onChange={(e) => setRelayContract(e.target.value)}
                  placeholder="response contract"
                  className="flex-1 rounded-lg border border-white/10 bg-black/40 px-2 py-1 text-[10px] text-white outline-none"
                />
              </div>
            </div>

            <label className="mt-3 flex items-center gap-2 text-[11px] text-slate-300">
              <input type="checkbox" checked={autoRoute} onChange={(e) => setAutoRoute(e.target.checked)} className="h-3.5 w-3.5 accent-cyan-400" />
              conductor auto-routing (a model decides the next relay when idle)
            </label>

            <button
              onClick={() => void create()}
              disabled={busy || !goal.trim()}
              className="mt-3 w-full rounded-xl bg-cyan-500 px-4 py-2.5 text-sm font-black text-black transition hover:bg-cyan-400 disabled:opacity-40"
            >
              Open collaboration
            </button>
          </div>

          {/* session list */}
          <div className="glass rounded-2xl p-4">
            <h2 className="text-sm font-extrabold text-white">Sessions</h2>
            <div className="mt-2 space-y-1.5">
              {collabs.length === 0 && <p className="px-1 py-3 text-xs text-slate-500">No collaborations yet.</p>}
              {collabs.map((c) => (
                <button
                  key={c.id}
                  onClick={() => setSelectedId(c.id)}
                  className={`w-full rounded-xl px-3 py-2 text-left ring-1 transition ${
                    selectedId === c.id
                      ? "bg-cyan-400/15 ring-cyan-400/40"
                      : "bg-white/5 ring-white/10 hover:bg-white/10"
                  }`}
                >
                  <div className="flex items-center justify-between gap-2">
                    <span className="truncate text-xs font-bold text-white">{c.title}</span>
                    <Badge text={c.status} style={STATUS_STYLE[c.status] ?? STATUS_STYLE.running} />
                  </div>
                  <div className="mt-0.5 truncate text-[10px] text-slate-400">
                    {c.participants.length} participants · {c.relays.length} relays
                  </div>
                </button>
              ))}
            </div>
          </div>

          {/* preferences & boundaries */}
          <div className="glass rounded-2xl p-4">
            <h2 className="text-sm font-extrabold text-white">🧠 Preferences & boundaries</h2>
            <p className="mt-1 text-[10px] leading-4 text-slate-500">
              Standing guidance every AI participant refers back to. Boundaries are hard limits — relays and tools never overstep them.
            </p>
            <div className="mt-2 space-y-1.5">
              {prefs.length === 0 && (
                <p className="px-1 py-2 text-[11px] text-slate-500">
                  Nothing stored yet. Tell the Archive Assistant “remember that…”, or add one below.
                </p>
              )}
              {prefs.map((pref) => (
                <div key={pref.id} className="rounded-xl bg-white/5 px-2.5 py-2 ring-1 ring-white/10">
                  <div className="flex items-start justify-between gap-2">
                    <p className="line-clamp-2 text-[11px] leading-4 text-slate-300">{pref.content}</p>
                    <button
                      onClick={() => void forgetPreference(pref.id)}
                      className="shrink-0 rounded bg-rose-500/15 px-1.5 py-0.5 text-[9px] font-black text-rose-200 hover:bg-rose-500/25"
                    >
                      ✕
                    </button>
                  </div>
                  <div className="mt-1 flex gap-1 text-[8px] font-black uppercase">
                    <span
                      className={`rounded px-1 py-0.5 ${
                        pref.kind === "boundary"
                          ? "bg-rose-400/10 text-rose-200"
                          : pref.kind === "goal"
                            ? "bg-emerald-400/10 text-emerald-200"
                            : "bg-cyan-400/10 text-cyan-200"
                      }`}
                    >
                      {pref.kind}
                    </span>
                    <span className="rounded bg-white/5 px-1 py-0.5 text-slate-400">{pref.classification}</span>
                    {pref.source === "assistant" && (
                      <span className="rounded bg-violet-400/10 px-1 py-0.5 text-violet-200">via assistant</span>
                    )}
                  </div>
                </div>
              ))}
            </div>
            <div className="mt-2.5 rounded-xl bg-black/30 p-2.5">
              <textarea
                value={prefText}
                onChange={(e) => setPrefText(e.target.value)}
                rows={2}
                placeholder="e.g. never auto-post anything; prefer concise answers"
                className="w-full rounded-lg border border-white/10 bg-black/40 px-2.5 py-1.5 text-[11px] text-white outline-none focus:border-cyan-400/60"
              />
              <div className="mt-1.5 flex gap-1.5">
                <select
                  value={prefKind}
                  onChange={(e) => setPrefKind(e.target.value)}
                  className="rounded-lg border border-white/10 bg-black/40 px-1.5 py-1 text-[10px] text-white outline-none"
                >
                  <option value="preference">preference</option>
                  <option value="boundary">boundary</option>
                  <option value="goal">goal</option>
                </select>
                <select
                  value={prefClass}
                  onChange={(e) => setPrefClass(e.target.value)}
                  className="rounded-lg border border-white/10 bg-black/40 px-1.5 py-1 text-[10px] text-white outline-none"
                >
                  <option value="public">public</option>
                  <option value="internal">internal</option>
                  <option value="private">private</option>
                </select>
                <button
                  onClick={() => void savePreference()}
                  disabled={busy || !prefText.trim()}
                  className="ml-auto rounded-lg bg-cyan-500 px-2.5 py-1 text-[10px] font-black text-black hover:bg-cyan-400 disabled:opacity-40"
                >
                  Remember
                </button>
              </div>
            </div>
          </div>
        </div>

        {/* ---- right: session detail ---- */}
        <div className="glass min-h-[520px] rounded-2xl p-5">
          {!detail ? (
            <div className="flex h-full items-center justify-center px-6 py-16 text-center text-sm text-slate-500">
              Open a session to see its relay timeline — or create one with a goal, participants, and an initial relay.
            </div>
          ) : (
            <>
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="min-w-0">
                  <h2 className="truncate text-lg font-extrabold text-white">{detail.title}</h2>
                  <p className="mt-1 max-w-2xl text-xs leading-5 text-slate-400">{detail.goal}</p>
                  <div className="mt-2 flex flex-wrap gap-1.5">
                    <Badge text={detail.status} style={STATUS_STYLE[detail.status] ?? STATUS_STYLE.running} />
                    {detail.autoRoute && <Badge text="auto-route" style="bg-violet-400/10 text-violet-200 ring-violet-400/20" />}
                    {detail.participants.map((p) => (
                      <span
                        key={p.id}
                        title={`${p.kind}${p.modelId ? ` · ${p.modelId}` : ""}${p.trust === "external" ? " · external trust" : ""}`}
                        className="rounded-full bg-white/5 px-2 py-0.5 text-[10px] font-bold text-slate-300 ring-1 ring-white/10"
                      >
                        {p.emoji} {p.name}
                      </span>
                    ))}
                  </div>
                </div>
                <div className="flex gap-2">
                  <button
                    onClick={() => void advance()}
                    disabled={busy || detail.status === "closed"}
                    className="rounded-xl bg-cyan-500 px-4 py-2 text-xs font-black text-black transition hover:bg-cyan-400 disabled:opacity-40"
                  >
                    {busy ? "…" : "▶ Advance"}
                  </button>
                  <button
                    onClick={() => void deliberateRound()}
                    disabled={busy || detail.status === "closed"}
                    title="Queue a perspective relay to every participant, then a synthesis relay"
                    className="rounded-xl bg-violet-500/20 px-3 py-2 text-xs font-black text-violet-100 ring-1 ring-violet-400/30 transition hover:bg-violet-500/30 disabled:opacity-40"
                  >
                    🎯 Round
                  </button>
                  <button
                    onClick={() => void close()}
                    disabled={busy || detail.status === "closed"}
                    className="rounded-xl bg-white/5 px-3 py-2 text-xs font-bold text-slate-300 ring-1 ring-white/10 hover:bg-white/10 disabled:opacity-40"
                  >
                    ■ Close
                  </button>
                </div>
              </div>

              {/* checkpoint banner */}
              {pendingCheckpoint && (
                <div className="mt-4 rounded-2xl border border-amber-400/30 bg-amber-400/5 p-4" data-testid="checkpoint-card">
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-extrabold text-amber-200">⏸ Checkpoint — relay #{pendingCheckpoint.seq} is waiting for you</span>
                    <Badge text={pendingCheckpoint.classification} style={CLASSIFICATION_STYLE[pendingCheckpoint.classification]} />
                  </div>
                  <p className="mt-1.5 whitespace-pre-wrap text-xs leading-5 text-slate-300">{pendingCheckpoint.request}</p>
                  <textarea
                    value={checkpointText}
                    onChange={(e) => setCheckpointText(e.target.value)}
                    rows={2}
                    placeholder="your answer (optional) — otherwise approval is recorded as-is"
                    className="mt-2 w-full rounded-xl border border-white/10 bg-black/40 px-3 py-2 text-xs text-white outline-none focus:border-amber-400/60"
                  />
                  <div className="mt-2 flex gap-2">
                    <button
                      onClick={() => void respond(pendingCheckpoint, false)}
                      disabled={busy}
                      className="rounded-xl bg-emerald-500 px-4 py-1.5 text-xs font-black text-black hover:bg-emerald-400 disabled:opacity-40"
                    >
                      ✓ Approve / answer
                    </button>
                    <button
                      onClick={() => void respond(pendingCheckpoint, true)}
                      disabled={busy}
                      className="rounded-xl bg-rose-500/20 px-4 py-1.5 text-xs font-black text-rose-200 hover:bg-rose-500/30 disabled:opacity-40"
                    >
                      ✕ Reject
                    </button>
                  </div>
                </div>
              )}

              {/* relay timeline */}
              <div className="mt-4 space-y-2.5">
                {detail.relays.length === 0 && (
                  <p className="px-1 py-6 text-center text-xs text-slate-500">No relays yet — add the first one below.</p>
                )}
                {detail.relays.map((r) => {
                  const target = participantByKey(r.targetKey);
                  const isCheckpoint = r.status === "pending" && target?.kind === "human";
                  return (
                    <div key={r.id} className="rounded-2xl bg-white/5 p-3.5 ring-1 ring-white/10">
                      <div className="flex flex-wrap items-center gap-2 text-[11px]">
                        <span className="font-mono font-bold text-slate-500">#{r.seq}</span>
                        <span className="font-bold text-cyan-200">{r.sourceKey}</span>
                        <span className="text-slate-500">➜</span>
                        <span className="font-bold text-cyan-200">
                          {target ? `${target.emoji} ${target.name}` : r.targetKey}
                        </span>
                        <span className="rounded bg-white/5 px-1.5 py-0.5 font-mono text-[10px] text-slate-400">{r.purpose}</span>
                        <Badge text={r.classification} style={CLASSIFICATION_STYLE[r.classification]} />
                        <Badge text={r.status} style={STATUS_STYLE[r.status] ?? STATUS_STYLE.pending} />
                        {r.via && <span className="font-mono text-[9px] text-slate-500">via {r.via}</span>}
                      </div>
                      <div className="mt-2 whitespace-pre-wrap text-xs leading-5 text-slate-300">{r.request}</div>
                      {r.response && (
                        <div className="mt-2 rounded-xl bg-black/30 p-3 text-xs leading-5 text-slate-200">
                          <Markdown text={r.response.slice(0, 4000)} />
                        </div>
                      )}
                      {r.steps.length > 0 && (
                        <div className="mt-2 flex flex-wrap gap-1">
                          {r.steps.map((step, i) => (
                            <span
                              key={i}
                              title={step.summary}
                              className={`rounded-full px-1.5 py-0.5 font-mono text-[9px] font-bold ring-1 ${
                                step.ok
                                  ? "bg-cyan-400/10 text-cyan-200 ring-cyan-400/20"
                                  : "bg-rose-400/10 text-rose-200 ring-rose-400/20"
                              }`}
                            >
                              🔧 {step.tool} {step.ok ? "✓" : "✗"} {step.ms}ms
                            </span>
                          ))}
                        </div>
                      )}
                      {r.note && <div className="mt-2 text-[11px] italic text-rose-300">{r.note}</div>}
                      {isCheckpoint && (
                        <div className="mt-1.5 text-[10px] font-bold uppercase tracking-wide text-amber-200">
                          ↑ answer this checkpoint in the banner above
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>

              {/* add relay */}
              {detail.status !== "closed" && (
                <div className="mt-4 rounded-2xl bg-black/30 p-3">
                  <div className="text-[10px] font-bold uppercase tracking-wider text-slate-500">Add relay (manual routing)</div>
                  <div className="mt-1.5 flex flex-wrap gap-1.5">
                    <select
                      value={nextTarget}
                      onChange={(e) => setNextTarget(e.target.value)}
                      className="rounded-lg border border-white/10 bg-black/40 px-2 py-1.5 text-[11px] text-white outline-none"
                    >
                      <option value="">target…</option>
                      {detail.participants.map((p) => (
                        <option key={p.id} value={p.key}>
                          {p.emoji} {p.name} ({p.kind})
                        </option>
                      ))}
                    </select>
                    <input
                      value={nextPurpose}
                      onChange={(e) => setNextPurpose(e.target.value)}
                      placeholder="purpose"
                      className="w-28 rounded-lg border border-white/10 bg-black/40 px-2 py-1.5 text-[11px] text-white outline-none"
                    />
                    <select
                      value={nextClassification}
                      onChange={(e) => setNextClassification(e.target.value)}
                      className="rounded-lg border border-white/10 bg-black/40 px-1.5 py-1.5 text-[11px] text-white outline-none"
                    >
                      <option value="public">public</option>
                      <option value="internal">internal</option>
                      <option value="private">private</option>
                    </select>
                    <label className="flex items-center gap-1.5 text-[10px] font-bold text-slate-400">
                      <input
                        type="checkbox"
                        checked={nextToolUse}
                        onChange={(e) => setNextToolUse(e.target.checked)}
                        className="h-3 w-3 accent-cyan-400"
                      />
                      🔧 tool-use (target needs tool_use)
                    </label>
                  </div>
                  <textarea
                    value={nextRequest}
                    onChange={(e) => setNextRequest(e.target.value)}
                    rows={2}
                    placeholder="request — what should this participant do?"
                    className="mt-1.5 w-full rounded-lg border border-white/10 bg-black/40 px-2.5 py-2 text-[11px] text-white outline-none"
                  />
                  <button
                    onClick={() => void addRelay()}
                    disabled={busy || !nextTarget || !nextRequest.trim()}
                    className="mt-1.5 rounded-lg bg-cyan-500/20 px-3 py-1.5 text-[11px] font-black text-cyan-100 hover:bg-cyan-500/30 disabled:opacity-40"
                  >
                    + Queue relay
                  </button>
                </div>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
