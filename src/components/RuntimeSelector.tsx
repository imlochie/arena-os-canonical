"use client";

import { FREE_MODELS, LOCAL_ENGINE_ID, type FreeModel } from "@/lib/models";
import { TIER_DESCRIPTIONS, TIER_LABELS } from "@/lib/runtime";

/**
 * Tiered AI runtime selector. The three tiers never look like the same thing:
 *
 *   Local Engine        ⚙️ deterministic offline engine — not an LLM
 *   Local LLM           💻 real model inference on this device
 *   Remote Free Models  ☁ real provider models — network required
 */

const TIER_ORDER = ["local-engine", "local-llm", "remote-free"] as const;

const TIER_META: Record<
  string,
  { emoji: string; badge: string; badgeClass: string }
> = {
  "local-engine": {
    emoji: "⚙️",
    badge: "🔒 No network · Instant · Not an LLM",
    badgeClass: "text-emerald-300",
  },
  "local-llm": {
    emoji: "💻",
    badge: "On device · Weights required",
    badgeClass: "text-sky-300",
  },
  "remote-free": {
    emoji: "☁️",
    badge: "Network — requests may leave this machine",
    badgeClass: "text-amber-300",
  },
};

export default function RuntimeSelector({
  value,
  onChange,
  kind = "text",
  id,
  className,
}: {
  value: string;
  onChange: (modelId: string) => void;
  kind?: "text" | "image";
  id?: string;
  className?: string;
}) {
  const models = FREE_MODELS.filter((m) => m.kind === kind);
  return (
    <div>
      <select
        id={id}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className={
          className ??
          "w-full rounded-lg border border-white/10 bg-black/40 px-3 py-2 text-sm font-semibold text-white focus:border-violet-500 focus:outline-none"
        }
        aria-label="AI runtime model"
      >
        {TIER_ORDER.map((tier) => {
          const group = models.filter((m) => m.tier === tier);
          if (!group.length) return null;
          const meta = TIER_META[tier];
          return (
            <optgroup key={tier} label={`${meta.emoji} ${TIER_LABELS[tier].toUpperCase()} — ${meta.badge}`}>
              {group.map((m: FreeModel) => (
                <option key={m.id} value={m.id}>
                  {m.emoji} {m.name}
                  {m.id === LOCAL_ENGINE_ID ? " (always ready)" : ""}
                </option>
              ))}
            </optgroup>
          );
        })}
      </select>
      <p className="mt-1.5 text-[10px] leading-4 text-slate-500">
        {TIER_DESCRIPTIONS[(FREE_MODELS.find((m) => m.id === value) ?? FREE_MODELS[0]).tier]}
      </p>
    </div>
  );
}
