"use client";

import { useEffect, useState } from "react";
import { GROQ_SIGNUP_URL, OPENROUTER_SIGNUP_URL, pickBrain, readBrainKeys, type Brain } from "@/lib/connectedBrain";

/**
 * The free-brain setup card. Shows which brain will actually run right now,
 * and when nothing is connected, walks through connecting Groq's free tier
 * (30 seconds, $0) inline — so the first space/mission/game a user creates
 * is immediately capable.
 */

export default function BrainCard({ context = "spaces" }: { context?: "spaces" | "arcade" }) {
  const [brain, setBrain] = useState<Brain | null>(null);
  const [open, setOpen] = useState(false);
  const [groqKey, setGroqKey] = useState("");
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    setBrain(pickBrain(readBrainKeys()));
    try {
      setGroqKey(localStorage.getItem("af_key_groq") ?? "");
    } catch {}
  }, []);

  if (!brain) return null;
  const connected = brain.provider !== "local";

  const save = () => {
    try {
      if (groqKey.trim()) localStorage.setItem("af_key_groq", groqKey.trim());
      else localStorage.removeItem("af_key_groq");
      setSaved(true);
      setBrain(pickBrain(readBrainKeys()));
      setTimeout(() => setSaved(false), 2500);
    } catch {}
  };

  const what =
    context === "arcade"
      ? "the generative forge can write any game you describe"
      : "agents can reason, write real code in mission workspaces, and act intelligently";

  return (
    <div className="rounded-xl bg-black/20 p-3 ring-1 ring-white/5">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-[10px] font-bold uppercase tracking-wider text-slate-400">Brain</span>
        <span
          className={`rounded-full px-2 py-0.5 text-[11px] font-bold ${
            connected ? "bg-emerald-400/10 text-emerald-300 ring-1 ring-emerald-400/30" : "bg-amber-400/10 text-amber-300 ring-1 ring-amber-400/30"
          }`}
        >
          {connected ? "●" : "○"} {brain.label}
        </span>
        {!connected && (
          <button
            onClick={() => setOpen((v) => !v)}
            className="rounded-lg bg-gradient-to-r from-emerald-500/20 to-cyan-500/20 px-2.5 py-1 text-[11px] font-bold text-emerald-200 ring-1 ring-emerald-400/30 hover:from-emerald-500/30 hover:to-cyan-500/30"
          >
            {open ? "× Close" : "🧠 Connect a free brain (30s)"}
          </button>
        )}
        {connected && (
          <button
            onClick={() => setOpen((v) => !v)}
            className="rounded-lg bg-white/5 px-2 py-1 text-[11px] font-bold text-slate-400 ring-1 ring-white/10 hover:bg-white/10"
          >
            {open ? "×" : "change"}
          </button>
        )}
      </div>

      <p className="mt-1.5 text-[11px] leading-snug text-slate-500">
        {brain.detail}
        {!connected && ` — connect a free model and ${what}.`}
      </p>

      {open && (
        <div className="mt-2.5 space-y-2.5">
          <div className="rounded-lg bg-black/30 p-2.5 ring-1 ring-white/5">
            <p className="text-[11px] font-bold text-white">Recommended: Groq free tier — $0, no card</p>
            <ol className="mt-1 list-decimal space-y-0.5 pl-4 text-[11px] text-slate-400">
              <li>
                Open{" "}
                <a href={GROQ_SIGNUP_URL} target="_blank" rel="noreferrer" className="font-bold text-cyan-300 hover:underline">
                  console.groq.com/keys
                </a>{" "}
                and sign up (email or Google/GitHub).
              </li>
              <li>
                In <b>API Keys</b> → <b>Create API Key</b>, copy it (starts with <code>gsk_…</code>).
              </li>
              <li>Paste it below — it stays in this browser only, never sent anywhere but Groq.</li>
            </ol>
            <div className="mt-2 flex gap-1.5">
              <input
                type="password"
                value={groqKey}
                onChange={(e) => setGroqKey(e.target.value)}
                placeholder="gsk_…"
                className="min-w-0 flex-1 rounded-lg border border-white/10 bg-black/40 px-2.5 py-1.5 font-mono text-xs text-white outline-none placeholder:text-slate-600"
              />
              <button
                onClick={save}
                className="rounded-lg bg-emerald-500/25 px-3 py-1.5 text-xs font-bold text-emerald-100 ring-1 ring-emerald-400/30 hover:bg-emerald-500/35"
              >
                {saved ? "✓ Saved" : "Save"}
              </button>
            </div>
            {saved && (
              <p className="mt-1.5 text-[11px] font-bold text-emerald-300">
                ✓ Connected — agents, missions, and generation now run on Groq&apos;s free tier.
              </p>
            )}
          </div>
          <p className="text-[10px] leading-snug text-slate-600">
            Alternatives:{" "}
            <a href={OPENROUTER_SIGNUP_URL} target="_blank" rel="noreferrer" className="text-slate-400 hover:text-slate-200 hover:underline">
              OpenRouter
            </a>{" "}
            free models (paste in the 🔑 keys bar), a{" "}
            <a href="/runtime" className="text-slate-400 hover:text-slate-200 hover:underline">
              TurboAgent
            </a>{" "}
            local server, or on-device WebLLM in the Arcade. Keys are ignored in 🔒 Local Mode.
          </p>
        </div>
      )}
    </div>
  );
}
