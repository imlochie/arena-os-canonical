"use client";

import { useCallback, useEffect, useState } from "react";
import Markdown from "./Markdown";
import { loadKeys } from "./KeysBar";
import PrivacyControls from "./PrivacyControls";
import ProjectPicker from "./ProjectPicker";
import HandoffButtons from "./HandoffButtons";
import { privacyFlags, usePrivacySettings } from "@/lib/privacyClient";
import { CATEGORIES } from "@/lib/models";
import { STRATEGIES } from "@/lib/strategies";

interface ModelInfo {
  id: string;
  name: string;
  emoji: string;
  kind: string;
  elo: number;
}
interface AssistantInfo {
  id: string;
  name: string;
  avatar: string;
  baseModel: string;
}
interface Contrib {
  id: string;
  round: number;
  contribIndex: number;
  kind: string;
  label: string;
  content: string;
}

const CHALLENGE_STARTERS: { strategy: string; text: string }[] = [
  {
    strategy: "second-brain",
    text: "Mess dump: Q3 ideas — (1) launch lore series for LOCO PRØD, (2) Notion curriculum is 60% done but governance page is chaos, (3) analytics say thumbnails with faces +2x CTR, (4) considering weekly vs daily uploads, (5) budget tracker needs automation. Turn this mess into structure.",
  },
  {
    strategy: "systems",
    text: "I keep re-deciding how to publish each track: title format, thumbnail style, description, archive location, cross-posts. Build me a repeatable publishing machine so I never re-think this.",
  },
  {
    strategy: "scenarios",
    text: "What should Phase II of my creative output look like? Options swirling: double down on one format, diversify into shorts, build a course, or go full lore-universe. Prototype the possible worlds.",
  },
  {
    strategy: "brainstorm",
    text: "I need a naming system + 10 name candidates for a new content series about building a personal university. Go wide and weird.",
  },
  {
    strategy: "debate",
    text: "Should I use SQL or NoSQL for my personal archive that mixes structured metadata with messy creative notes? Settle it with a real debate.",
  },
  {
    strategy: "signal",
    text: "Raw thought: I keep starting systems and abandoning them halfway, but the archive keeps growing anyway and somehow it still works?? What's actually going on here?",
  },
];

export default function CollabLab() {
  const [models, setModels] = useState<ModelInfo[]>([]);
  const [assistants, setAssistants] = useState<AssistantInfo[]>([]);
  const [strategyId, setStrategyId] = useState("council");
  const [challenge, setChallenge] = useState("");
  const [category, setCategory] = useState("general");
  const [count, setCount] = useState(3);
  const [pickMode, setPickMode] = useState<"random" | "pick">("random");
  const [picks, setPicks] = useState<string[]>(["model:openai", "model:deepseek", "model:claude", "model:gemini"]);
  const [synthModel, setSynthModel] = useState("openai");

  const [running, setRunning] = useState(false);
  const [phase, setPhase] = useState("");
  const [collab, setCollab] = useState<any | null>(null);
  const [contribs, setContribs] = useState<Contrib[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [history, setHistory] = useState<any[]>([]);
  const [search, setSearch] = useState("");
  const [instruction, setInstruction] = useState("");
  const [iterating, setIterating] = useState(false);
  const [crowned, setCrowned] = useState<number | null>(null);
  const [crowning, setCrowning] = useState(false);
  const [copied, setCopied] = useState<string | null>(null);
  const [projectId, setProjectId] = useState("");
  const [handoffSource, setHandoffSource] = useState<string | null>(null);
  const privacy = usePrivacySettings();
  const isEph = !!collab?.ephemeral;
  const isLocal = !!collab?.localOnly;

  const textModels = models.filter((m) => m.kind === "text");
  const strategy = STRATEGIES.find((s) => s.id === strategyId) ?? STRATEGIES[0];

  const fetchHistory = useCallback(async () => {
    try {
      const r = await fetch("/api/collabs?limit=30");
      const j = await r.json();
      setHistory(j.collabs ?? []);
    } catch {}
  }, []);

  useEffect(() => {
    fetch("/api/models").then((r) => r.json()).then((j) => setModels(j.models ?? [])).catch(() => {});
    fetch("/api/assistants").then((r) => r.json()).then((j) => setAssistants(j.assistants ?? [])).catch(() => {});
    fetchHistory();
    try {
      const q = new URLSearchParams(window.location.search);
      const ch = q.get("challenge");
      if (ch) setChallenge(ch.slice(0, 6000));
      const pj = q.get("projectId");
      if (pj) setProjectId(pj);
      const st = q.get("strategy");
      if (st && STRATEGIES.some((s) => s.id === st)) setStrategyId(st);
      const src = q.get("source");
      if (src) setHandoffSource(src);
    } catch {}
  }, [fetchHistory]);

  function setPick(i: number, v: string) {
    setPicks((p) => {
      const n = [...p];
      n[i] = v;
      return n;
    });
  }

  async function run(c?: string, s?: string) {
    const ch = (c ?? challenge).trim();
    if (!ch || running) return;
    const strat = s ?? strategyId;
    setChallenge(ch);
    setStrategyId(strat);
    setRunning(true);
    setError(null);
    setCollab(null);
    setContribs([]);
    setCrowned(null);
    const st = STRATEGIES.find((x) => x.id === strat)!;
    setPhase(st.rounds === 2 ? "Round 1/2: parallel drafts…" : "Collaborators drafting in parallel…");
    try {
      const collaborators =
        pickMode === "pick"
          ? picks.slice(0, count).map((v) => {
              const [type, ...rest] = v.split(":");
              return { type: type === "assistant" ? "assistant" : "model", id: rest.join(":") };
            })
          : [];
      if (st.rounds === 2) {
        setTimeout(() => setPhase((p) => (p.startsWith("Round 1") ? "Round 2/2: critiques + sharpening…" : p)), 25000);
      }
      setTimeout(() => setPhase("💎 Synthesizing best result…"), 45000);
      const r = await fetch("/api/collabs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ challenge: ch, category, strategy: strat, synthesisModel: synthModel, collaborators, keys: loadKeys(), ...privacyFlags(), ...(projectId ? { projectId } : {}) }),
      });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error ?? "collaboration failed");
      setCollab(j.collab);
      setContribs(j.contributions ?? []);
      if (!j.collab?.ephemeral) fetchHistory();
    } catch (e: any) {
      setError(e.message ?? "failed");
    } finally {
      setRunning(false);
      setPhase("");
    }
  }

  async function iterate() {
    const ins = instruction.trim();
    if (!ins || !collab || iterating) return;
    if (collab.ephemeral) {
      setError("👻 Ephemeral collabs are single-run — disable Ephemeral for iteration passes.");
      return;
    }
    setIterating(true);
    setInstruction("");
    setError(null);
    try {
      const r = await fetch(`/api/collabs/${collab.id}/iterate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ instruction: ins, keys: loadKeys(), ...privacyFlags() }),
      });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error ?? "iterate failed");
      // Refresh full thread
      const d = await fetch(`/api/collabs/${collab.id}`).then((x) => x.json());
      setCollab(d.collab);
      setContribs(d.contributions ?? []);
    } catch (e: any) {
      setError(e.message ?? "iterate failed");
    } finally {
      setIterating(false);
    }
  }

  async function crown(index: number) {
    if (!collab || crowning || crowned !== null) return;
    if (collab.ephemeral) {
      setError("👻 Ephemeral collabs can't crown — nothing is stored, no Elo. Disable Ephemeral to crown.");
      return;
    }
    setCrowning(true);
    try {
      const r = await fetch(`/api/collabs/${collab.id}/crown`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ index }),
      });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error ?? "crown failed");
      setCrowned(index);
    } catch (e: any) {
      setError(e.message ?? "crown failed");
    } finally {
      setCrowning(false);
    }
  }

  function copy(id: string, text: string) {
    const done = () => {
      setCopied(id);
      setTimeout(() => setCopied(null), 1500);
    };
    if (navigator.clipboard?.writeText) {
      navigator.clipboard.writeText(text).then(done).catch(() => fallbackCopy(text, done));
    } else fallbackCopy(text, done);
  }
  function fallbackCopy(text: string, done: () => void) {
    try {
      const ta = document.createElement("textarea");
      ta.value = text;
      document.body.appendChild(ta);
      ta.select();
      document.execCommand("copy");
      document.body.removeChild(ta);
    } catch {}
    done();
  }

  async function saveAsTemplate() {
    if (!collab) return;
    const title = window.prompt("Name this template:", collab.challenge.slice(0, 48));
    if (!title?.trim()) return;
    await fetch("/api/templates", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: title.trim(), prompt: collab.synthesis.slice(0, 2000), category }),
    });
    copy("tpl", "saved");
  }

  const drafts = contribs.filter((c) => c.kind === "draft" && c.round === 1);
  const critiques = contribs.filter((c) => c.kind === "critique");
  const syntheses = contribs.filter((c) => c.kind === "synthesis");
  const latestSynth = syntheses[syntheses.length - 1]?.content ?? collab?.synthesis ?? "";
  const extraPasses = contribs.filter((c) => c.round > (strategy.rounds === 2 ? 2 : 1));

  const filtered = history.filter((h: any) =>
    search.trim()
      ? (h.challenge as string).toLowerCase().includes(search.toLowerCase())
      : true
  );

  return (
    <div className="grid gap-5 lg:grid-cols-[1fr_300px]">
      <div className="min-w-0">
        {/* Challenge composer */}
        <div className="glass rounded-2xl p-4 sm:p-5">
          <p className="text-[11px] font-black uppercase tracking-wider text-slate-400">1 · Pick a thinking mode</p>
          <div className="mt-2 grid gap-2 sm:grid-cols-2 xl:grid-cols-3">
            {STRATEGIES.map((s) => (
              <button
                key={s.id}
                onClick={() => setStrategyId(s.id)}
                className={`rounded-xl border p-3 text-left transition ${
                  strategyId === s.id
                    ? "border-violet-400/60 bg-violet-600/15 shadow-[0_8px_28px_rgba(124,58,237,0.3)]"
                    : "border-white/10 bg-white/[0.03] hover:border-violet-500/40"
                }`}
              >
                <p className="text-sm font-extrabold text-white">
                  {s.emoji} {s.name}
                  {s.rounds === 2 && <span className="ml-1.5 rounded-full bg-amber-400/15 px-1.5 py-0.5 text-[9px] font-black text-amber-300">2 ROUNDS</span>}
                </p>
                <p className="mt-0.5 text-[11px] font-bold text-violet-300">{s.tagline}</p>
                <p className="mt-1 line-clamp-2 text-[11px] leading-relaxed text-slate-400">{s.description}</p>
              </button>
            ))}
          </div>
          <p className="mt-2 rounded-lg border border-white/5 bg-black/20 px-3 py-1.5 text-[11px] text-slate-400">
            🧠 Maps to your OS: <span className="font-semibold text-slate-200">{strategy.mapsTo}</span>
          </p>

          <p className="mt-4 text-[11px] font-black uppercase tracking-wider text-slate-400">2 · Describe the challenge (mess welcome)</p>
          <textarea
            value={challenge}
            onChange={(e) => setChallenge(e.target.value)}
            rows={4}
            placeholder="Dump it all: half-formed ideas, lists, analytics, competing options, screenshots-as-text… The council turns mess into the best result. (Ctrl+Enter to run)"
            onKeyDown={(e) => {
              if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) run();
            }}
            className="mt-2 min-h-[100px] w-full resize-y rounded-xl border border-white/10 bg-black/40 px-4 py-3 text-[15px] text-white placeholder:text-slate-500 focus:border-violet-500 focus:outline-none focus:ring-2 focus:ring-violet-500/30"
          />

          <div className="mt-3 flex flex-wrap items-center gap-2">
            {CATEGORIES.map((c) => (
              <button
                key={c.id}
                onClick={() => setCategory(c.id)}
                className={`rounded-full px-3 py-1.5 text-xs font-bold ${category === c.id ? "bg-violet-600 text-white" : "bg-white/5 text-slate-300 ring-1 ring-white/10 hover:bg-white/10"}`}
              >
                {c.emoji} {c.label}
              </button>
            ))}
          </div>

          <div className="mt-3 grid gap-3 rounded-xl border border-white/5 bg-black/20 p-3 sm:grid-cols-3">
            <div>
              <p className="mb-1.5 text-[11px] font-bold uppercase tracking-wider text-slate-400">Collaborators</p>
              <div className="flex gap-1">
                {[2, 3, 4].map((n) => (
                  <button
                    key={n}
                    onClick={() => setCount(n)}
                    className={`flex-1 rounded-lg px-2 py-1.5 text-xs font-extrabold ${count === n ? "bg-violet-600 text-white" : "bg-white/5 text-slate-300 ring-1 ring-white/10"}`}
                  >
                    {n}
                  </button>
                ))}
              </div>
              <div className="mt-1.5 flex overflow-hidden rounded-lg ring-1 ring-white/10">
                <button onClick={() => setPickMode("random")} className={`flex-1 px-2 py-1.5 text-[11px] font-bold ${pickMode === "random" ? "bg-cyan-500/25 text-cyan-200" : "text-slate-400"}`}>
                  🎲 Auto
                </button>
                <button onClick={() => setPickMode("pick")} className={`flex-1 px-2 py-1.5 text-[11px] font-bold ${pickMode === "pick" ? "bg-cyan-500/25 text-cyan-200" : "text-slate-400"}`}>
                  🎯 Pick
                </button>
              </div>
            </div>
            <div className={pickMode === "pick" ? "sm:col-span-2" : ""}>
              {pickMode === "pick" ? (
                <div className="grid gap-1.5 sm:grid-cols-2">
                  {Array.from({ length: count }).map((_, i) => (
                    <select
                      key={i}
                      value={picks[i]}
                      onChange={(e) => setPick(i, e.target.value)}
                      className="w-full rounded-lg border border-white/10 bg-black/40 px-2 py-1.5 text-xs font-semibold text-white focus:border-violet-500 focus:outline-none"
                    >
                      <optgroup label="🤖 Models">
                        {textModels.map((m) => (
                          <option key={m.id} value={`model:${m.id}`}>{m.emoji} {m.name}</option>
                        ))}
                      </optgroup>
                      {assistants.length > 0 && (
                        <optgroup label="🧬 Assistants">
                          {assistants.map((a) => (
                            <option key={a.id} value={`assistant:${a.id}`}>{a.avatar} {a.name}</option>
                          ))}
                        </optgroup>
                      )}
                    </select>
                  ))}
                </div>
              ) : (
                <>
                  <p className="mb-1.5 text-[11px] font-bold uppercase tracking-wider text-slate-400">Synthesizer</p>
                  <select
                    value={synthModel}
                    onChange={(e) => setSynthModel(e.target.value)}
                    className="w-full rounded-lg border border-white/10 bg-black/40 px-2 py-1.5 text-xs font-semibold text-white focus:border-violet-500 focus:outline-none"
                  >
                    {textModels.map((m) => (
                      <option key={m.id} value={m.id}>💎 {m.emoji} {m.name}</option>
                    ))}
                  </select>
                </>
              )}
            </div>
            {pickMode === "pick" && (
              <div className="sm:col-span-3">
                <p className="mb-1.5 text-[11px] font-bold uppercase tracking-wider text-slate-400">Synthesizer (merges everything into the best result)</p>
                <select
                  value={synthModel}
                  onChange={(e) => setSynthModel(e.target.value)}
                  className="w-full rounded-lg border border-white/10 bg-black/40 px-2 py-1.5 text-xs font-semibold text-white focus:border-violet-500 focus:outline-none sm:max-w-xs"
                >
                  {textModels.map((m) => (
                    <option key={m.id} value={m.id}>💎 {m.emoji} {m.name}</option>
                  ))}
                </select>
              </div>
            )}
          </div>

          <div className="mt-3 flex flex-wrap items-center gap-2">
            <button onClick={() => run()} disabled={running || !challenge.trim()} className="btn-arena rounded-xl px-6 py-2.5 text-sm font-extrabold text-white">
              {running ? `🤝 ${phase || "Collaborating…"}` : `🤝 Run ${strategy.name}`}
            </button>
            {collab && !running && (
              <button
                onClick={() => {
                  setCollab(null);
                  setContribs([]);
                  setCrowned(null);
                  setChallenge("");
                }}
                className="rounded-xl border border-white/10 bg-white/5 px-4 py-2.5 text-sm font-bold text-white hover:bg-white/10"
              >
                ＋ New challenge
              </button>
            )}
            <span className="ml-auto hidden text-[11px] text-slate-500 xl:block">
              {count} minds + 1 synthesizer · {strategy.rounds === 2 ? "2 rounds" : "1 round"} · free
            </span>
          </div>
          {handoffSource && (
            <p className="mt-2 rounded-lg border border-emerald-400/30 bg-emerald-400/10 px-3 py-1.5 text-[11px] font-bold text-emerald-200">
              🔁 Handoff from {handoffSource.replace(":", " ")} — project memory will be included when attached.
            </p>
          )}
          <div className="mt-3 flex flex-wrap items-center gap-2 border-t border-white/5 pt-3">
            <PrivacyControls compact />
            <ProjectPicker value={projectId} onChange={setProjectId} />
            <span className="text-[11px] text-slate-500">
              {privacy.ephemeral
                ? "👻 Ephemeral: single-run synthesis, nothing stored."
                : privacy.localMode || !privacy.online
                  ? "🔒 Local: on-device council + synthesis, zero egress."
                  : "parallel minds · synthesis · iterate · never trained on"}
            </span>
          </div>
          {(isEph || isLocal) && collab && (
            <p className="mt-2 text-[11px] font-bold text-slate-400">
              {isEph ? "👻 Ephemeral result — never stored. " : ""}
              {isLocal ? "🔒 Synthesized on-device." : ""}
            </p>
          )}

          {running && (
            <div className="mt-3">
              <div className="h-1.5 overflow-hidden rounded-full bg-white/5">
                <div className="shimmer-bar h-full w-full" />
              </div>
              <p className="mt-1.5 text-center text-xs text-slate-400">{phase} — {count} parallel minds working…</p>
            </div>
          )}

          {!collab && !running && (
            <div className="mt-4">
              <p className="mb-2 text-[11px] font-bold uppercase tracking-wider text-slate-500">Try a challenge →</p>
              <div className="grid gap-1.5">
                {CHALLENGE_STARTERS.map((s) => (
                  <button
                    key={s.text.slice(0, 32)}
                    onClick={() => run(s.text, s.strategy)}
                    className="truncate rounded-lg border border-white/10 bg-white/[0.03] px-3 py-2 text-left text-xs text-slate-300 hover:border-violet-500/50 hover:text-white"
                    title={s.text}
                  >
                    <span className="mr-1.5 rounded bg-violet-600/30 px-1.5 py-0.5 text-[10px] font-black text-violet-200">
                      {STRATEGIES.find((x) => x.id === s.strategy)?.emoji} {STRATEGIES.find((x) => x.id === s.strategy)?.name}
                    </span>
                    {s.text.length > 110 ? s.text.slice(0, 110) + "…" : s.text}
                  </button>
                ))}
              </div>
            </div>
          )}
          {error && <p className="mt-3 rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-sm text-red-300">⚠️ {error}</p>}
        </div>

        {/* Results */}
        {collab && (
          <div className="fade-up mt-5 space-y-4">
            {/* Synthesis first = best result */}
            <div className="overflow-hidden rounded-2xl border border-emerald-400/30 bg-gradient-to-b from-emerald-500/10 to-transparent">
              <div className="flex items-center gap-2.5 border-b border-emerald-400/20 px-4 py-3">
                <span className="grid h-9 w-9 place-items-center rounded-xl bg-gradient-to-br from-emerald-500 to-cyan-500 text-lg">💎</span>
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-extrabold text-white">Best result · {strategy.emoji} {strategy.name}</p>
                  <p className="text-[11px] text-slate-400">
                    Synthesized from {drafts.length} minds{critiques.length > 0 ? ` + ${critiques.length} critiques` : ""}{collab.rounds > 1 ? ` · pass ${collab.rounds}` : ""}
                  </p>
                </div>
                <div className="flex gap-1.5">
                  <button onClick={() => copy("synth", latestSynth)} className="rounded-lg bg-white/5 px-2.5 py-1.5 text-xs font-bold hover:bg-white/15" title="Copy best result">
                    {copied === "synth" ? "✓" : "📋"}
                  </button>
                  <button onClick={saveAsTemplate} className="rounded-lg bg-white/5 px-2.5 py-1.5 text-xs font-bold hover:bg-white/15" title="Save as reusable template">
                    {copied === "tpl" ? "✓" : "💾"}
                  </button>
                  {!collab.ephemeral && (
                    <a href={`/collabs/${collab.id}`} className="rounded-lg bg-white/5 px-2.5 py-1.5 text-xs font-bold hover:bg-white/15" title="Permalink">
                      🔗
                    </a>
                  )}
                </div>
              </div>
              <div className="scroll-thin max-h-[560px] overflow-y-auto p-5">
                <Markdown text={latestSynth || "Synthesizing…"} />
              </div>
              {!collab.ephemeral && latestSynth && (
                <div className="border-t border-emerald-400/20 p-3">
                  <HandoffButtons text={latestSynth} projectId={projectId || collab.projectId} source={`collab:${collab.id}`} exclude={["collab"]} />
                </div>
              )}
            </div>

            {/* Iterate = next thinking pass */}
            <div className="glass rounded-2xl p-4">
              <p className="text-xs font-extrabold text-white">
                🔁 Next thinking pass — disagree, reshape, add evidence ({collab.rounds}/6 passes used)
              </p>
              <div className="mt-2 flex gap-2">
                <input
                  value={instruction}
                  onChange={(e) => setInstruction(e.target.value)}
                  onKeyDown={(e) => e.key === "Enter" && iterate()}
                  placeholder="e.g. 'Good, but make it leaner — cut to 3 steps and add a checklist'…"
                  className="flex-1 rounded-xl border border-white/10 bg-black/40 px-4 py-2.5 text-sm text-white placeholder:text-slate-500 focus:border-violet-500 focus:outline-none"
                />
                <button onClick={iterate} disabled={iterating || !instruction.trim()} className="btn-arena rounded-xl px-5 py-2.5 text-sm font-extrabold text-white">
                  {iterating ? "…" : "Refine"}
                </button>
              </div>
            </div>

            {/* Drafts */}
            <div>
              <p className="mb-2 text-[11px] font-black uppercase tracking-wider text-slate-400">
                🧠 Round-1 drafts — crown the most helpful mind (+5 Elo signal)
              </p>
              <div className="grid items-start gap-3 md:grid-cols-2">
                {drafts.map((d) => (
                  <div key={d.id} className={`glass overflow-hidden rounded-2xl ${crowned === d.contribIndex || collab.bestContributor === d.contribIndex ? "ring-2 ring-amber-400/60" : ""}`}>
                    <div className="flex items-center gap-2 border-b border-white/10 px-3 py-2.5">
                      <p className="min-w-0 flex-1 truncate text-xs font-extrabold text-white">{d.label}</p>
                      {(crowned === d.contribIndex || collab.bestContributor === d.contribIndex) && <span>👑</span>}
                      <button onClick={() => copy(d.id, d.content)} className="rounded bg-white/5 px-1.5 py-1 text-[11px] hover:bg-white/15">
                        {copied === d.id ? "✓" : "📋"}
                      </button>
                      {crowned === null && collab.bestContributor === null && (
                        <button onClick={() => crown(d.contribIndex)} disabled={crowning} className="rounded bg-amber-500/20 px-2 py-1 text-[11px] font-extrabold text-amber-200 hover:bg-amber-500/40 disabled:opacity-50">
                          👑 Crown
                        </button>
                      )}
                    </div>
                    <div className="scroll-thin max-h-72 overflow-y-auto p-3">
                      <Markdown text={d.content} />
                    </div>
                  </div>
                ))}
              </div>
            </div>

            {critiques.length > 0 && (
              <details className="glass rounded-2xl p-4">
                <summary className="cursor-pointer text-xs font-extrabold text-white">
                  ⚔️ Round-2 critiques ({critiques.length}) — how drafts were stress-tested
                </summary>
                <div className="mt-3 grid gap-2 md:grid-cols-2">
                  {critiques.map((c) => (
                    <div key={c.id} className="rounded-xl bg-black/30 p-3 ring-1 ring-white/5">
                      <p className="text-[11px] font-extrabold text-slate-200">{c.label}</p>
                      <div className="mt-1 max-h-48 overflow-y-auto scroll-thin">
                        <Markdown text={c.content} />
                      </div>
                    </div>
                  ))}
                </div>
              </details>
            )}

            {extraPasses.length > 0 && (
              <details className="glass rounded-2xl p-4">
                <summary className="cursor-pointer text-xs font-extrabold text-white">
                  🔁 Iteration passes ({extraPasses.filter((c) => c.kind === "user").length}) — full thinking trail
                </summary>
                <div className="mt-3 space-y-2">
                  {extraPasses.map((c) => (
                    <div key={c.id} className="rounded-xl bg-black/30 p-3 ring-1 ring-white/5">
                      <p className="text-[11px] font-extrabold text-slate-200">
                        Pass {c.round} · {c.label}
                      </p>
                      <div className="mt-1 max-h-56 overflow-y-auto scroll-thin">
                        {c.kind === "user" ? (
                          <p className="text-xs italic text-violet-200">“{c.content}”</p>
                        ) : (
                          <Markdown text={c.content} />
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              </details>
            )}
          </div>
        )}
      </div>

      {/* Sidebar */}
      <aside className="min-w-0 space-y-4">
        <div className="rounded-2xl border border-emerald-400/25 bg-gradient-to-br from-emerald-500/15 to-cyan-500/5 p-4">
          <p className="text-sm font-extrabold text-emerald-200">🤝 Collaboration, not combat</p>
          <p className="mt-1.5 text-xs leading-relaxed text-emerald-100/80">
            Battles pick a <strong>winner</strong>. Collabs build the <strong>best result</strong>: {count} minds
            draft in parallel, a synthesizer merges the strongest parts, and you iterate until it clicks —
            your <strong>external cognitive OS</strong>.
          </p>
        </div>
        <div className="glass rounded-2xl p-4">
          <h3 className="text-sm font-extrabold text-white">🕘 Recent collabs</h3>
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="🔍 Search challenges…"
            className="mt-2 w-full rounded-lg border border-white/10 bg-black/40 px-3 py-1.5 text-xs text-white placeholder:text-slate-600 focus:border-violet-500 focus:outline-none"
          />
          <div className="scroll-thin mt-2 max-h-80 space-y-2 overflow-y-auto">
            {filtered.map((h: any) => (
              <div key={h.id} className="group relative rounded-lg bg-white/[0.03] p-2.5 ring-1 ring-white/5 hover:ring-emerald-500/40">
                <a href={`/collabs/${h.id}`} className="block">
                  <p className="pr-6 text-[10px] font-black text-emerald-300">
                    {STRATEGIES.find((s) => s.id === h.strategy)?.emoji} {STRATEGIES.find((s) => s.id === h.strategy)?.name ?? h.strategy}
                  </p>
                  <p className="mt-0.5 line-clamp-2 text-xs font-semibold text-slate-200">{h.challenge}</p>
                  <p className="mt-1 text-[11px] text-slate-500">
                    {h.rounds > 1 ? `🔁 ${h.rounds} passes · ` : ""}{h.category}
                    {h.bestContributor !== null && h.bestContributor !== undefined ? " · 👑 crowned" : ""}
                  </p>
                </a>
                <button
                  onClick={async () => {
                    if (!confirm("Delete this collab and its contributions?")) return;
                    await fetch(`/api/collabs/${h.id}`, { method: "DELETE" });
                    setHistory((list) => list.filter((x: any) => x.id !== h.id));
                  }}
                  title="Delete (right to erasure)"
                  className="absolute right-1.5 top-1.5 hidden rounded px-1.5 py-0.5 text-[11px] text-slate-500 hover:bg-red-500/20 hover:text-red-300 group-hover:block"
                >
                  ✕
                </button>
              </div>
            ))}
            {filtered.length === 0 && <p className="text-xs text-slate-500">No collabs yet — run your first challenge.</p>}
          </div>
        </div>
      </aside>
    </div>
  );
}
