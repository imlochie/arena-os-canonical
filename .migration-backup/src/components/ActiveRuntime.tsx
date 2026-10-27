"use client";

import { LEVEL_LABELS, LEVEL_NUMBER, type RuntimeLevel } from "@/lib/runtime";

/**
 * Renders the ACTIVE RUNTIME from the ACTUAL generation metadata — never from
 * what the user selected. Fallbacks are shown as an explicit chain.
 */

export interface RuntimeMeta {
  runtimeLevel: RuntimeLevel;
  backend: string;
  provider?: string;
  modelId: string;
  via: string;
  ms: number;
  firstTokenMs?: number | null;
  fallback: boolean;
  fallbackFrom?: { runtimeLevel: string; backend: string; modelId: string } | null;
  fallbackReason?: string | null;
  note?: string | null;
}

const TONES: Record<string, string> = {
  "arena-local": "border-emerald-400/25 bg-emerald-400/10 text-emerald-100",
  "on-device": "border-sky-400/25 bg-sky-400/10 text-sky-100",
  remote: "border-amber-400/25 bg-amber-400/10 text-amber-100",
};

const BADGES: Record<string, string> = {
  "arena-local": "🔒 LEVEL 0 · no network",
  "on-device": "💻 LEVEL 1 · on device",
  remote: "☁ LEVEL 2 · network",
};

export default function ActiveRuntime({ result, compact = false }: { result: RuntimeMeta; compact?: boolean }) {
  const tone = TONES[result.runtimeLevel] ?? TONES.remote;
  const badge = BADGES[result.runtimeLevel] ?? "runtime";
  const label = LEVEL_LABELS[result.runtimeLevel] ?? result.runtimeLevel;
  const levelNum = LEVEL_NUMBER[result.runtimeLevel];

  if (compact) {
    return (
      <span
        className={`inline-flex flex-wrap items-center gap-1.5 rounded-full border px-2 py-0.5 text-[10px] font-bold ${tone}`}
        data-testid="active-runtime"
      >
        {badge} · {result.fallback ? "Arena Local Engine (fallback)" : `${result.modelId} · ${result.backend}`}
        {typeof result.ms === "number" ? ` · ${result.ms}ms` : ""}
      </span>
    );
  }

  return (
    <div className={`mt-2 rounded-xl border p-3 text-xs ${tone}`} data-testid="active-runtime">
      <p className="font-black uppercase tracking-[0.14em] opacity-70">
        Active runtime · LEVEL {levelNum}
      </p>
      <p className="mt-1 text-sm font-bold">
        {badge} {label}
        {result.runtimeLevel !== "arena-local" && (
          <> — {result.modelId} · backend {result.backend} · provider {result.provider ?? result.backend}</>
        )}
        {result.runtimeLevel === "arena-local" && <> — deterministic offline engine, not an LLM</>}
      </p>
      <p className="mt-0.5 opacity-70">
        via {result.via} · {result.ms}ms measured generation latency
        {result.firstTokenMs !== undefined ? ` · first token ${result.firstTokenMs}ms` : ""}
      </p>
      {result.fallback && result.fallbackFrom ? (
        <p className="mt-1.5 rounded-lg bg-black/30 p-2 leading-5">
          <span className="font-bold">
            {result.fallbackFrom.modelId} / {result.fallbackFrom.backend}
          </span>{" "}
          → unavailable ({result.fallbackReason ?? result.note ?? "unavailable"})
          <br />↓ Fallback: <span className="font-bold">Arena Local Engine</span> — deterministic
          offline response, not model output.
        </p>
      ) : result.note ? (
        <p className="mt-1 opacity-70">{result.note}</p>
      ) : null}
    </div>
  );
}
