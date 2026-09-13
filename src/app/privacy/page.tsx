"use client";

import { apiErrorMessage } from "@/lib/apiErrorClient";

import { useCallback, useEffect, useState } from "react";
import PrivacyControls from "@/components/PrivacyControls";

interface Summary {
  policy: { training: string; version: string };
  stored: Record<string, number>;
  dbBytes: number | null;
  residency: string;
  training: string;
}

export default function PrivacyPage() {
  const [summary, setSummary] = useState<Summary | null>(null);
  const [events, setEvents] = useState<any[]>([]);
  const [scope, setScope] = useState("all");
  const [resetElo, setResetElo] = useState(false);
  const [confirm, setConfirm] = useState("");
  const [wiping, setWiping] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const s = await fetch("/api/privacy/summary").then((r) => r.json());
      if (!s.error) setSummary(s);
      const e = await fetch("/api/privacy/events?limit=30").then((r) => r.json());
      setEvents(e.events ?? []);
    } catch {}
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  async function wipe() {
    if (confirm !== "DELETE" || wiping) return;
    setWiping(true);
    setMsg(null);
    try {
      const r = await fetch(
        `/api/privacy/wipe?scope=${scope}&resetElo=${resetElo ? "1" : "0"}&confirm=yes`,
        { method: "DELETE" }
      );
      const j = await r.json();
      if (!r.ok) throw new Error(apiErrorMessage(j.error, "wipe failed"));
      setMsg(`✅ Erased: ${Object.entries(j.deleted).map(([k, v]) => `${k} ×${v}`).join(", ") || "nothing stored"}`);
      setConfirm("");
      refresh();
    } catch (e: any) {
      setMsg(`⚠️ ${e.message}`);
    } finally {
      setWiping(false);
    }
  }

  const mb = summary?.dbBytes ? (summary.dbBytes / 1024 / 1024).toFixed(2) : null;

  return (
    <div className="mx-auto max-w-4xl">
      <div className="text-center">
        <p className="inline-flex items-center gap-2 rounded-full border border-emerald-400/30 bg-emerald-400/10 px-4 py-1.5 text-xs font-bold text-emerald-200">
          🔒 Data Protection Center
        </p>
        <h1 className="mx-auto mt-4 text-3xl font-black leading-tight tracking-tight text-white sm:text-4xl">
          Your data is yours.{" "}
          <span className="bg-gradient-to-r from-emerald-300 to-cyan-300 bg-clip-text text-transparent">
            Never trained on. Ever.
          </span>
        </h1>
        <p className="mx-auto mt-3 max-w-2xl text-sm leading-relaxed text-slate-300">
          The contract: <strong className="text-white">no training on your data</strong>, memory and tasks that
          stay on your machine, and a <strong className="text-white">Local Mode for every feature</strong> so no
          internet connection is ever mandatory.
        </p>
      </div>

      {/* Guarantees */}
      <div className="mt-6 grid gap-2 sm:grid-cols-2">
        {[
          { e: "🚫", t: "Never trained on", d: "Your prompts, votes, chats and collabs are never used to train any model — not ours, not anyone's. Cloud calls carry explicit no-train / no-retain headers, and Local Mode sends nothing anywhere." },
          { e: "🏠", t: "Local-first memory", d: "History, assistants, templates and Elo live in your own Postgres — not a vendor cloud. Memory and tasks work fully offline." },
          { e: "📴", t: "Offline for everything", d: "Battles, collabs, chat, judge, image arena and leaderboards all run on the on-device engine in Local Mode. Pull the cable and keep working." },
          { e: "🧹", t: "Erase anything, anytime", d: "Delete single items, wipe by category, or nuke everything including the audit log. Exports are one click. No retention dark patterns." },
        ].map((c) => (
          <div key={c.t} className="glass rounded-2xl p-4">
            <p className="text-xl">{c.e}</p>
            <p className="mt-1 text-sm font-extrabold text-white">{c.t}</p>
            <p className="mt-1 text-xs leading-relaxed text-slate-300">{c.d}</p>
          </div>
        ))}
      </div>

      <div className="mt-4">
        <PrivacyControls />
      </div>

      {/* Mode matrix */}
      <div className="glass mt-4 rounded-2xl p-5">
        <h2 className="text-base font-extrabold text-white">🔀 The three modes</h2>
        <div className="mt-3 overflow-x-auto">
          <table className="w-full min-w-[560px] border-collapse text-xs">
            <thead>
              <tr className="text-left text-[11px] uppercase tracking-wider text-slate-400">
                <th className="border border-white/10 bg-white/[0.03] px-3 py-2">Question</th>
                <th className="border border-white/10 bg-white/[0.03] px-3 py-2">🔓 Cloud (default)</th>
                <th className="border border-white/10 bg-white/[0.03] px-3 py-2">🔒 Local Mode</th>
                <th className="border border-white/10 bg-white/[0.03] px-3 py-2">👻 Ephemeral</th>
              </tr>
            </thead>
            <tbody className="text-slate-200">
              {[
                ["Internet needed?", "Yes, for AI calls", "No — everything on-device", "Only if combined with cloud"],
                ["Prompts leave machine?", "Yes — inference only, no-train headers", "Never — zero egress", "Depends on Local toggle"],
                ["Anything trains on data?", "No — contract + headers", "Impossible — nothing sent", "No"],
                ["Saved to database?", "Yes — your local Postgres", "Yes — memory still works", "Nothing persisted"],
                ["Blind battles fair?", "Yes — sealed server-side", "Yes — same engine", "Yes — AES-sealed token"],
                ["Votes affect Elo?", "Yes", "Yes", "No — private by design"],
                ["Best for", "Max quality, still free", "Privacy + offline + travel", "Sensitive prompts"],
              ].map((r) => (
                <tr key={r[0]}>
                  <td className="border border-white/10 px-3 py-2 font-bold text-white">{r[0]}</td>
                  <td className="border border-white/10 px-3 py-2">{r[1]}</td>
                  <td className="border border-white/10 px-3 py-2">{r[2]}</td>
                  <td className="border border-white/10 px-3 py-2">{r[3]}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="mt-2 text-[11px] text-slate-500">
          Combine Local + Ephemeral for maximum protection: on-device AI with zero storage — the app becomes a
          stateless offline instrument. BYOK keys are ignored in Local Mode (zero egress beats key quality).
        </p>
      </div>

      {/* Inventory */}
      <div className="glass mt-4 rounded-2xl p-5">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="text-base font-extrabold text-white">📦 Your data inventory (right to know)</h2>
          <button onClick={refresh} className="rounded-lg border border-white/10 bg-white/5 px-3 py-1.5 text-xs font-bold text-white hover:bg-white/10">
            🔄 Refresh
          </button>
        </div>
        {!summary ? (
          <p className="mt-3 text-xs text-slate-500">Loading inventory…</p>
        ) : (
          <>
            <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-5">
              {[
                ["⚔️ Battles", summary.stored.battles],
                ["🗳️ Votes", summary.stored.votes],
                ["🤝 Collabs", summary.stored.collabs],
                ["💬 Chats", summary.stored.chats],
                ["💭 Chat msgs", summary.stored.chatMessages],
                ["🎮 Arcade games", summary.stored.arcade ?? 0],
                ["🧠 Council runs", summary.stored.councilRuns ?? 0],
                ["📦 Artifacts", summary.stored.councilArtifacts ?? 0],
                ["🧬 Assistants", summary.stored.assistants],
                ["📝 Templates", summary.stored.templates],
                ["🧵 Threads", (summary.stored.battleMessages ?? 0) + (summary.stored.collabContributions ?? 0)],
                ["🛡️ Audit events", summary.stored.auditEvents],
                ["💽 DB size", mb ? `${mb} MB` : "—"],
              ].map(([label, v]) => (
                <div key={label as string} className="rounded-xl bg-white/[0.03] p-2.5 text-center ring-1 ring-white/5">
                  <p className="text-base font-black text-white">{v}</p>
                  <p className="text-[10px] font-bold text-slate-400">{label}</p>
                </div>
              ))}
            </div>
            <p className="mt-2 text-[11px] text-slate-500">
              Residency: <strong className="text-slate-300">{summary.residency}</strong> · training:{" "}
              <strong className="text-emerald-300">{summary.training}</strong> · policy {summary.policy.version}
            </p>
          </>
        )}
        <div className="mt-3 flex flex-wrap gap-2">
          <a href="/api/export?format=json" className="rounded-lg border border-white/10 bg-white/5 px-3 py-1.5 text-xs font-bold text-white hover:bg-white/10">
            ⬇️ Export battles (JSON)
          </a>
          <a href="/api/export?format=csv" className="rounded-lg border border-white/10 bg-white/5 px-3 py-1.5 text-xs font-bold text-white hover:bg-white/10">
            ⬇️ Export battles (CSV)
          </a>
        </div>
      </div>

      {/* Wipe */}
      <div className="mt-4 rounded-2xl border border-red-400/25 bg-gradient-to-br from-red-500/10 to-transparent p-5">
        <h2 className="text-base font-extrabold text-white">🧹 Right to erasure</h2>
        <p className="mt-1 text-xs text-slate-400">
          Permanently delete your data. This cannot be undone — export first if you want a copy.
        </p>
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <select
            value={scope}
            onChange={(e) => setScope(e.target.value)}
            className="rounded-lg border border-white/10 bg-black/40 px-3 py-2 text-xs font-bold text-white focus:border-red-400 focus:outline-none"
          >
            <option value="all">Everything (battles, chats, collabs, library, audit)</option>
            <option value="battles">⚔️ Battles + threads + votes</option>
            <option value="chats">💬 Chats + messages</option>
            <option value="collabs">🤝 Collabs + contributions</option>
            <option value="arcade">🎮 Arcade games</option>
            <option value="council">🧠 Council runs + artifacts</option>
            <option value="library">📚 My templates + assistants</option>
            <option value="audit">🛡️ Audit log only</option>
          </select>
          <label className="flex items-center gap-1.5 rounded-lg border border-white/10 bg-white/5 px-3 py-2 text-xs font-bold text-slate-200">
            <input type="checkbox" checked={resetElo} onChange={(e) => setResetElo(e.target.checked)} className="accent-red-500" />
            Also reset Elo to 1200
          </label>
        </div>
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <input
            value={confirm}
            onChange={(e) => setConfirm(e.target.value)}
            placeholder='Type DELETE to confirm'
            className="rounded-lg border border-white/10 bg-black/40 px-3 py-2 text-xs text-white placeholder:text-slate-600 focus:border-red-400 focus:outline-none"
          />
          <button
            onClick={wipe}
            disabled={confirm !== "DELETE" || wiping}
            className="rounded-lg bg-red-600 px-4 py-2 text-xs font-extrabold text-white hover:bg-red-500 disabled:opacity-40"
          >
            {wiping ? "Erasing…" : "Erase now"}
          </button>
        </div>
        {msg && <p className="mt-2 text-xs font-bold text-slate-200">{msg}</p>}
      </div>

      {/* Audit */}
      <div className="glass mt-4 rounded-2xl p-5">
        <h2 className="text-base font-extrabold text-white">🛡️ Audit log (metadata only — never your content)</h2>
        <div className="scroll-thin mt-3 max-h-64 space-y-1.5 overflow-y-auto">
          {events.map((e: any) => (
            <div key={e.id} className="flex items-start gap-2 rounded-lg bg-white/[0.03] px-3 py-2 text-xs ring-1 ring-white/5">
              <span className="font-mono text-[10px] text-slate-500">
                {e.createdAt ? new Date(e.createdAt).toLocaleString() : ""}
              </span>
              <span className="font-bold text-cyan-300">{e.action}</span>
              <span className="text-slate-400">{e.detail}</span>
            </div>
          ))}
          {events.length === 0 && <p className="text-xs text-slate-500">No audit events yet.</p>}
        </div>
      </div>

      {/* Provider honesty */}
      <div className="glass mt-4 rounded-2xl p-5">
        <h2 className="text-base font-extrabold text-white">🤝 Honest provider notes</h2>
        <div className="mt-2 space-y-2 text-xs leading-relaxed text-slate-300">
          <p className="rounded-xl bg-white/[0.03] p-3 ring-1 ring-white/5">
            <strong className="text-white">Pollinations (default cloud).</strong> Keyless inference; we attach
            no-train / no-retain headers to every call. If you need a contractual guarantee rather than a
            best-effort header, use Local Mode — then nothing is sent at all.
          </p>
          <p className="rounded-xl bg-white/[0.03] p-3 ring-1 ring-white/5">
            <strong className="text-white">BYOK keys (Groq / OpenRouter).</strong> Keys live only in your browser
            and are forwarded per-request for inference. Free third-party tiers may log for abuse prevention —
            Local Mode ignores keys entirely and skips these providers.
          </p>
          <p className="rounded-xl bg-white/[0.03] p-3 ring-1 ring-white/5">
            <strong className="text-white">Browser TTS.</strong> Read-aloud uses your device&apos;s built-in
            speech engine — no audio is uploaded anywhere.
          </p>
        </div>
        <div className="mt-4 flex flex-wrap gap-2">
          <a href="/" className="btn-arena rounded-xl px-5 py-2 text-sm font-extrabold text-white">⚔️ Back to the arena</a>
          <a href="/collab" className="rounded-xl border border-white/10 bg-white/5 px-5 py-2 text-sm font-bold text-white hover:bg-white/10">🤝 Collab Lab</a>
        </div>
      </div>
    </div>
  );
}
