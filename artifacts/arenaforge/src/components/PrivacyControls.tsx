"use client";

import { setEphemeral, setLocalMode, usePrivacySettings } from "@workspace/arena/lib/privacyClient";

// Global request/storage preferences. Coverage remains specific to each feature.
export default function PrivacyControls({ compact = false }: { compact?: boolean }) {
  const { localMode, ephemeral, online } = usePrivacySettings();

  if (compact) {
    return (
      <div className="flex flex-wrap items-center gap-1.5">
        <button
          onClick={() => setLocalMode(!localMode)}
          title={localMode ? "Local Mode ON: supported remote provider calls are disabled; Arena still receives the request" : "Enable Local Mode to block supported remote provider calls"}
          className={`rounded-full px-2.5 py-1 text-[11px] font-extrabold transition ${
            localMode
              ? "bg-emerald-500/25 text-emerald-200 ring-1 ring-emerald-400/50"
              : "bg-white/5 text-slate-400 ring-1 ring-white/10 hover:text-white"
          }`}
        >
          {localMode ? "🔒 Local" : "🔓 Cloud"}
        </button>
        <button
          onClick={() => setEphemeral(!ephemeral)}
          title={ephemeral ? "Ephemeral ON: persistence is skipped only for supported flows" : "Enable Ephemeral for supported flows"}
          className={`rounded-full px-2.5 py-1 text-[11px] font-extrabold transition ${
            ephemeral
              ? "bg-amber-500/25 text-amber-200 ring-1 ring-amber-400/50"
              : "bg-white/5 text-slate-400 ring-1 ring-white/10 hover:text-white"
          }`}
        >
          {ephemeral ? "👻 Ephemeral" : "💾 Saved"}
        </button>
        {!online && (
          <span className="rounded-full bg-red-500/20 px-2.5 py-1 text-[11px] font-extrabold text-red-200 ring-1 ring-red-400/40">
            📴 API unavailable
          </span>
        )}
      </div>
    );
  }

  return (
    <div className="glass rounded-2xl p-4">
      <div className="flex items-center justify-between gap-2">
        <p className="text-sm font-extrabold text-white">🔒 Privacy controls</p>
        <a href="/privacy" className="text-xs font-bold text-cyan-300 hover:underline">
          Data handling details →
        </a>
      </div>
      <div className="mt-3 grid gap-2 sm:grid-cols-2">
        <button
          onClick={() => setLocalMode(!localMode)}
          className={`rounded-xl border p-3 text-left transition ${
            localMode ? "border-emerald-400/50 bg-emerald-500/10" : "border-white/10 bg-white/[0.03] hover:border-emerald-400/40"
          }`}
        >
          <p className="text-sm font-extrabold text-white">
            {localMode ? "🔒 Local Mode: ON" : "🔓 Local Mode: OFF"}
          </p>
          <p className="mt-1 text-[11px] leading-relaxed text-slate-400">
            {localMode
              ? "Blocks supported remote model/provider calls. Requests still reach the Arena API; storage depends on the tool."
              : "Provider calls follow the selected runtime. Local Mode does not change where the Arena API is hosted."}
          </p>
        </button>
        <button
          onClick={() => setEphemeral(!ephemeral)}
          className={`rounded-xl border p-3 text-left transition ${
            ephemeral ? "border-amber-400/50 bg-amber-500/10" : "border-white/10 bg-white/[0.03] hover:border-amber-400/40"
          }`}
        >
          <p className="text-sm font-extrabold text-white">
            {ephemeral ? "👻 Ephemeral: ON" : "💾 Ephemeral: OFF"}
          </p>
          <p className="mt-1 text-[11px] leading-relaxed text-slate-400">
            {ephemeral
              ? "Skips persistence only in flows that support it. Other tools may still save data."
              : "Storage behavior varies by tool. Review the data inventory and each tool's save controls."}
          </p>
        </button>
      </div>
      <p className="mt-2 text-[11px] text-slate-500">
        Status: {online ? "🟢 online" : "📴 API unavailable"} · Arena training:{" "}
        <strong className="text-emerald-300">none</strong> · storage: Arena server database
      </p>
    </div>
  );
}
