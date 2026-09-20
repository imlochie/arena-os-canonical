"use client";

import { setEphemeral, setLocalMode, usePrivacySettings } from "@/lib/privacyClient";

// Global privacy switches: Local Mode (zero egress) + Ephemeral (zero storage).
export default function PrivacyControls({ compact = false }: { compact?: boolean }) {
  const { localMode, ephemeral, online } = usePrivacySettings();

  if (compact) {
    return (
      <div className="flex flex-wrap items-center gap-1.5">
        <button
          onClick={() => setLocalMode(!localMode)}
          title={localMode ? "Local Mode ON: all AI runs on-device, zero internet needed" : "Enable Local Mode: run everything offline"}
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
          title={ephemeral ? "Ephemeral ON: nothing is saved" : "Enable Ephemeral: leave no trace"}
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
            📴 Offline — local auto-on
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
          Data Protection Center →
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
              ? "All AI runs on-device. Zero network egress, works with no internet. Memory & tasks still work — they never leave your machine."
              : "Cloud free tiers used for best quality. Nothing trains on your data. Turn on for guaranteed offline privacy."}
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
              ? "Nothing is saved — battles, chats and collabs vanish when you leave. Votes don't touch the leaderboard."
              : "History is saved to your local database for memory, tasks and Elo. Export or wipe anytime."}
          </p>
        </button>
      </div>
      <p className="mt-2 text-[11px] text-slate-500">
        Status: {online ? "🟢 online" : "📴 offline (local auto-enabled)"} · training on your data:{" "}
        <strong className="text-emerald-300">never</strong> · residency: local Postgres
      </p>
    </div>
  );
}
