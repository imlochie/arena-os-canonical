"use client";

import type { GenerateResult } from "@/lib/ai";

/**
 * Renders the ACTIVE RUNTIME from the ACTUAL generation metadata — never from
 * what the user selected. Fallbacks are shown as an explicit chain.
 */
export default function ActiveRuntime({
  result,
  compact = false,
}: {
  result: Pick<
    GenerateResult,
    "runtimeTier" | "backend" | "modelId" | "via" | "ms" | "fallback" | "fallbackFrom" | "note"
  >;
  compact?: boolean;
}) {
  const tierLabel =
    result.runtimeTier === "local-engine"
      ? "Local Engine"
      : result.runtimeTier === "local-llm"
        ? "Local LLM"
        : "Remote Free Model";
  const badge =
    result.runtimeTier === "local-engine"
      ? "🔒 No network"
      : result.runtimeTier === "local-llm"
        ? "💻 On device"
        : "☁ Network required";
  const tone =
    result.runtimeTier === "local-engine"
      ? "border-emerald-400/25 bg-emerald-400/10 text-emerald-100"
      : result.runtimeTier === "local-llm"
        ? "border-sky-400/25 bg-sky-400/10 text-sky-100"
        : "border-amber-400/25 bg-amber-400/10 text-amber-100";

  if (compact) {
    return (
      <span
        className={`inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-[10px] font-bold ${tone}`}
        data-testid="active-runtime"
      >
        {badge} · {tierLabel} · {result.ms}ms
        {result.fallback ? " · fallback" : ""}
      </span>
    );
  }

  return (
    <div
      className={`mt-2 rounded-xl border p-3 text-xs ${tone}`}
      data-testid="active-runtime"
    >
      <p className="font-black uppercase tracking-[0.14em] opacity-70">Active runtime</p>
      <p className="mt-1 text-sm font-bold">
        {badge} {tierLabel}
        {result.runtimeTier !== "local-engine" ? ` — ${result.modelId} via ${result.backend}` : " — deterministic offline engine"}
      </p>
      <p className="mt-0.5 opacity-70">
        via {result.via} · {result.ms}ms (generation latency)
      </p>
      {result.fallback && result.fallbackFrom ? (
        <p className="mt-1.5 rounded-lg bg-black/30 p-2 leading-5">
          <span className="font-bold">
            {result.fallbackFrom.modelId} / {result.fallbackFrom.backend}
          </span>{" "}
          → unavailable
          <br />↓ Fallback: <span className="font-bold">Local Engine</span> — deterministic
          offline response, not model output.
          {result.note ? <span className="block opacity-70">{result.note}</span> : null}
        </p>
      ) : result.note ? (
        <p className="mt-1 opacity-70">{result.note}</p>
      ) : null}
    </div>
  );
}
