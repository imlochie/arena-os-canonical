"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Markdown from "./Markdown";
import { loadKeys } from "./KeysBar";
import PrivacyControls from "./PrivacyControls";
import ProjectPicker from "./ProjectPicker";
import HandoffButtons from "./HandoffButtons";
import { privacyFlags, usePrivacySettings } from "@/lib/privacyClient";
import { localJudge } from "@/lib/localEngine";
import { CATEGORIES } from "@/lib/models";

interface ModelInfo {
  id: string;
  name: string;
  emoji: string;
  color: string;
  description: string;
  kind: string;
  elo: number;
}
interface AssistantInfo {
  id: string;
  name: string;
  avatar: string;
  baseModel: string;
}
interface Template {
  id: string;
  title: string;
  prompt: string;
  category: string;
  isDefault: boolean;
}
interface Turn {
  prompt: string;
  a: string;
  b: string;
}
interface Revealed {
  modelAId: string;
  modelBId: string;
  assistantAId: string | null;
  assistantBId: string | null;
  winner: string;
  nameA: string;
  nameB: string;
}
interface Judge {
  suggestion: "a" | "b" | "tie" | "both-bad" | null;
  scoreA: number | null;
  scoreB: number | null;
  reasoning: string;
  via?: string;
}

export default function BattleArena() {
  const [models, setModels] = useState<ModelInfo[]>([]);
  const [assistants, setAssistants] = useState<AssistantInfo[]>([]);
  const [templates, setTemplates] = useState<Template[]>([]);
  const [prompt, setPrompt] = useState("");
  const [category, setCategory] = useState<string>("general");
  const [mode, setMode] = useState<"random" | "pick">("random");
  const [fighterA, setFighterA] = useState("model:openai");
  const [fighterB, setFighterB] = useState("model:deepseek");
  const [templateId, setTemplateId] = useState("");

  const [streaming, setStreaming] = useState(false);
  const [battleId, setBattleId] = useState<string | null>(null);
  const [turns, setTurns] = useState<Turn[]>([]);
  const [revealed, setRevealed] = useState<Revealed | null>(null);
  const [voting, setVoting] = useState<string | null>(null);
  const [followup, setFollowup] = useState("");
  const [followBusy, setFollowBusy] = useState(false);
  const [judge, setJudge] = useState<Judge | null>(null);
  const [judging, setJudging] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [history, setHistory] = useState<any[]>([]);
  const [search, setSearch] = useState("");
  const [savingTpl, setSavingTpl] = useState(false);
  // Privacy state for the active battle
  const [ephToken, setEphToken] = useState<string | null>(null);
  const [isEph, setIsEph] = useState(false);
  const [isLocal, setIsLocal] = useState(false);
  const [projectId, setProjectId] = useState("");
  const [handoffSource, setHandoffSource] = useState<string | null>(null);
  const privacy = usePrivacySettings();
  const abortRef = useRef<AbortController | null>(null);

  const textModels = models.filter((m) => m.kind === "text");

  const fetchModels = useCallback(async () => {
    try {
      const r = await fetch("/api/models");
      const j = await r.json();
      setModels(j.models ?? []);
    } catch {}
  }, []);
  const fetchHistory = useCallback(async () => {
    try {
      const r = await fetch("/api/battles?limit=30");
      const j = await r.json();
      setHistory((j.battles ?? []).filter((b: any) => b.category !== "image"));
    } catch {}
  }, []);

  useEffect(() => {
    fetchModels();
    fetchHistory();
    fetch("/api/assistants").then((r) => r.json()).then((j) => setAssistants(j.assistants ?? [])).catch(() => {});
    fetch("/api/templates").then((r) => r.json()).then((j) => setTemplates(j.templates ?? [])).catch(() => {});
    try {
      const q = new URLSearchParams(window.location.search);
      const pr = q.get("prompt");
      if (pr) setPrompt(pr.slice(0, 4000));
      const pj = q.get("projectId");
      if (pj) setProjectId(pj);
      const src = q.get("source");
      if (src) setHandoffSource(src);
    } catch {}
  }, [fetchModels, fetchHistory]);

  const modelName = (id: string) => models.find((m) => m.id === id)?.name ?? id;
  const assistantLabel = (id: string | null) => {
    if (!id) return null;
    const a = assistants.find((x) => x.id === id);
    return a ? `${a.avatar} ${a.name}` : null;
  };

  function parseFighter(v: string): { type: "model" | "assistant"; id: string } {
    const [type, ...rest] = v.split(":");
    return { type: type === "assistant" ? "assistant" : "model", id: rest.join(":") };
  }

  function reset(clearPrompt = true) {
    abortRef.current?.abort();
    setStreaming(false);
    setBattleId(null);
    setTurns([]);
    setRevealed(null);
    setJudge(null);
    setFollowup("");
    setError(null);
    setEphToken(null);
    setIsEph(false);
    setIsLocal(false);
    if (clearPrompt) {
      setPrompt("");
      setTemplateId("");
    }
  }

  async function deleteBattle(id: string) {
    if (!confirm("Delete this battle and its thread? This cannot be undone.")) return;
    try {
      await fetch(`/api/battles/${id}`, { method: "DELETE" });
      setHistory((h) => h.filter((x: any) => x.id !== id));
    } catch {}
  }

  async function startBattle(p?: string) {
    const q = (p ?? prompt).trim();
    if (!q || streaming || followBusy) return;
    reset(false);
    setPrompt(q);
    setStreaming(true);
    setError(null);
    setTurns([{ prompt: q, a: "", b: "" }]);

    const flags = privacyFlags();
    setIsEph(flags.ephemeral);
    setIsLocal(flags.localOnly);
    const body: any = { prompt: q, category, keys: loadKeys(), ...flags };
    if (projectId) body.projectId = projectId;
    if (mode === "pick") {
      body.fighterA = parseFighter(fighterA);
      body.fighterB = parseFighter(fighterB);
    }
    // Ephemeral battles use the single-shot path (nothing is ever stored).
    // Otherwise try streaming first, fall back to classic POST.
    const runClassic = async () => {
      const r = await fetch("/api/battles", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error ?? "battle failed");
      setBattleId(j.battle.id);
      if (j.battle.ephemeral) setEphToken(j.battle.revealToken ?? null);
      setTurns([{ prompt: q, a: j.battle.responseA, b: j.battle.responseB }]);
    };
    try {
      if (flags.ephemeral) {
        await runClassic();
      } else {
        await runStream(body, q);
      }
    } catch (e: any) {
      if (e?.name === "AbortError") return;
      if (flags.ephemeral) {
        setError(e.message ?? "Something went wrong");
        setTurns([]);
        setStreaming(false);
        return;
      }
      try {
        await runClassic();
      } catch (e2: any) {
        setError(e2.message ?? "Something went wrong");
        setTurns([]);
      } finally {
        setStreaming(false);
      }
      return;
    }
    setStreaming(false);
  }

  async function runStream(body: any, q: string) {
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    const res = await fetch("/api/battles/stream", {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "text/event-stream" },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
    if (!res.ok || !res.body) throw new Error("stream unavailable");
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = "";
    let accA = "";
    let accB = "";
    const apply = () => setTurns([{ prompt: q, a: accA, b: accB }]);
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      const frames = buf.split("\n\n");
      buf = frames.pop() ?? "";
      for (const f of frames) {
        const line = f.trim();
        if (!line.startsWith("data:")) continue;
        let evt: any;
        try {
          evt = JSON.parse(line.slice(5).trim());
        } catch {
          continue;
        }
        if (evt.type === "meta") setBattleId(evt.battleId);
        else if (evt.type === "delta") {
          if (evt.side === "a") accA += evt.delta ?? "";
          else accB += evt.delta ?? "";
          apply();
        } else if (evt.type === "battle") {
          accA = evt.battle.responseA;
          accB = evt.battle.responseB;
          apply();
        } else if (evt.type === "error") throw new Error(evt.error ?? "stream failed");
      }
    }
  }

  async function sendFollowup() {
    const msg = followup.trim();
    if (!msg || !battleId || followBusy || streaming || isEph) return;
    setFollowBusy(true);
    setFollowup("");
    setError(null);
    setTurns((t) => [...t, { prompt: msg, a: "", b: "" }]);
    try {
      const r = await fetch(`/api/battles/${battleId}/followup`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: msg, keys: loadKeys(), ...privacyFlags() }),
      });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error ?? "followup failed");
      setTurns((t) => {
        const next = [...t];
        next[next.length - 1] = { prompt: msg, a: j.responseA, b: j.responseB };
        return next;
      });
    } catch (e: any) {
      setError(e.message ?? "followup failed");
      setTurns((t) => t.slice(0, -1));
    } finally {
      setFollowBusy(false);
    }
  }

  async function askJudge() {
    if (!battleId || judging) return;
    setJudging(true);
    setJudge(null);
    try {
      // Ephemeral battles: judge fully in-browser (zero egress, zero storage).
      if (isEph) {
        const last = turns[turns.length - 1];
        const j = localJudge(turns[0]?.prompt ?? "", last?.a ?? "", last?.b ?? "");
        setJudge({ ...j, via: "local:in-browser" });
        return;
      }
      const r = await fetch(`/api/battles/${battleId}/judge`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ keys: loadKeys(), ...privacyFlags() }),
      });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error ?? "judge failed");
      setJudge(j.judge);
    } catch (e: any) {
      setError(e.message ?? "judge failed");
    } finally {
      setJudging(false);
    }
  }

  async function vote(winner: "a" | "b" | "tie" | "both-bad") {
    if (!battleId || voting) return;
    setVoting(winner);
    try {
      // Ephemeral: sealed reveal, no storage, no Elo.
      if (isEph && ephToken) {
        const r = await fetch("/api/battles/reveal", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ revealToken: ephToken, winner }),
        });
        const j = await r.json();
        if (!r.ok) throw new Error(j.error ?? "reveal failed");
        setRevealed({
          modelAId: j.modelAId,
          modelBId: j.modelBId,
          assistantAId: j.assistantAId,
          assistantBId: j.assistantBId,
          winner: j.winner,
          nameA: j.nameA,
          nameB: j.nameB,
        });
        return;
      }
      const r = await fetch(`/api/battles/${battleId}/vote`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ winner }),
      });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error ?? "vote failed");
      const b = j.battle;
      const aA = assistantLabel(b.assistantAId);
      const aB = assistantLabel(b.assistantBId);
      setRevealed({
        modelAId: b.modelAId,
        modelBId: b.modelBId,
        assistantAId: b.assistantAId,
        assistantBId: b.assistantBId,
        winner: b.winner,
        nameA: aA ? `${aA} (${modelName(b.modelAId)})` : modelName(b.modelAId),
        nameB: aB ? `${aB} (${modelName(b.modelBId)})` : modelName(b.modelBId),
      });
      fetchHistory();
      fetchModels();
    } catch (e: any) {
      setError(e.message ?? "vote failed");
    } finally {
      setVoting(null);
    }
  }

  function applyTemplate(id: string) {
    setTemplateId(id);
    const t = templates.find((x) => x.id === id);
    if (t) {
      setPrompt(t.prompt);
      if ((CATEGORIES as readonly any[]).some((c) => c.id === t.category)) setCategory(t.category);
    }
  }

  async function saveTemplate() {
    const p = prompt.trim();
    if (!p || savingTpl) return;
    const title = window.prompt("Name this template:", p.slice(0, 48));
    if (!title?.trim()) return;
    setSavingTpl(true);
    try {
      const r = await fetch("/api/templates", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: title.trim(), prompt: p, category }),
      });
      const j = await r.json();
      if (r.ok) {
        setTemplates((t) => [...t, j.template]);
        setTemplateId(j.template.id);
      }
    } finally {
      setSavingTpl(false);
    }
  }

  async function deleteTemplate() {
    const t = templates.find((x) => x.id === templateId);
    if (!t || t.isDefault) return;
    if (!confirm(`Delete template "${t.title}"?`)) return;
    await fetch(`/api/templates?id=${t.id}`, { method: "DELETE" });
    setTemplates((list) => list.filter((x) => x.id !== t.id));
    setTemplateId("");
  }

  const active = turns.length > 0;
  const filteredHistory = history.filter((h: any) =>
    search.trim() ? h.prompt.toLowerCase().includes(search.toLowerCase()) : true
  );

  return (
    <div className="grid gap-5 lg:grid-cols-[1fr_300px]">
      <div className="min-w-0">
        {/* Prompt card */}
        <div className="glass rounded-2xl p-4 sm:p-5">
          <div className="flex flex-wrap items-center gap-2">
            {CATEGORIES.map((c) => (
              <button
                key={c.id}
                onClick={() => setCategory(c.id)}
                className={`rounded-full px-3 py-1.5 text-xs font-bold transition ${
                  category === c.id
                    ? "bg-violet-600 text-white shadow-[0_6px_20px_rgba(124,58,237,0.5)]"
                    : "bg-white/5 text-slate-300 ring-1 ring-white/10 hover:bg-white/10"
                }`}
              >
                {c.emoji} {c.label}
              </button>
            ))}
            <span className="mx-1 hidden h-5 w-px bg-white/10 sm:block" />
            <div className="flex overflow-hidden rounded-full ring-1 ring-white/10">
              <button
                onClick={() => setMode("random")}
                className={`px-3 py-1.5 text-xs font-bold ${mode === "random" ? "bg-cyan-500/25 text-cyan-200" : "text-slate-400 hover:text-white"}`}
              >
                🎲 Blind random
              </button>
              <button
                onClick={() => setMode("pick")}
                className={`px-3 py-1.5 text-xs font-bold ${mode === "pick" ? "bg-cyan-500/25 text-cyan-200" : "text-slate-400 hover:text-white"}`}
              >
                🎯 Pick fighters
              </button>
            </div>
          </div>

          {mode === "pick" && (
            <div className="mt-3 grid gap-2 sm:grid-cols-2">
              <FighterSelect label="Fighter A" value={fighterA} onChange={setFighterA} models={textModels} assistants={assistants} />
              <FighterSelect label="Fighter B" value={fighterB} onChange={setFighterB} models={textModels} assistants={assistants} />
            </div>
          )}

          <div className="mt-3 flex flex-col gap-2 sm:flex-row">
            <select
              value={templateId}
              onChange={(e) => applyTemplate(e.target.value)}
              className="w-full rounded-lg border border-white/10 bg-black/40 px-3 py-2 text-xs font-semibold text-slate-200 focus:border-violet-500 focus:outline-none sm:max-w-[240px]"
            >
              <option value="">📝 Prompt templates…</option>
              {templates.map((t) => (
                <option key={t.id} value={t.id}>{t.title} ({t.category})</option>
              ))}
            </select>
            <div className="flex gap-2">
              <button
                onClick={saveTemplate}
                disabled={!prompt.trim() || savingTpl}
                className="rounded-lg border border-white/10 bg-white/5 px-3 py-2 text-xs font-bold text-slate-200 hover:bg-white/10 disabled:opacity-50"
                title="Save current prompt as a reusable template"
              >
                💾 Save prompt
              </button>
              {templateId && !templates.find((t) => t.id === templateId)?.isDefault && (
                <button onClick={deleteTemplate} className="rounded-lg border border-white/10 bg-white/5 px-3 py-2 text-xs font-bold text-red-300 hover:bg-red-500/20">
                  🗑️
                </button>
              )}
            </div>
          </div>

          <div className="mt-2.5 flex gap-2">
            <textarea
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) startBattle();
              }}
              rows={3}
              placeholder="Ask anything… two anonymous fighters answer side-by-side, streamed live. You judge. (Ctrl+Enter to send)"
              className="min-h-[76px] flex-1 resize-y rounded-xl border border-white/10 bg-black/40 px-4 py-3 text-[15px] text-white placeholder:text-slate-500 focus:border-violet-500 focus:outline-none focus:ring-2 focus:ring-violet-500/30"
            />
          </div>
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <button onClick={() => startBattle()} disabled={streaming || !prompt.trim()} className="btn-arena rounded-xl px-6 py-2.5 text-sm font-extrabold text-white">
              {streaming ? "⚔️ Streaming…" : "⚔️ Start battle"}
            </button>
            {streaming && (
              <button onClick={() => reset(false)} className="rounded-xl border border-red-400/30 bg-red-500/10 px-4 py-2.5 text-sm font-bold text-red-200 hover:bg-red-500/20">
                ⏹ Stop
              </button>
            )}
            {active && !streaming && (
              <>
                <button onClick={() => reset()} className="rounded-xl border border-white/10 bg-white/5 px-4 py-2.5 text-sm font-bold text-slate-200 hover:bg-white/10">
                  ＋ New battle
                </button>
                <button
                  onClick={() => startBattle(turns[0]?.prompt)}
                  className="rounded-xl border border-white/10 bg-white/5 px-4 py-2.5 text-sm font-bold text-slate-200 hover:bg-white/10"
                  title="Same prompt, fresh random fighters"
                >
                  🔁 Retry
                </button>
              </>
            )}
          </div>
          <div className="mt-3 flex flex-wrap items-center gap-2 border-t border-white/5 pt-3">
            <PrivacyControls compact />
            <span className="text-[11px] text-slate-500">
              {privacy.ephemeral
                ? "👻 Ephemeral: single-turn, reveal-only vote, nothing stored."
                : privacy.localMode || !privacy.online
                  ? "🔒 Local: on-device AI, zero egress, memory still saved."
                  : "streamed · blind · position-randomized · Elo + BT · never trained on"}
            </span>
          </div>

          {error && <p className="mt-3 rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-sm text-red-300">⚠️ {error}</p>}
        </div>

        {/* Thread */}
        {active && (
          <div className="fade-up mt-5 space-y-5">
            {(isEph || isLocal) && (
              <p className="text-center text-[11px] font-bold text-slate-400">
                {isEph ? "👻 Ephemeral battle — nothing is stored; vote reveals without touching Elo." : ""}
                {isEph && isLocal ? " " : ""}
                {isLocal ? "🔒 Generated on-device — zero network egress." : ""}
              </p>
            )}
            {turns.map((t, i) => (
              <div key={i}>
                <div className="mb-3 flex justify-center">
                  <p className="max-w-3xl rounded-2xl border border-violet-500/30 bg-violet-600/10 px-4 py-2.5 text-center text-sm font-semibold text-violet-100">
                    <span className="mr-1.5 rounded-md bg-violet-600 px-1.5 py-0.5 text-[10px] font-black text-white">
                      TURN {i + 1}
                    </span>
                    {t.prompt}
                  </p>
                </div>
                <div className="grid items-start gap-4 md:grid-cols-2">
                  <FighterPanel
                    side="A"
                    text={t.a}
                    streaming={streaming && i === turns.length - 1 && !t.a}
                    revealed={!!revealed}
                    modelName={revealed?.nameA}
                    won={revealed?.winner === "a"}
                    tied={revealed?.winner === "tie"}
                    isLatest={i === turns.length - 1}
                  />
                  <FighterPanel
                    side="B"
                    text={t.b}
                    streaming={(streaming || followBusy) && i === turns.length - 1 && !t.b}
                    revealed={!!revealed}
                    modelName={revealed?.nameB}
                    won={revealed?.winner === "b"}
                    tied={revealed?.winner === "tie"}
                    isLatest={i === turns.length - 1}
                  />
                </div>
              </div>
            ))}

            {/* Follow-up (stored battles only) */}
            {!streaming && battleId && !isEph && (
              <div className="glass rounded-2xl p-4">
                <p className="text-xs font-extrabold text-white">💬 Continue the conversation (multi-turn — both fighters reply, vote when ready)</p>
                <div className="mt-2 flex gap-2">
                  <input
                    value={followup}
                    onChange={(e) => setFollowup(e.target.value)}
                    onKeyDown={(e) => e.key === "Enter" && sendFollowup()}
                    placeholder={`Follow-up ${turns.length + 1}/10… (Enter to send)`}
                    disabled={!!revealed}
                    className="flex-1 rounded-xl border border-white/10 bg-black/40 px-4 py-2.5 text-sm text-white placeholder:text-slate-500 focus:border-violet-500 focus:outline-none disabled:opacity-50"
                  />
                  <button onClick={sendFollowup} disabled={followBusy || !followup.trim() || !!revealed} className="btn-arena rounded-xl px-5 py-2.5 text-sm font-extrabold text-white">
                    {followBusy ? "…" : "Send"}
                  </button>
                </div>
                {revealed && <p className="mt-1.5 text-[11px] text-slate-500">Voted battles are locked — start a new battle to continue exploring.</p>}
              </div>
            )}
            {!streaming && battleId && isEph && !revealed && (
              <p className="text-center text-[11px] text-slate-500">👻 Ephemeral battles are single-turn — disable Ephemeral for multi-turn threads.</p>
            )}

            {/* Judge */}
            {!streaming && battleId && !revealed && (
              <div className="glass rounded-2xl p-4">
                {!judge ? (
                  <div className="flex flex-wrap items-center gap-2">
                    <button onClick={askJudge} disabled={judging} className="rounded-xl border border-amber-400/30 bg-amber-400/10 px-4 py-2 text-sm font-extrabold text-amber-200 hover:bg-amber-400/20 disabled:opacity-60">
                      {judging ? "🧑‍⚖️ Judging…" : isEph ? "🧑‍⚖️ Judge in-browser (local)" : "🧑‍⚖️ Ask the AI judge"}
                    </button>
                    <p className="text-[11px] text-slate-500">
                      {isEph
                        ? "Transparent on-device rubric — runs in your browser, nothing sent or stored."
                        : "Arena-Hard style: an impartial model scores both sides. Advisory only — your vote decides Elo."}
                    </p>
                  </div>
                ) : (
                  <div className="rounded-xl border border-amber-400/25 bg-amber-400/5 p-3">
                    <p className="text-sm font-extrabold text-white">
                      🧑‍⚖️ Judge suggests:{" "}
                      <span className="text-amber-300">
                        {judge.suggestion === "a" ? "A wins" : judge.suggestion === "b" ? "B wins" : judge.suggestion === "tie" ? "Tie" : judge.suggestion === "both-bad" ? "Both bad" : "no clear verdict"}
                      </span>
                      {judge.scoreA !== null && judge.scoreB !== null && (
                        <span className="ml-2 font-mono text-xs text-slate-300">A {judge.scoreA}/10 · B {judge.scoreB}/10</span>
                      )}
                    </p>
                    <p className="mt-1 text-xs leading-relaxed text-slate-300">{judge.reasoning}</p>
                    <div className="mt-2 flex flex-wrap gap-2">
                      {judge.suggestion && (
                        <button onClick={() => vote(judge.suggestion!)} disabled={!!voting} className="rounded-lg bg-amber-500/80 px-3 py-1.5 text-xs font-extrabold text-black hover:bg-amber-400 disabled:opacity-60">
                          ✓ Accept & cast vote
                        </button>
                      )}
                      <button onClick={() => setJudge(null)} className="rounded-lg border border-white/10 bg-white/5 px-3 py-1.5 text-xs font-bold text-white hover:bg-white/10">
                        Dismiss
                      </button>
                    </div>
                  </div>
                )}
              </div>
            )}

            {/* Vote */}
            {!streaming && !revealed && (
              <div className="glass rounded-2xl p-4">
                <p className="text-center text-sm font-extrabold text-white">👑 Which fighter is better{turns.length > 1 ? " across the whole conversation" : ""}?</p>
                <p className="mt-0.5 text-center text-xs text-slate-400">
                  {isEph
                    ? "👻 Ephemeral vote: reveals identities only — no storage, no Elo."
                    : "Voting reveals both identities + updates Elo & Bradley-Terry"}
                </p>
                <div className="mx-auto mt-3 grid max-w-2xl grid-cols-2 gap-2 sm:grid-cols-4">
                  <button onClick={() => vote("a")} disabled={!!voting} className="rounded-xl bg-violet-600 px-3 py-2.5 text-sm font-extrabold text-white hover:bg-violet-500 disabled:opacity-60">
                    {voting === "a" ? "…" : "🏅 A wins"}
                  </button>
                  <button onClick={() => vote("b")} disabled={!!voting} className="rounded-xl bg-cyan-600 px-3 py-2.5 text-sm font-extrabold text-white hover:bg-cyan-500 disabled:opacity-60">
                    {voting === "b" ? "…" : "🏅 B wins"}
                  </button>
                  <button onClick={() => vote("tie")} disabled={!!voting} className="rounded-xl border border-white/15 bg-white/5 px-3 py-2.5 text-sm font-extrabold text-white hover:bg-white/10 disabled:opacity-60">
                    🤝 Tie
                  </button>
                  <button onClick={() => vote("both-bad")} disabled={!!voting} className="rounded-xl border border-white/15 bg-white/5 px-3 py-2.5 text-sm font-extrabold text-slate-300 hover:bg-white/10 disabled:opacity-60">
                    👎 Both bad
                  </button>
                </div>
              </div>
            )}

            {revealed && (
              <div className="reveal-pop glass rounded-2xl border-violet-500/30 p-4 text-center">
                <p className="text-sm font-extrabold text-white">
                  {revealed.winner === "tie"
                    ? "🤝 It's a tie! Both fighters gain mutual respect."
                    : revealed.winner === "both-bad"
                      ? isEph ? "👎 Both marked bad. Nothing stored." : "👎 Both marked bad — Elo dipped slightly."
                      : revealed.winner === "a"
                        ? `🏆 ${revealed.nameA} takes the round!`
                        : `🏆 ${revealed.nameB} takes the round!`}
                </p>
                {isEph && <p className="mt-1 text-[11px] text-slate-500">👻 Ephemeral reveal — this battle never touched the database or leaderboard.</p>}
                <div className="mt-3 flex flex-wrap justify-center gap-2">
                  <button onClick={() => reset()} className="btn-arena rounded-xl px-5 py-2 text-sm font-extrabold text-white">
                    ⚔️ Battle again
                  </button>
                  <button onClick={() => startBattle(turns[0]?.prompt)} className="rounded-xl border border-white/10 bg-white/5 px-5 py-2 text-sm font-bold text-white hover:bg-white/10">
                    🔁 Retry same prompt
                  </button>
                  {battleId && !isEph && (
                    <a href={`/battles/${battleId}`} className="rounded-xl border border-white/10 bg-white/5 px-5 py-2 text-sm font-bold text-white hover:bg-white/10">
                      🔗 Share / permalink
                    </a>
                  )}
                </div>
              </div>
            )}
          </div>
        )}
      </div>

      {/* Sidebar */}
      <aside className="min-w-0 space-y-4">
        <div className="glass rounded-2xl p-4">
          <h3 className="text-sm font-extrabold text-white">🏆 Top fighters</h3>
          <div className="mt-3 space-y-2">
            {[...models].filter((m) => m.kind === "text").sort((a, b) => b.elo - a.elo).slice(0, 5).map((m, i) => (
              <div key={m.id} className="flex items-center gap-2 rounded-lg bg-white/[0.03] px-2.5 py-2 ring-1 ring-white/5">
                <span className="w-5 text-center text-xs font-black text-slate-400">
                  {i === 0 ? "🥇" : i === 1 ? "🥈" : i === 2 ? "🥉" : `${i + 1}`}
                </span>
                <span>{m.emoji}</span>
                <span className="min-w-0 flex-1 truncate text-xs font-bold text-white">{m.name}</span>
                <span className="font-mono text-xs font-bold text-cyan-300">{m.elo}</span>
              </div>
            ))}
            {models.length === 0 && <p className="text-xs text-slate-500">Loading…</p>}
          </div>
          <a href="/leaderboard" className="mt-3 block text-center text-xs font-bold text-violet-300 hover:underline">
            Full leaderboard →
          </a>
        </div>

        <div className="glass rounded-2xl p-4">
          <h3 className="text-sm font-extrabold text-white">🕘 Recent battles</h3>
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="🔍 Search battles…"
            className="mt-2 w-full rounded-lg border border-white/10 bg-black/40 px-3 py-1.5 text-xs text-white placeholder:text-slate-600 focus:border-violet-500 focus:outline-none"
          />
          <div className="scroll-thin mt-2 max-h-72 space-y-2 overflow-y-auto">
            {filteredHistory.map((h: any) => (
              <div key={h.id} className="group relative rounded-lg bg-white/[0.03] p-2.5 ring-1 ring-white/5 hover:ring-violet-500/40">
                <a href={`/battles/${h.id}`} className="block">
                  <p className="line-clamp-2 pr-6 text-xs font-semibold text-slate-200">{h.prompt}</p>
                  <p className="mt-1 text-[11px] text-slate-500">
                    {h.winner ? (
                      <>✅ voted: <span className="font-bold text-emerald-300">{h.winner === "a" ? "A" : h.winner === "b" ? "B" : h.winner}</span> · {h.category}</>
                    ) : (
                      <>🎭 blind · {h.category}</>
                    )}
                  </p>
                </a>
                <button
                  onClick={() => deleteBattle(h.id)}
                  title="Delete this battle (right to erasure)"
                  className="absolute right-1.5 top-1.5 hidden rounded px-1.5 py-0.5 text-[11px] text-slate-500 hover:bg-red-500/20 hover:text-red-300 group-hover:block"
                >
                  ✕
                </button>
              </div>
            ))}
            {filteredHistory.length === 0 && <p className="text-xs text-slate-500">No battles match.</p>}
          </div>
        </div>

        <div className="rounded-2xl border border-amber-400/25 bg-gradient-to-br from-amber-500/15 to-orange-500/5 p-4">
          <p className="text-sm font-extrabold text-amber-200">💡 New: battle your assistants</p>
          <p className="mt-1.5 text-xs leading-relaxed text-amber-100/80">
            Switch to <strong>🎯 Pick fighters</strong> and pit two of <a href="/assistants" className="font-bold underline">your assistants</a> against
            each other. Elo credits their base brains — names reveal on vote.
          </p>
        </div>
      </aside>
    </div>
  );
}

function FighterSelect({
  label, value, onChange, models, assistants,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  models: ModelInfo[];
  assistants: AssistantInfo[];
}) {
  return (
    <label className="block">
      <span className="mb-1 block text-[11px] font-bold uppercase tracking-wider text-slate-400">{label}</span>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="w-full rounded-lg border border-white/10 bg-black/40 px-3 py-2 text-sm font-semibold text-white focus:border-violet-500 focus:outline-none"
      >
        <optgroup label="🤖 Models">
          {models.map((m) => (
            <option key={m.id} value={`model:${m.id}`}>{m.emoji} {m.name}</option>
          ))}
        </optgroup>
        {assistants.length > 0 && (
          <optgroup label="🧬 My assistants">
            {assistants.map((a) => (
              <option key={a.id} value={`assistant:${a.id}`}>{a.avatar} {a.name}</option>
            ))}
          </optgroup>
        )}
      </select>
    </label>
  );
}

function FighterPanel({
  side, text, streaming, revealed, modelName, won, tied, isLatest,
}: {
  side: string;
  text: string;
  streaming?: boolean;
  revealed: boolean;
  modelName?: string;
  won?: boolean;
  tied?: boolean;
  isLatest?: boolean;
}) {
  const [copied, setCopied] = useState(false);
  const [speaking, setSpeaking] = useState(false);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      const ta = document.createElement("textarea");
      ta.value = text;
      document.body.appendChild(ta);
      ta.select();
      document.execCommand("copy");
      document.body.removeChild(ta);
    }
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  const speak = () => {
    try {
      const synth = window.speechSynthesis;
      if (speaking) {
        synth.cancel();
        setSpeaking(false);
        return;
      }
      synth.cancel();
      const plain = text.replace(/!\[.*?\]\(.*?\)/g, "image").replace(/[#*_`>]/g, "").slice(0, 1200);
      const u = new SpeechSynthesisUtterance(plain);
      u.onend = () => setSpeaking(false);
      synth.speak(u);
      setSpeaking(true);
    } catch {}
  };

  const words = text.trim() ? text.trim().split(/\s+/).length : 0;

  return (
    <div
      className={`glass overflow-hidden rounded-2xl ${
        revealed && won ? "ring-2 ring-amber-400/60" : revealed && tied ? "ring-2 ring-slate-400/40" : ""
      }`}
    >
      <div className={`flex items-center gap-2.5 border-b border-white/10 px-4 py-3 ${side === "A" ? "bg-violet-600/10" : "bg-cyan-600/10"}`}>
        <span className={`grid h-8 w-8 place-items-center rounded-lg text-base font-black text-white ${side === "A" ? "bg-violet-600" : "bg-cyan-600"}`}>
          {side}
        </span>
        <div className="min-w-0 flex-1">
          {revealed ? (
            <p className="reveal-pop truncate text-sm font-extrabold text-white">🎭 → {modelName}</p>
          ) : (
            <p className="text-sm font-extrabold text-white">🎭 Anonymous fighter</p>
          )}
          <p className="text-[11px] text-slate-400">
            {streaming ? "streaming…" : text ? `${words} words · free tier` : "waiting…"}
          </p>
        </div>
        {revealed && won && <span className="text-xl">🏆</span>}
        {revealed && tied && <span className="text-xl">🤝</span>}
        {text && (
          <div className="flex gap-1">
            <button onClick={copy} title="Copy response" className="rounded-lg bg-white/5 px-2 py-1 text-xs hover:bg-white/15">
              {copied ? "✓" : "📋"}
            </button>
            <button onClick={speak} title={speaking ? "Stop reading" : "Read aloud (on-device TTS — nothing uploaded)"} className="rounded-lg bg-white/5 px-2 py-1 text-xs hover:bg-white/15">
              {speaking ? "⏹" : "🔊"}
            </button>
          </div>
        )}
      </div>
      <div className="scroll-thin max-h-[520px] min-h-[120px] overflow-y-auto p-4">
        {streaming && !text ? (
          <div>
            <div className="h-1.5 overflow-hidden rounded-full bg-white/5">
              <div className="shimmer-bar h-full w-full" />
            </div>
            <div className="mt-4 space-y-2">
              <div className="h-3 w-11/12 rounded bg-white/5" />
              <div className="h-3 w-9/12 rounded bg-white/5" />
              <div className="h-3 w-10/12 rounded bg-white/5" />
            </div>
          </div>
        ) : text ? (
          <>
            <Markdown text={text} />
            {isLatest && !revealed && <span className="mt-1 inline-block h-4 w-2 animate-pulse rounded-sm bg-violet-400/70" />}
          </>
        ) : (
          <p className="text-sm text-slate-500">…</p>
        )}
      </div>
    </div>
  );
}
