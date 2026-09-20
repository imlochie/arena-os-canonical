"use client";

import { useEffect, useState } from "react";

// Optional BYOK bar — free keys boost quality. Stored in localStorage only.
export function loadKeys() {
  if (typeof window === "undefined") return {};
  try {
    return {
      openrouter: localStorage.getItem("af_key_openrouter") || undefined,
      groq: localStorage.getItem("af_key_groq") || undefined,
    };
  } catch {
    return {};
  }
}

export default function KeysBar() {
  const [open, setOpen] = useState(false);
  const [orKey, setOrKey] = useState("");
  const [groqKey, setGroqKey] = useState("");
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    try {
      setOrKey(localStorage.getItem("af_key_openrouter") ?? "");
      setGroqKey(localStorage.getItem("af_key_groq") ?? "");
    } catch {}
  }, []);

  const save = () => {
    try {
      if (orKey.trim()) localStorage.setItem("af_key_openrouter", orKey.trim());
      else localStorage.removeItem("af_key_openrouter");
      if (groqKey.trim()) localStorage.setItem("af_key_groq", groqKey.trim());
      else localStorage.removeItem("af_key_groq");
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    } catch {}
  };

  const hasKeys = orKey.trim() !== "" || groqKey.trim() !== "";

  return (
    <div className="glass rounded-2xl p-4">
      <button onClick={() => setOpen(!open)} className="flex w-full items-center justify-between gap-2 text-left">
        <span className="flex items-center gap-2 text-sm font-bold text-white">
          🔑 Optional free key boost
          {hasKeys ? (
            <span className="rounded-full bg-emerald-400/15 px-2 py-0.5 text-[11px] font-bold text-emerald-300 ring-1 ring-emerald-400/30">
              active
            </span>
          ) : (
            <span className="rounded-full bg-white/5 px-2 py-0.5 text-[11px] font-bold text-slate-400 ring-1 ring-white/10">
              not needed
            </span>
          )}
        </span>
        <span className="text-slate-400">{open ? "▲" : "▼"}</span>
      </button>
      <p className="mt-1 text-xs text-slate-400">
        Works with <strong className="text-slate-200">$0 and no keys</strong>. Paste free-tier keys to add extra
        quality headroom — stored only in your browser. In 🔒 Local Mode keys are ignored (zero egress wins).
        Free third-party tiers may log for abuse prevention — Local Mode skips them entirely.
      </p>
      {open && (
        <div className="mt-3 grid gap-2 sm:grid-cols-2">
          <label className="block">
            <span className="mb-1 block text-[11px] font-bold uppercase tracking-wider text-slate-400">
              OpenRouter key (free models)
            </span>
            <input
              type="password"
              value={orKey}
              onChange={(e) => setOrKey(e.target.value)}
              placeholder="sk-or-v1-…"
              className="w-full rounded-lg border border-white/10 bg-black/40 px-3 py-2 text-sm text-white placeholder:text-slate-600 focus:border-violet-500 focus:outline-none"
            />
          </label>
          <label className="block">
            <span className="mb-1 block text-[11px] font-bold uppercase tracking-wider text-slate-400">
              Groq key (free tier)
            </span>
            <input
              type="password"
              value={groqKey}
              onChange={(e) => setGroqKey(e.target.value)}
              placeholder="gsk_…"
              className="w-full rounded-lg border border-white/10 bg-black/40 px-3 py-2 text-sm text-white placeholder:text-slate-600 focus:border-violet-500 focus:outline-none"
            />
          </label>
          <div className="flex items-center gap-2 sm:col-span-2">
            <button
              onClick={save}
              className="rounded-lg bg-violet-600 px-4 py-2 text-sm font-bold text-white hover:bg-violet-500"
            >
              {saved ? "✓ Saved" : "Save keys"}
            </button>
            <a
              href="/guide#free-keys"
              className="text-xs font-semibold text-cyan-300 hover:underline"
            >
              Where do I get free keys? →
            </a>
          </div>
        </div>
      )}
    </div>
  );
}
