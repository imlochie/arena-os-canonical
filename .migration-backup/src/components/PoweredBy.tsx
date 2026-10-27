"use client";

import { LEVEL_LABELS, LEVEL_NUMBER, poweredBy, type GenerateResult } from "@/lib/runtime";

/**
 * Compact "Powered by" chip for room surfaces. Always rendered from the
 * ACTUAL execution metadata — never the selection.
 */

export type PoweredByMeta = Pick<GenerateResult, "runtimeLevel" | "backend" | "modelId" | "fallback">;

export default function PoweredBy({ runtime }: { runtime: PoweredByMeta | null | undefined }) {
  if (!runtime) return null;
  const tone =
    runtime.runtimeLevel === "arena-local"
      ? "text-emerald-300/90 border-emerald-400/20 bg-emerald-400/[0.07]"
      : runtime.runtimeLevel === "on-device"
        ? "text-sky-300/90 border-sky-400/20 bg-sky-400/[0.07]"
        : "text-amber-300/90 border-amber-400/20 bg-amber-400/[0.07]";
  return (
    <span
      className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[10px] font-bold ${tone}`}
      data-testid="powered-by"
      title={`LEVEL ${LEVEL_NUMBER[runtime.runtimeLevel]} · ${LEVEL_LABELS[runtime.runtimeLevel]}`}
    >
      ⚡ Powered by: {poweredBy(runtime)}
    </span>
  );
}
