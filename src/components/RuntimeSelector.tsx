"use client";

import { useState } from "react";
import { FREE_MODELS, LOCAL_ENGINE_ID, type FreeModel } from "@/lib/models";
import { LEVEL_LABELS, LEVEL_NUMBER, type RuntimeLevel } from "@/lib/runtime";

/**
 * The Arena AI selector — three LEVEL cards with models underneath.
 * Never a flat model dump; the level describes HOW the answer is produced,
 * not how smart it is.
 *
 * Labels in this selector state REQUIREMENTS honestly (download / server /
 * network). Only the Arena Local Engine is marked READY here, because it is
 * the only level that is genuinely always ready. Live status for Level 1/2
 * lives on /runtime — never faked here.
 */

const LEVEL_ORDER: RuntimeLevel[] = ["arena-local", "on-device", "remote"];

const LEVEL_CARDS: Record<
  RuntimeLevel,
  { emoji: string; tag: string; tone: string; ring: string; status: string; statusTone: string }
> = {
  "arena-local": {
    emoji: "⚙️",
    tag: "🔒 Offline · Instant · $0 · No download",
    tone: "from-emerald-500/15 to-transparent",
    ring: "border-emerald-400/40 bg-emerald-400/10",
    status: "READY",
    statusTone: "text-emerald-300",
  },
  "on-device": {
    emoji: "💻",
    tag: "WebLLM (browser) / TurboAgent (your server)",
    tone: "from-sky-500/15 to-transparent",
    ring: "border-sky-400/40 bg-sky-400/10",
    status: "Configure",
    statusTone: "text-sky-300",
  },
  remote: {
    emoji: "☁️",
    tag: "Provider-backed · network required",
    tone: "from-amber-500/15 to-transparent",
    ring: "border-amber-400/40 bg-amber-400/10",
    status: "Configure",
    statusTone: "text-amber-300",
  },
};

function modelRequirementLabel(m: FreeModel): string {
  if (m.level === "arena-local") return m.kind === "image" ? "offline canvas" : "always ready";
  if (m.backend === "webllm") return "download + WebGPU · runs in browser";
  if (m.backend === "turboagent") return "TurboAgent server required";
  return "☁ network · free/keyless";
}

export default function RuntimeSelector({
  value,
  onChange,
  kind = "text",
  id,
}: {
  value: string;
  onChange: (modelId: string) => void;
  kind?: "text" | "image";
  id?: string;
}) {
  const [openLevel, setOpenLevel] = useState<RuntimeLevel | null>(
    FREE_MODELS.find((m) => m.id === value)?.level ?? "arena-local",
  );
  const models = FREE_MODELS.filter((m) => m.kind === kind);
  const selected = models.find((m) => m.id === value);

  return (
    <div id={id} className="space-y-2" data-testid="arena-runtime-selector">
      {LEVEL_ORDER.map((level) => {
        const card = LEVEL_CARDS[level];
        const group = models.filter((m) => m.level === level);
        if (!group.length) return null;
        const isOpen = openLevel === level;
        const hasSelection = group.some((m) => m.id === value);
        return (
          <div key={level} data-testid={`level-${level}`}>
            <button
              type="button"
              onClick={() => setOpenLevel(isOpen ? null : level)}
              className={`w-full rounded-xl border p-3 text-left transition ${
                hasSelection ? card.ring : "border-white/10 bg-white/[0.03] hover:bg-white/[0.06]"
              }`}
            >
              <div className="flex items-center justify-between gap-2">
                <span className="text-[10px] font-black uppercase tracking-[0.18em] text-slate-400">
                  LEVEL {LEVEL_NUMBER[level]} · {level === "arena-local" ? "ARENA BASELINE" : "EXECUTION LEVEL"}
                </span>
                <span className={`text-[10px] font-black uppercase tracking-wide ${card.statusTone}`}>
                  {card.status}
                </span>
              </div>
              <div className="mt-1 flex items-center gap-2">
                <span className="text-lg">{card.emoji}</span>
                <span className="text-sm font-extrabold text-white">{LEVEL_LABELS[level]}</span>
              </div>
              <p className="mt-0.5 text-[11px] leading-4 text-slate-400">{card.tag}</p>
              {hasSelection && selected && selected.level === level && (
                <p className="mt-1.5 rounded-lg bg-black/30 px-2 py-1 text-[11px] font-bold text-white">
                  ✓ {selected.emoji} {selected.name}
                </p>
              )}
            </button>
            {isOpen && (
              <div className="mt-1 space-y-1 pl-2">
                {group.map((m) => (
                  <button
                    key={m.id}
                    type="button"
                    onClick={() => {
                      onChange(m.id);
                      setOpenLevel(null);
                    }}
                    className={`flex w-full items-center justify-between gap-2 rounded-lg px-2.5 py-2 text-left text-xs transition ${
                      m.id === value
                        ? "bg-violet-500/20 ring-1 ring-violet-400/40"
                        : "bg-white/[0.02] hover:bg-white/[0.07]"
                    }`}
                  >
                    <span className="font-bold text-white">
                      {m.emoji} {m.name}
                      {m.id === LOCAL_ENGINE_ID && (
                        <span className="ml-1.5 font-normal text-emerald-300">· not an LLM</span>
                      )}
                    </span>
                    <span className="shrink-0 text-[10px] text-slate-500">{modelRequirementLabel(m)}</span>
                  </button>
                ))}
                {level !== "arena-local" && (
                  <a
                    href="/runtime"
                    className="block rounded-lg px-2.5 py-1.5 text-[11px] font-semibold text-cyan-300 hover:underline"
                  >
                    Check live status & configure →
                  </a>
                )}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
