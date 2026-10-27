"use client";

import { TRUTH_LABEL, TRUTH_MEANING, TRUTH_STYLE, type TruthClass } from "@/lib/college/truth";

/**
 * One visual language for epistemic status across the whole College UI.
 * If a value is shown without one of these, it is a bug: the institution
 * should never present a claim without saying what kind of claim it is.
 */
export default function TruthBadge({
  truthClass,
  size = "sm",
}: {
  truthClass: string;
  size?: "xs" | "sm";
}) {
  const tc = (TRUTH_LABEL[truthClass as TruthClass] ? truthClass : "unknown") as TruthClass;
  return (
    <span
      title={TRUTH_MEANING[tc]}
      className={`inline-flex shrink-0 items-center rounded border px-1.5 font-mono font-bold uppercase tracking-wider ${TRUTH_STYLE[tc]} ${
        size === "xs" ? "py-0 text-[9px]" : "py-0.5 text-[10px]"
      }`}
    >
      {TRUTH_LABEL[tc]}
    </span>
  );
}

export function ClaimRow({
  label,
  claim,
}: {
  label: string;
  claim: { value: unknown; truthClass: string; provenance: string; conflictWith?: string[]; note?: string };
}) {
  const v =
    claim.value === null || claim.value === undefined || claim.value === ""
      ? "—"
      : String(claim.value);
  return (
    <div className="border-b border-white/5 py-2 last:border-0">
      <div className="flex items-baseline justify-between gap-3">
        <span className="text-[11px] uppercase tracking-wide text-slate-500">{label}</span>
        <TruthBadge truthClass={claim.truthClass} />
      </div>
      <div className="mt-0.5 text-sm font-semibold text-white">{v}</div>
      <div className="mt-0.5 text-[11px] leading-snug text-slate-500">
        <span className="text-slate-600">source: </span>
        {claim.provenance}
      </div>
      {claim.conflictWith?.length ? (
        <div className="mt-1 rounded border border-rose-500/30 bg-rose-500/5 px-2 py-1 text-[11px] text-rose-200">
          {claim.conflictWith.join("  ·  ")}
        </div>
      ) : null}
    </div>
  );
}
